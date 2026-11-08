# 子代理区数据打通：store 实时态 + 数据库历史 + 分组列表与详情

## Goal

子代理区在子智能体运行期间显示真实数据；所有执行过的子代理（运行中、已完成两组）以列表形式呈现，每行可进入详情并返回。用量区不再重复展示子代理明细。运行态恢复原插件的呼吸灯提示。

用户的原始反馈（2026-11-07，附截图）：

1. 子智能体在运行时，子智能体区没有数据展示。
2. 恢复原插件的呼吸灯特性。
3. 用量区域无需展示子代理的明细数据，统一在子代理区展示。
4. 子代理区展示任务所有执行过的子代理，按运行中、已完成分两组，列表展示 subagent 名称 + subagent 任务概要信息，同时提供进入详情按钮（箭头 ➡️），点击详情进入该 subagent 运行的详细数据，同时左上角支持返回。

## 背景：现状与根因

### 根因 1：子代理行被内核按 sid 过滤掉

`core/inject-main.cjs:539-558` 逐窗口聚合时，只取 `bySid.get(mine)` 的行，`mine` 是本窗口焦点会话 id。而 `zusage.py` 投影的子代理行 `sid` 是**子会话 id**（`sess_subagent_agent_xxx`），永远不等于父会话 id。

结果：`payload.recent` 里带着全部子代理行（`isSubagent=true`），但 `aggregate.subagent` 恒为空。这是状态条子代理控件无数据的直接原因。

### 根因 2：运行中的子代理在 SQLite 里不存在

实库采样（2026-11-07）：

```
select status, count(*) from model_usage group by 1;
cancelled|12  completed|1659  error|41
```

没有 `running` 行。`zusage.py` 的子代理查询也只取 `status='completed'`：

```sql
where m.query_source='subagent' and s2.parent_id=? and m.status='completed'
group by m.session_id
```

旧插件源码对此有明确记录，原话是「150s 采样实锤零 running 行」。所以运行态只能来自宿主 store。

### 根因 3：子代理 pill 没有绑点击

`statusbar/statusbar.js:894-913` 的 `bindBarEvents()` 只绑了 activity / usage / context / gear。子代理 pill 无 click 监听，点击无任何反应。

### 根因 4：子代理 pill 的两种状态都是单值

现有渲染（`statusbar.js:732-752`）只在 pill 里显示「活跃数 · 速度」或「会话累计 token」，没有列表能力，也没有详情入口。

### 运行态数据来源：tool_usage 的 running Agent 行（已核实）

运行中的子代理在 `model_usage` 里没有记录（每个请求要完成才落库），但**在 `tool_usage` 里有**：

```
usage_tool_sess_73aa3eb3-..._call_9149f8d7702047289e922ec2 | Agent | running | 1794029514666 |
```

同一 `tool_call_id` 的 `part` 行同时带着任务名与类型（实库取样）：

```json
{"type":"tool","callID":"call_9149f8d7702047289e922ec2","tool":"Agent",
 "state":{"status":"running","input":{
   "description":"恢复工具调用明细分组",
   "subagent_type":"pstack-zcode:poteto-agent"}}}
```

所以运行态**不需要宿主 store**。`tool_usage.tool_call_id` 与 `part.data` 的 `callID` 是直接 join 键，任务名（`description`）与子代理类型（`subagent_type`）在运行期就可读。

这也解释了为什么旧插件注释写「运行中的请求未入库」：它说的是 `model_usage`，而 `tool_usage` 是另一张表，运行期有行。

宿主 store 的 `snapshot.subagents.running`（`ZCode/.../snapshot.ts:391-408`）虽然也有一份，但读取需要 acquire 子会话租约（旧插件用桥 v2 的 `acquireConversationStore`，本项目的桥是 v1），属于高风险非必要依赖。**本任务不使用 store。**

### 已完成态的关联键

`zusage.py:529-570` 的 `_sub_agent_tasks()` 已经从 Agent 工具回执里解析 `agentId:` 行，并用 `sess_subagent_` + agentId 关联子会话。这个硬连接可直接复用。

运行中条目拿不到该回执（回执在完成时才写入），走同函数里已有的兜底：子会话标题是 prompt 的截断头（`_prompt_matches`），候选唯一才绑定。

### 已完成态的关联键

`zusage.py:529-570` 的 `_sub_agent_tasks()` 已经从 Agent 工具回执里解析 `agentId:` 行，并用 `sess_subagent_` + agentId 关联子会话。这个硬连接可直接复用。

## Requirements

### R1 运行中子代理有数据

子代理 pill 在子智能体运行期间显示活跃数与速度。

运行态数据来自 `tool_usage` 的 `tool_name='Agent' AND status='running'` 行，join `part.data` 的同 `callID` 取 `description` / `subagent_type`。不依赖宿主 store。

### R2 子代理区统一承载全部明细

子代理 pill 点击后打开子代理面板。面板分两组：**运行中**、**已完成**。

- 运行中：`tool_usage` 的 running Agent 行。
- 已完成（含 error / cancelled）：子会话的 `model_usage` 聚合，加上已结束的 Agent 工具行。
- 两组合并去重，运行时键为 `tool_call_id`，完成后键为 `childSessionId`。

### R3 列表行内容

每行展示：

