/**
 * Node test for the usage-meter browser half. Loads the real client module in a
 * sandboxed `window.__ModuleLoader__`, mounts it against a fake Cordis client
 * context, and renders the status bar and the statistics page through a small
 * React-like harness (fragments, function components, useState, useEffect with
 * dependency comparison) so copy, structure and interactions are checked
 * without a browser.
 *
 * Run: node tests/client.test.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

let loaded
const sandbox = {
  window: { __ModuleLoader__: { load(spec) { loaded = spec } } },
  document: {
    baseURI: 'http://127.0.0.1:59983/',
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  },
  // The status bar keeps polling timers alive; unref them so this process can exit.
  setTimeout: (callback, delay, ...args) => {
    const timer = setTimeout(callback, delay, ...args)
    timer.unref?.()
    return timer
  },
  clearTimeout,
  Intl,
  console,
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

assert.equal(loaded?.id, '@local/dsh-usage-meter', 'client module id matches the package name')
assert.equal(typeof loaded.factory, 'function')

// ---------------------------------------------------------------------------
// Minimal React-like harness
// ---------------------------------------------------------------------------

const Fragment = Symbol('Fragment')
const hookStore = new Map()
let currentKey = 'root'
let hookIndex = 0
let instanceSeq = 0
let pendingEffects = []

class Element {
  constructor(type, props, children) {
    this.type = type
    this.props = props ?? {}
    this.children = children
  }
}

function hookSlots() {
  let slots = hookStore.get(currentKey)
  if (slots === undefined) {
    slots = []
    hookStore.set(currentKey, slots)
  }
  return slots
}

function sameDeps(left, right) {
  if (left === undefined || right === undefined) return false
  if (left.length !== right.length) return false
  return left.every((value, index) => Object.is(value, right[index]))
}

const React = {
  Fragment,
  createElement(type, props, ...children) {
    return new Element(type, props, children.flat())
  },
  useState(initial) {
    const slots = hookSlots()
    const index = hookIndex
    hookIndex += 1
    if (slots[index] === undefined) {
      slots[index] = { value: typeof initial === 'function' ? initial() : initial }
    }
    const slot = slots[index]
    return [slot.value, (next) => {
      slot.value = typeof next === 'function' ? next(slot.value) : next
    }]
  },
  useEffect(effect, deps) {
    const slots = hookSlots()
    const index = hookIndex
    hookIndex += 1
    const changed = slots[index]?.deps === undefined || !sameDeps(slots[index].deps, deps)
    if (!changed) return
    slots[index] = { deps: deps === undefined ? null : [...deps] }
    pendingEffects.push(effect)
  },
}

function expand(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(expand)
  if (!(node instanceof Element)) return null
  if (node.type === Fragment) return node.children.map(expand)
  if (typeof node.type === 'function') {
    const key = `${node.type.displayName || node.type.name || 'component'}#${instanceSeq}`
    instanceSeq += 1
    const parentKey = currentKey
    const parentIndex = hookIndex
    currentKey = key
    hookIndex = 0
    let rendered
    try {
      rendered = node.type({ ...node.props, children: node.children.length === 1 ? node.children[0] : node.children })
    } finally {
      currentKey = parentKey
      hookIndex = parentIndex
    }
    return expand(rendered)
  }
  return new Element(node.type, node.props, node.children.map(expand))
}

function render(element) {
  instanceSeq = 0
  currentKey = 'root'
  pendingEffects = []
  const tree = expand(element)
  for (const effect of pendingEffects) effect()
  return tree
}

function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (!(node instanceof Element)) return
  visit(node)
  for (const child of node.children) walk(child, visit)
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (node instanceof Element) return node.children.map(textOf).join(' ')
  return ''
}

function findAll(root, predicate) {
  const found = []
  walk(root, (element) => {
    if (predicate(element)) found.push(element)
  })
  return found
}

function findByClass(root, className) {
  const matches = findAll(root, (element) => typeof element.props.className === 'string' && element.props.className.split(' ').includes(className))
  return matches[0] ?? null
}

function translate(dictionary) {
  return (key, params) => {
    const template = dictionary[key] ?? key
    return template.replace(/\{(\w+)\}/g, (_match, name) => (params?.[name] === undefined ? `{${name}}` : String(params[name])))
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Mounting: registrations and dictionaries
// ---------------------------------------------------------------------------

const moduleExports = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})
assert.deepEqual([...moduleExports.inject], ['slots', 'locale', 'layout'])

const localeRegistrations = []
const slotRegistrations = []
const injections = []
let openedStats = 0
let currentPanelId = null
const fakeClientContext = {
  effect(setup) {
    return setup()
  },
  locale: {
    register(ns, dictionaries) {
      localeRegistrations.push({ ns, dictionaries })
      return () => {}
    },
    bind(ns) {
      const entry = localeRegistrations.find((item) => item.ns === ns)
      return translate(entry?.dictionaries.zh ?? {})
    },
  },
  layout: {
    selectPanel(panelId) {
      currentPanelId = panelId
    },
  },
  slots: {
    inject(key, callback) {
      injections.push(key)
      callback()
    },
    register(options, Component) {
      slotRegistrations.push({ options, Component })
      return () => {}
    },
  },
}

moduleExports.apply(fakeClientContext)

assert.deepEqual(injections.sort(), [
  'conversation.chat.assistant-actions',
  'conversation.chat.turnTail',
  'main',
  'shell.bottom',
  'sidebar.panellist',
])
assert.equal(slotRegistrations.length, 5)

const panelRegistration = slotRegistrations.find((entry) => entry.options.name === 'main')
const sidebarRegistration = slotRegistrations.find((entry) => entry.options.name === 'sidebar.panellist')
const barRegistration = slotRegistrations.find((entry) => entry.options.name === 'shell.bottom')
const turnTailRegistration = slotRegistrations.find((entry) => entry.options.name === 'conversation.chat.turnTail')
const assistantActionRegistration = slotRegistrations.find((entry) => entry.options.name === 'conversation.chat.assistant-actions')
assert.equal(turnTailRegistration.options.id, 'dsh-usage-meter-turn')
assert.equal(assistantActionRegistration.options.id, 'dsh-usage-meter-turn')
assert.equal(typeof turnTailRegistration.Component, 'function')
assert.equal(typeof assistantActionRegistration.Component, 'function')
assert.equal(panelRegistration.options.key, 'usage-meter')
assert.equal(sidebarRegistration.options.id, 'usage-meter')
assert.equal(sidebarRegistration.options.order, 30)
assert.equal(sidebarRegistration.options.label(), '用量统计')
assert.equal(typeof barRegistration.Component, 'function')

const localeEntry = localeRegistrations[0]
assert.equal(localeEntry.ns, 'dsh-usage-meter')
assert.deepEqual(Object.keys(localeEntry.dictionaries).sort(), ['en', 'zh'])
const zhKeys = Object.keys(localeEntry.dictionaries.zh).sort()
assert.deepEqual(Object.keys(localeEntry.dictionaries.en).sort(), zhKeys, 'every language covers the same keys')
for (const key of ['panel.title', 'bar.label', 'kpi.totalTokens', 'kpi.totalCost', 'activity.title', 'models.title']) {
  assert.equal(zhKeys.includes(key), true, `dictionary contains ${key}`)
}
const zh = translate(localeEntry.dictionaries.zh)
const en = translate(localeEntry.dictionaries.en)

// ---------------------------------------------------------------------------
// Status bar: only the currently open Session, hidden otherwise
// ---------------------------------------------------------------------------

const summaryPayload = {
  ok: true,
  schema: 2,
  revision: 7,
  generatedAt: Date.now(),
  timezone: 'Asia/Shanghai',
  period: { kind: 'off', nextChangeAt: Date.now() + 3_600_000, windows: ['09:00-12:00', '14:00-18:00'], weekdaysOnly: true, holidayCount: 0 },
  today: { requests: 1, cost: 0.01 },
  total: { requests: 9, cost: 0.5 },
  models: [],
  last: null,
  trackingSince: Date.now() - 3_600_000,
  backfill: { state: 'done', sessions: 2, version: 2 },
  pollMs: 5_000,
  pricing: { currency: 'CNY', unit: '1M tokens', source: 'DeepSeek official pricing', models: {} },
  session: {
    id: 'session-1',
    tracked: true,
    requests: 5,
    cost: 12.34,
    peakCost: 0,
    offCost: 12.34,
    peakRequests: 0,
    offRequests: 5,
    inputTokens: 2_000_000,
    cacheReadTokens: 1_500_000,
    cacheWriteTokens: 0,
    outputTokens: 500_000,
    totalTokens: 4_000_000,
    cacheHitCost: 10.01,
    cacheMissCost: 1.23,
    outputCost: 1.1,
    effectiveRate: 3.075,
    longestTurnMs: 125_000,
    firstTime: Date.now() - 3_000_000,
    lastTime: Date.now() - 60_000,
  },
}

let fetchCount = 0
let fetchDelay = 0
sandbox.fetch = async () => {
  fetchCount += 1
  if (fetchDelay > 0) await sleep(fetchDelay)
  return { ok: true, status: 200, json: async () => summaryPayload }
}

function barProps(overrides = {}) {
  return {
    t: zh,
    useSessions: (selector) => selector({ ids: [], byId: {}, phase: 'ready' }),
    usePanelInfo: (selector) => selector({ activePanelId: null }),
    openStats: () => {
      openedStats += 1
    },
    ...overrides,
  }
}

const barTreeNoSession = render(React.createElement(barRegistration.Component, barProps()))
assert.equal(barTreeNoSession, null, 'no open Session hides the status bar')

const openSessionProps = barProps({
  useSessions: (selector) => selector({ ids: ['session-1'], byId: { 'session-1': { id: 'session-1', retainedBy: { mainView: 1 } } }, phase: 'ready' }),
})
render(React.createElement(barRegistration.Component, openSessionProps))
await sleep(5)
const barTree = render(React.createElement(barRegistration.Component, openSessionProps))
const bar = findByClass(barTree, 'dum-bar')
assert.notEqual(bar, null, 'renders the status bar while the Conversation shows a Session')
const barText = textOf(bar)
assert.equal(barText.includes('本会话'), true)
assert.equal(barText.includes('总花费'), true)
assert.equal(barText.includes('¥12.34'), true, 'session total cost is shown with two decimals')
assert.equal(barText.includes('输入（缓存命中）'), true)
assert.equal(barText.includes('¥10.01'), true, 'cache-hit cost is shown')
assert.equal(barText.includes('输入（缓存未命中）'), true)
assert.equal(barText.includes('¥1.23'), true, 'cache-miss cost is shown')
assert.equal(barText.includes('输出'), true)
assert.equal(barText.includes('¥1.10'), true, 'output cost keeps two decimals')
assert.equal(barText.includes('谷时'), true)
assert.equal(barText.includes('累计'), false, 'the bar never shows global totals')
assert.equal(bar.props.role, 'button')
assert.equal(bar.props.title.includes('本会话用量'), true)
assert.equal(bar.props.title.includes('总花费 ¥12.34'), true)
assert.equal(bar.props.title.includes('点击打开用量统计'), true)
bar.props.onClick()
assert.equal(openedStats, 1, 'clicking the bar opens the statistics page')

// A global panel open (Conversation hidden) also hides the bar.
const panelOpenTree = render(React.createElement(barRegistration.Component, barProps({
  useSessions: openSessionProps.useSessions,
  usePanelInfo: (selector) => selector({ activePanelId: 'usage-meter' }),
})))
assert.equal(panelOpenTree, null)

// English copy.
sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => summaryPayload })
const englishBarTree = render(React.createElement(barRegistration.Component, barProps({
  t: en,
  useSessions: openSessionProps.useSessions,
})))
const englishBar = findByClass(englishBarTree, 'dum-bar')
assert.equal(textOf(englishBar).includes('This session'), true)
assert.equal(textOf(englishBar).includes('Total'), true)
assert.equal(textOf(englishBar).includes('Input (cache hit)'), true)
assert.equal(textOf(englishBar).includes('Off-peak'), true)

// ---------------------------------------------------------------------------
// Statistics page: KPI band, activity heatmap, model rows, refresh
// ---------------------------------------------------------------------------

function buildStatsPayload() {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const days = []
  for (let back = 370; back >= 0; back -= 1) {
    const date = new Date(today)
    date.setDate(date.getDate() - back)
    const active = back < 40
    days.push({
      date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
      tokens: active ? (back + 1) * 10_000 : 0,
      cost: active ? (back + 1) * 0.001 : 0,
      requests: active ? 2 : 0,
    })
  }
  return {
    ok: true,
    schema: 2,
    revision: 12,
    generatedAt: Date.now(),
    timezone: 'Asia/Shanghai',
    period: { kind: 'off', nextChangeAt: Date.now() + 3_600_000, windows: ['09:00-12:00', '14:00-18:00'], weekdaysOnly: true, holidayCount: 0 },
    kpis: {
      totalTokens: 1_260_000_000,
      totalCost: 123.45,
      requests: 9_000,
      peakTokens: 70_263_000,
      peakDay: '2026-09-25',
      longestTurnMs: 7_440_000,
      longestStreakDays: 27,
      currentStreakDays: 4,
      activeDays: 40,
      sessionCount: 44,
      historyFrom: '2025-11-08',
      historyTo: '2026-11-08',
      trackingSince: Date.now() - 86_400_000,
      backfill: { state: 'done', sessions: 44, version: 2 },
    },
    days,
    models: [
      { model: 'deepseek-flash', cost: 120.5, peakCost: 20.5, offCost: 100, requests: 8_900, totalTokens: 1_200_000_000, estimated: false },
      { model: 'deepseek-v4-pro', cost: 2.95, peakCost: 1, offCost: 1.95, requests: 100, totalTokens: 60_000_000, estimated: false },
    ],
    pricing: { currency: 'CNY', unit: '1M tokens', source: 'DeepSeek official pricing', models: {} },
  }
}

const statsPayload = buildStatsPayload()
let statsFetchCount = 0
sandbox.fetch = async (url) => {
  statsFetchCount += 1
  if (String(url).includes('stats')) return { ok: true, status: 200, json: async () => statsPayload }
  return { ok: true, status: 200, json: async () => summaryPayload }
}

const pageComponent = panelRegistration.Component
const firstPageTree = render(React.createElement(pageComponent, { t: zh }))
assert.equal(textOf(firstPageTree).includes('正在读取用量数据…'), true, 'page starts in the loading state')
await sleep(5)
let pageTree = render(React.createElement(pageComponent, { t: zh }))
let pageText = textOf(pageTree)
assert.equal(pageText.includes('用量统计'), true)
assert.equal(pageText.includes('累计 Token 数'), true)
assert.equal(pageText.includes('累计费用'), true)
assert.equal(pageText.includes('¥123.45'), true, 'KPI cost is formatted to two decimals')
assert.equal(pageText.includes('¥120.50'), true, 'model cost is formatted to two decimals')
assert.equal(pageText.includes('Token 使用峰值'), true)
assert.equal(pageText.includes('最长任务用时'), true)
assert.equal(pageText.includes('最长连续天数'), true)
assert.equal(pageText.includes('当前连续天数'), true)
assert.equal(pageText.includes('27 天'), true)
assert.equal(pageText.includes('2 小时 4 分'), true)
assert.equal(pageText.includes('Token 活动'), true)
assert.equal(pageText.includes('按模型'), true)
assert.equal(pageText.includes('deepseek-flash'), true)
assert.equal(pageText.includes('历史回填完成：44 个会话'), true)

const heatCells = findAll(pageTree, (element) => typeof element.props.className === 'string' && element.props.className.includes('dum-heat__cell'))
assert.equal(heatCells.length, 371, 'one heatmap cell per day in the window')
const kpiValues = findAll(pageTree, (element) => element.props.className === 'dum-kpi')
assert.equal(kpiValues.length, 6, 'six KPI cards')
const modelRows = findAll(pageTree, (element) => element.props.className === 'dum-model')
assert.equal(modelRows.length, 2)

// The heatmap owns its styled bubble: no native `title` tooltip may double it.
for (const cell of heatCells.slice(0, 7)) assert.equal(cell.props.title, undefined, 'no native browser tooltip on heat cells')
const styleNode = findAll(pageTree, (element) => element.type === 'style')[0]
assert.equal(styleNode.children[0].includes('--dsw-static-blue-600'), true, 'heat cells use the blue scale')
assert.equal(styleNode.children[0].includes('--dsw-static-neutral-bluish-1000'), true, 'hover bubble is black')

function heatCellsOf(tree) {
  return findAll(tree, (element) => typeof element.props.className === 'string' && element.props.className.includes('dum-heat__cell'))
}

function hoverCell(tree, index) {
  const cells = heatCellsOf(tree)
  cells[index].props.onMouseEnter()
  return cells[index]
}

/**
 * Read the bar charts of weekly / cumulative mode: for every week column the
 * filled cells must be a contiguous stack from the bottom row upward.
 */
