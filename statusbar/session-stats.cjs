'use strict';

/**
 * session-stats.cjs —— 会话统计聚合（主进程 CommonJS，纯函数、无副作用）
 *
 * 职责：把内核从只读 SQLite 投影出的请求行（rows）聚合为状态条所需的一次会话快照，
 * 由内核定期调用后经 renderer 事件 "zcode-statusbar:session" 推送（契约见 statusbar/CONTRACT.md）。
 *
 * 口径（prd R2 / R5 / design §2）：
 * - 完成态速度 = Σ输出 token ÷ Σ生成时长（"会话均"），仅统计主会话完成请求，不含子代理。
 * - 有效生成窗口：200ms ≤ 窗 < 1h。
 * - 优先使用 durationMs；普通输出扣除有效 ttftMs，思考请求保留思考阶段。
 *   不按 firstTokenAt 缩窗：宿主写队列可能把该时间戳延迟到请求末尾。
 * - 总 token = input + output；缓存 token（cache_read/cache_write）已含在 input 中，绝不重复相加。
 * - 缓存命中率 = Σcache_read ÷ Σinput。
 * - 子代理单独聚合：活跃数、活跃速度、会话累计 token；不计入主口径任何字段。
 *
 * 与 design.md §9 契约的偏差/扩展（同步登记于 statusbar/CONTRACT.md）：
 * 1. aggregate(rows, now?) 增加可选第二参数 now（ms 时间戳），用于子代理活跃速度计算与测试注入；
 *    缺省 Date.now()。基线签名 aggregate(rows) 语义不变。
 * 2. 返回值在契约四字段（sessionAvgTokPerSec / cacheHitRate / totalTokens / subagent）之外扩展：
 *    turns、steps、tokens 分项、timing、speedTrend、subagent.rows，
 *    供 R1 常驻控件（轮次·步数）与 R6 详情弹层（模型/工具用时、TTFT、速度趋势、子代理明细）使用。
 *    turns 口径为「用户输入轮数」：按行 turnId 去重（一轮工具循环有多次模型请求）；
 *    turnId 缺失的行各计一轮兜底。
 * 3. speedTrend 元素为 { t, tokPerSec }（t = 该轮 completedAt），最多保留最近 10 轮。
 * 4. 行 status 严格判定：仅 status === 'completed' 计入完成态；未知状态一律忽略（宁可少算不可串数）。
 * 5. 返回值再扩展顶层 tools 明细分组 { total, errors, list: [{ name, count, durationMs, errors }] }：
 *    仅计 kind='tool' 且 status ∈ {completed, error} 的行（running 不计）；total/errors 含 error 行；
 *    durationMs = Σ(completedAt−startedAt) 且含 error 行（对齐原插件工具明细的有意差异，
 *    timing.toolTimeMs 仍仅算 completed 行）；时间戳缺失/倒挂的行计次不计时长。
 *    list 按 count 降序、同次数按工具名升序。
 */

// 有效生成窗口下限（ms）：滤掉瞬时的元请求/探测请求
const MIN_WINDOW_MS = 200;
// 有效生成窗口上限（ms）：1 小时，滤掉挂起的僵尸行
const MAX_WINDOW_MS = 60 * 60 * 1000;
// 运行中子代理的速度回推窗口（ms）：只认该子会话最近 2 分钟内跑完的请求段。
// 宿主运行期不写 running 行，实时证据只有「刚完成的段」；窗口过宽会把子代理上一轮的
// 旧读数当成当下速度（用户看到条上一个不动的假读数），过窄则在长工具调用期间闪烁成 --。
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;
// 速度趋势保留轮数（R6"最近速度趋势"占位数据接口）
const TREND_MAX = 10;
// 子代理明细弹层最多展示的行数
const SUBAGENT_DETAIL_MAX = 20;

/** 数值安全读取：非有限数值一律视为缺失（null），聚合时跳过 */
function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/** 是否子代理行（R5：子代理不计入主口径） */
function isSubagent(row) {
  return !!(row && row.isSubagent === true);
}

