# 设计：子代理区数据打通

## 1. 边界与职责

改动落在三层，各自的职责边界如下。

| 层 | 文件 | 职责 | 不负责 |
|---|---|---|---|
| 数据投影 | `zusage.py` | 从 SQLite 产出子代理条目（运行中 + 已结束），带父会话归属键 | 不做去重以外的展示决策、不算 UI 文案 |
| 聚合 | `statusbar/session-stats.cjs` | 把请求行聚合为 `subagent` 字段（计数、速度、条目列表） | 不读库、不知宿主 DOM |
| 内核缝 | `core/inject-main.cjs` | 按窗口焦点会话切分子代理行 | 不做业务聚合 |
| 展示 | `statusbar/statusbar.js` | 面板、分组、详情、返回、呼吸灯 | 不做跨源合并以外的推断 |

## 2. 领域模型：一个条目形状

子代理有两个生命阶段，字段来源不同，但**对外只暴露一个形状**。这是本设计的核心结构决策：用一个 `subagent` 条目类型承载两态，靠 `status` 判别，而非两套并行结构。

```js
{
  key: 'call_9149...' | 'sess_subagent_agent_a453...',  // 去重键：运行中用 toolCallId，结束后用 childSessionId
  toolCallId: string | null,      // 运行中必有
  childSessionId: string | null,  // 完成后才有（sess_subagent_ + agentId）
  type: string,                   // subagent_type，如 'Explore' / 'pstack-zcode:poteto-agent'
  task: string,                   // Agent 工具 input.description
  status: 'running' | 'completed' | 'error' | 'cancelled',
  startedAt: number | null,
  endedAt: number | null,
  durationMs: number | null,      // 结束时 = endedAt - startedAt；运行中 = 实时 elapsed
  requests: number,               // 已完成请求数（运行中为 0）
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  tpsAvg: number | null,          // 已完成段加权平均，口径同主会话
}
```

状态判别用单一 `status` 字段，不需要 `isRunning` / `isDone` 两个布尔。分组由 `status === 'running'` 一处派生。

## 3. 数据流

```
zusage.py
  ├─ 运行中：tool_usage(tool_name='Agent', status='running')
  │            ⋈ part.data on json callID → description / subagent_type
  │            → subagent.list[]（childSessionId=null, toolCallId 有值, status='running'）
  └─ 已结束：session(parent_id=当前会话) ⋈ model_usage(query_source='subagent')
               + tool_usage(Agent, status IN completed/error/cancelled)
               + _sub_agent_tasks() 的 agentId 关联 → description / subagent_type
               → subagent.list[]（status 取工具行状态，缺则按 model 行推断）
        ↓ 装入 payload.recent（每行带 parentSid）
core/inject-main.cjs
  按 parentSid 分桶（无则回落到 sid）→ 本窗口焦点会话的桶
        ↓
session-stats.cjs aggregate(rows)
  subagent: { activeCount, activeTokPerSec, sessionTokens, list: [...已排序] }
        ↓ window 事件 zcode-statusbar:session
statusbar.js
  面板：list 按 status 分两组；pill 显示 activeCount · speed
```

### 3.1 为什么不用宿主 store

宿主 `snapshot.subagents.running` 确实有运行中子代理，但读取要 acquire 子会话租约。旧插件为此把桥升到 v2（`acquireConversationStore`），本项目桥是 v1，只有 `getExistingConversationStore`（要求会话已在宿主注册表里）。

`tool_usage` 在运行期就有行，`part` 在同 `callID` 上带完整任务名与类型。实库取样已确认（见 PRD）。用数据库的好处：无租约生命周期、无 store 换代竞态、无宿主内部投影的版本依赖，且与已完成态同源同表。

代价：运行中的 token / 速度为 0，因为 `model_usage` 尚无该子会话的完成行。pill 在运行态显示活跃数与「已完成段速度」，不虚构运行中速度。

> 决策记录：原计划走 store 拿运行中速度（复刻旧插件字符增量估算）。实库核实后放弃——运行中子代理的 `tool_usage` 行提供了可靠的存在性与任务名，而速度只能来自 store 字符增量，收益不足以引入租约依赖与桥版本升级。若日后需要运行中速度，再单独评估。

### 3.2 父会话归属键

子代理行的 `sid` 是子会话 id，内核按 `sid` 分桶必然落空。方案：投影行新增 `parentSid`。

