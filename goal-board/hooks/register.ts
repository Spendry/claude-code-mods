import type { Register } from 'claude-code'

// One record per session, in the store every session on this machine shares.
// Each session writes only its own key, so sessions never overwrite each other.
type Task = { id: string; subject: string; status: 'pending' | 'in_progress' | 'completed'; doneAt?: number }
type Board = {
  id: string
  project: string
  goal: string
  isGoalAuto: boolean
  tasks: Task[]
  firstTaskAt?: number
  startedAt: number
  updatedAt: number
  isWorking: boolean
  isEnded?: boolean
}

const PANE = 'goal-board'
const STALE_MS = 12 * 60 * 60_000

let me: Board | null = null
let others = 0

function keyOf(id: string) {
  return `board:${id}`
}

function bar(done: number, total: number, width = 10): string {
  if (!total) return '▱'.repeat(width)
  const full = Math.round((done / total) * width)
  return '▰'.repeat(full) + '▱'.repeat(width - full)
}

function ago(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  return `${Math.round(m / 60)}h ago`
}

function eta(b: Board, now: number): string {
  const done = b.tasks.filter(t => t.status === 'completed').length
  const left = b.tasks.length - done
  if (!left) return b.tasks.length ? 'done' : ''
  if (!done || b.firstTaskAt === undefined) return ''
  const per = (now - b.firstTaskAt) / done
  const m = Math.max(1, Math.round((per * left) / 60_000))
  return m >= 60 ? `~${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')} left` : `~${m}m left`
}

function current(b: Board): string {
  return b.tasks.find(t => t.status === 'in_progress')?.subject ?? ''
}

