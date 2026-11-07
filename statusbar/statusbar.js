/*!
 * statusbar.js —— ZCode 状态条 UI（renderer 注入，IIFE，无框架）
 *
 * 职责（prd R1/R3/R4/R5/R6/R7/R12）：输入框下方水平居中状态条，五控件（Activity / Usage / 上下文 /
 * 子代理 / 齿轮）、详情弹层、齿轮短菜单、估算态呼吸标识；仅真实会话内渲染，身份不可确认则不渲染。
 * 全部 DOM 自绘、无第三方依赖、无构建步骤；样式经 CSS 变量对齐官方 mono 栈与字号。
 *
 * 依赖的全局（均可缺失并降级，契约见 statusbar/CONTRACT.md）：
 * - window.__ZCODE_STATUSBAR_BRIDGE__   内核静态桥 { getPaneId(), getSessionSnapshot() }；缺失/返回 null → 不渲染（防串数）。
 * - window.__ZCODE_STATUSBAR_RAMP__     色阶 { speedColor, contextColor }（加载器组装自 ramp.js）；缺失 → 数字与圆环退中性灰。
 * - window.__ZCODE_STATUSBAR_TURN__     turn-stats.js 产出（经事件 "zcode-statusbar:turn" 同步）。
 * - window.__ZCODE_STATUSBAR_VERSION__  可选：加载器注入的版本号。
 * - window.__ZCODE_STATUSBAR_I18N__     可选：宿主语言文案覆盖（键见下方 I18N）。
 *
 * 与 design.md §9 契约的偏差（供检查代理核对）：
 * 1. 会话数据来源：design 写"主进程推送事件 zcode-statusbar:session"——本实现按此接收；
 *    内核推送的 detail 为 { ...zusage 快照, aggregate: aggregate() 输出 }（聚合缝包裹，
 *    见 inject-main.cjs handlePayload），本 UI 经 normalizeSession() 取 aggregate 消费
 *    （形状见 CONTRACT.md §4.2）；直接推送 aggregate 形状的路径也兼容。
 * 2. 齿轮"重置会话统计"除派发 "zcode-statusbar:reset-session" 外，本地同步清空显示（用户即时反馈）。
 * 3. 上下文占用由本状态条自带的圆环 pill 承载（R4），官方上下文按钮的 DOM/样式/交互一概不改写；
 *    数据读宿主隐藏锚点 [data-usage-used] / [data-usage-max]（官方同源口径）。
 */

