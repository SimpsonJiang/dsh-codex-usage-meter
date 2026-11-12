/**
 * Node test for the usage-meter Host half. Runs the real plugin entry against a
 * fake Cordis context: exercises pricing, the session-event fold (replacement,
 * retry and turn-duration semantics), per-Session totals, the KPIs, both JSON
 * routes, persistence, and the two backfill generations.
 *
 * Run: node tests/host.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let profileDir = await mkdtemp(join(tmpdir(), 'dsh-usage-meter-test-'))
process.env.DSH_PROFILE_DIR = profileDir

const { apply, __internals } = await import('../index.js')
const {
  buildSnapshot,
  buildStats,
  computeStreaks,
  costOf,
  createState,
  foldSessionTotals,
  isPeak,
  localDateKey,
  nextPeriodChange,
  pricingSignature,
  pruneState,
  resolveConfig,
  resolvePrice,
  sanitizeState,
  serializeState,
  startOfLocalDay,
  truncateCost,
} = __internals

const BEIJING_OFFSET = 8 * 3_600_000
const DAY_MS = 86_400_000
const peakTime = (year, month, day, hour, minute = 0) => Date.UTC(year, month - 1, day, hour, minute) - BEIJING_OFFSET

let passed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok - ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Isolated plugin-data directory for one end-to-end case. */
async function useFreshProfile() {
  profileDir = await mkdtemp(join(tmpdir(), 'dsh-usage-meter-case-'))
  process.env.DSH_PROFILE_DIR = profileDir
  return profileDir
}

/** Minimal fake Cordis context: event capture, synchronous effects, route capture. */
function createFakeContext(services = {}) {
  const listeners = new Map()
  const routes = new Map()
  const ctx = {
    on(event, callback) {
      listeners.set(event, callback)
      return () => listeners.delete(event)
    },
    effect(setup) {
      return setup()
    },
    inject(_names, callback) {
      callback(ctx)
    },
    get(name) {
      return services[name]
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  return { ctx, listeners, routes }
}

/** Invoke one registered route and return `{ status, payload }`. */
function callRoute(route, { method = 'GET', url = '/' } = {}) {
  let status
  let body = ''
  const response = {
    writeHead(nextStatus) {
      status = nextStatus
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) body += String(chunk)
    },
  }
  route.handler({ method, url }, response)
  let payload
  try {
    payload = body === '' ? undefined : JSON.parse(body)
  } catch {
    payload = body
  }
  return { status, payload }
}

async function waitFor(condition, label, timeoutMs = 8_000) {
  const started = Date.now()
  for (;;) {
    const value = await condition()
    if (value !== undefined && value !== false && value !== null) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await sleep(10)
  }
}

/** Apply the plugin and wait until its state load settled and the routes answer. */
async function mount(services, config) {
  const fake = createFakeContext(services)
  apply(fake.ctx, config)
  const summaryRoute = fake.routes.get('/dsh-usage-meter/summary')
  const statsRoute = fake.routes.get('/dsh-usage-meter/stats')
  assert.equal(summaryRoute !== undefined, true, 'summary route registered')
  assert.equal(statsRoute !== undefined, true, 'stats route registered')
  await waitFor(() => {
    const result = callRoute(summaryRoute)
    return result.payload?.ok === true
  }, 'summary payload')
  return {
    ...fake,
    summaryRoute,
    statsRoute,
    emit: (session, event) => fake.listeners.get('session/event')(session, event),
    /** Drive the registered llm/stream waterfall listener with a fake chunk stream. */
    callLlmStream: async (options, chunks) => {
      const handler = fake.listeners.get('llm/stream')
      assert.equal(typeof handler, 'function', 'llm/stream listener registered')
      const stream = (async function* () {
        for (const chunk of chunks) yield chunk
      })()
      const seen = []
      for await (const chunk of handler(options, () => stream)) seen.push(chunk)
      return seen
    },
    summary: (query = '') => callRoute(summaryRoute, { url: `/dsh-usage-meter/summary${query}` }).payload,
    stats: () => callRoute(statsRoute).payload,
  }
}

function requestHeaderEvent({ time, model = 'deepseek-flash', provider = 'deepseek-official', seq = 1 }) {
  return {
    type: 'request/header',
    seq,
    time,
    data: { header: { config: { provider, model } }, reason: 'initial' },
  }
}

function messageEvent({ turn, step, time, usage, model = 'deepseek-flash', provider = 'deepseek-official', seq = 1 }) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn,
      step,
      message: { role: 'assistant', source: { kind: 'model', provider, model } },
      usage,
      stream: [],
    },
  }
}

function attemptEvent({ turn, step, time, usage, seq = 1 }) {
  return {
    type: 'assistant/attempt',
    seq,
    time,
    data: {
      turn,
      step,
      stream: [{ type: 'chunk', time, chunk: { type: 'usage', usage } }],
    },
  }
}

function turnEvent(type, { turn, time, seq = 1 }) {
  return { type, seq, time, data: { turn } }
}

