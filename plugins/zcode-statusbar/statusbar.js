/*!
 * statusbar.js —— ZCode 状态条 UI（renderer 注入，IIFE，无框架）
 *
 * 职责（prd R1/R3/R4/R5/R6/R7/R12）：输入框下方水平居中状态条，四控件（Activity / Usage / 子代理 / 齿轮）、
 * 详情弹层、齿轮短菜单、估算态呼吸标识、官方上下文圆环色阶增强；身份不可确认则不渲染。
 * 全部 DOM 自绘、无第三方依赖、无构建步骤；样式经 CSS 变量对齐官方 mono 栈与字号。
 *
 * 依赖的全局（均可缺失并降级，契约见 statusbar/CONTRACT.md）：
 * - window.__ZCODE_STATUSBAR_BRIDGE__   内核静态桥 { getPaneId(), getSessionSnapshot() }；缺失/返回 null → 不渲染（防串数）。
 * - window.__ZCODE_STATUSBAR_RAMP__     色阶 { speedColor, contextColor }（加载器组装自 ramp.js）；缺失 → 数字退中性灰、圆环不覆盖。
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
 * 3. 上下文占用不重复渲染第二圆环：仅对官方圆环做描边覆盖（R4 增强）；探测失败静默。
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
  // 挂载重试：500ms × 20 次 = 10s 静默重试窗口，超窗放弃（身份/锚点仍未就绪）
  var MOUNT_RETRY_MS = 500;
  var MOUNT_RETRY_MAX = 20;
  // 官方圆环增强轮询周期
  var RING_POLL_MS = 1000;

  // 挂载锚点候选（输入框容器），自上而下取第一个命中者；全部失效 → 重试窗口后放弃。
  // ZCode 宿主 DOM 未公开稳定锚点，候选为启发式，需实机校准。
  var MOUNT_ANCHORS = [
    '[data-zcode-composer]', // 未来官方/内核预留标记（乐观候选）
    'form[class*="composer" i]',
    '[class*="composer" i]',
    '[class*="prompt-editor" i]',
    '[class*="chat-input" i]',
    '[contenteditable="true"]', // 输入编辑器本身（挂到其父容器之后）
  ];

  // 官方上下文圆环探测候选（SVG 或其宿主按钮）。占用解析为 aria-label / data-usage-* 双源；
  // 官方 aria 文案未公开，以下正则为候选，需实机校准；探测失败一律静默（不残留）。
  var RING_SELECTORS = [
    '[data-usage-used] svg',
    'button[aria-label*="context" i] svg',
    'button[aria-label*="上下文"] svg',
    'button[aria-label*="占用"] svg',
  ];

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
    subRunningTip: '子代理运行中：活跃数 · 速度',
    subIdleTip: '子代理会话累计 token',
    gearTip: '状态条设置',
    noData: '暂无数据',
    activityTitle: '活动',
    usageTitle: '用量',
    modelTime: '模型用时',
    toolTime: '工具用时',
    ttft: '首字延迟',
    trend: '最近速度趋势',
    inputTok: '输入',
    outputTok: '输出',
    cacheRead: '缓存读',
    cacheWrite: '缓存写',
    subagents: '子代理明细',
    menuShow: '显示',
    pillActivity: '活动',
    pillUsage: '用量',
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
    givenUp: false,
    paneId: null,
    turn: null, // { tokPerSec, estimated, updatedAt }
    session: null, // session-stats.cjs aggregate() 输出
    sessionAt: 0, // 最近一次 session 数据到达时间（诊断用）
    ring: null, // { pct, source } 圆环增强状态（诊断用）
    lastError: null,
    visible: { activity: true, usage: true, subagent: true, gear: true },
  };

  // 显示开关持久化
  try {
    var saved = JSON.parse(W.localStorage.getItem(LS_PIILLS) || 'null');
    if (saved && typeof saved === 'object') {
      ['activity', 'usage', 'subagent', 'gear'].forEach(function (n) {
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
    '.zsb-sec{margin-top:10px;}',
    '.zsb-trend{display:flex;align-items:flex-end;gap:3px;height:36px;margin-top:4px;}',
    '.zsb-trend i{flex:1;min-width:3px;max-width:14px;border-radius:2px 2px 0 0;background:var(--zcode-color-text-secondary,currentColor);opacity:.6;display:block;}',
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
      '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="7" cy="7" r="2.2"/><path d="M7 1.2v1.6M7 11.2v1.6M12.8 7h-1.6M2.8 7H1.2M11.1 2.9l-1.2 1.2M4.1 9.9l-1.2 1.2M11.1 11.1l-1.2-1.2M4.1 4.1 2.9 2.9"/></svg>',
  };

  // ================= DOM 装配 =================

  var ui = null; // mountBar 返回的控件引用集：{ bar, pop, pills:{activity,usage,subagent,gear}, activityLabel, speedNum, usageNum, cacheNum, subLabel, subSep, subSpeed }
  var popMode = null; // 'activity' | 'usage' | 'menu' | null

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
      pills: { activity: pAct, usage: pUsage, subagent: pSub, gear: pGear },
      activityLabel: actLabel,
      speedNum: speedNum,
      speedUnit: speedUnit,
      usageNum: usageNum,
      cacheNum: cacheNum,
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
    else if (mode === 'menu') buildMenu(ui.pop);
    else {
      closePop();
      return;
    }
    ui.pop.hidden = false;
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

  // Activity 详情：模型用时 / 工具用时 / TTFT / 最近速度趋势（speedTrend 占位数据接口）
  function buildActivityDetail(pop) {
    var s = state.session || {};
    sectionTitle(pop, I18N.activityTitle);
    var timing = s.timing || {};
    pop.appendChild(row(I18N.modelTime, fmtMsNum(timing.modelTimeMs)));
    pop.appendChild(row(I18N.toolTime, fmtMsNum(timing.toolTimeMs)));
    pop.appendChild(row(I18N.ttft, fmtMsNum(timing.ttftMs)));
    var trendSec = el('div', 'zsb-sec');
    trendSec.appendChild(el('div', 'k', I18N.trend));
    var trend = Array.isArray(s.speedTrend) ? s.speedTrend : [];
    if (!trend.length) {
      trendSec.appendChild(el('div', 'k', I18N.noData));
    } else {
      var box = el('div', 'zsb-trend');
      trend.forEach(function (p) {
        var b = el('i');
        var h = Math.max(4, Math.min(100, (p.tokPerSec / 2000) * 100)); // 色阶同域（≥2000 封顶）作高度归一
        b.style.height = h + '%';
        b.title = Math.round(p.tokPerSec) + ' tok/s';
        box.appendChild(b);
      });
      trendSec.appendChild(box);
    }
    pop.appendChild(trendSec);
  }

  // Usage 详情：输入/输出/缓存读/缓存写分项 + 子代理明细。无任何费用字样。
  function buildUsageDetail(pop) {
    var s = state.session || {};
    var t = s.tokens || {};
    sectionTitle(pop, I18N.usageTitle);
    pop.appendChild(row(I18N.inputTok, fmtTok(t.input)));
    pop.appendChild(row(I18N.outputTok, fmtTok(t.output)));
    pop.appendChild(row(I18N.cacheRead, fmtTok(t.cacheRead)));
    pop.appendChild(row(I18N.cacheWrite, fmtTok(t.cacheWrite)));
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
      '圆环: ' + (state.ring ? '已增强（' + Math.round(state.ring.pct * 100) + '%，来源 ' + state.ring.source + '）' : '未探测到'),
      '最近会话数据: ' + (state.sessionAt ? new Date(state.sessionAt).toISOString() : '无'),
      '控件开关: ' + JSON.stringify(state.visible),
      '最近错误: ' + (state.lastError || '无'),
      'UA: ' + (navigator.userAgent || '--'),
    ];
    return lines.join('\n');
  }

  // ================= 渲染 =================

  function renderVisibility() {
    if (!ui) return;
    ['activity', 'usage', 'subagent', 'gear'].forEach(function (n) {
      ui.pills[n].style.display = state.visible[n] ? '' : 'none';
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

  // ================= 官方上下文圆环增强（R4，尽量实现、缺席静默） =================

  // 解析占用：优先 data-usage-used/max（隐藏测试节点），失败退 aria-label 正则。
  // 返回 { pct, source } 或 null；pct ∈ [0,1]。
  function readRingUsage(svg) {
    var host = svg.closest ? svg.closest('[data-usage-used]') : null;
    if (host) {
      var used = parseFloat(host.getAttribute('data-usage-used'));
      var max = parseFloat(host.getAttribute('data-usage-max'));
      if (isFinite(used) && isFinite(max) && max > 0) return { pct: Math.min(1, Math.max(0, used / max)), source: 'data-usage' };
    }
    var btn = svg.closest ? svg.closest('button[aria-label]') : null;
    var label = btn ? btn.getAttribute('aria-label') || '' : '';
    if (label) {
      var mPct = label.match(/(\d+(?:\.\d+)?)\s*%/);
      if (mPct) return { pct: Math.min(1, Math.max(0, parseFloat(mPct[1]) / 100)), source: 'aria-percent' };
      var mFrac = label.match(/([\d.,]+)\s*\/\s*([\d.,]+)/);
      if (mFrac) {
        var a = parseFloat(mFrac[1].replace(/,/g, ''));
        var b = parseFloat(mFrac[2].replace(/,/g, ''));
        if (isFinite(a) && isFinite(b) && b > 0) return { pct: Math.min(1, Math.max(0, a / b)), source: 'aria-fraction' };
      }
    }
    return null;
  }

  // 覆盖进度环描边：仅动 opacity ≥ 0.4 的描边元素（官方底环 opacity 0.25 不动）
  function applyRingStroke(svg, color) {
    var changed = false;
    var nodes = svg.querySelectorAll('circle, path, ellipse');
    nodes.forEach(function (n) {
      var stroke = n.getAttribute('stroke');
      if (!stroke || stroke === 'none' || stroke === 'transparent') return;
      var op = parseFloat(n.getAttribute('stroke-opacity'));
      if (!isFinite(op)) {
        try {
          op = parseFloat(W.getComputedStyle(n).strokeOpacity);
        } catch (e) {
          op = 1;
        }
        if (!isFinite(op)) op = 1;
      }
      if (op < 0.4) return; // 底环：保持官方样式
      n.setAttribute('style', 'stroke:' + color);
      changed = true;
    });
    return changed;
  }

  function enhanceRing() {
    var ramp = rampApi();
    if (!ramp) return; // 色阶缺失 → 不覆盖描边（保持官方原样），状态条数字退中性灰
    for (var i = 0; i < RING_SELECTORS.length; i++) {
      var nodes;
      try {
        nodes = D.querySelectorAll(RING_SELECTORS[i]);
      } catch (e) {
        continue;
      }
      for (var j = 0; j < nodes.length; j++) {
        var svg = nodes[j].tagName === 'svg' ? nodes[j] : nodes[j].querySelector('svg');
        if (!svg) continue;
        var usage = readRingUsage(svg);
        if (!usage) continue;
        var color = ramp.contextColor(usage.pct);
        if (!color) continue;
        if (svg.getAttribute('data-zsb-ring') === color) {
          state.ring = usage; // 已是目标色，仅刷新状态
          return;
        }
        if (applyRingStroke(svg, color)) {
          svg.setAttribute('data-zsb-ring', color);
          state.ring = usage;
          return;
        }
      }
    }
    state.ring = null; // 圆环缺席（如 Highspeed 锁定模型）：静默，无残留
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

  var mountTries = 0;
  var mountTimer = null;

  function attemptMount() {
    if (state.mounted || state.givenUp) {
      clearInterval(mountTimer);
      return;
    }
    mountTries += 1;
    var ident = identityOk();
    if (!ident) {
      state.lastError = '身份不可确认（桥缺失或 paneId 为空）';
      return;
    }
    var anchor = findAnchor();
    if (!anchor) {
      state.lastError = '未找到输入框挂载锚点';
      return;
    }
    ui = mountBar(anchor);
    if (!ui) {
      state.lastError = '挂载点插入失败';
      return;
    }
    clearInterval(mountTimer);
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
    bindEvents();
    enhanceRing();
    // 周期工作：圆环跟随 + 估算态过期切回核实态
    setInterval(function () {
      try {
        enhanceRing();
      } catch (e) {
        state.ring = null; /* 单次增强异常静默 */
      }
    }, RING_POLL_MS);
    setInterval(function () {
      render(); // 估算态 3s 过期 → 核实态；tabular-nums + min-height 保证无跳动
    }, 1000);
  }

  function startMountLoop() {
    attemptMount();
    mountTimer = setInterval(attemptMount, MOUNT_RETRY_MS);
    setTimeout(function () {
      if (!state.mounted) {
        state.givenUp = true;
        clearInterval(mountTimer);
        // 静默放弃：不渲染任何内容，仅保留诊断路径（lastError 已记录）
      }
      clearInterval(mountTimer);
    }, MOUNT_RETRY_MS * MOUNT_RETRY_MAX + 50);
  }

  // ================= 事件绑定 =================

  function bindEvents() {
    // 控件点击：Activity/Usage → 详情弹层；齿轮 → 菜单
    ui.pills.activity.addEventListener('click', function () {
      togglePop('activity');
    });
    ui.pills.usage.addEventListener('click', function () {
      togglePop('usage');
    });
    ui.pills.gear.addEventListener('click', function () {
      togglePop('menu');
    });

    // 菜单动作（事件委托）
    ui.pop.addEventListener('click', function (ev) {
      var mi = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (mi && ui.pop.contains(mi)) onMenuAction(mi.dataset.act, mi.dataset.pill);
    });

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

    // 主题变化（深浅切换）时重采变量
    try {
      var mq = W.matchMedia('(prefers-color-scheme: dark)');
      if (mq && typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', function () {
          applyThemeVars(ui.bar);
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
  startMountLoop();
})();
