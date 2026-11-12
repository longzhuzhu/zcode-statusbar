# CONTRACT — 状态条模块间契约（v0.1.2 基线）

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
| `__ZCODE_STATUSBAR_BRIDGE__` | 内核静态桥 | statusbar.js | `{ getPaneId(): string\|null, getSessionSnapshot(): object\|null, getContextBreakdown(): object\|null }`；身份不可确认时三者返回 null |
| `__ZCODE_STATUSBAR_VERSION__` | 加载器（可选） | statusbar.js | 版本号字符串；缺省内置 `'0.1.2'`（与 package.json 同步） |
| `__ZCODE_STATUSBAR_I18N__` | 加载器（可选） | statusbar.js | 文案覆盖对象，键见 statusbar.js 的 I18N 常量（宿主语言覆盖点） |
| `__ZCODE_STATUSBAR_STREAM_TEXT__` | 内核（可选钩子） | turn-stats.js | 函数，返回当前流式输出文本；优先于长度钩子与 DOM |
| `__ZCODE_STATUSBAR_STREAM_LENGTH__` | 内核（可选钩子） | turn-stats.js | 函数，返回当前流式输出文本长度（store 直喂，优先于 DOM 选择器） |
| `__ZCODE_STATUSBAR_STREAM_SELECTORS__` | 内核/诊断（可选） | turn-stats.js | 数组，覆盖默认 DOM 选择器候选 |
| `__ZCODE_STATUSBAR_DIAG__` | statusbar.js | 内核（diag 轮询） | `{ version, stage, ts, mounted, paneId, lastError, hasBridge, hasRamp, hasTurn, hasSession }`；挂载各分支实时更新，供 `diag-<n>.json` 落盘 |

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
- `updatedAt` 是最近文本增量时间，空闲 tick 不刷新它，3s 后 UI 回到会话均值。
- DOM 文本按中日韩字符约 1 字/token、ASCII 约 4 字/token、其余 Unicode 约 2 字/token 估算；仍非分词器精确值。显式校准后使用 charCount/outputTokens 系数。长度钩子保留默认 2 字/token。
- statusbar 侧新鲜度：`Date.now() - updatedAt < 3000ms` 视为"生成中"（估算态），否则切回核实态。

### 4.2 session 数据（`zcode-statusbar:session` detail = `{ ...zusage 快照, aggregate }`）

detail 顶层是 zusage 快照原样（`today` / `session` / `recent` / `known_sids` 等，§4.5 记 `today`）；
`aggregate` 键是下列聚合结果。UI 消费 `aggregate` 与顶层 `today`，其余键忽略。

```js
{
  turns: number,                  // 轮次 = 不同 turnId 的已完成 model 行数（用户输入轮；turnId 缺失按行计）
  steps: number,                  // 步数 = 主会话完成工具调用数（kind==='tool'）
  sessionAvgTokPerSec: number|null, // R2 完成态：Σ输出 ÷ Σ有效时长（null = 无有效窗口）
  cacheHitRate: number|null,      // 0–1；Σcache_read ÷ Σinput（null = input 为 0）
  totalTokens: number,            // input + output（缓存已含 input，不重复加）
  tokens: { input, output, cacheRead, cacheWrite },  // R6 Usage 弹层分项
  timing: { modelTimeMs, toolTimeMs, ttftMs },       // R6 Activity 弹层；ttftMs = 均值
  speedTrend: [{ t: number, tokPerSec: number }],    // 最近 ≤10 个完成请求，t = completedAt；
                                  // tokPerSec 与 sessionAvgTokPerSec 同口径（单请求 = output ÷ 有效生成窗（§4.3））
  subagent: {
    activeCount: number,          // status==='running' 的子代理数（按 list 统计，含仅有投影行的运行中条目）
    activeTokPerSec: number|null, // 运行中子代理 Σ输出 ÷ Σ(now−首字) ，200ms 下限
    sessionTokens: number,        // 子代理 Σ(input+output)
    rows: [{ id, model, status, outputTokens }],       // 旧形状，保留兼容；最近 ≤20 行
    list: [subagentItem]          // 面板条目（§4.2.1），运行中在前按 startedAt 升序，已完成按 endedAt 降序
  },
  tools: {                        // R6 工具调用明细（扩展，见 §8 偏差 10）：对齐原插件口径，含 error 行，running 不计
    total: number,                // completed+error 工具调用总次数（UI 不再展示，聚合仍产出）
    errors: number,               // status==='error' 的次数（UI 不再展示，聚合仍产出）
    list: [{ name, count, durationMs, errors }]        // 按工具名聚合（name 取行 model）；count 降序、同次数按名升序；
                                  // durationMs = Σ(completedAt−startedAt) 含 error 行，时间戳缺失/倒挂的行不计；
                                  // timing.toolTimeMs 仍仅算 completed 行（既有口径不动）
                                  // UI 每行只渲染 count 与 durationMs（§8 偏差 16）
  }
}

```

