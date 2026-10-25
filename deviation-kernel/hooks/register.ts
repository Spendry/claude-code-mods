import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Flag, Mode, Refusal } from '../types'

// The kernel lives at the project root, or under .claude/ if you'd rather keep the root clean.
const KERNEL_PATHS = ['KERNEL.md', '.claude/KERNEL.md']
const PANE = 'deviation-kernel'

const pending = atom({ plugin: 'deviation-kernel', key: 'pending' } as const, [] as Flag[])
const summary = atom({ plugin: 'deviation-kernel', key: 'summary' } as const, null)

const TEMPLATE = `# Kernel: <project name>

What this project refuses on purpose. Everything not listed here is allowed to be conventional.

## Refuses
- R1: <an assumption the standard approach makes that this design rejects> | tells: <word>, <phrase>, /<regex>/ | instead: <what this design does in its place>
- R2: <another refused assumption> | tells: <word> | instead: <...>

## Keeps conventional
- <parts you are happy to build the normal way: build system, logging, test harness, file formats>

## Exempt
- <optional: paths where notes name refused assumptions to weigh them, e.g. ideas/**; edits there skip the tell check>
`

// ---------- parsing ----------

// exempt: paths where notes may name refused assumptions in order to weigh them
// (idea notes, design reviews). Edits there skip the tell check.
type Parsed = { project: string; refusals: Refusal[]; keeps: string[]; exempt: string[] }

function parseKernel(text: string): Parsed {
  let project = 'project'
  let section = ''
  const refusals: Refusal[] = []
  const keeps: string[] = []
  const exempt: string[] = []

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const title = line.match(/^#\s*kernel\s*[:\-–—]\s*(.+)$/i)
    if (title) {
      project = (title[1] ?? '').trim()
      continue
    }
    if (/^#+\s*refuse/i.test(line)) {
      section = 'refuses'
      continue
    }
    if (/^#+\s*keep/i.test(line)) {
      section = 'keeps'
      continue
    }
    if (/^#+\s*exempt/i.test(line)) {
      section = 'exempt'
      continue
    }
    if (/^#+\s/.test(line)) {
      section = ''
      continue
    }

    const r = line.match(/^[-*]\s*(R\d+)\s*[:.)\-–]\s*(.+)$/i)
    if (r) {
      const parts = (r[2] ?? '').split('|').map(p => p.trim())
      const refusal: Refusal = { id: (r[1] ?? '').toUpperCase(), assumption: parts[0] ?? '', tells: [], instead: '' }
      for (const part of parts.slice(1)) {
        const tells = part.match(/^tells?\s*:\s*(.*)$/i)
        const instead = part.match(/^instead\s*:\s*(.*)$/i)
        if (tells) refusal.tells = (tells[1] ?? '').split(',').map(t => t.trim()).filter(Boolean)
        if (instead) refusal.instead = instead[1] ?? ''
      }
      refusals.push(refusal)
      continue
    }
    if (section === 'keeps' && /^[-*]\s+/.test(line)) keeps.push(line.replace(/^[-*]\s+/, ''))
    if (section === 'exempt' && /^[-*]\s+/.test(line)) {
      // the path pattern is the line's first token, `backticks` optional; the rest is a reason
      const glob = line.replace(/^[-*]\s+/, '').trim().split(/\s+/)[0]!.replace(/^`|`$/g, '')
      if (glob && !glob.startsWith('<')) exempt.push(glob)
    }
  }

  return { project, refusals, keeps, exempt }
}

// A path pattern, relative to the project: ** any depth, * within one folder, ? one character.
// A pattern ending in / covers everything under it.
function globPattern(glob: string): RegExp {
  let g = glob.replaceAll('\\', '/').replace(/^\.\//, '')
  if (g.endsWith('/')) g += '**'
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        re += '(?:.*/)?' // "**/" : zero or more folders
        i += 2
      } else {
        re += '.*'
        i += 1
      }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 'i')
}

function isExempt(path: string, cwd: string): boolean {
  if (!parsed.exempt.length) return false
  const p = path.replaceAll('\\', '/')
  const root = cwd.replaceAll('\\', '/').replace(/\/+$/, '') + '/'
  const rel = p.toLowerCase().startsWith(root.toLowerCase()) ? p.slice(root.length) : p.replace(/^\.\//, '')
  return parsed.exempt.some(g => globPattern(g).test(rel))
}

function tellPattern(tell: string): RegExp | null {
  try {
    const slash = tell.lastIndexOf('/')
    if (tell.startsWith('/') && slash > 0) return new RegExp(tell.slice(1, slash), tell.slice(slash + 1) || 'i')
    const escaped = tell.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`\\b${escaped}\\b`, 'i')
  } catch {
    return null
  }
}