/**
 * 用户输入轮数：按 turnId 去重计数（独立小函数，便于单测）。
 * 一轮的工具循环会产生多次模型请求，都共享同一 turn_id——直接数行数会把 1 轮数成 N 轮。
 * turnId 缺失（旧库缺列/瘦身夹具）的行各自按独立一轮计：宁可多算，不把真实轮次算丢。
 */
function countTurns(rows) {
  const seen = new Set();
  let n = 0;
  for (const r of rows) {
    const tid = r ? r.turnId : null;
    if (typeof tid === 'string' && tid) {
      if (seen.has(tid)) continue;
      seen.add(tid);
    }
    n += 1;
  }
  return n;
}

/**
 * 相对耗时指标优先；旧库回退请求跨度。接近请求末尾的 TTFT 可能是队列 flush，
 * 不用它缩窗。思考 token 已含在 output 中，不能扣掉首字前的思考阶段。
 */
function rowWindowMs(row) {
  if (!row || typeof row !== 'object') return null;
  const end = num(row.completedAt);
  const started = num(row.startedAt);
  const elapsed = end != null && started != null && end >= started ? end - started : null;
  const duration = num(row.durationMs);
  const ms = duration != null && duration > 0 ? duration : elapsed;
  if (ms == null) return null;
  const thinking = row.thinking === true || /claude/i.test(row.model || '');
  const ttft = num(row.ttftMs);
  if (!thinking && ttft != null && ttft >= 0 && ttft < ms * 0.97 && isCountedWindow(ms - ttft)) {
    return ms - ttft;
  }
  return ms;
}

/** 有效窗口判定：200ms ≤ 窗 < 1h（独立小函数，便于单测边界） */
function isCountedWindow(ms) {
  return ms != null && ms >= MIN_WINDOW_MS && ms < MAX_WINDOW_MS;
}

/** 按 key 求和（忽略缺失/非有限值） */
function sumBy(list, key) {
  let s = 0;
  for (const r of list) {
    const v = num(r ? r[key] : null);
    if (v != null) s += v;
  }
  return s;
}

/**
 * 子代理面板条目列表（CONTRACT §4.2 subagent.list）。
 *
 * 两个来源合并成一种形状：
 * - kind='subagent' 的投影行：存在性与任务名。运行中的子代理只在这里有记录，
 *   因为宿主在子代理跑完之前不写 model_usage。
 * - kind='model' 且 isSubagent 的行：token 与速度，带 sid = 子会话 id。
 *
 * 关联键用 childSessionId。对不上任何 kind='subagent' 行的 model 行独立成条——
 * 宁可多一行，也不把两个子代理的数据混作一个。
 *
 * @param {Array<object>} rows 全部请求行（含主会话行，逐行过滤）
 * @param {number} now 当前时间（ms），用于运行中条目的实时耗时
 */