### 4.3 aggregate 输入行（内核从 SQLite 投影；非有限数值 = 缺失，逐行跳过）

```js
{
  id: string,
  sid: string,                      // 投影来源会话 id（扩展）：内核按窗口焦点会话过滤聚合（R10 防串数）
  turnId: string|null,              // 用户输入轮标识（扩展）：同一轮工具循环产生的多次模型请求共享一个
                                    // turn_id；null = 旧库缺列，按「独立一轮」计（宁可多算，不丢轮次）
  parentSid: string|null,           // 行所属父会话（扩展）。子代理行的 sid 是子会话 id
                                    // （sess_subagent_*），与父会话永不相等，内核按 parentSid 分桶；
                                    // null = 该行本就属于主会话，分桶回落 sid
  kind: 'model' | 'tool' | 'subagent',  // 'model' 缺省；'subagent' 见 §4.3.1
  isSubagent: boolean,              // 缺省 false
  model: string,
  thinking: boolean,                // 思考请求标记；保留首字前思考阶段
  status: 'running' | 'completed' | 'error',  // 仅 'completed' 计入完成态（严格判定）
  startedAt: number,                // ms
  firstTokenAt: number|null,        // 首字时间；仅供旧库 TTFT 展示，不用于缩窗
  completedAt: number|null,
  durationMs: number|null,           // model 行：宿主相对请求耗时；旧库缺列为 null
  ttftMs: number|null,               // model 行：宿主相对首字延迟；旧库缺列为 null
  inputTokens: number,              // 含缓存（cache_read/cache_write 已在内）
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  subagentType: string|null,        // 仅 kind='subagent'：subagent_type，如 'Explore'
  task: string|null,                // 仅 kind='subagent'：Agent 工具的 description
  childSessionId: string|null       // 仅 kind='subagent'：sess_subagent_+agentId，运行中为 null
}
```

口径（R2/R5）：有效生成窗 200ms ≤ 窗 < 1h；优先用正的 `durationMs`，缺失时回退
`completedAt − startedAt`。普通输出扣除有效 `ttftMs`；`thinking` 或 Claude 请求保留完整
思考阶段（output 已含思考 token）。TTFT 为负、非有限、占总时长 ≥97%，或扣除后窗口
不足 200ms 时回退完整请求耗时，避免旧宿主队列 flush 时间被误当首字时间。
不使用 `firstTokenAt` 缩窗。缺失、非有限或非正输出不参与速度分子与分母。
会话均值、趋势和子代理完成态共用此窗口选择；模型总用时仍保留完整请求跨度。

#### 4.3.1 `kind='subagent'` 行（子代理生命周期记录）

一条 Agent 工具调用出一行。它承载**存在性与任务名**，`inputTokens` / `outputTokens` 等 token 分项恒为 0
（子代理的 token 由 `kind='model'` 且 `isSubagent=true` 的子会话行承担，两处不重复计）。