function columnBars(tree) {
  const columns = new Map()
  for (const cell of heatCellsOf(tree)) {
    const column = Number(cell.props.style.gridColumn)
    const row = Number(cell.props.style.gridRow) - 1
    const classes = String(cell.props.className).split(' ')
    const filled = classes.includes('dum-heat__bar')
    if (!columns.has(column)) columns.set(column, { rows: [], filledRows: [], uniform: new Set() })
    const entry = columns.get(column)
    entry.rows.push(row)
    if (filled) {
      entry.filledRows.push(row)
      entry.uniform.add('dum-heat__bar')
    } else {
      entry.uniform.add(classes.find((name) => /^dum-heat__l\d$/.test(name)))
    }
  }
  for (const entry of columns.values()) {
    const maxRow = Math.max(...entry.rows)
    entry.height = entry.filledRows.length
    // The last week is partial (it ends today), so a bar is contiguous when it
    // fills every existing row from the column's bottom cell upward.
    entry.suffix = entry.filledRows.length === 0
      || (Math.max(...entry.filledRows) === maxRow
        && Math.min(...entry.filledRows) === maxRow - entry.filledRows.length + 1)
  }
  return [...columns.entries()].sort((left, right) => left[0] - right[0]).map(([, entry]) => entry)
}

/** Number of Monday-first week columns the daily series projects onto. */
function expectedWeeks(days) {
  const [year, month, day] = days[0].date.split('-').map((part) => Number(part))
  const offset = (new Date(year, month - 1, day).getDay() + 6) % 7
  return Math.floor((offset + days.length - 1) / 7) + 1
}