(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return; // 非 renderer 环境静默退出

  var W = window;
  var D = document;

  // ================= 配置常量区 =================

  var VERSION = String(W.__ZCODE_STATUSBAR_VERSION__ || '0.1.0');

  // 估算态时效：turn 样本 updatedAt 超过此时长即认为本轮生成结束，切回核实态（会话均）
  var TURN_FRESH_MS = 3000;
  // 挂载/会话探测周期：SPA 内切换任务不重注入脚本，需常驻低频轮询——
  // 进入会话时挂载、回到 draft 或无会话时卸载。
  var MOUNT_POLL_MS = 1000;

  // 输入框挂载锚点候选，自上而下取第一个命中者。
  // ZCode 宿主 DOM 未公开稳定锚点，候选为启发式，需实机校准。
  var MOUNT_ANCHORS = [
    '[data-zcode-composer]', // 未来官方/内核预留标记（乐观候选）
    'form[class*="composer" i]',
    '[class*="composer" i]',
    '[class*="prompt-editor" i]',
    '[class*="chat-input" i]',
    '[contenteditable="true"]', // 输入编辑器本身（挂到其父容器之后）
  ];

  // 会话身份锚点（宿主 SessionPane 根节点）：data-session-id 为 "draft" 表示首页/新建任务，
  // 此时没有任何会话数据，不渲染状态条。R10：宁可少显示，不渲染错口径的空壳。
  var SESSION_SELECTOR = '[data-session-id]';
  var DRAFT_SESSION_ID = 'draft';

  // 上下文占用数据源：宿主 V4ComposerToolbar 的隐藏 e2e 锚点（className:hidden 的 span，
  // data-testid="v4-model-config"），与官方面板同源同口径（分母是完整 context window）。
  // 按数据属性本身定位而非 testid：testid 改名时属性仍在。官方升级若整块移除 → 读不到 → pill 不渲染。
  var USAGE_SELECTOR = '[data-usage-used]';

  // 事件名（与 CONTRACT.md 严格同步）
  var EV = {
    TURN: 'zcode-statusbar:turn',
    SESSION: 'zcode-statusbar:session',
    REFRESH: 'zcode-statusbar:refresh',
    RESET: 'zcode-statusbar:reset-session',
    CHECK_UPDATE: 'zcode-statusbar:check-update',
    UNINSTALL: 'zcode-statusbar:uninstall',
  };

  // 显示开关持久化键（localStorage，pane 无关；卸载保留）
  var LS_PIILLS = 'zcode-statusbar.pills';

  // 文案（默认中文）。宿主语言覆盖点：内核注入本文件前设置
  // window.__ZCODE_STATUSBAR_I18N__ = { <key>: '译文', ... } 即可整键覆盖。
  var I18N = {
    estTip: '估算值：按字符增量推得，非精确 tok/s',
    verifiedTip: '会话均：Σ输出 token ÷ Σ生成时长',
    usageTip: '累计 token 与缓存命中率（缓存已含在输入）',
    contextTip: '上下文占用：与官方面板同源，分母为完整 context window',
    subRunningTip: '子代理运行中：活跃数 · 速度',
    subIdleTip: '子代理会话累计 token',
    gearTip: '状态条设置',
    noData: '暂无数据',
    activityTitle: '活动',
    usageTitle: '用量',
    contextTitle: '上下文',
    modelTime: '模型用时',
    toolTime: '工具用时',
    ttft: '首字延迟',
    trend: '最近速度趋势',
    tps: '输出速度（TPS）',
    inputTok: '输入',
    outputTok: '输出',
    cacheRead: '缓存读',
    cacheWrite: '缓存写',
    toolsTitle: '工具调用',
    toolsTotal: '合计',
    toolCallsUnit: '次',
    toolErrors: '错误',
    subagents: '子代理明细',
    ctxUsed: '已用',
    ctxTotal: '总量',
    ctxPercent: '占比',
    menuShow: '显示',
    pillActivity: '活动',
    pillUsage: '用量',
    pillContext: '上下文',
    pillSubagent: '子代理',
    pillGear: '齿轮',
    menuRefresh: '立即刷新',
    menuDiag: '复制诊断',
    menuReset: '重置会话统计',
    menuUpdate: '检查更新',
    menuUninstall: '卸载状态条',
    copied: '已复制',
  };
  if (W.__ZCODE_STATUSBAR_I18N__ && typeof W.__ZCODE_STATUSBAR_I18N__ === 'object') {
    for (var k in W.__ZCODE_STATUSBAR_I18N__) {
      if (Object.prototype.hasOwnProperty.call(W.__ZCODE_STATUSBAR_I18N__, k)) I18N[k] = W.__ZCODE_STATUSBAR_I18N__[k];
    }
  }

  // 官方 mono 字体栈默认值（research/zcode-official-context.md；宿主变量缺失时兜底）
  var DEFAULT_MONO =
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", ' +
    '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", monospace';

  // ================= 运行时状态 =================

  var state = {
    mounted: false,
    paneId: null,
    turn: null, // { tokPerSec, estimated, updatedAt }
    session: null, // session-stats.cjs aggregate() 输出
    sessionAt: 0, // 最近一次 session 数据到达时间（诊断用）
    context: null, // { used, size } 上下文占用（读宿主隐藏锚点，诊断用）
    lastError: null,
    visible: { activity: true, usage: true, context: true, subagent: true, gear: true },
  };

  // 显示开关持久化
  try {
    var saved = JSON.parse(W.localStorage.getItem(LS_PIILLS) || 'null');
    if (saved && typeof saved === 'object') {
      ['activity', 'usage', 'context', 'subagent', 'gear'].forEach(function (n) {
        if (typeof saved[n] === 'boolean') state.visible[n] = saved[n];
      });
    }
  } catch (e) {
    /* localStorage 不可用：用默认开关 */
  }
  function saveVisible() {
    try {
      W.localStorage.setItem(LS_PIILLS, JSON.stringify(state.visible));
    } catch (e) {
      /* 忽略持久化失败 */
    }
  }

  // ================= 小工具 =================

  function rampApi() {
    var r = W.__ZCODE_STATUSBAR_RAMP__;
    if (!r) r = W.ZCodeStatusbarRamp; // ramp.js 自身的无模块系统兜底全局（见 ramp.js 导出段）
    return r && typeof r.speedColor === 'function' && typeof r.contextColor === 'function' ? r : null;
  }

  function el(tag, cls, text) {
    var n = D.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtTok(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '--';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(Math.round(n));
  }

  function fmtPct(rate) {
    if (typeof rate !== 'number' || !isFinite(rate)) return '--';
    return Math.round(rate * 100) + '%';
  }

  function fmtMsNum(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '--';
    if (ms >= 1000) return (ms / 1000).toFixed(2) + 's';
    return Math.round(ms) + 'ms';
  }

  // 人类可读时长（对齐 deepseek 弹层口径）：12分4秒 / 5.5秒 / 1时23分 / 480ms
  function fmtDur(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '--';
    if (ms < 1000) return Math.round(ms) + 'ms';
    var s = ms / 1000;
    if (s < 60) return (Math.round(s * 10) / 10) + '秒';
    var m = Math.floor(s / 60);
    var rs = Math.round(s - m * 60);
    if (rs >= 60) { m += 1; rs = 0; }
    if (m < 60) return m + '分' + rs + '秒';
    var h = Math.floor(m / 60);
    return h + '时' + (m - h * 60) + '分';
  }

  // ================= 样式注入 =================

  var CSS = [
    // 基色 fallback：deepseek 静态三级灰（浅 rgb(129,133,140) / 深 rgb(173,178,184)），
    // 经 --zsb-subtle 由 applyThemeVars 按主题提供；宿主变量可用时优先宿主。
    '.zsb-bar{position:relative;display:flex;justify-content:center;align-items:center;gap:12px;',
    'min-height:22px;margin-top:4px;font-family:var(--zcode-font-mono,' + JSON.stringify(DEFAULT_MONO) + ');',
    'font-size:var(--zcode-font-text-sm-size,12px);font-weight:400;line-height:20px;',
    'color:var(--zcode-color-text-secondary,var(--zsb-subtle,#818a8c));',
    'font-variant-numeric:tabular-nums;user-select:none;-webkit-user-select:none;z-index:60;}',
    '.zsb-pill{display:inline-flex;align-items:center;gap:6px;padding:1px 8px;border-radius:8px;',
    'border:0;background:transparent;color:inherit;font:inherit;line-height:inherit;cursor:pointer;',
    'font-variant-numeric:tabular-nums;transition:background-color .15s ease,color .15s ease;}',
    // hover：淡灰背景 + 升为二级文字色（fallback 同样按主题经 --zsb-hover 提供）
    '.zsb-pill:hover{background:color-mix(in srgb,currentColor 10%,transparent);',
    'color:var(--zcode-color-text-secondary-hover,var(--zsb-hover,#565a60));}',
    '.zsb-ico{display:inline-flex;width:14px;height:14px;flex:none;}',
    '.zsb-ico svg{width:14px;height:14px;display:block;}',
    '.zsb-num{font-variant-numeric:tabular-nums;}',
    '.zsb-est{animation:zsb-breathe 2s ease-in-out infinite;}',
    '@keyframes zsb-breathe{0%,100%{opacity:1}50%{opacity:.55}}',
    '.zsb-ring-fill{transition:stroke-dasharray .3s ease,stroke .3s ease;}',
    '.zsb-ctxbar{height:4px;border-radius:999px;margin-top:10px;overflow:hidden;',
    'background:color-mix(in srgb,currentColor 16%,transparent);}',
    '.zsb-ctxbar-fill{display:block;height:100%;border-radius:999px;',
    'background:currentColor;transition:width .3s ease;}',
    '.zsb-pop{position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);',
    'min-width:220px;max-width:340px;padding:12px 14px;border-radius:12px;',
    'background:var(--zsb-pop-bg,var(--zsb-pop-bg-fallback,#fff));border:1px solid var(--zsb-pop-border,rgba(0,0,0,.12));',
    'box-shadow:0 8px 28px rgba(0,0,0,.18);color:var(--zcode-color-text-primary,var(--zsb-primary,#232629));',
    'font-variant-numeric:tabular-nums;text-align:left;z-index:70;}',
    '.zsb-pop[hidden]{display:none;}',
    '.zsb-pop-title{font-weight:500;margin-bottom:8px;}',
    '.zsb-row{display:flex;justify-content:space-between;gap:16px;line-height:22px;}',
    '.zsb-row .k{opacity:.85;white-space:nowrap;}',
    '.zsb-row .v{white-space:nowrap;}',
    // 工具名行截断：长工具名（如 MCP 全名）不撑破 max-width:340px 的弹层（.k 默认 nowrap 不截断）
    '.zsb-row .zsb-tool-k{min-width:0;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.zsb-sec{margin-top:10px;}',
    // 速度趋势折线图：SVG 按容器像素宽定点绘制，文字/网格线经类名统一弱化着色
    '.zsb-trend{height:64px;margin-top:4px;}',
    '.zsb-trend svg{display:block;width:100%;height:64px;}',
    '.zsb-trend .zsb-tgrid{stroke:currentColor;stroke-width:1;}',
    '.zsb-trend .zsb-tgrid.dash{stroke-dasharray:2 3;opacity:.18;}',
    '.zsb-trend .zsb-tgrid.base{opacity:.25;}',
    '.zsb-trend text{font-family:inherit;font-size:10px;}',
    '.zsb-trend .zsb-tick{fill:currentColor;opacity:.55;}',
    '.zsb-trend .zsb-tnow{font-weight:500;}',
    '.zsb-menu{display:flex;flex-direction:column;min-width:180px;}',
    '.zsb-menu-title{opacity:.7;margin-bottom:4px;}',
    '.zsb-mi{display:flex;justify-content:space-between;align-items:center;gap:12px;border:0;background:transparent;',
    'color:inherit;font:inherit;line-height:26px;padding:0 4px;border-radius:6px;cursor:pointer;text-align:left;white-space:nowrap;}',
    '.zsb-mi:hover{background:color-mix(in srgb,currentColor 10%,transparent);}',
    '.zsb-mi .tick{opacity:.9;}',
    '.zsb-mi.danger:hover{background:color-mix(in srgb,#e5484d 14%,transparent);}',
    '.zsb-menu-ver{opacity:.6;line-height:22px;padding:0 4px;}',
    '.zsb-hr{border:0;border-top:1px solid color-mix(in srgb,currentColor 14%,transparent);margin:6px 0;}',
  ].join('');

  // 主题（深浅）变量兜底：优先采样宿主变量，取不到按 prefers-color-scheme 落固定值
  function applyThemeVars(root) {
    var dark = false;
    try {
      dark = W.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (e) {
      dark = false;
    }
    var cs = null;
    try {
      cs = W.getComputedStyle(D.documentElement);
    } catch (e) {
      cs = null;
    }
    function hostVar(name) {
      if (!cs) return '';
      try {
        return String(cs.getPropertyValue(name) || '').trim();
      } catch (e) {
        return '';
      }
    }
    // 官方变量桥接（research/zcode-official-context.md）：--font-mono / --text-ui-sm / --color-foreground(-subtle)
    var mono = hostVar('--font-mono');
    var smSize = hostVar('--text-ui-sm');
    var subtle = hostVar('--color-foreground-subtle');
    var primary = hostVar('--color-foreground');
    var bg = hostVar('--color-background');
    if (mono) root.style.setProperty('--zcode-font-mono', mono);
    if (smSize) root.style.setProperty('--zcode-font-text-sm-size', smSize);
    if (subtle) root.style.setProperty('--zcode-color-text-secondary', subtle);
    if (primary) root.style.setProperty('--zcode-color-text-primary', primary);
    if (bg) root.style.setProperty('--zsb-pop-bg', bg);
    // 主题兜底（无宿主变量时生效）：三级灰基色 / hover 二级灰 / 弹层主文字与底色
    root.style.setProperty('--zsb-subtle', dark ? 'rgb(173,178,184)' : 'rgb(129,133,140)');
    root.style.setProperty('--zsb-hover', dark ? 'rgb(200,205,211)' : 'rgb(86,90,96)');
    root.style.setProperty('--zsb-primary', dark ? '#e6e8eb' : '#232629');
    root.style.setProperty('--zsb-pop-bg-fallback', dark ? '#1e1f22' : '#ffffff');
    root.style.setProperty('--zsb-pop-border', dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.12)');
  }

  // ================= 图标（内联 SVG，14×14，描边继承 currentColor） =================

  var ICONS = {
    activity:
      '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M2 8a5 5 0 0 1 10 0"/><path d="M7 8 9.4 5.2"/><circle cx="7" cy="8" r="0.9" fill="currentColor" stroke="none"/></svg>',
    usage:
      '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<ellipse cx="7" cy="3.2" rx="4.6" ry="1.7"/><path d="M2.4 3.2v7.6c0 .94 2.06 1.7 4.6 1.7s4.6-.76 4.6-1.7V3.2"/><path d="M2.4 7c0 .94 2.06 1.7 4.6 1.7S11.6 7.94 11.6 7"/></svg>',
    subagent:
      '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="7" cy="2.8" r="1.8"/><circle cx="2.8" cy="11" r="1.8"/><circle cx="11.2" cy="11" r="1.8"/>' +
      '<path d="M7 4.6v3M7 7.6 3.6 9.5M7 7.6l3.4 1.9"/></svg>',
    gear:
      '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M5.86 1.11L8.14 1.11L7.83 2.73L9.43 3.39L10.36 2.03L11.97 3.64L10.61 4.57L11.27 6.17L12.89 5.86L12.89 8.14L11.27 7.83L10.61 9.43L11.97 10.36L10.36 11.97L9.43 10.61L7.83 11.27L8.14 12.89L5.86 12.89L6.17 11.27L4.57 10.61L3.64 11.97L2.03 10.36L3.39 9.43L2.73 7.83L1.11 8.14L1.11 5.86L2.73 6.17L3.39 4.57L2.03 3.64L3.64 2.03L4.57 3.39L6.17 2.73Z"/>' +
      '<circle cx="7" cy="7" r="2.15"/></svg>',
  };

  // 上下文圆环（14×14，描边 2px，形态对齐 deepseek ContextMeter）。
  // 底环固定 0.25 透明度；进度环描边色由色阶驱动，dash 长度按占用比例写入。
  var RING_R = 5.5;
  var RING_C = 2 * Math.PI * RING_R;
  var CONTEXT_RING_SVG =
    '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" aria-hidden="true">' +
    '<circle class="zsb-ring-track" cx="7" cy="7" r="' + RING_R + '" stroke="currentColor" stroke-width="2" opacity="0.25"/>' +
    '<circle class="zsb-ring-fill" cx="7" cy="7" r="' + RING_R + '" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" transform="rotate(-90 7 7)"/></svg>';

  // ================= DOM 装配 =================

  var ui = null; // mountBar 返回的控件引用集：{ bar, pop, pills:{activity,usage,context,subagent,gear}, activityLabel, speedNum, usageNum, cacheNum, ctxPct, ctxFill, subLabel, subSep, subSpeed }
  var popMode = null; // 'activity' | 'usage' | 'context' | 'menu' | null
  var pendingTrend = null; // 待定点绘制的趋势样本：弹层 hidden 期间无像素宽，解除隐藏后 layoutTrend 消费

  function makePill(name, icon, title) {
    var p = el('button', 'zsb-pill');
    p.type = 'button';
    p.dataset.zsbPill = name;
    p.title = title;
    var ico = el('span', 'zsb-ico');
    ico.innerHTML = icon;
    p.appendChild(ico);
    // 注意：不预置空文本 span——pill 为 flex gap:6px，空子元素也会占一个 gap，
    // 会使图标与文字间距变成 12px（设计要求 6px）。
    return p;
  }

  function mountBar(anchor) {
    var bar = el('div', 'zsb-bar');
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-label', '状态条');

    // Activity：轮次·步数·tok/s（速度数字单独成 span：上色阶 + 估算态呼吸）
    var pAct = makePill('activity', ICONS.activity, I18N.verifiedTip);
    var actLabel = el('span', null, '--轮·--步·');
    var speedNum = el('span', 'zsb-num', '--');
    var speedUnit = el('span', null, ' tok/s');
    pAct.appendChild(actLabel);
    pAct.appendChild(speedNum);
    pAct.appendChild(speedUnit);

    // Usage：累计 token · 缓存 N%（缓存已含在输入，不重复相加）
    var pUsage = makePill('usage', ICONS.usage, I18N.usageTip);
    var usageNum = el('span', 'zsb-num', '-- tok');
    var usageSep = el('span', null, ' · 缓存');
    var cacheNum = el('span', 'zsb-num', '--');
    pUsage.appendChild(usageNum);
    pUsage.appendChild(usageSep);
    pUsage.appendChild(cacheNum);

    // 上下文：圆环 + 百分比（形态对齐 deepseek ContextMeter）。数据缺失时整 pill 隐藏（见 render）。
    var pCtx = makePill('context', CONTEXT_RING_SVG, I18N.contextTip);
    var ctxPct = el('span', 'zsb-num', '--');
    pCtx.appendChild(ctxPct);
    var ctxFill = pCtx.querySelector('.zsb-ring-fill');

    // 子代理：双态（运行中 = 活跃数·速度；闲 = 会话累计 token，中性灰）
    var pSub = makePill('subagent', ICONS.subagent, I18N.subIdleTip);
    var subLabel = el('span', 'zsb-num', '--');
    var subSep = el('span', null, ' · ');
    var subSpeed = el('span', 'zsb-num');
    subSep.style.display = 'none'; // 运行态才显示"活跃数 · 速度"
    subSpeed.style.display = 'none';
    pSub.appendChild(subLabel);
    pSub.appendChild(subSep);
    pSub.appendChild(subSpeed);

    // 齿轮
    var pGear = makePill('gear', ICONS.gear, I18N.gearTip);

    // 弹层容器（内容按 popMode 重建）
    var pop = el('div', 'zsb-pop');
    pop.hidden = true;

    bar.appendChild(pAct);
    bar.appendChild(pUsage);
    bar.appendChild(pCtx);
    bar.appendChild(pSub);
    bar.appendChild(pGear);
    bar.appendChild(pop);

    // 插到输入框容器正下方
    var host = anchor.parentElement;
    if (!host) return null;
    if (anchor.nextSibling) host.insertBefore(bar, anchor.nextSibling);
    else host.appendChild(bar);

    return {
      bar: bar,
      pop: pop,
      pills: { activity: pAct, usage: pUsage, context: pCtx, subagent: pSub, gear: pGear },
      activityLabel: actLabel,
      speedNum: speedNum,
      speedUnit: speedUnit,
      usageNum: usageNum,
      cacheNum: cacheNum,
      ctxPct: ctxPct,
      ctxFill: ctxFill,
      subLabel: subLabel,
      subSep: subSep,
      subSpeed: subSpeed,
    };
  }

  // ================= 弹层管理 =================

  function closePop() {
    if (!ui) return;
    ui.pop.hidden = true;
    popMode = null;
  }

  function openPop(mode) {
    if (!ui) return;
    popMode = mode;
    ui.pop.innerHTML = '';
    if (mode === 'activity') buildActivityDetail(ui.pop);
    else if (mode === 'usage') buildUsageDetail(ui.pop);
    else if (mode === 'context') buildContextDetail(ui.pop);
    else if (mode === 'menu') buildMenu(ui.pop);
    else {
      closePop();
      return;
    }
    ui.pop.hidden = false;
    layoutTrend(); // activity 弹层解除隐藏后才有容器像素宽，此时补画趋势图
  }

  function togglePop(mode) {
    if (popMode === mode) closePop();
    else openPop(mode);
  }

  function sectionTitle(pop, text) {
    var t = el('div', 'zsb-pop-title', text);
    pop.appendChild(t);
  }

  function row(k, v) {
    var r = el('div', 'zsb-row');
    r.appendChild(el('span', 'k', k));
    var vv = el('span', 'v');
    vv.textContent = v;
    r.appendChild(vv);
    return r;
  }

  // 上下文详情：已用 / 总量 + 占用进度条。数据与官方 pill 同源（隐藏锚点），
  // 分解仅在有 breakdown 时才画分段条——宿主锚点当前不带 breakdown，退化为单色进度条。
  function buildContextDetail(pop) {
    var c = state.context;
    sectionTitle(pop, I18N.contextTitle);
    if (!c) {
      pop.appendChild(el('div', 'k', I18N.noData));
      return;
    }
    var pct = Math.min(1, Math.max(0, c.used / c.size));
    pop.appendChild(row(I18N.ctxUsed, fmtTok(c.used)));
    pop.appendChild(row(I18N.ctxTotal, fmtTok(c.size)));
    pop.appendChild(row(I18N.ctxPercent, fmtPct(pct)));
    var bar = el('div', 'zsb-ctxbar');
    var fill = el('i', 'zsb-ctxbar-fill');
    fill.style.width = (pct * 100).toFixed(1) + '%';
    var ramp = rampApi();
    fill.style.background = (ramp && ramp.contextColor(pct)) || '';
    bar.appendChild(fill);
    pop.appendChild(bar);
  }

  // Activity 详情：模型用时 / 工具用时 / TTFT / 输出速度（TPS）/ 最近速度趋势。
  // 行序对齐 deepseek 弹层；TPS 与底部状态条速度数字同源（currentSpeed）同色阶（speedColor）。
  function buildActivityDetail(pop) {
    var s = state.session || {};
    sectionTitle(pop, I18N.activityTitle);
    var timing = s.timing || {};
    pop.appendChild(row(I18N.modelTime, fmtDur(timing.modelTimeMs)));
    pop.appendChild(row(I18N.toolTime, fmtDur(timing.toolTimeMs)));
    pop.appendChild(row(I18N.ttft, fmtDur(timing.ttftMs)));
    var sp = currentSpeed();
    var rTps = el('div', 'zsb-row');
    rTps.appendChild(el('span', 'k', I18N.tps));
    var tpsVal = el('span', 'v', sp ? Math.round(sp.v) + ' tok/s' : '--');
    if (sp) {
      var ramp = rampApi();
      tpsVal.style.color = (ramp && ramp.speedColor(sp.v)) || ''; // 与底部速度数字同色阶
      if (sp.est) tpsVal.className = 'v zsb-est'; // 估算态呼吸，与底部数字一致
    }
    rTps.appendChild(tpsVal);
    pop.appendChild(rTps);
    var trendSec = el('div', 'zsb-sec');
    trendSec.appendChild(el('div', 'k', I18N.trend));
    var trend = Array.isArray(s.speedTrend) ? s.speedTrend : [];
    if (!trend.length) {
      trendSec.appendChild(el('div', 'k', I18N.noData));
    } else {
      // SVG 需容器像素宽定点，构建时弹层仍 hidden；先留空盒，openPop 解除隐藏后 layoutTrend 补画
      trendSec.appendChild(el('div', 'zsb-trend'));
      pendingTrend = trend;
    }
    pop.appendChild(trendSec);
  }

  // 趋势图补画：弹层解除隐藏后读一次 clientWidth（强制回流，宽值可靠）再按真实宽定点。
  function layoutTrend() {
    if (popMode !== 'activity' || !pendingTrend || !ui) return;
    var box = ui.pop.querySelector('.zsb-trend');
    if (!box) return;
    var trend = pendingTrend;
    pendingTrend = null;
    box.innerHTML = buildTrendSvg(trend, box.clientWidth || 280);
  }

  // 速度趋势折线图（SVG 自绘，零依赖）：
  // - 纵轴按本轮样本动态归一（非固定色阶域），保证小速度样本也有可见波动；
  // - 顶/中虚线网格带峰值与半值标注，底部实线基线；
  // - 折线描边沿 x 用各采样点 speedColor 取色的 linearGradient，数据点圆点同色，
  //   颜色语义与底部状态条速度数字一致；
  // - 右上角标注当前速度（末点值，同色），左上角标注峰值；
  // - ramp 缺失 → 全图退 currentColor 中性灰（与数字降级口径一致）。
  // 坐标按构建时容器像素宽定点：弹层打开期间宽度稳定，重开弹层即重算。
  var TREND_H = 64; // 与 .zsb-trend 高度一致
  function buildTrendSvg(trend, w) {
    var padT = 14;
    var padB = 6;
    var plotH = TREND_H - padT - padB;
    var vals = trend.map(function (p) {
      return typeof p.tokPerSec === 'number' && isFinite(p.tokPerSec) ? Math.max(0, p.tokPerSec) : 0;
    });
    var n = vals.length;
    var vpeak = Math.max.apply(null, vals);
    var vmax = vpeak > 0 ? vpeak : 1; // 全零样本也画基线，避免除零
    var plotW = Math.max(1, w - 2);
    function x(i) {
      return n > 1 ? 1 + (i / (n - 1)) * plotW : w / 2;
    }
    function y(v) {
      return padT + (1 - v / vmax) * plotH;
    }
    function col(v) {
      var ramp = rampApi();
      return ramp ? ramp.speedColor(v) : 'currentColor';
    }

    var parts = [];
    parts.push('<svg width="' + w + '" height="' + TREND_H + '" viewBox="0 0 ' + w + ' ' + TREND_H + '" aria-hidden="true">');
    if (n > 1) {
      var stops = '';
      for (var i = 0; i < n; i++) {
        stops += '<stop offset="' + (i / (n - 1)).toFixed(4) + '" stop-color="' + col(vals[i]) + '"/>';
      }
      parts.push('<defs><linearGradient id="zsb-trend-grad" x1="0" y1="0" x2="1" y2="0">' + stops + '</linearGradient></defs>');
    }
    var yTop = y(vpeak > 0 ? vpeak : 0); // 全零时顶网格线落基线，与折线重合
    var yMid = y(vmax / 2);
    var yBase = y(0);
    parts.push('<line class="zsb-tgrid dash" x1="0" y1="' + yTop.toFixed(1) + '" x2="' + w + '" y2="' + yTop.toFixed(1) + '"/>');
    parts.push('<line class="zsb-tgrid dash" x1="0" y1="' + yMid.toFixed(1) + '" x2="' + w + '" y2="' + yMid.toFixed(1) + '"/>');
    parts.push('<line class="zsb-tgrid base" x1="0" y1="' + yBase.toFixed(1) + '" x2="' + w + '" y2="' + yBase.toFixed(1) + '"/>');
    parts.push('<text class="zsb-tick" x="0" y="' + (yTop - 3).toFixed(1) + '">' + fmtTok(vpeak) + '</text>');
    parts.push('<text class="zsb-tick" x="0" y="' + (yMid - 3).toFixed(1) + '">' + fmtTok(vmax / 2) + '</text>');
    if (n > 1) {
      var pts = '';
      for (var j = 0; j < n; j++) {
        pts += x(j).toFixed(1) + ',' + y(vals[j]).toFixed(1) + ' ';
      }
      var line = 'M' + x(0).toFixed(1) + ',' + yBase.toFixed(1) +
        ' L' + pts.trim().split(' ').join(' L') +
        ' L' + x(n - 1).toFixed(1) + ',' + yBase.toFixed(1) + ' Z';
      parts.push('<path d="' + line + '" fill="url(#zsb-trend-grad)" opacity="0.14"/>');
      parts.push('<polyline points="' + pts.trim() + '" fill="none" stroke="url(#zsb-trend-grad)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>');
    }
    for (var k = 0; k < n; k++) {
      parts.push('<circle cx="' + x(k).toFixed(1) + '" cy="' + y(vals[k]).toFixed(1) + '" r="' + (k === n - 1 ? 2.5 : 2) +
        '" fill="' + col(vals[k]) + '"><title>' + Math.round(vals[k]) + ' tok/s</title></circle>');
    }
    var last = vals[n - 1];
    parts.push('<text class="zsb-tnow" x="' + w + '" y="10" text-anchor="end" fill="' + col(last) + '">' +
      Math.round(last) + ' tok/s</text>');
    parts.push('</svg>');
    return parts.join('');
  }

  // Usage 详情：输入/输出/缓存读/缓存写分项 + 工具调用明细 + 子代理明细。无任何费用字样。
  function buildUsageDetail(pop) {
    var s = state.session || {};
    var t = s.tokens || {};
    sectionTitle(pop, I18N.usageTitle);
    pop.appendChild(row(I18N.inputTok, fmtTok(t.input)));
    pop.appendChild(row(I18N.outputTok, fmtTok(t.output)));
    pop.appendChild(row(I18N.cacheRead, fmtTok(t.cacheRead)));
    pop.appendChild(row(I18N.cacheWrite, fmtTok(t.cacheWrite)));
    var tools = s.tools || {};
    var toolSec = el('div', 'zsb-sec');
    toolSec.appendChild(el('div', 'zsb-pop-title', I18N.toolsTitle));
    var toolList = Array.isArray(tools.list) ? tools.list : [];
    var toolTotal = typeof tools.total === 'number' && isFinite(tools.total) ? tools.total : 0;
    if (!toolList.length && !toolTotal) {
      toolSec.appendChild(el('div', 'k', I18N.noData));
    } else {
      toolSec.appendChild(row(I18N.toolsTotal, toolTotal + I18N.toolCallsUnit +
        (tools.errors ? ' · ' + I18N.toolErrors + ' ' + tools.errors : '')));
      toolList.forEach(function (item) {
        var name = item.name || '--';
        var r = el('div', 'zsb-row');
        var k = el('span', 'zsb-tool-k', name);
        k.title = name;
        r.appendChild(k);
        var v = el('span', 'v');
        v.textContent = (item.count || 0) + I18N.toolCallsUnit + ' · ' + fmtMsNum(item.durationMs) +
          (item.errors ? ' · ' + I18N.toolErrors + ' ' + item.errors : '');
        r.appendChild(v);
        toolSec.appendChild(r);
      });
    }
    pop.appendChild(toolSec);
    var sub = s.subagent || {};
    var sec = el('div', 'zsb-sec');
    sec.appendChild(el('div', 'zsb-pop-title', I18N.subagents));
    var rows = Array.isArray(sub.rows) ? sub.rows : [];
    if (!rows.length) {
      sec.appendChild(el('div', 'k', I18N.noData));
    } else {
      rows.forEach(function (r) {
        var statusText = r.status === 'running' ? '运行中' : r.status === 'completed' ? '已完成' : r.status || '--';
        sec.appendChild(row((r.model || '子代理') + ' · ' + statusText, fmtTok(r.outputTokens)));
      });
    }
    pop.appendChild(sec);
  }

  // ================= 齿轮短菜单（R7，全部短句） =================

  function buildMenu(pop) {
    var menu = el('div', 'zsb-menu');
    menu.appendChild(el('div', 'zsb-menu-title', I18N.menuShow));
    [
      ['activity', I18N.pillActivity],
      ['usage', I18N.pillUsage],
      ['context', I18N.pillContext],
      ['subagent', I18N.pillSubagent],
      ['gear', I18N.pillGear],
    ].forEach(function (pair) {
      var mi = el('button', 'zsb-mi');
      mi.type = 'button';
      mi.dataset.act = 'toggle';
      mi.dataset.pill = pair[0];
      mi.appendChild(el('span', null, pair[1]));
      mi.appendChild(el('span', 'tick', state.visible[pair[0]] ? '✓' : ''));
      menu.appendChild(mi);
    });
    menu.appendChild(el('hr', 'zsb-hr'));
    [
      ['refresh', I18N.menuRefresh],
      ['diag', I18N.menuDiag],
      ['reset', I18N.menuReset],
      ['update', I18N.menuUpdate],
    ].forEach(function (pair) {
      var mi = el('button', 'zsb-mi');
      mi.type = 'button';
      mi.dataset.act = pair[0];
      mi.appendChild(el('span', null, pair[1]));
      menu.appendChild(mi);
    });
    menu.appendChild(el('div', 'zsb-menu-ver', 'v' + VERSION));
    var un = el('button', 'zsb-mi danger');
    un.type = 'button';
    un.dataset.act = 'uninstall';
    un.appendChild(el('span', null, I18N.menuUninstall));
    menu.appendChild(un);
    pop.appendChild(menu);
  }

  function emit(name, detail) {
    // 统一在 window 派发（与 turn-stats.js 的派发面一致，内核监听 window，见 CONTRACT.md）
    try {
      W.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
    } catch (e) {
      /* 派发失败静默 */
    }
  }

  function onMenuAction(act, pill) {
    if (act === 'toggle') {
      state.visible[pill] = !state.visible[pill];
      saveVisible();
      renderVisibility();
      openPop('menu'); // 重建勾选态
    } else if (act === 'refresh') {
      emit(EV.REFRESH, { paneId: state.paneId });
      render(); // 即时反馈：数据由内核重查后经 session 事件到达（CONTRACT.md §7.6）
      closePop();
    } else if (act === 'diag') {
      copyText(buildDiagText());
      // 短反馈：菜单项文字短暂替换为"已复制"
      if (ui && !ui.pop.hidden) {
        var mi = ui.pop.querySelector('[data-act="diag"]');
        if (mi) {
          var span = mi.querySelector('span');
          var old = span.textContent;
          span.textContent = I18N.copied;
          setTimeout(function () {
            span.textContent = old;
          }, 1200);
        }
      }
    } else if (act === 'reset') {
      emit(EV.RESET, { paneId: state.paneId });
      state.session = null;
      render();
      closePop();
    } else if (act === 'update') {
      emit(EV.CHECK_UPDATE, { paneId: state.paneId, from: 'gear-menu' });
      closePop();
    } else if (act === 'uninstall') {
      emit(EV.UNINSTALL, { paneId: state.paneId, from: 'gear-menu' });
      closePop();
    }
  }

  function copyText(text) {
    var done = false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(text);
        done = true;
      }
    } catch (e) {
      done = false;
    }
    if (!done) {
      // 降级：隐藏 textarea + execCommand
      try {
        var ta = D.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        D.body.appendChild(ta);
        ta.select();
        D.execCommand('copy');
        D.body.removeChild(ta);
      } catch (e) {
        /* 复制失败静默（诊断文本也可从日志取） */
      }
    }
  }

  function buildDiagText() {
    var bridge = W.__ZCODE_STATUSBAR_BRIDGE__;
    var lines = [
      'ZCode 状态条诊断',
      '版本: ' + VERSION,
      '时间: ' + new Date().toISOString(),
      '挂载: ' + (state.mounted ? '已挂载' : '未挂载' + (state.lastError ? '（' + state.lastError + '）' : '')),
      '身份: 桥=' + (bridge ? '有' : '无') + ' paneId=' + (state.paneId || 'null'),
      '模块: turn-stats=' + (W.__ZCODE_STATUSBAR_TURN_API__ ? '有' : '无') +
        ' ramp=' + (rampApi() ? '有' : '无（降级中性灰）'),
      '上下文: ' + (state.context
        ? fmtTok(state.context.used) + ' / ' + fmtTok(state.context.size) +
          '（' + fmtPct(state.context.used / state.context.size) + '）'
        : '未读到宿主锚点'),
      '最近会话数据: ' + (state.sessionAt ? new Date(state.sessionAt).toISOString() : '无'),
      '控件开关: ' + JSON.stringify(state.visible),
      '最近错误: ' + (state.lastError || '无'),
      'UA: ' + (navigator.userAgent || '--'),
    ];
    return lines.join('\n');
  }

  // ================= 渲染 =================

  // 显示 = 用户开关 AND 该 pill 有数据。上下文 pill 在宿主锚点缺席时整只不占位（R4/R10）。
  function renderVisibility() {
    if (!ui) return;
    ['activity', 'usage', 'context', 'subagent', 'gear'].forEach(function (n) {
      var on = state.visible[n] && (n !== 'context' || !!state.context);
      ui.pills[n].style.display = on ? '' : 'none';
    });
  }

  // 会话数据规范化：内核 session 事件的 detail 为 { ...zusage 快照, aggregate }（聚合缝
  // 包裹，见 inject-main.cjs handlePayload / CONTRACT.md §7.2）；本 UI 只消费 aggregate
  // 形状（CONTRACT.md §4.2）。非包裹路径（detail 即 aggregate）按特征键识别放行；
  // 其余形状（如宿主 store 快照）一律拒绝——宁可显示占位符，不可渲染错口径（R10）。
  function normalizeSession(d) {
    if (!d || typeof d !== 'object') return null;
    var agg = d.aggregate;
    if (agg && typeof agg === 'object' && !Array.isArray(agg)) return agg;
    if ('sessionAvgTokPerSec' in d || 'totalTokens' in d || 'subagent' in d) return d;
    return null;
  }

  // 当前速度读数：生成中（样本 3s 内新鲜）→ 估算态；否则 → 核实态（会话均）
  function currentSpeed() {
    var t = state.turn;
    if (t && typeof t.tokPerSec === 'number' && isFinite(t.tokPerSec) && Date.now() - t.updatedAt < TURN_FRESH_MS) {
      return { v: t.tokPerSec, est: true };
    }
    var s = state.session;
    if (s && typeof s.sessionAvgTokPerSec === 'number' && isFinite(s.sessionAvgTokPerSec)) {
      return { v: s.sessionAvgTokPerSec, est: false };
    }
    return null;
  }

  function render() {
    if (!ui) return;
    var s = state.session || {};
    var sub = s.subagent || {};

    // ---- Activity：轮次·步数·tok/s ----
    ui.activityLabel.textContent = (s.turns || 0) + '轮·' + (s.steps || 0) + '步·';
    var sp = currentSpeed();
    if (sp) {
      ui.speedNum.textContent = String(Math.round(sp.v));
      var color = rampApi() ? rampApi().speedColor(sp.v) : null; // ramp 缺失 → 保持中性灰
      ui.speedNum.style.color = color || '';
      ui.speedNum.className = 'zsb-num' + (sp.est ? ' zsb-est' : ''); // 估算态呼吸动画（R3）
      ui.pills.activity.title = sp.est ? I18N.estTip : I18N.verifiedTip;
    } else {
      ui.speedNum.textContent = '--';
      ui.speedNum.style.color = '';
      ui.speedNum.className = 'zsb-num';
      ui.pills.activity.title = I18N.verifiedTip;
    }

    // ---- Usage：累计 token · 缓存 N%（缓存已含在输入，不重复相加）----
    ui.usageNum.textContent = fmtTok(s.totalTokens) + ' tok';
    ui.cacheNum.textContent = fmtPct(s.cacheHitRate);

    // ---- 上下文：圆环 + 百分比；宿主锚点缺席或占用为 0 → 整只隐藏（R4/R10）----
    var ctx = readContextUsage();
    var ctxChanged = !!ctx !== !!state.context;
    state.context = ctx;
    if (ctx) {
      var ctxPct = ctx.used / ctx.size;
      ui.ctxPct.textContent = fmtPct(ctxPct);
      renderContextRing(ctxPct);
    }
    if (ctxChanged) renderVisibility(); // 有/无占用切换时才动 display，避免每秒重排

    // ---- 子代理双态（R5）：运行中 = 活跃数·速度（上色阶）；闲 = 会话累计（中性灰）----
    var subRunning = sub.activeCount > 0;
    if (subRunning && typeof sub.activeTokPerSec === 'number' && isFinite(sub.activeTokPerSec)) {
      ui.subSep.style.display = '';
      ui.subSpeed.style.display = '';
      ui.subSpeed.textContent = Math.round(sub.activeTokPerSec) + ' tok/s';
      var rampNow = rampApi();
      // ramp 缺失 → 速度退中性灰（继承基色）
      ui.subSpeed.style.color = rampNow ? rampNow.speedColor(sub.activeTokPerSec) || '' : '';
    } else {
      ui.subSep.style.display = 'none';
      ui.subSpeed.style.display = 'none';
      ui.subSpeed.style.color = '';
    }
    if (subRunning) {
      ui.subLabel.textContent = String(sub.activeCount);
      ui.pills.subagent.title = I18N.subRunningTip;
    } else {
      ui.subLabel.textContent = fmtTok(sub.sessionTokens || 0);
      ui.pills.subagent.title = I18N.subIdleTip;
    }
  }

  // ================= 上下文占用（R4，读宿主隐藏锚点；缺失静默） =================

  // 返回 { used, size } 或 null。口径与官方 getRenderableTaskUsage 一致：
  // used/size 必须有限且 > 0，否则视为「无可展示占用」，pill 整只不渲染。
  function readContextUsage() {
    var host = null;
    try {
      host = D.querySelector(USAGE_SELECTOR);
    } catch (e) {
      return null;
    }
    if (!host || !host.getAttribute) return null;
    var used = parseFloat(host.getAttribute('data-usage-used'));
    var size = parseFloat(host.getAttribute('data-usage-max'));
    if (!isFinite(used) || !isFinite(size) || used <= 0 || size <= 0) return null;
    return { used: used, size: size };
  }

  // 圆环进度：dash 长度按占用比例；描边色走 contextColor 色阶（ramp 缺失 → 继承基色）。
  function renderContextRing(pct) {
    if (!ui || !ui.ctxFill) return;
    var ramp = rampApi();
    ui.ctxFill.setAttribute('stroke-dasharray', (RING_C * pct).toFixed(2) + ' ' + RING_C.toFixed(2));
    ui.ctxFill.setAttribute('stroke', (ramp && ramp.contextColor(pct)) || 'currentColor');
  }

  // ================= 身份与挂载 =================

  function findAnchor() {
    for (var i = 0; i < MOUNT_ANCHORS.length; i++) {
      try {
        var n = D.querySelector(MOUNT_ANCHORS[i]);
        if (n) return n;
      } catch (e) {
        /* 非法选择器：跳过 */
      }
    }
    return null;
  }

  function identityOk() {
    var bridge = W.__ZCODE_STATUSBAR_BRIDGE__;
    if (!bridge || typeof bridge.getPaneId !== 'function') return null;
    var paneId = null;
    try {
      paneId = bridge.getPaneId();
    } catch (e) {
      paneId = null;
    }
    if (!paneId) return null; // 身份不可确认：拒绝渲染（防串数，R10）
    return { bridge: bridge, paneId: paneId };
  }

  // 说明：桥的 getSessionSnapshot() 返回宿主 conversation store 快照（非 CONTRACT §4.2
  // aggregate 形状），不作为会话统计数据源——会话数据仅来自内核 session 事件（聚合缝），
  // "立即刷新"由内核重查 SQLite 后重发 session 事件（CONTRACT.md §7.6）完成反馈。

  var mountTimer = null;
  var mountAnchor = null; // 当前挂载的输入框容器（用于检测宿主换 DOM 后重挂）

  // 会话身份：以挂载点所在 SessionPane 的 data-session-id 为准。
  // "draft" = 首页/新建任务，没有会话数据；找不到所属 pane 也按无会话处理（R10：宁可不显示）。
  function isRealSession(node) {
    var pane = null;
    try {
      pane = node.closest ? node.closest(SESSION_SELECTOR) : null;
    } catch (e) {
      pane = null;
    }
    if (!pane || !pane.getAttribute) return false;
    var sid = pane.getAttribute('data-session-id');
    return !!sid && sid !== DRAFT_SESSION_ID;
  }

  function unmountBar() {
    closePop();
    if (ui && ui.bar && ui.bar.parentNode) ui.bar.parentNode.removeChild(ui.bar);
    ui = null;
    mountAnchor = null;
    state.mounted = false;
    state.context = null;
  }
  function attemptMount() {
    var ident = identityOk();
    if (!ident) {
      unmountBar();
      state.lastError = '身份不可确认（桥缺失或 paneId 为空）';
      return;
    }

    var anchor = findAnchor();
    if (!anchor) {
      unmountBar();
      state.lastError = '未找到输入框挂载锚点';
      return;
    }

    // 换会话不重注入脚本（SPA 内切换），所以每轮都要核对：当前会话是否真实、宿主是否换了 DOM。
    var stale = state.mounted && (anchor !== mountAnchor || !D.contains(ui && ui.bar));
    if (stale) unmountBar();
    if (state.mounted) {
      state.paneId = ident.paneId;
      state.lastError = null;
      return;
    }

    if (!isRealSession(anchor)) {
      state.lastError = null; // 首页/新建任务：正常状态，不是错误
      return;
    }

    var mounted = mountBar(anchor);
    if (!mounted) {
      state.lastError = '挂载点插入失败';
      return;
    }
    ui = mounted;
    mountAnchor = anchor;
    state.mounted = true;
    state.paneId = ident.paneId;
    state.lastError = null;
    // turn 事件可能早于本文件事件绑定：挂载时补读全局最新样本
    if (W.__ZCODE_STATUSBAR_TURN__ && typeof W.__ZCODE_STATUSBAR_TURN__ === 'object') {
      state.turn = W.__ZCODE_STATUSBAR_TURN__;
    }
    applyThemeVars(ui.bar);
    renderVisibility();
    render();
    bindBarEvents();
  }

  function startMountLoop() {
    attemptMount();
    mountTimer = setInterval(attemptMount, MOUNT_POLL_MS);
  }

  // ================= 事件绑定 =================

  // 跟随 bar 生命周期的监听：随 REMOUNT 重建，故不挂 window/document 级持久监听。
  function bindBarEvents() {
    ui.pills.activity.addEventListener('click', function () {
      togglePop('activity');
    });
    ui.pills.usage.addEventListener('click', function () {
      togglePop('usage');
    });
    ui.pills.context.addEventListener('click', function () {
      togglePop('context');
    });
    ui.pills.gear.addEventListener('click', function () {
      togglePop('menu');
    });

    // 菜单动作（事件委托）
    ui.pop.addEventListener('click', function (ev) {
      var mi = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (mi && ui.pop.contains(mi)) onMenuAction(mi.dataset.act, mi.dataset.pill);
    });
  }

  // 全局监听只注册一次：turn/session 事件在 bar 未挂载时也要收，挂载后才能立刻出数据。
  function bindGlobalEvents() {
    // 外点关闭（capture 阶段；点击 pill 本身交给 pill 的 toggle 处理，避免闪烁）
    D.addEventListener('click', function (ev) {
      if (popMode == null || !ui) return;
      var t = ev.target;
      if (ui.pop.contains(t)) return;
      if (t.closest && t.closest('[data-zsb-pill]')) return;
      closePop();
    }, true);

    // Escape 关闭
    D.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && popMode != null) closePop();
    });

    // turn 样本：turn-stats.js → 本 UI
    W.addEventListener(EV.TURN, function (ev) {
      var d = ev && ev.detail;
      if (d && typeof d === 'object') {
        state.turn = d;
        render();
      }
    });

    // 会话聚合：内核主进程推送（detail = { ...zusage 快照, aggregate }，经 normalizeSession 取 aggregate）
    W.addEventListener(EV.SESSION, function (ev) {
      var d = normalizeSession(ev && ev.detail);
      if (d) {
        state.session = d;
        state.sessionAt = Date.now();
        render();
      }
    });

    // 周期渲染：估算态 3s 过期 → 核实态；tabular-nums + min-height 保证无跳动。
    // 常驻而非随 bar 建立，重挂后不会叠加多个定时器。
    setInterval(function () {
      render();
    }, 1000);

    // 主题变化（深浅切换）时重采变量
    try {
      var mq = W.matchMedia('(prefers-color-scheme: dark)');
      if (mq && typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', function () {
          if (ui) applyThemeVars(ui.bar);
        });
      }
    } catch (e) {
      /* 老宿主无 matchMedia 监听：忽略 */
    }
  }

  // 样式一次性注入（head 未就绪时等 DOMContentLoaded）
  function injectStyle() {
    if (D.getElementById('zcode-statusbar-style')) return;
    if (!D.head) {
      D.addEventListener('DOMContentLoaded', injectStyle, { once: true });
      return;
    }
    var st = D.createElement('style');
    st.id = 'zcode-statusbar-style';
    st.textContent = CSS;
    D.head.appendChild(st);
  }

  injectStyle();
  bindGlobalEvents();
  startMountLoop();
})();