/** Rate in CNY per 1M input tokens at one instant, under the current defaults. */
function flashInputRate(time) {
  const config = resolveConfig({})
  return isPeak(time, config) ? config.models['deepseek-flash'].peak.cacheMiss : config.models['deepseek-flash'].off.cacheMiss
}

// ---------------------------------------------------------------------------
// Pure pricing and period logic
// ---------------------------------------------------------------------------

await test('peak windows follow the configured Beijing schedule', () => {
  const config = resolveConfig({})
  assert.equal(config.pricingMode, 'scheduled')
  assert.equal(config.peakDays, 'weekdays')
  assert.deepEqual(config.peakWindows, [[540, 720], [840, 1080]])
  assert.equal(isPeak(peakTime(2026, 11, 9, 9, 0), config), true)
  assert.equal(isPeak(peakTime(2026, 11, 9, 11, 59), config), true)
  assert.equal(isPeak(peakTime(2026, 11, 9, 12, 0), config), false)
  assert.equal(isPeak(peakTime(2026, 11, 9, 13, 59), config), false)
  assert.equal(isPeak(peakTime(2026, 11, 9, 14, 0), config), true)
  assert.equal(isPeak(peakTime(2026, 11, 9, 17, 59), config), true)
  assert.equal(isPeak(peakTime(2026, 11, 9, 18, 0), config), false)
  // 2026-11-14 is a Saturday and 2026-11-15 a Sunday: off-peak by default.
  assert.equal(isPeak(peakTime(2026, 11, 14, 10, 0), config), false)
  assert.equal(isPeak(peakTime(2026, 11, 15, 15, 0), config), false)

  // `peakDays: daily` bills weekends inside the windows too.
  const daily = resolveConfig({ peakDays: 'daily' })
  assert.equal(daily.peakDays, 'daily')
  assert.equal(isPeak(peakTime(2026, 11, 14, 10, 0), daily), true)
  assert.equal(isPeak(peakTime(2026, 11, 15, 15, 0), daily), true)

  // Custom windows are parsed from `HH:MM-HH:MM` strings.
  const custom = resolveConfig({ peakWindows: ['10:30-11:15'] })
  assert.deepEqual(custom.peakWindows, [[630, 675]])
  assert.equal(isPeak(peakTime(2026, 11, 9, 10, 45), custom), true)
  assert.equal(isPeak(peakTime(2026, 11, 9, 9, 30), custom), false)
})

await test('configured holidays are billed off-peak', () => {
  const config = resolveConfig({ holidays: ['2026-11-09'] })
  assert.equal(isPeak(peakTime(2026, 11, 9, 10, 0), config), false)
  assert.equal(isPeak(peakTime(2026, 11, 10, 10, 0), config), true)
})

await test('next period change follows the configured schedule', () => {
  const weekly = resolveConfig({})
  assert.equal(nextPeriodChange(peakTime(2026, 11, 9, 8, 30), weekly), peakTime(2026, 11, 9, 9, 0))
  assert.equal(nextPeriodChange(peakTime(2026, 11, 9, 10, 0), weekly), peakTime(2026, 11, 9, 12, 0))
  assert.equal(nextPeriodChange(peakTime(2026, 11, 9, 12, 30), weekly), peakTime(2026, 11, 9, 14, 0))
  // Weekday-only windows: Friday 18:30 is followed by Monday 09:00.
  assert.equal(nextPeriodChange(peakTime(2026, 11, 13, 18, 30), weekly), peakTime(2026, 11, 16, 9, 0))

  // Every-day windows: Friday 18:30 is followed by Saturday 09:00.
  const daily = resolveConfig({ peakDays: 'daily' })
  assert.equal(nextPeriodChange(peakTime(2026, 11, 13, 18, 30), daily), peakTime(2026, 11, 14, 9, 0))

  // Weekday-only windows plus a holiday skip the weekend and the holiday Monday.
  const holidayConfig = resolveConfig({ holidays: ['2026-11-16'] })
  assert.equal(nextPeriodChange(peakTime(2026, 11, 13, 18, 30), holidayConfig), peakTime(2026, 11, 17, 9, 0))
})

await test('flash prices: peak costs exactly double off-peak', () => {
  const config = resolveConfig({})
  const flash = config.models['deepseek-flash']
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }
  assert.equal(costOf(usage, flash.peak), 10)
  assert.equal(costOf(usage, flash.off), 5)
  const cacheOnly = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 }
  assert.equal(costOf(cacheOnly, flash.peak), 0.04)
  assert.equal(costOf(cacheOnly, flash.off), 0.02)
  const writeOnly = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 }
  assert.equal(costOf(writeOnly, flash.peak), 2)
})

await test('v4-pro prices follow the official table', () => {
  const config = resolveConfig({})
  const pro = config.models['deepseek-v4-pro']
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }
  assert.equal(costOf(usage, pro.peak), 36)
  assert.equal(costOf(usage, pro.off), 18)
})

