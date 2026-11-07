/*!
 * turn-stats.js —— 生成中速度采样（renderer 注入 IIFE，无模块系统）
 *
 * 契约（详见 statusbar/CONTRACT.md）：
 * - 产出 window.__ZCODE_STATUSBAR_TURN__ = { tokPerSec, estimated: true, updatedAt }（updatedAt 为 ms 时间戳）。
 * - 每次采样同时派发 window 事件 "zcode-statusbar:turn"（detail 同上对象）。
 * - 自校准钩子：window.__ZCODE_STATUSBAR_TURN_API__ = { setCharsPerToken, calibrateFromTurn, reset, stop }。
 * - 采样：约 2s 滑动窗、100ms tick；速度 = 字符增量 ÷ 每 token 字符数（默认 2）÷ 窗口秒数。
 * - 无增量 → 速度归零（不冻结旧值）；文本长度回落视为新一轮开始，重置窗口。
 * - 字符来源优先级：
 *   1. window.__ZCODE_STATUSBAR_STREAM_LENGTH__()（内核桥直喂 store 文本长度，若提供则优先）；
 *   2. DOM 选择器（STREAM_SELECTORS，取最后一个命中节点的 textContent.length，选择器失效 → 静默停采）。
 * - estimated 恒为 true：本模块只产估算值，核实值（会话均）由 session-stats.cjs 口径提供。
 *
 * 与 design.md §9 契约的偏差（供检查代理核对）：
 * - 为 node:test 覆盖采样逻辑，本文件在"无 window 且存在 module.exports"的环境（node）
 *   额外导出 { createTurnSampler, CONSTANTS }；浏览器注入路径不受影响（仍为 IIFE 自动装配）。
 * - design §2 的"renderer store 字符增量"在本实现中退化为"DOM 文本长度差"通用思路
 *   （任务说明允许），并提供 __ZCODE_STATUSBAR_STREAM_LENGTH__ 直喂钩子供内核日后接回 store。
 */
