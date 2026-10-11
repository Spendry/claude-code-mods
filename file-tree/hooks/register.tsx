import { atom, read, update } from 'claude-code'
import type { Engine, FsEntry, Register } from 'claude-code'

import type { Changed } from '../types'
import { advance, beatCells, createPlayer, DUEL_ROWS, parseColor } from './duel'

const PANE = 'file-tree'
const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.next', '.DS_Store', 'Thumbs.db'])
// Tools that can change what is on disk; a read-only call leaves the tree alone.
const WRITERS = new Set(['Write', 'Edit', 'NotebookEdit', 'Bash', 'PowerShell'])
// Rows past this are not listed, so a huge opened folder cannot stall a draw.
const MAX_ROWS = 1500
const KEEP_CHANGED = 50
// The duel's frame time: slow enough to stay in the corner of the eye.
const DUEL_MS = 250

// Every path the mod keeps is absolute with '/' separators, so the tree's root can move above the working folder.
const expanded = atom({ plugin: 'file-tree', key: 'expanded' } as const, [])
const changed = atom({ plugin: 'file-tree', key: 'changed' } as const, [])
const rev = atom({ plugin: 'file-tree', key: 'rev' } as const, 0)
const up = atom({ plugin: 'file-tree', key: 'up' } as const, 0)

/** `guide` is the tree's line art before the name: '│  ' per open ancestor, then '├─ ' or '└─ '. */
type Row = { path: string; name: string; isDir: boolean; guide: string }

export function slashes(path: string): string {
  const flat = path.replace(/\\/g, '/')
  return flat === '/' ? flat : flat.replace(/\/+$/, '')
}

