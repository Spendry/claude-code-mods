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
  expect(JSON.stringify(r)).toContain('R1 refuses: a single global clock')
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