function buildSubagentList(rows, now) {
  const byChild = new Map(); // childSessionId → 条目
  const items = [];

  function blank(key, child, callId) {
    return {
      key: key,
      toolCallId: callId || null,
      childSessionId: child || null,
      type: null,
      task: null,
      status: 'completed',
      startedAt: null,
      endedAt: null,
      durationMs: null,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      tpsAvg: null,
      tpsLive: null,
      recentOut: 0,
      recentSec: 0,
    };
  }

  // 第一遍：投影行给出存在性、任务名、状态
  // 两条投影行指向同一子会话（同一 Agent 重试 / 回执重复）时合并成一条：
  // 否则列表出现两行同 key，点第二行详情会显示第一行的数据。
  let projSeq = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object' || r.kind !== 'subagent') continue;
    const child = typeof r.childSessionId === 'string' ? r.childSessionId : null;
    const callId = r.id != null ? String(r.id) : null;
    const dup = child ? byChild.get(child) : null;
    if (dup) {
      // 状态取更"活跃"的一侧：任一侧还在跑就是运行中
      if (normalizeSubStatus(r.status) === 'running') {
        dup.status = 'running';
        dup.endedAt = null;
      }
      const s = num(r.startedAt);
      if (s != null && (dup.startedAt == null || s < dup.startedAt)) dup.startedAt = s;
      continue;
    }
    // key 必须唯一：投影行理论上都有 call id，缺了就用序号兜底，避免多行同键
    const item = blank(child || callId || ('sub:' + (projSeq += 1)), child, callId);
    item.type = typeof r.subagentType === 'string' && r.subagentType ? r.subagentType : null;
    item.task = typeof r.task === 'string' && r.task ? r.task : null;
    item.status = normalizeSubStatus(r.status);
    item.startedAt = num(r.startedAt);
    item.endedAt = item.status === 'running' ? null : num(r.completedAt);
    if (child) byChild.set(child, item);
    items.push(item);
  }

  // 第二遍：model 行回填 token / 请求数 / 速度窗口
  const speeds = new Map();
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    if (r.kind === 'subagent' || !isSubagent(r)) continue;
    const child = typeof r.sid === 'string' ? r.sid : null;
    let target = child ? byChild.get(child) : null;
    if (!target) {
      // 孤儿：有 token 但父会话的 Agent 工具行没解析出对应子会话（回执缺 agentId 且
      // 标题前缀对不上）。key 必须唯一，否则多条孤儿挤在空键上、点详情互相串。
      target = blank(child || ('orphan:' + r.id), child, null);
      target.status = normalizeSubStatus(r.status);
      if (child) byChild.set(child, target);
      items.push(target);
    }
    if (r.status === 'completed') target.requests += 1;
    target.inputTokens += num(r.inputTokens) || 0;
    target.outputTokens += num(r.outputTokens) || 0;
    target.cacheReadTokens += num(r.cacheReadTokens) || 0;
    target.cacheWriteTokens += num(r.cacheWriteTokens) || 0;
    const s = num(r.startedAt);
    if (s != null && (target.startedAt == null || s < target.startedAt)) target.startedAt = s;
    const e = num(r.completedAt);
    if (e != null && (target.endedAt == null || e > target.endedAt)) target.endedAt = e;
    const win = rowWindowMs(r);
    if (r.status === 'running') {
      // 运行中的 model 行（宿主若写）：窗口取 now − 首字，与主口径同用 200ms 下限
      const from = num(r.firstTokenAt) != null ? num(r.firstTokenAt) : s;
      const dur = from != null ? now - from : null;
      if (!isCountedWindow(dur)) continue;
      target.recentOut += num(r.outputTokens) || 0;
      target.recentSec += dur / 1000;
      continue;
    }
    const out = num(r.outputTokens);
    if (isCountedWindow(win) && out != null && out > 0) {
      const speed = speeds.get(target) || { output: 0, seconds: 0 };
      speed.output += out;
      speed.seconds += win / 1000;
      speeds.set(target, speed);
      // 近期已完成段：宿主运行期不写 running 行（实库 0 条），运行中条目的实时速度
      // 只能靠「刚跑完的请求段」回推——每轮工具循环结束就落库一条。
      if (e != null && now - e <= ACTIVE_WINDOW_MS) {
        target.recentOut += out;
        target.recentSec += win / 1000;
      }
    }
  }

  const list = items.slice(-SUBAGENT_DETAIL_MAX);
  for (const it of list) {
    const end = it.status === 'running' ? now : it.endedAt;
    it.durationMs = it.startedAt != null && end != null && end >= it.startedAt ? end - it.startedAt : null;
    if (it.status === 'running') {
      // 运行中用近期段的加权速度；无近期段 → null，UI 显占位而不伪造
      it.tpsLive = it.recentSec > 0 ? it.recentOut / it.recentSec : null;
    } else {
      // 已完成条目的平均速度：按条目各自加权（口径同主会话），运行中不虚构
      const speed = speeds.get(it);
      if (speed) it.tpsAvg = speed.output / speed.seconds;
    }
  }

  const running = list.filter(function (it) { return it.status === 'running'; });
  running.sort(function (a, b) { return (a.startedAt || 0) - (b.startedAt || 0); });
  const done = list.filter(function (it) { return it.status !== 'running'; });
  done.sort(function (a, b) { return (b.endedAt || a.startedAt || 0) - (a.endedAt || b.startedAt || 0); });
  return running.concat(done);
}