必须单独成 kind 而非复用 `kind='tool'`：聚合层把 `kind='tool'` 计为工具调用次数，
运行中的子代理若走 `kind='tool'` 会污染 `steps`。聚合层对 `kind='subagent'` 行的处理是
「不进主口径、不进 `subRows`、只进 `subagent.list`」。

运行中的子代理在宿主 `model_usage` 里没有记录（请求完成才落库），`kind='subagent'` 行是它存在的唯一证据。

#### 4.3.2 `subagentItem`（`subagent.list` 元素）

两态共用一种形状，靠 `status` 判别，不设 `isRunning` / `isDone` 之类的布尔。

```js
{
  key: string,                  // 去重键：有子会话时用 childSessionId，否则用 toolCallId
  toolCallId: string|null,      // Agent 工具调用 id，运行中必有
  childSessionId: string|null,  // sess_subagent_+agentId，运行中为 null
  type: string|null,            // subagent_type；缺 part 时为 null（不猜）
  task: string|null,            // Agent 输入的 description；缺 part 时为 null
  status: 'running' | 'completed' | 'error' | 'cancelled',
  startedAt: number|null,
  endedAt: number|null,         // 运行中恒为 null
  durationMs: number|null,      // 运行中 = now − startedAt（实时）；已结束 = endedAt − startedAt
  requests: number,             // 已完成请求数（运行中为 0）
  inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens: number,
  tpsAvg: number|null           // 已完成段加权平均；运行中为 null（不虚构速度）
}
```

合并规则：`kind='subagent'` 行提供存在性与任务名，`kind='model'` 且 `isSubagent` 的行按
`childSessionId` 回填 token 与请求数。对不上任何投影行的 model 行独立成条（token 有、任务名为 null），
不与其他子代理合并。条目上限 `SUBAGENT_DETAIL_MAX`（20）。

### 4.4 上下文来源明细（`bridge.getContextBreakdown()` 返回）

上下文弹层的分段条与图例数据源。桥做**窄投影**，只取宿主 `snapshot.usage.contextWindow`
的三个字段并逐项浅拷贝，绝不把整份会话快照搬到渲染端（`getSessionSnapshot` 是深拷贝，
长会话点一次弹层要拷掉全部消息行，故不用于此路径）。

```js
{
  used: number|null,                // 宿主 usedTokens（数值缺失/非有限 → null）
  size: number|null,                // 宿主 maxTokens
  breakdown: [{ source: string, chars: number }] | null
}
```

- `breakdown` 逐项过滤：`source` 非字符串、`chars` 非有限正数的项直接丢弃；过滤后为空 → `null`。
- 返回 `breakdown: null` 时 UI 退化为单色进度条且**不渲染图例**（不伪造分项）。
- `source` 枚举由宿主定义（`system_prompt` / `meta_user_context` / `skills` / `tool_prompt` /
  `system_tool_schemas` / `mcp_tool_schemas` / `messages`）。statusbar.js 用 `CTX_BUCKET_OF`
  表把它们归三桶（系统提示词 / 工具定义 / 对话消息），**未登记的 source 不计入**，
  比例在已知来源内归一。
- 图例读数域是**占比**（桶内 chars ÷ 全部已知 chars），不是 deepseek 的原始 token 数。
- 只在弹层打开时读一次，不进 1s 渲染循环；会话切换（`unmountBar`）时连同 `state.context` 一并清空。
- 桥无 `getContextBreakdown` 时 statusbar.js 回退到 `getSessionSnapshot().snapshot.usage.contextWindow.breakdown`。

### 4.5 顶层 `today` 块（全库今日口径，「今日用量」分组的数据源）

```js
{
  requests: number,               // 今日 completed 请求数
  input: number,                  // Σinput_tokens（含缓存）
  output: number,                 // Σoutput_tokens
  cache_read: number,             // Σcache_read_input_tokens
  cache_write: number,
  total: number,                  // Σcomputed_total_tokens（= input + output，实库 3208 行 0 条不符）
  reasoning: number, retries: number,
  started: number, last_at: number
}
```

