# 状态条图标改用 DeepSeek 字形并补齐子代理运行态绿色呼吸点

## Goal

状态条 pill 图标从手绘线稿换成 DeepSeek `ui-primitives` 的官方字形，让 14px 下的笔画和几何更干净；同时补上原插件有、本插件丢失的子代理运行态绿色呼吸点。

## 背景

现状的四个图标是 `d9b5745` 一次性手绘的（`statusbar/statusbar.js:430-447`），设计文档只规定了尺寸，没规定图形语义。实机对比 DeepSeek 自己的统计条（`StatsPills`）看出两处差距：

1. **字形质量**。自绘 activity 是半圆弧加斜线，读起来像"信号"而不是仪表；四个图标用了 1.4/1.4/1.4/1.15 三个不同描边值，齿轮在 14px 下偏重。DeepSeek 全表只有 1.0 和 1.3 两档。
2. **运行态语义**。原插件 `zcode-token-usage-statusbar` 在子代理格尾追加一个绿色`●`并让它呼吸（`overlay.js:5061`：`'<span class="ok dot">●</span>'`，配 `.ok{color:#3ecf8e}` 与 `.dot{animation:zupulse 1.6s ...}`）；面板头部也有一条绿色圆点状态行（`overlay.js:3409`：`.zu-spstate.run .dot{background:#3ecf8e}`）。本插件移植时把呼吸动画留下了，绿色丢了，而且把呼吸从"点"挪到了"数字本身"。

## Requirements

### R1 三个 pill 图标改用 DeepSeek 字形

- activity → `gauge-outline`，usage → `database-outline`，gear → `settings-outline`。路径数据取自 `deepseek-harness/packages/client/ui-primitives/src/icons/artwork.ts`。
- 子代理**保留现有自绘三分叉图标**，不采用 `users-outline`（人形头像）或 `agent-preset-outline`（14px 下糊成一团）。这是用户明确选择。
- 保留 14px 容器与零依赖：只替换 `ICONS` 表里的字符串，不引入包、不新建图标模块、不加注册表。
- 描边宽度写 1.6。DeepSeek 画布是 viewBox 16，宿主 CSS 把图标渲染成 14px，缩放比 14/16 = 0.875，`1.6 × 0.875 = 1.4`，与现有视觉字重一致。子代理图标仍是 viewBox 14 + stroke 1.4（缩放比 1），两边生效描边都是 1.4px，混排不突。
- 在 `ICONS` 上方加一行来源与许可说明：字形数据来自 deepseek-harness，MIT（Copyright (c) 2026 DeepSeek）。

### R2 子代理运行态：绿点 + 速度，不再显示个数

运行态 pill 的内容重定为「图标 · 绿点 · 速度」，活跃数不再展示。

- 运行态（`subagent.activeCount > 0`）在图标**之后**放一个绿色圆点，沿用原插件的呼吸节奏 `1.6s ease-in-out`，透明度 1 → 0.2。顺序为图标 → 绿点 → 速度读数。
- 活跃数不再渲染。`subSep`（` · ` 分隔符）随之失去作用，直接删掉，不留在 DOM 里当空壳。
- 绿点承担"有子代理在跑"的二元状态，速度读数承担快慢。个数信息仍然可从子代理面板查到（分组标题带条目数），不丢失。
- 绿色取原插件值：深色 `#3ecf8e`，浅色 `#0c8a63`。现有 `applyThemeVars` 已经算出 `dark` 布尔值，按它二选一写入 CSS 变量，不新增主题探测。
- **数字本身不再呼吸**。一个 14px 宽的读数上挂两条动画会互相干扰，而且原插件就是只让点呼吸。`zsb-pulse` 类从 `subLabel` 移到新点上。
- 速度读数保持 `speedColor()` 色阶不变。绿色只承担"有子代理在跑"，不参与速度语义。
- 闲态不变：无绿点，显示会话累计 token，中性灰。
- 子代理面板每行的状态点同样改绿：`zsb-subdot` 在运行态用同一个绿色变量，静止不呼吸（呼吸只留在条上，避免面板里多个动画同时闪）。已完成态维持 `currentColor` 半透明。
- pill 的 tooltip 文案同步去掉"活跃数"：运行态改为只描述速度，例如「子代理运行中 · 实时速度」。

