/* zcode-statusbar 渲染端静态桥 shim（内核注入面，IIFE，无模块系统依赖）。
 * 由 inject-main.cjs 在每个主窗口 dom-ready 时经 executeJavaScript 注入（先于
 * ramp.js / turn-stats.js / statusbar.js），按 design §9 契约暴露：
 *   window.__ZCODE_STATUSBAR_BRIDGE__ = { getPaneId(), getSessionSnapshot() }
 * 身份不可确认时两者返回 null，状态条据此拒绝渲染（R10 防串数）。
 *
 * 身份来源（按优先级）：
 *   1) asar 内嵌桥（core/renderer_bridge.py 部署的 data-zcstatusbar-* 属性与
 *      __zcodeStatusbarGetExistingConversationStore 访问器）——首选，进程内只读；
 *   2) React fiber 兜底（只读遍历、深度封顶、绝不写宿主对象）；
 *   3) 全部失败 → null（绝不猜测，宁可降级为不渲染 + SQLite 轮询链兜底）。
 * 相对原插件差异：全局名/属性名全部换为 zcstatusbar 前缀（与原插件共存互不冲突）；
 * 对外契约是 design §9 的两函数桥，不再暴露原插件的逐问速率桥接面。
 * 与 design §1 的偏差：本文件（连同 renderer_bridge.py）属内核注入部分，放在 core/
 * 而非 statusbar/，依据是 design §9「renderer 静态桥（内核注入，主进程侧执行）」。
 *
 * 本 shim 另承担两件内核注入面的职责（检查代理核对：CONTRACT.md §2 已登记）：
 *   1) __ZCODE_STATUSBAR_DIAG__：注入诊断快照（install_monitor.py 靠 diag-<n>.json
 *      的回写时间确认注入链路已加载）；
 *   2) 齿轮事件转发器（CONTRACT.md §3 / §7.6）：主进程不能直接监听 window 事件，
 *      由本 shim 把状态条派发的 refresh/reset-session/check-update/uninstall 四个
 *      window 事件转写进 __ZCODE_STATUSBAR_REQUESTS__ 轮询队列（已有通道），主进程
 *      pollPluginRequests 白名单消费。监听器随首次注入注册一次，重复注入幂等跳过。 */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window) return;
  if (window.__ZCODE_STATUSBAR_BRIDGE__) return;   // 幂等：重复注入不重建（监听器随首次注入注册一次）

  var FIBER_MAX_DEPTH = 300;      // fiber 向上/属性遍历深度封顶，防异常树形拖死页面

  /* ---------- 注入诊断快照：install_monitor.py 靠 diag-<n>.json 回写确认注入链路 ---------- */
  try {
    window.__ZCODE_STATUSBAR_DIAG__ = {
      version: "0.1.0",
      injectedAt: Date.now(),
      bridge: true,
      ua: (typeof navigator !== "undefined" && navigator && navigator.userAgent) || "",
    };
  } catch (e) { /* 只读页面兜底：诊断缺席不影响桥 */ }

  /* ---------- 齿轮事件转发器（CONTRACT.md §7.6）：window 事件 → REQUESTS 轮询队列 ----------
   * 主进程轮询 __ZCODE_STATUSBAR_REQUESTS__（数组，splice 消费），白名单动作见
   * inject-main.cjs pollPluginRequests；id 供回执（__ZCODE_STATUSBAR_RESULT__）对账。
   * 宿主环境无 addEventListener（测试沙箱/老页面）时跳过：齿轮动作静默失效，不影响桥。 */
  if (typeof window.addEventListener === "function") {
    try {
      if (!Array.isArray(window.__ZCODE_STATUSBAR_REQUESTS__)) window.__ZCODE_STATUSBAR_REQUESTS__ = [];
      var gearSeq = 0;
      var GEAR_EVENTS = {
        "zcode-statusbar:refresh": "refresh",
        "zcode-statusbar:reset-session": "reset-session",
        "zcode-statusbar:check-update": "check-update",
        "zcode-statusbar:uninstall": "uninstall",
      };
      Object.keys(GEAR_EVENTS).forEach(function (evName) {
        var action = GEAR_EVENTS[evName];
        window.addEventListener(evName, function (ev) {
          try {
            var d = (ev && ev.detail) || {};
            gearSeq += 1;
            window.__ZCODE_STATUSBAR_REQUESTS__.push({
              id: "gear-" + Date.now().toString(36) + "-" + gearSeq,
              action: action,
              paneId: typeof d.paneId === "string" ? d.paneId : "",
              from: typeof d.from === "string" ? d.from : "gear-menu",
            });
          } catch (e) { /* 转发失败静默：内核兜底轮询自会拉新数据 */ }
        });
      });
    } catch (e) { /* 注册失败静默 */ }
  }

  function reactFiber(node) {
    // React 17+ 把 fiber 挂在 DOM 节点的 __reactFiber$<rand> 键上；逐键探测，不猜具体后缀
    try {
      var keys = Object.keys(node);
      for (var i = 0; i < keys.length; i++) {
        if (/^__reactFiber\$/.test(keys[i])) return node[keys[i]];
        if (keys[i] === "__reactInternalInstance$") return node[keys[i]];   // React <=16 兼容
      }
    } catch (e) { }
    return null;
  }

  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  /* 只读 fiber 上溯：收集第一个同时带 paneId 与 sessionId（或 workspacePath）的 props。 */
  function fiberPaneScope(node) {
    try {
      var fiber = reactFiber(node);
      var depth = 0;
      while (fiber && depth++ < FIBER_MAX_DEPTH) {
        var props = fiber.memoizedProps;
        if (isPlainObject(props) && typeof props.paneId === "string" &&
            (typeof props.sessionId === "string" || isPlainObject(props.scope))) {
          var scope = isPlainObject(props.scope) ? props.scope : props;
          return {
            paneId: typeof props.paneId === "string" ? props.paneId : null,
            sessionId: typeof scope.sessionId === "string" ? scope.sessionId
              : typeof props.sessionId === "string" ? props.sessionId : null,
            workspacePath: typeof scope.workspacePath === "string" ? scope.workspacePath : null,
            workspaceIdentity: typeof scope.workspaceIdentity === "string" ? scope.workspaceIdentity : null,
            remoteSessionId: typeof scope.remoteSessionId === "string" ? scope.remoteSessionId : null,
          };
        }
        fiber = fiber.return;
      }
    } catch (e) { }
    return null;
  }

  /* 定位当前窗口的 SessionPane 元素：内嵌桥属性优先，宿主 data-session-id 兜底。 */
  function paneElement() {
    try {
      var el = document.querySelector("[data-zcstatusbar-pane-id]");
      if (el) return el;
      el = document.querySelector("[data-session-id]");
      return el || null;
    } catch (e) { return null; }
  }

  function paneDataset(el) {
    try {
      var d = el && el.dataset ? el.dataset : null;
      if (!d) return null;
      return {
        paneId: d.zcstatusbarPaneId || null,
        sessionId: d.sessionId || null,
        workspacePath: d.zcstatusbarWorkspacePath || "",
        workspaceIdentity: d.zcstatusbarWorkspaceIdentity || "",
        remoteSessionId: d.zcstatusbarRemoteSessionId || "",
      };
    } catch (e) { return null; }
  }

  /* 组装内嵌桥的 conversation scope；scope 必须同时具备 sessionId 与
   * workspacePath（getExistingConversationStore 的形状门），缺一按不可确认处理。 */
  function buildScope(info) {
    if (!info) return null;
    var scope = {
      sessionId: info.sessionId || "",
      workspacePath: info.workspacePath || "",
      workspaceIdentity: info.workspaceIdentity || "",
      remoteSessionId: info.remoteSessionId || "",
    };
    if (!scope.sessionId || !scope.workspacePath) return null;
    return scope;
  }

  function embeddedStore(scope) {
    try {
      var accessor = window.__zcodeStatusbarGetExistingConversationStore;
      if (typeof accessor !== "function") return null;
      var store = accessor(scope);
      if (!store || typeof store.getState !== "function") return null;
      return store;
    } catch (e) { return null; }
  }

  var bridge = {
    /** 当前窗口焦点 pane 的 id；不可确认返回 null（不猜测）。 */
    getPaneId: function () {
      try {
        var el = paneElement();
        if (!el) return null;
        var info = paneDataset(el);
        if (info && info.paneId) return info.paneId;
        var fiberInfo = fiberPaneScope(el);
        return fiberInfo && fiberInfo.paneId ? fiberInfo.paneId : null;
      } catch (e) { return null; }
    },
    /** 当前窗口焦点会话的只读 store 快照（frozen）；不可确认返回 null。 */
    getSessionSnapshot: function () {
      try {
        var el = paneElement();
        if (!el) return null;
        var info = paneDataset(el);
        var fiberInfo = null;
        var scope = buildScope(info);
        if (!scope) {
          fiberInfo = fiberPaneScope(el);
          scope = fiberInfo && buildScope(fiberInfo);
        }
        if (!scope) return null;
        var store = embeddedStore(scope);
        return store ? store.getState() : null;
      } catch (e) { return null; }
    },
  };

  Object.freeze(bridge);
  window.__ZCODE_STATUSBAR_BRIDGE__ = bridge;
})();
