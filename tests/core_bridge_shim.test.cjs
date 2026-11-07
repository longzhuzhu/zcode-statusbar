"use strict";
// 渲染端静态桥 shim（design §9 契约）回归：window.__ZCODE_STATUSBAR_BRIDGE__ =
// { getPaneId(), getSessionSnapshot() }，身份不可确认时两者返回 null。
// vm 沙箱内模拟 DOM/内嵌桥访问器，全部在临时对象上进行，不触碰真实浏览器。
// 运行：node --test tests/（仓库根）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const CORE = path.join(__dirname, "..", "core");
const SHIM = fs.readFileSync(path.join(CORE, "statusbar-bridge.js"), "utf8");

function makeWindow(dom = {}) {
  // 极简 DOM 塑形：querySelector + dataset。dom.pane = 带 data-* 属性的元素描述。
  const elements = {};
  if (dom.bridgePane) {
    elements["[data-zcstatusbar-pane-id]"] = { dataset: dom.bridgePane };
  }
  if (dom.sessionPane) {
    elements["[data-session-id]"] = { dataset: dom.sessionPane };
  }
  const document = {
    querySelector(selector) {
      return Object.prototype.hasOwnProperty.call(elements, selector) ? elements[selector] : null;
    },
  };
  const window = { document, __ZCODE_STATUSBAR_WANTS__: [] };
  if (dom.accessor) window.__zcodeStatusbarGetExistingConversationStore = dom.accessor;
  return window;
}

function loadShim(window) {
  const context = { window, document: window.document };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(SHIM, context, { filename: "statusbar-bridge.test.js" });
  return window.__ZCODE_STATUSBAR_BRIDGE__ || null;
}

test("shim 安装幂等：重复注入不重建、对象冻结", () => {
  const window = makeWindow();
  const first = loadShim(window);
  assert.ok(first, "桥已安装");
  assert.ok(Object.isFrozen(first));
  const again = loadShim(window);
  assert.equal(again, first, "幂等：第二次注入保留同一实例");
});

test("身份不可确认：无 pane 元素时 getPaneId/getSessionSnapshot 返回 null", () => {
  const bridge = loadShim(makeWindow());
  assert.equal(bridge.getPaneId(), null);
  assert.equal(bridge.getSessionSnapshot(), null);
});

test("身份不可确认：scope 缺 workspacePath（仅 sessionId）返回 null，绝不猜测", () => {
  const bridge = loadShim(makeWindow({
    bridgePane: { zcstatusbarPaneId: "pane-1", sessionId: "sess_a",
      zcstatusbarWorkspacePath: "", zcstatusbarWorkspaceIdentity: "", zcstatusbarRemoteSessionId: "" },
  }));
  assert.equal(bridge.getPaneId(), "pane-1", "paneId 属性可得时不依赖 scope 完整性");
  assert.equal(bridge.getSessionSnapshot(), null);
});

test("内嵌桥路径：data-zcstatusbar-* + 访问器 → 返回 paneId 与冻结快照", () => {
  const snapshot = Object.freeze({ status: "connected", seq: 7 });
  const accessorCalls = [];
  const bridge = loadShim(makeWindow({
    bridgePane: { zcstatusbarPaneId: "pane-main", sessionId: "sess_a",
      zcstatusbarWorkspacePath: "/repo", zcstatusbarWorkspaceIdentity: "u1",
      zcstatusbarRemoteSessionId: "" },
    accessor(scope) {
      accessorCalls.push(scope);
      return { getState: () => snapshot };
    },
  }));
  assert.equal(bridge.getPaneId(), "pane-main");
  const got = bridge.getSessionSnapshot();
  assert.equal(got, snapshot, "快照原样返回（冻结语义由内嵌桥承担）");
  // scope 对象诞生于 vm context（原型跨 realm），展开为主 realm 普通对象再比较。
  assert.deepEqual(accessorCalls.map((scope) => ({ ...scope })), [{
    sessionId: "sess_a", workspacePath: "/repo",
    workspaceIdentity: "u1", remoteSessionId: "",
  }]);
});

test("内嵌桥缺席：快照返回 null（fail-closed，不做 fiber 深挖之外的猜测）", () => {
  const bridge = loadShim(makeWindow({
    bridgePane: { zcstatusbarPaneId: "pane-1", sessionId: "sess_a",
      zcstatusbarWorkspacePath: "/repo", zcstatusbarWorkspaceIdentity: "",
      zcstatusbarRemoteSessionId: "" },
  }));
  assert.equal(bridge.getPaneId(), "pane-1");
  assert.equal(bridge.getSessionSnapshot(), null);
});

test("访问器异常/坏返回值：getSessionSnapshot 吞错返回 null", () => {
  for (const accessor of [
    () => { throw new TypeError("stale"); },
    () => null,
    () => ({ /* 缺 getState */ }),
  ]) {
    const bridge = loadShim(makeWindow({
      bridgePane: { zcstatusbarPaneId: "p", sessionId: "s",
        zcstatusbarWorkspacePath: "/repo", zcstatusbarWorkspaceIdentity: "",
        zcstatusbarRemoteSessionId: "" },
      accessor,
    }));
    assert.equal(bridge.getSessionSnapshot(), null);
  }
});

test("fiber 兜底路径：无 data-zcstatusbar-* 时从宿主 data-session-id 元素上溯 fiber props", () => {
  // 构造带 __reactFiber$ 键的 DOM 节点与 memoizedProps 链
  const props = { paneId: "pane-fiber", sessionId: "sess_f",
    workspacePath: "/repo", workspaceIdentity: "", remoteSessionId: "" };
  const fiber = { memoizedProps: props, return: null };
  const el = {
    dataset: { sessionId: "sess_f" },
  };
  el["__reactFiber$abc"] = fiber;
  const document = {
    querySelector(selector) {
      return selector === "[data-session-id]" ? el : null;
    },
  };
  const window = { document };
  const context = { window, document };
  vm.createContext(context);
  vm.runInContext(SHIM, context, { filename: "statusbar-bridge.test.js" });
  const bridge = window.__ZCODE_STATUSBAR_BRIDGE__;
  assert.equal(bridge.getPaneId(), "pane-fiber");
  assert.equal(bridge.getSessionSnapshot(), null, "无内嵌访问器时快照 fail-closed");
});

test("外部页面/异常 DOM：querySelector 抛错时全部返回 null", () => {
  const document = { querySelector() { throw new Error("destroyed"); } };
  const window = { document };
  const context = { window, document };
  vm.createContext(context);
  vm.runInContext(SHIM, context, { filename: "statusbar-bridge.test.js" });
  const bridge = window.__ZCODE_STATUSBAR_BRIDGE__;
  assert.equal(bridge.getPaneId(), null);
  assert.equal(bridge.getSessionSnapshot(), null);
});