// ---------- explaining a trip: how the matched text goes against the kernel ----------

const bare = (s: string) => s.trim().replace(/[.;:,\s]+$/, '')
const firstSentence = (s: string) => bare(s.split(/(?<=[.!?])\s+/)[0] ?? s)

// The words around the match, on its own line, so the reader sees what tripped and where.
function snippet(text: string, re: RegExp): string {
  const m = new RegExp(re.source, re.flags.replace('g', '')).exec(text)
  if (!m) return ''
  const start = text.lastIndexOf('\n', m.index) + 1
  const end = text.indexOf('\n', m.index + m[0].length)
  let line = text.slice(start, end < 0 ? undefined : end).trim().replace(/\s+/g, ' ')
  if (line.length > 90) {
    const at = Math.max(0, line.toLowerCase().indexOf(m[0].toLowerCase()) - 30)
    line = (at > 0 ? '…' : '') + line.slice(at, at + 90) + (at + 90 < line.length ? '…' : '')
  }
  return line
}

/** Two sentences at most: what the edit adds and which refused assumption it marks, then what the design does instead. */
function explain(refusal: Refusal, tell: string, text: string, re: RegExp): string {
  const s = snippet(text, re)
  const one = `The edit adds ${s ? `"${s}", where ` : ''}"${tell}" marks ${refusal.id}'s refused assumption: ${bare(refusal.assumption)}.`
  return refusal.instead ? `${one} This design does otherwise: ${firstSentence(refusal.instead)}.` : one
}

// ---------- module state (rebuilt from disk on every reload) ----------

let kernelPath = ''
let mtime = -1
let parsed: Parsed = { project: 'project', refusals: [], keeps: [], exempt: [] }
let patterns: { refusal: Refusal; tell: string; re: RegExp }[] = []
let section = ''
let modeOverride: Mode | undefined
let loaded = false
// Trips are logged per project folder, so two kernels with the same title keep separate logs.
let logKey = 'log:'

function renderSection(p: Parsed): string {
  const refusals = p.refusals
    .map(r => {
      const tells = r.tells.length ? ` (tells: ${r.tells.join(', ')})` : ''
      const instead = r.instead ? ` Instead: ${r.instead}` : ''
      return `- ${r.id}: ${r.assumption}${tells}.${instead}`
    })
    .join('\n')
  const keeps = p.keeps.length ? `\nKept conventional on purpose: ${p.keeps.join('; ')}.` : ''
  const exempt = p.exempt.length ? `\nExempt from the edit check (notes there may name refused assumptions to weigh them): ${p.exempt.join(', ')}. Code there is still held to the kernel.` : ''

  return `<deviation_kernel project="${p.project}">
This project carries a deviation kernel: assumptions it refuses on purpose. Its value depends on these refusals holding while the build fills in ordinary parts, and the usual failure is quiet: a standard component slips in and brings a refused assumption with it.

Refuses:
${refusals}${keeps}${exempt}

How to work under it:
- Name each slot by what it must guarantee and what crosses its boundary before naming its category. A category name pulls in its standard filler before any search runs.
- Take the conventional answer wherever the kernel is not touched, and say in one line when you take it on purpose.
- Before filling a slot, check the filler against each refusal. When a standard component would re-impose a refused assumption, stop at that step, name the refusal it touches, and hold two or more alternatives open instead of defaulting to the standard one.
- When an existing library or pattern touches a refusal, go one level into its assumptions before accepting it. It is a candidate, not a stopping point.
- The result still has to run and hold up in reality. An unconventional part needs a stated mechanism and a way it could fail, not only novelty.
- The kernel file is the user's. Do not edit it unless asked.
</deviation_kernel>`
}

let configuredMode: Mode = 'ask'
let semantic = true

function mode(): Mode {
  return modeOverride ?? configuredMode
}

