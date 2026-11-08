# dsh-usage-meter · Codex-style DSH 用量统计

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **这是一个 Codex-style 的用量统计插件。** 界面布局、6 张 KPI 卡、活动热力图 / 柱状图、悬浮气泡和页脚注脚都参考 **OpenAI Codex 官方用量统计界面**，再针对 DeepSeek Harness 与 DeepSeek 峰谷计价做适配。本项目与 OpenAI / Codex 无隶属关系，也不包含其任何代码。
>
> **This usage meter is Codex-style**: its layout, KPI cards, activity heatmap / cell bars, hover tooltips and footer note follow the **OpenAI Codex usage dashboard**, adapted for DeepSeek Harness and DeepSeek peak/off-peak pricing. Not affiliated with OpenAI; no Codex code is included.

DeepSeek Harness 插件：统计 provider 上报的 Token 用量，按 DeepSeek **峰时 / 谷时（peak / off-peak）** 价格计费，提供两个界面：

- **底部状态栏**（`shell.bottom`）：只显示**当前打开 Session** 的费用拆分——`总花费 | 输入（缓存命中） | 输入（缓存未命中） | 输出`，加上实时 `峰时` / `谷时` 标识。没有打开会话（或停留在其他面板页）时整条状态栏隐藏；点击状态栏直接打开统计页。
- **「用量统计」页**：左侧栏一级入口 + 中间整页，布局参考 Codex 官方用量界面——一行 6 张 KPI 卡（累计 Token 数 / 累计费用 / Token 使用峰值 / 最长任务用时 / 最长连续天数 / 当前连续天数）、Token 活动图（近 53 周，可切换 每天 / 每周 / 累计总量，以及 Token / 费用 两种指标；悬停显示 Codex 风格的深色气泡）、按模型拆分、历史回填与统计起点注脚。页面打开时加载一次，提供手动「刷新」，不做轮询。
  - `每天`：热力图——每格 = 当天用量，按数值渐变蓝色；
  - `每周`：**柱状图（用热力格绘制）**——每列是一周，同一周自下而上堆叠蓝色格子，柱高 = 该周用量；整列都可悬停，没有用量的周显示「{周一起始日期} 起的一周 + 0 个 Token」；
  - `累计总量`：同样的柱状图，柱高 = 截至该周的累计用量（只增不减）；悬停显示「累计至 {周一起始日期} 起的一周 + 累计值」。

计费与统计都不产生模型请求、不联网：Host 半只折叠 Session 日志里已经提交的 `assistant/message` / `assistant/attempt` 结算，以及 `turn/start` → `turn/end` 边界。

## 价格与峰谷规则

DeepSeek 官方列表价（元 / 百万 token，价格页更新于 2026-09-10）：

| 模型 | 输入缓存命中 | 输入缓存未命中 | 输出 |
| --- | --- | --- | --- |
| `deepseek-flash` 峰 / 谷 | 0.04 / 0.02 | 2 / 1 | 8 / 4 |
| `deepseek-v4-pro` 峰 / 谷 | 0.30 / 0.15 | 9 / 4.5 | 27 / 13.5 |

- **峰时**：北京时间 `09:00–12:00`、`14:00–18:00`，默认**每天**生效（`peakDays: daily`）；可用 `peakDays: weekdays` 切换为官方文档里“周一至周五”的日历，并用 `holidays` 把指定日期整天按谷时计；
- **谷时**：其余全部时间，价格恰为峰时的一半；
- 缓存写入按缓存未命中价计（可用 `cacheWrite` 覆盖）；旧模型名（`deepseek-v4-flash` 等）自动别名，未知模型回退 `deepseek-flash` 并标记「估算」。
- **默认值来自账单校准**：官方文档写“周一至周五”为峰时，但 2026-11-08（周日）14:00–18:00 的实际账单按峰价计费（平台今日消费 ¥7.28 与该口径精确吻合），因此默认每天峰时；如以文档为准可设 `peakDays: weekdays`。
- 金额一律按 **元** 计、**只保留小数点后两位（末位直接舍去，不四舍五入）**：持久化的 `usage.json` 与所有接口返回值都用两位小数，界面也固定显示 `¥x.xx`。
- 价格 / 峰谷日历 / 节假日属于计费口径：改动后插件会用会话日志**重算全部历史**（`pricingSignature` 变化触发），避免新旧价目混算。

## 配置

默认零配置即可用。价格、节假日、轮询频率等可在 profile 的 patch 层覆盖插件行：

```yaml
- id: dsh-usage-meter
  config:
    models:
      deepseek-flash:
        peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 }
        # `off` 省略时按峰时价的一半推导
      deepseek-v4-pro:
        peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 }
        off: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }
    aliases:
      deepseek-v4-flash: deepseek-flash
    fallbackModel: deepseek-flash
    peakDays: daily     # daily（默认，与实测账单一致）| weekdays（官方文档口径）
    peakWindows: ['09:00-12:00', '14:00-18:00']
    holidays: ['2026-10-01', '2026-10-02']   # 北京时间指定日期，全天按谷时
    retainDays: 400     # 日粒度保留天数（下限 371，热力图需要）
    pollMs: 5000        # 状态栏轮询
    flushMs: 2000       # 落盘防抖
    backfill: true      # 启动时回放历史会话
```

## 数据与接口

- 状态持久化在 `<profile>/plugin-data/dsh-usage-meter/usage.json`：全局累计、按日、按模型、按 Session 汇总、最长 Turn 时长和已结算的 step 槽位。
- `GET /dsh-usage-meter/summary[?session=<id>]`：状态栏数据（带 `session` 时附该会话汇总）。
- `GET /dsh-usage-meter/stats`：统计页数据（KPI、371 天零填充日序列、模型汇总、回填状态）。
- **历史回填**：首次安装回放启动前已落盘的全部会话（忽略 fork 继承事件，避免重复计费）；从旧版本升级时按「已覆盖窗口」补齐（v1 状态补全量历史，v2 状态补安装前当天的小时窗），并在升级后按日志重放一次**按会话对账**，修正旧版本没有按会话汇总导致的偏差。回填在后台进行、有时限，超时标记 `partial`，页面注脚会显示状态。
- 会话维度只统计该 Session **自身**的结算（fork/子代理继承来的历史不计入子会话）。

## 布局

| 文件 | 职责 |
| --- | --- |
| `index.js` | Host 半：计费、会话事件折叠、按日/按会话聚合、回填、两个 JSON 路由 |
| `client.js` | 浏览器半：状态栏（当前会话 + 点击跳转）、侧栏入口与「用量统计」页、zh/en 文案、主题 token 样式 |
| `cordis.patch.yml` | 插入 Host 插件行 |
| `locale/*.json` | 插件管理器的标题 / 描述 |
| `tests/host.test.mjs` / `tests/client.test.mjs` | Host 21 项、客户端渲染与交互断言 |

## 安装

通过 Harness 插件管理器安装本目录（`install_bundle` 指向该绝对路径），会以链接方式装入当前 profile 并启用 bundle 的补丁行；Host 代码变更由 profile 重组（HMR）自动替换，浏览器半随客户端模块 HMR 重新加载，必要时刷新页面。

## 仓库

- 源码：<https://github.com/SimpsonJiang/dsh-usage-meter>
- 问题反馈：<https://github.com/SimpsonJiang/dsh-usage-meter/issues>

## License

[MIT](LICENSE) © 2026 SimpsonJiang
