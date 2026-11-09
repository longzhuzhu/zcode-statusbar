'use strict';

/**
 * statusbar.js 齿轮菜单冒烟（node:test + vm DOM stub，桩与 statusbar-usage.test.cjs 一致）：
 * 点击 gear pill → 断言菜单结构为「显示勾选区 / 分隔线 / 动作区 / 卸载 / 分隔线 / 版本号页脚」，
 * 版本号是菜单最后一个子节点且位于卸载项之后，防止后续改动把它塞回动作项之间。
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

function mountMenu(env) {
  const bar = env.host.children.find((n) => n.className === 'zsb-bar');
  assert.ok(bar, '状态条已挂载');
  const gearPill = bar.children.find((n) => n.dataset && n.dataset.zsbPill === 'gear');
  assert.ok(gearPill, 'gear pill 存在');
  gearPill.dispatchEvent({ type: 'click', target: gearPill });
  const pop = bar.children.find((n) => n.className === 'zsb-pop');
  assert.ok(pop, '弹层容器存在');
  const menu = pop.children.find((n) => n.className === 'zsb-menu');
  assert.ok(menu, '菜单容器存在');
  return { pop, menu };
}

test('齿轮菜单：版本号位于最底部页脚，卸载项之后并带分隔线', () => {
  const env = loadStatusbar();
  const { pop, menu } = mountMenu(env);
  assert.equal(pop.hidden, false, '点击 gear 后弹层打开');

  const last = menu.children[menu.children.length - 1];
  assert.equal(last.className, 'zsb-menu-ver', '菜单最后一项是版本号');
  assert.match(last.textContent, /^v\d+\.\d+\.\d+$/, '版本号格式为 vX.Y.Z');

  const uninstallIdx = menu.children.findIndex(
    (n) => n.className === 'zsb-mi danger' && n.dataset.act === 'uninstall'
  );
  assert.ok(uninstallIdx >= 0, '卸载项存在');
  assert.equal(uninstallIdx, menu.children.length - 3, '卸载项之后紧跟分隔线与版本号');
  assert.equal(menu.children[menu.children.length - 2].className, 'zsb-hr', '版本号前有分隔线');

  const verIdx = menu.children.length - 1;
  const dupes = menu.children.filter((n) => n.className === 'zsb-menu-ver');
  assert.equal(dupes.length, 1, '版本号只出现一次');
  assert.ok(verIdx > uninstallIdx, '版本号在卸载项下方');
});

test('齿轮菜单：动作区不被版本号隔断，分隔线恰好两条', () => {
  const env = loadStatusbar();
  const { menu } = mountMenu(env);

  const hrs = menu.children.filter((n) => n.className === 'zsb-hr');
  assert.equal(hrs.length, 2, '显示区与动作区之间、卸载与版本号之间各一条');

  const acts = menu.children.filter((n) => n.dataset && n.dataset.act).map((n) => n.dataset.act);
  assert.deepEqual(
    acts,
    ['toggle', 'toggle', 'toggle', 'toggle', 'toggle', 'refresh', 'diag', 'reset', 'update', 'uninstall'],
    '动作项顺序不变，版本号不占动作位'
  );
});
