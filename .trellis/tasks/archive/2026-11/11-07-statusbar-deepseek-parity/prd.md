# 状态条对齐 deepseek：会话内挂载、齿轮图标、上下文进度按钮

## Goal

状态条只在真实会话内挂载（draft 首页不渲染）；齿轮改用齿形轮廓图标；移除对官方上下文圆环的描边改写与 1s 轮询；新增自带上下文圆环 pill（圆环 + 百分比）与占用详情弹层，数据读官方隐藏锚点 data-usage-used/max。

## 背景

上一版对每个主窗口无条件渲染，且会对官方上下文圆环做 SVG 描边改写。实机暴露四个问题：

1. 首页（新建任务、无会话）也渲染状态条，此时没有任何会话数据，读数是 `--`。
2. 齿轮图标是「圆 + 八条辐条」，读起来像太阳，与「设置」语义不符。
3. 官方上下文进度按钮被插件改写，属于侵入官方 UI。
4. 状态条控件集合里没有上下文进度按钮，用户看不到上下文占用。

第 3 条还附带一个事实：那段圆环增强从未生效。`enhanceRing()` 用 `svg.closest('[data-usage-used]')` 取占用，而官方的 `data-usage-used` 挂在 `V4ComposerToolbar.tsx:1263` 的独立隐藏 `<span>` 上，不在圆环 SVG 的祖先链里；退回 `aria-label` 正则时，官方文案是 `上下文已用 {used} / 总量 {total}`（`zh-CN.ts:5585`），既无百分比也无 `a/b` 形态，两种解析都取不到值。

## Requirements

### R1 会话内挂载

状态条只在真实会话中渲染。判定依据是宿主 `SessionPane` 的 `data-session-id`（`SessionPane.tsx:5938`），值为 `"draft"` 表示首页/新建任务草稿，不渲染。

挂载探测从「10s 后永久放弃」改为常驻低频探测（1s）。原因：SPA 内切换任务不重新注入 renderer 脚本，进入会话要及时出现，回到 draft 要及时消失。

### R2 齿轮图标

齿轮按钮改用齿形轮廓图标，与「设置」语义一致，不再是辐条放射状。

### R3 不修改官方上下文控件

移除全部对官方上下文圆环的干预：选择器探测、SVG 描边改写、`data-zsb-ring` 标记、1s 轮询。官方按钮的 DOM、样式、弹层、行为保持原样。

### R4 自带上下文进度按钮

状态条新增上下文 pill，形态对齐 deepseek 的 ContextMeter：14×14 圆环 + 百分比读数。

- 顺序：Activity → Usage → 上下文 → 子代理 → 齿轮。
- 数据源为官方隐藏锚点 `[data-v4-model-config]` 上的 `data-usage-used` / `data-usage-max`（`V4ComposerToolbar.tsx:1263-1264`），与官方面板同源同口径，分母为完整 context window。
- 圆环进度与百分比都随占用变化；圆环描边颜色沿用现有 `contextColor` 色阶。
- 点击展开详情弹层：已用 / 总量（mono 数字）、占用进度条、来源分解（系统提示词 / 工具定义 / 消息）。
- 数据缺失（`used <= 0`、`size <= 0`、非有限值）时不渲染该 pill，与官方 `getRenderableTaskUsage` 的守卫同口径。
- pill 显示开关并入现有「显示」菜单，持久化键沿用 `zcode-statusbar.pills`。

## Out of Scope

- 不改官方上下文按钮的 DOM、样式、hover/点击行为。
- 不引入第二个上下文数据通道（不读 store、不加 IPC），只读宿主已有的隐藏锚点。
- 来源分解不做精确 token 换算：官方 `breakdown` 只有 `chars` 且不在隐藏锚点上，取不到时退化为单色进度条。

## Acceptance Criteria

- [x] AC1 首页/新建任务（`data-session-id="draft"`）下无状态条；切到真实会话后 1s 内出现；切回 draft 后消失。
- [x] AC2 齿轮按钮显示齿形轮廓，不再是辐条状。
- [x] AC3 官方上下文圆环按钮的颜色、弹层、交互与未装插件时一致；插件不再写官方 SVG 的任何属性。
- [x] AC4 会话中状态条出现上下文 pill（圆环 + 百分比）；有真实占用时读数与官方弹层顶部数字一致。
- [x] AC5 点击上下文 pill 展开详情，含已用/总量与进度条；再次点击、外点或 Escape 关闭。
- [x] AC6 官方锚点缺失或占用为 0 时该 pill 不渲染，其余 pill 不受影响。
- [x] AC7 `npm test` 全绿；`python3 core/sync_plugin.py --check` 无漂移。

## Risks

- `data-v4-model-config` 是官方 e2e 契约锚点，不是公开 API，宿主升级可能改名。失效路径为静默（pill 不渲染），不影响其余控件；锚点集中在 `statusbar.js` 常量区登记。
- 常驻低频探测从「一次性 10s」变为「每 1s 一次 querySelector」，开销可忽略（单选择器、无布局读取），需确认不与 `turn-stats.js` 的 MutationObserver 形成叠加负担。
