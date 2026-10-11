import { expect, test } from 'claude-code/testing'

import { absolute, fit, maxUp, rootAbove, sortEntries } from '../hooks/register'

// The engine hands fs.list an absolute path, so the fake disk is keyed by the folder's own name.
const disk: Record<string, { name: string; kind: 'file' | 'dir' }[]> = {
  work: [
    { name: 'notes', kind: 'dir' },
    { name: 'relay', kind: 'dir' },
  ],
  relay: [
    { name: 'src', kind: 'dir' },
    { name: 'README.md', kind: 'file' },
    { name: '.git', kind: 'dir' },
    { name: 'node_modules', kind: 'dir' },
  ],
  src: [{ name: 'main.ts', kind: 'file' }],
}

function stage(on: any) {
  on('session.cwd', async () => ({ value: 'C:\\work\\relay' }))
  on('command.register', async () => ({ value: undefined }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }))
  on('session.start', async () => ({ cwd: 'C:\\work\\relay' }))
  on('fs.list', async ($: any, e: any) => {
    const last = String(e.path ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''
    return { value: (disk[last] ?? []).map(one => ({ ...one, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('tool.call', async () => ({ result: {} }) as any)
}

const paneProps = {
  title: 'Files',
  isFocused: false,
  bodyColumns: 40,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30, contentRows: 1 },
  view: {},
} as any

async function mount($: any) {
  await $.session.start({ cwd: 'C:\\work\\relay' } as any)
  return $.ui.mount({ plugin: 'file-tree', surface: 'terminal', component: 'Pane', requestId: 'file-tree', props: paneProps } as any)
}

test('paths: absolute, and the folders above the working one', () => {
  expect(absolute('C:\\work\\relay', 'src\\main.ts')).toBe('C:/work/relay/src/main.ts')
  expect(absolute('/home/me', '/etc/hosts')).toBe('/etc/hosts')
  expect(rootAbove('C:\\work\\relay', 1)).toBe('C:/work')
  expect(rootAbove('C:\\work\\relay', 2)).toBe('C:/')
  expect(rootAbove('C:\\work\\relay', 9)).toBe('C:/')
  expect(rootAbove('/home/me', 2)).toBe('/')
  expect(maxUp('C:\\work\\relay')).toBe(2)
  expect(maxUp('/home/me')).toBe(1)
})

test('fit cuts a name at its end and a path at its start', () => {
  expect(fit('short', 10)).toBe('short')
  expect(fit('a-very-long-file-name.ts', 10)).toBe('a-very-lo…')
  expect(fit('C:/Users/me/Projects/claude-code-mods', 17, 'tail')).toBe('…claude-code-mods')
  expect(fit('C:/Users/me/Projects/claude-code-mods', 17, 'tail').length).toBe(17)
})

test('sortEntries puts folders first and hides .git and node_modules', () => {
  const names = sortEntries(disk.relay as any).map(one => one.name)
  expect(names).toEqual(['src', 'README.md'])
})

test('the pane lists the working folder, opens a folder, and marks an edited file', async ($, on) => {
  stage(on)
  const ui = await mount($)
  expect(await ui.find({ text: 'README.md' })).toBeDefined()
  expect(await ui.find({ text: 'node_modules' })).toBeUndefined()
  expect(await ui.find({ text: 'main.ts' })).toBeUndefined()

  await ui.press({ key: 'd:C:/work/relay/src' } as any)
  expect(await ui.find({ text: 'main.ts' })).toBeDefined()

  await $.tool.call({ tool: 'Edit', file_path: 'C:\\work\\relay\\src\\main.ts', old_string: 'a', new_string: 'b' } as any)
  expect(await ui.find({ text: '● ' })).toBeDefined()
})

test('up shows the folder the working folder sits in, one level per press; home returns', async ($, on) => {
  stage(on)
  const ui = await mount($)
  expect(await ui.find({ text: 'notes' })).toBeUndefined()

  await ui.press({ key: 'up' } as any)
  expect(await ui.find({ text: 'notes' })).toBeDefined()
  // The working folder stays open under its parent and is marked.
  expect(await ui.find({ text: ' · here' })).toBeDefined()
  expect(await ui.find({ text: 'README.md' })).toBeDefined()
  expect(await ui.find({ text: '1 up from relay' })).toBeDefined()

  await ui.press({ key: 'up' } as any)
  expect(await ui.find({ text: '2 up from relay' })).toBeDefined()
  // At the drive root another press goes no further.
  await ui.press({ key: 'up' } as any)
  expect(await ui.find({ text: '2 up from relay' })).toBeDefined()

  await ui.press({ key: 'home' } as any)
  expect(await ui.find({ text: 'notes' })).toBeUndefined()
  expect(await ui.find({ text: 'README.md' })).toBeDefined()
})