const heatmapWeeks = expectedWeeks(statsPayload.days)

function findFilledCell(tree) {
  return findAll(tree, (element) => typeof element.props.className === 'string' && element.props.className.includes('dum-heat__bar'))[0]
}

const lastIndex = heatCells.length - 1
const dailyTarget = hoverCell(pageTree, lastIndex)
pageTree = render(React.createElement(pageComponent, { t: zh }))
let tip = findByClass(pageTree, 'dum-heat__tip')
assert.notEqual(tip, null, 'renders the styled hover bubble')
assert.equal(tip.props.style.top, (dailyTarget.props.style.gridRow - 1) * 14 - 3, 'bubble sits just above the hovered cell')
assert.equal(textOf(tip).includes('个 Token'), true)
assert.equal(textOf(tip).includes('起的一周'), false, 'daily mode labels one day')

// Manual refresh re-reads the statistics route (the page does not poll).
const refreshButton = findAll(pageTree, (element) => element.type === 'button' && textOf(element).includes('刷新'))[0]
assert.notEqual(refreshButton, undefined, 'page exposes a manual refresh button')
const beforeRefresh = statsFetchCount
refreshButton.props.onClick()
render(React.createElement(pageComponent, { t: zh }))
await sleep(5)
render(React.createElement(pageComponent, { t: zh }))
assert.equal(statsFetchCount, beforeRefresh + 1, 'refresh button re-fetches once')