(function (global) {
  'use strict';

  // ---------------- 配置常量 ----------------
  var CONSTANTS = {
    WINDOW_MS: 2000, // 采样窗：约 2s
    TICK_MS: 100, // 采样 tick：100ms
    DEFAULT_CHARS_PER_TOKEN: 2, // 每 token 字符数初值（自校准钩子可改写）
    CHARS_PER_TOKEN_MIN: 0.5, // 自校准钳制下限（防除零/离谱值）
    CHARS_PER_TOKEN_MAX: 10, // 自校准钳制上限
    IDLE_HOLD_MS: 5000, // 最近一次读到文本后多久进入"仅脏标记驱动"的低频模式
  };

  // DOM 选择器候选（宿主会话流式输出容器）。ZCode 宿主 DOM 未公开稳定锚点，
  // 以下为启发式候选，需实机校准；全部失效即静默停采（不发事件、不报错）。
  // 允许运行时覆盖：window.__ZCODE_STATUSBAR_STREAM_SELECTORS__ = [ ... ]（见 CONTRACT.md）。
  var STREAM_SELECTORS = [
    '[data-zcode-stream]', // 未来官方/内核预留标记（乐观候选）
    '[class*="message-stream" i]',
    '[class*="message-list" i] > *:last-child',
    '[class*="chat-message" i]:last-of-type',
    '[class*="markdown-body" i]:last-of-type',
  ];

  function clampCharsPerToken(v) {
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return CONSTANTS.DEFAULT_CHARS_PER_TOKEN;
    if (n < CONSTANTS.CHARS_PER_TOKEN_MIN) return CONSTANTS.CHARS_PER_TOKEN_MIN;
    if (n > CONSTANTS.CHARS_PER_TOKEN_MAX) return CONSTANTS.CHARS_PER_TOKEN_MAX;
    return n;
  }

  /**
   * 采样器工厂（纯逻辑，DOM 无关；依赖经 opts 注入，便于单测）。
   * @param {Object} [opts]
   * @param {Function} [opts.readLength] 读取当前流式文本长度；返回 null 表示本轮不可读（静默跳过）
   * @param {Function} [opts.now]         时钟（ms）
   * @param {Function} [opts.publish]     样本发布回调（默认由浏览器装配写入全局并派发事件）
   * @param {number}   [opts.charsPerToken] 每 token 字符数（默认 2）
   */
  function createTurnSampler(opts) {
    opts = opts || {};
    var readLength = typeof opts.readLength === 'function' ? opts.readLength : function () { return null; };
    var now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
    var publish = typeof opts.publish === 'function' ? opts.publish : function () {};
    var charsPerToken = clampCharsPerToken(opts.charsPerToken != null ? opts.charsPerToken : CONSTANTS.DEFAULT_CHARS_PER_TOKEN);

    var samples = []; // 升序 [{ t, len }]，samples[0] 为增量基线
    var lastSample = null;

    /** 重置窗口：以当前可读长度为新基线（新一轮/口径切换时调用） */
    function reset() {
      var len = readLength();
      samples = len == null ? [] : [{ t: now(), len: len }];
      lastSample = null;
    }

    /**
     * 采样一个 tick：读长度 → 维护窗口 → 计算速度 → 发布。
     * 返回本次发布的样本（未发布时返回 null）。
     */
    function tick() {
      var len = readLength();
      if (len == null) return null; // 不可读 → 静默（不发布、不误归零其他来源）
      var t = now();
      var last = samples.length ? samples[samples.length - 1] : null;

      if (last && len < last.len) {
        // 文本回落：新一轮/消息切换，重置窗口（速度自然归零）
        reset();
        // reset 已读一次，此处直接以新基线继续
      } else {
        samples.push({ t: t, len: len });
        // 淘汰窗外样本：基线必须落在窗口内；窗口内无更早样本时 delta=0 → 速度归零
        while (samples.length > 1 && samples[0].t < t - CONSTANTS.WINDOW_MS) samples.shift();
      }

      var oldest = samples[0];
      var delta = len - oldest.len;
      var dt = (t - oldest.t) / 1000;

      var tokPerSec;
      if (delta <= 0) {
        tokPerSec = 0; // 无增量 → 归零而非冻结旧值
      } else if (dt <= 0) {
        return null; // 同刻突增（消息切换）：留待下一 tick 再算，避免除零/尖峰
      } else {
        tokPerSec = delta / charsPerToken / dt;
      }

      lastSample = { tokPerSec: tokPerSec, estimated: true, updatedAt: t };
      publish(lastSample);
      return lastSample;
    }

    /** 设置每 token 字符数（自校准钩子；钳制到合理区间） */
    function setCharsPerToken(v) {
      charsPerToken = clampCharsPerToken(v);
      reset(); // 避免窗内混用两种换算系数
      return charsPerToken;
    }

    /**
     * 按上一完成轮自校准：charCount / outputTokens。
     * 例：{ outputTokens: 100, charCount: 400 } → 每 token 4 字符。
     */
    function calibrateFromTurn(info) {
      info = info || {};
      var out = Number(info.outputTokens);
      var chars = Number(info.charCount);
      if (!isFinite(out) || out <= 0 || !isFinite(chars) || chars <= 0) return charsPerToken;
      return setCharsPerToken(chars / out);
    }

    return {
      tick: tick,
      reset: reset,
      setCharsPerToken: setCharsPerToken,
      calibrateFromTurn: calibrateFromTurn,
      getCharsPerToken: function () { return charsPerToken; },
      lastSample: function () { return lastSample; },
    };
  }

  // ---------------- 浏览器装配（renderer 注入路径） ----------------
  function installBrowser() {
    var D = global.document;
    if (!D) return false;
    if (!D.body) {
      // DOM 未就绪：等一次 DOMContentLoaded 再装配
      D.addEventListener('DOMContentLoaded', installBrowser, { once: true });
      return true;
    }

    var dirty = true; // MutationObserver 脏标记：有 DOM 变化才需要读长度
    var lastReadAt = 0; // 最近一次成功读到长度的时间

    function readLength() {
      // 优先内核直喂钩子（store 长度，绕过 DOM）
      var hook = global.__ZCODE_STATUSBAR_STREAM_LENGTH__;
      if (typeof hook === 'function') {
        var v = hook();
        if (typeof v === 'number' && isFinite(v)) {
          lastReadAt = Date.now();
          return Math.max(0, v);
        }
        return null;
      }
      // 闲置降频：无 DOM 变化且久未读到文本时跳过读取（省 textContent 开销）
      if (!dirty && Date.now() - lastReadAt > CONSTANTS.IDLE_HOLD_MS) return null;
      var selectors = global.__ZCODE_STATUSBAR_STREAM_SELECTORS__;
      if (!Array.isArray(selectors) || !selectors.length) selectors = STREAM_SELECTORS;
      for (var i = 0; i < selectors.length; i++) {
        try {
          var nodes = D.querySelectorAll(selectors[i]);
          if (nodes.length) {
            dirty = false;
            lastReadAt = Date.now();
            return nodes[nodes.length - 1].textContent.length;
          }
        } catch (e) {
          /* 选择器非法：跳过该候选，静默 */
        }
      }
      dirty = false;
      return null;
    }

    function publish(sample) {
      try {
        global.__ZCODE_STATUSBAR_TURN__ = sample;
        if (typeof global.dispatchEvent === 'function' && typeof global.CustomEvent === 'function') {
          global.dispatchEvent(new global.CustomEvent('zcode-statusbar:turn', { detail: sample }));
        }
      } catch (e) {
        /* 发布失败静默：状态条会因 updatedAt 过期自行切回核实态 */
      }
    }

    var sampler = createTurnSampler({ readLength: readLength, publish: publish });
    var timer = setInterval(function () {
      try {
        sampler.tick();
      } catch (e) {
        /* 单次采样异常不终止整个采样循环 */
      }
    }, CONSTANTS.TICK_MS);

    // 流式输出主要是 characterData/childList 变化；body 级观察只置脏标记，开销极小
    var mo = null;
    try {
      mo = new global.MutationObserver(function () { dirty = true; });
      mo.observe(D.body, { childList: true, characterData: true, subtree: true });
    } catch (e) {
      mo = null; // 无观察器时退化为持续 100ms 读取
    }

    // 自校准钩子（供内核/诊断在轮结束后回填真实 outputTokens）
    global.__ZCODE_STATUSBAR_TURN_API__ = {
      setCharsPerToken: sampler.setCharsPerToken,
      calibrateFromTurn: sampler.calibrateFromTurn,
      reset: sampler.reset,
      stop: function () {
        clearInterval(timer);
        if (mo) mo.disconnect();
        try {
          delete global.__ZCODE_STATUSBAR_TURN_API__;
        } catch (e) {
          global.__ZCODE_STATUSBAR_TURN_API__ = undefined;
        }
      },
    };
    return true;
  }

  // 启动：仅在浏览器（renderer）环境自动装配；node 测试环境不装配定时器
  if (typeof global.document !== 'undefined') {
    installBrowser();
  }

  // node:test 环境导出（偏差已记录于文件头）
  if (typeof module !== 'undefined' && module.exports && typeof global.window === 'undefined') {
    module.exports = { createTurnSampler: createTurnSampler, CONSTANTS: CONSTANTS };
  }
})(typeof window !== 'undefined' ? window : globalThis);