await test('the session fold splits cost into cache-hit, cache-miss and output', () => {
  const config = resolveConfig({})
  const at = peakTime(2026, 11, 9, 10, 0)
  const events = [
    requestHeaderEvent({ time: at }),
    messageEvent({
      turn: 1,
      step: 1,
      time: at,
      usage: { inputTokens: 1_000_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0, outputTokens: 3_000_000 },
    }),
  ]
  const folded = foldSessionTotals(events, 0, config, at + 1)
  // Default `scheduled` pricing: 10:00 on a Monday is inside the peak window.
  assert.equal(folded.cacheHitCost, 2 * 0.04)
  assert.equal(folded.cacheMissCost, 1 * 2)
  assert.equal(folded.outputCost, 3 * 8)
  assert.equal(folded.cost, 0.08 + 2 + 24)
  // `flat` charges the off-peak column regardless of the clock.
  const flat = foldSessionTotals(events, 0, resolveConfig({ pricingMode: 'flat' }), at + 1)
  assert.equal(flat.cacheHitCost, 2 * 0.02)
  assert.equal(flat.cacheMissCost, 1 * 1)
  assert.equal(flat.outputCost, 3 * 4)
  assert.equal(flat.cost, 0.04 + 1 + 12)
  // Events at or after the live cutoff are excluded.
  const withoutMessage = foldSessionTotals(events, 0, config, at)
  assert.equal(withoutMessage.cost, 0)
})

await test('money is truncated to cents, never rounded', () => {
  assert.equal(truncateCost(26.089), 26.08)
  assert.equal(truncateCost(1.239), 1.23)
  assert.equal(truncateCost(0.0099), 0)
  assert.equal(truncateCost(1.999), 1.99)
  assert.equal(truncateCost(0), 0)
  assert.equal(truncateCost(-3), 0)
  assert.equal(truncateCost(undefined), 0)
  // Binary-float dust must not lose a legitimate cent.
  assert.equal(truncateCost(0.29), 0.29)
  assert.equal(truncateCost(10.15), 10.15)

  const state = createState()
  state.total.cost = 1.239
  state.total.cacheHitCost = 0.089
  state.total.outputCost = 1.15
  state.sessions['s1'] = { ...createState().total, cost: 26.089, cacheHitCost: 25.999 }
  state.days['2026-11-08'] = { ...createState().total, cost: 1.239 }
  const disk = JSON.parse(serializeState(state))
  assert.equal(disk.total.cost, 1.23)
  assert.equal(disk.total.cacheHitCost, 0.08)
  assert.equal(disk.sessions.s1.cost, 26.08)
  assert.equal(disk.sessions.s1.cacheHitCost, 25.99)
  assert.equal(disk.days['2026-11-08'].cost, 1.23)
})

await test('pricing mode: scheduled (default) honours the peak window, flat does not', async () => {
  await useFreshProfile()
  const at = peakTime(2026, 11, 9, 10, 0) // inside the published weekday peak window
  const scheduled = await mount({}, { backfill: false })
  scheduled.emit({ id: 'session-scheduled' }, requestHeaderEvent({ time: at }))
  scheduled.emit({ id: 'session-scheduled' }, messageEvent({ turn: 1, step: 1, time: at, usage: { inputTokens: 2_000_000, outputTokens: 0 } }))
  const scheduledSummary = scheduled.summary()
  assert.equal(scheduledSummary.total.cost, 4, 'scheduled mode charges the peak price inside the window')
  assert.equal(scheduledSummary.period.pricingMode, 'scheduled')

  await useFreshProfile()
  const flat = await mount({}, { backfill: false, pricingMode: 'flat' })
  flat.emit({ id: 'session-flat' }, requestHeaderEvent({ time: at }))
  flat.emit({ id: 'session-flat' }, messageEvent({ turn: 1, step: 1, time: at, usage: { inputTokens: 2_000_000, outputTokens: 0 } }))
  const flatSummary = flat.summary()
  assert.equal(flatSummary.total.cost, 2, 'flat mode charges the off-peak price at every hour')
  assert.equal(flatSummary.period.pricingMode, 'flat')
})

await test('config can add models, derives the missing side, and aliases retired ids', () => {
  const config = resolveConfig({
    models: { 'my-model': { cacheMiss: 4, output: 12 } },
    aliases: { 'my-model-legacy': 'my-model' },
    fallbackModel: 'my-model',
  })
  assert.equal(config.models['my-model'].peak.cacheMiss, 4)
  assert.equal(config.models['my-model'].off.cacheMiss, 2)
  assert.equal(resolvePrice(config, 'my-model-legacy').priceId, 'my-model')
  assert.equal(resolvePrice(config, 'my-model-legacy').estimated, false)
  const fallback = resolvePrice(config, 'does-not-exist')
  assert.equal(fallback.priceId, 'my-model')
  assert.equal(fallback.estimated, true)
  assert.equal(resolvePrice(config, 'deepseek-flash').estimated, false)
})

// ---------------------------------------------------------------------------
// State hygiene and KPI derivation
// ---------------------------------------------------------------------------

