# CONTRACT — 状态条模块间契约（v0.1.0 基线）

> 本文是 `turn-stats.js` / `session-stats.cjs` / `statusbar.js` 三者之间，以及它们与内核（接入内核、加载器）、
> 与宿主 DOM 之间的接口契约。基线来源：design.md §9。实现中的偏差已在各模块顶部注释与本文 §8 登记供检查代理核对。
> 任何字段/事件改名必须先改本文。

## 1. 模块关系与注入顺序

```
加载器（内核 inject-main.cjs → executeJavaScript，按序注入 renderer）
  ① statusbar/ramp.js        → 组装为 window.__ZCODE_STATUSBAR_RAMP__（见 §4）
  ② statusbar/turn-stats.js  → IIFE 自装配，产出 turn 样本（§2.1 / §3.1）
  ③ statusbar/statusbar.js   → IIFE 自装配，读全局、听事件、渲染 UI
主进程
  statusbar/session-stats.cjs → 内核定期调用 aggregate(rows)，经 webContents 推送 session 事件（§3.2）
内核静态桥（主进程侧执行，先于上述注入）
  暴露 window.__ZCODE_STATUSBAR_BRIDGE__（§2.4）
```

注入顺序约束：ramp 必须先于 statusbar.js（后者每次使用时动态读全局，晚到也能生效，但建议按序）；
bridge 必须先于 statusbar.js 的首次挂载探测（常驻 1s 轮询，无「放弃窗口」），否则首轮取不到身份（防串数，R10）。

## 2. 全局变量

| 全局 | 生产者 | 消费者 | 说明 |
|---|---|---|---|
| `__ZCODE_STATUSBAR_TURN__` | turn-stats.js | statusbar.js | 最新 turn 样本（§3.1），每次采样整体覆盖 |
| `__ZCODE_STATUSBAR_TURN_API__` | turn-stats.js | 内核/诊断 | `{ setCharsPerToken(v), calibrateFromTurn({outputTokens, charCount}), reset(), stop() }`（自校准钩子） |
| `__ZCODE_STATUSBAR_RAMP__` | 加载器（组装自 ramp.js） | statusbar.js | `{ speedColor(tokPerSec), contextColor(pct0to1) }`；缺失 → 数字与上下文圆环退中性灰 |
| `__ZCODE_STATUSBAR_BRIDGE__` | 内核静态桥 | statusbar.js | `{ getPaneId(): string\|null, getSessionSnapshot(): object\|null }`；身份不可确认两者返回 null |
| `__ZCODE_STATUSBAR_VERSION__` | 加载器（可选） | statusbar.js | 版本号字符串；缺省内置 `'0.1.0'`（与 package.json 同步） |
| `__ZCODE_STATUSBAR_I18N__` | 加载器（可选） | statusbar.js | 文案覆盖对象，键见 statusbar.js 的 I18N 常量（宿主语言覆盖点） |
| `__ZCODE_STATUSBAR_STREAM_LENGTH__` | 内核（可选钩子） | turn-stats.js | 函数，返回当前流式输出文本长度（store 直喂，优先于 DOM 选择器） |
| `__ZCODE_STATUSBAR_STREAM_SELECTORS__` | 内核/诊断（可选） | turn-stats.js | 数组，覆盖默认 DOM 选择器候选 |

## 3. window 事件（全部在 `window` 上派发/监听）

| 事件 | 方向 | detail | 说明 |
|---|---|---|---|
| `zcode-statusbar:turn` | turn-stats → statusbar | turn 样本（§3.1） | 每 100ms tick 有可读长度时派发 |
| `zcode-statusbar:session` | 内核主进程 → statusbar | aggregate 输出（§3.2） | 内核建议周期 ≥1.5s（SQLite 300ms 去抖 + ≥1500ms 节流） |
| `zcode-statusbar:refresh` | statusbar → 内核 | `{ paneId }` | 齿轮"立即刷新"：内核重查 SQLite 并重发 session 事件 |
| `zcode-statusbar:reset-session` | statusbar → 内核 | `{ paneId }` | 齿轮"重置会话统计"：内核侧清统计；statusbar 本地同步清显示 |
| `zcode-statusbar:check-update` | statusbar → 内核 | `{ paneId, from: 'gear-menu' }` | 仅派发，更新流程全在内核（R9） |
| `zcode-statusbar:uninstall` | statusbar → 内核 | `{ paneId, from: 'gear-menu' }` | 仅派发，卸载流程全在内核（R8） |

