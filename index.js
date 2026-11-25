/**
 * DSH usage meter — Host half.
 *
 * Folds provider-reported token usage from every Session into local cost
 * totals priced with DeepSeek's peak / off-peak rates, keeps global daily and
 * per-Session aggregates, persists them under the profile's `plugin-data`
 * directory, and serves the read-only JSON the browser half reads:
 *
 * - `GET /dsh-usage-meter/summary[?session=<id>]` — live status-bar reading
 *   (current Session totals when `session` is given) plus current period.
 * - `GET /dsh-usage-meter/stats` — the statistics page payload: KPIs, a
 *   371-day zero-filled daily series, per-model totals and backfill state.
 *
 * Pricing model (DeepSeek, per 1M tokens, CNY):
 * - peak hours: Beijing weekdays 09:00–12:00 and 14:00–18:00, excluding
 *   configured statutory holidays;
 * - off-peak: every other instant and exactly half the peak rate;
 * - cached input is billed at its own cache-hit rate, uncached input at the
 *   cache-miss rate, and cache writes at the cache-miss rate unless a model
 *   declares its own `cacheWrite` price.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Stable Cordis plugin name. */
export const name = 'dsh-usage-meter'

/** Status-bar route. */
export const ROUTE_PATH = '/dsh-usage-meter/summary'
/** Statistics-page route. */
export const STATS_PATH = '/dsh-usage-meter/stats'
/** Per-Turn cost map for the Chat footer; computed lazily from the session log. */
export const TURNS_PATH = '/dsh-usage-meter/turns'
/** Lazily folded model/effort mix of one chat, for the ranking's expanded row. */
export const CHAT_META_PATH = '/dsh-usage-meter/chat-meta'

const PLUGIN_ID = 'dsh-usage-meter'
const STATE_FILE = 'usage.json'
const STATE_VERSION = 1
const DAY_MS = 86_400_000
/** China Standard Time is UTC+8 all year, so the peak window needs no tz database. */
const BEIJING_OFFSET_MS = 8 * 3_600_000
/**
 * DeepSeek peak windows in Beijing time, in minutes from midnight.
 * `peakDays` defaults to `weekdays` (the documented Monday–Friday calendar);
 * set `peakDays: daily` only if the account bills weekends at the peak rate.
 */
const DEFAULT_PEAK_WINDOWS = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]
const TOKEN_FIELDS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']
const COUNTER_FIELDS = ['requests', 'peakRequests', 'offRequests']
const COST_FIELDS = ['cost', 'peakCost', 'offCost']
/** Billing split the status bar reads: cached input, uncached input, output. */
const COST_PART_FIELDS = ['cacheHitCost', 'cacheMissCost', 'outputCost']
const BUCKET_FIELDS = [...COUNTER_FIELDS, ...COST_FIELDS, ...COST_PART_FIELDS, ...TOKEN_FIELDS]
const MODEL_LIMIT = 60
const SLOT_TTL_MS = 2 * 3_600_000
const SLOT_LIMIT = 300
const SESSION_LIMIT = 500
const HISTORY_DAYS = 371
/** Bumped when the backfill semantics change, so an old partial pass can extend itself. */
const BACKFILL_VERSION = 3
/** Bumped when the session reconciliation passes new per-Session fields. */
const SESSION_RECONCILE_VERSION = 2
/** One-time pass that fills Session titles and parent facts for the ranking. */
const TITLES_VERSION = 2
/** One-time pass that fills the stored model/effort mix of existing chats. */
const CHAT_META_VERSION = 1
const BACKFILL_SESSION_LIMIT = 400
const BACKFILL_DEADLINE_MS = 60_000
const BUFFER_LIMIT = 5_000

/** DeepSeek official list prices, CNY per 1M tokens (docs updated 2026-09-10). */
const DEFAULT_MODELS = {
  'deepseek-flash': {
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    off: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  },
  'deepseek-v4-pro': {
    peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    off: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
  },
}

/** Model ids that are served by a priced model under a retired name. */
const DEFAULT_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4-pro-0813': 'deepseek-v4-pro',
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonNegative(value) {
  const number = finiteNumber(value)
  return number !== undefined && number >= 0 ? number : undefined
}