- 主会话行：`parentSid: null`（无父）。
- 子代理行：`parentSid` = 父会话 id。
- 工具行：`parentSid: null`（本就属于主会话）。

内核分桶键改为 `row.parentSid || row.sid`。主会话行与工具行行为不变（`parentSid` 为 `null`，回落 `sid`），子代理行归入父会话桶。R10 防串数语义不变：桶仍然只被本窗口焦点会话取用，只是桶的键从「行来源会话」扩为「行所属会话」。

**契约影响**：`CONTRACT_ROW_KEYS` 新增 `parentSid`。`tests/data_zusage_snapshot.py:50` 的 `set(r.keys())` 严格相等断言需同步加该键，这是显式契约变更，符合 R8。

## 4. `zusage.py` 改造

### 4.1 运行中条目查询

```sql
select t.tool_call_id, t.started_at
from tool_usage t
where t.session_id = :sid and t.tool_name = 'Agent' and t.status = 'running'
```

任务名与类型从 `part` 取。`_sub_agent_tasks()` 已有同款扫描成本控制（按 part 数与最大 `time_updated` 做缓存键）。扩展它，让它同时返回 `(description, subagentType, output)` 三元组，并额外产出一个 `running` 映射：`callID → { description, subagentType }`。

**约束**：一次扫描只跑一遍。现有实现对父会话全部 part 做 `like '%"tool":"Agent"%'`，实测 29ms。运行中条目复用同一扫描结果，不新增查询。

### 4.2 条目状态判定

已结束条目按优先级取状态：

1. 有对应 `tool_usage` 行 → 用其 `status`（`completed` / `error` / `cancelled`）。
2. 无工具行 → 按子会话 `model_usage` 行推断：全 `completed` → `completed`，有 `error` 且无 `completed` → `error`。

子代理 `tool_usage` 行与子会话的关联沿用现有 `agentId` 回执解析。回执缺失时走 `_prompt_matches` 标题前缀兜底（已实现）。

### 4.3 排序与上限

- 运行中：按 `startedAt` 升序（先派发的在前）。
- 已结束：按最近活动时间倒序。
- 上限沿用 `SUBAGENT_DETAIL_MAX`（20），但**分组各自独立计上限**，并在条目里带总数供 UI 显示「另有 N 个」。

## 5. `session-stats.cjs` 改造

保持 `aggregate(rows, now?)` 签名不变。`subagent` 字段扩展：

```js
subagent: {
  activeCount,          // 不变
  activeTokPerSec,      // 不变（无运行中速度时保持 null）
  sessionTokens,        // 不变
  rows: [...],          // 保留（既有字段，不改语义）
  list: [subagent 条目] // 新增：完整形状，见 §2
}
```

`list` 由 `subRows`（`isSubagent === true`）加运行中条目构造。运行中条目的 `status` 取自投影行的 `status`。

**口径不变约束**：`sessionAvgTokPerSec` / `cacheHitRate` / `totalTokens` / `tokens` / `timing` / `speedTrend` / `tools` 的算法一行不动。子代理行仍不进主口径。

## 6. `statusbar.js` 改造

### 6.1 pill 状态

| 情形 | pill 内容 |
|---|---|
| 有运行中 | `N` + 呼吸灯 + ` · ` + `X tok/s`（有已完成速度时） |
| 无运行中，有历史 | 会话累计 token |
| 无任何子代理 | 会话累计 token（`0`） |

### 6.2 面板状态机

面板两种视图，用模块级变量承载：

```js
var subView = { mode: 'list', key: null };  // mode: 'list' | 'detail'
```

- `mode === 'list'`：两组列表。
- `mode === 'detail'`：单个条目详情，左上角返回按钮把 `mode` 置回 `'list'`。

返回时不清 `key` 之外的状态，列表重建时从 `state.session.subagent.list` 重新派生，保持最新数据。

### 6.3 详情数据来源

详情所需字段全在条目形状（§2）里，不从别处二次查询。运行中条目的 token 字段为 0，详情页对运行中显示「运行中」而非显示 0 token，避免伪造读数。

### 6.3b 可见性：惰性出现 + 会话内粘滞

现状 `renderVisibility()`（`statusbar.js:912-918`）只看用户开关，`subagent` 默认 `true`，所以无子代理的会话里 pill 恒占位。