## 4. 数据形状

### 4.1 turn 样本（`__ZCODE_STATUSBAR_TURN__` / `zcode-statusbar:turn` detail）

```js
{ tokPerSec: number, estimated: true, updatedAt: number /* ms */ }
```

- `estimated` 恒为 true（本模块只产估算值）；核实值来自 session 数据的 `sessionAvgTokPerSec`。
- 无增量 → `tokPerSec` 归零（不冻结旧值）；文本回落 → 视为新轮重置窗口。
- statusbar 侧新鲜度：`Date.now() - updatedAt < 3000ms` 视为"生成中"（估算态），否则切回核实态。

### 4.2 session 数据（`zcode-statusbar:session` detail = `aggregate(rows, now?)` 返回）

```js
{
  turns: number,                  // 轮次 = 主会话完成请求数
  steps: number,                  // 步数 = 主会话完成工具调用数（kind==='tool'）
  sessionAvgTokPerSec: number|null, // R2 完成态：Σ输出 ÷ Σ有效时长（null = 无有效窗口）
  cacheHitRate: number|null,      // 0–1；Σcache_read ÷ Σinput（null = input 为 0）
  totalTokens: number,            // input + output（缓存已含 input，不重复加）
  tokens: { input, output, cacheRead, cacheWrite },  // R6 Usage 弹层分项
  timing: { modelTimeMs, toolTimeMs, ttftMs },       // R6 Activity 弹层；ttftMs = 均值
  speedTrend: [{ t: number, tokPerSec: number }],    // 最近 ≤10 完成轮，t = completedAt
  subagent: {
    activeCount: number,          // status==='running' 的子代理数
    activeTokPerSec: number|null, // 运行中子代理 Σ输出 ÷ Σ(now−首字) ，200ms 下限
    sessionTokens: number,        // 子代理 Σ(input+output)
    rows: [{ id, model, status, outputTokens }]        // R6 子代理明细，最近 ≤20 行
  },
  tools: {                        // R6 工具调用明细（扩展，见 §8 偏差 10）：对齐原插件口径，含 error 行，running 不计
    total: number,                // completed+error 工具调用总次数
    errors: number,               // status==='error' 的次数
    list: [{ name, count, durationMs, errors }]        // 按工具名聚合（name 取行 model）；count 降序、同次数按名升序；
                                  // durationMs = Σ(completedAt−startedAt) 含 error 行，时间戳缺失/倒挂的行不计；
                                  // timing.toolTimeMs 仍仅算 completed 行（既有口径不动）
  }
}
```

### 4.3 aggregate 输入行（内核从 SQLite 投影；非有限数值 = 缺失，逐行跳过）

```js
{
  id: string,
  sid: string,                      // 投影来源会话 id（扩展）：内核按窗口焦点会话过滤聚合（R10 防串数）
  kind: 'model' | 'tool',           // 缺省按 'model'
  isSubagent: boolean,              // 缺省 false
  model: string,
  thinking: boolean,                // 思考请求标记（决定 started_at 窗）
  status: 'running' | 'completed' | 'error',  // 仅 'completed' 计入完成态（严格判定）
  startedAt: number,                // ms
  firstTokenAt: number|null,        // 首字时间；缺 → 首字窗退 started_at 窗
  completedAt: number|null,
  inputTokens: number,              // 含缓存（cache_read/cache_write 已在内）
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number
}
```