### R3 子代理 pill 移到用量与上下文之间

状态条顺序从 Activity → Usage → 上下文 → 子代理 → 齿轮 改为 Activity → Usage → **子代理** → 上下文 → 齿轮。

- 改动点是 `mountBar` 的 `bar.appendChild` 顺序（`statusbar.js:563-567`），子代理排到上下文之前。DOM 顺序即视觉顺序（bar 是 flex 行，无 `order`）。
- 降级阶梯的档位编号与视觉顺序解耦，不因这次移动而重排。但档位注释里的"价值序"按新顺序重述一遍，避免注释与实际布局矛盾。
- 无数据时子代理 pill 整只不占位（`state.subSeen` 粘滞逻辑不变），上下文 pill 缺席时同理。两者互不影响，顺序变化不引入新的占位空洞。
- 同步更新两处登记：`statusbar/CONTRACT.md` §7 的 pill 名列表，以及 `.trellis/spec/statusbar/ui-guidelines.md` 的 DOM 表。

## 非目标

- 不改布局、尺寸、间距、色阶（`ramp.js` 一行不动）。
- 不改子代理面板的信息结构与交互。
- 不引入 DeepSeek 的图标精灵（`<symbol>` + `<use>`）机制，仍是内联 SVG 字符串。
- 不处理弹层标题图标化。现阶段 `sectionTitle` 不渲染图标，弹层标题也没有「会话统计」这个文案，与用户截图里的那一版不是同一份代码。

## Acceptance Criteria

- [x] AC1 activity / usage / gear 三个 pill 渲染 DeepSeek 字形，14px 下笔画清晰；子代理 pill 仍是三分叉图标。
- [x] AC2 四个图标混排时生效描边一致（都是 1.4px），无某一个明显偏重或偏轻。
- [x] AC3 子代理运行中：图标后出现绿色圆点并呼吸，圆点后是速度读数；pill 内不出现活跃数数字。
- [x] AC4 子代理运行中数字本身静止；速度读数仍走 `speedColor()` 色阶，不因 R2 变绿。
- [x] AC5 子代理闲态：无绿色点，显示会话累计 token，中性灰。
- [x] AC6 面板内运行中行的状态点为绿色，已完成行为当前色半透明；分组标题仍带条目数。
- [x] AC7 运行态与闲态来回切换时 pill 宽度变化可接受，不出现跳动或文字被裁。
- [x] AC8 状态条顺序为 Activity → Usage → 子代理 → 上下文 → 齿轮，与用户开关无关（开关只控制显隐，不改顺序）。
- [x] AC9 `statusbar/statusbar.js` 与 `plugins/zcode-statusbar/statusbar.js` 同步（`python3 core/sync_plugin.py --check` 无漂移）。
- [x] AC10 `npm test` 全绿；`statusbar/CONTRACT.md` §7 与 `.trellis/spec/statusbar/ui-guidelines.md` 的 DOM 登记同步更新。

## Notes

- 轻量任务，PRD-only。三处改动都落在 `statusbar/statusbar.js` 一个文件里，不需要 design.md / implement.md。
- 字形取舍的证据在 `/tmp/zsb-icon-proto/shot3.png`（四组字形对比）、`shot6.png`（绿色与速度色阶在三种速度下的共存效果）与 `shot7.png`（新运行态形态与整体顺序）。三个文件是可丢弃原型，不进仓库。
- 抄 DeepSeek path 数据的许可依据：deepseek-harness 与本仓库同为 MIT，复制后按要求保留版权声明。