改为三段判定，缺一不显示：

```js
// 命中条件：用户开关 AND （非 subagent 项 OR 本会话出现过子代理）
var shown = state.visible[n] && (n !== 'subagent' || state.subSeen);
```

`state.subSeen` 是粘滞标志，只在两处写：

1. `render()` 读到 `subagent` 有内容（`activeCount > 0` 或 `list.length > 0` 或 `sessionTokens > 0`）→ 置 `true`，并触发一次 `renderVisibility()`。
2. 换会话（`unmountBar()`）→ 置 `false`。这是防串数的关键：粘滞标志属于会话，不属于窗口。

不引入延迟隐藏或倒计时。用户要的是「出现后一直在」，任何中间态超时都会让 pill 在子代理连续派发时闪。

开关优先级：`state.visible.subagent` 由齿轮菜单控制且持久化，`false` 时粘滞标志不覆盖它。用户显式关闭就是关闭。

### 6.4 呼吸灯

新增 CSS，类名 `zsb-pulse`：

```css
@keyframes zsb-pulse { 0%,100%{opacity:1} 50%{opacity:.2} }
.zsb-pulse { animation: zsb-pulse 1.6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .zsb-pulse { animation: none; opacity: .8; } }
```

周期 1.6s 与 opacity 振幅对齐原插件 `zupulse`（`overlay.js:3197-3199`）。已有的 `zsb-est`（2s、振幅 0.55）保持不变，两者语义不同：`zsb-est` 标记估算值，`zsb-pulse` 标记运行中。

**无障碍**：呼吸灯只是伴随标识，状态同时由文字（`N` 与「运行中」分组标题）承载，动画不是唯一载体。

### 6.5 用量弹层

`buildUsageDetail()` 删除子代理分组那一段（`statusbar.js:507-519`），只留 token 分项。

## 7. 兼容与降级

| 失效点 | 表现 | 兜底 |
|---|---|---|
| `part.data` JSON 解析失败 | 该条任务名为空 | 回退子会话 `title`，再回退 `sid` 尾段 |
| `tool_usage` 无 Agent 行 | 运行中组为空 | 只显示已完成组，不渲染空组标题 |
| `parentSid` 字段缺失（旧投影） | 子代理行落不到父桶 | 内核回落 `sid`，行为等同改动前 |
| `aggregate` 缺席或抛错 | 无 `list` | 面板显示空态，pill 仍按旧逻辑显示 |

面板在 `state.session` 为空时显示空态，不抛错。

## 8. 测试策略

| 层 | 测试 | 断言行为 |
|---|---|---|
| 投影 | `tests/data_zusage_snapshot.py` 扩展 | 运行中 Agent 行产出 `status='running'` 条目；`parentSid` 正确指向父会话；子代理行 `parentSid` 非空 |
| 聚合 | `tests/stats-session.test.cjs` 扩展 | `subagent.list` 含两态条目；主口径字段数值不受新增条目影响 |
| 契约 | `CONTRACT_ROW_KEYS` 同步 | 行字段集合与新契约一致 |
| 界面 | 手工验证 | 逐条对照 AC1–AC10 |

界面层无自动化测试框架（本项目 renderer 注入代码不进 node 测试），靠手工验证 + AC 清单。

## 9. 改动清单

| 文件 | 改动 |
|---|---|
| `zusage.py` | `_sub_agent_tasks()` 返回类型扩展；新增运行中 Agent 行查询；`_project_request_rows()` 增 `parentSid`；`_sub_item()` 增字段；`sub.list` 合并两态 |
| `core/inject-main.cjs` | 分桶键改 `parentSid \|\| sid` |
| `statusbar/session-stats.cjs` | `subagent.list` 构造 |
| `statusbar/statusbar.js` | pill 绑 click、面板两视图、呼吸灯 CSS、用量弹层删子代理段 |
| `statusbar/CONTRACT.md` | 行字段、`subagent.list` 形状 |
| `tests/` | 投影与聚合断言扩展 |
| `plugins/zcode-statusbar/` | 同步副本（`core/sync_plugin.py` 生成，勿手改） |

## 10. 回滚

改动集中在四个源文件加测试，无数据迁移、无持久格式变更（localStorage 键不变）。回滚为 `git revert`。`parentSid` 是新增可选字段，旧投影与旧聚合代码组合下行为等同改动前。