await test('state survives a JSON round trip through sanitizeState', () => {
  const state = createState()
  state.total.cost = 1.25
  state.total.outputTokens = 10
  state.total.cacheHitCost = 0.2
  state.days['2026-11-08'] = { ...createState().total, cost: 0.5, requests: 1 }
  state.sessions['session-a'] = { ...createState().total, requests: 2, cost: 0.25, firstTime: 10, lastTime: 20, longestTurnMs: 5_000 }
  state.slots['s|1:1'] = {
    time: 1,
    provider: 'p',
    model: 'm',
    priceId: 'm',
    estimated: false,
    peak: true,
    cost: 1,
    usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
  }
  const clone = sanitizeState(JSON.parse(JSON.stringify(state)))
  assert.equal(clone.total.cost, 1.25)
  assert.equal(clone.total.cacheHitCost, 0.2)
  assert.equal(clone.days['2026-11-08'].cost, 0.5)
  assert.equal(clone.sessions['session-a'].cost, 0.25)
  assert.equal(clone.sessions['session-a'].longestTurnMs, 5_000)
  assert.equal(clone.slots['s|1:1'].usage.cacheWriteTokens, 4)
  assert.equal(clone.revision, state.revision)
})

await test('pruneState drops old days and dormant slots', () => {
  const config = resolveConfig({})
  const now = peakTime(2026, 11, 9, 10, 0)
  const state = createState()
  state.days['2020-01-01'] = { ...createState().total, cost: 5 }
  state.days[localDateKey(now)] = { ...createState().total, cost: 1 }
  state.slots['old|1:1'] = { time: now - 3 * 3_600_000, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, cost: 0 }
  state.slots['fresh|1:1'] = { time: now - 60_000, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, cost: 0 }
  pruneState(state, config, now)
  assert.equal(state.days['2020-01-01'], undefined)
  assert.equal(state.days[localDateKey(now)].cost, 1)
  assert.equal(state.slots['old|1:1'], undefined)
  assert.equal(state.slots['fresh|1:1'] !== undefined, true)
})

await test('streaks count consecutive active days and keep yesterday alive', () => {
  const now = peakTime(2026, 11, 9, 10, 0)
  const state = createState()
  for (const key of ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']) {
    state.days[key] = { ...createState().total, requests: 1, cost: 1 }
  }
  const streaks = computeStreaks(state, now)
  assert.equal(streaks.longest, 4)
  // Today (11-09) has no usage yet, so the streak still ends yesterday.
  assert.equal(streaks.current, 4)
  state.days['2026-11-09'] = { ...createState().total, requests: 1, cost: 1 }
  assert.equal(computeStreaks(state, now).current, 5)
})

await test('snapshot exposes billing period, totals, pricing and one Session', () => {
  const config = resolveConfig({})
  const state = createState()
  state.days[localDateKey(startOfLocalDay(Date.now()))] = { ...createState().total, cost: 0.25, requests: 2 }
  state.total = { ...createState().total, cost: 1.5, requests: 4, peakCost: 1, offCost: 0.5, inputTokens: 1000, outputTokens: 2000 }
  state.sessions['session-a'] = { ...createState().total, cost: 0.75, requests: 3, peakCost: 0.25, offCost: 0.5, inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheHitCost: 0.1, cacheMissCost: 0.5, outputCost: 0.15, firstTime: 100, lastTime: 200, longestTurnMs: 90_000 }
  const snapshot = buildSnapshot(state, config, Date.now())
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.today.cost, 0.25)
  assert.equal(snapshot.total.totalTokens, 3000)
  assert.equal(snapshot.total.effectiveRate > 0, true)
  assert.equal(['peak', 'off'].includes(snapshot.period.kind), true)
  assert.equal(snapshot.pricing.models['deepseek-flash'].peak.output, 8)
  assert.equal(snapshot.session, undefined)
  const withSession = buildSnapshot(state, config, Date.now(), 'session-a')
  assert.equal(withSession.session.cost, 0.75)
  assert.equal(withSession.session.totalTokens, 35)
  assert.equal(withSession.session.cacheHitCost, 0.1)
  assert.equal(withSession.session.cacheMissCost, 0.5)
  assert.equal(withSession.session.outputCost, 0.15)
  assert.equal(withSession.session.longestTurnMs, 90_000)
  assert.equal(withSession.session.tracked, true)
  const unknown = buildSnapshot(state, config, Date.now(), 'session-missing')
  assert.equal(unknown.session.tracked, false)
  assert.equal(unknown.session.cost, 0)
})

