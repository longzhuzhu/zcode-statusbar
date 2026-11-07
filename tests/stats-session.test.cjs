'use strict';

/**
 * session-stats.cjs 单测（node:test）——测口径行为，不测实现细节。
 * 覆盖：R2 完成态速度（窗口边界 200ms/1h、思考/Claude started_at 窗、首字窗）、
 * 缓存命中率（缓存含在 input 不重复加）、总 token、子代理聚合（R5）、坏行容错。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  aggregate,
  windowBasis,
  rowWindowMs,
  isCountedWindow,
  MIN_WINDOW_MS,
  MAX_WINDOW_MS,
} = require('../statusbar/session-stats.cjs');

// ---- 行工厂：只填必要字段，其余缺省 ----
function row(over) {
  return Object.assign(
    {
      id: 'r',
      kind: 'model',
      isSubagent: false,
      model: 'glm-4.6',
      thinking: false,
      status: 'completed',
      startedAt: 1000,
      firstTokenAt: 2000,
      completedAt: 3000,
      inputTokens: 100,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    over
  );
}

test('windowBasis：思考请求与 Claude 模型用 started_at 窗，其余用 first_token 窗', () => {
  assert.equal(windowBasis(row({ thinking: true })), 'started_at');
  assert.equal(windowBasis(row({ model: 'claude-sonnet-4' })), 'started_at');
  assert.equal(windowBasis(row({ model: 'Claude' })), 'started_at'); // 不区分大小写
  assert.equal(windowBasis(row({ model: 'glm-4.6' })), 'first_token');
  assert.equal(windowBasis(row({ model: 'glm-4.6', thinking: false })), 'first_token');
  assert.equal(windowBasis(null), 'first_token'); // 坏输入不抛错
});

test('rowWindowMs：首字窗与 started_at 窗；时间缺失/倒挂返回 null', () => {
  // 普通行：completed(3000) − first_token(2000) = 1000ms
  assert.equal(rowWindowMs(row()), 1000);
  // 思考行：completed(3000) − started(1000) = 2000ms（首字时间被忽略）
  assert.equal(rowWindowMs(row({ thinking: true, firstTokenAt: 2900 })), 2000);
  // 普通行缺首字：退 started_at 窗
  assert.equal(rowWindowMs(row({ firstTokenAt: null })), 2000);
  // 缺 completedAt / 缺 startedAt / 倒挂 → null
  assert.equal(rowWindowMs(row({ completedAt: null })), null);
  assert.equal(rowWindowMs(row({ startedAt: null, firstTokenAt: null })), null);
  assert.equal(rowWindowMs(row({ firstTokenAt: 5000 })), null); // 首字晚于完成，倒挂
});

test('isCountedWindow：200ms 含、199ms 排除、1h 排除、1h−1ms 含', () => {
  assert.equal(isCountedWindow(MIN_WINDOW_MS), true);
  assert.equal(isCountedWindow(MIN_WINDOW_MS - 1), false);
  assert.equal(isCountedWindow(MAX_WINDOW_MS), false); // < 1h，开区间
  assert.equal(isCountedWindow(MAX_WINDOW_MS - 1), true);
  assert.equal(isCountedWindow(null), false);
  assert.equal(isCountedWindow(-5), false);
});

test('完成态速度 = Σ输出 ÷ Σ有效生成时长；无效窗口行被剔除', () => {
  const rows = [
    // first_token 窗 1000ms，out 300 → 300 tok/s
    row({ id: 'a', outputTokens: 300 }),
    // thinking：started_at 窗 2000ms，out 200 → 100 tok/s
    row({ id: 'b', thinking: true, outputTokens: 200 }),
    // 窗口 150ms < 200ms → 剔除
    row({ id: 'c', outputTokens: 999, firstTokenAt: 2850 }),
    // 窗口 2h ≥ 1h → 剔除
    row({ id: 'd', outputTokens: 999, startedAt: 0, firstTokenAt: 1000, completedAt: 7200 * 1000 }),
    // 运行中（未完成）→ 剔除
    row({ id: 'e', status: 'running', outputTokens: 999 }),
    // 错误行 → 剔除
    row({ id: 'f', status: 'error', outputTokens: 999 }),
  ];
  const agg = aggregate(rows);
  // Σout = 500；Σwin = 1.0s + 2.0s = 3.0s → 166.67
  assert.ok(Math.abs(agg.sessionAvgTokPerSec - 500 / 3) < 1e-9);
});

test('子代理不计入主口径任何字段（R2：不含子代理）', () => {
  const rows = [
    row({ id: 'main', outputTokens: 300 }), // 窗 1s
    row({ id: 'sub1', isSubagent: true, outputTokens: 900, inputTokens: 1000 }), // 窗 1s
    row({ id: 'sub2', isSubagent: true, outputTokens: 900, inputTokens: 1000 }),
  ];
  const agg = aggregate(rows);
  assert.ok(Math.abs(agg.sessionAvgTokPerSec - 300) < 1e-9); // 只算主行
  assert.equal(agg.totalTokens, 300 + 100); // 子代理 token 不计入总 token
  assert.equal(agg.turns, 1); // 轮次只数主会话完成请求
  assert.equal(agg.subagent.sessionTokens, (900 + 1000) * 2);
});

test('缓存命中率与总 token：缓存已含在 input，不重复相加', () => {
  const rows = [
    row({ inputTokens: 1000, cacheReadTokens: 700, cacheWriteTokens: 100, outputTokens: 200 }),
  ];
  const agg = aggregate(rows);
  assert.equal(agg.cacheHitRate, 0.7); // 700 / 1000
  assert.equal(agg.totalTokens, 1200); // input(1000，含缓存) + output(200)
  assert.equal(agg.tokens.input, 1000);
  assert.equal(agg.tokens.output, 200);
  assert.equal(agg.tokens.cacheRead, 700);
  assert.equal(agg.tokens.cacheWrite, 100);
});

test('缓存命中率：input 为 0 或缺失时返回 null 而非 NaN', () => {
  assert.equal(aggregate([row({ inputTokens: 0 })]).cacheHitRate, null);
  assert.equal(aggregate([]).cacheHitRate, null);
  assert.equal(aggregate([]).sessionAvgTokPerSec, null);
});

test('子代理聚合：活跃数、活跃速度（now 注入）、会话累计（R5）', () => {
  const now = 10_000;
  const rows = [
    // 运行中：first_token 6000 → 窗 4000ms，out 800 → 200 tok/s
    row({ id: 's1', isSubagent: true, status: 'running', startedAt: 5000, firstTokenAt: 6000, completedAt: null, outputTokens: 800, inputTokens: 200 }),
    // 运行中但窗口 < 200ms → 不进速度
    row({ id: 's2', isSubagent: true, status: 'running', startedAt: 9950, firstTokenAt: 9960, completedAt: null, outputTokens: 50, inputTokens: 0 }),
    // 已结束子代理：不计活跃
    row({ id: 's3', isSubagent: true, status: 'completed', startedAt: 1000, firstTokenAt: 1100, completedAt: 2000, outputTokens: 300, inputTokens: 100 }),
  ];
  const agg = aggregate(rows, now);
  assert.equal(agg.subagent.activeCount, 2);
  assert.ok(Math.abs(agg.subagent.activeTokPerSec - 800 / 4) < 1e-9); // 只含有效窗口行
  assert.equal(agg.subagent.sessionTokens, 800 + 200 + 50 + 0 + 300 + 100);
  assert.equal(agg.subagent.rows.length, 3);
  assert.equal(agg.subagent.rows[0].model, 'glm-4.6');
});

test('无活跃子代理时 activeTokPerSec 为 null', () => {
  const agg = aggregate([row({ isSubagent: true, status: 'completed', outputTokens: 10 })], 10_000);
  assert.equal(agg.subagent.activeCount, 0);
  assert.equal(agg.subagent.activeTokPerSec, null);
});

test('speedTrend：按完成时间升序取最近 10 轮（R6 占位数据接口）', () => {
  const rows = [];
  for (let i = 0; i < 15; i++) {
    rows.push(
      row({
        id: 't' + i,
        startedAt: i * 10_000,
        firstTokenAt: i * 10_000 + 100,
        completedAt: i * 10_000 + 1100, // 窗 1s
        outputTokens: 100 + i,
      })
    );
  }
  const agg = aggregate(rows);
  assert.equal(agg.speedTrend.length, 10);
  // 最近 10 轮 = t5..t14
  assert.equal(agg.speedTrend[0].t, 5 * 10_000 + 1100);
  assert.equal(agg.speedTrend[9].t, 14 * 10_000 + 1100);
  assert.ok(Math.abs(agg.speedTrend[9].tokPerSec - (100 + 14)) < 1e-9);
});

test('timing：模型用时、工具用时、TTFT 均值（R6）', () => {
  const rows = [
    // 模型行1：started 1000 → completed 3000 = 2000ms；TTFT = 2000−1000 = 1000ms
    row({ id: 'm1' }),
    // 模型行2：started 5000 → completed 8000 = 3000ms；TTFT = 5500−5000 = 500ms
    row({ id: 'm2', startedAt: 5000, firstTokenAt: 5500, completedAt: 8000 }),
    // 工具行：1500ms
    row({ id: 'w1', kind: 'tool', startedAt: 3000, firstTokenAt: null, completedAt: 4500, outputTokens: 0 }),
  ];
  const agg = aggregate(rows);
  assert.equal(agg.timing.modelTimeMs, 5000);
  assert.equal(agg.timing.toolTimeMs, 1500);
  assert.ok(Math.abs(agg.timing.ttftMs - 750) < 1e-9); // (1000+500)/2
  assert.equal(agg.steps, 1);
  assert.equal(agg.turns, 2);
});

test('坏行容错：null、非对象、非有限数值字段不抛错、按缺失跳过', () => {
  const agg = aggregate([
    null,
    42,
    'x',
    row({ outputTokens: '300' }), // 字符串数字：非有限数值类型 → 视为缺失（0 计入速度分母时长）
    row({ outputTokens: NaN }),
  ]);
  // '300' 与 NaN 都不计输出；但两行窗口有效（各 1s），分母 2s → 速度 0
  assert.equal(agg.sessionAvgTokPerSec, 0);
  assert.equal(agg.totalTokens, 200); // 仅 input 累计（两行各 100）
});

test('aggregate 缺省 now 参数可用（Date.now 兜底）', () => {
  const agg = aggregate([row({ isSubagent: true, status: 'running', startedAt: 0, firstTokenAt: 0, completedAt: null })]);
  assert.equal(agg.subagent.activeCount, 1);
  assert.equal(agg.subagent.activeTokPerSec, null); // 窗口远超 1h → 无有效活跃速度
});

// ---- tools 工具调用明细（对齐原插件口径：completed+error 计入，running 不计）----

test('tools：按工具名聚合，同名 count/durationMs 求和，list 只出一行', () => {
  const rows = [
    row({ id: 't1', kind: 'tool', model: 'Bash', status: 'completed', startedAt: 1000, completedAt: 2500 }),
    row({ id: 't2', kind: 'tool', model: 'Bash', status: 'completed', startedAt: 3000, completedAt: 3600 }),
  ];
  const agg = aggregate(rows);
  assert.equal(agg.tools.total, 2);
  assert.equal(agg.tools.errors, 0);
  assert.equal(agg.tools.list.length, 1);
  assert.deepEqual(agg.tools.list[0], { name: 'Bash', count: 2, durationMs: 2100, errors: 0 });
});

test('tools：error 行计入 count/errors/durationMs；running 行完全不计', () => {
  const rows = [
    row({ id: 'a', kind: 'tool', model: 'Bash', status: 'error', startedAt: 1000, completedAt: 1500 }),
    row({ id: 'b', kind: 'tool', model: 'Bash', status: 'completed', startedAt: 2000, completedAt: 2600 }),
    row({ id: 'c', kind: 'tool', model: 'Bash', status: 'running', startedAt: 3000, completedAt: null }),
    row({ id: 'd', kind: 'tool', model: 'Read', status: 'running', startedAt: 3000, completedAt: null }),
  ];
  const agg = aggregate(rows);
  assert.equal(agg.tools.total, 2);
  assert.equal(agg.tools.errors, 1);
  assert.equal(agg.tools.list.length, 1);
  assert.equal(agg.tools.list[0].count, 2);
  assert.equal(agg.tools.list[0].errors, 1);
  assert.equal(agg.tools.list[0].durationMs, 1100);
});

test('tools：时间戳缺失或倒挂的 error 行计 count/errors、不计时长', () => {
  const agg = aggregate([
    row({ id: 'a', kind: 'tool', model: 'Bash', status: 'error', startedAt: null, completedAt: 1500 }),
    row({ id: 'b', kind: 'tool', model: 'Read', status: 'error', startedAt: 2000, completedAt: 1000 }),
  ]);
  assert.equal(agg.tools.total, 2);
  assert.equal(agg.tools.errors, 2);
  assert.equal(agg.tools.list.length, 2);
  for (const t of agg.tools.list) assert.equal(t.durationMs, 0);
});

test('tools：list 排序 count 降序、同次数按工具名升序', () => {
  const rows = [
    row({ id: '1', kind: 'tool', model: 'Zed', status: 'completed', startedAt: 0, completedAt: 10 }),
    row({ id: '2', kind: 'tool', model: 'mcp', status: 'completed', startedAt: 0, completedAt: 10 }),
    row({ id: '3', kind: 'tool', model: 'Bash', status: 'completed', startedAt: 0, completedAt: 10 }),
    row({ id: '4', kind: 'tool', model: 'Bash', status: 'completed', startedAt: 0, completedAt: 10 }),
    row({ id: '5', kind: 'tool', model: 'Read', status: 'completed', startedAt: 0, completedAt: 10 }),
    row({ id: '6', kind: 'tool', model: 'Read', status: 'completed', startedAt: 0, completedAt: 10 }),
    row({ id: '7', kind: 'tool', model: 'Edit', status: 'completed', startedAt: 0, completedAt: 10 }),
  ];
  const agg = aggregate(rows);
  assert.deepEqual(agg.tools.list.map((t) => t.name), ['Bash', 'Read', 'Edit', 'Zed', 'mcp']);
});

test('tools：空输入/无工具行返回 { total: 0, errors: 0, list: [] }', () => {
  assert.deepEqual(aggregate([]).tools, { total: 0, errors: 0, list: [] });
  assert.deepEqual(aggregate([row()]).tools, { total: 0, errors: 0, list: [] });
});

test('tools：工具名缺失（model 空串或 undefined）归 "" 聚合，total 仍计', () => {
  const agg = aggregate([
    row({ id: 'a', kind: 'tool', model: '', status: 'completed', startedAt: 0, completedAt: 100 }),
    row({ id: 'b', kind: 'tool', model: undefined, status: 'error', startedAt: 0, completedAt: 200 }),
  ]);
  assert.equal(agg.tools.total, 2);
  assert.equal(agg.tools.errors, 1);
  assert.equal(agg.tools.list.length, 1);
  assert.equal(agg.tools.list[0].name, '');
  assert.equal(agg.tools.list[0].count, 2);
  assert.equal(agg.tools.list[0].durationMs, 300);
});

// ---- subagent.list：面板条目（运行中来自投影行，token 来自 model 行）----

function subRow(over) {
  return Object.assign(
    {
      id: 'call_1',
      sid: 'sess_parent',
      parentSid: 'sess_parent',
      kind: 'subagent',
      isSubagent: true,
      model: '',
      subagentType: 'Explore',
      task: '调研布局',
      status: 'running',
      thinking: false,
      startedAt: 5000,
      firstTokenAt: null,
      completedAt: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      childSessionId: null,
    },
    over
  );
}

test('subagent.list：运行中条目来自 kind=subagent 投影行，token 为 0 且 tpsAvg 为 null', () => {
  const agg = aggregate([subRow()], 8000);
  const list = agg.subagent.list;
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'running');
  assert.equal(list[0].type, 'Explore');
  assert.equal(list[0].task, '调研布局');
  assert.equal(list[0].outputTokens, 0);
  assert.equal(list[0].tpsAvg, null); // 运行中不虚构速度
  assert.equal(list[0].durationMs, 3000); // now - startedAt
  assert.equal(agg.subagent.activeCount, 1);
});

test('subagent.list：已完成条目按 childSessionId 合并 model 行，token 求和且速度非空', () => {
  const rows = [
    subRow({ id: 'call_9', status: 'completed', startedAt: 1000, completedAt: 4000, childSessionId: 'sess_sub_a' }),
    row({ id: 'm1', isSubagent: true, sid: 'sess_sub_a', status: 'completed', startedAt: 1000, firstTokenAt: 2000, completedAt: 4000, outputTokens: 300, inputTokens: 50 }),
    row({ id: 'm2', isSubagent: true, sid: 'sess_sub_a', status: 'completed', startedAt: 1000, firstTokenAt: 2000, completedAt: 4000, outputTokens: 700, inputTokens: 50 }),
  ];
  const agg = aggregate(rows, 10_000);
  assert.equal(agg.subagent.list.length, 1); // 合并成一条，不是三条
  const it = agg.subagent.list[0];
  assert.equal(it.status, 'completed');
  assert.equal(it.type, 'Explore');
  assert.equal(it.outputTokens, 1000);
  assert.equal(it.inputTokens, 100);
  assert.equal(it.requests, 2);
  assert.equal(it.durationMs, 3000);
  assert.ok(it.tpsAvg > 0);
  assert.equal(agg.subagent.activeCount, 0);
});

test('subagent.list：多个运行中按 startedAt 升序，已结束按 endedAt 倒序，运行中排在前面', () => {
  const running =[
    subRow({ id: 'r1', startedAt: 5000 }),
    subRow({ id: 'r2', startedAt: 3000 }),
  ];
  const done = [
    subRow({ id: 'd1', status: 'completed', startedAt: 0, completedAt: 1000 }),
    subRow({ id: 'd2', status: 'completed', startedAt: 0, completedAt: 9000 }),
  ];
  const list = aggregate(running.concat(done), 10_000).subagent.list;
  assert.deepEqual(list.map((i) => i.toolCallId), ['r2', 'r1', 'd2', 'd1']);
});

test('subagent.list：token 为零的投影行不进主口径（totalTokens/turns/steps 不受影响）', () => {
  const base = [row({ id: 'main', kind: 'model', status: 'completed', outputTokens: 500, inputTokens: 200 })];
  const withSub = base.concat([
    subRow({ id: 'p1', status: 'completed', startedAt: 1000, completedAt: 4000 }),
    subRow({ id: 'p2' }),
  ]);
  const a = aggregate(base, 10_000);
  const b = aggregate(withSub, 10_000);
  assert.equal(b.totalTokens, a.totalTokens);
  assert.equal(b.turns, a.turns);
  assert.equal(b.steps, a.steps);
  assert.equal(b.sessionAvgTokPerSec, a.sessionAvgTokPerSec);
  assert.equal(b.cacheHitRate, a.cacheHitRate);
  assert.equal(b.subagent.sessionTokens, 0); // 投影行零 token 不污染会话累计
});

test('subagent.list：对不上投影行的 model 行独立成条，不与其他子代理合并', () => {
  const agg = aggregate(
    [
      subRow({ id: 'p1', childSessionId: 'sess_sub_a', status: 'running' }),
      row({ id: 'm1', isSubagent: true, sid: 'sess_sub_b', status: 'completed', outputTokens: 42 }),
    ],
    10_000
  );
  assert.equal(agg.subagent.list.length, 2);
  const b = agg.subagent.list.find((i) => i.childSessionId === 'sess_sub_b');
  assert.ok(b);
  assert.equal(b.outputTokens, 42);
  assert.equal(b.task, null); // 无投影行就没有任务名，不猜
});

test('subagent.list：空输入返回空数组', () => {
  assert.deepEqual(aggregate([]).subagent.list, []);
  assert.deepEqual(aggregate([row()]).subagent.list, []);
});

test('subagent.list：未知状态归一为 completed（不虚报运行中）', () => {
  const list = aggregate([subRow({ id: 'x', status: 'weird' })], 10_000).subagent.list;
  assert.equal(list[0].status, 'completed');
});

test('轮次口径 = 用户输入轮数：同 turnId 的多次模型请求只计一轮', () => {
  // 一轮工具循环：用户提问 → 模型请求 → 工具 → 模型请求 → ... 共享同一 turn_id
  const agg = aggregate([
    row({ id: 'a', turnId: 't1', outputTokens: 100 }),
    row({ id: 'b', turnId: 't1', outputTokens: 100 }),
    row({ id: 'c', turnId: 't1', outputTokens: 100 }),
    row({ id: 'd', turnId: 't2', outputTokens: 100 }),
  ]);
  assert.equal(agg.turns, 2, '3 次模型请求同属 t1 + 1 次 t2 = 2 个用户输入轮');
  // 步数仍按工具调用计，与轮次口径互相独立
  assert.equal(agg.steps, 0);
});

test('轮次兜底：turnId 缺失的行各计一轮（旧库/瘦身夹具不丢轮次）', () => {
  const agg = aggregate([
    row({ id: 'a', turnId: 't1' }),
    row({ id: 'b' }), // 缺 turnId
    row({ id: 'c', turnId: null }),
    row({ id: 'd', turnId: '' }),
  ]);
  // t1 一轮 + 三个无 turnId 行各一轮
  assert.equal(agg.turns, 4);
});

test('轮次只数已完成轮：running/error 行不进 turns', () => {
  const agg = aggregate([
    row({ id: 'a', turnId: 't1' }),
    row({ id: 'b', turnId: 't1', status: 'running' }),
    row({ id: 'c', turnId: 't2', status: 'error' }),
  ]);
  assert.equal(agg.turns, 1, '只有 t1 有 completed 行，t2 仅 error 不计');
});

test('轮次不含子代理：子代理行的 turnId 不参与主口径', () => {
  const agg = aggregate([
    row({ id: 'a', turnId: 't1' }),
    row({ id: 's', turnId: 't1', isSubagent: true }),
    row({ id: 's2', turnId: 't9', isSubagent: true }),
  ]);
  assert.equal(agg.turns, 1, '子代理 turnId 一律不计');
});
