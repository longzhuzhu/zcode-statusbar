'use strict';

/**
 * statusbar.js 上下文弹层（形态对齐 deepseek ContextMeter）回归：
 * 头部一行读数（比例 + used/total）、分段占用条按来源份额切分、图例行显示占比。
 * 数据两源：水位读宿主隐藏锚点 [data-usage-used]/[data-usage-max]；
 * 来源明细读桥的 getSessionSnapshot().snapshot.usage.contextWindow.breakdown。
 * 桥缺席或 breakdown 缺失时退化为单色条且不渲染图例（绝不猜测分项）。
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
      if (sel === '.zsb-ring-fill') return this.children.find((c) => c.className === 'zsb-ring-fill') || null;
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

function descendants(node, out = []) {
  (node.children || []).forEach((c) => {
    out.push(c);
    descendants(c, out);
  });
  return out;
}

/**
 * @param {{used?: string, max?: string, snapshot?: object|null, breakdown?: object[]|null}} opts
 *   used/max 写入宿主隐藏锚点；snapshot 为桥返回的 ConversationStoreState；
 *   breakdown 为桥窄投影 getContextBreakdown 的返回（两者互斥，用于分别覆盖新旧路径）。
 */
function loadStatusbar(opts = {}) {
  const anchor = makeElement('div');
  const host = makeElement('div');
  anchor.parentElement = host;
  const pane = makeElement('div');
  pane.attrs['data-session-id'] = 'sess-real';
  anchor.closest = () => pane;

  const usageHost = makeElement('span');
  if (opts.used !== undefined) usageHost.attrs['data-usage-used'] = opts.used;
  if (opts.max !== undefined) usageHost.attrs['data-usage-max'] = opts.max;

  const document = {
    head: makeElement('head'),
    body: makeElement('body'),
    documentElement: makeElement('html'),
    getElementById() {
      return null;
    },
    querySelector(selector) {
      if (selector === '[data-zcode-composer]') return anchor;
      if (selector === '[data-usage-used]') return opts.used === undefined ? null : usageHost;
      return null;
    },
    querySelectorAll() {
      return [];
    },
    createElement(tag) {
      return makeElement(tag);
    },
    addEventListener() {},
  };

  const bridge = {
    getPaneId: () => 'pane-test',
    getSessionSnapshot: () => (opts.snapshot === undefined ? null : opts.snapshot),
  };
  // breakdown 显式给出时安装窄投影方法（模拟新版桥）；否则走旧快照回退路径
  if (opts.breakdown !== undefined) {
    bridge.getContextBreakdown = () => ({ used: null, size: null, breakdown: opts.breakdown });
  }
  const window = {
    document,
    __ZCODE_STATUSBAR_BRIDGE__: bridge,
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
    constructor(type, evOpts) {
      this.type = type;
      this.detail = evOpts ? evOpts.detail : undefined;
    }
  }
  window.CustomEvent = CustomEvent;

  const ctx = {
    window,
    document,
    navigator: { userAgent: 'node-test' },
    CustomEvent,
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

function openContextPop(env) {
  const bar = env.host.children.find((n) => n.className === 'zsb-bar');
  assert.ok(bar, '状态条已挂载');
  const pill = bar.children.find((n) => n.dataset && n.dataset.zsbPill === 'context');
  assert.ok(pill, '上下文 pill 存在');
  pill.dispatchEvent({ type: 'click', target: pill });
  const pop = bar.children.find((n) => n.className === 'zsb-pop');
  assert.ok(pop, '弹层容器存在');
  return pop;
}

function snapshotWith(breakdown) {
  return { snapshot: { usage: { contextWindow: { usedTokens: 11400, maxTokens: 262000, breakdown } } } };
}

test('头部一行同时给出占比与 used/total（对齐 deepseek header）', () => {
  const env = loadStatusbar({ used: '11400', max: '262000' });
  const pop = openContextPop(env);
  const text = fullText(pop);
  assert.ok(text.includes('上下文已用'), '前导文案渲染');
  assert.ok(text.includes('4%'), '占比读数渲染');
  assert.ok(text.includes('11.4K / 262K'), 'used / total 同源渲染（大数值去假精度）');
  assert.equal(pop.hidden, false);
});

test('breakdown 按三桶切分：分段条 3 段 + 图例 3 行，图例值是按份额分配的 token', () => {
  const env = loadStatusbar({
    used: '11400',
    max: '262000',
    snapshot: snapshotWith([
      { source: 'system_prompt', chars: 1400 },
      { source: 'meta_user_context', chars: 200 },
      { source: 'system_tool_schemas', chars: 6000 },
      { source: 'mcp_tool_schemas', chars: 1100 },
      { source: 'messages', chars: 3100 },
    ]),
  });
  const pop = openContextPop(env);
  const nodes = descendants(pop);
  const segs = nodes.filter((n) => n.className === 'zsb-ctxseg');
  assert.equal(segs.length, 3, '三个来源桶各一段');
  const rows = nodes.filter((n) => n.className === 'zsb-ctxrow');
  assert.equal(rows.length, 3, '图例三行');

  const text = fullText(pop);
  assert.ok(text.includes('系统提示词'), '系统提示词行');
  assert.ok(text.includes('工具定义'), '工具定义行');
  assert.ok(text.includes('对话消息'), '对话消息行');
  // 分项 token = 头部已用 11400 × 桶内份额，三行之和必须回到头部总量
  // system 1600/11800 → 0.1356 × 11400 ≈ 1546；tools 7100/11800 ≈ 0.6017 → 6860；messages 3100/11800 ≈ 0.2627 → 2995
  assert.ok(text.includes('~1.5K'), 'system 份额 13.6% → ~1.5K');
  assert.ok(text.includes('~6.9K'), 'tools 份额 60.2% → ~6.9K');
  assert.ok(text.includes('~3.0K'), 'messages 份额 26.3% → ~3.0K');
  assert.ok(!text.includes(' chars'), '不暴露原始 chars');
  assert.ok(!/\b14%\b/.test(text), '图例不再显示占比');
  // 分段宽度 = 总水位 4.35% × 份额；三段之和回到总水位
  const widths = segs.map((s) => parseFloat(s.style.width));
  const sum = widths.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - (11400 / 262000) * 100) < 0.01, '分段宽度之和等于总水位');
});

