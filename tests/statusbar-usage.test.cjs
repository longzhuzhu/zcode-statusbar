'use strict';

/**
 * statusbar.js 用量弹层冒烟（node:test + vm DOM stub）：
 * 加载 IIFE → 派发 session 事件（真实 session-stats.cjs aggregate 形状，含 tools + today 帧）→
 * 点击 usage pill → 断言「用量」分组含缓存占比、「今日用量」分组含 token 总量与平均缓存率、
 * 「工具调用」分组只剩每工具行（无合计行、无错误计数），以及空态兜底。
 * stub 只覆盖 IIFE 实际触达的宿主面：createElement/appendChild/insertBefore/addEventListener/
 * dispatchEvent/className/textContent/innerHTML/hidden/setAttribute/dataset/style/closest。
 * statusbar.js 全程 className 直赋、不用 classList，故未 stub classList。
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
    querySelector() {
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
    // 挂载锚点（MOUNT_ANCHORS 首个候选）返回伪锚点；其余选择器（上下文锚点等）一律未命中
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

function mountUsagePop(env) {
  const bar = env.host.children.find((n) => n.className === 'zsb-bar');
  assert.ok(bar, '状态条已挂载');
  const usagePill = bar.children.find((n) => n.dataset && n.dataset.zsbPill === 'usage');
  assert.ok(usagePill, 'usage pill 存在');
  usagePill.dispatchEvent({ type: 'click', target: usagePill });
  const pop = bar.children.find((n) => n.className === 'zsb-pop');
  assert.ok(pop, '弹层容器存在');
  return pop;
}

// 真实链路：session-stats.cjs aggregate() 产出的形状经内核 detail 包裹（{ aggregate, today }）喂给 session 事件
function sessionDetail(today) {
  const { aggregate } = require('../statusbar/session-stats.cjs');
  const base = {
    id: 'r',
    kind: 'tool',
    isSubagent: false,
    model: 'Bash',
    thinking: false,
    status: 'completed',
    startedAt: 1000,
    firstTokenAt: null,
    completedAt: 2500,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const tool = (over) => Object.assign({}, base, over);
  const model = (over) => Object.assign({}, base, { id: 'm', kind: 'model' }, over);
  const detail = {
    aggregate: aggregate([
      model({ id: 'm1', startedAt: 1000, completedAt: 4000, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 700 }),
      tool({ id: 't1', model: 'Bash', status: 'completed', startedAt: 1000, completedAt: 2500 }),
      tool({ id: 't2', model: 'Bash', status: 'error', startedAt: 3000, completedAt: 3600 }),
      tool({ id: 't3', model: 'Read', status: 'completed', startedAt: 1000, completedAt: 1500 }),
    ]),
  };
  if (today !== undefined) detail.today = today;
  return detail;
}

function mountWithDetail(detail) {
  const env = loadStatusbar();
  env.window.dispatchEvent(new env.window.CustomEvent('zcode-statusbar:session', { detail }));
  return mountUsagePop(env);
}

test('「用量」分组底部给出缓存占比', () => {
  const pop = mountWithDetail(sessionDetail());

  const text = fullText(pop);
  assert.ok(text.includes('输入'), '输入分项渲染');
  assert.ok(text.includes('缓存读'), '缓存读分项渲染');
  assert.ok(text.includes('缓存占比'), '缓存占比标签渲染');
  assert.ok(text.includes('70%'), '缓存占比 = cacheRead 700 ÷ input 1000');
});

test('「今日用量」分组给出 token 总用量与平均缓存率', () => {
  const pop = mountWithDetail(
    sessionDetail({ input: 3000, output: 500, cache_read: 1800, cache_write: 0 })
  );

  const text = fullText(pop);
  assert.ok(text.includes('今日用量'), '今日分组标题渲染');
  assert.ok(text.includes('token 总用量'), '总用量标签渲染');
  assert.ok(text.includes('3.5K'), '总用量 = input 3000 + output 500');
  assert.ok(text.includes('平均缓存率'), '平均缓存率标签渲染');
  assert.ok(text.includes('60%'), '平均缓存率 = cache_read 1800 ÷ input 3000');
});

test('帧缺 today 块时「今日用量」整组不渲染', () => {
  const pop = mountWithDetail(sessionDetail());

  assert.ok(!fullText(pop).includes('今日用量'), '无今日数据不留空壳分组');
});

test('「工具调用」分组只有每工具行：无合计行、无错误计数', () => {
  const pop = mountWithDetail(sessionDetail());

  const text = fullText(pop);
  assert.ok(text.includes('工具调用'), '分组标题渲染');
  assert.ok(!text.includes('合计'), '合计行已删除');
  assert.ok(!text.includes('错误'), '错误计数已删除');
  assert.ok(text.includes('Bash'), '工具名渲染');
  assert.ok(text.includes('2次 · 2.10s'), '工具行 = 次数 + 时长（error 行时长仍计入）');
  assert.ok(text.includes('Read'), '第二个工具名渲染');
  assert.ok(text.includes('1次 · 500ms'), '第二行读数');
});

test('无 tools 数据时「工具调用」分组显示空态兜底', () => {
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

  const pop = mountUsagePop(env);
  const text = fullText(pop);
  assert.ok(text.includes('工具调用'), '分组标题渲染');
  assert.ok(text.includes('暂无数据'), '空态兜底文案');
});
