# 执行计划：子代理区数据打通

## 前置基线

改动前先确认基线是绿的。

```bash
cd /Users/ou/Code/github/zcode-statusbar
npm test
python3 -m unittest discover -s tests -p "*.py" 2>&1 | tail -5
```

基线已知：node 62 pass、Python 178 通过（commit `dd0d125` 的规模）。工作区有未提交改动（`statusbar.js` / `session-stats.cjs` / `CONTRACT.md` 的工具明细分组），先确认 `npm test` 在当前工作区也是绿的再动手。

## 步骤

### 1. 投影层：`zusage.py` 增 `parentSid`

**改**：`_model_contract_row()` 与 `_tool_contract_row()` 返回值加 `parentSid` 键。

- 子代理行：父会话 id（查询时 join `session` 取 `parent_id`）。
- 其余行：`null`。

`_project_request_rows()` 的子代理查询要顺带选出 `s2.parent_id`。

**验证**：

```bash
python3 -m unittest tests.data_zusage_snapshot
```

预期先红：`CONTRACT_ROW_KEYS` 严格相等断言不通过。同步把 `tests/data_zusage_snapshot.py:50` 的集合加上 `parentSid`，并新增断言：子代理行 `parentSid == MAIN`，主会话行 `parentSid is None`。

**回滚点**：`git checkout zusage.py tests/data_zusage_snapshot.py`

### 2. 投影层：运行中 Agent 行

**改**：新增查询取 `tool_usage` 的 running Agent 行；扩展 `_sub_agent_tasks()` 使其返回状态三元组并额外产出 `running` 映射。

**验证**：新增单测，在 fixture 里插一行 `tool_usage(tool_name='Agent', status='running')` 加一条对应 `part`，断言 `snapshot()["session"]["sub"]["list"]` 里出现 `status='running'`、`type` 与 `task` 正确的条目。

**约束**：不新增第三次全表扫描。运行中条目复用 `_sub_agent_tasks()` 的同一次 part 扫描。

### 3. 投影层：已结束条目状态与字段

**改**：`_sub_item()` 增 `type` / `status` / `endedAt` / `durationMs` / `childSessionId`；`status` 按 §4.2 的优先级判定。

**验证**：fixture 里造三种终态（completed / error / cancelled），断言 `list` 各自状态正确。

### 4. 内核：分桶键

**改**：`core/inject-main.cjs:539-544` 的分桶键改 `row.parentSid || row.sid`。

**验证**：`npm test`（`tests/core_bridge_shim.test.cjs` 覆盖内核缝）。若该测试不覆盖分桶，手工核对逻辑并补一条断言。

### 5. 聚合层：`subagent.list`

**改**：`statusbar/session-stats.cjs` 构造 `subagent.list`，形状按 design §2。

**验证**：

```bash
npm test
```

新增断言：

- `list` 含 running 与 completed 两态条目。
- **主口径不变**：同一批行在新增 `list` 前后，`sessionAvgTokPerSec` / `totalTokens` / `cacheHitRate` / `turns` / `steps` 数值相同。这条最关键，直接对应 design §5 的口径不变约束。

### 6. 界面：pill 点击 + 面板列表

**改**：`statusbar/statusbar.js`

- `bindBarEvents()` 给 `ui.pills.subagent` 绑 click → `togglePop('subagent')`。
- `openPop()` 加 `'subagent'` 分支 → `buildSubagentPanel(ui.pop)`。
- `buildSubagentPanel()` 渲染两组；详情视图由 `subView.mode` 切换。

**验证**：注入宿主后打开面板，确认两组标题、行内容、箭头。

### 7. 界面：详情与返回

**改**：`buildSubagentDetail(pop, item)` 渲染字段；左上角返回按钮把 `subView.mode` 置回 `'list'` 并重建面板。

**验证**：点击箭头进详情、点返回回列表，两次往返后分组位置不变。

### 8. 界面：用量弹层删子代理段

**改**：`buildUsageDetail()` 删除 `statusbar.js:507-519` 的子代理分组。

**验证**：打开用量弹层，只剩输入 / 输出 / 缓存读 / 缓存写四行。

### 9. 界面：呼吸灯

**改**：CSS 加 `zsb-pulse` 与 reduced-motion 分支；运行中条目与 pill 加该类。

**验证**：运行中子智能体时标识闪烁；系统开启「减弱动态效果」后停播。

### 9b. 界面：子代理 pill 惰性出现与会话内粘滞

**改**：`statusbar/statusbar.js`

- `state` 加 `subSeen: false`（会话内粘滞标志）。
- `renderVisibility()` 的 `subagent` 分支改为 `state.visible.subagent && state.subSeen`。
- `render()` 在读到子代理有内容时置 `state.subSeen = true` 并触发一次 `renderVisibility()`；只在从 `false` 翻到 `true` 的那一次触发，避免每秒重排。
- `unmountBar()` 与换会话路径把 `state.subSeen` 置回 `false`。

**验证**：新会话无子代理时 pill 不占位；派生子代理后出现；子代理结束仍保留；切到无子代理的会话后消失。

### 10. 契约与同步副本

**改**：

- `statusbar/CONTRACT.md`：行字段加 `parentSid`、`subagent.list` 形状、store 不消费的说明。
- `python3 core/sync_plugin.py` 同步 `plugins/zcode-statusbar/`。

**验证**：

```bash
python3 core/sync_plugin.py --check
npm test
```

## 验证命令汇总

```bash
cd /Users/ou/Code/github/zcode-statusbar
npm test
python3 -m unittest discover -s tests -p "*.py" 2>&1 | tail -5
python3 core/sync_plugin.py --check
```

## 评审门

| 门 | 条件 |
|---|---|
| G1 | 步骤 1–3 完成且 Python 测试绿，投影层字段稳定 |
| G2 | 步骤 4–5 完成且 `npm test` 绿，口径不变断言通过 |
| G3 | 步骤 6–9 完成，实机逐条对照 AC1–AC10 |
| G4 | 步骤 10 完成，契约一致、同步副本无漂移 |

## 回滚点

每个步骤后提交一次。任一步失败可 `git revert` 单个提交，不必整体回退。步骤 1 与步骤 4 有耦合（`parentSid` 生产者与消费者），这两个提交需一起回退。