口径是**全库当日**已完成行（`zusage.py:_today_usage`，按 `completed_at` 落在本地日内过滤），
与 §4.2 的本会话口径互不相干。UI 渲染 `input + output` 为「token 总用量」、
`cache_read ÷ input` 为「平均缓存率」；`today` 缺失（直接推 aggregate 的兼容路径）时整组不渲染，
不留空壳、不拿零值冒充。UI 侧独立存 `state.today`：会话聚合未变的新帧也会更新它。

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
  pill 名与视觉顺序 `activity` / `usage` / `subagent` / `context` / `gear`；上下文圆环填充环 class `zsb-ring-fill`；
  子代理运行态绿点 class `zsb-livedot`（附 `zsb-pulse` 呼吸）；
  子代理面板行 `data-subkey`（值为条目 `key`）、行状态点 class `zsb-subdot`（运行中加 `zsb-live` 标绿）、
  返回按钮 `data-act="sub-back"`。
- 子代理 pill 的显隐不只看开关：本会话从未出现过子代理时整只不占位，出现过后常驻。
  粘滞标志 `state.subSeen` 是会话级状态，`unmountBar()`（换会话）时重置，跨会话不继承。
  用户开关优先级更高：`visible.subagent === false` 时粘滞标志不使它显示。
- 子代理 pill 双态：运行中 = 绿点 · 速度（不显示活跃数，个数见面板分组标题）；闲 = 会话累计 token。
- CSS 变量：`--zcode-font-mono` / `--zcode-font-text-sm-size` / `--zcode-color-text-secondary`（宿主值采样自
  `--font-mono` / `--text-ui-sm` / `--color-foreground-subtle`，缺省官方 mono 栈与 12px，见 R12 与 research）；
  `--zsb-live`（子代理运行态绿点，深色 `#3ecf8e` / 浅色 `#0c8a63`，由 `applyThemeVars` 按主题写入）。

## 8. 内核对齐点（并行代理/后续工作须知）

1. **注入顺序**：bridge → ramp → turn-stats → statusbar（§1）。
2. **session 推送**：主进程调 `session-stats.cjs` 的 `aggregate(rows)`，经 `webContents.executeJavaScript`
   或桥转发为 window 事件 `zcode-statusbar:session`（detail = aggregate 返回对象，勿再包裹）。
