# 调研：deepseek-harness 状态栏（视觉 UX 参考）

> 用户所指的"状态栏"最可能是**会话输入框下方、水平居中的统计条**（源码称 composer dock），不是全窗口底栏。调研时间 2026-11-06。

## 三个易混位置

| 位置 | 用途 |
|---|---|
| **输入框下统计条（目标）** | 轮数/步数、输出速度、累计 token、缓存命中率、上下文占用 |
| 聊天内容末尾运行提示 | 蓝色鲸鱼动画 "Deep diving"+运行时长，非统计条 |
| 应用全宽底部 `shell.bottom` | 默认留空；实验性 Inspector 占用 |

## 横向顺序与显示条件（默认详细模式）

| 序 | 控件 | 外观 | 出现条件 |
|---|---|---|---|
| 1 | Activity | 仪表盘图标 + `N 轮 N 步 · N tok/s` | 详细模式且有已结束 step；点击看模型用时/工具用时/TTFT/TPS |
| 2 | Usage | 数据库图标 + `N tok · 缓存命中 N%` | 有 token 用量；点击看精确输入/输出/缓存分项 |
| 3 | Context | 小圆环 + `N%`（无"上下文"文字） | 有占用量和容量；点击展开占用/容量及构成 |

- 简洁模式：前两项只留速度、缓存命中率；上下文圆环仍独立存在可点击。默认 detailed。
- 有数据后**持续显示**，不是仅生成时出现。

## 视觉规格（默认字号下的源码值）

| 项 | 值 |
|---|---|
| 布局 | 水平居中；控件间 12px；距输入卡片顶 4px |
| 高度稳定 | 无读数也保留 ≥22px 统计行，防跳动 |
| Activity/Usage 字 | 12px / 行高 20px；图标 14×14 |
| Context 字 | 13px / 行高 20px；圆环 14×14、描边 2px |
| 控件内 | 图文间距 6px；padding 1px 8px；圆角 8px；透明背景无边框 |
| 数字 | `tabular-nums` 等宽；主条普通字重；详情标题/关键数字 500 |
| 字体 | 系统无衬线栈（SF/PingFang SC/Segoe UI），非品牌字体 |
| 静态色 | 浅色 `rgb(129,133,140)` / 深色 `rgb(173,178,184)`（三级灰） |
| hover | 升为二级文字色 + 淡灰背景；Context hover 200ms 显示"上下文已用 N%" |

- **没有**按上下文高占用自动变黄/红的分支；圆环保持中性灰。
- 详情构成条才区分颜色：系统灰、工具紫、消息蓝。

## 口径注意

- 显示的速度是**会话累计平均**（Σ输出 tokens ÷ Σ解码时间），不是瞬时速度计。
- 累计 token ≠ 当前上下文：Context 用 `projectedTokens`（回退 `pressureTokens`）÷ 容量，封顶 100%；详情用 `~已用 / 容量` 表达估计性质。

## "靠视觉减少文字"的现成做法（可直接借鉴）

1. 图标承担类别，正文只留读数和必要单位（上下文 = 圆环+百分比）。
2. 圆环表达占比，详情彩色分段表达构成。
3. 短数值、`tok/s`、`tok`、K/M 缩写、中点分隔代替句子。
4. 计费桶/时间分解/精确数值移入点击详情。
5. 安静灰色、等宽数字、固定预留高度防跳动。

## 源码锚点

- 顺序注册：`packages/client/ui-chat/src/client/apply.ts:337-345`
- 前两项：`packages/client/ui-chat/src/client/chat/StatsPills.tsx:247-346`
- 上下文：`packages/client/ui-conversation/src/client/skeleton/ContextMeter.tsx:56-167`
- 样式：`packages/client/ui-chat/src/client/chat/StatsPills.module.css:6-62`、`ContextMeter.module.css:9-49`
- 文本快照：`apps/web/tests/expected/skill-user-invoke/ui.expected.md:22-29`（无现成目标状态栏截图）