test('未知 source 不计入：比例在已知来源内归一，不猜归属', () => {
  const env = loadStatusbar({
    used: '1000',
    max: '10000',
    snapshot: snapshotWith([
      { source: 'messages', chars: 500 },
      { source: 'brand_new_source', chars: 500 },
    ]),
  });
  const pop = openContextPop(env);
  const text = fullText(pop);
  assert.ok(text.includes('~1.0K'), '唯一已知来源占满全部已用水位');
  assert.equal(descendants(pop).filter((n) => n.className === 'zsb-ctxrow').length, 1, '未知来源不新增行');
});

test('breakdown 缺席时退化为单色条且不渲染图例', () => {
  const env = loadStatusbar({ used: '11400', max: '262000', snapshot: snapshotWith(undefined) });
  const pop = openContextPop(env);
  const nodes = descendants(pop);
  assert.equal(nodes.filter((n) => n.className === 'zsb-ctxseg').length, 0, '无分段');
  assert.equal(nodes.filter((n) => n.className === 'zsb-ctxrow').length, 0, '无图例');
  assert.equal(nodes.filter((n) => n.className === 'zsb-ctxbar-fill').length, 1, '单色条兜底');
  const text = fullText(pop);
  assert.ok(text.includes('4%'), '水位读数仍然显示');
  assert.ok(!text.includes('系统提示词'), '不渲染猜测分项');
});

test('桥返回 null（store 未就绪）时同样走单色降级', () => {
  const env = loadStatusbar({ used: '11400', max: '262000', snapshot: null });
  const pop = openContextPop(env);
  const nodes = descendants(pop);
  assert.equal(nodes.filter((n) => n.className === 'zsb-ctxrow').length, 0);
  assert.equal(nodes.filter((n) => n.className === 'zsb-ctxbar-fill').length, 1);
});

test('小份额来源不被抹成 0：份额极小仍给出可读 token 数', () => {
  const env = loadStatusbar({
    used: '1000',
    max: '10000',
    snapshot: snapshotWith([
      { source: 'messages', chars: 9960 },
      { source: 'system_prompt', chars: 40 },
    ]),
  });
  const pop = openContextPop(env);
  const text = fullText(pop);
  assert.ok(text.includes('~996'), 'messages 份额 99.6% → ~996');
  assert.ok(text.includes('~4'), 'system 份额 0.4% → ~4（不抹成 0）');
});

test('优先走桥的窄投影 getContextBreakdown，不触发整份快照深拷贝', () => {
  let snapshotCalls = 0;
  const env = loadStatusbar({
    used: '11400',
    max: '262000',
    breakdown: [{ source: 'messages', chars: 100 }],
  });
  // 包一层计数：窄投影在，快照路径必须一次都不走
  const bridge = env.window.__ZCODE_STATUSBAR_BRIDGE__;
  const original = bridge.getSessionSnapshot;
  bridge.getSessionSnapshot = () => {
    snapshotCalls += 1;
    return original();
  };
  const pop = openContextPop(env);
  assert.equal(snapshotCalls, 0, '窄投影可用时不得读整份快照');
  assert.ok(fullText(pop).includes('对话消息'), '窄投影数据已用于图例');
});

test('窄投影返回空 breakdown 时与缺席同待遇：单色降级', () => {
  const env = loadStatusbar({ used: '11400', max: '262000', breakdown: null });
  const pop = openContextPop(env);
  const nodes = descendants(pop);
  assert.equal(nodes.filter((n) => n.className === 'zsb-ctxrow').length, 0);
  assert.equal(nodes.filter((n) => n.className === 'zsb-ctxbar-fill').length, 1);
});
