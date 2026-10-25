import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const KERNEL = `# Kernel: Relay

## Refuses
- R1: a single global clock | tells: global clock, /clock[_ ]tree/ | instead: local handshakes per stage
- R2: fixed instruction width | tells: fixed-width

## Keeps conventional
- build system, test harness
`

const COMPOSE = { model: 'opus', promptModel: 'opus', surfaces: ['terminal'] as const, tools: ['Edit', 'Write'], outputStyle: null, traits: [] }

// Stand in for the disk: one KERNEL.md at the project root, plus any files a test adds.
function disk(on: On, files: Record<string, string> = {}) {
  mock.store(on)
  mock.clock(on)
  // Paths arrive with the OS separator; compare with forward slashes so this holds on Windows too.
  const slash = (path: string) => path.replaceAll('\\', '/')
  const fileAt = (path: string) => Object.keys(files).find(f => slash(path).endsWith(f))
  on('fs.exists', async ($, e) => {
    const path = slash(e.path)
    return { value: (path.endsWith('/KERNEL.md') && !path.endsWith('/.claude/KERNEL.md')) || fileAt(path) !== undefined }
  })
  on('fs.stat', async () => ({ value: { kind: 'file', size: KERNEL.length, mtimeMs: 1, isLink: false } }))
  on('fs.read', async ($, e) => {
    const f = fileAt(e.path)
    return { value: f === undefined ? KERNEL : files[f]! }
  })
  on('session.cwd', async () => ({ value: '/p' }))
  on('command.register', async () => ({ value: undefined }))
  on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }))
  on('tool.call', async () => ({ result: 'written' }))
}

test('the kernel rides in the system prompt', async ($, on) => {
  disk(on)
  const composed = await $.prompt.compose(COMPOSE)
  const kernel = composed.sections.find(s => s.id === 'deviation-kernel:kernel')
  expect(kernel?.scope).toBe('session')
  expect(kernel?.text).toContain('R1: a single global clock')
  expect(kernel?.text).toContain('Kept conventional on purpose: build system, test harness')
})

test('block mode refuses an edit that brings in a tell', { options: { mode: 'block', semanticCheck: false } }, async ($, on) => {
  disk(on)
  await $.prompt.compose(COMPOSE)
  const r = await $.tool.call({ tool: 'Write', file_path: '/p/core.v', content: 'module top; // drive the clock_tree from one global clock' })
  expect(JSON.stringify(r)).toContain("marks R1's refused assumption: a single global clock")
})

test('a trip explains itself in two sentences: the matched text, then the instead', { options: { mode: 'block', semanticCheck: false } }, async ($, on) => {
  disk(on)
  await $.prompt.compose(COMPOSE)
  const r = JSON.stringify(await $.tool.call({ tool: 'Write', file_path: '/p/core.v', content: 'module top;\n// drive the clock_tree from one global clock\nendmodule' }))
  expect(r).toContain('The edit adds \\"// drive the clock_tree from one global clock\\", where \\"global clock\\" marks R1')
  expect(r).toContain('This design does otherwise: local handshakes per stage.')
})

test('a refusal with no instead explains in one sentence', { options: { mode: 'block', semanticCheck: false } }, async ($, on) => {
  disk(on)
  await $.prompt.compose(COMPOSE)
  const r = JSON.stringify(await $.tool.call({ tool: 'Write', file_path: '/p/isa.md', content: 'Use a fixed-width encoding.' }))
  expect(r).toContain('marks R2\'s refused assumption: fixed instruction width.')
  expect(r).not.toContain('This design does otherwise')
})

test('an edit with no tell goes through', { options: { mode: 'block', semanticCheck: false } }, async ($, on) => {
  disk(on)
  await $.prompt.compose(COMPOSE)
  const r = await $.tool.call({ tool: 'Write', file_path: '/p/core.v', content: 'module stage; handshake req, ack;' })
  expect(JSON.stringify(r)).toContain('written')
})

