import type { Register } from 'claude-code'

// Six agents: three that explore, and a lazy helper (a trogg) for each.
const AGENTS = ['premise-breaker', 'field-crosser', 'idea-sizer', 'trogg-skip', 'trogg-borrow', 'trogg-poke']
const AGENT_DIR = '.claude/agents'
// The ideas folder: research/ideas/ in a project that keeps research apart, else ideas/.
const IDEA_DIRS = ['research/ideas', 'ideas']

const OFFER = { yes: 'Install them', later: 'Not this session', never: 'Never in this folder' }
const TAILOR = { now: 'Yes, tailor them now', later: 'Later', keep: 'Keep them generic' }

// The guide Claude carries in a project that has the agents.
const GUIDE = `<idea_agents>
This project has six exploration agents in .claude/agents/: premise-breaker, field-crosser and idea-sizer, each with a lazy helper (trogg-skip, trogg-borrow, trogg-poke, on haiku). They propose and size ideas; they never edit project code. Use them when the person asks for a round on a problem, or when a goal is close but stuck and the person agrees to a round.

A round, one folder per run:
1. \`/ideas new <topic>\` makes <ideas>/<date>-<nn>-<topic>/ (the ideas folder is research/ideas/ where the project keeps research apart, else ideas/) with a run card (README.md) and 0-data.md. Fill 0-data.md first: the question, the current numbers with their sources, the rules (gates, KERNEL.md refusals), and which parts of the current method are choices rather than facts.
2. Start premise-breaker and field-crosser together, each told the run folder. When each finishes, run its trogg on its file (trogg-skip on 1-premises.md, trogg-borrow on 2-fields.md). Subagents can't start subagents, so the main session runs every trogg.
3. Send each upper agent its trogg's note and ask for the short revise step (same agent, so it keeps its context).
4. Start idea-sizer on both files; give it a scratch folder for probes. Then trogg-poke on 3-sizing.md.
5. Report the try-next list to the person. Run only the kill tests they pick. Write 4-result.md (what was run, the numbers, PASS or FAIL against each kill bar) and finish the run card: question, read order, outcome, decisions.

Hold to these:
- A ceiling is only as good as the premise it holds fixed. Say what a poke holds fixed.
- A gate's bar never moves. An idea that changes a gate's terms needs the person's yes before it runs.
- Never score held-out or gate data while choosing; size on validation, then run the gate once.
- Agent reports are model output. Check a claim against the file or number before passing it on.
- New agent files load at the next session start. Until then, run each through the general-purpose agent, told to read its file under .claude/agents/ and follow it exactly (haiku for the troggs).
- If a guard blocks an agent's note, stop and ask the person; don't route around it.
</idea_agents>`