await test('stats payload carries KPIs, a 371-day series and models', () => {
  const config = resolveConfig({})
  const now = Date.now()
  const today = localDateKey(now)
  const yesterday = localDateKey(startOfLocalDay(now) - DAY_MS)
  const state = createState()
  state.days[today] = { ...createState().total, requests: 2, cost: 0.25, inputTokens: 1_000_000, outputTokens: 0, peakCost: 0, offCost: 0.25 }
  state.days[yesterday] = { ...createState().total, requests: 1, cost: 2, inputTokens: 0, outputTokens: 500_000, peakCost: 2, offCost: 0 }
  state.total = { ...createState().total, requests: 3, cost: 2.25, inputTokens: 1_000_000, outputTokens: 500_000 }
  state.models['deepseek-flash'] = { ...createState().total, requests: 3, cost: 2.25 }
  state.sessions['session-a'] = { ...createState().total, requests: 2, cost: 0.25, longestTurnMs: 120_000 }
  state.sessions['session-b'] = { ...createState().total, requests: 1, cost: 2, longestTurnMs: 3_600_000 }
  const stats = buildStats(state, config, now)
  assert.equal(stats.ok, true)
  assert.equal(stats.days.length, 371)
  assert.equal(stats.days[stats.days.length - 1].date, today)
  assert.equal(stats.days[stats.days.length - 1].cost, 0.25)
  assert.equal(String(stats.days[stats.days.length - 1].cost).split('.')[1]?.length <= 2 || Number.isInteger(stats.days[stats.days.length - 1].cost), true)
  assert.equal(stats.kpis.totalTokens, 1_500_000)
  assert.equal(stats.kpis.totalCost, 2.25)
  assert.equal(stats.kpis.peakTokens, 1_000_000)
  assert.equal(stats.kpis.peakDay, today)
  assert.equal(stats.kpis.longestTurnMs, 3_600_000)
  assert.equal(stats.kpis.longestStreakDays, 2)
  assert.equal(stats.kpis.currentStreakDays, 2)
  assert.equal(stats.kpis.activeDays, 2)
  assert.equal(stats.kpis.sessionCount, 2)
  assert.equal(stats.models[0].model, 'deepseek-flash')
})

// ---------------------------------------------------------------------------
// Plugin entry: fold, session totals, turn duration, routes, persistence
// ---------------------------------------------------------------------------

await test('folds usage, replaces a step settlement, and bills retries separately', async () => {
  await useFreshProfile()
  const at = Date.now() - 60_000
  const inputRate = flashInputRate(at)
  const outputRate = inputRate * 4
  const { emit, summary } = await mount({}, { backfill: false })

  emit({ id: 'session-1' }, requestHeaderEvent({ time: at, seq: 1 }))
  emit({ id: 'session-1' }, attemptEvent({ turn: 1, step: 1, time: at, usage: { inputTokens: 1_000_000, outputTokens: 0 }, seq: 2 }))
  emit({ id: 'session-1' }, messageEvent({ turn: 1, step: 1, time: at, usage: { inputTokens: 2_000_000, outputTokens: 1_000_000 }, seq: 3 }))
  let payload = summary()
  assert.equal(payload.total.requests, 1)
  assert.equal(payload.total.cost, 2 * inputRate + outputRate)
  assert.equal(payload.last.peak, isPeak(at, resolveConfig({})))

  emit({ id: 'session-1' }, attemptEvent({ turn: 2, step: 1, time: at, usage: { inputTokens: 1_000_000, outputTokens: 0 }, seq: 4 }))
  emit({ id: 'session-1' }, { type: 'llm/retry-started', seq: 5, time: at, data: { turn: 2, step: 1, retry: 1, retryId: 'r1' } })
  emit({ id: 'session-1' }, messageEvent({ turn: 2, step: 1, time: at, usage: { inputTokens: 2_000_000, outputTokens: 1_000_000 }, seq: 6 }))
  payload = summary()
  assert.equal(payload.total.requests, 3)
  assert.equal(payload.total.cost, 5 * inputRate + 2 * outputRate)

  // The same events also fill the per-Session aggregates.
  const sessionPayload = summary('?session=session-1')
  assert.equal(sessionPayload.session.tracked, true)
  assert.equal(sessionPayload.session.requests, 3)
  assert.equal(sessionPayload.session.cost, payload.total.cost)
  assert.equal(
    sessionPayload.session.cost,
    Number((sessionPayload.session.cacheHitCost + sessionPayload.session.cacheMissCost + sessionPayload.session.outputCost).toFixed(2)),
    'the four cost readings add up',
  )
  const other = summary('?session=session-2')
  assert.equal(other.session.tracked, false)
  assert.equal(other.session.cost, 0)
})

await test('turn boundaries feed the longest-task KPI', async () => {
  await useFreshProfile()
  const at = Date.now() - 120_000
  const { emit, summary, stats } = await mount({}, { backfill: false })
  emit({ id: 'session-turn' }, turnEvent('turn/start', { turn: 1, time: at, seq: 1 }))
  emit({ id: 'session-turn' }, turnEvent('turn/end', { turn: 1, time: at + 125_000, seq: 2 }))
  assert.equal(summary('?session=session-turn').session.longestTurnMs, 125_000)
  assert.equal(stats().kpis.longestTurnMs, 125_000)
  // A shorter later turn does not lower the maximum.
  emit({ id: 'session-turn' }, turnEvent('turn/start', { turn: 2, time: at + 130_000, seq: 3 }))
  emit({ id: 'session-turn' }, turnEvent('turn/end', { turn: 2, time: at + 140_000, seq: 4 }))
  assert.equal(stats().kpis.longestTurnMs, 125_000)
})