function clip(text: string, n: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

async function save($: any) {
  if (!me) return
  me.updatedAt = await $.clock.now()
  await $.store.set(keyOf(me.id), me)
  $.ui.invalidate('ui.render')
}

async function readAll($: any): Promise<Board[]> {
  const now = await $.clock.now()
  const keys = ((await $.store.keys()) as string[]).filter(k => k.startsWith('board:'))
  const boards: Board[] = []
  for (const k of keys) {
    const b = (await $.store.get(k)) as Board | undefined
    if (!b) continue
    if (now - b.updatedAt > STALE_MS) {
      await $.store.delete(k)
      continue
    }
    boards.push(b)
  }
  return boards.sort((a, b) => b.updatedAt - a.updatedAt)
}

async function fresh($: any): Promise<Board> {
  const id = await $.session.id()
  const cwd = (await $.session.cwd()) as string
  const now = await $.clock.now()
  return { id, project: cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd, goal: '', isGoalAuto: true, tasks: [], startedAt: now, updatedAt: now, isWorking: false }
}

async function countOthers($: any) {
  if (!me) return
  const all = await readAll($)
  others = all.filter(b => b.id !== me!.id && !b.isEnded && (b.tasks.length || b.goal)).length
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const id = await $.session.id()
    const stored = (await $.store.get(keyOf(id))) as Board | undefined
    // values from the store may be frozen; work on a copy
    me = stored ? (JSON.parse(JSON.stringify(stored)) as Board) : await fresh($)
    await countOthers($)
    // Keep the "+N sessions" count and the open board current.
    $.clock.every(5000, async () => {
      await countOthers($)
      $.ui.invalidate('ui.render')
    })
    try {
      await $.command.register({ name: 'goal', description: "Set or clear this session's goal", argumentHint: '[text | clear]', immediate: true })
      await $.command.register({ name: 'goals', description: 'Board of every running session: goal, progress, ETA', immediate: true })
    } catch {
      // a name is taken
    }
    return next(e)
  })

  // /clear starts new work: start a new record for it
  on('classic.SessionStart', { source: ['clear'] }, async ($, e, next) => {
    me = await fresh($)
    await save($)
    return next(e)
  })

  // A session that finished its tasks stays on the board as done until the 12-hour cleanup;
  // one that ends with work left over drops off, since nothing will move it forward.
  on('session.end', async ($, e, next) => {
    if (me) {
      const isDone = me.tasks.length > 0 && me.tasks.every(t => t.status === 'completed')
      if (isDone) {
        me.isWorking = false
        me.isEnded = true
        await save($)
      } else {
        await $.store.delete(keyOf(me.id))
      }
    }
    return next(e)
  })

  // The first prompt becomes the goal until you set one with /goal.
  on('prompt.submit', async ($, e, next) => {
    if (me && !me.goal && e.text.trim() && !e.text.trim().startsWith('/')) {
      me.goal = clip(e.text.split('\n')[0] ?? '', 70)
      me.isGoalAuto = true
      await save($)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (me && !me.isWorking) {
      me.isWorking = true
      await save($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (me && !e.agentId) {
      me.isWorking = false
      await save($)
    }
    return next(e)
  })

  // ---------- tasks, from Claude's own task tools ----------

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (!me || ran.deny !== undefined || ran.isError) return ran
    const created = (ran.result as { task?: { id?: string } } | undefined)?.task
    const now = await $.clock.now()
    me.tasks.push({ id: created?.id ?? `t${me.tasks.length + 1}`, subject: e.subject, status: 'pending' })
    me.firstTaskAt ??= now
    await save($)
    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (!me || ran.deny !== undefined || ran.isError) return ran
    const t = me.tasks.find(x => x.id === e.taskId)
    if (t) {
      if (e.subject) t.subject = e.subject
      if (e.status === 'deleted') me.tasks = me.tasks.filter(x => x !== t)
      else if (e.status) {
        if (e.status === 'completed' && t.status !== 'completed') t.doneAt = await $.clock.now()
        t.status = e.status
      }
      await save($)
    }
    return ran
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (!me || ran.deny !== undefined || ran.isError) return ran
    const now = await $.clock.now()
    const before = new Map(me.tasks.map(t => [t.subject, t]))
    me.tasks = e.todos.map((todo, i) => {
      const old = before.get(todo.content)
      const doneAt = todo.status === 'completed' ? (old?.doneAt ?? now) : undefined
      return { id: `todo${i}`, subject: todo.content, status: todo.status, ...(doneAt ? { doneAt } : {}) }
    })
    if (me.tasks.length) me.firstTaskAt ??= now
    await save($)
    return ran
  })

  // ---------- commands ----------

  on('command.run', { command: 'goal' }, async ($, e) => {
    if (!me) return { text: 'Goal board is not ready yet.' }
    const text = (e.args ?? '').trim()
    if (!text) return { text: me.goal ? `Goal: ${me.goal}${me.isGoalAuto ? ' (from your first prompt; /goal <text> to set it)' : ''}` : 'No goal yet. /goal <text> sets one.' }
    if (text === 'clear') {
      me.goal = ''
      me.isGoalAuto = true
    } else {
      me.goal = clip(text, 90)
      me.isGoalAuto = false
    }
    await save($)
    return {}
  })

  on('command.run', { command: 'goals' }, async ($) => {
    const placed = await $.ui.open({ id: PANE, title: 'Goals', focus: true, closeOnEscape: true })
    if (placed.isPlaced) return {}
    // No pane on this surface (the VS Code panel, claude -p): answer in text instead.
    const now = await $.clock.now()
    const all = await readAll($)
    if (!all.length) return { text: 'No sessions with goals or tasks right now.' }
    return {
      text: all
        .map(b => {
          const done = b.tasks.filter(t => t.status === 'completed').length
          return `${b.project}: ${b.goal || '(no goal)'}\n  ${bar(done, b.tasks.length)} ${done}/${b.tasks.length} ${eta(b, now)} · ${b.isEnded ? `ended ${ago(now - b.updatedAt)}` : b.isWorking ? 'working' : `idle ${ago(now - b.updatedAt)}`}${current(b) ? ` · now: ${current(b)}` : ''}`
        })
        .join('\n'),
    }
  })

  // ---------- drawing ----------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!me || e.props.hasSurvey || (!me.goal && !me.tasks.length)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const done = me.tasks.filter(t => t.status === 'completed').length
    const total = me.tasks.length
    const width = Math.max(20, e.props.bodyColumns)

    const parts: any[] = [Text({ bold: true, children: [`◎ ${clip(me.goal || '(no goal set)', Math.floor(width * 0.35))}`] })]
    if (total) {
      parts.push(Text({ color: done === total ? 'green' : 'cyan', children: [`  ${bar(done, total)} ${done}/${total}`] }))
      const left = eta(me, now)
      if (left) parts.push(Text({ dimColor: true, children: [` · ${left}`] }))
      const now2 = current(me)
      if (now2) parts.push(Text({ dimColor: true, children: [` · now: ${clip(now2, Math.floor(width * 0.25))}`] }))
    }
    if (others) parts.push(Text({ dimColor: true, children: [` · +${others} session${others > 1 ? 's' : ''} (/goals)`] }))

    const theirs = await next(e)
    return Box({ flexDirection: 'column', children: [Box({ flexDirection: 'row', children: parts }), ...(theirs ? [theirs] : [])] })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const all = await readAll($)
    const width = Math.max(30, e.props.bodyColumns)
    if (!all.length) return Text({ dimColor: true, children: ['No sessions with goals or tasks right now.'] })

    const rows = all.map(b => {
      const done = b.tasks.filter(t => t.status === 'completed').length
      const isMe = me && b.id === me.id
      const state = b.tasks.length && done === b.tasks.length ? (b.isEnded ? `✓ done, ended ${ago(now - b.updatedAt)}` : '✓ done') : b.isWorking ? '● working' : `○ idle ${ago(now - b.updatedAt)}`
      const stateColor = state.startsWith('✓') ? 'green' : b.isWorking ? 'cyan' : 'gray'
      return Box({
        key: b.id,
        flexDirection: 'column',
        marginBottom: 1,
        children: [
          Text({ bold: true, children: [`${isMe ? '▸ ' : '  '}${b.project}: ${clip(b.goal || '(no goal)', width - b.project.length - 6)}`] }),
          Box({
            flexDirection: 'row',
            children: [
              Text({ color: 'cyan', children: [`  ${bar(done, b.tasks.length, 16)} ${done}/${b.tasks.length}`] }),
              Text({ dimColor: true, children: [eta(b, now) ? ` · ${eta(b, now)}` : ''] }),
              Text({ color: stateColor, children: [` · ${state}`] }),
            ],
          }),
          ...(current(b) ? [Text({ dimColor: true, children: [`  now: ${clip(current(b), width - 8)}`] })] : []),
        ],
      })
    })
    return Box({ flexDirection: 'column', children: rows })
  })
}
