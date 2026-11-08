# Design: ZCode 状态栏插件

> 对应 prd.md（11-06-statusbar-design）。总体原则：接入内核复刻 zcode-token-usage-statusbar 并做减法，UI 层重写为 deepseek 风格视觉组件。

## 1. 架构与边界

```
zcode-statusbar/                     （本仓库 = 插件源码 + 分发配置）
├── plugin.json / .zcode-plugin/     插件 manifest、hooks、命令（分发与触发渠道）
├── core/                            接入内核（复刻自原插件，裁剪后移植）
│   ├── patch_install.py             asar 注入/剥离（SessionStart 同步入口）
│   ├── install.py                   独立安装器（失败不删运行目录 ← 补缺口③）
│   ├── inject-main.cjs              主进程 loader（加载稳定运行目录模块）
│   ├── engine-patch.cjs             引擎补丁（登记 SHA 白名单 + restore ← 补缺口①）
│   ├── pending_zip_patch.py         更新 ZIP 预注入 + 撤销链（← 补缺口②）
│   └── plugin-updater.cjs           Release 更新（渠道/版本/文件集/哈希校验）
├── statusbar/                       UI 与数据（新写，deepseek 风格）
│   ├── statusbar.js                 注入 UI：四控件 + 详情弹层 + 齿轮菜单
│   ├── ramp.js                      色阶引擎（连续插值，速度/上下文两条）
│   ├── turn-stats.js                生成中速度采样（字符增量，~2s 窗自校准）
│   ├── session-stats.cjs            会话加权均、缓存命中、子代理聚合
│   └── renderer_bridge.py           状态桥/身份识别（复刻原实现，含 fiber 兜底）
└── zusage.py                        SQLite 只读查询（裁剪：无价格/额度/汇率）
```

- 稳定运行目录：`~/.zcode/zcode-statusbar/`（与插件缓存分离，注入行指向此处）。
- **裁剪清单**（相对原插件）：overlay 六分区设置、回答末尾统计行、prompt-submit 注入、额度/余额/价格/汇率、Git 栏、命令中心增强、路径增强、压缩引擎行为功能扩展。

## 2. 数据流

```
SQLite(WAL, 300ms 去抖, ≥1500ms) ─┐
原生上下文按钮 aria-label ────────┼→ 身份识别(窗口/分栏) → 状态条状态树 → ramp.js 上色 → DOM
renderer store 字符增量(100ms tick) ┘
```

- 生成中速度：`字符增量 ÷ 每token字符数`（初值 2，用上一完成轮自校准），采样窗 ~2s；标记为估算态。
- 完成态速度：`Σ有效输出 token ÷ Σ有效生成时长`；有效窗口 200ms ≤ t < 1h；思考/Claude 请求用 `completed_at − started_at`，其余用首字窗口；不含子代理。
- 上下文：优先 aria-label 已用/总量（与官方面板同源），失败退 SQLite 最近完成请求 input/window；缓存已含在 input，不重复相加。
- 不可确认身份的窗口不渲染（防串数），重试窗口内静默。

## 3. 色阶引擎（ramp.js）

连续插值，输入数值 → 输出颜色；锚点分段线性，中间过 hsl 插值避免脏色：

| 色阶 | 域 | 锚点 |
|---|---|---|
| 速度 | 0 → ≥2000 tok/s | 0 红 → 150 绿 → 800 蓝 → 2000 紫（≥2000 封顶紫；原来的"星点装饰"不保留） |
| 上下文 | 0% → 100% | 0 绿 → 50 黄 → 90 红 → 100 深红（作用于官方圆环描边） |

- 估算态标识：数字附加呼吸透明度动画（约 2s 周期）+ tooltip 首句声明"估算"；核实态静态。
- 色值锚点在实现任务用深浅主题对比度校验后固化为主题内常量，不依赖宿主未公开变量。
- 子代理闲态累计一律中性灰（foreground-subtle），不上色阶。

## 4. UI 规格（statusbar.js）

- 挂载：输入框容器下方插入居中 flex 行；预留 ≥22px 高度防跳动；控件间 12px；距输入卡片 4px。
- 控件：图标 14×14 + 数字文本；padding 1px 8px；圆角 8px；透明背景，hover 升亮 + 淡灰背景。
- 字体：数字 `font-family: var(--zcode-font-mono, <官方 mono 栈>)`、字号 `calc(var(--zcode-font-text-sm-size, 12px))`、`font-variant-numeric: tabular-nums`、字重 400、基色 `var(--zcode-color-text-secondary, foreground-subtle)`。注入时从宿主 computed style 采样官方变量并以 CSS 变量注入，取不到时落默认栈（mono 栈见 research/zcode-official-context.md）。
- 官方圆环增强：不改动按钮结构，仅覆盖 SVG 描边色（ramp 上下文色阶）+ hover 提示行；点击仍走官方面板。圆环缺席时增强逻辑静默。
- 弹层/菜单：全 DOM 自绘，Escape/外点关闭；文案跟随宿主语言（无宿主语言信号时中文）。

## 5. 安装 / 卸载 / 更新（补缺口设计）