await test('stats route serves the page payload', async () => {
  await useFreshProfile()
  const at = Date.now() - 60_000
  const rate = flashInputRate(at)
  const { emit, stats } = await mount({}, { backfill: false })
  emit({ id: 'session-stats' }, requestHeaderEvent({ time: at }))
  emit({ id: 'session-stats' }, messageEvent({ turn: 1, step: 1, time: at, usage: { inputTokens: 2_000_000, outputTokens: 0 } }))
  const payload = stats()
  assert.equal(payload.ok, true)
  assert.equal(payload.kpis.totalTokens, 2_000_000)
  assert.equal(payload.kpis.totalCost, 2 * rate)
  assert.equal(payload.days.length, 371)
  assert.equal(payload.days[payload.days.length - 1].tokens, 2_000_000)
  assert.equal(payload.models.length, 1)
  assert.equal(payload.models[0].model, 'deepseek-flash')
})

await test('rejects bad methods and invalid session ids', async () => {
  await useFreshProfile()
  const { summaryRoute, statsRoute } = await mount({}, { backfill: false })
  assert.equal(callRoute(summaryRoute, { method: 'POST' }).status, 405)
  assert.equal(callRoute(statsRoute, { method: 'POST' }).status, 405)
  assert.equal(callRoute(summaryRoute, { url: '/dsh-usage-meter/summary?session=bad%2Fid' }).status, 400)
})

await test('persists the aggregate atomically with costs truncated to cents', async () => {
  const dir = await useFreshProfile()
  const at = Date.now() - 60_000
  const expected = truncateCost((flashInputRate(at) * 1_234_567) / 1_000_000)
  const { emit, summary } = await mount({}, { backfill: false, flushMs: 250 })
  emit({ id: 'persist-session' }, requestHeaderEvent({ time: at }))
  emit({ id: 'persist-session' }, messageEvent({ turn: 1, step: 1, time: at, usage: { inputTokens: 1_234_567, outputTokens: 0 } }))
  await sleep(800)
  const raw = await readFile(join(dir, 'plugin-data', 'dsh-usage-meter', 'usage.json'), 'utf8')
  const saved = JSON.parse(raw)
  assert.equal(saved.total.cost, expected)
  assert.equal(String(saved.total.cost).split('.')[1]?.length <= 2 || Number.isInteger(saved.total.cost), true, 'stored cost keeps at most two decimals')
  assert.equal(saved.total.requests, 1)
  assert.equal(saved.days[localDateKey(at)].cost, expected)
  assert.equal(saved.sessions['persist-session'].cost, expected)
  assert.equal(summary().total.cost, expected, 'the live payload is truncated the same way')
})

await test('a pricing change rebuilds the retained history from session logs', async () => {
  const dir = await useFreshProfile()
  const at = Date.now() - 60_000
  const rate = flashInputRate(at)
  const todayKey = localDateKey(at)
  const todayStart = startOfLocalDay(at)
  const totals = (fields) => ({ requests: 0, peakRequests: 0, offRequests: 0, cost: 0, peakCost: 0, offCost: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, ...fields })
  // A persisted state produced by a different price book: its totals are bogus.
  const seeded = {
    version: 1,
    trackingSince: at - 3_600_000,
    updatedAt: at,
    revision: 9,
    pricingSignature: '{"old":"price-book"}',
    total: totals({ requests: 99, cost: 999 }),
    days: { [todayKey]: totals({ requests: 99, cost: 999 }) },
    models: {},
    sessions: {},
    slots: {},
    last: null,
    backfill: { state: 'done', version: 3, at },
    sessionReconcile: { state: 'done', version: 2, at },
  }
  const pluginData = join(dir, 'plugin-data', 'dsh-usage-meter')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(pluginData, { recursive: true })
  await writeFile(join(pluginData, 'usage.json'), JSON.stringify(seeded), 'utf8')

  const services = {
    sessionQuery: {
      async listSessions() {
        return [{ header: { id: 'reprice-session', createdAt: todayStart + 1000 }, live: false, persisted: true }]
      },
      async readSession() {
        return {
          session: { id: 'reprice-session' },
          inheritedEventCount: 0,
          events: [
            { type: 'request/header', seq: 0, time: at - 1000, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } }, reason: 'initial' } },
            { type: 'assistant/message', seq: 1, time: at, data: { turn: 1, step: 1, message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } }, usage: { inputTokens: 1_000_000, outputTokens: 0 }, stream: [] } },
          ],
        }
      },
    },
  }
  const { summary } = await mount(services, { flushMs: 250 })
  const payload = await waitFor(() => {
    const reading = summary()
    return reading?.ok === true && reading.total.requests === 1 ? reading : undefined
  }, 'rebuilt history')
  assert.equal(payload.total.cost, rate, 'bogus persisted cost is replaced by a log replay')
  await sleep(800)
  const saved = JSON.parse(await readFile(join(pluginData, 'usage.json'), 'utf8'))
  assert.equal(saved.pricingSignature, pricingSignature(resolveConfig({})))
  assert.equal(saved.total.cost, rate)
})