test('a tell already in the replaced text is not new drift', { options: { mode: 'block', semanticCheck: false } }, async ($, on) => {
  disk(on)
  await $.prompt.compose(COMPOSE)
  const r = await $.tool.call({ tool: 'Edit', file_path: '/p/legacy.v', old_string: '// old global clock', new_string: '// old global clock, kept for the test bench' })
  expect(JSON.stringify(r)).toContain('written')
})

test('rewriting a file that already holds a tell is not new drift', { options: { mode: 'block', semanticCheck: false } }, async ($, on) => {
  disk(on, { '/p/legacy.v': '// old global clock\nmodule legacy;' })
  await $.prompt.compose(COMPOSE)
  const r = await $.tool.call({ tool: 'Write', file_path: '/p/legacy.v', content: '// old global clock\nmodule legacy; // tidied' })
  expect(JSON.stringify(r)).toContain('written')
})

// ---------- exempt paths ----------

const EXEMPT_KERNEL = `${KERNEL}
## Exempt
- \`ideas/**\` idea notes weigh refused assumptions by name
- docs/reviews/
`

function exemptDisk(on: On) {
  mock.store(on)
  mock.clock(on)
  on('fs.exists', async ($, e) => ({ value: e.path.replaceAll('\\', '/').endsWith('/KERNEL.md') && !e.path.replaceAll('\\', '/').endsWith('/.claude/KERNEL.md') }))
  on('fs.stat', async () => ({ value: { kind: 'file', size: EXEMPT_KERNEL.length, mtimeMs: 1, isLink: false } }))
  on('fs.read', async () => ({ value: EXEMPT_KERNEL }))
  on('session.cwd', async () => ({ value: '/p' }))
  on('command.register', async () => ({ value: undefined }))
  on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }))
  on('tool.call', async () => ({ result: 'written' }))
}

test('an exempt path takes a note that names a refused assumption', { options: { mode: 'block', semanticCheck: false } }, async ($, on) => {
  exemptDisk(on)
  await $.prompt.compose(COMPOSE)
  const deep = await $.tool.call({ tool: 'Write', file_path: '/p/ideas/2026-10-24-01-clock/1-premises.md', content: 'A1: a global clock, inverted: local handshakes.' })
  expect(JSON.stringify(deep)).toContain('written')
  const folder = await $.tool.call({ tool: 'Write', file_path: '/p/docs/reviews/r1.md', content: 'drop the clock_tree' })
  expect(JSON.stringify(folder)).toContain('written')
})

test('outside the exempt paths the same text is still refused', { options: { mode: 'block', semanticCheck: false } }, async ($, on) => {
  exemptDisk(on)
  await $.prompt.compose(COMPOSE)
  const r = await $.tool.call({ tool: 'Write', file_path: '/p/src/top.v', content: '// one global clock' })
  expect(JSON.stringify(r)).toContain("marks R1's refused assumption")
  const near = await $.tool.call({ tool: 'Write', file_path: '/p/ideas-old.v', content: '// one global clock' })
  expect(JSON.stringify(near)).toContain("marks R1's refused assumption")
})

test('the exempt paths are named in the system prompt', async ($, on) => {
  exemptDisk(on)
  const composed = await $.prompt.compose(COMPOSE)
  const text = composed.sections.find(s => s.id === 'deviation-kernel:kernel')?.text ?? ''
  expect(text).toContain('Exempt from the edit check')
  expect(text).toContain('ideas/**, docs/reviews/')
})

// ---------- a folder with no kernel ----------

const TYPED = { wait: false, origin: { kind: 'composer' as const } }