- 安装：SessionStart hook 同步源码到运行目录 → asar stage → 语法/入口自检 → 原子替换 → 注入行指向运行目录。跨进程锁 + 来源指纹校验照搬原实现。
- 卸载（单一入口 `uninstall`，三条路径都收敛到它）：
  1. 引擎补丁 `restore()` 反向剥离（缺口①：插件 remove 钩子显式调用）；
  2. ZIP 预注入撤销：记录已预注入清单于运行目录 state 文件，卸载时逐条还原（缺口②）；
  3. asar 剥离失败 → 保留运行目录与 state 文件并输出修复指引（缺口③），绝不"失败也删目录"。
- 卸载保留：用户配置（显示开关等）、SQLite 统计数据、日志。
- 更新：Release 元数据 → 渠道/版本/文件集/SHA256 校验 → 原子落盘 → 热换（renderer/Python/主进程子模块）；loader/静态桥级变更置"待重启"标记，齿轮菜单显示。
- 降级保护：hash 基线 + mtime 迁移 + journal 照搬，阻止旧版本覆盖。

## 6. 兼容与降级

- 宿主版本登记表（renderer 锚点 = 版本 + SHA256 + 唯一锚点）；未登记版本严格推导，失败降级为"不显示状态条，仅保留 SQLite 查询能力"，绝不盲注。
- 引擎补丁仅作用于登记 SHA；未知版本跳过并在诊断里注明。
- 界面字号：CSS 变量随宿主 `--ui-font-size` 派生；宿主字号变更事件未覆盖插件时，下次注入生效（已知限制，写入 README）。

## 7. 测试策略

- 移植并改写原项目回归：安装竞态/篡改/权限（test_pending_asar 模式）、升级保护、热换、速度口径（双口径+边界 200ms/1h）、上下文兜底。
- ramp.js 纯函数测试：锚点值、域外值、插值单调性、估算态标记。
- 卸载闭环专项：三缺口各一条端到端用例（临时目录内模拟 asar/ZIP/引擎文件）。
- 实机人工验收清单：真实 hover、多窗口/分栏隔离、Highspeed 隐藏场景、Windows 文件占用、界面字号缩放、深浅主题。

## 8. 权衡记录

- 连续渐变 vs 离散档位：选连续（访谈决策 4），代价是阈值不可解释 → 用 tooltip 数值补偿。
- 增强官方圆环 vs 双圆环：选增强（决策 5），代价是与官方按钮实现耦合 → 已有版本登记降级路径兜底。
- 零费用/零凭据（决策 7）：Usage 弹层信息量下降，换取零凭据边界与更小攻击面。

## 9. 模块契约（分派实现的接口基线）

命名基线：插件 id `zcode-statusbar`；运行目录 `~/.zcode/zcode-statusbar/`；代码注释一律中文。

- **statusbar/ramp.js**（纯函数，无 DOM、无依赖，CommonJS + ESM 双兼容导出）：
  - `speedColor(tokPerSec: number) -> string`：0 红 → 150 绿 → 800 蓝 → ≥2000 紫，hsl 分段线性插值，域外钳制。
  - `contextColor(pct: number) -> string`：入参 0–1；0 绿 → 0.5 黄 → 0.9 红 → 1 深红，同插值规则。
  - 导出 `SPEED_ANCHORS`、`CONTEXT_ANCHORS` 常量与两条映射函数；估算态的呼吸动画由 CSS 承担，ramp 不管。
- **statusbar/turn-stats.js**（renderer 注入，无模块系统，IIFE）：
  - 采样字符增量 → `window.__ZCODE_STATUSBAR_TURN__ = { tokPerSec, estimated: true, updatedAt }`，并派发 `window` 事件 `zcode-statusbar:turn`。
- **statusbar/session-stats.cjs**（主进程，CommonJS）：
  - `aggregate(rows) -> { sessionAvgTokPerSec, cacheHitRate, totalTokens, subagent: { activeCount, activeTokPerSec, sessionTokens } }`；口径遵循 R2/R5（200ms ≤ 窗 < 1h、不含子代理）。
- **statusbar/statusbar.js**（renderer 注入 UI，IIFE，无框架）：
  - 挂载输入框下方居中条；数据来源 = `window.__ZCODE_STATUSBAR_TURN__`（速度）+ 主进程推送事件 `zcode-statusbar:session`（会话聚合）+ 官方圆环节点探测（上下文）。
  - 所有宿主样式经 CSS 变量（`--zcode-font-mono` 等）注入，采样失败落默认栈。
- **renderer 静态桥**（内核注入，主进程侧执行）：
  - 暴露 `window.__ZCODE_STATUSBAR_BRIDGE__ = { getPaneId(), getSessionSnapshot() }`；身份不可确认时两者返回 null，状态条据此拒绝渲染。
- **zusage.py**：CLI 输出 JSON（原结构减去价格/额度/汇率字段）；供 session-stats.cjs 与诊断使用。
- 各模块实现若与契约有偏差，必须在模块顶部注释中记录偏差与原因，交检查代理核对。