// ---------------------------------------------------------------------------
// Auxiliary model calls (auto-review and other purposeful callers)
// ---------------------------------------------------------------------------

await test('bills purposeful llm/stream calls without double counting the agent loop', async () => {
  const dir = await useFreshProfile()
  const at = Date.now() - 60_000
  const rate = flashInputRate(at)
  const { emit, callLlmStream, summary, stats } = await mount({}, { backfill: false, flushMs: 250 })
  emit({ id: 'aux-session' }, requestHeaderEvent({ time: at }))
  emit({ id: 'aux-session' }, messageEvent({ turn: 1, step: 1, time: at, usage: { inputTokens: 1_000_000, outputTokens: 0 } }))
  await sleep(50)
  assert.equal(summary().total.requests, 1)

  // An agent-loop-shaped call has no purpose: already billed by its message.
  const passthrough = await callLlmStream(
    { provider: 'deepseek-official', model: 'deepseek-flash', sessionId: 'aux-session' },
    [{ type: 'usage', usage: { inputTokens: 500_000, outputTokens: 0 } }, { type: 'finish' }],
  )
  assert.equal(passthrough.length, 2)
  assert.equal(summary().total.requests, 1, 'agent-loop calls are not counted twice')

  // An auxiliary call (auto-review) carries a purpose and must be billed.
  const auxRate = flashInputRate(Date.now())
  const auxUsage = { inputTokens: 250_000, outputTokens: 10_000, cacheReadTokens: 100_000 }
  await callLlmStream(
    { provider: 'deepseek-official', model: 'deepseek-flash', sessionId: 'aux-session', purpose: 'auto-review' },
    [{ type: 'usage', usage: auxUsage }, { type: 'finish' }],
  )
  const expectedAuxCost = (auxUsage.inputTokens * auxRate + auxUsage.cacheReadTokens * (auxRate * 0.02) + auxUsage.outputTokens * (auxRate * 4)) / 1_000_000
  const payload = summary()
  const sessionPayload = summary('?session=aux-session')
  assert.equal(payload.total.requests, 2, 'the auxiliary call is counted once')
  assert.equal(sessionPayload.session.requests, 2)
  assert.equal(Math.abs(sessionPayload.session.cost - (rate + expectedAuxCost)) <= 0.02, true, 'the session includes the auxiliary cost')
  const statsPayload = stats()
  assert.equal(statsPayload.auxCalls.requests, 1)
  assert.equal(Math.abs(statsPayload.auxCalls.cost - expectedAuxCost) <= 0.02, true)
  assert.equal(statsPayload.auxCalls.byPurpose['auto-review'] !== undefined, true)
  await sleep(700)
  const saved = JSON.parse(await readFile(join(dir, 'plugin-data', 'dsh-usage-meter', 'usage.json'), 'utf8'))
  assert.equal(saved.aux.requests, 1)
})

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

await test('fresh backfill counts all logged history once and skips inherited events', async () => {
  await useFreshProfile()
  const at = Date.now() - 60_000
  const todayStart = startOfLocalDay(Date.now())
  const inheritedUsage = { inputTokens: 5_000_000, outputTokens: 0 }
  const ownUsage = { inputTokens: 3_000_000, outputTokens: 0 }
  const rate = flashInputRate(at)
  const services = {
    sessionQuery: {
      async listSessions() {
        return [{ header: { id: 'backfill-session', createdAt: todayStart + 1000 }, live: false, persisted: true }]
      },
      async readSession() {
        return {
          session: { id: 'backfill-session' },
          inheritedEventCount: 2,
          events: [
            { type: 'assistant/message', seq: 0, time: at - 10_000, data: { turn: 0, step: 1, message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } }, usage: inheritedUsage, stream: [] } },
            { type: 'assistant/message', seq: 1, time: at - 9_000, data: { turn: 0, step: 2, message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } }, usage: inheritedUsage, stream: [] } },
            { type: 'request/header', seq: 2, time: at - 8_000, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } }, reason: 'initial' } },
            { type: 'assistant/message', seq: 3, time: at, data: { turn: 1, step: 1, message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } }, usage: ownUsage, stream: [] } },
          ],
        }
      },
    },
  }
  const { summary, stats } = await mount(services, { backfill: true })
  const payload = await waitFor(() => {
    const reading = summary()
    return reading?.ok === true && reading.backfill?.state === 'done' ? reading : undefined
  }, 'backfill done')
  assert.equal(payload.backfill.sessions, 1)
  assert.equal(payload.total.requests, 1)
  assert.equal(payload.total.cost, 3 * rate)
  assert.equal(payload.today.cost, 3 * rate)
  assert.equal(summary('?session=backfill-session').session.cost, 3 * rate)
  assert.equal(stats().kpis.totalTokens, 3_000_000)
})