// A folder with no KERNEL.md until an edit writes one. `pick` answers the offer.
function bare(on: On, pick: string, { cwd = '/p', store = {} as Record<string, unknown> } = {}) {
  mock.store(on, store)
  mock.clock(on)
  const slash = (path: string) => path.replaceAll('\\', '/')
  const seen ={ asked: [] as string[], entered: [] as (readonly string[] | undefined)[], kernel: '' }
  on('fs.exists', async ($, e) => ({ value: seen.kernel !== '' && slash(e.path).endsWith('/KERNEL.md') && !slash(e.path).endsWith('/.claude/KERNEL.md') }))
  on('fs.stat', async () => ({ value: { kind: 'file', size: seen.kernel.length, mtimeMs: 1, isLink: false } }))
  on('fs.read', async () => ({ value: seen.kernel }))
  on('session.cwd', async () => ({ value: cwd }))
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
      return { result: { questions: e.questions, answers: { [q]: pick } } }
    }
    if (e.tool === 'Write' && slash(e.file_path).endsWith('/KERNEL.md')) seen.kernel = e.content
    return { result: 'written' }
  })
  return seen
}

test('a folder with no kernel is offered one at its first typed prompt, once', async ($, on) => {
  const seen = bare(on, 'Yes, now')
  await $.prompt.submit({ text: 'tidy the parser', ...TYPED })
  await $.prompt.submit({ text: 'and the lexer', ...TYPED })
  expect(seen.asked.length).toBe(1)
  expect(seen.asked[0]).toContain('no KERNEL.md in p')
  expect(seen.entered[0]?.join('\n')).toContain('before working on their message')
  expect(seen.entered[0]?.join('\n')).toContain('Do not propose any of your own')
  expect(seen.entered[1]).toBeUndefined()
})

test('after this message puts the interview after the answer', async ($, on) => {
  const seen = bare(on, 'After this message')
  await $.prompt.submit({ text: 'tidy the parser', ...TYPED })
  expect(seen.entered[0]?.join('\n')).toContain('Answer their message first, then start')
})

test('not this session sends nothing to Claude', async ($, on) => {
  const seen = bare(on, 'Not this session')
  await $.prompt.submit({ text: 'tidy the parser', ...TYPED })
  expect(seen.asked.length).toBe(1)
  expect(seen.entered[0]).toBeUndefined()
})

test('a folder declined before is not offered again', async ($, on) => {
  const seen = bare(on, 'Yes, now', { store: { 'never:/p': true } })
  await $.prompt.submit({ text: 'tidy the parser', ...TYPED })
  expect(seen.asked.length).toBe(0)
  expect(seen.entered[0]).toBeUndefined()
})

test('the home folder is not offered one', async ($, on) => {
  const seen = bare(on, 'Yes, now', { cwd: '/home/sam' })
  await $.prompt.submit({ text: 'what is on today', ...TYPED })
  expect(seen.asked.length).toBe(0)
})

test('a slash command runs without the offer, and the next typed prompt gets it', async ($, on) => {
  const seen = bare(on, 'Not this session')
  await $.prompt.submit({ text: '/kernel init', command: { name: 'kernel', args: 'init' }, ...TYPED })
  expect(seen.asked.length).toBe(0)
  await $.prompt.submit({ text: 'tidy the parser', ...TYPED })
  expect(seen.asked.length).toBe(1)
})

test('the offer can be switched off', { options: { offerKernel: false } }, async ($, on) => {
  const seen = bare(on, 'Yes, now')
  await $.prompt.submit({ text: 'tidy the parser', ...TYPED })
  expect(seen.asked.length).toBe(0)
})

test('a kernel written where there was none goes into the system prompt', async ($, on) => {
  bare(on, 'Yes, now')
  await $.prompt.submit({ text: 'tidy the parser', ...TYPED })
  await $.tool.call({ tool: 'Write', file_path: '/p/KERNEL.md', content: KERNEL })
  const composed = await $.prompt.compose(COMPOSE)
  expect(composed.sections.find(s => s.id === 'deviation-kernel:kernel')?.text).toContain('R1: a single global clock')
})