async function loadKernel($: any, force = false): Promise<boolean> {
  loaded = true
  let found = ''
  for (const path of KERNEL_PATHS) {
    if (await $.fs.exists(path)) {
      found = path
      break
    }
  }
  if (!found) {
    kernelPath = ''
    parsed = { project: 'project', refusals: [], keeps: [], exempt: [] }
    patterns = []
    section = ''
    await update($, summary, () => null)
    return false
  }

  const stat = await $.fs.stat(found)
  if (!force && found === kernelPath && stat.mtimeMs === mtime) return true

  kernelPath = found
  mtime = stat.mtimeMs
  logKey = `log:${await $.session.cwd()}`
  parsed = parseKernel(await $.fs.read(found))
  patterns = []
  for (const refusal of parsed.refusals) {
    for (const tell of refusal.tells) {
      const re = tellPattern(tell)
      if (re) patterns.push({ refusal, tell, re })
    }
  }
  section = parsed.refusals.length ? renderSection(parsed) : ''
  await update($, summary, () => ({ project: parsed.project, refusals: parsed.refusals.length, mode: mode() }))
  return true
}

async function logFlag($: any, flag: Flag, decision: string) {
  const log = ((await $.store.get(logKey)) as unknown[] | undefined) ?? []
  await $.store.set(logKey, [...log, { ...flag, decision }].slice(-50))
}

async function addPending($: any, flags: Flag[]) {
  if (!flags.length) return
  await update($, pending, list => [...list, ...flags].slice(-8))
}

// ---------- no kernel here: offer, once per folder, to help write one ----------

const OFFER = { now: 'Yes, now', after: 'After this message', later: 'Not this session', never: 'Never in this folder' }

let offer = true
// Folders already offered this session. A reload asks again; /clear does not.
const offered = new Set<string>()