function folderKey(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

// Paths hang off the session's root folder: the working directory can move during a session.
async function at($: any, path: string): Promise<string> {
  return `${(await $.session.root()).replace(/[\\/]+$/, '')}/${path}`
}

async function ideasDir($: any): Promise<string> {
  for (const d of IDEA_DIRS) if (await $.fs.exists(await at($, d))) return d
  return (await $.fs.exists(await at($, 'research'))) ? 'research/ideas' : 'ideas'
}

async function missing($: any): Promise<string[]> {
  const out: string[] = []
  for (const a of AGENTS) if (!(await $.fs.exists(await at($, `${AGENT_DIR}/${a}.md`)))) out.push(a)
  return out
}

/** Writes the agents this project lacks (never overwrites one) and ideas/README.md if absent. */
async function install($: any): Promise<string[]> {
  const wrote: string[] = []
  for (const a of await missing($)) {
    await $.fs.write(await at($, `${AGENT_DIR}/${a}.md`), await $.fs.read(`${$.plugin.root}/templates/${a}.md`))
    wrote.push(a)
  }
  const IDEAS = await ideasDir($)
  if (!(await $.fs.exists(await at($, `${IDEAS}/README.md`))))
    await $.fs.write(await at($, `${IDEAS}/README.md`), await $.fs.read(`${$.plugin.root}/templates/ideas-README.md`))
  return wrote
}

function slug(topic: string): string {
  return topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'run'
}

/** ideas/<date>-<nn>-<topic>/ with a run card and a data note to fill. */
async function newRun($: any, topic: string): Promise<string> {
  const date = new Date(await $.clock.now()).toISOString().slice(0, 10)
  const IDEAS = await ideasDir($)
  let entries: { name: string; kind: string }[] = []
  try {
    entries = await $.fs.list(await at($, IDEAS))
  } catch {
    // no ideas folder yet
  }
  const today = entries.filter(e => e.kind === 'directory' && e.name.startsWith(`${date}-`)).length
  const name = `${date}-${String(today + 1).padStart(2, '0')}-${slug(topic)}`
  const dir = `${IDEAS}/${name}`
  const full = await at($, dir)
  await $.fs.write(
    `${full}/README.md`,
    `# Run ${String(today + 1).padStart(2, '0')} · ${topic}\n\n**Question.** \n\n**Outcome.** (open)\n\n## Read in this order\n| File | Agent | What it holds |\n|---|---|---|\n| \`0-data.md\` | main session | |\n| \`1-premises.md\` | premise-breaker | |\n| \`1-premises-lazy-skip.md\` | trogg-skip | |\n| \`2-fields.md\` | field-crosser | |\n| \`2-fields-lazy-borrow.md\` | trogg-borrow | |\n| \`3-sizing.md\` | idea-sizer | |\n| \`3-sizing-lazy-poke.md\` | trogg-poke | |\n| \`4-result.md\` | main session | |\n\n## Decisions\n`,
  )
  await $.fs.write(
    `${full}/0-data.md`,
    `# ${topic}: the data\n\n## The question\n\n## Current numbers (with sources)\n\n## Rules (gates, refusals, what may not change)\n\n## Choices in the current method, not facts\n\n## Code and files\n`,
  )
  return dir
}

const TAILOR_NOTE = `[idea-agents] The person asked you to tailor the six exploration agents in .claude/agents/ to this project. Read the project's own record first (CLAUDE.md, README, design notes, KERNEL.md, where results are kept). Then, one agent at a time, propose specific edits: the project's real building blocks in place of generic ones, its gates and units, its results files, its scratch and probe limits. Show each change and write it only when they say so. Keep the six roles and the run-folder file names as they are.`

// ---------- module state (rebuilt on every reload) ----------
let offer = true
let installed = false
// Folders already offered this session. A reload asks again; /clear does not.
const offered = new Set<string>()

async function refresh($: any) {
  installed = (await missing($)).length === 0
}

export const register: Register = (on, options) => {
  offer = ((options as { offer?: boolean }) ?? {}).offer !== false

  on('session.start', async ($, e, next) => {
    await refresh($)
    try {
      await $.command.register({
        name: 'ideas',
        description: 'Exploration agents: status, install, new <topic>, tailor',
        argumentHint: '[install | new <topic> | tailor]',
        immediate: true,
      })
    } catch {
      // name taken: the rest of the mod still works
    }
    return next(e)
  })

  // The guide rides in the system prompt only where the agents are installed.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!installed) return composed
    return { sections: [...composed.sections, { id: 'idea-agents:guide', text: GUIDE, scope: 'session' as const }] }
  })

  // First typed prompt in a folder without the agents: offer them, once.
  on('prompt.submit', async ($, e, next) => {
    await refresh($)
    if (installed || !offer || e.command || e.isMeta || (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge')) return next(e)
    const cwd = await $.session.root()
    const key = folderKey(cwd)
    if (offered.has(key)) return next(e)
    offered.add(key)
    const homes = [await $.env.get('HOME'), await $.env.get('USERPROFILE')].filter(Boolean).map((h: string) => folderKey(h))
    if (homes.includes(key) || (await $.store.get(`never:${key}`))) return next(e)

    const lacking = await missing($)
    const folder = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd
    let answer = OFFER.later
    try {
      answer = await $.ui.ask(
        `${folder} has ${lacking.length === AGENTS.length ? 'no' : `only ${AGENTS.length - lacking.length} of the six`} exploration agents (three that explore ideas, three lazy helpers). Install ${lacking.length === AGENTS.length ? 'them' : 'the missing ones'} into .claude/agents/?`,
        { header: 'Idea agents', options: [OFFER.yes, OFFER.later, OFFER.never] },
      )
    } catch {
      // dismissed, or nobody to ask
    }
    if (answer === OFFER.never) {
      await $.store.set(`never:${key}`, true)
      $.ui.toast(`idea-agents: no more offers in ${folder}. /ideas install still works.`)
      return next(e)
    }
    if (answer !== OFFER.yes) return next(e)

    const wrote = await install($)
    await refresh($)
    let tailor = TAILOR.later
    try {
      tailor = await $.ui.ask('Installed. Should Claude tailor the agents to this project (its building blocks, gates, results files)?', {
        header: 'Idea agents',
        options: [TAILOR.now, TAILOR.later, TAILOR.keep],
      })
    } catch {
      // dismissed: leave them generic for now
    }
    const notes = [
      `[idea-agents] Installed ${wrote.join(', ')} into .claude/agents/ and ideas/README.md if it was missing. They load as agent types at the next session start; until then run them through the general-purpose agent told to follow each file. Mention this in one line, then answer the person's message.`,
    ]
    if (tailor === TAILOR.now) notes.push(TAILOR_NOTE + ' Do this after answering their message.')
    return next({ ...e, context: [...(e.context ?? []), ...notes] })
  }).catch(($, e, next) => next(e)) // a failed offer never holds up the prompt

  on('command.run', { command: 'ideas' }, async ($, e) => {
    const [sub, ...rest] = (e.args ?? '').trim().split(/\s+/)
    const arg = rest.join(' ').trim()

    if (sub === 'install') {
      const wrote = await install($)
      await refresh($)
      return { text: wrote.length ? `Installed ${wrote.join(', ')} into ${AGENT_DIR}/. They load as agent types at the next session start.` : 'All six agents are already here.' }
    }

    if (sub === 'new') {
      if (!arg) return { text: 'Usage: /ideas new <topic>' }
      const dir = await newRun($, arg)
      return { text: `Made ${dir}/ with README.md (the run card) and 0-data.md. Fill 0-data.md, then ask Claude to run the round.` }
    }

    if (sub === 'tailor') {
      if (!installed) return { text: 'The agents are not all installed here. Run /ideas install first.' }
      const r = await $.model.fork({ prompt: TAILOR_NOTE + ' Start with the first agent now.' })
      return { text: r.isAnswered ? r.text : 'Claude could not start the tailoring just now.' }
    }

    // bare /ideas: status
    const lacking = await missing($)
    const IDEAS = await ideasDir($)
    let runs: string[] = []
    try {
      runs = (await $.fs.list(await at($, IDEAS))).filter((x: { kind: string }) => x.kind === 'directory').map((x: { name: string }) => x.name).sort()
    } catch {
      // no ideas folder
    }
    const agents = lacking.length ? `Missing: ${lacking.join(', ')}. /ideas install adds them.` : 'All six agents installed.'
    const last = runs.length ? `\n${runs.length} run(s) in ${IDEAS}/, latest ${runs[runs.length - 1]}.` : `\nNo runs yet. /ideas new <topic> starts one.`
    return { text: agents + last }
  })
}
