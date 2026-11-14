/**
 * DSH usage meter — browser half.
 *
 * Two surfaces over the Host's usage routes:
 * - the root-scoped `shell.bottom` status bar, which shows the Session currently
 *   open in the Conversation (cost, input / cache-hit / output tokens, total,
 *   peak / off-peak badge) and opens the statistics page on click;
 * - the global "用量统计" page registered as a sidebar panel, following the
 *   Codex usage dashboard's layout: a KPI band, a Token-activity heatmap with
 *   daily / weekly / cumulative and Token / cost switches, and a per-model
 *   breakdown.
 *
 * All copy goes through the Client locale service, and every style is either a
 * `--dsw-*` theme token or a derived color-mix of one.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-usage-meter',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'dsh-usage-meter'
    /** The `main` keyed slot id, and therefore the sidebar panel id. */
    const PANEL_ID = 'usage-meter'
    /** Host routes, resolved against the page base so reverse-proxy prefixes survive. */
    const SUMMARY_ROUTE = 'dsh-usage-meter/summary'
    const STATS_ROUTE = 'dsh-usage-meter/stats'
    const TURNS_ROUTE = 'dsh-usage-meter/turns'

    const DEFAULT_POLL_MS = 5_000
    const ERROR_POLL_MS = 15_000
    const HEATMAP_DAYS = 371
    const CELL = 11
    const GAP = 3
    const STEP = CELL + GAP

    const DICTIONARIES = {
      zh: {
        'panel.title': '用量统计',
        'units.tokens': '{value} 个 Token',
        'units.calls': '{count} 次调用',
        'period.peak': '峰时',
        'period.off': '谷时',
        'status.loading': '读取中…',
        'status.unavailable': '数据不可用',
        'status.error': '读取失败：{error}',

        'bar.label': '本会话',
        'bar.totalCost': '总花费',
        'bar.hitCost': '输入（缓存命中）',
        'bar.missCost': '输入（缓存未命中）',
        'bar.outputCost': '输出',
        'bar.tipTitle': '本会话用量',
        'bar.tipCosts': '总花费 {total}\n输入·缓存命中 {hit} · 输入·未命中 {miss} · 输出 {output}',
        'bar.tipBreakdown': 'Token：输入 {input} · 缓存命中 {hit} · 输出 {output} · 共 {total}',
        'bar.tipCalls': '模型调用 {count} 次 · 最长单轮 {duration}',
        'bar.tipPeriod': '当前{period}，下次切换 {next}（北京时间）',
        'bar.tipHint': '点击打开用量统计',

        'page.title': '用量统计',
        'page.intro': 'DeepSeek Token 用量与费用，按峰时 / 谷时价格计费',
        'page.refresh': '刷新',
        'page.refreshing': '刷新中…',
        'page.updated': '更新于 {time}',
        'page.loading': '正在读取用量数据…',
        'page.retry': '重试',
        'page.trackedSince': '统计自 {time}',
        'page.auxCalls': '含辅助模型调用 {count} 次（{cost}）',

        'kpi.totalTokens': '累计 Token 数',
        'kpi.totalCost': '累计费用',
        'kpi.peak': 'Token 使用峰值',
        'kpi.longestTask': '最长任务用时',
        'kpi.longestStreak': '最长连续天数',
        'kpi.currentStreak': '当前连续天数',
        'kpi.peakDate': '峰值日期：{date}',
        'kpi.streakDays': '{days} 天',
        'duration.hm': '{hours} 小时 {minutes} 分',
        'duration.m': '{minutes} 分',
        'duration.s': '{seconds} 秒',

        'activity.title': 'Token 活动',
        'activity.mode.daily': '每天',
        'activity.mode.weekly': '每周',
        'activity.mode.cumulative': '累计总量',
        'activity.metric.token': 'Token',
        'activity.metric.cost': '费用',
        'activity.less': '少',
        'activity.more': '多',
        'activity.tipDaily': '{date}\n{value}',
        'activity.tipWeekly': '{date} 起的一周\n{value}',
        'activity.tipCumulative': '累计至 {date} 起的一周\n{value}',
        'activity.barHintWeekly': '柱高表示该周用量',
        'activity.barHintCumulative': '柱高表示截至该周的累计用量',
        'activity.empty': '还没有可展示的用量',

        'models.title': '按模型',
        'models.tokens': '{tokens} Token',
        'models.requests': '{count} 次调用',
        'models.estimated': '估算',
        'models.empty': '暂无模型数据',

        'backfill.done': '历史回填完成：{sessions} 个会话',
        'backfill.partial': '历史回填部分完成：{sessions} 个会话（已截断）',
        'backfill.running': '历史回填中…',
        'backfill.skipped': '历史回填已跳过',
        'backfill.pending': '历史回填待开始',
      },
      en: {
        'panel.title': 'Usage',
        'units.tokens': '{value} tokens',
        'units.calls': '{count} calls',
        'period.peak': 'Peak',
        'period.off': 'Off-peak',
        'status.loading': 'Loading…',
        'status.unavailable': 'Unavailable',
        'status.error': 'Read failed: {error}',

        'bar.label': 'This session',
        'bar.totalCost': 'Total',
        'bar.hitCost': 'Input (cache hit)',
        'bar.missCost': 'Input (cache miss)',
        'bar.outputCost': 'Output',
        'bar.tipTitle': 'This session',
        'bar.tipCosts': 'Total {total}\nInput hit {hit} · input miss {miss} · output {output}',
        'bar.tipBreakdown': 'Tokens: input {input} · cache hit {hit} · output {output} · {total} total',
        'bar.tipCalls': '{count} model calls · longest turn {duration}',
        'bar.tipPeriod': 'Now {period}; next switch {next} (Beijing time)',
        'bar.tipHint': 'Click to open usage statistics',

        'page.title': 'Usage',
        'page.intro': 'DeepSeek token usage and cost, priced with peak and off-peak rates',
        'page.refresh': 'Refresh',
        'page.refreshing': 'Refreshing…',
        'page.updated': 'Updated {time}',
        'page.loading': 'Reading usage data…',
        'page.retry': 'Retry',
        'page.trackedSince': 'Tracked since {time}',
        'page.auxCalls': 'Includes {count} auxiliary model calls ({cost})',

        'kpi.totalTokens': 'Total tokens',
        'kpi.totalCost': 'Total cost',
        'kpi.peak': 'Peak token day',
        'kpi.longestTask': 'Longest task',
        'kpi.longestStreak': 'Longest streak',
        'kpi.currentStreak': 'Current streak',
        'kpi.peakDate': 'Peak day: {date}',
        'kpi.streakDays': '{days} days',
        'duration.hm': '{hours}h {minutes}m',
        'duration.m': '{minutes}m',
        'duration.s': '{seconds}s',

        'activity.title': 'Token activity',
        'activity.mode.daily': 'Daily',
        'activity.mode.weekly': 'Weekly',
        'activity.mode.cumulative': 'Cumulative',
        'activity.metric.token': 'Tokens',
        'activity.metric.cost': 'Cost',
        'activity.less': 'Less',
        'activity.more': 'More',
        'activity.tipDaily': '{date}\n{value}',
        'activity.tipWeekly': 'Week of {date}\n{value}',
        'activity.tipCumulative': 'Cumulative through {date}\n{value}',
        'activity.barHintWeekly': 'Bar height = that week’s usage',
        'activity.barHintCumulative': 'Bar height = cumulative usage through that week',
        'activity.empty': 'No usage to show yet',

        'models.title': 'By model',
        'models.tokens': '{tokens} tokens',
        'models.requests': '{count} calls',
        'models.estimated': 'est.',
        'models.empty': 'No model data yet',

        'backfill.done': 'History backfill complete: {sessions} sessions',
        'backfill.partial': 'History backfill partially complete: {sessions} sessions (truncated)',
        'backfill.running': 'Backfilling history…',
        'backfill.skipped': 'History backfill skipped',
        'backfill.pending': 'History backfill pending',
      },
    }

    const STYLES = [
      // -- status bar ------------------------------------------------------
      '.dum-bar{display:flex;align-items:center;gap:8px;height:26px;padding:0 12px;box-sizing:border-box;',
      'border-top:1px solid var(--dsw-alias-border-l1,#e5e5e5);background:var(--dsw-alias-bg-base,transparent);',
      'color:var(--dsw-alias-label-tertiary,#8a8a8a);font-family:inherit;',
      'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
      'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));',
      'font-variant-numeric:tabular-nums;white-space:nowrap;user-select:none;overflow:hidden;cursor:pointer}',
      '.dum-bar:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.03))}',
      '.dum-bar:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:-2px}',
      '.dum-bar__label{color:var(--dsw-alias-label-secondary,#5c5c5c);font-weight:600}',
      '.dum-bar__grow{flex:1 1 auto}',
      '.dum-bar__item{display:inline-flex;align-items:center;gap:4px}',
      '.dum-bar__muted{color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      '.dum-bar__value{color:var(--dsw-alias-label-primary,#1a1a1a);font-weight:600}',
      '.dum-bar__sep{color:var(--dsw-alias-separator-primary,var(--dsw-alias-border-l1,#ddd))}',
      '.dum-bar__period{display:inline-flex;align-items:center;gap:5px}',
      '.dum-bar__dot{width:6px;height:6px;border-radius:50%;background:currentColor}',
      '.dum-bar__peak{color:var(--dsw-static-amber-500,#b45309)}',
      '.dum-bar__off{color:var(--dsw-static-green-500,#15803d)}',
      '@media (max-width:860px){.dum-bar__optional{display:none}}',

      // -- page shell ------------------------------------------------------
      '.dum-page{--dum-inset:clamp(24px,4vw,48px);box-sizing:border-box;height:100%;padding:0 var(--dum-inset);',
      'display:flex;flex-direction:column;align-items:center;color:var(--dsw-alias-label-primary,#1a1a1a)}',
      '@media (max-width:767px){.dum-page{--dum-inset:20px}}',
      '.dum-page__head{box-sizing:border-box;width:100%;max-width:960px;padding-top:28px;display:flex;',
      'justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}',
      '[data-platform=darwin] .dum-page__head{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}',
      '.dum-page__title{margin:0;font-size:20px;font-weight:500;line-height:28px}',
      '.dum-page__intro{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#5c5c5c)}',
      '.dum-page__tools{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}',
      '.dum-page__updated{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-variant-numeric:tabular-nums}',
      '.dum-page__body{box-sizing:border-box;width:calc(100% + 2 * var(--dum-inset));margin-inline:calc(-1 * var(--dum-inset));',
      'padding:24px var(--dum-inset) 48px;flex:1;min-height:0;overflow:hidden auto;display:flex;flex-direction:column;',
      'align-items:center;gap:20px}',
      '.dum-page__body>*{flex:none;width:100%;max-width:960px}',
      '.dum-page__state{padding:64px 0;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary,#5c5c5c)}',
      '.dum-page__note{margin:0;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary,#8a8a8a);',
      'display:flex;gap:8px;flex-wrap:wrap;align-items:center}',

      // -- generic card ----------------------------------------------------
      '.dum-card{box-sizing:border-box;background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1,#fff));',
      'border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4,#00000029));',
      'border-radius:var(--dsw-radius-xl,16px)}',
      '.dum-card__head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:14px 18px 0}',
      '.dum-card__title{margin:0;font-size:15px;font-weight:600;line-height:24px}',
      '.dum-card__controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',

      // -- KPI band --------------------------------------------------------
      '.dum-kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:1px;',
      'background:var(--dsw-alias-border-l2,#0000001a);overflow:hidden}',
      '@media (max-width:1100px){.dum-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}',
      '@media (max-width:640px){.dum-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}',
      '.dum-kpi{background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1,#fff));padding:16px 18px;min-width:0}',
      '.dum-kpi__value{font-size:20px;font-weight:600;line-height:28px;color:var(--dsw-alias-label-primary,#1a1a1a);',
      'font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dum-kpi__label{margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#5c5c5c);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

      // -- activity heatmap ------------------------------------------------
      '.dum-activity{padding-bottom:14px}',
      '.dum-heat{position:relative;padding:14px 18px 0}',
      '.dum-heat__canvas{position:relative;width:max-content}',
      '.dum-heat__grid{display:grid;gap:3px}',
      '.dum-heat__cell{border-radius:2px;width:11px;height:11px}',
      '.dum-heat__l0{background:var(--dsw-static-neutral-bluish-100,#ebeef2)}',
      '.dum-heat__l1{background:var(--dsw-static-blue-100,#dbeafe)}',
      '.dum-heat__l2{background:var(--dsw-static-blue-300,#93c5fd)}',
      '.dum-heat__l3{background:var(--dsw-static-blue-450,#4d93f8)}',
      '.dum-heat__l4{background:var(--dsw-static-blue-600,#2563eb)}',
      '.dum-heat__bar{background:var(--dsw-static-blue-500,#3b82f6)}',
      '[data-ds-dark-theme] .dum-heat__l0{background:var(--dsw-static-neutral-bluish-850,#2c2c2e)}',
      '[data-ds-dark-theme] .dum-heat__l1{background:var(--dsw-static-blue-950,#172554)}',
      '[data-ds-dark-theme] .dum-heat__l2{background:#1e40af}',
      '[data-ds-dark-theme] .dum-heat__l3{background:#2563eb}',
      '[data-ds-dark-theme] .dum-heat__l4{background:#3b82f6}',
      '[data-ds-dark-theme] .dum-heat__bar{background:var(--dsw-static-blue-500,#3b82f6)}',
      '.dum-heat__months{display:grid;gap:3px;margin-top:6px;height:16px;font-size:11px;',
      'color:var(--dsw-alias-label-tertiary,#8a8a8a);white-space:nowrap}',
      '.dum-heat__months>span{grid-row:1;overflow:visible}',
      '.dum-heat__legend{display:flex;align-items:center;justify-content:flex-end;gap:5px;margin-top:8px;',
      'font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      '.dum-heat__swatch{width:11px;height:11px;border-radius:2px}',
      '.dum-heat__tip{position:absolute;z-index:2;transform:translate(-50%,-100%);pointer-events:none;',
      'background:var(--dsw-static-neutral-bluish-1000,#0f1115);color:#fff;',
      'border-radius:8px;padding:6px 10px;font-size:12px;line-height:17px;white-space:pre;',
      'box-shadow:0 4px 14px rgba(0,0,0,.18)}',

      // -- segmented controls ---------------------------------------------
      '.dum-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:7px;',
      'background:var(--dsw-alias-bg-layer-2,#f2f2f2)}',
      '.dum-seg__item{border:none;background:transparent;color:var(--dsw-alias-label-secondary,#5c5c5c);',
      'font-family:inherit;font-size:12px;line-height:18px;padding:2px 9px;border-radius:5px;cursor:pointer}',
      '.dum-seg__item:hover{color:var(--dsw-alias-label-primary,#1a1a1a)}',
      '.dum-seg__item.is-active{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);',
      'box-shadow:0 0 0 1px var(--dsw-alias-border-l2,#e6e6e6)}',
      '.dum-refresh{border:1px solid var(--dsw-alias-border-l2,#e6e6e6);background:transparent;',
      'color:var(--dsw-alias-label-secondary,#5c5c5c);font-family:inherit;font-size:12px;line-height:20px;',
      'padding:2px 10px;border-radius:6px;cursor:pointer}',
      '.dum-refresh:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));',
      'color:var(--dsw-alias-label-primary,#1a1a1a)}',
      '.dum-refresh:disabled{cursor:default;opacity:.6}',

      // -- per-model rows --------------------------------------------------
      '.dum-models{display:flex;flex-direction:column;padding:6px 18px 14px}',
      '.dum-model{display:flex;align-items:center;gap:12px;padding:8px 0;',
      'border-top:1px solid var(--dsw-alias-border-l1,#ececec);font-size:13px;min-width:0}',
      '.dum-model:first-child{border-top:none}',
      '.dum-model__name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;',
      'display:inline-flex;align-items:center;gap:6px}',
      '.dum-model__est{font-size:10px;line-height:16px;padding:0 5px;border-radius:4px;',
      'background:var(--dsw-alias-bg-layer-2,#f2f2f2);color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      '.dum-model__meta{flex:none;color:var(--dsw-alias-label-secondary,#5c5c5c);font-variant-numeric:tabular-nums}',
      '.dum-model__cost{flex:none;min-width:76px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums}',
      '.dum-models__empty{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a);padding:8px 0 2px}',
      '@media (max-width:640px){.dum-model__meta{display:none}}',
      '.dum-turn-cost{display:flex;justify-content:flex-end;padding:0 2px;',
      'color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:12px;line-height:18px;',
      'font-variant-numeric:tabular-nums;user-select:none}',
      '.dum-turn-chip{display:inline-flex;align-items:center;height:20px;padding:0 6px;',
      'border-radius:6px;color:var(--dsw-alias-label-secondary,#5c5c5c);',
      'background:color-mix(in srgb,var(--dsw-alias-label-secondary,#5c5c5c) 8%,transparent);',
      'font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;user-select:none}',
    ].join('')

    // -----------------------------------------------------------------------
    // Formatting helpers
    // -----------------------------------------------------------------------

    function numberOrZero(value) {
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
    }

    /** Route resolved against the page base (keeps a reverse-proxy prefix). */
    function endpointPath(route, query) {
      const suffix = query === undefined ? '' : `?${query}`
      if (typeof document === 'undefined') return `/${route}${suffix}`
      try {
        return new URL(route, document.baseURI).pathname + suffix
      } catch {
        return `/${route}${suffix}`
      }
    }

    async function fetchJson(path) {
      const response = await fetch(path, { cache: 'no-store', headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      if (data === null || typeof data !== 'object' || data.ok !== true) throw new Error('unexpected payload')
      return data
    }

    /** Locale-aware compact number: 亿/万 in Chinese, B/M in English. */
    function formatCompact(value) {
      const number = numberOrZero(value)
      try {
        return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(number)
      } catch {
        return String(Math.round(number))
      }
    }

    /** CNY reading: money is kept to two decimal places (cents) everywhere. */
    function formatCny(value) {
      const number = numberOrZero(value)
      try {
        return `¥${new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number)}`
      } catch {
        return `¥${number.toFixed(2)}`
      }
    }

    /** Beijing wall-clock `HH:MM` of one instant. */
    function formatBeijingClock(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      const date = new Date(ms + 8 * 3_600_000)
      return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
    }

    function formatDateTime(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      try {
        return new Date(ms).toLocaleString()
      } catch {
        return new Date(ms).toISOString()
      }
    }

    /** Localized `9月25日` / `Sep 25` from a `YYYY-MM-DD` server key. */
    function formatDayKey(dateKey) {
      const [year, month, day] = String(dateKey).split('-').map((part) => Number(part))
      try {
        return new Date(year, month - 1, day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      } catch {
        return String(dateKey)
      }
    }

    /** Localized `2026年7月27日` / `July 27, 2026` week label. */
    function formatFullDate(date) {
      try {
        return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
      } catch {
        return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
      }
    }

    function formatMonth(date) {
      try {
        return date.toLocaleDateString(undefined, { month: 'short' })
      } catch {
        return `${date.getMonth() + 1}`
      }
    }

    function formatDuration(ms, t) {
      const totalSeconds = Math.max(0, Math.round(numberOrZero(ms) / 1000))
      const hours = Math.floor(totalSeconds / 3600)
      const minutes = Math.floor((totalSeconds % 3600) / 60)
      const seconds = totalSeconds % 60
      if (hours > 0) return t('duration.hm', { hours, minutes })
      if (minutes > 0) return t('duration.m', { minutes })
      return t('duration.s', { seconds })
    }

    function periodLabel(t, kind) {
      return t(kind === 'peak' ? 'period.peak' : 'period.off')
    }

    function backfillNote(t, backfill) {
      const state = backfill?.state
      if (state === 'running') return t('backfill.running')
      if (state === 'partial') return t('backfill.partial', { sessions: backfill?.sessions ?? 0 })
      if (state === 'done') return t('backfill.done', { sessions: backfill?.sessions ?? 0 })
      if (state === 'skipped') return t('backfill.skipped')
      return t('backfill.pending')
    }

    // -----------------------------------------------------------------------
    // Data hooks
    // -----------------------------------------------------------------------

    /** Poll the status-bar route for one Session; idle while no Session is open. */
    function useSessionSummary(sessionId) {
      const [snapshot, setSnapshot] = React.useState({ status: 'loading', data: null, error: null })
      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined
        let disposed = false
        let timer = null
        setSnapshot({ status: 'loading', data: null, error: null })
        const load = async () => {
          try {
            const data = await fetchJson(endpointPath(SUMMARY_ROUTE, `session=${encodeURIComponent(sessionId)}`))
            if (disposed) return
            setSnapshot({ status: 'live', data, error: null })
            schedule(numberOrZero(data.pollMs) > 0 ? data.pollMs : DEFAULT_POLL_MS)
          } catch (error) {
            if (disposed) return
            setSnapshot((previous) => ({
              status: previous.data === null ? 'failed' : 'live',
              data: previous.data,
              error: String(error?.message ?? error),
            }))
            schedule(ERROR_POLL_MS)
          }
        }
        function schedule(delay) {
          if (disposed) return
          if (timer !== null) clearTimeout(timer)
          timer = setTimeout(() => {
            void load()
          }, delay)
        }
        const onVisibility = () => {
          if (typeof document === 'undefined' || document.visibilityState !== 'visible') return
          if (timer !== null) clearTimeout(timer)
          void load()
        }
        document.addEventListener('visibilitychange', onVisibility)
        void load()
        return () => {
          disposed = true
          if (timer !== null) clearTimeout(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [sessionId])
      return snapshot
    }

    /** Load the statistics page payload once; the page refreshes on demand. */
    function useStatsData() {      const [state, setState] = React.useState({ status: 'loading', data: null, error: null, fetching: false })
      const [tick, setTick] = React.useState(0)
      React.useEffect(() => {
        let disposed = false
        setState((previous) => (previous.data === null
          ? { status: 'loading', data: null, error: null, fetching: true }
          : { ...previous, fetching: true }))
        void (async () => {
          try {
            const data = await fetchJson(endpointPath(STATS_ROUTE))
            if (disposed) return
            setState({ status: 'live', data, error: null, fetching: false })
          } catch (error) {
            if (disposed) return
            setState((previous) => ({
              status: previous.data === null ? 'failed' : 'live',
              data: previous.data,
              error: String(error?.message ?? error),
              fetching: false,
            }))
          }
        })()
        return () => {
          disposed = true
        }
      }, [tick])
      const refresh = () => setTick((value) => value + 1)
      return [state, refresh]
    }

    // -----------------------------------------------------------------------
    // Per-Turn cost
    // -----------------------------------------------------------------------

    /** Short-lived per-Session cache; every turn footer mount revalidates it. */
    const turnDataCache = new Map()

    async function loadTurnData(sessionId) {
      const cached = turnDataCache.get(sessionId)
      if (cached !== undefined && Date.now() - cached.at < 1_500) return cached.data
      const data = await fetchJson(endpointPath(TURNS_ROUTE, `session=${encodeURIComponent(sessionId)}`))
      turnDataCache.set(sessionId, { at: Date.now(), data })
      return data
    }

    /** Folded Turn costs for the Session in the current Chat view. */
    function useTurnData(sessionId) {
      const [data, setData] = React.useState(() => {
        const cached = typeof sessionId === 'string' ? turnDataCache.get(sessionId) : undefined
        return cached === undefined ? null : cached.data
      })
      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined
        let disposed = false
        void (async () => {
          try {
            const next = await loadTurnData(sessionId)
            if (!disposed) setData(next)
          } catch {
            // A missing log only hides the per-Turn reading.
          }
        })()
        return () => {
          disposed = true
        }
      }, [sessionId])
      return data
    }

    function turnCostOf(data, turn) {
      if (data === null || typeof data !== 'object' || !Array.isArray(data.turns)) return null
      for (const entry of data.turns) {
        if (entry !== null && typeof entry === 'object' && entry.turn === turn) {
          return numberOrZero(entry.cost)
        }
      }
      return null
    }

    function messageTurnOf(data, messageId) {
      if (data === null || typeof data !== 'object' || data.messages === null || typeof data.messages !== 'object') return undefined
      const turn = data.messages[messageId]
      return typeof turn === 'number' && Number.isFinite(turn) ? turn : undefined
    }

    // -----------------------------------------------------------------------
    // Heatmap
    // -----------------------------------------------------------------------

    function parseDayKey(dateKey) {
      const [year, month, day] = String(dateKey).split('-').map((part) => Number(part))
      return new Date(year, month - 1, day)
    }

    function heatLevel(value, max) {
      if (!(value > 0) || !(max > 0)) return 0
      const ratio = value / max
      if (ratio <= 0.25) return 1
      if (ratio <= 0.5) return 2
      if (ratio <= 0.75) return 3
      return 4
    }

    /** Project the server's daily series onto a Monday-first 53-week grid. */
    function buildHeatmap(days, mode, metric) {
      const entries = (Array.isArray(days) ? days : []).map((day) => ({
        date: String(day.date),
        dateObj: parseDayKey(day.date),
        tokens: numberOrZero(day.tokens),
        cost: numberOrZero(day.cost),
        requests: numberOrZero(day.requests),
        base: metric === 'cost' ? numberOrZero(day.cost) : numberOrZero(day.tokens),
      }))
      if (entries.length === 0) {
        return { weeks: 0, cells: [], months: [], values: new Map(), max: 0, weekStarts: [] }
      }
      const offset = (entries[0].dateObj.getDay() + 6) % 7
      const cells = entries.map((entry, index) => ({
        entry,
        index,
        week: Math.floor((offset + index) / 7),
        row: (offset + index) % 7,
      }))
      const weeks = cells[cells.length - 1].week + 1
      const weekStarts = []
      for (let week = 0; week < weeks; week += 1) {
        const first = cells.find((cell) => cell.week === week)
        const monday = new Date(first.entry.dateObj)
        monday.setDate(monday.getDate() - first.row)
        weekStarts.push(monday)
      }
      const weekTotals = new Map()
      for (const cell of cells) weekTotals.set(cell.week, (weekTotals.get(cell.week) ?? 0) + cell.entry.base)
      const values = new Map()
      let max = 0
      let bars = null
      if (mode === 'weekly') {
        // Codex's weekly view is a bar chart drawn with heat cells: each week
        // column is a bar whose height encodes that week's total.
        max = 0
        for (const total of weekTotals.values()) if (total > max) max = total
        bars = new Map()
        for (let week = 0; week < weeks; week += 1) {
          const value = weekTotals.get(week) ?? 0
          bars.set(week, { value, height: barHeight(value, max) })
        }
        for (const cell of cells) values.set(cell.index, weekTotals.get(cell.week) ?? 0)
      } else if (mode === 'cumulative') {
        // The cumulative view is the same bar chart over running totals.
        const cumulativeByWeek = new Map()
        let running = 0
        for (let week = 0; week < weeks; week += 1) {
          running += weekTotals.get(week) ?? 0
          cumulativeByWeek.set(week, running)
        }
        max = running
        bars = new Map()
        for (let week = 0; week < weeks; week += 1) {
          const value = cumulativeByWeek.get(week) ?? 0
          bars.set(week, { value, height: barHeight(value, max) })
        }
        for (const cell of cells) values.set(cell.index, cumulativeByWeek.get(cell.week) ?? 0)
      } else {
        for (const cell of cells) values.set(cell.index, cell.entry.base)
        for (const value of values.values()) if (value > max) max = value
      }
      const months = []
      let previousMonth = null
      for (let week = 0; week < weeks; week += 1) {
        const monday = weekStarts[week]
        const month = `${monday.getFullYear()}-${monday.getMonth()}`
        if (month !== previousMonth) {
          months.push({ week, label: formatMonth(monday) })
          previousMonth = month
        }
      }
      return { weeks, cells, months, values, max, weekStarts, bars, barMode: mode !== 'daily' }
    }

    /** Bar height in cells (0–7) for a weekly or cumulative value. */
    function barHeight(value, max) {
      if (!(value > 0) || !(max > 0)) return 0
      return Math.min(7, Math.max(1, Math.ceil((value / max) * 7)))
    }

    function heatmapTooltip(t, cell, heatmap, mode, metric) {
      const value = heatmap.values.get(cell.index) ?? 0
      const valueText = metric === 'cost' ? formatCny(value) : t('units.tokens', { value: formatCompact(value) })
      if (mode === 'weekly' || mode === 'cumulative') {
        const date = formatFullDate(heatmap.weekStarts[cell.week])
        return t(mode === 'weekly' ? 'activity.tipWeekly' : 'activity.tipCumulative', { date, value: valueText })
      }
      return t('activity.tipDaily', { date: formatDayKey(cell.entry.date), value: valueText })
    }

    // -----------------------------------------------------------------------
    // Small controls
    // -----------------------------------------------------------------------

    function Segmented({ options, value, onChange }) {
      return h(
        'div',
        { className: 'dum-seg', role: 'tablist' },
        options.map((option) => h(
          'button',
          {
            key: option.id,
            type: 'button',
            role: 'tab',
            'aria-selected': option.id === value,
            className: `dum-seg__item${option.id === value ? ' is-active' : ''}`,
            onClick: () => onChange(option.id),
          },
          option.label,
        )),
      )
    }

    // -----------------------------------------------------------------------
    // Status bar
    // -----------------------------------------------------------------------

    /** The Session currently displayed by the Conversation view. */
    function currentSessionId(useSessions) {
      return useSessions((snapshot) => {
        const byId = snapshot?.byId
        if (byId === undefined || byId === null) return undefined
        for (const session of Object.values(byId)) {
          if (session !== null && typeof session === 'object' && (session.retainedBy?.mainView ?? 0) > 0) return session.id
        }
        return undefined
      })
    }

    function buildBarTooltip(t, summary, session) {
      if (session === null) {
        if (summary.status === 'failed') return `${t('bar.tipTitle')}\n${t('status.error', { error: summary.error })}`
        return `${t('bar.tipTitle')}\n${t('status.loading')}`
      }
      const lines = [t('bar.tipTitle')]
      lines.push(t('bar.tipCosts', {
        total: formatCny(session.cost),
        hit: formatCny(session.cacheHitCost),
        miss: formatCny(session.cacheMissCost),
        output: formatCny(session.outputCost),
      }))
      lines.push(t('bar.tipBreakdown', {
        input: formatCompact(session.inputTokens),
        hit: formatCompact(session.cacheReadTokens),
        output: formatCompact(session.outputTokens),
        total: formatCompact(session.totalTokens),
      }))
      if (session.requests > 0) {
        lines.push(t('bar.tipCalls', {
          count: session.requests,
          duration: formatDuration(session.longestTurnMs, t),
        }))
      }
      const period = summary.data?.period
      if (period !== undefined) {
        lines.push(t('bar.tipPeriod', {
          period: periodLabel(t, period.kind),
          next: formatBeijingClock(period.nextChangeAt),
        }))
      }
      lines.push(t('bar.tipHint'))
      return lines.join('\n')
    }

    /** Bare `¥x.xx` for one completed Turn, registered in `conversation.chat.turnTail`. */
    function TurnCostTail(props) {
      const data = useTurnData(props.sessionId)
      const turn = props.turn !== null && typeof props.turn === 'object' ? props.turn.turn : undefined
      const cost = typeof turn === 'number' ? turnCostOf(data, turn) : null
      if (cost === null) return null
      return h('div', { className: 'dum-turn-cost', 'data-dsh-usage-meter-turn': String(turn) }, formatCny(cost))
    }

    /** The same reading as a compact chip in the Turn footer's action row. */
    function TurnCostAction(props) {
      const data = useTurnData(props.sessionId)
      const turn = messageTurnOf(data, props.messageId)
      const cost = turn === undefined ? null : turnCostOf(data, turn)
      if (cost === null) return null
      return h('span', { className: 'dum-turn-chip', 'data-dsh-usage-meter-turn-chip': String(turn) }, formatCny(cost))
    }

    function UsageStatusBar(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const useSessions = props.useSessions
      const usePanelInfo = props.usePanelInfo
      const sessionId = typeof useSessions === 'function' ? currentSessionId(useSessions) : undefined
      const activePanelId = typeof usePanelInfo === 'function' ? usePanelInfo((info) => info?.activePanelId ?? null) : null
      const visible = typeof sessionId === 'string' && sessionId !== '' && activePanelId === null
      const summary = useSessionSummary(visible ? sessionId : undefined)
      if (!visible) return null

      const session = summary.data?.session !== undefined && summary.data.session.id === sessionId
        ? summary.data.session
        : null
      const periodKind = summary.data?.period?.kind === 'peak' ? 'peak' : 'off'
      const tooltip = buildBarTooltip(t, summary, session)

      const costItem = (key, label, value, extra = '') => h('span', { className: `dum-bar__item${extra}`, key },
        h('span', { className: 'dum-bar__muted' }, label),
        h('span', { className: 'dum-bar__value' }, value))
      const separator = (key) => h('span', { className: 'dum-bar__sep', key }, '·')
      const readings = session === null
        ? h('span', { className: 'dum-bar__muted' }, t(summary.status === 'failed' ? 'status.unavailable' : 'status.loading'))
        : [
          costItem('total', t('bar.totalCost'), formatCny(session.cost)),
          separator('sep1'),
          costItem('hit', t('bar.hitCost'), formatCny(session.cacheHitCost)),
          separator('sep2'),
          costItem('miss', t('bar.missCost'), formatCny(session.cacheMissCost)),
          separator('sep3'),
          costItem('output', t('bar.outputCost'), formatCny(session.outputCost), ' dum-bar__optional'),
        ]

      return h(
        React.Fragment,
        null,
        h('style', { key: 'style' }, STYLES),
        h(
          'footer',
          {
            key: 'bar',
            className: 'dum-bar',
            'data-dsh-usage-meter': '',
            role: 'button',
            tabIndex: 0,
            'aria-label': tooltip.replace(/\n/g, ' '),
            title: tooltip,
            onClick: () => {
              if (typeof props.openStats === 'function') props.openStats()
            },
            onKeyDown: (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              if (typeof props.openStats === 'function') props.openStats()
            },
          },
          h('span', { className: 'dum-bar__label' }, t('bar.label')),
          h('span', { className: `dum-bar__period dum-bar__${periodKind}` },
            h('span', { className: 'dum-bar__dot', 'aria-hidden': true }),
            periodLabel(t, periodKind)),
          h('span', { className: 'dum-bar__grow', 'aria-hidden': true }),
          readings,
        ),
      )
    }

    // -----------------------------------------------------------------------
    // Sidebar glyph
    // -----------------------------------------------------------------------

    function UsageMeterGlyph(props) {
      const size = typeof props.size === 'number' ? props.size : 18
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          'aria-hidden': true,
          focusable: 'false',
          style: { display: 'block' },
        },
        h('circle', { cx: 12, cy: 12, r: 8.5, stroke: 'currentColor', strokeWidth: 1.6, opacity: 0.55 }),
        h('path', { d: 'M12 3.5a8.5 8.5 0 0 1 0 17z', fill: 'currentColor', opacity: 0.28 }),
        h('path', {
          d: 'M8.6 7.4 12 11.8l3.4-4.4M12 11.8V17M9.2 13.7h5.6',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    // -----------------------------------------------------------------------
    // Statistics page
    // -----------------------------------------------------------------------

    function ActivityHeatmap(props) {
      const { t, heatmap, mode, metric } = props
      const [hover, setHover] = React.useState(null)
      if (heatmap.cells.length === 0) {
        return h('div', { className: 'dum-page__state' }, t('activity.empty'))
      }
      const barMode = heatmap.barMode === true
      const gridWidth = heatmap.weeks * STEP - GAP
      const tipLeft = hover === null
        ? 0
        : Math.min(Math.max(hover.x * STEP + CELL / 2, 64), Math.max(gridWidth - 64, 64))
      return h(
        'div',
        { className: 'dum-heat', onMouseLeave: () => setHover(null) },
        h(
          'div',
          { className: 'dum-heat__canvas' },
          h(
            'div',
            {
              className: 'dum-heat__grid',
              style: {
                gridTemplateColumns: `repeat(${heatmap.weeks}, ${CELL}px)`,
                gridTemplateRows: `repeat(7, ${CELL}px)`,
              },
            },
            heatmap.cells.map((cell) => {
              if (barMode) {
                // Weekly / cumulative are bar charts made of cells: the column
                // is filled from the bottom up to the value's height. Every cell
                // of the column answers the hover, so a week without usage still
                // reports its zero value instead of staying silent.
                const bar = heatmap.bars?.get(cell.week)
                const height = bar?.height ?? 0
                const filled = cell.row >= 7 - height
                return h('div', {
                  key: cell.entry.date,
                  className: `dum-heat__cell ${filled ? 'dum-heat__bar' : 'dum-heat__l0'}`,
                  style: { gridColumn: cell.week + 1, gridRow: cell.row + 1 },
                  onMouseEnter: () => setHover({
                    x: cell.week,
                    y: cell.row,
                    text: heatmapTooltip(t, cell, heatmap, mode, metric),
                  }),
                })
              }
              const value = heatmap.values.get(cell.index) ?? 0
              const level = heatLevel(value, heatmap.max)
              return h('div', {
                key: cell.entry.date,
                className: `dum-heat__cell dum-heat__l${level}`,
                style: { gridColumn: cell.week + 1, gridRow: cell.row + 1 },
                onMouseEnter: () => setHover({
                  x: cell.week,
                  y: cell.row,
                  text: heatmapTooltip(t, cell, heatmap, mode, metric),
                }),
              })
            }),
          ),
          hover === null ? null : h(
            'div',
            {
              className: 'dum-heat__tip',
              style: { left: tipLeft, top: hover.y * STEP - 3 },
            },
            hover.text,
          ),
        ),
        h(
          'div',
          {
            className: 'dum-heat__months',
            style: { gridTemplateColumns: `repeat(${heatmap.weeks}, ${CELL}px)` },
          },
          heatmap.months.map((month) => h(
            'span',
            { key: month.week, style: { gridColumnStart: month.week + 1 } },
            month.label,
          )),
        ),
        barMode ? h('div', { className: 'dum-heat__legend' }, h('span', null, t(mode === 'cumulative' ? 'activity.barHintCumulative' : 'activity.barHintWeekly'))) : h(
          'div',
          { className: 'dum-heat__legend' },
          h('span', null, t('activity.less')),
          [0, 1, 2, 3, 4].map((level) => h('span', { key: level, className: `dum-heat__swatch dum-heat__l${level}` })),
          h('span', null, t('activity.more')),
        ),
      )
    }

    function KpiCard({ value, label, title }) {
      return h(
        'div',
        { className: 'dum-kpi', ...(title === undefined ? {} : { title }) },
        h('div', { className: 'dum-kpi__value' }, value),
        h('div', { className: 'dum-kpi__label' }, label),
      )
    }

    function UsageStatsPage(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const [mode, setMode] = React.useState('daily')
      const [metric, setMetric] = React.useState('token')
      const [stats, refresh] = useStatsData()
      const data = stats.data
      const updatedAt = data === null || data === undefined ? '—' : formatDateTime(data.generatedAt)

      const head = h(
        'div',
        { className: 'dum-page__head' },
        h('div', null,
          h('h1', { className: 'dum-page__title' }, t('page.title')),
          h('p', { className: 'dum-page__intro' }, t('page.intro'))),
        h('div', { className: 'dum-page__tools' },
          h('span', { className: 'dum-page__updated' }, t('page.updated', { time: updatedAt })),
          h('button', {
            type: 'button',
            className: 'dum-refresh',
            disabled: stats.fetching === true,
            onClick: refresh,
          }, stats.fetching === true ? t('page.refreshing') : t('page.refresh'))),
      )

      let body
      if (data === null || data === undefined) {
        body = h('div', { className: 'dum-page__state' },
          stats.status === 'failed'
            ? h(React.Fragment, null,
              h('div', null, t('status.error', { error: stats.error })),
              h('button', { type: 'button', className: 'dum-refresh', onClick: refresh }, t('page.retry')))
            : t('page.loading'))
      } else {
        const kpis = data.kpis ?? {}
        const backfill = kpis.backfill ?? data.backfill ?? {}
        const heatmap = buildHeatmap(data.days, mode, metric)
        const modeOptions = [
          { id: 'daily', label: t('activity.mode.daily') },
          { id: 'weekly', label: t('activity.mode.weekly') },
          { id: 'cumulative', label: t('activity.mode.cumulative') },
        ]
        const metricOptions = [
          { id: 'token', label: t('activity.metric.token') },
          { id: 'cost', label: t('activity.metric.cost') },
        ]
        const kpiCards = [
          h(KpiCard, { key: 'tokens', value: formatCompact(kpis.totalTokens), label: t('kpi.totalTokens') }),
          h(KpiCard, { key: 'cost', value: formatCny(kpis.totalCost), label: t('kpi.totalCost') }),
          h(KpiCard, {
            key: 'peak',
            value: formatCompact(kpis.peakTokens),
            label: t('kpi.peak'),
            title: kpis.peakDay === null || kpis.peakDay === undefined
              ? undefined
              : t('kpi.peakDate', { date: formatDayKey(kpis.peakDay) }),
          }),
          h(KpiCard, { key: 'task', value: formatDuration(kpis.longestTurnMs, t), label: t('kpi.longestTask') }),
          h(KpiCard, { key: 'longest', value: t('kpi.streakDays', { days: numberOrZero(kpis.longestStreakDays) }), label: t('kpi.longestStreak') }),
          h(KpiCard, { key: 'current', value: t('kpi.streakDays', { days: numberOrZero(kpis.currentStreakDays) }), label: t('kpi.currentStreak') }),
        ]
        const models = Array.isArray(data.models) ? data.models : []
        const auxCalls = data.auxCalls ?? {}
        const auxCount = numberOrZero(auxCalls.requests)
        body = h(
          React.Fragment,
          null,
          h('section', { className: 'dum-card dum-kpis' }, kpiCards),
          h('section', { className: 'dum-card dum-activity' },
            h('div', { className: 'dum-card__head' },
              h('h2', { className: 'dum-card__title' }, t('activity.title')),
              h('div', { className: 'dum-card__controls' },
                h(Segmented, { options: modeOptions, value: mode, onChange: setMode }),
                h(Segmented, { options: metricOptions, value: metric, onChange: setMetric }))),
            h(ActivityHeatmap, { t, heatmap, mode, metric })),
          h('section', { className: 'dum-card' },
            h('div', { className: 'dum-card__head' },
              h('h2', { className: 'dum-card__title' }, t('models.title'))),
            h('div', { className: 'dum-models' },
              models.length === 0
                ? h('div', { className: 'dum-models__empty' }, t('models.empty'))
                : models.map((model) => h('div', { className: 'dum-model', key: model.model },
                  h('span', { className: 'dum-model__name' },
                    model.model,
                    model.estimated === true ? h('span', { className: 'dum-model__est' }, t('models.estimated')) : null),
                  h('span', { className: 'dum-model__meta' }, t('models.tokens', { tokens: formatCompact(model.totalTokens) })),
                  h('span', { className: 'dum-model__meta' }, t('models.requests', { count: model.requests })),
                  h('span', { className: 'dum-model__cost' }, formatCny(model.cost)))))),
          h('p', { className: 'dum-page__note' },
            h('span', null, backfillNote(t, backfill)),
            h('span', null, '·'),
            h('span', null, t('page.trackedSince', { time: formatDateTime(kpis.trackingSince) })),
            auxCount > 0 ? h('span', null, '·') : null,
            auxCount > 0
              ? h('span', null, t('page.auxCalls', { count: auxCount, cost: formatCny(auxCalls.cost) }))
              : null),
        )
      }

      return h(
        'div',
        { className: 'dum-page', 'data-dsh-usage-meter-page': '' },
        h('style', { key: 'style' }, STYLES),
        head,
        h('div', { className: 'dum-page__body' }, body),
      )
    }

    // -----------------------------------------------------------------------
    // Plugin registration
    // -----------------------------------------------------------------------

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'dsh-usage-meter: dictionaries')
        const translate = ctx.locale.bind(NS)
        const openStats = () => {
          try {
            ctx.layout.selectPanel(PANEL_ID)
          } catch {
            // Navigation is best effort; the bar keeps working without it.
          }
        }
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: PANEL_ID, locale: NS },
          UsageStatsPage,
        ))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => translate('panel.title'), locale: NS },
          UsageMeterGlyph,
        ))
        ctx.slots.inject('shell.bottom', () => ctx.slots.register(
          { name: 'shell.bottom', locale: NS, inject: () => ({ openStats }) },
          UsageStatusBar,
        ))
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register(
          { name: 'conversation.chat.turnTail', id: 'dsh-usage-meter-turn', order: 20, locale: NS },
          TurnCostTail,
        ))
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register(
          { name: 'conversation.chat.assistant-actions', id: 'dsh-usage-meter-turn', order: 20, locale: NS },
          TurnCostAction,
        ))
      },
    }
  },
})