口径（R2/R5）：有效生成窗 200ms ≤ 窗 < 1h；思考/`model` 含 `claude`（不分大小写）用
`completed_at − started_at`，其余用 `completed_at − first_token_at`；子代理不计入主口径任何字段。

## 5. ramp 依赖与加载器组装

ramp.js 由并行代理实现（CommonJS + ESM 双兼容，导出 `speedColor` / `contextColor` / `SPEED_ANCHORS` / `CONTEXT_ANCHORS`）。
**加载器职责**：`require` ramp.js 后挂到 renderer：

```js
window.__ZCODE_STATUSBAR_RAMP__ = { speedColor: m.speedColor, contextColor: m.contextColor };
```

statusbar.js 内部不 `require`（renderer 注入场景）；`rampApi()` 每次使用时动态读全局，ramp 晚到即自动生效。
次级来源：ramp.js 在无模块系统环境会兜底挂 `globalThis.ZCodeStatusbarRamp`（同形状），statusbar.js 也会读取它。
ramp 缺失的降级：速度/子代理速度数字与上下文圆环描边均保持基色（中性灰）。

## 6. 宿主 DOM 依赖（只读，不改写）

状态条的挂载与上下文数据都依赖宿主 DOM 锚点。**全部只读**：插件不写宿主节点任何属性、class 或样式。

| 锚点 | 用途 | 失效行为 |
|---|---|---|
| `[data-session-id]`（SessionPane 根，`SessionPane.tsx:5938`） | 会话身份门：值为 `"draft"` 即首页/新建任务，不渲染 | 找不到所属 pane → 按无会话处理，不渲染 |
| `MOUNT_ANCHORS`（statusbar.js） | 输入框容器（挂载位置） | 未命中 → 不渲染，下一轮轮询重试 |
| `[data-usage-used]` / `[data-usage-max]`（V4ComposerToolbar 隐藏 span，`V4ComposerToolbar.tsx:1263-1264`） | 上下文占用 `used` / `size`，与官方面板同源同口径 | 读不到或 `used <= 0` / `size <= 0` → 上下文 pill 整只隐藏，其余控件不受影响 |

**探测周期**：1s 常驻轮询（`MOUNT_POLL_MS`）。SPA 内切换任务不重新注入 renderer 脚本，
因此不能用「N 次后放弃」的一次性窗口：进入会话要及时出现，回到 draft 要及时消失。

**会话切换**：每轮轮询核对「当前锚点 + 已挂 DOM 是否仍在」，不等则拆条重建；全局监听只注册一次，
不随重挂叠加（`bindGlobalEvents` 与 `bindBarEvents` 分离）。

## 7. 持久化与其他键

- localStorage `zcode-statusbar.pills`：`{ activity, usage, context, subagent, gear }` 五个布尔显示开关（R7，即时生效，卸载保留）。
- DOM：statusbar.js 样式节点 id `zcode-statusbar-style`；条根元素 class `zsb-bar`；pill 标记 `data-zsb-pill`；
  pill 名 `activity` / `usage` / `context` / `subagent` / `gear`；上下文圆环填充环 class `zsb-ring-fill`。
- CSS 变量：`--zcode-font-mono` / `--zcode-font-text-sm-size` / `--zcode-color-text-secondary`（宿主值采样自
  `--font-mono` / `--text-ui-sm` / `--color-foreground-subtle`，缺省官方 mono 栈与 12px，见 R12 与 research）。

## 8. 内核对齐点（并行代理/后续工作须知）

1. **注入顺序**：bridge → ramp → turn-stats → statusbar（§1）。
2. **session 推送**：主进程调 `session-stats.cjs` 的 `aggregate(rows)`，经 `webContents.executeJavaScript`
   或桥转发为 window 事件 `zcode-statusbar:session`（detail = aggregate 返回对象，勿再包裹）。
3. **轮结束自校准**（可选，**暂缓**）：内核在轮完成后调 `__ZCODE_STATUSBAR_TURN_API__.calibrateFromTurn({ outputTokens, charCount })`。
   现状：内核拿不到每轮的流式字符数（DB 行无 charCount，渲染端轮结束信号未接），暂按默认 2 字符/token；
   接线方案见 `.trellis/tasks/11-06-statusbar-design/research/acceptance-checklist.md`。
