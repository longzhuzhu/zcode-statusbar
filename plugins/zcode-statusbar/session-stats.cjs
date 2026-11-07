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
 * - 思考请求或 Claude 模型用 started_at 窗（completed_at − started_at）；
 *   其余用首字窗（completed_at − first_token_at，缺首字时间时退 started_at）。
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
 * 口径判定：该行生成窗口以哪端为起点（独立小函数，便于单测）。
 * 思考请求（row.thinking === true）或 Claude 系模型 → 'started_at'；其余 → 'first_token'。
 */
function windowBasis(row) {
  if (row && row.thinking === true) return 'started_at';
  if (row && typeof row.model === 'string' && /claude/i.test(row.model)) return 'started_at';
  return 'first_token';
}

/**
 * 单行生成窗口时长（ms）。
 * 思考/Claude：completed_at − started_at；其余：completed_at − first_token_at（缺首字退 started_at）。
 * 任一时间缺失或 end < 起点 → null（该行不参与速度口径）。
 */
function rowWindowMs(row) {
  if (!row || typeof row !== 'object') return null;
  const end = num(row.completedAt);
  if (end == null) return null;
  const started = num(row.startedAt);
  const first = num(row.firstTokenAt);
  let from;
  if (windowBasis(row) === 'started_at') {
    from = started;
  } else {
    from = first != null ? first : started;
  }
  if (from == null) return null;
  const ms = end - from;
  return ms >= 0 ? ms : null;
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
 * 聚合主入口。
 * @param {Array<object>} rows 请求行数组（形状见 CONTRACT.md；容忍坏行，逐行跳过）
 * @param {number} [now] 当前时间（ms），仅用于子代理活跃速度；缺省 Date.now()
 */
function aggregate(rows, now) {
  rows = Array.isArray(rows) ? rows : [];
  if (num(now) == null) now = Date.now();

  // 行分类：主会话完成请求 / 主会话完成工具调用 / 子代理行
  const mainCompleted = [];
  const toolCompleted = [];
  const toolEnded = [];
  const subRows = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
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
    const sec = win / 1000;
    // output 缺失按 0 计入：时长仍占分母（保持"Σ输出 ÷ Σ时长"原口径）
    speedOut += out != null ? out : 0;
    speedSec += sec;
    trend.push({ t: num(r.completedAt), tokPerSec: sec > 0 ? (out != null ? out : 0) / sec : 0 });
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
  let activeCount = 0;
  let activeOut = 0;
  let activeSec = 0;
  let subSessionTokens = 0;
  for (const r of subRows) {
    const inTok = num(r.inputTokens);
    const outTok = num(r.outputTokens);
    subSessionTokens += (inTok != null ? inTok : 0) + (outTok != null ? outTok : 0);
    if (r.status !== 'running') continue;
    activeCount += 1;
    // 活跃速度窗口：now −（首字时间优先，缺则 started_at）；与主口径同用 200ms 下限滤抖动
    const start = num(r.startedAt);
    const first = num(r.firstTokenAt);
    const from = first != null ? first : start;
    if (from == null) continue;
    const dur = now - from;
    if (!isCountedWindow(dur)) continue;
    activeOut += outTok != null ? outTok : 0;
    activeSec += dur / 1000;
  }

  return {
    // R1 Activity：轮次 = 主会话完成请求数；步数 = 主会话完成工具调用数
    turns: mainCompleted.length,
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
      activeTokPerSec: activeSec > 0 ? activeOut / activeSec : null,
      sessionTokens: subSessionTokens,
      rows: subRows.slice(-SUBAGENT_DETAIL_MAX).map(function (r) {
        return {
          id: r.id != null ? r.id : null,
          model: typeof r.model === 'string' ? r.model : null,
          status: typeof r.status === 'string' ? r.status : null,
          outputTokens: num(r.outputTokens) != null ? num(r.outputTokens) : 0,
        };
      }),
    },
    tools: { total: toolTotal, errors: toolErrorTotal, list: toolsList },
  };
}

module.exports = {
  aggregate,
  // 口径小函数（测试与内核对齐用）
  windowBasis,
  rowWindowMs,
  isCountedWindow,
  isSubagent,
  // 常量
  MIN_WINDOW_MS,
  MAX_WINDOW_MS,
  TREND_MAX,
  SUBAGENT_DETAIL_MAX,
};