function folderKey(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

function interview(lead: string): string {
  return `[deviation-kernel] ${lead}

How to run it:
- The folder may already hold work. If it does, read its own record first (README, design notes, the earliest docs or commits) so your questions can point at what the project set out to do. Use what you find to ask, not to answer.
- Ask the user, one question at a time, which assumptions this project refuses on purpose: ones the standard approach makes and this design rejects. The refusals come from them. Do not propose any of your own.
- For each refusal they give, help word it, propose tells (words, phrases or /regex/ that would show up in an edit that brings the assumption back) and an "instead:" (what the design does in its place). Two or three refusals are enough to start; /kernel add takes more later.
- Ask what the project keeps conventional on purpose.
- Show the whole file in this form, and write it as KERNEL.md at the folder root only when the user says so:

${TEMPLATE}
- Once it is written, say in one line each what the modes do (ask holds a tripped edit for their decision, warn lets it through and flags it, block refuses it), that the mode is ${mode()}, and that /kernel mode changes it. Say too that tells only check what an edit brings in, not what the files already hold, and offer to read the existing work against the new refusals.`
}

// Resolves to a note for Claude when the user takes the offer, or undefined.
async function kernelOffer($: any, e: { command?: unknown; isMeta?: true; origin: { kind: string } }): Promise<string | undefined> {
  // Only a prompt the user typed; a slash command (/kernel init among them) runs as asked.
  if (!offer || e.command || e.isMeta || (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge')) return undefined
  const cwd = await $.session.cwd()
  const key = folderKey(cwd)
  if (offered.has(key)) return undefined
  offered.add(key)
  // A home folder is where sessions start, not a project.
  const homes = [await $.env.get('HOME'), await $.env.get('USERPROFILE')].filter(Boolean).map(folderKey)
  if (homes.includes(key) || (await $.store.get(`never:${key}`))) return undefined

  const folder = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd
  let answer = OFFER.later
  try {
    answer = await $.ui.ask(`There's no KERNEL.md in ${folder}. Want Claude to help you write one?`, {
      header: 'Kernel',
      options: [OFFER.now, OFFER.after, OFFER.later, OFFER.never],
    })
  } catch {
    // dismissed, or nobody to ask (claude -p): leave it for this session
  }

  if (answer === OFFER.now)
    return interview(`This folder has no KERNEL.md, and the user just chose to have you help write one. Do that before working on their message, and come back to the message once the file is written or they stop.`)
  if (answer === OFFER.after)
    return interview(`This folder has no KERNEL.md, and the user chose to have you help write one after this message. Answer their message first, then start.`)
  if (answer === OFFER.never) {
    await $.store.set(`never:${key}`, true)
    $.ui.toast(`kernel: no more offers in ${folder}. /kernel init still works.`)
    return undefined
  }
  if (answer !== OFFER.later && answer.trim())
    return interview(`This folder has no KERNEL.md. Offered help writing one, the user answered: "${answer.trim()}". Go by that answer; if it asks for the help, run it as below.`)
  return undefined
}


export const register: Register = (on, options) => {
  const configured = (options as { mode?: Mode; semanticCheck?: boolean; offerKernel?: boolean }) ?? {}
  configuredMode = configured.mode ?? 'ask'
  semantic = configured.semanticCheck !== false
  offer = configured.offerKernel !== false

  // ---------- session ----------

  on('session.start', async ($, e, next) => {
    const stored = (await $.store.get('mode')) as Mode | undefined
    if (stored === 'ask' || stored === 'warn' || stored === 'block') modeOverride = stored
    await loadKernel($, true)
    try {
      await $.command.register({
        name: 'kernel',
        description: 'Deviation kernel: show, init, add, mode, check, log, reload',
        argumentHint: '[init | add <refusal> | mode ask|warn|block | check | log | reload]',
        immediate: true,
      })
    } catch {
      // name taken: the rest of the mod still works
    }
    return next(e)
  })

  // /clear, /resume and /branch reset $.state, so rebuild the summary
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await loadKernel($, true)
    return next(e)
  })

  // ---------- the standing seed: the kernel rides in the system prompt ----------

  on('prompt.compose', async ($, e, next) => {
    if (!loaded) await loadKernel($, true)
    const composed = await next(e)
    if (!section) return composed
    return { sections: [...composed.sections, { id: 'deviation-kernel:kernel', text: section, scope: 'session' as const }] }
  })

  // ---------- your prompt: refresh the kernel, deliver flagged drift, or offer one ----------

  on('prompt.submit', async ($, e, next) => {
    if (!(await loadKernel($))) {
      const note = await kernelOffer($, e)
      return next(note ? { ...e, context: [...(e.context ?? []), note] } : e)
    }
    const flags = await read($, pending)
    if (!flags.length) return next(e)

    const lines = flags.map(f => {
      const r = parsed.refusals.find(x => x.id === f.id)
      return `- ${f.id}${r ? ` (refuses: ${r.assumption})` : ''}: "${f.term}" in ${f.where}${f.why ? ` — ${f.why}` : ''}`
    })
    await update($, pending, () => [])

    const note = `[deviation-kernel] A check of the work since your last answer found places that may re-impose refused assumptions:\n${lines.join('\n')}\nDeal with these before building further on that work. If a flag is wrong, say so in one line and continue.`
    return next({ ...e, context: [...(e.context ?? []), note] })
  }).catch(($, e, next) => next(e)) // a failed check or offer never holds up the prompt

  // ---------- edits: the step where the conventional filler actually lands ----------

  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    if (!loaded) await loadKernel($, true)

    // Checked before the tells, so a kernel written where there was none takes hold from the next request.
    const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
    if (/(^|[\\/])KERNEL\.md$/i.test(path)) {
      const ran = await next(e)
      await loadKernel($, true)
      return ran
    }
    if (!patterns.length) return next(e)
    if (isExempt(path, await $.session.cwd())) return next(e)

    let added = ''
    let before = ''
    if (e.tool === 'Edit') {
      added = e.new_string
      before = e.old_string
    } else if (e.tool === 'Write') {
      added = e.content
      // A Write replaces the whole file, so what the file held is the replaced text.
      try {
        if (await $.fs.exists(path)) before = await $.fs.read(path)
      } catch {
        // unreadable: judge the new content on its own
      }
    } else if (e.tool === 'NotebookEdit') {
      added = e.new_source
    }

    // Only tells this edit introduces; one already in the replaced text is not new drift.
    const hit = patterns.find(p => p.re.test(added) && !(before && p.re.test(before)))
    if (!hit) return next(e)

    const file = path.split(/[\\/]/).pop() ?? path
    const why = explain(hit.refusal, hit.tell, added, hit.re)
    const flag: Flag = { id: hit.refusal.id, term: hit.tell, where: file, why, at: await $.clock.now() }
    const deny = {
      deny: `Deviation kernel ${hit.refusal.id}, in ${file}. ${why} Rework this part against the refusal. If this use genuinely does not touch the refusal, say why in one line and ask the user before trying again.`,
    }

    const current = mode()
    if (current === 'block') {
      await logFlag($, flag, 'blocked')
      $.ui.toast(`kernel ${flag.id}: blocked "${flag.term}" in ${file}`)
      return deny
    }

    if (current === 'warn') {
      await logFlag($, flag, 'warned')
      await addPending($, [flag])
      $.ui.toast(`kernel ${flag.id}: "${flag.term}" in ${file}`)
      return next(e)
    }

    // ask: hold the edit until you decide
    let answer = 'Refuse it'
    try {
      answer = await $.ui.ask(
        `Kernel ${flag.id}, in ${file}. ${why} Let it through?`,
        { header: 'Kernel', options: ['Refuse it', 'Allow, on purpose'] },
      )
    } catch {
      // dismissed, or nobody to ask (claude -p): fall through to refuse
    }
    if (answer === 'Allow, on purpose') {
      await logFlag($, flag, 'allowed')
      return next(e)
    }
    await logFlag($, flag, 'refused')
    return deny
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'The deviation-kernel guard failed on this edit, so it was not applied. Ask the user before retrying.' }))

  // ---------- answers: semantic drift the keyword tells miss ----------

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!semantic || !section || e.agentId || e.isAborted || (e.answer ?? '').length < 300) return done

    const answer = e.answer.slice(-12000)
    $.clock.after(0, async () => {
      const r = await $.model.complete({
        model: 'haiku',
        effort: 'low',
        maxTokens: 600,
        system:
          'You audit an answer against a project\'s deviation kernel: assumptions the project refuses on purpose. Report only places where the answer adopts, assumes or builds on a refused assumption, including through a standard component that carries it implicitly. Do not report places that name a refused assumption in order to reject or contrast with it. Reply with JSON only: an array of {"id":"R#","quote":"<at most 12 words copied from the answer>","why":"<at most 20 words>"}. Reply [] when nothing trips.',
        prompt: `${section}\n\nANSWER:\n${answer}`,
      })
      if (!r.isAnswered) return
      const start = r.text.indexOf('[')
      const end = r.text.lastIndexOf(']')
      if (start < 0 || end <= start) return
      let found: { id?: string; quote?: string; why?: string }[] = []
      try {
        found = JSON.parse(r.text.slice(start, end + 1))
      } catch {
        return
      }
      const ids = new Set(parsed.refusals.map(x => x.id))
      const at = await $.clock.now()
      const flags: Flag[] = found
        .filter(f => f && typeof f.id === 'string' && ids.has(f.id.toUpperCase()))
        .slice(0, 4)
        .map(f => ({ id: f.id!.toUpperCase(), term: String(f.quote ?? '').slice(0, 120), where: 'last answer', why: String(f.why ?? '').slice(0, 160), at }))
      if (!flags.length) return
      await addPending($, flags)
      for (const f of flags) await logFlag($, f, 'flagged')
      $.ui.toast(`kernel: ${flags.map(f => f.id).join(', ')} drift in last answer`)
    })
    return done
  })

  // ---------- /kernel ----------

  on('command.run', { command: 'kernel' }, async ($, e) => {
    const [sub, ...rest] = (e.args ?? '').trim().split(/\s+/)
    const arg = rest.join(' ').trim()
    const asMode = (m: string): Mode | undefined => (m === 'ask' || m === 'warn' || m === 'block' ? m : undefined)

    if (sub === 'init') {
      if (await loadKernel($)) return { text: `A kernel already exists at ${kernelPath}.` }
      await $.fs.write('KERNEL.md', TEMPLATE)
      await loadKernel($, true)
      return { text: 'Wrote KERNEL.md from the template. Fill in the refusals; the mod picks it up on your next prompt.' }
    }

    if (sub === 'add') {
      if (!arg) return { text: 'Usage: /kernel add <refused assumption> | tells: a, b | instead: ...' }
      if (!(await loadKernel($))) await $.fs.write('KERNEL.md', TEMPLATE.replace(/## Refuses[\s\S]*?\n\n/, '## Refuses\n\n'))
      await loadKernel($, true)
      const n = parsed.refusals.reduce((max, r) => Math.max(max, Number(r.id.slice(1)) || 0), 0) + 1
      const text = await $.fs.read(kernelPath)
      const line = `- R${n}: ${arg}`
      const updated = /## Refuses\s*\n/i.test(text)
        ? text.replace(/(## Refuses[^\n]*\n(?:[ \t]*[-*][^\n]*\n|[ \t]*\n)*?)(\n?## |\s*$)/i, (_m, body, tail) => `${body.replace(/\n*$/, '\n')}${line}\n${tail.startsWith('\n') || tail.trim() === '' ? tail : '\n' + tail}`)
        : `${text.replace(/\n*$/, '\n')}\n## Refuses\n${line}\n`
      await $.fs.write(kernelPath, updated)
      await loadKernel($, true)
      return { text: `Added R${n} to ${kernelPath}. Claude reads it from the next request.` }
    }

    if (sub === 'mode') {
      const next = asMode(arg)
      if (!next) return { text: `Mode is ${mode()}. Use /kernel mode ask|warn|block.` }
      modeOverride = next
      await $.store.set('mode', next)
      await update($, summary, s => (s ? { ...s, mode: next } : s))
      return { text: `Kernel mode: ${next}.` }
    }

    if (sub === 'reload') {
      const ok = await loadKernel($, true)
      return { text: ok ? `Reloaded ${kernelPath}: ${parsed.refusals.length} refusals.` : 'No KERNEL.md here. Run /kernel init.' }
    }

    if (sub === 'log') {
      const log = ((await $.store.get(logKey)) as (Flag & { decision: string })[] | undefined) ?? []
      if (!log.length) return { text: 'No kernel trips logged for this project yet.' }
      return { text: log.slice(-15).map(f => `${f.id} ${f.decision}: "${f.term}" in ${f.where}${f.why ? ` (${f.why})` : ''}`).join('\n') }
    }

    if (sub === 'check') {
      if (!section) return { text: 'No kernel loaded. Run /kernel init.' }
      const r = await $.model.fork({
        prompt: `${section}\n\nAudit the work in this conversation so far against the kernel above. For each refusal, say whether the design or code has quietly re-imposed it, quoting the place. Then list conventional choices made on purpose that do not touch the kernel. Be specific and short. If nothing trips, say so.`,
      })
      return { text: r.isAnswered ? `Kernel audit:\n${r.text}` : 'The kernel audit could not run just now.' }
    }

    // bare /kernel: show it
    if (!(await loadKernel($))) return { text: 'No KERNEL.md in this project. Run /kernel init to write a template, or /kernel add <refusal>.' }
    await $.ui.open({ id: PANE, title: `Kernel: ${parsed.project}`, focus: true, closeOnEscape: true })
    return {}
  })

  // ---------- drawing ----------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, summary)
    if (!s || e.props.hasSurvey) return next(e)
    const flags = await read($, pending)
    const { Box, Text, Button } = $.ui.resolve(e)

    const children: any[] = [Text({ dimColor: true, children: [`◆ kernel · ${s.project} · ${s.refusals} refusals · ${s.mode}`] })]
    if (flags.length) {
      children.push(Text({ color: 'yellow', children: [` · ⚠ ${flags.map(f => f.id).join(', ')} drift → goes to Claude with your next prompt `] }))
      children.push(Button({ key: 'drop', label: 'drop', plain: true, dimColor: true, onPress: () => update($, pending, () => []) }))
    }
    const theirs = await next(e)
    return Box({ flexDirection: 'column', children: [Box({ flexDirection: 'row', children }), ...(theirs ? [theirs] : [])] })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Markdown } = $.ui.resolve(e)
    const log = ((await $.store.get(logKey)) as (Flag & { decision: string })[] | undefined) ?? []
    const refusals = parsed.refusals
      .map(r => `**${r.id}** ${r.assumption}${r.tells.length ? `  \n  tells: ${r.tells.join(', ')}` : ''}${r.instead ? `  \n  instead: ${r.instead}` : ''}`)
      .join('\n\n')
    const keeps = parsed.keeps.length ? `\n\n**Kept conventional:** ${parsed.keeps.join('; ')}` : ''
    const exempt = parsed.exempt.length ? `\n\n**Exempt from the edit check:** ${parsed.exempt.join(', ')}` : ''
    const trips = log.length
      ? `\n\n**Recent trips**\n\n${log.slice(-8).reverse().map(f => `- ${f.id} ${f.decision}: "${f.term}" in ${f.where}${f.why ? `  \n  ${f.why}` : ''}`).join('\n')}`
      : ''
    return Markdown({ key: 'kernel', text: `Mode: **${mode()}** · file: \`${kernelPath}\`\n\n${refusals}${keeps}${exempt}${trips}` })
  })
}