/** 子代理状态归一：未知值一律按已完成处理（宁可少报运行中，不虚报活跃） */
function normalizeSubStatus(s) {
  if (s === 'running') return 'running';
  if (s === 'error') return 'error';
  if (s === 'cancelled') return 'cancelled';
  return 'completed';
}

/**
 * 聚合主入口。
 * @param {Array<object>} rows 请求行数组（形状见 CONTRACT.md；容忍坏行，逐行跳过）
 * @param {number} [now] 当前时间（ms），仅用于子代理活跃速度；缺省 Date.now()
 */
function aggregate(rows, now) {
  rows = Array.isArray(rows) ? rows : [];
  if (num(now) == null) now = Date.now();

  // 行分类：主会话完成请求 / 主会话完成工具调用 / 子代理行
  // kind='subagent' 的行零 token，只承载存在性与状态（见 buildSubagentList），
  // 不得进 subRows，否则会话累计 token 与活跃速度会被这些零值行污染。
  const mainCompleted = [];
  const toolCompleted = [];
  const toolEnded = [];
  const subRows = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (row.kind === 'subagent') continue;
    if (isSubagent(row)) {
      subRows.push(row);
      continue;
    }
    if (row.kind === 'tool') {
      if (row.status === 'completed') toolCompleted.push(row);
      if (row.status === 'completed' || row.status === 'error') toolEnded.push(row);
      continue;
    }
    if (row.status === 'completed') mainCompleted.push(row);
  }

  // ---- token 分项与总量（主会话完成请求；缓存已含在 input，不重复相加）----
  const input = sumBy(mainCompleted, 'inputTokens');
  const output = sumBy(mainCompleted, 'outputTokens');
  const cacheRead = sumBy(mainCompleted, 'cacheReadTokens');
  const cacheWrite = sumBy(mainCompleted, 'cacheWriteTokens');
  const totalTokens = input + output;
  const cacheHitRate = input > 0 ? cacheRead / input : null;

  // ---- 完成态会话均速度（R2）与速度趋势（R6）----
  let speedOut = 0;
  let speedSec = 0;
  const trend = [];
  for (const r of mainCompleted) {
    const win = rowWindowMs(r);
    if (!isCountedWindow(win)) continue;
    const out = num(r.outputTokens);
    if (out == null || out <= 0) continue;
    const sec = win / 1000;
    speedOut += out;
    speedSec += sec;
    trend.push({ t: num(r.completedAt), tokPerSec: out / sec });
  }
  trend.sort((a, b) => (a.t == null ? 1 : b.t == null ? -1 : a.t - b.t));
  const sessionAvgTokPerSec = speedSec > 0 ? speedOut / speedSec : null;

  // ---- 用时与 TTFT（R6 弹层）----
  let modelTimeMs = 0;
  for (const r of mainCompleted) {
    const s = num(r.startedAt);
    const e = num(r.completedAt);
    if (s != null && e != null && e >= s) modelTimeMs += e - s;
  }
  let toolTimeMs = 0;
  for (const r of toolCompleted) {
    const s = num(r.startedAt);
    const e = num(r.completedAt);
    if (s != null && e != null && e >= s) toolTimeMs += e - s;
  }
  let ttftSum = 0;
  let ttftN = 0;
  for (const r of mainCompleted) {
    const s = num(r.startedAt);
    const f = num(r.firstTokenAt);
    const measured = num(r.ttftMs);
    if (measured != null && measured >= 0) {
      ttftSum += measured;
      ttftN += 1;
      continue;
    }
    if (s != null && f != null && f >= s) {
      ttftSum += f - s;
      ttftN += 1;
    }
  }
  const ttftMs = ttftN > 0 ? ttftSum / ttftN : null;

  // ---- 工具调用明细（R6 弹层）----
  // 时长含 error 行：对齐原插件工具明细口径的有意差异；timing.toolTimeMs 仅算 completed 行是既有口径，保持不动。
  const toolAgg = new Map();
  let toolTotal = 0;
  let toolErrorTotal = 0;
  for (const r of toolEnded) {
    const name = typeof r.model === 'string' ? r.model : '';
    toolTotal += 1;
    if (r.status === 'error') toolErrorTotal += 1;
    let g = toolAgg.get(name);
    if (!g) {
      g = { name: name, count: 0, durationMs: 0, errors: 0 };
      toolAgg.set(name, g);
    }
    g.count += 1;
    if (r.status === 'error') g.errors += 1;
    const s = num(r.startedAt);
    const e = num(r.completedAt);
    if (s != null && e != null && e >= s) g.durationMs += e - s;
  }
  const toolsList = Array.from(toolAgg.values()).sort((a, b) =>
    b.count !== a.count ? b.count - a.count : a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );

  // ---- 子代理聚合（R5 双态）----
  // 面板条目先建，activeCount 取两者中更可信的来源：投影行是运行中子代理的唯一
  // 存在性证据（宿主跑完才写 model_usage），model 行则提供 token。
  const subList = buildSubagentList(rows, now);
  let activeCount = subList.filter(function (it) { return it.status === 'running'; }).length;
  // 运行中汇总速度 = 各运行中条目的实时速度合计。同一条子代理的近期段已在
  // buildSubagentList 里累计过，这里只按条目合并，无实时读数的条目不计入。
  let liveOut = 0;
  let liveSec = 0;
  for (const it of subList) {
    if (it.status !== 'running' || it.tpsLive == null) continue;
    liveOut += it.recentOut;
    liveSec += it.recentSec;
  }
  let subSessionTokens = 0;
  for (const r of subRows) {
    const inTok = num(r.inputTokens);
    const outTok = num(r.outputTokens);
    subSessionTokens += (inTok != null ? inTok : 0) + (outTok != null ? outTok : 0);
  }

  return {
    // R1 Activity：轮次 = 用户输入轮数（按 turnId 去重）；步数 = 主会话完成工具调用数
    turns: countTurns(mainCompleted),
    steps: toolCompleted.length,
    // R2 完成态口径（核实值；null = 无有效窗口）
    sessionAvgTokPerSec,
    cacheHitRate,
    totalTokens,
    tokens: { input, output, cacheRead, cacheWrite },
    timing: { modelTimeMs, toolTimeMs, ttftMs },
    speedTrend: trend.slice(-TREND_MAX),
    subagent: {
      activeCount,
      activeTokPerSec: liveSec > 0 ? liveOut / liveSec : null,
      sessionTokens: subSessionTokens,
      rows: subRows.slice(-SUBAGENT_DETAIL_MAX).map(function (r) {
        return {
          id: r.id != null ? r.id : null,
          model: typeof r.model === 'string' ? r.model : null,
          status: typeof r.status === 'string' ? r.status : null,
          outputTokens: num(r.outputTokens) != null ? num(r.outputTokens) : 0,
        };
      }),
      list: subList,
    },
    tools: { total: toolTotal, errors: toolErrorTotal, list: toolsList },
  };
}

module.exports = {
  aggregate,
  buildSubagentList,
  // 口径小函数（测试与内核对齐用）
  rowWindowMs,
  isCountedWindow,
  isSubagent,
  countTurns,
  // 常量
  MIN_WINDOW_MS,
  MAX_WINDOW_MS,
  TREND_MAX,
  SUBAGENT_DETAIL_MAX,
};
