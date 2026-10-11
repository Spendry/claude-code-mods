import type { Register } from 'claude-code'

// Claude API list prices, USD per million tokens, from Anthropic's pricing page as of Oct 2026.
// Check https://platform.claude.com/docs/en/about-claude/pricing and edit if they move.
// Cache writes are priced from `input`: 1.25x for the 5-minute cache, 2x for the 1-hour cache.
type Rate = { input: number; output: number; cacheRead: number }
const PRICES: { match: RegExp; name: string; rate: Rate }[] = [
  { match: /opus-5-5/, name: 'Opus 5.5', rate: { input: 4, output: 20, cacheRead: 0.2 } },
  { match: /sonnet-5-5/, name: 'Sonnet 5.5', rate: { input: 2, output: 10, cacheRead: 0.2 } },
  { match: /sonnet-5(?!-)/, name: 'Sonnet 5', rate: { input: 2, output: 10, cacheRead: 0.2 } },
  { match: /haiku-5-5/, name: 'Haiku 5.5', rate: { input: 0.1, output: 0.5, cacheRead: 0.01 } },
  { match: /haiku-4-5/, name: 'Haiku 4.5', rate: { input: 1, output: 5, cacheRead: 0.1 } },
]
// Unknown models (Fable, Mythos, anything newer) fall back to Opus 5.5 rates and show "≈".
const FALLBACK = PRICES[0]!

type Last = {
  at: number
  model: string
  prefix: number // tokens in the prompt the cache holds: read + written + uncached input
  read: number
  wrote: number
}

const FIVE_MIN = 5 * 60_000
const ONE_HOUR = 60 * 60_000

// The API usage a mod sees does not say which cache lifetime was written. In `auto`, the meter
// assumes 5 minutes until a request reads from cache after more than five idle minutes, which
// only the one-hour cache can serve, and then remembers 1h for every later session.
let ttlSetting: 'auto' | '5m' | '1h' = 'auto'
let isDetected = false
let ttlMs = FIVE_MIN
let writeMultiplier = 1.25

function applyTtl(isOneHour: boolean) {
  ttlMs = isOneHour ? ONE_HOUR : FIVE_MIN
  writeMultiplier = isOneHour ? 2 : 1.25
}

function ttlLabel(): string {
  const label = ttlMs >= ONE_HOUR ? '1h' : '5m'
  if (ttlSetting !== 'auto') return label
  return isDetected ? `${label}, detected` : `${label}, assumed`
}
let warn = true

let last: Last | null = null
let warnedFor = 0 // the `at` of the request we already warned about
let isWorking = false
let context: { tokens?: number; window: number; percent?: number } | null = null
let costUsd: number | undefined

function priceFor(model: string) {
  const hit = PRICES.find(p => p.match.test(model))
  return { ...(hit ?? FALLBACK), isGuess: !hit }
}

