import { expect, mock, test } from 'claude-code/testing'

test('a request starts the clock and prices a miss', async ($, on) => {
  const clock = mock.clock(on)
  on('session.usage', async () => ({ value: { startedAt: 0, context: { tokens: 84_000, window: 200_000, percent: 42 }, rateLimits: [], cost: { usd: 4.1 } } }))
  on('command.register', async () => ({ value: undefined }))
  on('turn.step', async function* () {
    return {
      turnId: 't1', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn',
      usage: { model: 'claude-opus-5-5', input_tokens: 2_000, output_tokens: 300, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 18_000 },
    } as any
  })
  on('command.run', async () => ({ text: 'engine' }))

  const before = await $.command.run({ command: 'cache', args: '' } as any)
  expect(JSON.stringify(before)).toContain('nothing is cached')

  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) { /* drain */ }
  await stream.result

  const warm = JSON.stringify(await $.command.run({ command: 'cache', args: '' } as any))
  expect(warm).toContain('warm, 5:00 left of 5m')
  expect(warm).toContain('Prefix: 100k tokens')
  // 100k tokens x $4/M x 1.25 = $0.50
  expect(warm).toContain('miss ≈ $0.50')
  expect(warm).toContain('Session so far at API rates: $4.10')

  await clock.advance(5 * 60_000 + 1000)
  const cold = JSON.stringify(await $.command.run({ command: 'cache', args: '' } as any))
  expect(cold).toContain('cold')
})

test('a cache read after more than five idle minutes switches auto to the one-hour cache', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.usage', async () => ({ value: { startedAt: 0, context: { tokens: 84_000, window: 200_000, percent: 42 }, rateLimits: [], cost: { usd: 4.1 } } }))
  on('command.register', async () => ({ value: undefined }))
  on('turn.step', async function* () {
    return {
      turnId: 't1', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn',
      usage: { model: 'claude-opus-5-5', input_tokens: 2_000, output_tokens: 300, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 18_000 },
    } as any
  })
  on('command.run', async () => ({ text: 'engine' }))
  on('session.start', async () => ({ cwd: '/p' }) as any)
  await $.session.start({ cwd: '/p' } as any)

  const step = async () => {
    const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
    for await (const _ of stream) { /* drain */ }
    await stream.result
  }

  await step()
  expect(JSON.stringify(await $.command.run({ command: 'cache', args: '' } as any))).toContain('left of 5m, assumed')

  await clock.advance(6 * 60_000)
  await step()
  const after = JSON.stringify(await $.command.run({ command: 'cache', args: '' } as any))
  expect(after).toContain('left of 1h, detected')
  // 100k tokens x $4/M x 2 = $0.80
  expect(after).toContain('miss ≈ $0.80')
})