function integerOf(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'unknown error'
}

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function clockLabel(minutes) {
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`
}

/** Safe arithmetic: clamp float dust after subtracting an exact contribution. */
function cleanNumber(value) {
  return Number.isFinite(value) && value > 0 ? (value < 1e-12 ? 0 : value) : 0
}


/** Keep two decimal places of a CNY amount, rounding half away from zero. */
export function roundCost(value) {
  const number = finiteNumber(value)
  if (number === undefined || number <= 0) return 0
  // `toFixed(6)` first so 1.005 rounds up instead of down from float dust.
  return Math.round(Number((number * 100).toFixed(6))) / 100
}

// ---------------------------------------------------------------------------
// Time: Beijing billing period and local calendar days
// ---------------------------------------------------------------------------

/** Calendar facts at one instant, read in Beijing time. */
function beijingParts(ms) {
  const date = new Date(ms + BEIJING_OFFSET_MS)
  return {
    weekday: date.getUTCDay(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    dateKey: `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`,
  }
}

/** Whether DeepSeek bills `ms` at the peak (list) price. */
function isPeak(ms, config) {
  const parts = beijingParts(ms)
  if (config.holidaySet.has(parts.dateKey)) return false
  if (config.peakDays === 'weekdays' && (parts.weekday === 0 || parts.weekday === 6)) return false
  const minutes = parts.hour * 60 + parts.minute
  return config.peakWindows.some(([start, end]) => minutes >= start && minutes < end)
}

/** First instant after `now` whose peak/off-peak classification differs. */
function nextPeriodChange(now, config) {
  const current = isPeak(now, config)
  const minute = Math.floor(now / 60_000) * 60_000
  const limit = now + 8 * DAY_MS
  for (let at = minute + 60_000; at < limit; at += 60_000) {
    if (isPeak(at, config) !== current) return at
  }
  return null
}

/** `YYYY-MM-DD` of the host's local calendar day containing `ms`. */
function localDateKey(ms) {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** Local midnight at or before `ms`. */
function startOfLocalDay(ms) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Local midnight of the calendar day named by `YYYY-MM-DD`. */
function localDayMs(dateKey) {
  const [year, month, day] = dateKey.split('-').map((part) => Number(part))
  return new Date(year, month - 1, day).getTime()
}

/** Key of the local calendar day after `dateKey`. */
function nextDateKey(dateKey) {
  const date = new Date(localDayMs(dateKey))
  date.setDate(date.getDate() + 1)
  return localDateKey(date.getTime())
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function normalizeRates(raw) {
  if (!isRecord(raw)) return undefined
  const cacheMiss = nonNegative(raw.cacheMiss)
  const output = nonNegative(raw.output)
  if (cacheMiss === undefined || output === undefined) return undefined
  return {
    cacheHit: nonNegative(raw.cacheHit) ?? 0,
    cacheMiss,
    cacheWrite: nonNegative(raw.cacheWrite) ?? cacheMiss,
    output,
  }
}

function scaleRates(rates, factor) {
  return {
    cacheHit: rates.cacheHit * factor,
    cacheMiss: rates.cacheMiss * factor,
    cacheWrite: rates.cacheWrite * factor,
    output: rates.output * factor,
  }
}

/**
 * Normalize one configured model into an explicit peak/off pair. Supplying
 * only one side derives the other at DeepSeek's 2:1 list ratio; a flat
 * `{ cacheMiss, output, ... }` entry is read as the peak rate.
 */
function normalizePricePair(raw) {
  if (!isRecord(raw)) return undefined
  const peak = normalizeRates(raw.peak)
  const off = normalizeRates(raw.off)
  if (peak !== undefined && off !== undefined) return { peak, off }
  if (peak !== undefined) return { peak, off: scaleRates(peak, 0.5) }
  if (off !== undefined) return { peak: scaleRates(off, 2), off }
  const flat = normalizeRates(raw)
  return flat === undefined ? undefined : { peak: flat, off: scaleRates(flat, 0.5) }
}

function clampInteger(value, fallback, min, max) {
  const number = finiteNumber(value)
  if (number === undefined) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** Parse `["09:00-12:00", "14:00-18:00"]` style windows into minute pairs. */
function parsePeakWindows(raw) {
  if (!Array.isArray(raw)) return DEFAULT_PEAK_WINDOWS
  const windows = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(entry.trim())
    if (match === null) continue
    const start = Number(match[1]) * 60 + Number(match[2])
    const end = Number(match[3]) * 60 + Number(match[4])
    if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= 1_440 && end > start) windows.push([start, end])
  }
  return windows.length > 0 ? windows : DEFAULT_PEAK_WINDOWS
}

/** Stable digest of every setting that changes how a historical event is priced. */
function pricingSignature(config) {
  const stable = {
    models: Object.fromEntries(Object.entries(config.models).sort(([left], [right]) => left.localeCompare(right))),
    aliases: Object.fromEntries(Object.entries(config.aliases).sort(([left], [right]) => left.localeCompare(right))),
    fallbackModel: config.fallbackModel,
    pricingMode: config.pricingMode,
    peakDays: config.peakDays,
    peakWindows: config.peakWindows,
    holidays: [...config.holidays].sort(),
  }
  return JSON.stringify(stable)
}

/** Merge the row config over the shipped defaults. */
export function resolveConfig(raw) {
  const input = isRecord(raw) ? raw : {}
  const models = {}
  for (const [id, price] of Object.entries(DEFAULT_MODELS)) models[id] = normalizePricePair(price)
  if (isRecord(input.models)) {
    for (const [id, price] of Object.entries(input.models)) {
      if (typeof id !== 'string' || id.trim() === '') continue
      const normalized = normalizePricePair(price)
      if (normalized !== undefined) models[id.trim()] = normalized
    }
  }
  const aliases = { ...DEFAULT_ALIASES }
  if (isRecord(input.aliases)) {
    for (const [alias, target] of Object.entries(input.aliases)) {
      if (typeof alias === 'string' && typeof target === 'string' && alias.trim() !== '' && models[target.trim()] !== undefined) {
        aliases[alias.trim()] = target.trim()
      }
    }
  }
  const requestedFallback = typeof input.fallbackModel === 'string' ? input.fallbackModel.trim() : ''
  const fallbackModel = models[requestedFallback] !== undefined ? requestedFallback : 'deepseek-flash'
  const holidays = Array.isArray(input.holidays)
    ? input.holidays.filter((entry) => typeof entry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry))
    : []
  const peakDaysInput = typeof input.peakDays === 'string' ? input.peakDays.trim().toLowerCase() : ''
  const pricingModeInput = typeof input.pricingMode === 'string' ? input.pricingMode.trim().toLowerCase() : ''
  return {
    models,
    aliases,
    fallbackModel,
    holidays,
    holidaySet: new Set(holidays),
    pricingMode: pricingModeInput === 'flat' ? 'flat' : 'scheduled',
    peakDays: peakDaysInput === 'daily' ? 'daily' : 'weekdays',
    peakWindows: parsePeakWindows(input.peakWindows),
    retainDays: clampInteger(input.retainDays, 400, HISTORY_DAYS, 3_660),
    flushMs: clampInteger(input.flushMs, 2_000, 250, 60_000),
    pollMs: clampInteger(input.pollMs, 5_000, 1_000, 60_000),
    backfill: input.backfill !== false,
  }
}

/** Resolve the price of one model id, following aliases and the fallback. */
export function resolvePrice(config, model) {
  const id = typeof model === 'string' ? model.trim() : ''
  if (id !== '' && config.models[id] !== undefined) return { priceId: id, price: config.models[id], estimated: false }
  const alias = id !== '' ? config.aliases[id] : undefined
  if (alias !== undefined && config.models[alias] !== undefined) {
    return { priceId: alias, price: config.models[alias], estimated: false }
  }
  const fallback = config.models[config.fallbackModel]
  if (fallback !== undefined) return { priceId: config.fallbackModel, price: fallback, estimated: true }
  return undefined
}

// ---------------------------------------------------------------------------
// Usage and cost
// ---------------------------------------------------------------------------

/** Read a provider `TokenUsage` into the four disjoint billing buckets. */
function readUsage(raw) {
  return {
    inputTokens: nonNegative(raw?.inputTokens) ?? 0,
    outputTokens: nonNegative(raw?.outputTokens) ?? 0,
    cacheReadTokens: nonNegative(raw?.cacheReadTokens) ?? 0,
    cacheWriteTokens: nonNegative(raw?.cacheWriteTokens) ?? 0,
  }
}

/** Spot price in CNY for one usage sample at one instant. */
export function costOf(usage, rates) {
  return (
    usage.inputTokens * rates.cacheMiss +
    usage.cacheReadTokens * rates.cacheHit +
    usage.cacheWriteTokens * rates.cacheWrite +
    usage.outputTokens * rates.output
  ) / 1_000_000
}

/** Build one immutable contribution from a settlement event. */
function makeContribution({ usage, provider, model, time, config, effort }) {
  const resolved = resolvePrice(config, model)
  // `scheduled` (default) follows the published peak windows; `flat` charges
  // the 空闲 price at every hour for accounts that never see the peak price.
  const peak = config.pricingMode === 'scheduled' && isPeak(time, config)
  const rates = resolved === undefined ? undefined : peak ? resolved.price.peak : resolved.price.off
  const costParts = rates === undefined ? { cacheHit: 0, cacheMiss: 0, output: 0 } : {
    cacheHit: (usage.cacheReadTokens * rates.cacheHit) / 1_000_000,
    cacheMiss: (usage.inputTokens * rates.cacheMiss + usage.cacheWriteTokens * rates.cacheWrite) / 1_000_000,
    output: (usage.outputTokens * rates.output) / 1_000_000,
  }
  return {
    time,
    provider: typeof provider === 'string' ? provider : '',
    model: typeof model === 'string' ? model : '',
    effort: typeof effort === 'string' ? effort : '',
    priceId: resolved?.priceId ?? '',
    estimated: resolved?.estimated ?? true,
    peak,
    cost: costParts.cacheHit + costParts.cacheMiss + costParts.output,
    costParts,
    usage,
  }
}

/** Usage reported by an assistant settlement, preferring the explicit field. */
function usageOfEvent(event) {
  const data = event?.data
  if (!isRecord(data)) return undefined
  if (event.type === 'assistant/message' && isRecord(data.usage)) return data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  const stream = data.stream
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (isRecord(record) && record.type === 'chunk' && isRecord(record.chunk) && record.chunk.type === 'usage' && isRecord(record.chunk.usage)) {
      return record.chunk.usage
    }
  }
  return undefined
}

/** Provider/model route named by a request header or context event. */
function routeOfEvent(event) {
  const data = event?.data
  if (!isRecord(data)) return undefined
  if (event.type === 'request/header' && isRecord(data.header) && isRecord(data.header.config)) {
    const { provider, model } = data.header.config
    return { provider: typeof provider === 'string' ? provider : '', model: typeof model === 'string' ? model : '' }
  }
  if (event.type === 'request/context') {
    const { provider, model } = data
    return { provider: typeof provider === 'string' ? provider : '', model: typeof model === 'string' ? model : '' }
  }
  return undefined
}

/** Provider/model named by a settled assistant message. */
function sourceOfMessage(event) {
  const source = event?.data?.message?.source
  if (!isRecord(source)) return { provider: '', model: '' }
  return {
    provider: typeof source.provider === 'string' ? source.provider : '',
    model: typeof source.model === 'string' ? source.model : '',
  }
}

// ---------------------------------------------------------------------------
// Aggregate state
// ---------------------------------------------------------------------------

function emptyTotals() {
  const totals = {}
  for (const field of BUCKET_FIELDS) totals[field] = 0
  return totals
}

function emptySession() {
  return {
    ...emptyTotals(),
    firstTime: 0,
    lastTime: 0,
    longestTurnMs: 0,
  }
}

export function createState() {
  return {
    version: STATE_VERSION,
    trackingSince: Date.now(),
    updatedAt: 0,
    revision: 0,
    pricingSignature: '',
    total: emptyTotals(),
    days: {},
    models: {},
    sessions: {},
    /** Latest durable `session/title` per session, for the chat ranking. */
    titles: {},
    /** Per-chat token mix by model and reasoning effort, updated live. */
    chatMeta: {},
    chatMetaBackfill: { state: 'pending' },
    /** Session header facts used to fold subagent sessions into their parent chat. */
    meta: {},
    titlesBackfill: { state: 'pending' },
    slots: {},
    last: null,
    aux: { requests: 0, cost: 0, tokens: 0, byPurpose: {}, byPurposeRequests: {}, byPurposeTokens: {}, log: [] },
    backfill: { state: 'pending' },
    sessionReconcile: { state: 'pending' },
  }
}

function cleanBucket(bucket) {
  for (const field of BUCKET_FIELDS) bucket[field] = cleanNumber(bucket[field])
  return bucket
}

function addToBucket(bucket, contribution, sign) {
  const { usage, cost, peak } = contribution
  bucket.requests += sign
  bucket.cost += sign * cost
  if (peak) {
    bucket.peakRequests += sign
    bucket.peakCost += sign * cost
  } else {
    bucket.offRequests += sign
    bucket.offCost += sign * cost
  }
  bucket.inputTokens += sign * usage.inputTokens
  bucket.cacheReadTokens += sign * usage.cacheReadTokens
  bucket.cacheWriteTokens += sign * usage.cacheWriteTokens
  bucket.outputTokens += sign * usage.outputTokens
  const parts = contribution.costParts
  bucket.cacheHitCost += sign * (finiteNumber(parts?.cacheHit) ?? 0)
  bucket.cacheMissCost += sign * (finiteNumber(parts?.cacheMiss) ?? 0)
  bucket.outputCost += sign * (finiteNumber(parts?.output) ?? 0)
  cleanBucket(bucket)
}

function ensureBucket(collection, key) {
  let bucket = collection[key]
  if (bucket === undefined) {
    bucket = emptyTotals()
    collection[key] = bucket
  }
  return bucket
}

function tokensOfUsage(usage) {
  if (!isRecord(usage)) return 0
  return (finiteNumber(usage.inputTokens) ?? 0)
    + (finiteNumber(usage.outputTokens) ?? 0)
    + (finiteNumber(usage.cacheReadTokens) ?? 0)
    + (finiteNumber(usage.cacheWriteTokens) ?? 0)
}

/** Add or remove one settlement's tokens from a chat's model/effort mix. */
function bumpChatMeta(state, sessionId, model, effort, tokens, sign, time) {
  if (typeof sessionId !== 'string' || sessionId === '' || !(tokens > 0)) return
  if (!isRecord(state.chatMeta)) state.chatMeta = {}
  let entry = state.chatMeta[sessionId]
  if (!isRecord(entry)) {
    entry = { models: {}, efforts: {}, updatedAt: 0 }
    state.chatMeta[sessionId] = entry
  }
  if (!isRecord(entry.models)) entry.models = {}
  if (!isRecord(entry.efforts)) entry.efforts = {}
  const modelKey = typeof model === 'string' && model !== '' ? model.slice(0, 120) : 'unknown'
  const effortKey = typeof effort === 'string' && effort !== '' ? effort.slice(0, 40) : 'default'
  const nextModel = Math.max(0, (finiteNumber(entry.models[modelKey]) ?? 0) + sign * tokens)
  const nextEffort = Math.max(0, (finiteNumber(entry.efforts[effortKey]) ?? 0) + sign * tokens)
  if (nextModel <= 0) delete entry.models[modelKey]
  else entry.models[modelKey] = nextModel
  if (nextEffort <= 0) delete entry.efforts[effortKey]
  else entry.efforts[effortKey] = nextEffort
  if (sign > 0) entry.updatedAt = Math.max(finiteNumber(entry.updatedAt) ?? 0, time ?? Date.now())
}

/** Sorted response arrays for one stored chat mix. */
function chatMetaArrays(entry) {
  const models = Object.entries(isRecord(entry?.models) ? entry.models : {})
    .map(([model, tokens]) => ({ model, tokens: Math.max(0, Math.floor(finiteNumber(tokens) ?? 0)) }))
    .filter((item) => item.tokens > 0)
    .sort((left, right) => right.tokens - left.tokens)
  const efforts = Object.entries(isRecord(entry?.efforts) ? entry.efforts : {})
    .map(([effort, tokens]) => ({ effort, tokens: Math.max(0, Math.floor(finiteNumber(tokens) ?? 0)) }))
    .filter((item) => item.tokens > 0)
    .sort((left, right) => right.tokens - left.tokens)
  return { models, efforts }
}

function storeChatMetaFold(state, sessionId, folded) {
  if (!isRecord(state.chatMeta)) state.chatMeta = {}
  const models = {}
  for (const item of Array.isArray(folded?.models) ? folded.models : []) {
    if (isRecord(item) && typeof item.model === 'string' && item.tokens > 0) models[item.model] = item.tokens
  }
  const efforts = {}
  for (const item of Array.isArray(folded?.efforts) ? folded.efforts : []) {
    if (isRecord(item) && typeof item.effort === 'string' && item.tokens > 0) efforts[item.effort] = item.tokens
  }
  state.chatMeta[sessionId] = { models, efforts, updatedAt: Date.now() }
}

function ensureSession(state, sessionId) {
  let session = state.sessions[sessionId]
  if (session === undefined) {
    session = emptySession()
    state.sessions[sessionId] = session
  }
  return session
}

function cloneTotals(value) {
  const totals = {}
  for (const field of BUCKET_FIELDS) totals[field] = finiteNumber(value?.[field]) ?? 0
  return totals
}

function sanitizeTotals(raw) {
  const totals = cleanBucket(cloneTotals(isRecord(raw) ? raw : {}))
  // Repair small drift between a bucket's total and its cost components (for
  // example truncation residues inherited from an older state file).
  const parts = totals.cacheHitCost + totals.cacheMissCost + totals.outputCost
  if (parts > 0 && Math.abs(parts - totals.cost) <= 0.05) totals.cost = parts
  return totals
}

function sanitizeSlot(raw) {
  if (!isRecord(raw)) return undefined
  const time = finiteNumber(raw.time)
  const cost = finiteNumber(raw.cost)
  const usage = readUsage(raw.usage)
  if (time === undefined || cost === undefined) return undefined
  const costParts = {
    cacheHit: nonNegative(raw.costParts?.cacheHit) ?? 0,
    cacheMiss: nonNegative(raw.costParts?.cacheMiss) ?? 0,
    output: nonNegative(raw.costParts?.output) ?? 0,
  }
  const parts = costParts.cacheHit + costParts.cacheMiss + costParts.output
  return {
    time,
    provider: typeof raw.provider === 'string' ? raw.provider : '',
    model: typeof raw.model === 'string' ? raw.model : '',
    effort: typeof raw.effort === 'string' ? raw.effort : '',
    priceId: typeof raw.priceId === 'string' ? raw.priceId : '',
    estimated: raw.estimated === true,
    peak: raw.peak === true,
    cost: parts > 0 && Math.abs(parts - cost) <= 0.05 ? parts : Math.max(0, cost),
    costParts,
    usage,
  }
}

function sanitizeSessionRecord(raw) {
  if (!isRecord(raw)) return undefined
  const session = {
    ...sanitizeTotals(raw),
    firstTime: nonNegative(raw.firstTime) ?? 0,
    lastTime: nonNegative(raw.lastTime) ?? 0,
    longestTurnMs: nonNegative(raw.longestTurnMs) ?? 0,
  }
  return session
}

/** Rebuild trusted state from a persisted document, dropping anything malformed. */
export function sanitizeState(raw) {
  const state = createState()
  if (!isRecord(raw)) return state
  const trackingSince = finiteNumber(raw.trackingSince)
  if (trackingSince !== undefined) state.trackingSince = trackingSince
  const updatedAt = finiteNumber(raw.updatedAt)
  if (updatedAt !== undefined) state.updatedAt = updatedAt
  const revision = finiteNumber(raw.revision)
  if (revision !== undefined && revision >= 0) state.revision = Math.floor(revision)
  if (typeof raw.pricingSignature === 'string') state.pricingSignature = raw.pricingSignature
  state.total = sanitizeTotals(raw.total)
  if (isRecord(raw.days)) {
    for (const [key, value] of Object.entries(raw.days)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(key)) state.days[key] = sanitizeTotals(value)
    }
  }
  if (isRecord(raw.models)) {
    for (const [key, value] of Object.entries(raw.models)) {
      if (typeof key !== 'string' || key === '' || Object.keys(state.models).length >= 120) continue
      const bucket = sanitizeTotals(value)
      if (isRecord(value) && value.estimated === true) bucket.estimated = true
      state.models[key.slice(0, 120)] = bucket
    }
  }
  if (isRecord(raw.sessions)) {
    for (const [key, value] of Object.entries(raw.sessions)) {
      if (typeof key !== 'string' || key === '' || key.length > 200 || Object.keys(state.sessions).length >= SESSION_LIMIT * 2) continue
      const session = sanitizeSessionRecord(value)
      if (session !== undefined) state.sessions[key] = session
    }
  }
  if (isRecord(raw.titles)) {
    for (const [key, value] of Object.entries(raw.titles)) {
      if (typeof key !== 'string' || key === '' || key.length > 200) continue
      if (typeof value !== 'string') continue
      const title = value.trim()
      if (title === '' || Object.keys(state.titles).length >= SESSION_LIMIT * 2) continue
      state.titles[key] = title.slice(0, 200)
    }
  }
  if (isRecord(raw.meta)) {
    for (const [key, value] of Object.entries(raw.meta)) {
      if (typeof key !== 'string' || key === '' || key.length > 200) continue
      if (!isRecord(value)) continue
      const entry = {}
      if (value.origin === 'subagent') entry.origin = 'subagent'
      if (typeof value.parent === 'string' && value.parent !== '' && value.parent.length <= 200) {
        entry.parent = value.parent
      }
      if (Object.keys(entry).length > 0) state.meta[key] = entry
      if (Object.keys(state.meta).length >= SESSION_LIMIT * 2) break
    }
  }
  if (isRecord(raw.chatMeta)) {
    for (const [key, value] of Object.entries(raw.chatMeta)) {
      if (typeof key !== 'string' || key === '' || key.length > 200) continue
      if (!isRecord(value)) continue
      const models = {}
      for (const [model, tokens] of Object.entries(isRecord(value.models) ? value.models : {})) {
        if (typeof model !== 'string' || model === '' || model.length > 120) continue
        const count = finiteNumber(tokens)
        if (count !== undefined && count > 0) models[model] = Math.floor(count)
      }
      const efforts = {}
      for (const [effort, tokens] of Object.entries(isRecord(value.efforts) ? value.efforts : {})) {
        if (typeof effort !== 'string' || effort === '' || effort.length > 40) continue
        const count = finiteNumber(tokens)
        if (count !== undefined && count > 0) efforts[effort] = Math.floor(count)
      }
      state.chatMeta[key] = { models, efforts, updatedAt: finiteNumber(value.updatedAt) ?? 0 }
      if (Object.keys(state.chatMeta).length >= SESSION_LIMIT * 2) break
    }
  }
  if (isRecord(raw.chatMetaBackfill) && finiteNumber(raw.chatMetaBackfill.version) === CHAT_META_VERSION) {
    state.chatMetaBackfill = {
      state: raw.chatMetaBackfill.state === 'done' ? 'done' : 'partial',
      version: CHAT_META_VERSION,
      ...(finiteNumber(raw.chatMetaBackfill.at) === undefined ? {} : { at: raw.chatMetaBackfill.at }),
    }
  }
  if (isRecord(raw.titlesBackfill) && finiteNumber(raw.titlesBackfill.version) === TITLES_VERSION) {
    state.titlesBackfill = {
      state: raw.titlesBackfill.state === 'done' ? 'done' : 'partial',
      version: TITLES_VERSION,
      ...(finiteNumber(raw.titlesBackfill.at) === undefined ? {} : { at: raw.titlesBackfill.at }),
    }
  }
  if (isRecord(raw.slots)) {
    for (const [key, value] of Object.entries(raw.slots)) {
      if (typeof key !== 'string' || key.length > 200 || Object.keys(state.slots).length >= SLOT_LIMIT * 2) continue
      const slot = sanitizeSlot(value)
      if (slot !== undefined) state.slots[key] = slot
    }
  }
  if (isRecord(raw.last)) {
    const time = finiteNumber(raw.last.time)
    if (time !== undefined) {
      state.last = {
        time,
        model: typeof raw.last.model === 'string' ? raw.last.model : '',
        provider: typeof raw.last.provider === 'string' ? raw.last.provider : '',
        peak: raw.last.peak === true,
        cost: Math.max(0, finiteNumber(raw.last.cost) ?? 0),
        estimated: raw.last.estimated === true,
      }
    }
  }
  if (isRecord(raw.backfill) && typeof raw.backfill.state === 'string') {
    state.backfill = {
      state: raw.backfill.state,
      ...(finiteNumber(raw.backfill.version) === undefined ? {} : { version: raw.backfill.version }),
      ...(finiteNumber(raw.backfill.at) === undefined ? {} : { at: raw.backfill.at }),
      ...(finiteNumber(raw.backfill.sessions) === undefined ? {} : { sessions: raw.backfill.sessions }),
      ...(raw.backfill.truncated === true ? { truncated: true } : {}),
    }
  }
  if (isRecord(raw.sessionReconcile) && typeof raw.sessionReconcile.state === 'string') {
    state.sessionReconcile = {
      state: raw.sessionReconcile.state,
      ...(finiteNumber(raw.sessionReconcile.version) === undefined ? {} : { version: raw.sessionReconcile.version }),
      ...(finiteNumber(raw.sessionReconcile.at) === undefined ? {} : { at: raw.sessionReconcile.at }),
      ...(finiteNumber(raw.sessionReconcile.sessions) === undefined ? {} : { sessions: raw.sessionReconcile.sessions }),
      ...(raw.sessionReconcile.truncated === true ? { truncated: true } : {}),
    }
  }
  if (isRecord(raw.aux)) {
    const byPurpose = {}
    if (isRecord(raw.aux.byPurpose)) {
      for (const [purpose, cost] of Object.entries(raw.aux.byPurpose)) {
        if (typeof purpose !== 'string' || purpose === '' || purpose.length > 80) continue
        byPurpose[purpose] = nonNegative(cost) ?? 0
      }
    }
    const byPurposeRequests = {}
    if (isRecord(raw.aux.byPurposeRequests)) {
      for (const [purpose, count] of Object.entries(raw.aux.byPurposeRequests)) {
        if (typeof purpose !== 'string' || purpose === '' || purpose.length > 80) continue
        byPurposeRequests[purpose] = Math.max(0, Math.floor(finiteNumber(count) ?? 0))
      }
    }
    const byPurposeTokens = {}
    if (isRecord(raw.aux.byPurposeTokens)) {
      for (const [purpose, tokens] of Object.entries(raw.aux.byPurposeTokens)) {
        if (typeof purpose !== 'string' || purpose === '' || purpose.length > 80) continue
        byPurposeTokens[purpose] = Math.max(0, Math.floor(finiteNumber(tokens) ?? 0))
      }
    }
    const log = []
    if (Array.isArray(raw.aux.log)) {
      for (const entry of raw.aux.log.slice(-25)) {
        if (!isRecord(entry) || typeof entry.purpose !== 'string') continue
        log.push({
          time: finiteNumber(entry.time) ?? 0,
          purpose: entry.purpose.slice(0, 80),
          sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '',
          provider: typeof entry.provider === 'string' ? entry.provider : '',
          model: typeof entry.model === 'string' ? entry.model : '',
          inputTokens: Math.max(0, Math.floor(finiteNumber(entry.inputTokens) ?? 0)),
          cacheReadTokens: Math.max(0, Math.floor(finiteNumber(entry.cacheReadTokens) ?? 0)),
          outputTokens: Math.max(0, Math.floor(finiteNumber(entry.outputTokens) ?? 0)),
          cost: nonNegative(entry.cost) ?? 0,
        })
      }
    }
    state.aux = {
      requests: Math.max(0, Math.floor(finiteNumber(raw.aux.requests) ?? 0)),
      cost: nonNegative(raw.aux.cost) ?? 0,
      tokens: Math.max(0, Math.floor(finiteNumber(raw.aux.tokens) ?? 0)),
      byPurpose,
      byPurposeRequests,
      byPurposeTokens,
      log,
    }
  }
  return state
}

/** Copy a totals-like bucket with money fields rounded and parts-consistent. */
function roundedBucketCosts(bucket) {
  if (!isRecord(bucket)) return bucket
  const money = presentedCostFields(bucket)
  return {
    ...bucket,
    ...money,
    peakCost: roundCost(bucket.peakCost),
    offCost: roundCost(bucket.offCost),
  }
}

/**
 * Serialize the aggregate with costs kept at two decimal places: the persisted
 * file (and every served payload) carries money truncated to the cent.
 */
export function serializeState(state) {
  const slots = {}
  for (const [key, slot] of Object.entries(state.slots)) {
    if (!isRecord(slot)) continue
    const money = presentedCostFields({
      cost: slot.cost,
      cacheHitCost: slot.costParts?.cacheHit,
      cacheMissCost: slot.costParts?.cacheMiss,
      outputCost: slot.costParts?.output,
    })
    slots[key] = {
      ...slot,
      cost: money.cost,
      costParts: {
        cacheHit: money.cacheHitCost,
        cacheMiss: money.cacheMissCost,
        output: money.outputCost,
      },
    }
  }
  const mapBuckets = (collection) => Object.fromEntries(
    Object.entries(collection).map(([key, bucket]) => [key, roundedBucketCosts(bucket)]),
  )
  return JSON.stringify({
    ...state,
    total: roundedBucketCosts(state.total),
    days: mapBuckets(state.days),
    models: mapBuckets(state.models),
    sessions: mapBuckets(state.sessions),
    slots,
    last: state.last === null ? null : { ...state.last, cost: roundCost(state.last.cost) },
    aux: {
      requests: Math.max(0, Math.floor(finiteNumber(state.aux?.requests) ?? 0)),
      cost: roundCost(state.aux?.cost),
      tokens: Math.max(0, Math.floor(finiteNumber(state.aux?.tokens) ?? 0)),
      byPurpose: Object.fromEntries(
        Object.entries(isRecord(state.aux?.byPurpose) ? state.aux.byPurpose : {})
          .map(([purpose, cost]) => [purpose, roundCost(cost)]),
      ),
      byPurposeRequests: Object.fromEntries(
        Object.entries(isRecord(state.aux?.byPurposeRequests) ? state.aux.byPurposeRequests : {})
          .map(([purpose, count]) => [purpose, Math.max(0, Math.floor(finiteNumber(count) ?? 0))]),
      ),
      byPurposeTokens: Object.fromEntries(
        Object.entries(isRecord(state.aux?.byPurposeTokens) ? state.aux.byPurposeTokens : {})
          .map(([purpose, tokens]) => [purpose, Math.max(0, Math.floor(finiteNumber(tokens) ?? 0))]),
      ),
      log: Array.isArray(state.aux?.log) ? state.aux.log.slice(-25).map((entry) => ({
        ...entry,
        cost: roundCost(entry.cost),
      })) : [],
    },
  })
}

/** Drop calendar days past the retention window, dormant slots, idle sessions, low-value models. */
export function pruneState(state, config, now) {
  const cutoffKey = localDateKey(now - config.retainDays * DAY_MS)
  for (const key of Object.keys(state.days)) {
    if (key < cutoffKey) delete state.days[key]
  }
  const modelIds = Object.keys(state.models)
  if (modelIds.length > MODEL_LIMIT) {
    modelIds.sort((left, right) => (state.models[left].cost ?? 0) - (state.models[right].cost ?? 0))
    for (let index = 0; index < modelIds.length - MODEL_LIMIT; index += 1) delete state.models[modelIds[index]]
  }
  const sessionIds = Object.keys(state.sessions)
  if (sessionIds.length > SESSION_LIMIT) {
    sessionIds.sort((left, right) => (state.sessions[left].lastTime ?? 0) - (state.sessions[right].lastTime ?? 0))
    for (let index = 0; index < sessionIds.length - SESSION_LIMIT; index += 1) delete state.sessions[sessionIds[index]]
  }
  if (isRecord(state.titles)) {
    for (const key of Object.keys(state.titles)) {
      if (state.sessions[key] === undefined) delete state.titles[key]
    }
  }
  if (isRecord(state.meta)) {
    for (const key of Object.keys(state.meta)) {
      if (state.sessions[key] === undefined) delete state.meta[key]
    }
  }
  if (isRecord(state.chatMeta)) {
    for (const key of Object.keys(state.chatMeta)) {
      if (state.sessions[key] === undefined) delete state.chatMeta[key]
    }
  }
  const slotEntries = Object.entries(state.slots)
  if (slotEntries.length === 0) return
  const fresh = slotEntries.filter(([, slot]) => {
    const time = finiteNumber(slot?.time)
    return time !== undefined && now - time < SLOT_TTL_MS
  })
  if (fresh.length === slotEntries.length && fresh.length <= SLOT_LIMIT) return
  const kept = fresh.length > SLOT_LIMIT ? fresh.sort((left, right) => right[1].time - left[1].time).slice(0, SLOT_LIMIT) : fresh
  const next = {}
  for (const [key, slot] of kept) next[key] = slot
  state.slots = next
}

/** Slot key of one step's usage settlement. */
function slotKey(sessionId, turn, step, seq) {
  const coordinates = typeof turn === 'number' && typeof step === 'number' ? `${turn}:${step}` : `seq:${String(seq)}`
  return `${sessionId}|${coordinates}`
}

/**
 * Replay one Session's own log into a per-Session totals record, with the same
 * replacement / retry / route semantics as the live fold. No global side effect:
 * this is the authoritative source for the status bar's "this session" reading
 * after an upgrade that predates the per-Session map.
 *
 * @param events Session log events (any order).
 * @param inherited Events before this index are fork-inherited and skipped.
 * @param config Resolved pricing configuration.
 * @param cap Events at or after this instant belong to the live fold.
 */
export function foldSessionTotals(events, inherited, config, cap) {
  const session = emptySession()
  const slots = new Map()
  const turnStarts = new Map()
  let route = { provider: '', model: '' }
  const list = Array.isArray(events) ? [...events] : []
  list.sort((left, right) => (finiteNumber(left?.seq) ?? 0) - (finiteNumber(right?.seq) ?? 0))
  for (const event of list) {
    if (!isRecord(event) || typeof event.type !== 'string') continue
    if ((finiteNumber(event?.seq) ?? 0) < inherited) continue
    const time = finiteNumber(event.time) ?? 0
    if (cap !== undefined && time >= cap) continue
    if (event.type === 'turn/start') {
      const turn = integerOf(event.data?.turn)
      if (turn !== undefined) turnStarts.set(turn, time)
      continue
    }
    if (event.type === 'turn/end') {
      const turn = integerOf(event.data?.turn)
      if (turn !== undefined && turnStarts.has(turn)) {
        const duration = Math.max(0, time - turnStarts.get(turn))
        if (duration > session.longestTurnMs) session.longestTurnMs = duration
        turnStarts.delete(turn)
      }
      continue
    }
    if (event.type === 'request/header' || event.type === 'request/context') {
      const next = routeOfEvent(event)
      if (next !== undefined) route = next
      continue
    }
    if (event.type === 'llm/retry-started') {
      slots.delete(slotKey('', integerOf(event.data?.turn), integerOf(event.data?.step), event.seq))
      continue
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const rawUsage = usageOfEvent(event)
    if (rawUsage === undefined) continue
    const usage = readUsage(rawUsage)
    if (usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens <= 0) continue
    const key = slotKey('', integerOf(event.data?.turn), integerOf(event.data?.step), event.seq)
    const previous = slots.get(key)
    if (previous !== undefined) addToBucket(session, previous, -1)
    const source = event.type === 'assistant/message' ? sourceOfMessage(event) : route
    const contribution = makeContribution({ usage, provider: source.provider, model: source.model, time, config })
    slots.set(key, contribution)
    addToBucket(session, contribution, 1)
    if (session.firstTime === 0 || time < session.firstTime) session.firstTime = time
    if (time > session.lastTime) session.lastTime = time
  }
  return session
}

/**
 * Fold one session log into per-Turn costs plus a durable message → Turn map.
 * Mirrors `foldSessionTotals` (retry slot replacement, route tracking) so the
 * sum of Turn costs equals the Session's settled main-call cost.
 */
export function foldTurnCosts(events, inherited, config, cap) {
  const slots = new Map()
  let route = { provider: '', model: '' }
  const buckets = new Map()
  const messages = new Map()
  const list = Array.isArray(events) ? [...events] : []
  list.sort((left, right) => (finiteNumber(left?.seq) ?? 0) - (finiteNumber(right?.seq) ?? 0))
  for (const event of list) {
    if (!isRecord(event) || typeof event.type !== 'string') continue
    if ((finiteNumber(event?.seq) ?? 0) < inherited) continue
    const time = finiteNumber(event.time) ?? 0
    if (cap !== undefined && time >= cap) continue
    if (event.type === 'turn/start' || event.type === 'turn/end') continue
    if (event.type === 'request/header' || event.type === 'request/context') {
      const next = routeOfEvent(event)
      if (next !== undefined) route = next
      continue
    }
    if (event.type === 'llm/retry-started') {
      slots.delete(slotKey('', integerOf(event.data?.turn), integerOf(event.data?.step), event.seq))
      continue
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const rawUsage = usageOfEvent(event)
    if (rawUsage === undefined) continue
    const usage = readUsage(rawUsage)
    if (usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens <= 0) continue
    const turn = integerOf(event.data?.turn)
    if (turn === undefined) continue
    const key = slotKey('', turn, integerOf(event.data?.step), event.seq)
    const previous = slots.get(key)
    if (previous !== undefined) {
      const previousBucket = buckets.get(turn)
      if (previousBucket !== undefined) addToBucket(previousBucket, previous, -1)
    }
    const source = event.type === 'assistant/message' ? sourceOfMessage(event) : route
    const contribution = makeContribution({ usage, provider: source.provider, model: source.model, time, config })
    slots.set(key, contribution)
    let bucket = buckets.get(turn)
    if (bucket === undefined) {
      bucket = emptyTotals()
      buckets.set(turn, bucket)
    }
    addToBucket(bucket, contribution, 1)
    if (event.type === 'assistant/message') {
      const messageId = event?.data?.message?.id
      if (typeof messageId === 'string' && messageId !== '') messages.set(messageId, turn)
    }
  }
  const turns = []
  for (const [turn, bucket] of [...buckets].sort((left, right) => left[0] - right[0])) {
    if (bucket.requests <= 0 || bucket.cost <= 0) continue
    turns.push({
      turn,
      cost: roundCost(bucket.cost),
      cacheHitCost: roundCost(bucket.cacheHitCost),
      cacheMissCost: roundCost(bucket.cacheMissCost),
      outputCost: roundCost(bucket.outputCost),
      totalTokens: totalTokensOf(bucket),
    })
  }
  return { turns, messages: Object.fromEntries(messages) }
}

/**
 * Fold one session log into its token mix by model and by reasoning effort.
 * Token counts (not money) keep the percentages meaningful for API billing.
 */
export function foldSessionChatMeta(events, inherited) {
  let route = { provider: '', model: '', effort: '' }
  const models = new Map()
  const efforts = new Map()
  const list = Array.isArray(events) ? [...events] : []
  list.sort((left, right) => (finiteNumber(left?.seq) ?? 0) - (finiteNumber(right?.seq) ?? 0))
  for (const event of list) {
    if (!isRecord(event) || typeof event.type !== 'string') continue
    if ((finiteNumber(event?.seq) ?? 0) < inherited) continue
    if (event.type === 'request/header') {
      const config = event?.data?.header?.config
      if (isRecord(config)) {
        route = {
          provider: typeof config.provider === 'string' ? config.provider : route.provider,
          model: typeof config.model === 'string' ? config.model : route.model,
          effort: typeof config.reasoningEffort === 'string' ? config.reasoningEffort : '',
        }
      }
      continue
    }
    if (event.type === 'request/context') {
      const data = event.data
      if (isRecord(data)) {
        route = {
          ...route,
          provider: typeof data.provider === 'string' ? data.provider : route.provider,
          model: typeof data.model === 'string' ? data.model : route.model,
        }
      }
      continue
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const rawUsage = usageOfEvent(event)
    if (rawUsage === undefined) continue
    const usage = readUsage(rawUsage)
    const tokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
    if (tokens <= 0) continue
    const source = event.type === 'assistant/message' ? sourceOfMessage(event) : route
    const model = (source.model || route.model || 'unknown').slice(0, 120)
    const effort = route.effort === '' ? 'default' : route.effort
    models.set(model, (models.get(model) ?? 0) + tokens)
    efforts.set(effort, (efforts.get(effort) ?? 0) + tokens)
  }
  return {
    models: [...models].map(([model, tokens]) => ({ model, tokens })).sort((left, right) => right.tokens - left.tokens),
    efforts: [...efforts].map(([effort, tokens]) => ({ effort, tokens })).sort((left, right) => right.tokens - left.tokens),
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Resolve the per-profile `plugin-data/<id>` directory. */
function resolvePluginDataDir(ctx) {
  try {
    const profile = ctx.get('profileContext')
    if (profile !== undefined && typeof profile?.dir === 'string' && isAbsolute(profile.dir)) {
      return join(resolve(profile.dir), 'plugin-data', PLUGIN_ID)
    }
  } catch {
    // Fall through to the environment.
  }
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  const profileDir = typeof process.env.DSH_PROFILE_DIR === 'string' ? process.env.DSH_PROFILE_DIR.trim() : ''
  if (profileDir !== '' && isAbsolute(profileDir)) return join(resolve(profileDir), 'plugin-data', PLUGIN_ID)
  const profileName = typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE.trim() !== ''
    ? process.env.DSH_PROFILE.trim()
    : 'web'
  return join(resolve(home), 'profiles', profileName, 'plugin-data', PLUGIN_ID)
}

async function loadState(dataDir) {
  try {
    const text = await readFile(join(dataDir, STATE_FILE), 'utf8')
    const parsed = JSON.parse(text)
    return { existed: true, state: sanitizeState(parsed) }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`[dsh-usage-meter] ignoring unreadable usage state: ${messageOf(error)}`)
    }
    return { existed: false, state: createState() }
  }
}

// ---------------------------------------------------------------------------
// Snapshots served to the browser half
// ---------------------------------------------------------------------------

function totalTokensOf(bucket) {
  return TOKEN_FIELDS.reduce((sum, field) => sum + (finiteNumber(bucket?.[field]) ?? 0), 0)
}

/**
 * Present a bucket's money fields to two decimals with the given converter.
 * The total is the sum of the converted components so the status bar's four
 * readings always add up.
 */
function costFields(totals, convert) {
  const cacheHitCost = convert(totals.cacheHitCost)
  const cacheMissCost = convert(totals.cacheMissCost)
  const outputCost = convert(totals.outputCost)
  const rawCost = finiteNumber(totals.cost) ?? 0
  const rawParts = (finiteNumber(totals.cacheHitCost) ?? 0)
    + (finiteNumber(totals.cacheMissCost) ?? 0)
    + (finiteNumber(totals.outputCost) ?? 0)
  // Only let the components define the total when the bucket was accumulated
  // with cost parts; a bucket upgraded from an older state keeps its raw total.
  const partsConsistent = rawParts > 0 && Math.abs(rawParts - rawCost) <= Math.max(0.005, Math.abs(rawCost) * 1e-9)
  const cost = partsConsistent
    ? Number((cacheHitCost + cacheMissCost + outputCost).toFixed(2))
    : convert(rawCost)
  return { cost, cacheHitCost, cacheMissCost, outputCost }
}

/** Displayed money: rounded half-up to cents. */
function presentedCostFields(totals) {
  return costFields(totals, roundCost)
}


function presentTotals(rawTotals, date) {
  const totals = sanitizeTotals(rawTotals)
  const totalTokens = totalTokensOf(totals)
  const money = presentedCostFields(totals)
  const presented = {
    ...totals,
    cost: money.cost,
    cacheHitCost: money.cacheHitCost,
    cacheMissCost: money.cacheMissCost,
    outputCost: money.outputCost,
    peakCost: roundCost(totals.peakCost),
    offCost: roundCost(totals.offCost),
    totalTokens,
    effectiveRate: totalTokens > 0 ? round((totals.cost * 1_000_000) / totalTokens, 4) : 0,
  }
  if (date !== undefined) presented.date = date
  return presented
}

function presentModels(state) {
  return Object.entries(state.models)
    .map(([model, rawTotals]) => {
      const totals = sanitizeTotals(rawTotals)
      const money = presentedCostFields(totals)
      return {
        model,
        cost: money.cost,
        cacheHitCost: money.cacheHitCost,
        cacheMissCost: money.cacheMissCost,
        outputCost: money.outputCost,
        peakCost: roundCost(totals.peakCost),
        offCost: roundCost(totals.offCost),
        requests: totals.requests,
        totalTokens: totalTokensOf(totals),
        estimated: rawTotals.estimated === true,
      }
    })
    .sort((left, right) => right.cost - left.cost)
    .slice(0, 6)
}

/** Top user chats by cost; subagent sessions fold into their parent chat. */
function presentChats(state) {
  const titles = isRecord(state.titles) ? state.titles : {}
  const meta = isRecord(state.meta) ? state.meta : {}
  const chatMeta = isRecord(state.chatMeta) ? state.chatMeta : {}
  const copyMix = (source) => {
    const out = {}
    if (!isRecord(source)) return out
    for (const [key, value] of Object.entries(source)) {
      const count = finiteNumber(value)
      if (typeof key === 'string' && key !== '' && count !== undefined && count > 0) out[key] = count
    }
    return out
  }
  const addMix = (target, source) => {
    if (!isRecord(source)) return
    for (const [key, value] of Object.entries(source)) {
      const count = finiteNumber(value)
      if (typeof key !== 'string' || key === '' || count === undefined || count <= 0) continue
      target[key] = (finiteNumber(target[key]) ?? 0) + count
    }
  }
  const mixArray = (mix, labelKey) => Object.entries(mix)
    .map(([key, tokens]) => ({ [labelKey]: key, tokens: Math.round(tokens) }))
    .filter((item) => item.tokens > 0)
    .sort((left, right) => right.tokens - left.tokens)
  const rows = new Map()
  for (const [id, raw] of Object.entries(state.sessions)) {
    if (!isRecord(raw)) continue
    const info = isRecord(meta[id]) ? meta[id] : undefined
    if (info?.origin === 'subagent') continue
    const totals = sanitizeTotals(raw)
    if (totals.requests <= 0 && totals.cost <= 0) continue
    rows.set(id, {
      id,
      title: typeof titles[id] === 'string' ? titles[id] : '',
      costRaw: totals.cost,
      hitRaw: totals.cacheHitCost,
      missRaw: totals.cacheMissCost,
      outRaw: totals.outputCost,
      totalTokens: totalTokensOf(totals),
      requests: totals.requests,
      lastTime: finiteNumber(raw.lastTime) ?? 0,
      modelMix: copyMix(chatMeta[id]?.models),
      effortMix: copyMix(chatMeta[id]?.efforts),
    })
  }
  for (const [id, raw] of Object.entries(state.sessions)) {
    if (!isRecord(raw)) continue
    const info = isRecord(meta[id]) ? meta[id] : undefined
    if (info?.origin !== 'subagent') continue
    const parent = typeof info.parent === 'string' ? rows.get(info.parent) : undefined
    if (parent === undefined) continue
    const totals = sanitizeTotals(raw)
    if (totals.requests <= 0 && totals.cost <= 0) continue
    parent.costRaw += totals.cost
    parent.hitRaw += totals.cacheHitCost
    parent.missRaw += totals.cacheMissCost
    parent.outRaw += totals.outputCost
    parent.totalTokens += totalTokensOf(totals)
    parent.requests += totals.requests
    parent.lastTime = Math.max(parent.lastTime, finiteNumber(raw.lastTime) ?? 0)
    addMix(parent.modelMix, chatMeta[id]?.models)
    addMix(parent.effortMix, chatMeta[id]?.efforts)
  }
  return [...rows.values()]
    .map((row) => ({
      id: row.id,
      title: row.title,
      cost: roundCost(row.costRaw),
      cacheHitCost: roundCost(row.hitRaw),
      cacheMissCost: roundCost(row.missRaw),
      outputCost: roundCost(row.outRaw),
      totalTokens: row.totalTokens,
      requests: row.requests,
      lastTime: row.lastTime,
      models: mixArray(row.modelMix, 'model'),
      efforts: mixArray(row.effortMix, 'effort'),
    }))
    .sort((left, right) => right.cost - left.cost
      || right.totalTokens - left.totalTokens
      || right.lastTime - left.lastTime)
    .slice(0, 20)
}

function presentSession(state, sessionId) {
  const raw = isRecord(state.sessions[sessionId]) ? state.sessions[sessionId] : undefined
  return {
    id: sessionId,
    tracked: raw !== undefined,
    ...presentTotals(raw),
    longestTurnMs: finiteNumber(raw?.longestTurnMs) ?? 0,
    firstTime: finiteNumber(raw?.firstTime) ?? 0,
    lastTime: finiteNumber(raw?.lastTime) ?? 0,
  }
}

/** Day keys that reported at least one settled request, ascending. */
function activeDayKeys(state) {
  return Object.keys(state.days)
    .filter((key) => (finiteNumber(state.days[key]?.requests) ?? 0) > 0)
    .sort()
}

/** Longest and current consecutive-day streaks over active days. */
function computeStreaks(state, now) {
  const active = new Set(activeDayKeys(state))
  let longest = 0
  let run = 0
  let previous = null
  for (const key of [...active].sort()) {
    run = previous !== null && nextDateKey(previous) === key ? run + 1 : 1
    if (run > longest) longest = run
    previous = key
  }
  const cursor = new Date(now)
  cursor.setHours(0, 0, 0, 0)
  if (!active.has(localDateKey(cursor.getTime()))) {
    // A day that has not reported yet keeps yesterday's streak alive.
    cursor.setDate(cursor.getDate() - 1)
  }
  let current = 0
  while (active.has(localDateKey(cursor.getTime()))) {
    current += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return { longest, current }
}

/** Peak daily token total over the complete retained history. */
function computePeakDay(state) {
  let peakTokens = 0
  let peakDay = null
  for (const [key, bucket] of Object.entries(state.days)) {
    const tokens = totalTokensOf(bucket)
    if (tokens > peakTokens) {
      peakTokens = tokens
      peakDay = key
    }
  }
  return { peakTokens, peakDay }
}

function presentBackfill(state) {
  const backfill = isRecord(state.backfill) ? state.backfill : {}
  return {
    state: typeof backfill.state === 'string' ? backfill.state : 'pending',
    ...(finiteNumber(backfill.at) === undefined ? {} : { at: backfill.at }),
    ...(finiteNumber(backfill.sessions) === undefined ? {} : { sessions: backfill.sessions }),
    ...(backfill.truncated === true ? { truncated: true } : {}),
    ...(finiteNumber(backfill.version) === undefined ? {} : { version: backfill.version }),
  }
}

/** Build the status-bar payload. */
export function buildSnapshot(state, config, now, sessionId) {
  const scheduled = config.pricingMode === 'scheduled'
  const peak = scheduled && isPeak(now, config)
  const dayKey = localDateKey(now)
  const snapshot = {
    ok: true,
    schema: 2,
    revision: state.revision,
    generatedAt: now,
    timezone: 'Asia/Shanghai',
    period: {
      kind: peak ? 'peak' : 'off',
      pricingMode: config.pricingMode,
      nextChangeAt: scheduled ? nextPeriodChange(now, config) : null,
      windows: scheduled ? config.peakWindows.map(([start, end]) => `${clockLabel(start)}-${clockLabel(end)}`) : [],
      peakDays: config.peakDays,
      holidayCount: config.holidays.length,
    },
    today: presentTotals(state.days[dayKey], dayKey),
    total: presentTotals(state.total),
    models: presentModels(state),
    last: state.last === null ? null : {
      time: state.last.time,
      model: state.last.model,
      provider: state.last.provider,
      peak: state.last.peak,
      cost: roundCost(state.last.cost),
      estimated: state.last.estimated,
    },
    trackingSince: state.trackingSince,
    backfill: presentBackfill(state),
    pollMs: config.pollMs,
    pricing: {
      currency: 'CNY',
      unit: '1M tokens',
      source: 'DeepSeek official pricing',
      models: config.models,
    },
  }
  if (typeof sessionId === 'string') snapshot.session = presentSession(state, sessionId)
  return snapshot
}

/** Build the statistics-page payload: KPIs, zero-filled daily series, models. */
export function buildStats(state, config, now) {
  const end = startOfLocalDay(now)
  const days = []
  for (let back = HISTORY_DAYS - 1; back >= 0; back -= 1) {
    const date = new Date(end)
    date.setDate(date.getDate() - back)
    const key = localDateKey(date.getTime())
    const bucket = state.days[key]
    days.push({
      date: key,
      tokens: totalTokensOf(bucket),
      cost: roundCost(finiteNumber(bucket?.cost) ?? 0),
      requests: finiteNumber(bucket?.requests) ?? 0,
    })
  }
  const { peakTokens, peakDay } = computePeakDay(state)
  const streaks = computeStreaks(state, now)
  const sessions = Object.values(state.sessions)
  const longestTurnMs = sessions.reduce((longest, session) => Math.max(longest, finiteNumber(session?.longestTurnMs) ?? 0), 0)
  const activeDays = activeDayKeys(state).length
  const allDayKeys = Object.keys(state.days).sort()
  return {
    ok: true,
    schema: 2,
    revision: state.revision,
    generatedAt: now,
    timezone: 'Asia/Shanghai',
    period: buildSnapshot(state, config, now).period,
    kpis: {
      totalTokens: totalTokensOf(state.total),
      totalCost: presentTotals(state.total).cost,
      requests: finiteNumber(state.total.requests) ?? 0,
      peakTokens,
      peakDay,
      longestTurnMs,
      longestStreakDays: streaks.longest,
      currentStreakDays: streaks.current,
      activeDays,
      sessionCount: sessions.length,
      historyFrom: allDayKeys.length > 0 ? allDayKeys[0] : null,
      historyTo: allDayKeys.length > 0 ? allDayKeys[allDayKeys.length - 1] : null,
      trackingSince: state.trackingSince,
      backfill: presentBackfill(state),
    },
    days,
    models: presentModels(state),
    chats: presentChats(state),
    auxCalls: {
      requests: Math.max(0, Math.floor(finiteNumber(state.aux?.requests) ?? 0)),
      cost: roundCost(state.aux?.cost),
      tokens: Math.max(0, Math.floor(finiteNumber(state.aux?.tokens) ?? 0)),
      byPurpose: Object.fromEntries(
        Object.entries(isRecord(state.aux?.byPurpose) ? state.aux.byPurpose : {})
          .map(([purpose, cost]) => [purpose, roundCost(cost)]),
      ),
      byPurposeRequests: Object.fromEntries(
        Object.entries(isRecord(state.aux?.byPurposeRequests) ? state.aux.byPurposeRequests : {})
          .map(([purpose, count]) => [purpose, Math.max(0, Math.floor(finiteNumber(count) ?? 0))]),
      ),
      byPurposeTokens: Object.fromEntries(
        Object.entries(isRecord(state.aux?.byPurposeTokens) ? state.aux.byPurposeTokens : {})
          .map(([purpose, tokens]) => [purpose, Math.max(0, Math.floor(finiteNumber(tokens) ?? 0))]),
      ),
      recent: Array.isArray(state.aux?.log) ? state.aux.log.slice(-25).map((entry) => ({
        time: entry.time,
        purpose: entry.purpose,
        sessionId: entry.sessionId,
        provider: entry.provider,
        model: entry.model,
        inputTokens: entry.inputTokens,
        cacheReadTokens: entry.cacheReadTokens,
        outputTokens: entry.outputTokens,
        cost: roundCost(entry.cost),
      })) : [],
    },
    pricing: {
      currency: 'CNY',
      unit: '1M tokens',
      source: 'DeepSeek official pricing',
      models: config.models,
    },
  }
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/**
 * Mount the usage meter.
 * @param ctx Host plugin context.
 * @param rawConfig Optional row config (see README).
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  let state = createState()
  let dataDir = ''
  let loaded = false
  let dirty = false
  let backfilling = false
  /** Live events wait here until state load (and the optional backfill) settles. */
  const buffer = []
  /** Last provider/model route per session; `assistant/attempt` carries none. */
  const routes = new Map()
  /** Open turn per session, for the longest-task duration. */
  const turnStarts = new Map()
  /** Lazily folded per-Turn costs, dropped whenever the session log advances. */
  const turnCache = new Map()
  /** Lazily folded model/effort mix, invalidated by the same session events. */
  const chatMetaCache = new Map()
  /** Newest live events per session, so a just-settled Turn folds before the log flushes. */
  const liveEvents = new Map()
  const LIVE_EVENT_LIMIT = 400
  const recordLiveEvent = (sessionId, event) => {
    if (!isRecord(event) || typeof event.type !== 'string') return
    let list = liveEvents.get(sessionId)
    if (list === undefined) {
      list = []
      liveEvents.set(sessionId, list)
    }
    list.push(event)
    if (list.length > LIVE_EVENT_LIMIT) list.splice(0, list.length - LIVE_EVENT_LIMIT)
  }

  const markDirty = () => {
    dirty = true
  }

  let writeChain = Promise.resolve()
  const persist = () => {
    if (!dirty || dataDir === '') return writeChain
    dirty = false
    const text = serializeState(state)
    writeChain = writeChain
      .then(async () => {
        await mkdir(dataDir, { recursive: true })
        const temporary = join(dataDir, `${STATE_FILE}.${process.pid}.tmp`)
        await writeFile(temporary, text, 'utf8')
        await rename(temporary, join(dataDir, STATE_FILE))
      })
      .catch((error) => {
        dirty = true
        console.warn(`[dsh-usage-meter] failed to save usage state: ${messageOf(error)}`)
      })
    return writeChain
  }

  const applyContribution = (contribution, sign, sessionId) => {
    const buckets = [
      state.total,
      ensureBucket(state.days, localDateKey(contribution.time)),
      ensureBucket(state.models, contribution.model === '' ? '(unknown)' : contribution.model),
    ]
    if (contribution.estimated) {
      const modelBucket = buckets[2]
      if (modelBucket.estimated !== true) modelBucket.estimated = true
    }
    if (typeof sessionId === 'string' && sessionId !== '') {
      const session = ensureSession(state, sessionId)
      buckets.push(session)
      if (sign > 0) {
        const time = contribution.time
        if (session.firstTime === 0 || time < session.firstTime) session.firstTime = time
        if (time > session.lastTime) session.lastTime = time
      }
    }
    for (const bucket of buckets) addToBucket(bucket, contribution, sign)
  }

  const deleteSlot = (sessionId, event, slotStore) => {
    const turn = integerOf(event?.data?.turn)
    const step = integerOf(event?.data?.step)
    const key = slotKey(sessionId, turn, step, event?.seq)
    if (slotStore !== undefined) slotStore.delete(key)
    else delete state.slots[key]
  }

  /**
   * Fold one committed session event into the aggregate.
   * @param sessionId Stable session id.
   * @param event Committed session event.
   * @param options Backfill windows plus the local maps a replay owns.
   */
  const ingest = (sessionId, event, options = {}) => {
    if (!isRecord(event) || typeof event.type !== 'string') return
    const time = finiteNumber(event.time) ?? Date.now()
    /** A buffered event already present in a reconciled Session total. */
    const skipSession = options.skipSession === true
    const sessionTarget = skipSession ? undefined : sessionId

    // Turn boundaries feed the longest-task KPI for live and replayed events.
    if (event.type === 'turn/start') {
      if (skipSession) return
      const turn = integerOf(event.data?.turn)
      if (turn !== undefined) (options.turnStarts ?? turnStarts).set(sessionId, { turn, time })
      return
    }
    if (event.type === 'turn/end') {
      if (skipSession) return
      const turn = integerOf(event.data?.turn)
      const starts = options.turnStarts ?? turnStarts
      const started = starts.get(sessionId)
      if (started !== undefined && turn !== undefined && started.turn === turn) {
        const session = ensureSession(state, sessionId)
        const duration = Math.max(0, time - started.time)
        if (duration > (finiteNumber(session.longestTurnMs) ?? 0)) {
          session.longestTurnMs = duration
          state.revision += 1
          state.updatedAt = Date.now()
          markDirty()
        }
      }
      starts.delete(sessionId)
      return
    }

    const inWindow = options.backfill !== true
      || (time < options.cap && time >= options.floor)
    if (!inWindow) return

    if (event.type === 'session/title') {
      const title = typeof event.data?.title === 'string' ? event.data.title.trim() : ''
      if (title !== '') {
        if (!isRecord(state.titles)) state.titles = {}
        const next = title.slice(0, 200)
        if (state.titles[sessionId] !== next) {
          state.titles[sessionId] = next
          state.revision += 1
          state.updatedAt = Date.now()
          markDirty()
        }
      }
      return
    }

    if (event.type === 'request/header' || event.type === 'request/context') {
      const next = routeOfEvent(event)
      if (next !== undefined) {
        const store = options.routes ?? routes
        const previousRoute = store.get(sessionId)
        const header = event.type === 'request/header' && isRecord(event.data?.header?.config)
          ? event.data.header.config
          : undefined
        const effort = header !== undefined && typeof header.reasoningEffort === 'string'
          ? header.reasoningEffort
          : (typeof previousRoute?.effort === 'string' ? previousRoute.effort : '')
        store.set(sessionId, { ...next, effort })
      }
      return
    }
    if (event.type === 'llm/retry-started') {
      // A retry starts a separately billed request: the earlier attempt stays
      // counted, and the next settlement must not replace it.
      deleteSlot(sessionId, event, options.slots)
      return
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return
    const rawUsage = usageOfEvent(event)
    if (rawUsage === undefined) return
    const usage = readUsage(rawUsage)
    if (usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens <= 0) return
    const tokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
    const turn = integerOf(event.data?.turn)
    const step = integerOf(event.data?.step)
    const key = slotKey(sessionId, turn, step, event.seq)
    const slotStore = options.slots
    const previous = slotStore !== undefined ? slotStore.get(key) : state.slots[key]
    if (previous !== undefined) {
      applyContribution(previous, -1, sessionTarget)
      if (sessionTarget !== undefined) {
        bumpChatMeta(state, sessionTarget, previous.model, previous.effort, tokensOfUsage(previous.usage), -1, time)
      }
    }
    const route = (options.routes ?? routes).get(sessionId) ?? { provider: '', model: '', effort: '' }
    const source = event.type === 'assistant/message' ? sourceOfMessage(event) : route
    const effort = typeof route.effort === 'string' ? route.effort : ''
    const contribution = makeContribution({ usage, provider: source.provider, model: source.model, time, config, effort })
    if (slotStore !== undefined) slotStore.set(key, contribution)
    else state.slots[key] = contribution
    applyContribution(contribution, 1, sessionTarget)
    if (sessionTarget !== undefined) {
      bumpChatMeta(state, sessionTarget, contribution.model, effort, tokens, 1, time)
    }
    if (state.last === null || time >= state.last.time) {
      state.last = {
        time,
        model: contribution.model,
        provider: contribution.provider,
        peak: contribution.peak,
        cost: contribution.cost,
        estimated: contribution.estimated,
      }
    }
    state.revision += 1
    state.updatedAt = Date.now()
    if (options.backfill !== true) pruneState(state, config, Date.now())
    markDirty()
  }

  const onSessionEvent = (session, event) => {
    const sessionId = typeof session?.id === 'string' ? session.id : String(session?.id ?? '')
    turnCache.delete(sessionId)
    chatMetaCache.delete(sessionId)
    recordLiveEvent(sessionId, event)
    if (!loaded || backfilling) {
      if (buffer.length < BUFFER_LIMIT) buffer.push([sessionId, event])
      return
    }
    ingest(sessionId, event)
  }

  // -------------------------------------------------------------------------
  // Backfill: already-logged history, so "today" and the heatmap are right
  // -------------------------------------------------------------------------

  const readSessionLog = async (record) => {
    const sessionId = record?.header?.id
    if (sessionId === undefined) return undefined
    const query = ctx.get('sessionQuery')
    if (query !== undefined && typeof query.readSession === 'function') {
      const snapshot = await query.readSession(sessionId)
      if (snapshot !== undefined && Array.isArray(snapshot.events)) return snapshot
    }
    const persistence = ctx.get('sessionPersistence')
    if (persistence !== undefined && typeof persistence.open === 'function') {
      const handle = await persistence.open(sessionId, 'read')
      try {
        const result = await handle.read()
        return {
          session: handle.header,
          inheritedEventCount: handle.inheritedEventCount,
          events: Array.isArray(result?.events) ? result.events : [],
        }
      } finally {
        await handle.close?.()
      }
    }
    return undefined
  }

  const listSessions = async () => {
    const query = ctx.get('sessionQuery')
    if (query !== undefined && typeof query.listSessions === 'function') {
      const records = await query.listSessions()
      return Array.isArray(records) ? records : []
    }
    const persistence = ctx.get('sessionPersistence')
    if (persistence !== undefined && typeof persistence.list === 'function') {
      const snapshots = await persistence.list()
      return Array.isArray(snapshots) ? snapshots.map((snapshot) => ({ header: snapshot.header })) : []
    }
    return undefined
  }

  /**
   * Replay logged history. The first pass (`floor = 0`) covers everything
   * logged before this process started; a later upgrade pass only fills days
   * before the day the old pass already covered, so nothing is counted twice.
   */
  const runBackfill = async (loadedExisted) => {
    const current = isRecord(state.backfill) ? state.backfill : {}
    if (current.state === 'skipped' && current.version === BACKFILL_VERSION) return
    if (!config.backfill) {
      state.backfill = { state: 'skipped', reason: 'disabled', version: BACKFILL_VERSION }
      state.sessionReconcile = { state: 'skipped', reason: 'disabled' }
      markDirty()
      return
    }
    const covered = current.state === 'done' || current.state === 'partial'
    if (covered && current.version === BACKFILL_VERSION) return
    if (current.state === 'running' && loadedExisted) {
      // An interrupted pass in a persisted state: retry it as a new pass.
      state.backfill = { state: 'pending' }
    }
    const startedAt = Date.now()
    const trackingSince = finiteNumber(state.trackingSince) ?? startedAt
    const extended = covered
    // Window each upgrade generation still owes:
    // - v1 had no version: it counted today's sessions only, so replay every
    //   Session created before today across its whole life;
    // - v2 already covered old days, so replay only the pre-install hours of
    //   today for those Sessions;
    // - a first pass owns everything logged before this process started.
    let cap = trackingSince
    let floor = 0
    let candidateBefore = trackingSince
    if (extended && current.version === 2) {
      floor = startOfLocalDay(finiteNumber(current.at) ?? trackingSince)
      candidateBefore = floor
    } else if (extended) {
      candidateBefore = startOfLocalDay(trackingSince)
    }
    state.backfill = { state: 'running', version: BACKFILL_VERSION, startedAt }
    markDirty()
    let records
    try {
      records = await listSessions()
    } catch (error) {
      console.warn(`[dsh-usage-meter] cannot list sessions for backfill: ${messageOf(error)}`)
      records = undefined
    }
    let sessions = 0
    let truncated = false
    if (records !== undefined) {
      const candidates = records
        .filter((record) => {
          const createdAt = finiteNumber(record?.header?.createdAt)
          return createdAt !== undefined && createdAt < candidateBefore
        })
        .sort((left, right) => right.header.createdAt - left.header.createdAt)
        .slice(0, BACKFILL_SESSION_LIMIT)
      for (const record of candidates) {
        if (Date.now() - startedAt > BACKFILL_DEADLINE_MS) {
          truncated = true
          break
        }
        try {
          const snapshot = await readSessionLog(record)
          if (snapshot === undefined) continue
          const inherited = Math.max(0, integerOf(snapshot.inheritedEventCount) ?? 0)
          const events = Array.isArray(snapshot.events) ? [...snapshot.events] : []
          events.sort((left, right) => (finiteNumber(left?.seq) ?? 0) - (finiteNumber(right?.seq) ?? 0))
          const sessionId = String(snapshot.session?.id ?? record.header.id)
          const sessionRoutes = new Map()
          const sessionSlots = new Map()
          const sessionTurns = new Map()
          for (const event of events) {
            if ((finiteNumber(event?.seq) ?? 0) < inherited) continue
            ingest(sessionId, event, {
              backfill: true,
              floor,
              cap,
              routes: sessionRoutes,
              slots: sessionSlots,
              turnStarts: sessionTurns,
            })
          }
          sessions += 1
        } catch (error) {
          console.warn(`[dsh-usage-meter] backfill skipped one session: ${messageOf(error)}`)
        }
      }
    }
    state.backfill = {
      state: truncated ? 'partial' : 'done',
      version: BACKFILL_VERSION,
      at: Date.now(),
      sessions,
      ...(truncated ? { truncated: true } : {}),
    }
    if (!extended) {
      // A first pass already produced complete per-Session totals.
      state.sessionReconcile = { state: 'done', reason: 'fresh-backfill', at: Date.now(), version: SESSION_RECONCILE_VERSION }
    }
    state.revision += 1
    state.updatedAt = Date.now()
    markDirty()
    console.warn(`[dsh-usage-meter] history backfill ${state.backfill.state}: ${sessions} sessions`)
  }

  /**
   * Rebuild per-Session totals from the durable logs. An upgrade from a build
   * that had no per-Session map cannot recover today's earlier usage from the
   * aggregate alone, so this pass replays each Session once and overwrites its
   * totals. Events at or after `cap` belong to the live fold and are excluded.
   */
  const reconcileSessions = async () => {
    const startedAt = Date.now()
    const cap = startedAt
    const done = new Set()
    let records
    try {
      records = await listSessions()
    } catch (error) {
      console.warn(`[dsh-usage-meter] cannot list sessions for reconciliation: ${messageOf(error)}`)
      records = undefined
    }
    let sessions = 0
    let truncated = false
    if (records !== undefined) {
      const candidates = records
        .filter((record) => {
          const createdAt = finiteNumber(record?.header?.createdAt)
          return createdAt !== undefined && createdAt < cap
        })
        .sort((left, right) => (finiteNumber(right.header?.createdAt) ?? 0) - (finiteNumber(left.header?.createdAt) ?? 0))
        .slice(0, BACKFILL_SESSION_LIMIT)
      for (const record of candidates) {
        if (Date.now() - startedAt > BACKFILL_DEADLINE_MS) {
          truncated = true
          break
        }
        try {
          const snapshot = await readSessionLog(record)
          if (snapshot === undefined) continue
          const inherited = Math.max(0, integerOf(snapshot.inheritedEventCount) ?? 0)
          const sessionId = String(snapshot.session?.id ?? record.header.id)
          state.sessions[sessionId] = foldSessionTotals(snapshot.events, inherited, config, cap)
          done.add(sessionId)
          sessions += 1
          markDirty()
        } catch (error) {
          console.warn(`[dsh-usage-meter] session reconcile skipped one session: ${messageOf(error)}`)
        }
      }
    }
    state.sessionReconcile = {
      state: truncated ? 'partial' : 'done',
      version: SESSION_RECONCILE_VERSION,
      at: Date.now(),
      sessions,
      ...(truncated ? { truncated: true } : {}),
    }
    pruneState(state, config, Date.now())
    state.revision += 1
    state.updatedAt = Date.now()
    markDirty()
    console.warn(`[dsh-usage-meter] session totals reconciled: ${sessions} sessions`)
    return { cap, sessions: done }
  }

  // -------------------------------------------------------------------------
  // Effects and routes
  // -------------------------------------------------------------------------

  ctx.on('session/event', onSessionEvent)

  // Auxiliary model calls (auto-review, and any future purposeful callers) do
  // not settle an `assistant/message`, so their usage never reaches
  // session/event. Intercept the `llm/stream` waterfall to bill them too, which
  // is what makes the daily/session totals match DeepSeek's own bill.
  const auxBuffer = []
  const recordAuxUsage = ({ time, purpose, provider, model, sessionId, usage: rawUsage }) => {
    const usage = readUsage(rawUsage)
    const tokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
    if (tokens <= 0) return
    const contribution = makeContribution({ usage, provider, model, time, config })
    applyContribution(contribution, 1, sessionId)
    state.aux = isRecord(state.aux) ? state.aux : { requests: 0, cost: 0, tokens: 0, byPurpose: {}, byPurposeRequests: {}, byPurposeTokens: {}, log: [] }
    state.aux.requests = (Math.max(0, Math.floor(finiteNumber(state.aux.requests) ?? 0)) + 1)
    state.aux.cost = (nonNegative(state.aux.cost) ?? 0) + contribution.cost
    state.aux.tokens = (Math.max(0, Math.floor(finiteNumber(state.aux.tokens) ?? 0)) + tokens)
    if (!isRecord(state.aux.byPurpose)) state.aux.byPurpose = {}
    state.aux.byPurpose[purpose] = (nonNegative(state.aux.byPurpose[purpose]) ?? 0) + contribution.cost
    if (!isRecord(state.aux.byPurposeRequests)) state.aux.byPurposeRequests = {}
    state.aux.byPurposeRequests[purpose] = (Math.max(0, Math.floor(finiteNumber(state.aux.byPurposeRequests[purpose]) ?? 0)) + 1)
    if (!isRecord(state.aux.byPurposeTokens)) state.aux.byPurposeTokens = {}
    state.aux.byPurposeTokens[purpose] = (Math.max(0, Math.floor(finiteNumber(state.aux.byPurposeTokens[purpose]) ?? 0)) + tokens)
    if (!Array.isArray(state.aux.log)) state.aux.log = []
    state.aux.log.push({
      time,
      purpose,
      sessionId: sessionId ?? '',
      provider: contribution.provider,
      model: contribution.model,
      inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      outputTokens: usage.outputTokens,
      cost: contribution.cost,
    })
    if (state.aux.log.length > 25) state.aux.log.splice(0, state.aux.log.length - 25)
    state.revision += 1
    state.updatedAt = Date.now()
    markDirty()
  }
  ctx.on('llm/stream', (options, next) => {
    const stream = next()
    const purpose = typeof options?.purpose === 'string' ? options.purpose.trim() : ''
    // The agent loop's own requests carry no purpose and are already billed by
    // their `assistant/message` settlement; only purposeful callers are aux.
    if (purpose === '' || purpose === 'agent') return stream
    const entry = {
      time: Date.now(),
      purpose: purpose.slice(0, 80),
      provider: typeof options?.provider === 'string' ? options.provider : '',
      model: typeof options?.model === 'string' ? options.model : '',
      sessionId: typeof options?.sessionId === 'string' ? options.sessionId : undefined,
      usage: undefined,
    }
    return (async function* observeAuxStream() {
      try {
        for await (const chunk of stream) {
          if (isRecord(chunk) && chunk.type === 'usage' && isRecord(chunk.usage)) entry.usage = chunk.usage
          yield chunk
        }
      } finally {
        try {
          if (entry.usage !== undefined) {
            if (loaded) recordAuxUsage(entry)
            else auxBuffer.push(entry)
          }
        } catch (error) {
          // Never let metering break a provider call.
          console.warn(`[dsh-usage-meter] auxiliary usage was not recorded: ${messageOf(error)}`)
        }
      }
    })()
  })

  ctx.effect(() => {
    let cancelled = false
    /** Buffered pre-reconcile events already folded into a Session total. */
    let reconcileCutoff = 0
    const reconciledSessions = new Set()
    // Whatever happens during bootstrap, the routes must stop answering
    // "loading" and the buffered live events must reach the fold.
    const finishBootstrap = () => {
      if (cancelled) return
      loaded = true
      backfilling = false
      const queued = buffer.splice(0)
      for (const [sessionId, event] of queued) {
        const time = finiteNumber(event?.time) ?? 0
        const alreadyReconciled = time < reconcileCutoff && reconciledSessions.has(sessionId)
        ingest(sessionId, event, alreadyReconciled ? { skipSession: true } : {})
      }
      const queuedAux = auxBuffer.splice(0)
      for (const entry of queuedAux) {
        if (entry.usage !== undefined) recordAuxUsage(entry)
      }
      void persist()
    }
    /** One-time fill of durable Session titles for the chat ranking. */
    const ensureTitles = async () => {
      const marker = isRecord(state.titlesBackfill) ? state.titlesBackfill : undefined
      if (marker?.version === TITLES_VERSION && marker.state === 'done') return
      const query = ctx.get('sessionQuery')
      if (query === undefined || typeof query.readTitleSnapshots !== 'function') return
      const startedAt = Date.now()
      let records
      try {
        records = await listSessions()
      } catch {
        records = []
      }
      const recordsList = Array.isArray(records) ? records : []
      if (!isRecord(state.meta)) state.meta = {}
      for (const record of recordsList) {
        const header = record?.header
        const id = String(header?.id ?? '')
        if (id === '' || id.length > 200) continue
        const entry = {}
        if (header?.origin === 'subagent') entry.origin = 'subagent'
        const parent = header?.parentSession
        if (typeof parent === 'string' && parent !== '' && parent.length <= 200) entry.parent = parent
        if (Object.keys(entry).length > 0) state.meta[id] = entry
        else if (state.meta[id] !== undefined) delete state.meta[id]
      }
      const known = new Set(Object.entries(state.sessions)
        .sort((left, right) => (finiteNumber(right[1]?.cost) ?? 0) - (finiteNumber(left[1]?.cost) ?? 0))
        .slice(0, 60)
        .map(([id]) => id))
      const ids = recordsList
        .map((record) => String(record?.header?.id ?? ''))
        .filter((id) => id !== '' && known.has(id))
        .slice(0, BACKFILL_SESSION_LIMIT)
      if (!isRecord(state.titles)) state.titles = {}
      let truncated = false
      for (let index = 0; index < ids.length; index += 50) {
        if (Date.now() - startedAt > BACKFILL_DEADLINE_MS) {
          truncated = true
          break
        }
        const chunk = ids.slice(index, index + 50)
        let results
        try {
          results = await query.readTitleSnapshots(chunk)
        } catch {
          continue
        }
        for (const result of Array.isArray(results) ? results : []) {
          if (result?.status !== 'fulfilled') continue
          const title = result.value?.title?.title
          if (typeof title !== 'string' || title.trim() === '') continue
          state.titles[String(result.sessionId)] = title.trim().slice(0, 200)
        }
      }
      state.titlesBackfill = { state: truncated ? 'partial' : 'done', version: TITLES_VERSION, at: Date.now() }
      state.updatedAt = Date.now()
      markDirty()
    }
    /** One-time fill of the stored model/effort mix for existing chats. */
    const ensureChatMeta = async () => {
      const marker = isRecord(state.chatMetaBackfill) ? state.chatMetaBackfill : undefined
      if (marker?.version === CHAT_META_VERSION && marker.state === 'done') return
      const startedAt = Date.now()
      if (!isRecord(state.chatMeta)) state.chatMeta = {}
      const candidates = Object.entries(state.sessions)
        .filter(([id]) => !isRecord(state.chatMeta[id]))
        .sort((left, right) => (finiteNumber(right[1]?.cost) ?? 0) - (finiteNumber(left[1]?.cost) ?? 0))
        .slice(0, 80)
      let truncated = false
      for (const [id] of candidates) {
        if (Date.now() - startedAt > 30_000) {
          truncated = true
          break
        }
        try {
          const snapshot = await readSessionLog({ header: { id } })
          if (snapshot === undefined) continue
          const inherited = Math.max(0, integerOf(snapshot.inheritedEventCount) ?? 0)
          storeChatMetaFold(state, id, foldSessionChatMeta(snapshot.events, inherited))
          markDirty()
        } catch (error) {
          console.warn(`[dsh-usage-meter] chat meta skipped one session: ${messageOf(error)}`)
        }
      }
      state.chatMetaBackfill = { state: truncated ? 'partial' : 'done', version: CHAT_META_VERSION, at: Date.now() }
      state.updatedAt = Date.now()
      markDirty()
    }
    void (async () => {
      try {
        dataDir = resolvePluginDataDir(ctx)
        const loadedState = await loadState(dataDir)
        if (cancelled) return
        const signature = pricingSignature(config)
        // Any pricing/schedule change reprices the whole retained history, so
        // rebuild it from the durable logs instead of mixing two price books.
        const stalePricing = loadedState.existed && loadedState.state.pricingSignature !== signature
        if (stalePricing) {
          console.warn('[dsh-usage-meter] pricing configuration changed; rebuilding usage history from session logs')
          state = createState()
        } else {
          state = loadedState.state
        }
        state.pricingSignature = signature
        pruneState(state, config, Date.now())
        state.revision += 1
        markDirty()
        backfilling = true
        await runBackfill(stalePricing ? false : loadedState.existed)
        const reconcileState = state.sessionReconcile
        const reconcileCurrent = reconcileState?.state === 'done' && reconcileState?.version === SESSION_RECONCILE_VERSION
        if (reconcileState?.state !== 'skipped' && !reconcileCurrent) {
          const result = await reconcileSessions()
          reconcileCutoff = result.cap
          for (const sessionId of result.sessions) reconciledSessions.add(sessionId)
        }
      } catch (error) {
        console.warn(`[dsh-usage-meter] state bootstrap failed: ${messageOf(error)}`)
      } finally {
        finishBootstrap()
        // Titles and stored chat mixes are filled in the background so the
        // routes never wait on session-log reads.
        void ensureTitles()
        void ensureChatMeta()
      }
    })()
    return () => {
      cancelled = true
    }
  }, 'dsh-usage-meter: state load')

  ctx.effect(() => {
    const timer = setInterval(() => {
      void persist()
    }, config.flushMs)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      void persist()
    }
  }, 'dsh-usage-meter: flush timer')

  const sendJson = (response, status, payload) => {
    try {
      const body = JSON.stringify(payload)
      response.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'x-content-type-options': 'nosniff',
      })
      response.end(body)
    } catch (error) {
      console.warn(`[dsh-usage-meter] cannot answer a usage route: ${messageOf(error)}`)
      try {
        response.writeHead(500)
        response.end()
      } catch {
        // The socket is already gone.
      }
    }
  }

  const requestUrl = (request) => {
    try {
      return new URL(request.url ?? '/', 'http://localhost')
    } catch {
      return new URL('/', 'http://localhost')
    }
  }

  const requireLoaded = (response) => {
    if (loaded) return true
    sendJson(response, 200, { ok: false, status: 'loading' })
    return false
  }

  const handleSummary = (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
      response.end()
      return
    }
    if (!requireLoaded(response)) return
    try {
      const session = requestUrl(request).searchParams.get('session')
      if (session !== null && !/^[A-Za-z0-9._:-]{1,200}$/.test(session)) {
        sendJson(response, 400, { ok: false, error: 'invalid session id' })
        return
      }
      sendJson(response, 200, buildSnapshot(state, config, Date.now(), session ?? undefined))
    } catch (error) {
      sendJson(response, 500, { ok: false, error: messageOf(error) })
    }
  }

  const handleStats = (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
      response.end()
      return
    }
    if (!requireLoaded(response)) return
    try {
      sendJson(response, 200, buildStats(state, config, Date.now()))
    } catch (error) {
      sendJson(response, 500, { ok: false, error: messageOf(error) })
    }
  }

  const handleTurns = async (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
      response.end()
      return
    }
    if (!requireLoaded(response)) return
    try {
      const session = requestUrl(request).searchParams.get('session')
      if (session === null || !/^[A-Za-z0-9._:-]{1,200}$/.test(session)) {
        sendJson(response, 400, { ok: false, error: 'invalid session id' })
        return
      }
      const cached = turnCache.get(session)
      let payload = cached !== undefined && Date.now() - cached.at < 1_500 ? cached.payload : undefined
      if (payload === undefined) {
        const snapshot = await readSessionLog({ header: { id: session } })
        const tail = liveEvents.get(session)
        if (snapshot === undefined && tail === undefined) {
          sendJson(response, 404, { ok: false, error: 'session unavailable' })
          return
        }
        const bySeq = new Map()
        for (const event of Array.isArray(snapshot?.events) ? snapshot.events : []) {
          bySeq.set(String(event?.seq), event)
        }
        for (const event of tail ?? []) bySeq.set(String(event?.seq), event)
        const inherited = Math.max(0, integerOf(snapshot?.inheritedEventCount) ?? 0)
        payload = foldTurnCosts([...bySeq.values()], inherited, config)
        turnCache.set(session, { at: Date.now(), payload })
      }
      sendJson(response, 200, { ok: true, session, turns: payload.turns, messages: payload.messages })
    } catch (error) {
      sendJson(response, 500, { ok: false, error: messageOf(error) })
    }
  }

  const handleChatMeta = async (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
      response.end()
      return
    }
    if (!requireLoaded(response)) return
    try {
      const session = requestUrl(request).searchParams.get('session')
      if (session === null || !/^[A-Za-z0-9._:-]{1,200}$/.test(session)) {
        sendJson(response, 400, { ok: false, error: 'invalid session id' })
        return
      }
      const stored = isRecord(state.chatMeta) && isRecord(state.chatMeta[session]) ? state.chatMeta[session] : undefined
      if (stored !== undefined) {
        const arrays = chatMetaArrays(stored)
        sendJson(response, 200, { ok: true, session, models: arrays.models, efforts: arrays.efforts, stored: true })
        return
      }
      const cached = chatMetaCache.get(session)
      let payload = cached !== undefined && Date.now() - cached.at < 5_000 ? cached.payload : undefined
      if (payload === undefined) {
        const snapshot = await readSessionLog({ header: { id: session } })
        if (snapshot === undefined) {
          sendJson(response, 404, { ok: false, error: 'session unavailable' })
          return
        }
        const inherited = Math.max(0, integerOf(snapshot.inheritedEventCount) ?? 0)
        payload = foldSessionChatMeta(snapshot.events, inherited)
        chatMetaCache.set(session, { at: Date.now(), payload })
        storeChatMetaFold(state, session, payload)
        markDirty()
      }
      sendJson(response, 200, { ok: true, session, models: payload.models, efforts: payload.efforts })
    } catch (error) {
      sendJson(response, 500, { ok: false, error: messageOf(error) })
    }
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler: handleSummary }),
      'dsh-usage-meter: summary route',
    )
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: STATS_PATH, handler: handleStats }),
      'dsh-usage-meter: stats route',
    )
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: TURNS_PATH, handler: handleTurns }),
      'dsh-usage-meter: turns route',
    )
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: CHAT_META_PATH, handler: handleChatMeta }),
      'dsh-usage-meter: chat meta route',
    )
  })
}

/** Test seam: the pure pricing/time/state helpers, unchanged at runtime. */
export const __internals = {
  beijingParts,
  buildSnapshot,
  buildStats,
  computeStreaks,
  costOf,
  createState,
  foldSessionChatMeta,
  foldSessionTotals,
  foldTurnCosts,
  isPeak,
  localDateKey,
  nextPeriodChange,
  normalizePricePair,
  pricingSignature,
  presentChats,
  pruneState,
  readUsage,
  resolveConfig,
  resolvePrice,
  roundCost,
  sanitizeState,
  serializeState,
  startOfLocalDay,
}
