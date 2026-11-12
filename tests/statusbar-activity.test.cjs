'use strict';

/**
 * statusbar.js 活动弹层冒烟（node:test + vm DOM stub）：
 * 加载 IIFE → 派发 session 事件（真实 session-stats.cjs aggregate 形状，含 timing/speedTrend）→
 * 点击 activity pill → 断言弹层含「输出速度（TPS）」行（数值同会话均口径）与
 * 人类可读时长（X分Y秒 / X.X秒），以及空态兜底。
 * stub 面与 statusbar-usage.test.cjs 一致：querySelector 恒 null，趋势图 SVG 定点绘制
 * （layoutTrend）在桩下静默跳过，仅冒烟行结构；图表视觉由实机截图验收。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'statusbar', 'statusbar.js'), 'utf8');

function makeElement(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    className: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    title: '',
    type: '',
    id: '',
    dataset: {},
    style: { setProperty() {} },
    attrs: {},
    listeners: {},
    parentElement: null,
    parentNode: null,
    nextSibling: null,
    appendChild(child) {
      child.parentElement = child.parentNode = this;
      this.children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      child.parentElement = child.parentNode = this;
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i >= 0) this.children.splice(i, 0, child);
      else this.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
    },
    contains(target) {
      for (let cur = target; cur; cur = cur.parentElement) {
        if (cur === this) return true;
      }
      return false;
    },
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null;
    },
    addEventListener(type, fn) {
      (this.listeners[type] || (this.listeners[type] = [])).push(fn);
    },
    dispatchEvent(ev) {
      (this.listeners[ev.type] || []).forEach((fn) => fn(ev));
      return true;
    },
    querySelector(sel) {
      // 只支持类选择器：趋势图盒按 `.zsb-trend` 找，其余选择器返回 null。
      // 与浏览器一致，从自身子树开始匹配，不查后代之外。
      if (!sel || sel.charAt(0) !== '.') return null;
      const want = sel.slice(1);
      const stack = [...this.children];
      while (stack.length) {
        const node = stack.shift();
        if ((node.className || '').split(/\s+/).includes(want)) return node;
        stack.push(...(node.children || []));
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
  };
}

function fullText(node) {
  let out = typeof node.textContent === 'string' ? node.textContent : '';
  (node.children || []).forEach((c) => {
    out += fullText(c);
  });
  return out;
}

function loadStatusbar() {
  const anchor = makeElement('div');
  const host = makeElement('div');
  anchor.parentElement = host;
  const pane = makeElement('div');
  pane.attrs['data-session-id'] = 'sess-real';
  anchor.closest = () => pane; // isRealSession：锚点属真实会话（非 draft）

  const document = {
    head: makeElement('head'),
    body: makeElement('body'),
    documentElement: makeElement('html'),
    getElementById() {
      return null;
    },
    querySelector(selector) {
      return selector === '[data-zcode-composer]' ? anchor : null;
    },
    querySelectorAll() {
      return [];
    },
    createElement(tag) {
      return makeElement(tag);
    },
    addEventListener() {},
  };

  const window = {
    document,
    __ZCODE_STATUSBAR_BRIDGE__: { getPaneId: () => 'pane-test', getSessionSnapshot: () => null },
    localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    listeners: {},
    addEventListener(type, fn) {
      (window.listeners[type] || (window.listeners[type] = [])).push(fn);
    },
    dispatchEvent(ev) {
      (window.listeners[ev.type] || []).forEach((fn) => fn(ev));
      return true;
    },
  };
  class CustomEvent {
    constructor(type, opts) {
      this.type = type;
      this.detail = opts ? opts.detail : undefined;
    }
  }
  window.CustomEvent = CustomEvent;

  const ctx = {
    window,
    document,
    navigator: { userAgent: 'node-test' },
    CustomEvent,
    // 定时器停摆：周期渲染/挂载轮询不得让测试进程挂起
    setInterval() {
      return null;
    },
    clearInterval() {},
    setTimeout() {
      return null;
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'statusbar.js' });
  return { window, host };
}

function mountActivityPop(env) {
  const bar = env.host.children.find((n) => n.className === 'zsb-bar');
  assert.ok(bar, '状态条已挂载');
  const actPill = bar.children.find((n) => n.dataset && n.dataset.zsbPill === 'activity');
  assert.ok(actPill, 'activity pill 存在');
  actPill.dispatchEvent({ type: 'click', target: actPill });
  const pop = bar.children.find((n) => n.className === 'zsb-pop');
  assert.ok(pop, '弹层容器存在');
  return pop;
}

// 真实链路：aggregate() 产出 timing/speedTrend/sessionAvgTokPerSec，经 { aggregate } 包裹喂给 session 事件。
// 主行设计：modelTime 635s → 10分35秒；ttft 9.5s → 9.5秒；
// 生成窗 = completed − started = 635s，75060 输出 → TPS 约 118（整段跨度口径）。
function sessionDetail() {
  const { aggregate } = require('../statusbar/session-stats.cjs');
  const main = (over) =>
    Object.assign(
      {
        id: 'r',
        kind: 'request',
        isSubagent: false,
        model: 'glm-test',
        thinking: false,
        status: 'completed',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      over
    );
  return {
    aggregate: aggregate([
      main({
        id: 'm1',
        startedAt: 1000,
        firstTokenAt: 10500,
        completedAt: 636000,
        outputTokens: 75060,
      }),
    ]),
  };
}

test('活动弹层含「输出速度（TPS）」行与人类可读时长', () => {
  const env = loadStatusbar();
  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', { detail: sessionDetail() })
  );

  const pop = mountActivityPop(env);
  assert.equal(pop.hidden, false, '点击 activity 后弹层打开');

  const text = fullText(pop);
  assert.ok(text.includes('模型用时'), '模型用时行渲染');
  assert.ok(text.includes('10分35秒'), '模型用时为 X分Y秒 格式');
  assert.ok(text.includes('首字延迟'), '首字延迟行渲染');
  assert.ok(text.includes('9.5秒'), '首字延迟为 X.X秒 格式');
  assert.ok(text.includes('输出速度（TPS）'), 'TPS 行渲染');
  assert.ok(text.includes('118 tok/s'), 'TPS 数值与底部状态条同源（会话均口径）');
  assert.ok(text.includes('速度趋势'), '趋势区标题渲染');
});

test('趋势图渲染为平滑曲线：三次贝塞尔路径，无折线 polyline', () => {
  const { aggregate } = require('../statusbar/session-stats.cjs');
  const rows = [];
  for (let i = 0; i < 6; i++) {
    rows.push({
      id: 'r' + i,
      kind: 'model',
      isSubagent: false,
      model: 'glm-test',
      thinking: false,
      status: 'completed',
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      startedAt: i * 10_000,
      firstTokenAt: i * 10_000 + 500,
      completedAt: i * 10_000 + 5_000, // 窗恒 5s
      outputTokens: [100, 900, 300, 700, 200, 500][i] * 5, // → 100/900/300/700/200/500 tok/s
    });
  }
  const env = loadStatusbar();
  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', { detail: { aggregate: aggregate(rows) } })
  );
  const pop = mountActivityPop(env);
  const box = pop.querySelector('.zsb-trend');
  assert.ok(box, '趋势图盒子存在');
  const svg = box.innerHTML;
  assert.ok(svg.includes('<svg'), 'SVG 已补画（layoutTrend 消费 pendingTrend）');
  assert.ok(!svg.includes('<polyline'), '不再输出折线');
  assert.ok(/ d="M[\d.]+,[\d.]+ C/.test(svg), '曲线路径由 M + C 段组成');
  const strokes = svg.match(/<path d="[^"]+" fill="none"/g) || [];
  assert.equal(strokes.length, 1, '描边只有一条曲线路径');
  const circles = svg.match(/<circle /g) || [];
  assert.equal(circles.length, 6, '每个样本仍有一个数据点');
});

test('无数据时 TPS 行显 --、趋势区空态兜底', () => {
  const env = loadStatusbar();
  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', {
      detail: {
        aggregate: {
          turns: 0,
          steps: 0,
          sessionAvgTokPerSec: null,
          cacheHitRate: null,
          totalTokens: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          timing: { modelTimeMs: 0, toolTimeMs: 0, ttftMs: null },
          speedTrend: [],
          subagent: { activeCount: 0, activeTokPerSec: null, sessionTokens: 0, rows: [] },
        },
      },
    })
  );

  const pop = mountActivityPop(env);
  const text = fullText(pop);
  assert.ok(text.includes('输出速度（TPS）'), 'TPS 行渲染');
  assert.ok(text.includes('-- tok/s') || /输出速度（TPS）--/.test(text.replace(/\s+/g, '')), 'TPS 无数据显 --');
  assert.ok(text.includes('暂无数据'), '趋势区空态兜底');
});


test('活动弹层打开时 TPS 随实时样本刷新，过期后回落到完成请求速度', () => {
  const env = loadStatusbar();
  env.window.dispatchEvent(new env.window.CustomEvent('zcode-statusbar:session', { detail: sessionDetail() }));
  const pop = mountActivityPop(env);
  env.window.dispatchEvent(new env.window.CustomEvent('zcode-statusbar:turn', {
    detail: { tokPerSec: 222, estimated: true, updatedAt: Date.now() },
  }));
  assert.ok(fullText(pop).includes('222 tok/s'));
  env.window.dispatchEvent(new env.window.CustomEvent('zcode-statusbar:turn', {
    detail: { tokPerSec: 0, estimated: true, updatedAt: Date.now() - 4000 },
  }));
  assert.ok(fullText(pop).includes('118 tok/s'));
});

// 两个完成请求：各 100s 窗，输出 1000 / 5000 → 单段 10 / 50，会话均速 6000/200s = 30。
function twoRequestDetail() {
  const { aggregate } = require('../statusbar/session-stats.cjs');
  const base = {
    kind: 'model',
    isSubagent: false,
    model: 'glm-test',
    thinking: false,
    status: 'completed',
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  return {
    aggregate: aggregate([
      Object.assign({}, base, {
        id: 'slow',
        startedAt: 1_000,
        firstTokenAt: 1_500,
        completedAt: 101_000,
        outputTokens: 1_000,
      }),
      Object.assign({}, base, {
        id: 'fast',
        startedAt: 101_000,
        firstTokenAt: 101_500,
        completedAt: 201_000,
        outputTokens: 5_000,
      }),
    ]),
  };
}

function valueOf(pop, cls) {
  const node = pop.querySelector('.' + cls);
  assert.ok(node, cls + ' 行存在');
  return node.textContent;
}

test('TPS 行取最近完成请求速度，会话均速单独成行', () => {
  const env = loadStatusbar();
  env.window.dispatchEvent(new env.window.CustomEvent('zcode-statusbar:session', { detail: twoRequestDetail() }));

  const pop = mountActivityPop(env);
  assert.equal(valueOf(pop, 'zsb-activity-speed'), '50 tok/s', 'TPS = 最近完成请求（与趋势末点同源）');
  assert.equal(valueOf(pop, 'zsb-activity-avg'), '30 tok/s', '会话均速 = Σ输出 ÷ Σ有效窗');

  const bar = env.host.children.find((n) => n.className === 'zsb-bar');
  const actPill = bar.children.find((n) => n.dataset && n.dataset.zsbPill === 'activity');
  assert.ok(fullText(actPill).includes('50 tok/s'), '底部速度数字与 TPS 行同源');
});

test('旧内核帧缺 speedTrend 时回退会话均速，不显 --', () => {
  const env = loadStatusbar();
  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', {
      detail: { aggregate: { turns: 1, steps: 2, sessionAvgTokPerSec: 42, totalTokens: 100 } },
    })
  );
  const pop = mountActivityPop(env);
  assert.equal(valueOf(pop, 'zsb-activity-speed'), '42 tok/s');
  assert.equal(valueOf(pop, 'zsb-activity-avg'), '42 tok/s');
});

test('活动弹层随新聚合帧刷新耗时与曲线，不冻结在打开时刻', () => {
  const { aggregate } = require('../statusbar/session-stats.cjs');
  const base = {
    kind: 'model',
    isSubagent: false,
    model: 'glm-test',
    thinking: false,
    status: 'completed',
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const first = Object.assign({}, base, {
    id: 'a',
    startedAt: 1_000,
    firstTokenAt: 1_500,
    completedAt: 101_000,
    outputTokens: 1_000,
  });
  const second = Object.assign({}, base, {
    id: 'b',
    startedAt: 101_000,
    firstTokenAt: 101_500,
    completedAt: 201_000,
    outputTokens: 5_000,
  });

  const env = loadStatusbar();
  const push = (rows) =>
    env.window.dispatchEvent(
      new env.window.CustomEvent('zcode-statusbar:session', { detail: { aggregate: aggregate(rows) } })
    );

  push([first]);
  const pop = mountActivityPop(env);
  assert.ok(fullText(pop).includes('1分40秒'), '打开时耗时来自首帧');
  assert.ok(pop.querySelector('.zsb-trend').innerHTML.includes('>10 tok/s</text>'), '打开时曲线末点为 10');

  push([first, second]);
  assert.ok(fullText(pop).includes('3分20秒'), '新聚合帧到达后耗时随之刷新');
  assert.ok(pop.querySelector('.zsb-trend').innerHTML.includes('>50 tok/s</text>'), '新聚合帧到达后曲线随之刷新');
});