function money(usd: number): string {
  if (usd < 0.01) return '<$0.01'
  if (usd < 10) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(0)}`
}

function tokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function rewriteCost(l: Last): { usd: number; isGuess: boolean } {
  const p = priceFor(l.model)
  return { usd: (l.prefix / 1e6) * p.rate.input * writeMultiplier, isGuess: p.isGuess }
}

function bar(fraction: number, width = 8): string {
  const full = Math.round(Math.max(0, Math.min(1, fraction)) * width)
  return '▰'.repeat(full) + '▱'.repeat(width - full)
}

async function refreshUsage($: any) {
  try {
    const u = await $.session.usage()
    context = u.context
    costUsd = u.cost?.usd
  } catch {
    // usage figures are optional; the meter still runs on its own counts
  }
}

export const register: Register = (on, options) => {
  const o = (options as { cacheTtl?: string; warnBeforeExpiry?: boolean }) ?? {}
  ttlSetting = o.cacheTtl === '5m' || o.cacheTtl === '1h' ? o.cacheTtl : 'auto'
  applyTtl(ttlSetting === '1h')
  warn = o.warnBeforeExpiry !== false

  on('session.start', async ($, e, next) => {
    if (ttlSetting === 'auto' && (await $.store.get('detectedTtl')) === '1h') {
      isDetected = true
      applyTtl(true)
    }
    await refreshUsage($)
    // Redraw once a second so the countdown moves; the engine throttles and coalesces.
    $.clock.every(1000, async () => {
      if (!last) return
      const left = last.at + ttlMs - (await $.clock.now())
      if (warn && !isWorking && left > 0 && left <= 60_000 && warnedFor !== last.at) {
        warnedFor = last.at
        $.ui.toast(`Cache goes cold in ${clock(left)}. A miss rewrites ${tokens(last.prefix)} tokens ≈ ${money(rewriteCost(last).usd)} at API rates.`, { timeoutMs: 8000 })
      }
      $.ui.invalidate('ui.render')
    })
    try {
      await $.command.register({ name: 'cache', description: 'Prompt cache: warmth, rewrite cost, context and session cost', immediate: true })
    } catch {
      // name taken
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    isWorking = true
    return next(e)
  })

  // Every request to the model: what it read from cache, what it wrote, how big the prefix is.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (!e.agentId && result.usage) {
      const u = result.usage
      const at = await $.clock.now()
      // At least half the previous prefix, so a small shared piece kept warm by another request doesn't count.
      if (ttlSetting === 'auto' && !isDetected && last && at - last.at > FIVE_MIN && u.cache_read_input_tokens >= last.prefix / 2) {
        isDetected = true
        applyTtl(true)
        await $.store.set('detectedTtl', '1h')
        $.ui.toast('cache-meter: a cache read after more than 5 idle minutes means the 1-hour cache. The countdown now uses 1h.', { timeoutMs: 8000 })
      }
      last = {
        at,
        model: u.model || e.model,
        prefix: u.cache_read_input_tokens + u.cache_creation_input_tokens + u.input_tokens,
        read: u.cache_read_input_tokens,
        wrote: u.cache_creation_input_tokens,
      }
      await refreshUsage($)
      $.ui.invalidate('ui.render')
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) isWorking = false
    await refreshUsage($)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('command.run', { command: 'cache' }, async ($) => {
    await refreshUsage($)
    if (!last) return { text: 'No requests yet this session, so nothing is cached.' }
    const left = last.at + ttlMs - (await $.clock.now())
    const p = priceFor(last.model)
    const miss = rewriteCost(last)
    const hitCost = (last.prefix / 1e6) * p.rate.cacheRead
    const lines = [
      `Cache: ${left > 0 ? `warm, ${clock(left)} left of ${ttlLabel()}` : 'cold, the next request rewrites the prefix'}`,
      `Prefix: ${tokens(last.prefix)} tokens (last request read ${tokens(last.read)}, wrote ${tokens(last.wrote)})`,
      `Next request at API rates (${p.name}${p.isGuess ? ', guessed' : ''}): hit ≈ ${money(hitCost)}, miss ≈ ${money(miss.usd)}`,
      context ? `Context: ${context.tokens !== undefined ? tokens(context.tokens) : '?'} / ${tokens(context.window)}${context.percent !== undefined ? ` (${Math.round(context.percent)}%)` : ''}` : '',
      costUsd !== undefined ? `Session so far at API rates: ${money(costUsd)}` : '',
    ]
    return { text: lines.filter(Boolean).join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!last || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const left = last.at + ttlMs - (await $.clock.now())
    const miss = rewriteCost(last)
    const approx = miss.isGuess ? '≈' : ''

    const parts: any[] = []
    if (isWorking) {
      parts.push(Text({ color: 'green', children: ['cache live'] }))
    } else if (left > 0) {
      const f = left / ttlMs
      const color = f > 0.5 ? 'green' : f > 0.2 ? 'yellow' : 'red'
      parts.push(Text({ color, children: [`cache ${bar(f)} ${clock(left)}`] }))
    } else {
      parts.push(Text({ color: 'red', bold: true, children: ['cache cold'] }))
    }
    parts.push(Text({ dimColor: true, children: [` · ${left > 0 || isWorking ? 'miss' : 'next turn'} ${approx}${money(miss.usd)}`] }))
    if (context) {
      const pct = context.percent !== undefined ? ` ${Math.round(context.percent)}%` : ''
      parts.push(Text({ dimColor: true, children: [` · ctx ${context.tokens !== undefined ? tokens(context.tokens) : '?'}/${tokens(context.window)}${pct}`] }))
    }
    if (costUsd !== undefined) parts.push(Text({ dimColor: true, children: [` · session ${money(costUsd)} API`] }))

    const theirs = await next(e)
    return Box({ flexDirection: 'column', children: [Box({ flexDirection: 'row', children: parts }), ...(theirs ? [theirs] : [])] })
  })
}
