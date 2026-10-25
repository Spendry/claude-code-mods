import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const COMPOSE = { model: 'opus', promptModel: 'opus', surfaces: ['terminal'] as const, tools: ['Agent'], outputStyle: null, traits: [] }
const TYPED = { wait: false, origin: { kind: 'composer' as const } }
const SIX = ['premise-breaker', 'field-crosser', 'idea-sizer', 'trogg-skip', 'trogg-borrow', 'trogg-poke']

// A project on an in-memory disk. `picks` answers the asks in order.
function project(on: On, { files = {} as Record<string, string>, picks = [] as string[], cwd = '/p', store = {} as Record<string, unknown> } = {}) {
  mock.store(on, store)
  mock.clock(on)
  const slash = (p: string) => p.replaceAll('\\', '/')
  // paths arrive relative, or resolved against the project (with a drive letter on Windows)
  const rel = (p: string) => slash(p).replace(/^(?:[A-Za-z]:)?\/p\//, '').replace(/^\.\//, '')
  const disk: Record<string, string> = { ...files }
  const seen = { asked: [] as string[], entered: [] as (readonly string[] | undefined)[], disk }
  // a folder exists when a file under it does
  on('fs.exists', async ($, e) => ({ value: rel(e.path) in disk || Object.keys(disk).some(k => k.startsWith(rel(e.path) + '/')) }))
  on('fs.read', async ($, e) => {
    const p = slash(e.path)
    const t = p.match(/\/templates\/(.+)\.md$/)
    if (t) return { value: `---\nname: ${t[1]}\n---\ntemplate ${t[1]}` }
    if (!(rel(p) in disk)) throw new Error('ENOENT')
    return { value: disk[rel(p)]! }
  })
  on('fs.write', async ($, e) => {
    disk[rel(e.path)] = e.text
    return { value: undefined }
  })
  on('fs.list', async ($, e) => {
    const dir = rel(e.path ?? '.').replace(/\/$/, '')
    const names = new Set<string>()
    for (const k of Object.keys(disk)) if (k.startsWith(dir + '/')) names.add(k.slice(dir.length + 1).split('/')[0]!)
    if (!names.size) throw new Error('ENOENT')
    return { value: [...names].map(name => ({ name, kind: (Object.keys(disk).some(k => k.startsWith(`${dir}/${name}/`)) ? 'directory' : 'file') as 'directory' | 'file', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('session.cwd', async () => ({ value: cwd }))
  on('session.root', async () => ({ value: cwd }))
  on('env.get', async ($, e) => ({ value: e.name === 'HOME' ? '/home/sam' : undefined }))
  on('command.register', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }))
  on('prompt.submit', async ($, e) => {
    seen.entered.push(e.context)
    return { text: e.text }
  })
  on('tool.call', async ($, e) => {
    if (e.tool === 'AskUserQuestion') {
      const q = e.questions[0]!.question
      seen.asked.push(q)
      return { result: { questions: e.questions, answers: { [q]: picks.shift() ?? 'Not this session' } } }
    }
    return { result: 'ok' }
  })
  return seen
}

const allSix = () => Object.fromEntries(SIX.map(a => [`.claude/agents/${a}.md`, `mine ${a}`]))

test('a project without the agents is offered them once; yes installs all six and the ideas README', async ($, on) => {
  const seen = project(on, { picks: ['Install them', 'Later'] })
  await $.prompt.submit({ text: 'look at the parser', ...TYPED })
  await $.prompt.submit({ text: 'and the lexer', ...TYPED })
  expect(seen.asked.length).toBe(2)                         // the offer, then the tailoring question
  expect(seen.asked[0]).toContain('no exploration agents')
  expect(seen.asked[1]).toContain('tailor')
  for (const a of SIX) expect(seen.disk[`.claude/agents/${a}.md`]).toContain(`template ${a}`)
  expect(seen.disk['ideas/README.md']).toContain('template ideas-README')
  expect(seen.entered[0]?.join('\n')).toContain('Installed premise-breaker')
  expect(seen.entered[0]?.join('\n')).not.toContain('tailor the six')
  expect(seen.entered[1]).toBeUndefined()
})

test('tailor now sends Claude the tailoring note', async ($, on) => {
  const seen = project(on, { picks: ['Install them', 'Yes, tailor them now'] })
  await $.prompt.submit({ text: 'look at the parser', ...TYPED })
  expect(seen.entered[0]?.join('\n')).toContain('tailor the six exploration agents')
  expect(seen.entered[0]?.join('\n')).toContain('write it only when they say so')
})

test('an agent the project already has is never overwritten', async ($, on) => {
  const seen = project(on, { files: { '.claude/agents/idea-sizer.md': 'mine idea-sizer' }, picks: ['Install them', 'Later'] })
  await $.prompt.submit({ text: 'go', ...TYPED })
  expect(seen.asked[0]).toContain('only 1 of the six')
  expect(seen.disk['.claude/agents/idea-sizer.md']).toBe('mine idea-sizer')
  expect(seen.disk['.claude/agents/trogg-poke.md']).toContain('template trogg-poke')
})

test('never in this folder is remembered', async ($, on) => {
  const seen = project(on, { store: { 'never:/p': true } })
  await $.prompt.submit({ text: 'go', ...TYPED })
  expect(seen.asked.length).toBe(0)
})

test('a project that has all six is not asked, and gets the guide', async ($, on) => {
  const seen = project(on, { files: allSix() })
  await $.prompt.submit({ text: 'go', ...TYPED })
  expect(seen.asked.length).toBe(0)
  const composed = await $.prompt.compose(COMPOSE)
  const guide = composed.sections.find(s => s.id === 'idea-agents:guide')
  expect(guide?.text).toContain('Subagents can\'t start subagents')
  expect(guide?.text).toContain('A gate\'s bar never moves')
})

test('the guide stays out where the agents are not installed', async ($, on) => {
  project(on)
  const composed = await $.prompt.compose(COMPOSE)
  expect(composed.sections.find(s => s.id === 'idea-agents:guide')).toBeUndefined()
})

test('/ideas new numbers runs within a day and writes the run card and data note', async ($, on) => {
  const seen = project(on, { files: allSix() })
  await $.command.run({ command: 'ideas', args: 'new Batch 8 gap' })
  const r = await $.command.run({ command: 'ideas', args: 'new attention cost' })
  // the date comes from the (mocked) clock, so find the folders by shape
  const card = Object.keys(seen.disk).find(k => /^ideas\/\d{4}-\d\d-\d\d-01-batch-8-gap\/README\.md$/.test(k))
  const data = Object.keys(seen.disk).find(k => /^ideas\/\d{4}-\d\d-\d\d-02-attention-cost\/0-data\.md$/.test(k))
  expect(card && seen.disk[card]).toContain('# Run 01 · Batch 8 gap')
  expect(data && seen.disk[data]).toContain('## Rules')
  expect(JSON.stringify(r)).toContain('-02-attention-cost')
})

test('a project that keeps research apart gets its runs in research/ideas/', async ($, on) => {
  const seen = project(on, { files: { ...allSix(), 'research/results/g0.json': '{}' } })
  await $.command.run({ command: 'ideas', args: 'new kv cost' })
  expect(Object.keys(seen.disk).some(k => /^research\/ideas\/\d{4}-\d\d-\d\d-01-kv-cost\/README\.md$/.test(k))).toBe(true)
  expect(Object.keys(seen.disk).some(k => k.startsWith('ideas/'))).toBe(false)
})

test('a slash command runs without the offer', async ($, on) => {
  const seen = project(on, { picks: ['Install them'] })
  await $.prompt.submit({ text: '/ideas', command: { name: 'ideas', args: '' }, ...TYPED })
  expect(seen.asked.length).toBe(0)
})