// Weekly mode is a bar chart made of cells: one bar per week, filled bottom-up.
pageTree = render(React.createElement(pageComponent, { t: zh }))
const weeklyButton = findAll(pageTree, (element) => element.type === 'button' && textOf(element) === '每周')[0]
assert.notEqual(weeklyButton, undefined)
weeklyButton.props.onClick()
pageTree = render(React.createElement(pageComponent, { t: zh }))
assert.equal(heatCellsOf(pageTree).length, 371)
let bars = columnBars(pageTree)
assert.equal(bars.length, heatmapWeeks, 'one column per week')
for (const bar of bars) {
  assert.equal(bar.suffix, true, 'weekly bars are contiguous from the bottom row')
  assert.equal(bar.height <= 7, true)
}
const weeklyHeights = bars.map((bar) => bar.height)
assert.equal(Math.max(...weeklyHeights), 7, 'the busiest week fills the column')
assert.equal(weeklyHeights.some((height) => height > 0 && height < 7), true, 'heights vary with the week value')
assert.equal(textOf(pageTree).includes('柱高表示该周用量'), true)
const filledWeeklyCell = findFilledCell(pageTree)
assert.equal(filledWeeklyCell.props.title, undefined, 'no native title on bar cells')
filledWeeklyCell.props.onMouseEnter()
pageTree = render(React.createElement(pageComponent, { t: zh }))
tip = findByClass(pageTree, 'dum-heat__tip')
assert.equal(textOf(tip).includes('起的一周'), true)
assert.equal(textOf(tip).includes('个 Token'), true)