/** The path made absolute against cwd, with '/' separators. */
export function absolute(cwd: string, path: string): string {
  const flat = slashes(path)
  if (/^([A-Za-z]:)?\//.test(flat)) return flat
  return `${slashes(cwd)}/${flat.replace(/^\.\//, '')}`
}

/** Windows paths compare without case; elsewhere this costs nothing in practice. */
function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** The folder `levels` above cwd, stopping at the drive or filesystem root. */
export function rootAbove(cwd: string, levels: number): string {
  const parts = slashes(cwd).split('/')
  const keep = Math.max(1, parts.length - levels)
  const root = parts.slice(0, keep).join('/')
  // 'C:' alone means the drive's current folder; '' is the POSIX root.
  return root === '' || /^[A-Za-z]:$/.test(root) ? `${root}/` : root
}

/** How many levels cwd can go up before it reaches the root. */
export function maxUp(cwd: string): number {
  return slashes(cwd).split('/').filter(Boolean).length - 1
}

/** Cuts text to `width` cells: a name keeps its head, a path keeps its tail, '…' marking the cut. */
export function fit(text: string, width: number, keep: 'head' | 'tail' = 'head'): string {
  if (width <= 0) return ''
  if (text.length <= width) return text
  if (width === 1) return '…'
  return keep === 'head' ? `${text.slice(0, width - 1)}…` : `…${text.slice(text.length - width + 1)}`
}

function join(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

/** Each folder below `root` down to `path`, `path` first. */
function chain(root: string, path: string): string[] {
  const out: string[] = []
  let at = path
  while (at.length > root.replace(/\/$/, '').length && at.startsWith(root.replace(/\/$/, ''))) {
    out.push(at)
    const cut = at.lastIndexOf('/')
    if (cut <= 0) break
    at = at.slice(0, cut)
  }
  return out
}

export function sortEntries(entries: readonly FsEntry[]): FsEntry[] {
  return entries
    .filter(entry => !SKIP.has(entry.name))
    .sort((a, b) => {
      const isDirA = a.kind === 'dir'
      const isDirB = b.kind === 'dir'
      if (isDirA !== isDirB) return isDirA ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
}

async function walk($: Engine, root: string, isOpen: (path: string) => boolean): Promise<Row[]> {
  const rows: Row[] = []
  const visit = async (dir: string, lead: string) => {
    const entries = sortEntries(await $.fs.list(dir).catch(() => [] as FsEntry[]))
    for (const [i, entry] of entries.entries()) {
      if (rows.length >= MAX_ROWS) return
      const isLast = i === entries.length - 1
      const path = join(dir, entry.name)
      const isDir = entry.kind === 'dir'
      rows.push({ path, name: entry.name, isDir, guide: lead + (isLast ? '└─ ' : '├─ ') })
      if (isDir && isOpen(path)) await visit(path, lead + (isLast ? '   ' : '│  '))
    }
  }
  await visit(root, '')
  return rows
}

/** Moves the tree's root to `levels` above the working folder, opening the way down to it. */
async function goUp($: Engine, levels: number) {
  const cwd = slashes(await $.session.cwd())
  const next = Math.max(0, Math.min(levels, maxUp(cwd)))
  const way = chain(rootAbove(cwd, next), cwd)
  await update($, expanded, list => {
    const now = list ?? []
    return [...now, ...way.filter(one => !now.some(have => same(have, one)))]
  })
  await update($, up, () => next)
}

async function toggle($: Engine) {
  const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (isUp) {
    await $.ui.close({ id: PANE })
    return false
  }
  await $.ui.open({ id: PANE, title: 'Files' })
  return true
}

export const register: Register = (on, options) => {
  const configured = (options as { background?: string; coverFrame?: boolean; duel?: boolean }) ?? {}
  const background = configured.background?.trim() || undefined
  const coverFrame = configured.coverFrame !== false
  const isDuelOn = configured.duel !== false
  const duelBackground = parseColor(background)
  // Animation bookkeeping only; a reload starting these over just restarts the fight.
  const player = createPlayer()
  let isWorking = false
  let duelColumns = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'files',
      description: 'Show or hide the file tree pane',
    })
    void $.ui.open({ id: PANE, title: 'Files' })
    if (isDuelOn) {
      // Repaints only the duel's cells; the tree is not drawn again. A blit with nothing mounted is refused, harmlessly.
      $.clock.every(DUEL_MS, () => {
        const beat = advance(player, isWorking ? 'fight' : 'calm')
        if (duelColumns > 0)
          void $.ui.blit({ requestId: PANE, key: 'duel', cells: beatCells(beat, duelColumns, duelBackground) }).catch(() => {})
      })
    }

    return next(e)
  })

  // The duel fences while Claude works and meditates between turns.
  on('turn.start', async ($, e, next) => {
    isWorking = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    isWorking = false
    return next(e)
  })

  on('turn.abort', async ($, e, next) => {
    isWorking = false
    return next(e)
  })

  on('command.run', { command: 'files' }, async $ => {
    const isOpen = await toggle($)

    return { text: isOpen ? 'File tree opened.' : 'File tree closed.' }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!WRITERS.has(e.tool)) return ran

    // Bookkeeping for the drawing only: a failure here must never fail the tool call.
    try {
      const target =
        e.tool === 'Write' || e.tool === 'Edit' ? e.file_path : e.tool === 'NotebookEdit' ? e.notebook_path : undefined
      if (target !== undefined) {
        const path = absolute(await $.session.cwd(), target)
        const at = Date.now()
        await update($, changed, list =>
          [...(list ?? []).filter(one => !same(one.path, path)), { path, at } satisfies Changed].slice(-KEEP_CHANGED),
        )
      }
      await update($, rev, n => (n ?? 0) + 1)
    } catch {}

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    await read($, rev)
    const cwd = slashes(await $.session.cwd())
    const levels = Math.min(await read($, up), maxUp(cwd))
    const root = rootAbove(cwd, levels)
    const open = new Set((await read($, expanded)).map(one => one.toLowerCase()))
    const touched = new Set((await read($, changed)).map(one => one.path.toLowerCase()))
    // A folder holding a changed file is marked too, so a change inside a closed folder still shows.
    const touchedDirs = new Set<string>()
    for (const path of touched) for (const dir of chain(root.toLowerCase(), path).slice(1)) touchedDirs.add(dir)

    const rows = await walk($, root, path => open.has(path.toLowerCase()))
    const rootName = root.replace(/\/$/, '').split('/').pop() || root
    const here = cwd.split('/').pop() || cwd

    const flip = (path: string) =>
      update($, expanded, list => {
        const now = list ?? []
        const key = path.toLowerCase()
        const isOpen = now.some(one => one.toLowerCase() === key)
        return isOpen
          ? now.filter(one => !(one.toLowerCase() === key || one.toLowerCase().startsWith(key + '/')))
          : [...now, path]
      })

    // Kept dark so it sits behind the transcript: a muted orange frame on a darker ground, every
    // name dimmed, and only a changed file in color. The engine's own square frame is outside this one.
    const columns = e.props.bodyColumns ?? 40
    const tall = Math.max(6, e.props.scroll?.bodyRows ?? 0)
    // Over the frame, the border sits one cell outside the body and the text gets those cells back.
    const inner = Math.max(10, columns - (coverFrame ? 2 : 4))
    const count = touched.size > 0 ? `${touched.size} changed · ` : ''
    const where = levels > 0 ? `${levels} up from ${here}` : root
    return (
      <Box
        flexDirection="column"
        borderStyle={coverFrame ? undefined : 'round'}
        borderColor={coverFrame ? undefined : 'claude'}
        borderDimColor={!coverFrame}
        backgroundColor={background}
        paddingX={1}
        minHeight={tall}
      >
        {coverFrame && (
          <Box
            position="absolute"
            top={-1}
            left={-1}
            width={columns + 2}
            height={tall + 2}
            borderStyle="round"
            borderColor="claude"
            borderDimColor
          />
        )}
        <Box flexDirection="row" justifyContent="space-between">
          <Text color="claude" dimColor>
            {fit(rootName, Math.max(4, inner - 34))}
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="up" plain hotkey="u" onPress={() => goUp($, levels + 1)}>
              <Text color={levels >= maxUp(cwd) ? 'inactive' : 'subtle'} dimColor>‹ up</Text>
            </Button>
            <Button key="home" plain hotkey="h" onPress={() => update($, up, () => 0)}>
              <Text color={levels === 0 ? 'inactive' : 'subtle'} dimColor>home</Text>
            </Button>
            <Button key="refresh" plain hotkey="r" onPress={() => update($, rev, n => (n ?? 0) + 1)}>
              <Text color="subtle" dimColor>refresh</Text>
            </Button>
            <Button key="collapse" plain hotkey="c" onPress={() => update($, expanded, () => [])}>
              <Text color="subtle" dimColor>collapse</Text>
            </Button>
          </Box>
        </Box>
        <Text color="claude" dimColor>{'─'.repeat(inner)}</Text>
        {rows.length === 0 && <Text color="subtle" dimColor italic>empty folder</Text>}
        {rows.map(row => {
          const key = row.path.toLowerCase()
          const room = inner - row.guide.length - 2
          if (row.isDir) {
            const isOpen = open.has(key)
            const isHere = levels > 0 && key === cwd.toLowerCase()
            const mark = isHere ? ' · here' : ''
            return (
              <Button key={`d:${row.path}`} plain onPress={() => flip(row.path)}>
                <Text color="subtle" dimColor>{row.guide}</Text>
                <Text color="subtle" dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
                <Text color={isHere ? 'claude' : touchedDirs.has(key) ? 'success' : 'subtle'} dimColor={isHere || touchedDirs.has(key)}>
                  {fit(row.name, room - mark.length)}
                </Text>
                <Text color="subtle" dimColor italic>{mark}</Text>
              </Button>
            )
          }
          return (
            <Text>
              <Text color="subtle" dimColor>{row.guide}</Text>
              {touched.has(key) ? (
                <Text color="success" dimColor>● {fit(row.name, room)}</Text>
              ) : (
                <Text color="subtle" dimColor>  {fit(row.name, room)}</Text>
              )}
            </Text>
          )
        })}
        {rows.length >= MAX_ROWS && <Text color="subtle" dimColor italic>more not listed; close a folder</Text>}
        <Box flexGrow={1} />
        {isDuelOn && e.surface === 'terminal' && inner >= 20 && (() => {
          const { Raster } = $.ui.resolve(e)
          duelColumns = inner
          return <Raster key="duel" columns={inner} rows={DUEL_ROWS} cells={beatCells(player.beat, inner, duelBackground)} />
        })()}
        <Text color="subtle" dimColor italic>
          {fit(count, inner)}
          {fit(where, inner - count.length, 'tail')}
        </Text>
      </Box>
    )
  })
}
