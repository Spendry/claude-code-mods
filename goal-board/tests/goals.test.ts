import { expect, mock, test } from 'claude-code/testing'

test('tasks drive progress and the board', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  on('session.id', async () => ({ value: 's1' }))
  on('session.cwd', async () => ({ value: '/home/me/relay' }))
  on('command.register', async () => ({ value: undefined }))
  on('ui.render', async ($, e) => $.ui.resolve(e).Box({ children: [] }) as any)
  on('ui.open', async () => ({ value: { isPlaced: false, reason: 'no pane here' } }))
  on('prompt.submit', async ($, e) => ({ text: e.text }) as any)
  on('session.start', async () => ({ cwd: '/home/me/relay' }))
  let n = 0
  on('tool.call', async ($, e) => (e.tool === 'TaskCreate' ? { result: { task: { id: String(++n), subject: e.subject } } } : { result: {} }) as any)

  await $.session.start({ cwd: '/home/me/relay' } as any)
  await $.prompt.submit({ text: 'Build the async pipeline stage' } as any)

  await $.tool.call({ tool: 'TaskCreate', subject: 'Write handshake', description: '' } as any)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Test handshake', description: '' } as any)
  await clock.advance(10 * 60_000)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as any)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' } as any)

  const board = JSON.stringify(await $.command.run({ command: 'goals', args: '' } as any))
  expect(board).toContain('relay: Build the async pipeline stage')
  expect(board).toContain('1/2')
  expect(board).toContain('~10m left')
  expect(board).toContain('now: Test handshake')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'goal-board', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4, contentRows: 1 }, view: 'expanded' } as any })
    expect(await ui.find({ text: '1/2' })).toBeDefined()
  }
})

test('a finished session stays on the board after it ends; an unfinished one drops off', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  let id = 'done-session'
  on('session.id', async () => ({ value: id }))
  on('session.cwd', async () => ({ value: '/home/me/relay' }))
  on('command.register', async () => ({ value: undefined }))
  on('ui.open', async () => ({ value: { isPlaced: false, reason: 'no pane here' } }))
  on('prompt.submit', async ($, e) => ({ text: e.text }) as any)
  on('session.start', async () => ({ cwd: '/home/me/relay' }))
  on('session.end', async ($, e) => ({ sessionId: e.sessionId }))
  on('tool.call', async ($, e) => (e.tool === 'TaskCreate' ? { result: { task: { id: '1', subject: e.subject } } } : { result: {} }) as any)

  await $.session.start({ cwd: '/home/me/relay' } as any)
  await $.prompt.submit({ text: 'Ship the handshake' } as any)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Write handshake', description: '' } as any)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as any)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: id } as any)

  id = 'open-session'
  await $.session.start({ cwd: '/home/me/relay' } as any)
  await $.prompt.submit({ text: 'Half-finished work' } as any)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Start something', description: '' } as any)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: id } as any)

  const board = JSON.stringify(await $.command.run({ command: 'goals', args: '' } as any))
  expect(board).toContain('Ship the handshake')
  expect(board).toContain('ended')
  expect(board).not.toContain('Half-finished work')
})