// A week with no usage still answers the hover with an explicit zero.
const emptyWeekCell = findAll(pageTree, (element) => typeof element.props.className === 'string'
  && element.props.className.split(' ').includes('dum-heat__l0'))[0]
assert.notEqual(emptyWeekCell, undefined, 'empty weeks still render their cells')
assert.equal(Number(emptyWeekCell.props.style.gridColumn) <= 10, true, 'the oldest columns have no usage in this payload')
emptyWeekCell.props.onMouseEnter()
pageTree = render(React.createElement(pageComponent, { t: zh }))
tip = findByClass(pageTree, 'dum-heat__tip')
assert.notEqual(tip, null, 'empty weeks keep the styled bubble')
assert.equal(textOf(tip).includes('起的一周'), true)
assert.equal(textOf(tip).includes('0 个 Token'), true, 'a week without usage reports zero instead of staying silent')

// Cumulative mode is the same bars over running totals: never shrinking.
pageTree = render(React.createElement(pageComponent, { t: zh }))
const cumulativeButton = findAll(pageTree, (element) => element.type === 'button' && textOf(element) === '累计总量')[0]
assert.notEqual(cumulativeButton, undefined)
cumulativeButton.props.onClick()
pageTree = render(React.createElement(pageComponent, { t: zh }))
bars = columnBars(pageTree)
for (const bar of bars) assert.equal(bar.suffix, true, 'cumulative bars are contiguous from the bottom row')
let monotonic = true
// The first and last weeks are partial columns, so compare complete weeks only.
const fullBars = bars.filter((bar) => bar.rows.length === 7)
for (let index = 1; index < fullBars.length; index += 1) {
  if (fullBars[index].height < fullBars[index - 1].height) monotonic = false
}
assert.equal(monotonic, true, 'cumulative bars never shrink')
const lastBar = bars[bars.length - 1]
assert.equal(lastBar.filledRows.length, lastBar.rows.length, 'the final cumulative value fills every existing cell')
assert.equal(textOf(pageTree).includes('柱高表示截至该周的累计用量'), true)
const filledCumulativeCell = findFilledCell(pageTree)
filledCumulativeCell.props.onMouseEnter()
pageTree = render(React.createElement(pageComponent, { t: zh }))
tip = findByClass(pageTree, 'dum-heat__tip')
assert.equal(textOf(tip).includes('累计至'), true)
assert.equal(textOf(tip).includes('起的一周'), true)

// English page copy.
const englishPageTree = render(React.createElement(pageComponent, { t: en }))
await sleep(5)
const englishPageText = textOf(render(React.createElement(pageComponent, { t: en })))
assert.equal(englishPageText.includes('Total tokens'), true)
assert.equal(englishPageText.includes('Peak token day'), true)
assert.equal(englishPageText.includes('By model'), true)
assert.equal(englishPageText.includes('Token activity'), true)
assert.equal(englishPageTree !== undefined, true)

// An unreachable Host degrades to an error state with retry.
hookStore.clear()
sandbox.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) })
const failedPageTree = render(React.createElement(pageComponent, { t: zh }))
await sleep(5)
const failedText = textOf(render(React.createElement(pageComponent, { t: zh })))
assert.equal(failedText.includes('读取失败'), true)
assert.equal(failedPageTree !== undefined, true)

console.log('client module: all assertions passed')