- 子代理名称（`subagentType`，如 `pstack-zcode:poteto-agent`、`Explore`）
- 任务概要（Agent 工具的 `description`，缺失时回退 store 的 `title`）
- 状态标识（运行中有呼吸灯）
- 进入详情按钮（箭头）

### R4 详情页与返回

点击箭头进入该子代理的运行详情，展示：

- 名称、类型、状态
- 任务概要
- 起止时间与总耗时
- 请求数、输入 / 输出 token、缓存读写
- 平均速度
- 最近活动时间

详情页左上角有返回按钮，点击回到列表并保持原分组位置。详情页期间面板不关闭。

### R5 用量区移除子代理明细

`buildUsageDetail()` 里删除子代理分组，用量弹层只保留输入 / 输出 / 缓存读 / 缓存写。

### R6 恢复呼吸灯

运行中的子代理标识恢复原插件的呼吸闪烁（`zupulse`，1.6s 周期，opacity 1 → 0.2 → 1）。已完成条目无动画。

`prefers-reduced-motion: reduce` 时停播。

### R6b 子代理 pill 的惰性出现与常驻

用户的原始反馈（2026-11-07，截图红框）：没有子代理的会话里，子代理 pill 不应常驻占位。

- **不出现**：本会话从未出现过任何子代理时，pill 不渲染、不占位（与上下文 pill 的缺席隐藏同款处理，`statusbar.js` 的 `renderVisibility`）。
- **被触发出现**：本会话一旦出现任一子代理（运行中或已完成），pill 立刻出现。
- **出现后常驻**：出现之后即使子代理全部结束、子代理列表变空，pill 仍保留（显示会话累计 token），不来回闪烁。
- **粘滞标志按会话重置**：切换会话时粘滞标志清零，新会话重新按「是否有子代理」判定，防止上一个会话的子代理状态串到下一个会话（R10）。
- 齿轮菜单的「显示」开关仍是最高优先级：用户手动关掉子代理项后不显示，粘滞标志不覆盖用户选择。

### R7 内核聚合修正

`aggregate()` 需要能拿到本会话的子代理行。子代理行的 `sid` 是子会话 id，必须让父会话聚合能匹配到它们。

实现方式在 `design.md` 定义，约束：

- 不破坏 R10 防串数（不得把别的窗口的会话数据混入）。
- 不改变现有主口径字段语义（`sessionAvgTokPerSec` / `cacheHitRate` / `totalTokens` / `tokens` / `timing` / `speedTrend`）。

### R8 契约同步

`statusbar/CONTRACT.md` 同步更新：新的 session 事件字段形状、子代理条目字段、store 快照消费点。

## Out of Scope

- 不做子代理下钻（不复刻宿主的 `SubagentDrilldown` 内嵌输出预览）。
- 不做停止 / 取消子代理的控制能力。
- 不引入费用、汇率、配额字段（沿用既有决策 7）。
- 不做子代理对话内容的读取与展示。
- 不改宿主 DOM，不修改官方 UI。

## Acceptance Criteria

- [ ] AC1 子智能体运行期间，子代理 pill 显示活跃数与速度，不再空白。
- [ ] AC2 子代理 pill 可点击，打开面板，分「运行中」「已完成」两组。
- [ ] AC3 运行中条目来自 `tool_usage` 的 running Agent 行，随任务推进刷新；结束后自动移入已完成组。
- [ ] AC4 已完成的子代理（含 error / cancelled）全部出现在已完成组，按最近活动倒序。
- [ ] AC5 每行显示名称、任务概要、进入详情箭头；运行中行有呼吸灯动画。
- [ ] AC6 点击箭头进入详情页，字段完整；左上角返回回到列表。
- [ ] AC7 用量弹层不再出现子代理分组。
- [ ] AC8 `prefers-reduced-motion: reduce` 下呼吸灯停播。
- [ ] AC9 子代理数据缺失时面板仍可用，无条目时显示空态文案，不报错、不留空白组。
- [ ] AC10 多窗口场景下不串数：A 窗口的子代理不出现在 B 窗口。
- [ ] AC11 `npm test` 全绿；`python3 -m unittest` 全绿。
- [ ] AC12 `CONTRACT.md` 与实际字段一致。
- [ ] AC13 本会话从未出现子代理时，子代理 pill 不渲染、不占位。
- [ ] AC14 出现第一个子代理后 pill 立刻出现；子代理全部结束后 pill 仍保留（显示会话累计 token）。
- [ ] AC15 切换到另一个没有子代理的会话时 pill 隐藏（粘滞标志按会话重置，不串数）。
- [ ] AC16 用户在齿轮菜单关闭子代理项后，粘滞标志不使它重新出现。

## Risks

- `tool_usage` 与 `part` 目前未被本插件作为子代理数据源使用。两者是宿主内部表，字段可能随宿主升级变化。失效路径须为静默：运行中列表为空，已完成列表与其余控件不受影响。
- `part.data` 是 JSON 文本，`_sub_agent_tasks()` 已按父会话缓存（键为 part 数与最大 `time_updated`）。运行中条目同样走该缓存，缓存命中时不重扫。
- 同一 `tool_call_id` 的 `part` 可能因重试有多行，取最新一行为准。
- 呼吸灯是纯视觉提示，不能让颜色/动画成为唯一状态载体（无障碍要求已在 roadmap 审计中记录）。
- 子代理面板条目数无上限时，超长会话可能过长。已完成组需要设展示上限并给出总数。
