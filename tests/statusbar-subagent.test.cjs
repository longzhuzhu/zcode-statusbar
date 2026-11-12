'use strict';

/**
 * statusbar.js 子代理面板冒烟（node:test + vm DOM stub，桩与 statusbar-usage.test.cjs 一致）：
 * 覆盖 AC2/AC5/AC6/AC9/AC13/AC14 —— pill 点击开面板、运行中/已完成分组、
 * 空组不渲染标题、点行进详情、返回回列表、无子代理时 pill 不占位。
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
    // 真实 DOM 语义：给 innerHTML 赋空串会清空子节点。弹层每次 openPop 都靠这一条重建
    // 内容，桩若只存字符串，旧节点会残留并掩盖"重建成叠加"这类真实缺陷。
    get innerHTML() {
      return this._innerHTML || '';
    },
    set innerHTML(v) {
      this._innerHTML = v;
      if (v === '') {
        this.children.forEach((c) => {
          c.parentElement = c.parentNode = null;
        });
        this.children = [];
        this.textContent = '';
      }
    },
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
    removeAttribute(k) {
      delete this.attrs[k];
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
    // 只支持本测试用到的属性选择器形态：[data-x]，沿祖先链上溯（真实 DOM 的 closest 语义）
    closest(sel) {
      const m = /^\[data-([\w-]+)\]$/.exec(String(sel || ''));
      if (!m) return null;
      const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      for (let cur = this; cur; cur = cur.parentElement) {
        if (cur.dataset && cur.dataset[key] != null) return cur;
      }
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

function findByClass(node, cls) {
  const out = [];
  if (String(node.className || '').split(/\s+/).includes(cls)) out.push(node);
  (node.children || []).forEach((c) => out.push(...findByClass(c, cls)));
  return out;
}

function loadStatusbar() {
  const anchor = makeElement('div');
  const host = makeElement('div');
  anchor.parentElement = host;
  const pane = makeElement('div');
  pane.attrs['data-session-id'] = 'sess-real';
  anchor.closest = () => pane;

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

function subPill(env) {
  const bar = env.host.children.find((n) => n.className === 'zsb-bar');
  assert.ok(bar, '状态条已挂载');
  return bar.children.find((n) => n.dataset && n.dataset.zsbPill === 'subagent');
}

function popOf(env) {
  const bar = env.host.children.find((n) => n.className === 'zsb-bar');
  return bar.children.find((n) => n.className === 'zsb-pop');
}

// 真实链路：aggregate() 产出的 subagent.list，经 { aggregate } 包裹喂给 session 事件
function detailWith(rows) {
  const { aggregate } = require('../statusbar/session-stats.cjs');
  return { aggregate: aggregate(rows, 10_000) };
}

function projected(over) {
  return Object.assign(
    {
      id: 'call_1',
      sid: 'sess-real',
      parentSid: 'sess-real',
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

test('子代理 pill：本会话无子代理时不占位（AC13）', () => {
  const env = loadStatusbar();
  env.window.dispatchEvent(new env.window.CustomEvent('zcode-statusbar:session', { detail: detailWith([]) }));
  const pill = subPill(env);
  assert.equal(pill.style.display, 'none', '从未出现子代理 → 不渲染');
});

test('子代理 pill：出现子代理后显形，全部结束仍保留（AC14）', () => {
  const env = loadStatusbar();
  // 先跑一个
  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', { detail: detailWith([projected({})]) })
  );
  assert.notEqual(subPill(env).style.display, 'none', '有运行中子代理 → 显形');
  // 再全结束（聚合结果里运行中条目变成已完成）
  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', {
      detail: detailWith([projected({ status: 'completed', completedAt: 9000 })]),
    })
  );
  assert.notEqual(subPill(env).style.display, 'none', '结束后粘滞保留');
});

test('子代理 pill：点击开面板，分「运行中」「已完成」两组（AC2）', () => {
  const env = loadStatusbar();
  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', {
      detail: detailWith([
        projected({ id: 'run1', status: 'running', startedAt: 5000 }),
        projected({
          id: 'done1',
          status: 'completed',
          startedAt: 1000,
          completedAt: 3000,
          subagentType: 'poteto-agent',
          task: '改代码',
        }),
      ]),
    })
  );
  const pill = subPill(env);
  pill.dispatchEvent({ type: 'click', target: pill });

  const pop = popOf(env);
  assert.equal(pop.hidden, false, '弹层打开');
  const text = fullText(pop);
  assert.ok(text.includes('运行中'), '运行中分组标题');
  assert.ok(text.includes('已完成'), '已完成分组标题');
  assert.ok(text.includes('Explore'), '运行中条目类型');
  assert.ok(text.includes('poteto-agent'), '已完成条目类型');
  assert.ok(text.includes('调研布局') && text.includes('改代码'), '任务概要渲染');
});

test('子代理面板：没有运行中条目时不渲染空组标题（AC9）', () => {
  const env = loadStatusbar();
  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', {
      detail: detailWith([projected({ id: 'd1', status: 'completed', startedAt: 0, completedAt: 2000 })]),
    })
  );
  const pill = subPill(env);
  pill.dispatchEvent({ type: 'click', target: pill });
  const text = fullText(popOf(env));
  assert.ok(!text.includes('运行中'), '无运行中条目 → 不出该组标题');
  assert.ok(text.includes('已完成'), '已完成组仍在');
});

test('子代理面板：运行中行状态点标绿，已完成行不标绿', () => {
  const env = loadStatusbar();
  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', {
      detail: detailWith([
        projected({ id: 'run1', status: 'running', startedAt: 5000 }),
        projected({ id: 'done1', status: 'completed', startedAt: 0, completedAt: 2000 }),
      ]),
    })
  );
  const pill = subPill(env);
  pill.dispatchEvent({ type: 'click', target: pill });
  const dots = findByClass(popOf(env), 'zsb-subdot');
  assert.equal(dots.length, 2);
  assert.equal(dots.filter((d) => d.className.includes('zsb-live')).length, 1, '运行中行标绿');
  assert.equal(dots.filter((d) => d.className.includes('zsb-pulse')).length, 0, '面板内不呼吸');
});

test('子代理 pill 运行态：绿点 + 速度，不显示活跃数', () => {
  const env = loadStatusbar();
  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', {
      detail: detailWith([
        projected({ id: 'run1', status: 'running', startedAt: 5000 }),
        projected({ id: 'run2', status: 'running', startedAt: 6000 }),
      ]),
    })
  );
  const pill = subPill(env);
  const texts = [];
  (function walk(n) {
    if (n.textContent) texts.push(n.textContent);
    (n.children || []).forEach(walk);
  })(pill);
  assert.equal(texts.filter((t) => t === '2').length, 0, '不渲染活跃数');
  assert.ok(
    findByClass(pill, 'zsb-livedot').some((d) => d.className.includes('zsb-pulse')),
    '运行中绿点呼吸'
  );
});

test('子代理面板：点行进详情，详情含状态与任务，返回回到列表（AC6）', () => {
  const env = loadStatusbar();
  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', {
      detail: detailWith([
        projected({ id: 'run1', status: 'running', startedAt: 5000, task: '调研布局' }),
      ]),
    })
  );
  const pill = subPill(env);
  pill.dispatchEvent({ type: 'click', target: pill });

  const pop = popOf(env);
  const rowEl = findByClass(pop, 'zsb-subrow')[0];
  assert.ok(rowEl, '列表里有可点的行');
  pop.dispatchEvent({ type: 'click', target: rowEl });

  const detailText = fullText(pop);
  assert.ok(detailText.includes('状态'), '详情含状态行');
  assert.ok(detailText.includes('任务'), '详情含任务行');
  assert.ok(detailText.includes('调研布局'), '任务概要');
  assert.ok(detailText.includes('返回'), '左上角有返回');

  // 运行中不显示 0 token：输出行是 --（不伪造读数）
  assert.ok(detailText.includes('--'), '运行中 token 显占位而非 0');

  const back = findByClass(pop, 'zsb-back')[0];
  assert.ok(back, '返回按钮存在');
  pop.dispatchEvent({ type: 'click', target: back });
  assert.ok(fullText(pop).includes('运行中'), '返回后回到列表（重新出现分组标题）');
});

test('子代理面板：无条目时显示空态文案，不抛错（AC9）', () => {
  const env = loadStatusbar();
  // 先让 pill 显形，再清空条目
  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', { detail: detailWith([projected({})]) })
  );
  env.window.dispatchEvent(new env.window.CustomEvent('zcode-statusbar:session', { detail: detailWith([]) }));
  const pill = subPill(env);
  pill.dispatchEvent({ type: 'click', target: pill });
  const text = fullText(popOf(env));
  assert.ok(text.includes('暂无数据'), '空态兜底');
});

test('用量弹层不再出现子代理分组（AC7）', () => {
  const env = loadStatusbar();
  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', {
      detail: detailWith([projected({ id: 'd1', status: 'completed', startedAt: 0, completedAt: 2000 })]),
    })
  );
  const bar = env.host.children.find((n) => n.className === 'zsb-bar');
  const usagePill = bar.children.find((n) => n.dataset && n.dataset.zsbPill === 'usage');
  usagePill.dispatchEvent({ type: 'click', target: usagePill });
  const text = fullText(popOf(env));
  assert.ok(!text.includes('子代理明细'), '用量弹层没有子代理分组标题');
});

test('子代理面板打开期间，新 session 数据到达会刷新行内容（读数不冻结）', () => {
  const env = loadStatusbar();
  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', {
      detail: detailWith([projected({ id: 'run1', task: '第一版任务' })]),
    })
  );
  const pill = subPill(env);
  pill.dispatchEvent({ type: 'click', target: pill });
  assert.ok(fullText(popOf(env)).includes('第一版任务'), '首次渲染');

  // 任务名在新一帧里变了：面板必须跟着变，否则用户看到的是冻结的旧读数
  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', {
      detail: detailWith([projected({ id: 'run1', task: '第二版任务' })]),
    })
  );
  const text = fullText(popOf(env));
  assert.ok(text.includes('第二版任务'), '面板随数据刷新');
  assert.ok(!text.includes('第一版任务'), '旧内容被替换，不是叠加');
});

test('子代理面板：详情页打开期间数据刷新，仍停在详情不被打回列表', () => {
  const env = loadStatusbar();
  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', {
      detail: detailWith([projected({ id: 'run1', task: '任务甲' })]),
    })
  );
  const pill = subPill(env);
  pill.dispatchEvent({ type: 'click', target: pill });
  const pop = popOf(env);
  pop.dispatchEvent({ type: 'click', target: findByClass(pop, 'zsb-subrow')[0] });
  assert.ok(fullText(pop).includes('状态'), '已进入详情');

  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', {
      detail: detailWith([projected({ id: 'run1', task: '任务乙' })]),
    })
  );
  const text = fullText(popOf(env));
  assert.ok(text.includes('状态'), '仍在详情视图');
  assert.ok(text.includes('任务乙'), '详情内容已更新');
});

test('子代理面板：其他弹层不受刷新影响（用量弹层保持打开时快照）', () => {
  const env = loadStatusbar();
  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', { detail: detailWith([projected({})]) })
  );
  const bar = env.host.children.find((n) => n.className === 'zsb-bar');
  const usagePill = bar.children.find((n) => n.dataset && n.dataset.zsbPill === 'usage');
  usagePill.dispatchEvent({ type: 'click', target: usagePill });
  const pop = popOf(env);
  assert.equal(pop.hidden, false);
  // 再来一帧数据：用量弹层不该被重建（重建会清掉正在看的列表，且用量本身不需要实时）
  const before = pop.children.length;
  env.window.dispatchEvent(new env.window.CustomEvent('zcode-statusbar:session', { detail: detailWith([]) }));
  assert.equal(pop.children.length, before, '用量弹层未被重建');
});

test('子代理面板：无类型的孤儿条目用子会话尾号兜底，不显示成同名占位', () => {
  const env = loadStatusbar();
  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', {
      detail: detailWith([
        projected({
          id: 'orphan1',
          status: 'completed',
          startedAt: 0,
          completedAt: 2000,
          subagentType: null,
          task: null,
          childSessionId: 'sess_subagent_agent_977-be2d-1807594d5135',
        }),
      ]),
    })
  );
  const pill = subPill(env);
  pill.dispatchEvent({ type: 'click', target: pill });
  // 只看名字列：面板标题本身含"子代理明细"，用整段文本断言会误判
  const names = findByClass(popOf(env), 'nm').map((n) => n.textContent);
  assert.equal(names.length, 1);
  assert.ok(/^#\w{6}$/.test(names[0]), '名字列显示子会话尾号：' + names[0]);
});

test('子代理 pill：切换到无子代理的会话时隐藏（粘滞标志按会话重置，AC15）', () => {
  const env = loadStatusbar();
  // detail 带 mine（内核注入的焦点会话 id），这才是换会话的判据：
  // 同一窗格切会话时 paneId 不变、unmountBar 不触发
  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', {
      detail: Object.assign({ mine: 'sess-A' }, detailWith([projected({})])),
    })
  );
  assert.notEqual(subPill(env).style.display, 'none', '会话 A 有子代理 → 显示');

  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', {
      detail: Object.assign({ mine: 'sess-B' }, detailWith([])),
    })
  );
  assert.equal(subPill(env).style.display, 'none', '会话 B 无子代理 → 隐藏');

  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', {
      detail: Object.assign({ mine: 'sess-A' }, detailWith([projected({})])),
    })
  );
  assert.notEqual(subPill(env).style.display, 'none', '切回 A → 重新显示');
});

test('子代理 pill：用户手动关闭开关时，粘滞标志不使它显示（AC16）', () => {
  const env = loadStatusbar();
  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', {
      detail: Object.assign({ mine: 'sess-A' }, detailWith([projected({})])),
    })
  );
  const bar = env.host.children.find((n) => n.className === 'zsb-bar');
  const gear = bar.children.find((n) => n.dataset && n.dataset.zsbPill === 'gear');
  gear.dispatchEvent({ type: 'click', target: gear });
  const pop = popOf(env);
  const menuItem = findByClass(pop, 'zsb-mi').find((n) => n.dataset.pill === 'subagent');
  assert.ok(menuItem, '菜单里有子代理开关');
  pop.dispatchEvent({ type: 'click', target: menuItem });

  assert.equal(subPill(env).style.display, 'none', '用户关闭后不显示');

  // 再来一帧子代理数据：粘滞标志不能把用户的关闭决定覆盖掉
  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', {
      detail: Object.assign({ mine: 'sess-A' }, detailWith([projected({ id: 'c2' })])),
    })
  );
  assert.equal(subPill(env).style.display, 'none', '粘滞不覆盖用户开关');
});

test('状态条 pill 顺序：子代理排在用量与上下文之间', () => {
  const env = loadStatusbar();
  const bar = env.host.children.find((n) => n.className === 'zsb-bar');
  const order = bar.children
    .filter((n) => n.dataset && n.dataset.zsbPill)
    .map((n) => n.dataset.zsbPill);
  assert.deepEqual(order, ['activity', 'usage', 'subagent', 'context', 'gear']);
});

test('运行中条目带上子会话时，面板只出一行且显示任务名（不只剩尾号）', () => {
  const env = loadStatusbar();
  env.window.dispatchEvent(
    new env.window.CustomEvent('zcode-statusbar:session', {
      detail: detailWith([
        // 运行中的 Agent 投影行已带子会话 id（内核侧修好后就是这个形状）
        projected({ id: 'call_live', childSessionId: 'sess_subagent_agent_e0c5b6xx', status: 'running', startedAt: 5000 }),
        Object.assign(projected({}), {
          id: 'm1',
          kind: 'model',
          sid: 'sess_subagent_agent_e0c5b6xx',
          childSessionId: 'sess_subagent_agent_e0c5b6xx',
          status: 'completed',
          startedAt: 5000,
          firstTokenAt: 5100,
          completedAt: 7000,
          inputTokens: 100,
          outputTokens: 300,
        }),
      ]),
    })
  );
  const pill = subPill(env);
  pill.dispatchEvent({ type: 'click', target: pill });
  const rows = findByClass(popOf(env), 'zsb-subrow');
  assert.equal(rows.length, 1, '同一次派发不该出现两条');
  const text = fullText(rows[0]);
  assert.ok(text.includes('调研布局'), '任务名照常显示');
  assert.ok(!text.includes('#e0c5b6'), '不该退化成尾号占位');
});