await test('an upgraded install extends history without touching counted days', async () => {
  const dir = await useFreshProfile()
  const at = Date.now() - 60_000
  const todayKey = localDateKey(at)
  const todayStart = startOfLocalDay(at)
  const oldAt = at - 30 * DAY_MS
  const oldKey = localDateKey(oldAt)
  const rate = flashInputRate(at)
  const oldRate = flashInputRate(oldAt)

  // A v1 state: today's usage already counted, no per-session map, backfill v1 done.
  const totals = (fields) => ({ requests: 0, peakRequests: 0, offRequests: 0, cost: 0, peakCost: 0, offCost: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, ...fields })
  const seeded = {
    version: 1,
    trackingSince: at,
    updatedAt: at,
    revision: 10,
    pricingSignature: pricingSignature(resolveConfig({})),
    total: totals({ requests: 1, offRequests: 1, cost: rate, offCost: rate, inputTokens: 1_000_000 }),
    days: { [todayKey]: totals({ requests: 1, offRequests: 1, cost: rate, offCost: rate, inputTokens: 1_000_000 }) },
    models: { 'deepseek-flash': totals({ requests: 1, cost: rate, inputTokens: 1_000_000 }) },
    slots: {},
    last: null,
    backfill: { state: 'done', at, sessions: 1 },
  }
  const pluginData = join(dir, 'plugin-data', 'dsh-usage-meter')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(pluginData, { recursive: true })
  await writeFile(join(pluginData, 'usage.json'), JSON.stringify(seeded), 'utf8')

  // A pre-install hour of today, so the v1 -> current upgrade also fills the
  // window between local midnight and the old install time.
  const todayAt = at - 60_000
  const todayEventCounted = todayAt >= todayStart
  const services = {
    sessionQuery: {
      async listSessions() {
        return [
          { header: { id: 'old-session', createdAt: todayStart - 30 * DAY_MS }, live: false, persisted: true },
          { header: { id: 'today-session', createdAt: todayStart + 1000 }, live: false, persisted: true },
        ]
      },
      async readSession(sessionId) {
        if (sessionId === 'today-session') {
          return {
            session: { id: 'today-session' },
            inheritedEventCount: 0,
            events: [
              { type: 'assistant/message', seq: 0, time: at - 90_000, data: { turn: 1, step: 1, message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } }, usage: { inputTokens: 1_000_000, outputTokens: 0 }, stream: [] } },
            ],
          }
        }
        return {
          session: { id: 'old-session' },
          inheritedEventCount: 0,
          events: [
            { type: 'request/header', seq: 0, time: oldAt - 1000, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } }, reason: 'initial' } },
            { type: 'assistant/message', seq: 1, time: oldAt, data: { turn: 1, step: 1, message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } }, usage: { inputTokens: 2_000_000, outputTokens: 0 }, stream: [] } },
            ...(todayEventCounted ? [{ type: 'assistant/message', seq: 2, time: todayAt, data: { turn: 2, step: 1, message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } }, usage: { inputTokens: 500_000, outputTokens: 0 }, stream: [] } }] : []),
          ],
        }
      },
    },
  }
  const { summary } = await mount(services, { backfill: true, flushMs: 250 })
  const payload = await waitFor(() => {
    const reading = summary()
    return reading?.ok === true && reading.backfill?.state === 'done' && reading.backfill?.version === 3 ? reading : undefined
  }, 'extended backfill done')
  assert.equal(payload.backfill.sessions, 1)
  const todayExtra = todayEventCounted ? 0.5 * rate : 0
  assert.equal(payload.total.requests, todayEventCounted ? 3 : 2)
  assert.equal(payload.today.cost, rate + todayExtra, 'today gains only its uncounted pre-install events')
  assert.equal(payload.total.cost, rate + todayExtra + 2 * oldRate)
  // Per-Session totals are rebuilt from the logs, including today's earlier usage.
  const todaySession = await waitFor(() => {
    const reading = summary('?session=today-session')
    return reading?.session?.tracked === true ? reading.session : undefined
  }, 'reconciled today session')
  assert.equal(todaySession.requests, 1)
  assert.equal(todaySession.cost, rate)
  const oldSession = summary('?session=old-session').session
  assert.equal(oldSession.requests, todayEventCounted ? 2 : 1)
  assert.equal(oldSession.cost, 2 * oldRate + todayExtra)
  await sleep(800)
  const stateOnDisk = JSON.parse(await readFile(join(pluginData, 'usage.json'), 'utf8'))
  const rebuilt = sanitizeState(stateOnDisk)
  assert.equal(rebuilt.days[oldKey].cost, 2 * oldRate)
  assert.equal(rebuilt.days[todayKey].cost, rate + todayExtra)
  assert.equal(rebuilt.sessions['old-session'].cost, 2 * oldRate + todayExtra)
  assert.equal(rebuilt.sessions['today-session'].cost, rate)
  assert.equal(rebuilt.backfill.version, 3)
  assert.equal(rebuilt.sessionReconcile.state, 'done')
  assert.equal(rebuilt.sessionReconcile.version, 2)
})

// ---------------------------------------------------------------------------

await rm(profileDir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1

