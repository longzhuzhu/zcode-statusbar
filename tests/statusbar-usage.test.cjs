'use strict';

/**
 * statusbar.js 用量弹层冒烟（node:test + vm DOM stub）：
 * 加载 IIFE → 派发 session 事件（真实 session-stats.cjs aggregate 形状，含 tools）→
 * 点击 usage pill → 断言弹层含「工具调用」分组标题、合计行与每工具左右布局行，以及空态兜底。
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

// 真实链路：session-stats.cjs aggregate() 产出的形状经内核 detail 包裹（{ aggregate }）喂给 session 事件
function sessionDetail() {
  const { aggregate } = require('../statusbar/session-stats.cjs');
  const tool = (over) =>
    Object.assign(
      {
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
      },
      over
    );
  return {
    aggregate: aggregate([
      tool({ id: 't1', model: 'Bash', status: 'completed', startedAt: 1000, completedAt: 2500 }),
      tool({ id: 't2', model: 'Bash', status: 'error', startedAt: 3000, completedAt: 3600 }),
      tool({ id: 't3', model: 'Read', status: 'completed', startedAt: 1000, completedAt: 1500 }),
    ]),
  };
}

test('用量弹层出现独立「工具调用」分组：合计行 + 每工具左右布局行', () => {
  const env = loadStatusbar();
  env.window.dispatchEvent(new env.window.CustomEvent('zcode-statusbar:session', { detail: sessionDetail() }));

  const pop = mountUsagePop(env);
  assert.equal(pop.hidden, false, '点击 usage 后弹层打开');

  const text = fullText(pop);
  assert.ok(text.includes('工具调用'), '分组标题渲染');
  assert.ok(text.includes('合计'), '合计行渲染');
  assert.ok(text.includes('3次 · 错误 1'), '合计 = total3 + 错误1');
  assert.ok(text.includes('Bash'), '工具名渲染');
  assert.ok(text.includes('2次 · 2.10s · 错误 1'), '工具行 = 次数 + 时长 + 错误');
  assert.ok(text.includes('Read'), '第二个工具名渲染');
  assert.ok(text.includes('1次 · 500ms'), '错误为 0 时省略错误段');
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