4. **store 直喂**（可选，优先于 DOM 选择器）：内核暴露 `__ZCODE_STATUSBAR_STREAM_LENGTH__` 返回流式文本长度。
5. **选择器校准**：`MOUNT_ANCHORS`（statusbar.js）、`STREAM_SELECTORS`（turn-stats.js）为启发式候选，
   需在实机登记宿主版本后校准；失效路径均为静默（不渲染/停采）。宿主锚点表见 §6。
6. **齿轮事件**：内核通过**注入事件桥接 shim** 消费 `zcode-statusbar:refresh` / `:check-update` / `:uninstall`
   （shim 把 window 事件翻译进 `__ZCODE_STATUSBAR_REQUESTS__` 队列，由 pollPluginRequests 白名单执行；
   见 core/inject-main.cjs 的 EVENT_SHIM / forceRefresh / runUninstallAndRelaunch）。
   `:reset-session` 无内核消费方：纯渲染端行为（本地清显示），事件保留作扩展点。
7. **身份**：桥缺失或 `getPaneId()` 为空时 statusbar 不渲染（常驻轮询，身份恢复即自动挂上）；
   诊断文本可从菜单"复制诊断"获取。

## 8. 与 design §9 的偏差登记（汇总）

| # | 偏差 | 原因 | 位置 |
|---|---|---|---|
| 1 | turn-stats.js 在 node 环境额外导出 `{ createTurnSampler, CONSTANTS }`（浏览器仍为无模块系统 IIFE） | node:test 覆盖采样逻辑；renderer 注入路径不变 | turn-stats.js 头注释 |
| 2 | 字符增量来源退化为"DOM 文本长度差"，另留 `__ZCODE_STATUSBAR_STREAM_LENGTH__` 直喂钩子 | 任务说明允许通用思路；钩子供内核日后接回 store | turn-stats.js 头注释 |
| 3 | `aggregate(rows, now?)` 增加可选 now 参数 | 子代理活跃速度需当前时间；测试注入时钟 | session-stats.cjs 头注释 |
| 4 | aggregate 返回值扩展 `turns/steps/tokens/timing/speedTrend/subagent.rows` | R1 轮次·步数与 R6 弹层需要；基线四字段语义不变 | session-stats.cjs 头注释 |
| 5 | `status` 严格判定（仅 `'completed'` 计入完成态） | 宁可少算不可串数（R10） | session-stats.cjs 头注释 |
| 6 | 齿轮"重置会话统计"为派发事件 + 本地清显示 | 用户即时反馈 | statusbar.js 头注释 |
| 7 | 检查更新/卸载仅派发事件（内核执行），事件名见 §3 | 任务要求"仅派发事件给内核" | statusbar.js 头注释 |
| 8 | 上下文占用改为状态条自带圆环 pill，读宿主隐藏锚点 `[data-usage-used]/[data-usage-max]`；原设计「增强官方圆环」作废 | 官方 `data-usage-used` 在独立隐藏 span 上，不在圆环 SVG 祖先链内，`closest()` 取不到；aria 文案为 `上下文已用 {used} / 总量 {total}`，无百分比也无 `a/b` 形态，两条解析路径均无效。改为自绘 pill 后官方 DOM 零改写 | statusbar.js 头注释 |
| 9 | 挂载门控读 `[data-session-id]`（`"draft"` 不渲染），探测从「10s 后放弃」改为 1s 常驻轮询 | 首页/新建任务无会话数据；SPA 内切换任务不重注入脚本，需随会话进出动态挂载/卸载 | statusbar.js 头注释 |
| 10 | aggregate 返回值再扩展顶层 `tools` 明细分组（含 error 行时长；timing.toolTimeMs 既有口径不动） | 对齐原插件工具调用明细 | session-stats.cjs 头注释 |