3. **轮结束自校准**（可选，**暂缓**）：内核在轮完成后调 `__ZCODE_STATUSBAR_TURN_API__.calibrateFromTurn({ outputTokens, charCount })`。
   现状：内核拿不到每轮的流式字符数（DB 行无 charCount，渲染端轮结束信号未接），暂按默认 2 字符/token。
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
| 11 | 上下文弹层从「三行 key-value + 单色条」改为 deepseek `ContextMeter` 形态（头部一行读数 + 分段条 + 图例若干行，图例值域为占比）；桥新增窄投影 `getContextBreakdown()` | 用户要求对齐 deepseek 上下文窗口样式并保留字段占比。分段/图例需 breakdown，`getSessionSnapshot` 深拷贝整份会话不适合高频路径，故新增只投影三个字段的读取器 | statusbar.js `buildContextDetail` / `core/statusbar-bridge.js`；§4.4 |
| 12 | `turns` 口径从「主会话完成请求数」改为「按 `turnId` 去重的用户输入轮数」；§4.3 行新增可选 `turnId` | 一轮的工具循环产生多次模型请求，按行计数把 1 轮数成 N 轮（实测 51 轮对应真实 2 个用户输入）。`turn_id` 列在现网库无空值；旧库缺列时 `_has_column` 探测降级为 `NULL as turn_id`，聚合端按独立一轮兜底 | `zusage.py` `_project_request_rows` / `session-stats.cjs` `countTurns`；§4.2/§4.3 |
| 13（已由 18 替代） | 状态条用负 margin 下沉 `--zsb-sink` 占住宿主 dock 留白（`pb-4`+面板 `pb-1`）；弹层 `bottom` 同量抬回 | 状态条插在 `[data-v4-composer]` 之后，下方留着宿主 20px 底部内边距成为死区（实机红框）。下沉量由 `sinkIntoDockGap` 实测 `padding-bottom`（上限 24px 防误判），读不到时用 CSS 缺省 20px | statusbar.js `.zsb-bar` / `sinkIntoDockGap` |
| 14（已由 17 替代） | 速度口径统一为 `completedAt − startedAt`，删除 `windowBasis` 的思考/Claude 分支与首字缩窗 | 宿主 `first_token_at` 来自流式事件时间戳，而该时间戳在写队列 flush 时才赋值（`model-streaming-event-queue.ts` 把 append 串行化），首个增量块的时间戳因此落到请求末尾。实测该列位于请求跨度的 97%–100% 处，1501 条请求中 632 条的首字窗不足 30ms。沿用首字窗时这 632 条算出 >1000 tok/s（中位首字窗 26ms，全窗中位 5310ms），趋势图出现 5927 tok/s 的虚假尖峰；改全窗后同一批数据中位 50、p95 141、峰值 223，无一条超 500。首字时间仍用于 TTFT 展示 | session-stats.cjs `rowWindowMs`；§4.2/§4.3 |
| 15 | 速度趋势从折线渲染改为单调三次贝塞尔曲线（Fritsch–Carlson 切线钳制） | 逐点折线在 64px 高度内呈锯齿状；Catmull-Rom 类插值会在峰谷过冲、画到峰值网格线之外。切线取相邻斜率的加权调和均值，段间保持单调，实测曲线 y 值域等于原始数据点值域 | statusbar.js `smoothPath` / `buildTrendSvg` |
| 16 | 用量弹层三处调整：① 工具调用去掉合计行与每行错误计数（`tools.total`/`tools.errors`/`item.errors` 仍由聚合层产出，只是不渲染）；② 用量分组底部补「缓存占比」（会话口径 `cacheHitRate`）；③ 新增「今日用量」分组（`today` 块，全库口径）。 | 三个口径混在一个无分组边界的长列表里：合计行与每行尾部错误计数属噪音，而用户要看的是「本会话用量」与「今日用量」两块可比的读数；缓存命中率此前只在状态条 pill 上显示，弹层里看不到 | statusbar.js `buildUsageDetail` / `buildTodaySection`；§4.2 / §4.5 |
| 17 | 速度优先相对耗时与有效 TTFT；排除无输出请求 | 修正前置等待拉低速度，同时保留队列 flush 保护；实时采样区分文字类型，空闲样本不刷新新鲜度；活动弹层 TPS 随条更新 | §4.1 / §4.3 |
| 18（已由 19 替代） | 移除下沉负 margin；条底保留 8px 外边距，弹层距条 10px | 保留宿主 dock 留白，hover 区域不贴窗口边缘；替代偏差 13 | statusbar.js 样式 |
| 19 | 上方默认 4px；按实际几何补偿最多 24px 的宿主底部留白，使条到窗口底边的距离等于条到输入框的距离 | 固定 8px 外边距叠加宿主 padding 后下方约 24px，上下失衡。只调整插件自身 margin，挂载、渲染与容器尺寸变化时重测；远离底部或无法测量时回退 CSS 默认 4px | statusbar.js `balanceDockGap`；截图舞台不再额外增加底部留白 |
| 20 | 修正字体栈被整体引号包裹的问题；详情使用 UI 字体栈（含 Segoe UI / 微软雅黑回退），标题使用 700 字重、比正文大 1px，分组增加细分隔线 | Windows 常见字体缺少 500 字重时标题可能与正文同重；通过字重、字号和分组间距共同表达层级。速度趋势也使用统一标题样式；宿主 `--font-sans` 可覆盖详情字体 | statusbar.js 样式与 `applyThemeVars` |
