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

  // 上下文来源分桶：宿主 usage.contextWindow.breakdown 的七个 source 归三桶。
  // 配色对齐 deepseek ContextMeter（中性灰 / 紫 / 蓝），深浅主题值由 applyThemeVars 写入。
  var CTX_BUCKETS = [
    { key: 'system', label: 'ctxSystem', color: 'var(--zsb-ctx-system,#adb2b8)' },
    { key: 'tools', label: 'ctxTools', color: 'var(--zsb-ctx-tools,#a78bfa)' },
    { key: 'messages', label: 'ctxMessages', color: 'var(--zsb-ctx-messages,#4d93f8)' },
  ];
  // source → 桶引用（表驱动：新增 source 只改这里，contextShares 不分支）
  var CTX_BUCKET_OF = {
    system_prompt: CTX_BUCKETS[0],
    meta_user_context: CTX_BUCKETS[0],
    skills: CTX_BUCKETS[0],
    tool_prompt: CTX_BUCKETS[1],
    system_tool_schemas: CTX_BUCKETS[1],
    mcp_tool_schemas: CTX_BUCKETS[1],
    messages: CTX_BUCKETS[2],
  };

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
    subRunningTip: '子代理运行中 · 实时速度',
    subIdleTip: '子代理会话累计 token',
    gearTip: '状态条设置',
    noData: '暂无数据',
    activityTitle: '活动',
    usageTitle: '用量',
    contextTitle: '上下文',
    modelTime: '模型用时',
    toolTime: '工具用时',
    ttft: '首字延迟',
    trend: '速度趋势',
    tps: '输出速度（TPS）',
    inputTok: '输入',
    outputTok: '输出',
    cacheRead: '缓存读',
    cacheWrite: '缓存写',
    cacheShare: '缓存占比',
    todayTitle: '今日用量',
    todayTokens: 'token 总用量',
    todayCacheRate: '平均缓存率',
    toolsTitle: '工具调用',
    toolCallsUnit: '次',
    subagents: '子代理明细',
    subRunning: '运行中',
    subDone: '已完成',
    subBack: '返回',
    subUnnamed: '子代理',
    subStatus: '状态',
    subTask: '任务',
    subStarted: '开始时间',
    subDuration: '耗时',
    subRequests: '请求数',
    subInput: '输入',
    subOutput: '输出',
    subCache: '缓存读 / 写',
    subTps: '平均速度',
    subStRunning: '运行中',
    subStDone: '已完成',
    subStError: '失败',
    subStCancelled: '已取消',
    ctxUsed: '已用',
    ctxTotal: '总量',
    ctxPercent: '占比',
    ctxHeadline: '上下文已用',
    ctxSystem: '系统提示词',
    ctxTools: '工具定义',
    ctxMessages: '对话消息',
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
    today: null, // 内核帧的 today 块（全库今日 completed 行）；与 session 口径不同，单独存
    sessionAt: 0, // 最近一次 session 数据到达时间（诊断用）
    context: null, // { used, size } 上下文占用（读宿主隐藏锚点，诊断用）
    breakdown: null, // [{ source, chars }] 上下文来源明细（弹层打开时读一次，见 readContextBreakdown）
    subSeen: false, // 本会话是否出现过子代理：出现过就一直显示 pill，换会话重置（防串数）
    sessionOwner: null, // 当前会话 id（来自内核 detail.mine）：判定"换会话"的唯一依据
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

  // 紧凑 token 数：≥100 的缩放值取整（262K 而非 262.0K，去掉假精度），
  // 小数只在量级小时有意义（11.4K）。与 deepseek ContextMeter 的 formatTokens 同口径。
  function fmtScaled(v) {
    return v >= 100 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1);
  }

  function fmtTok(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '--';
    if (n >= 1e9) return fmtScaled(n / 1e9) + 'B';
    if (n >= 1e6) return fmtScaled(n / 1e6) + 'M';
    if (n >= 1000) return fmtScaled(n / 1000) + 'K';
    return String(Math.round(n));
  }

  function fmtPct(rate) {
    if (typeof rate !== 'number' || !isFinite(rate)) return '--';
    return Math.round(rate * 100) + '%';
  }

  // 有限数值读取：非有限值一律视为缺失（null），与 session-stats.cjs 的 num() 同口径
  function finNum(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  // 来源占比：≥10% 取整（避免长条上的抖动），小份额保留一位小数（0.4% 不吃成 0%）
  function fmtShare(rate) {
    if (typeof rate !== 'number' || !isFinite(rate)) return '--';
    var p = rate * 100;
    return (p >= 10 ? String(Math.round(p)) : (Math.round(p * 10) / 10).toFixed(1)) + '%';
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
    // 单行铁律：bar 与 pill 一律 nowrap 且 pill 不可收缩（flex:none）。容器收窄时不再换行，
    // 改由 fitBar 的降级阶梯（fit=1..7，见下方 data-fit 规则）逐档让位。
    // safe center：极窄时退化为左对齐，读数从头可见，而不是两端各裁一半。
    '.zsb-bar{position:relative;display:flex;justify-content:center;justify-content:safe center;',
    'align-items:center;gap:12px;',
    'min-height:22px;margin-top:4px;margin-bottom:8px;',
    'font-family:var(--zcode-font-mono,' + JSON.stringify(DEFAULT_MONO) + ');',
    'font-size:var(--zcode-font-text-sm-size,12px);font-weight:400;line-height:20px;',
    'color:var(--zcode-color-text-secondary,var(--zsb-subtle,#818a8c));',
    'font-variant-numeric:tabular-nums;user-select:none;-webkit-user-select:none;z-index:60;',
    'white-space:nowrap;}',
    '.zsb-pill{display:inline-flex;align-items:center;gap:6px;padding:1px 8px;border-radius:8px;',
    'border:0;background:transparent;color:inherit;font:inherit;line-height:inherit;cursor:pointer;',
    'font-variant-numeric:tabular-nums;transition:background-color .15s ease,color .15s ease;',
    'flex:none;white-space:nowrap;}',
    // 窄容器降级阶梯：data-fit 为空格分隔的档位集合（"1 2"=已启用前两档），由 fitBar 按
    // 实测可用宽度逐档抬高（不是媒体查询——状态条容器宽度与窗口宽度无关）。
    // 档位按价值序编号，与 pill 的视觉顺序（Activity → Usage → 子代理 → 上下文 → 齿轮）解耦。
    // 价值序（先让位的是最可牺牲的）：缓存命中（派生指标，长期稳定） < 闲置子代理统计
    // < 轮·步读数 < 用量总量 < 运行中子代理 < 速度单位 < 上下文百分比。
    // 上下文圆环与齿轮任何档位都不隐（R4）；读数在各弹层内始终完整可查。
    // 用量 pill 一旦隐就整只隐（不留孤立图标——脱离了数字的图标读不出语义，只是噪音）。
    '.zsb-bar[data-fit~="1"] .zsb-f1,', // 缓存命中（Usage 弹层内仍有）
    '.zsb-bar[data-fit~="2"]:not([data-sub="run"]) [data-zsb-pill="subagent"],', // 闲置子代理（非运行态）
    '.zsb-bar[data-fit~="3"] .zsb-f3,', // 轮·步读数（Activity 弹层内仍有）
    '.zsb-bar[data-fit~="4"] [data-zsb-pill="usage"],', // 用量 pill 整只（Usage 弹层内仍有）
    '.zsb-bar[data-fit~="5"] [data-zsb-pill="subagent"],', // 运行中子代理
    '.zsb-bar[data-fit~="6"] .zsb-f6,', // 速度单位 tok/s
    '.zsb-bar[data-fit~="7"] .zsb-f7{display:none;}', // 上下文百分比（圆环本身仍显示占比）
    // 进入降级后顺手收紧间距：gap 12px→8px、pill 内边距 8px→6px，约再省 40px
    '.zsb-bar[data-fit~="1"]{gap:8px;}',
    '.zsb-bar[data-fit~="1"] .zsb-pill{padding:1px 6px;}',
    // hover：淡灰背景 + 升为二级文字色（fallback 同样按主题经 --zsb-hover 提供）
    '.zsb-pill:hover{background:color-mix(in srgb,currentColor 10%,transparent);',
    'color:var(--zcode-color-text-secondary-hover,var(--zsb-hover,#565a60));}',
    '.zsb-ico{display:inline-flex;width:14px;height:14px;flex:none;}',
    '.zsb-ico svg{width:14px;height:14px;display:block;}',
    '.zsb-num{font-variant-numeric:tabular-nums;}',
    '.zsb-est{animation:zsb-breathe 2s ease-in-out infinite;}',
    '@keyframes zsb-breathe{0%,100%{opacity:1}50%{opacity:.85}}',
    // 运行中子代理呼吸灯：周期/振幅对齐原插件 zupulse。zsb-est 标记估算值，两者语义不同。
    '.zsb-pulse{animation:zsb-pulse 1.6s ease-in-out infinite;}',
    '@keyframes zsb-pulse{0%,100%{opacity:1}50%{opacity:.2}}',
    '@media (prefers-reduced-motion:reduce){.zsb-est,.zsb-pulse{animation:none;opacity:.8}}',
    // 运行态绿点：只表达"有子代理在跑"，不参与速度语义（速度仍由色阶表达）。
    // 颜色经 --zsb-live 按深浅主题取值（#3ecf8e / #0c8a63，取自原插件 zupulse）。
    '.zsb-livedot{width:6px;height:6px;border-radius:999px;flex:none;background:var(--zsb-live,#3ecf8e);}',
    '.zsb-livedot.zsb-pulse{animation:zsb-pulse 1.6s ease-in-out infinite;}',
    // 子代理面板：分组 + 每行「状态点 类型 任务 →」。省略号统一给中间的任务列，
    // 类型与箭头固定在两端，行宽不随任务文本跳动。
    '.zsb-subgroup{margin-top:10px;}',
    '.zsb-subgroup:first-child{margin-top:0;}',
    '.zsb-subrow{display:flex;align-items:center;gap:6px;line-height:24px;padding:1px 4px;border-radius:6px;',
    'border:0;background:transparent;color:inherit;font:inherit;font-size:inherit;text-align:left;',
    'width:100%;cursor:pointer;font-variant-numeric:tabular-nums;}',
    '.zsb-subrow:hover{background:color-mix(in srgb,currentColor 10%,transparent);}',
    '.zsb-subdot{width:6px;height:6px;border-radius:999px;flex:none;background:currentColor;opacity:.75;}',
    // 面板内运行中行：状态点用同一绿色（静止，呼吸只留在条上，避免多点同闪）
    '.zsb-subdot.zsb-live{background:var(--zsb-live,#3ecf8e);opacity:1;}',
    '.zsb-subrow .nm{flex:none;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.zsb-subrow .tk{flex:1;min-width:0;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.zsb-subrow .go{flex:none;opacity:.5;}',
    '.zsb-back{display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;color:inherit;',
    'font:inherit;font-size:inherit;cursor:pointer;padding:0 4px 6px 0;border-radius:6px;opacity:.8;}',
    '.zsb-back:hover{opacity:1;}',
    '.zsb-ring-fill{transition:stroke-dasharray .3s ease,stroke .3s ease;}',
    '.zsb-ctxbar{height:4px;border-radius:999px;margin-top:10px;overflow:hidden;display:flex;gap:1px;',
    'background:color-mix(in srgb,currentColor 16%,transparent);}',
    '.zsb-ctxbar-fill{display:block;height:100%;border-radius:999px;',
    'background:currentColor;transition:width .3s ease;}',
    '.zsb-ctxseg{display:block;height:100%;flex:none;min-width:2px;transition:width .3s ease;}',
    // 头部：读数与总量同时可见，读数为强调色、其余为弱化色（对齐 deepseek header 层级）
    '.zsb-ctx-head{display:flex;align-items:baseline;gap:6px;line-height:22px;}',
    '.zsb-ctx-headline{opacity:.7;}',
    '.zsb-ctx-percent{font-weight:500;}',
    '.zsb-ctx-figures{margin-left:auto;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap;}',
    '.zsb-ctxlist{margin-top:8px;}',
    '.zsb-ctxrow{display:flex;align-items:center;gap:6px;line-height:22px;}',
    '.zsb-ctxrow .k{opacity:.85;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.zsb-ctxrow .v{margin-left:auto;font-variant-numeric:tabular-nums;}',
    '.zsb-ctxsw{width:8px;height:8px;border-radius:2px;flex:none;}',
    // 宽度对齐 deepseek 弹层：标签与读数之间留足呼吸，趋势图可横向铺开更多采样点。
    '.zsb-pop{position:absolute;bottom:calc(100% + 10px);left:50%;',
    'transform:translateX(-50%);',
    'min-width:280px;max-width:360px;padding:12px 14px;border-radius:12px;',
    'background:var(--zsb-pop-bg,var(--zsb-pop-bg-fallback,#fff));border:1px solid var(--zsb-pop-border,rgba(0,0,0,.12));',
    'box-shadow:0 8px 28px rgba(0,0,0,.18);color:var(--zcode-color-text-primary,var(--zsb-primary,#232629));',
    'font-variant-numeric:tabular-nums;text-align:left;z-index:70;}',
    '.zsb-pop[hidden]{display:none;}',
    '.zsb-pop-title{font-weight:500;margin-bottom:8px;}',
    '.zsb-row{display:flex;justify-content:space-between;gap:16px;line-height:22px;}',
    '.zsb-row .k{opacity:.85;white-space:nowrap;}',
    '.zsb-row .v{white-space:nowrap;}',
    // 工具名行截断：长工具名（如 MCP 全名）不撑破 max-width:360px 的弹层（.k 默认 nowrap 不截断）
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
    '.zsb-menu-ver{opacity:.55;line-height:20px;padding:0 4px;text-align:right;}',
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
    // 上下文来源配色：系统提示词跟主题灰走（深色下提亮），工具/消息用固定紫蓝（deepseek 同款）
    root.style.setProperty('--zsb-ctx-system', dark ? 'rgb(173,178,184)' : 'rgb(129,133,140)');
    root.style.setProperty('--zsb-ctx-tools', '#a78bfa');
    root.style.setProperty('--zsb-ctx-messages', dark ? 'rgb(77,147,248)' : 'rgb(59,130,246)');
    // 子代理运行态绿点（原插件 zupulse 同色）：深色提亮，浅色压深保证白底可辨
    root.style.setProperty('--zsb-live', dark ? '#3ecf8e' : '#0c8a63');
  }

  // ================= 图标（内联 SVG，14×14，描边继承 currentColor） =================
  // activity / usage / gear 的路径数据取自 deepseek-harness 的 ui-primitives 图标表
  // （packages/client/ui-primitives/src/icons/artwork.ts，MIT，Copyright (c) 2026 DeepSeek）。
  // 画布是 viewBox 16，渲染到 14px 时缩放 0.875，故 stroke-width 写 1.6（生效 1.4px），
  // 与自绘子代理图标（viewBox 14 / 1.4）字重一致。子代理保留自绘三分叉，不用人形头像。

  var ICONS = {
    activity:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M3.4041 13.096C2.49514 12.187 1.87614 11.0288 1.62537 9.76798C1.37459 8.50716 1.50331 7.20028 1.99525 6.01261C2.48719 4.82494 3.32025 3.80981 4.3891 3.09557C5.45795 2.38134 6.71458 2.00008 8.0001 2C9.28563 2.00008 10.5423 2.38134 11.6111 3.09557C12.68 3.80981 13.513 4.82494 14.005 6.01261C14.4969 7.20028 14.6256 8.50716 14.3748 9.76798C14.1241 11.0288 13.5051 12.187 12.5961 13.096"/>' +
      '<path d="M8 8.49994L11.6114 4.88855"/>' +
      '<path d="M8 9.75C8.69036 9.75 9.25 9.19036 9.25 8.5C9.25 7.80964 8.69036 7.25 8 7.25C7.30964 7.25 6.75 7.80964 6.75 8.5C6.75 9.19036 7.30964 9.75 8 9.75Z" fill="currentColor"/></svg>',
    usage:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M13.1967 5.1869C13.7232 4.77378 14.0003 4.30517 14.0001 3.82819C14.0003 3.3512 13.7232 2.88259 13.1967 2.46947C12.6702 2.05635 11.9128 1.71328 11.0006 1.47475C10.0885 1.23621 9.05371 1.11062 8.00039 1.1106C6.94707 1.11057 5.9123 1.23612 5.00009 1.47461C4.08742 1.71301 3.32948 2.05604 2.80249 2.46919C2.2755 2.88235 1.99805 3.35106 1.99805 3.82819C1.99805 4.30531 2.2755 4.77402 2.80249 5.18718C3.32948 5.60033 4.08742 5.94336 5.00009 6.18176C5.9123 6.42025 6.94707 6.5458 8.00039 6.54578C9.05371 6.54575 10.0885 6.42016 11.0006 6.18163C11.9128 5.94309 12.6702 5.60002 13.1967 5.1869Z"/>' +
      '<path d="M2 3.80371V11.7848"/><path d="M14 3.80371V11.7848"/>' +
      '<path d="M2 7.81396C2 8.60524 2.63214 9.36411 3.75736 9.92363C4.88258 10.4832 6.4087 10.7975 8 10.7975C9.5913 10.7975 11.1174 10.4832 12.2426 9.92363C13.3679 9.36411 14 8.60524 14 7.81396"/>' +
      '<path d="M2 11.7847C2 12.6081 2.63214 13.3977 3.75736 13.98C4.88258 14.5622 6.4087 14.8893 8 14.8893C9.5913 14.8893 11.1174 14.5622 12.2426 13.98C13.3679 13.3977 14 12.6081 14 11.7847"/></svg>',
    subagent:
      '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="7" cy="2.8" r="1.8"/><circle cx="2.8" cy="11" r="1.8"/><circle cx="11.2" cy="11" r="1.8"/>' +
      '<path d="M7 4.6v3M7 7.6 3.6 9.5M7 7.6l3.4 1.9"/></svg>',
    gear:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M8 9.75012C8.9665 9.75012 9.75 8.96662 9.75 8.00012C9.75 7.03362 8.9665 6.25012 8 6.25012C7.0335 6.25012 6.25 7.03362 6.25 8.00012C6.25 8.96662 7.0335 9.75012 8 9.75012Z"/>' +
      '<path d="M13.0107 7.79377C12.9505 7.89401 12.9205 7.94413 12.9205 7.99951C12.9205 8.0549 12.9505 8.10502 13.0106 8.20528L13.9849 9.83006C14.045 9.93029 14.0751 9.9804 14.0751 10.0358C14.0751 10.0911 14.045 10.1413 13.9849 10.2415L13.0037 11.8777C12.9468 11.9726 12.9184 12.0201 12.8725 12.0461C12.8267 12.072 12.7713 12.072 12.6607 12.072H10.6704C10.5598 12.072 10.5045 12.072 10.4586 12.098C10.4128 12.1239 10.3843 12.1714 10.3274 12.2662L9.33825 13.9142C9.28133 14.009 9.25287 14.0564 9.20703 14.0823C9.16118 14.1083 9.10588 14.1083 8.99529 14.1083H7.00486C6.89426 14.1083 6.83896 14.1083 6.79312 14.0823C6.74727 14.0564 6.71881 14.009 6.6619 13.9142L5.67273 12.2662C5.61581 12.1714 5.58735 12.1239 5.54151 12.098C5.49566 12.072 5.44036 12.072 5.32977 12.072H3.33945C3.2288 12.072 3.17347 12.072 3.12761 12.0461C3.08176 12.0201 3.0533 11.9726 2.9964 11.8777L2.0152 10.2415C1.9551 10.1413 1.92505 10.0911 1.92505 10.0358C1.92505 9.9804 1.9551 9.93029 2.0152 9.83006L2.98951 8.20528C3.04963 8.10502 3.07969 8.0549 3.07969 7.99951C3.07968 7.94413 3.04961 7.89401 2.98946 7.79377L2.01529 6.17011C1.95514 6.06987 1.92507 6.01975 1.92507 5.96437C1.92506 5.90899 1.95512 5.85886 2.01524 5.7586L2.9964 4.1224C3.0533 4.0275 3.08176 3.98005 3.12761 3.95408C3.17347 3.92811 3.2288 3.92811 3.33945 3.92811H5.32977C5.44036 3.92811 5.49566 3.92811 5.54151 3.90216C5.58735 3.87621 5.61581 3.82879 5.67273 3.73397L6.6619 2.08599C6.71881 1.99116 6.74727 1.94375 6.79312 1.9178C6.83896 1.89185 6.89426 1.89185 7.00486 1.89185H8.99529C9.10588 1.89185 9.16118 1.89185 9.20703 1.9178C9.25287 1.94375 9.28133 1.99116 9.33825 2.08599L10.3274 3.73397C10.3843 3.82879 10.4128 3.87621 10.4586 3.90216C10.5045 3.92811 10.5598 3.92811 10.6704 3.92811H12.6607C12.7713 3.92811 12.8267 3.92811 12.8725 3.95408C12.9184 3.98005 12.9468 4.0275 13.0037 4.1224L13.9849 5.7586C14.045 5.85886 14.0751 5.90899 14.0751 5.96437C14.0751 6.01975 14.045 6.06987 13.9849 6.17011L13.0107 7.79377Z" stroke-miterlimit="10"/></svg>',
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

  var ui = null; // mountBar 返回的控件引用集：{ bar, pop, pills:{activity,usage,context,subagent,gear}, activityLabel, speedNum, usageNum, cacheNum, ctxPct, ctxFill, subLive, subLabel, subSpeed }
  var popMode = null; // 'activity' | 'usage' | 'context' | 'menu' | null
  var pendingTrend = null; // 待定点绘制的趋势样本：弹层 hidden 期间无像素宽，解除隐藏后 layoutTrend 消费
  var resizeObserver = null; // 容器宽度监听（watchResize 建立，随 bar 生命周期）

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
    var actLabel = el('span', 'zsb-f3', '--轮·--步·'); // 窄容器让位次序见 CSS 阶梯
    var speedNum = el('span', 'zsb-num', '--');
    var speedUnit = el('span', 'zsb-f6', ' tok/s');
    pAct.appendChild(actLabel);
    pAct.appendChild(speedNum);
    pAct.appendChild(speedUnit);

    // Usage：累计 token · 缓存 N%（缓存已含在输入，不重复相加）
    var pUsage = makePill('usage', ICONS.usage, I18N.usageTip);
    var usageNum = el('span', 'zsb-num zsb-f4', '-- tok');
    var usageSep = el('span', 'zsb-f1', ' · 缓存');
    var cacheNum = el('span', 'zsb-num zsb-f1', '--');
    pUsage.appendChild(usageNum);
    pUsage.appendChild(usageSep);
    pUsage.appendChild(cacheNum);

    // 上下文：圆环 + 百分比（形态对齐 deepseek ContextMeter）。数据缺失时整 pill 隐藏（见 render）。
    var pCtx = makePill('context', CONTEXT_RING_SVG, I18N.contextTip);
    var ctxPct = el('span', 'zsb-num zsb-f7', '--');
    pCtx.appendChild(ctxPct);
    var ctxFill = pCtx.querySelector('.zsb-ring-fill');

    // 子代理双态：运行中 = 绿点 · 速度；闲 = 会话累计 token（中性灰）。
    // 运行态不显示活跃数——二元状态由绿点承担，个数在子代理面板分组标题里可查。
    var pSub = makePill('subagent', ICONS.subagent, I18N.subIdleTip);
    var subLive = el('i', 'zsb-livedot');
    var subLabel = el('span', 'zsb-num', '--');
    var subSpeed = el('span', 'zsb-num');
    subLive.style.display = 'none'; // 运行态才显示绿点
    subSpeed.style.display = 'none';
    pSub.appendChild(subLive);
    pSub.appendChild(subLabel);
    pSub.appendChild(subSpeed);

    // 齿轮
    var pGear = makePill('gear', ICONS.gear, I18N.gearTip);

    // 弹层容器（内容按 popMode 重建）
    var pop = el('div', 'zsb-pop');
    pop.hidden = true;

    bar.appendChild(pAct);
    bar.appendChild(pUsage);
    bar.appendChild(pSub);
    bar.appendChild(pCtx);
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
      subLive: subLive,
      subLabel: subLabel,
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
    else if (mode === 'subagent') buildSubagentPanel(ui.pop);
    else if (mode === 'context') {
      state.breakdown = readContextBreakdown(); // 仅打开时读一次，不进 1s 渲染循环
      buildContextDetail(ui.pop);
    } else if (mode === 'menu') buildMenu(ui.pop);
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

  // 子代理面板是唯一"活"的弹层：数据每秒都在变，冻结在打开那一刻就等于读数不动。
  // 只在 subagent 模式且数据到达时重建，其余弹层保持"打开时快照"的既有行为。
  // 重建保留 subView（列表/详情位置），所以详情页会随数据刷新而不是被踢回列表。
  function refreshSubagentPop() {
    if (popMode !== 'subagent' || !ui) return;
    openPop('subagent');
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

  // 上下文详情（形态对齐 deepseek ContextMeter）：头部一行读数 + 分段占用条 + 来源图例。
  // 头部数字取自宿主隐藏锚点（提供方精确水位）；分段与图例来自宿主 breakdown，
  // 读不到时退化为单色进度条且整块图例不渲染（绝不用猜测值凑三行）。
  function buildContextDetail(pop) {
    var c = state.context;
    if (!c) {
      sectionTitle(pop, I18N.contextTitle);
      pop.appendChild(el('div', 'k', I18N.noData));
      return;
    }
    var pct = Math.min(1, Math.max(0, c.used / c.size));
    var shares = contextShares();

    var head = el('div', 'zsb-ctx-head');
    head.appendChild(el('span', 'zsb-ctx-headline', I18N.ctxHeadline));
    head.appendChild(el('span', 'zsb-ctx-percent', fmtPct(pct)));
    head.appendChild(el('span', 'zsb-ctx-figures', fmtTok(c.used) + ' / ' + fmtTok(c.size)));
    pop.appendChild(head);

    var bar = el('div', 'zsb-ctxbar');
    if (shares) {
      // 分段长度 = 总水位 × 该来源份额：条的总长仍是精确值，分项只切分它。
      shares.forEach(function (s) {
        var seg = el('i', 'zsb-ctxseg');
        seg.style.width = (pct * s.share * 100).toFixed(2) + '%';
        seg.style.background = s.color;
        bar.appendChild(seg);
      });
    } else {
      var fill = el('i', 'zsb-ctxbar-fill');
      fill.style.width = (pct * 100).toFixed(1) + '%';
      var ramp = rampApi();
      fill.style.background = (ramp && ramp.contextColor(pct)) || '';
      bar.appendChild(fill);
    }
    pop.appendChild(bar);

    if (shares) {
      var list = el('div', 'zsb-ctxlist');
      shares.forEach(function (s) {
        var r = el('div', 'zsb-ctxrow');
        var sw = el('i', 'zsb-ctxsw');
        sw.style.background = s.color;
        r.appendChild(sw);
        r.appendChild(el('span', 'k', s.label));
        r.appendChild(el('span', 'v', s.sharePct));
        list.appendChild(r);
      });
      pop.appendChild(list);
    }
  }

  // 来源分桶：宿主七个 source 归三桶。未知 source 不计入——枚举扩展时比例在已知来源
  // 内归一，不猜归属（宁可比例偏差，不可错标来源）。
  function contextShares() {
    var list = state.breakdown;
    if (!list || !list.length) return null;
    var totals = {};
    var sum = 0;
    for (var i = 0; i < list.length; i++) {
      var b = CTX_BUCKET_OF[list[i].source];
      if (!b) continue;
      var chars = list[i].chars;
      if (typeof chars !== 'number' || !isFinite(chars) || chars <= 0) continue;
      totals[b.key] = (totals[b.key] || 0) + chars;
      sum += chars;
    }
    if (sum <= 0) return null;
    var out = [];
    for (var j = 0; j < CTX_BUCKETS.length; j++) {
      var bucket = CTX_BUCKETS[j];
      var n = totals[bucket.key] || 0;
      if (n <= 0) continue;
      out.push({
        key: bucket.key,
        label: I18N[bucket.label],
        color: bucket.color,
        share: n / sum,
        sharePct: fmtShare(n / sum),
      });
    }
    return out.length ? out : null;
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
    var tpsVal = el('span', 'v zsb-activity-speed', sp ? Math.round(sp.v) + ' tok/s' : '--');
    if (sp) {
      var ramp = rampApi();
      tpsVal.style.color = (ramp && ramp.speedColor(sp.v)) || ''; // 与底部速度数字同色阶
      if (sp.est) tpsVal.className += ' zsb-est'; // 估算态呼吸，与底部数字一致
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

  // 速度趋势曲线图（SVG 自绘，零依赖）：
  // - 纵轴按本轮样本动态归一（非固定色阶域），保证小速度样本也有可见波动；
  // - 顶/中虚线网格带峰值与半值标注，底部实线基线；
  // - 描边沿 x 用各采样点 speedColor 取色的 linearGradient，数据点圆点同色，
  //   颜色语义与底部状态条速度数字一致；
  // - 右上角标注当前速度（末点值，同色），左上角标注峰值；
  // - ramp 缺失 → 全图退 currentColor 中性灰（与数字降级口径一致）。
  // 坐标按构建时容器像素宽定点：弹层打开期间宽度稳定，重开弹层即重算。
  var TREND_H = 64; // 与 .zsb-trend 高度一致

  /**
   * 单调三次贝塞尔路径（Fritsch–Carlson 切线钳制）。
   * 逐点折线在 60px 高度里读起来是锯齿；直接套 Catmull-Rom 又会在峰谷处过冲，
   * 越过峰值网格线甚至画出负速度。切线按相邻斜率的加权调和均值取，段间保持单调，
   * 曲线只在相邻样本之间弯，不会凭空造出数据里没有的峰。
   */
  function smoothPath(px, py) {
    var n = px.length;
    var d = 'M' + px[0].toFixed(1) + ',' + py[0].toFixed(1);
    if (n === 2) return d + ' L' + px[1].toFixed(1) + ',' + py[1].toFixed(1);
    var dx = [];
    var dy = [];
    var slope = [];
    for (var i = 0; i < n - 1; i++) {
      dx[i] = px[i + 1] - px[i];
      dy[i] = py[i + 1] - py[i];
      slope[i] = dx[i] === 0 ? 0 : dy[i] / dx[i];
    }
    var t = [];
    t[0] = slope[0];
    t[n - 1] = slope[n - 2];
    for (var j = 1; j < n - 1; j++) {
      if (slope[j - 1] * slope[j] <= 0) {
        t[j] = 0; // 极值点切线取平，峰谷处不过冲
      } else {
        var w1 = 2 * dx[j] + dx[j - 1];
        var w2 = dx[j] + 2 * dx[j - 1];
        t[j] = (w1 + w2) / (w1 / slope[j - 1] + w2 / slope[j]);
      }
    }
    for (var k = 0; k < n - 1; k++) {
      var h = dx[k];
      d +=
        ' C' + (px[k] + h / 3).toFixed(1) + ',' + (py[k] + (t[k] * h) / 3).toFixed(1) +
        ' ' + (px[k + 1] - h / 3).toFixed(1) + ',' + (py[k + 1] - (t[k + 1] * h) / 3).toFixed(1) +
        ' ' + px[k + 1].toFixed(1) + ',' + py[k + 1].toFixed(1);
    }
    return d;
  }

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
    var yTop = y(vpeak > 0 ? vpeak : 0); // 全零时顶网格线落基线，与曲线重合
    var yMid = y(vmax / 2);
    var yBase = y(0);
    parts.push('<line class="zsb-tgrid dash" x1="0" y1="' + yTop.toFixed(1) + '" x2="' + w + '" y2="' + yTop.toFixed(1) + '"/>');
    parts.push('<line class="zsb-tgrid dash" x1="0" y1="' + yMid.toFixed(1) + '" x2="' + w + '" y2="' + yMid.toFixed(1) + '"/>');
    parts.push('<line class="zsb-tgrid base" x1="0" y1="' + yBase.toFixed(1) + '" x2="' + w + '" y2="' + yBase.toFixed(1) + '"/>');
    parts.push('<text class="zsb-tick" x="0" y="' + (yTop - 3).toFixed(1) + '">' + fmtTok(vpeak) + '</text>');
    parts.push('<text class="zsb-tick" x="0" y="' + (yMid - 3).toFixed(1) + '">' + fmtTok(vmax / 2) + '</text>');
    if (n > 1) {
      var px = [];
      var py = [];
      for (var j = 0; j < n; j++) {
        px.push(x(j));
        py.push(y(vals[j]));
      }
      var curve = smoothPath(px, py);
      parts.push('<path d="' + curve + ' L' + px[n - 1].toFixed(1) + ',' + yBase.toFixed(1) +
        ' L' + px[0].toFixed(1) + ',' + yBase.toFixed(1) + ' Z" fill="url(#zsb-trend-grad)" opacity="0.14"/>');
      parts.push('<path d="' + curve + '" fill="none" stroke="url(#zsb-trend-grad)" stroke-width="1.5" stroke-linecap="round"/>');
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

  // Usage 详情：输入/输出/缓存读/缓存写 + 缓存占比 + 今日用量 + 工具调用明细。无任何费用字样。
  function buildUsageDetail(pop) {
    var s = state.session || {};
    var t = s.tokens || {};
    sectionTitle(pop, I18N.usageTitle);
    pop.appendChild(row(I18N.inputTok, fmtTok(t.input)));
    pop.appendChild(row(I18N.outputTok, fmtTok(t.output)));
    pop.appendChild(row(I18N.cacheRead, fmtTok(t.cacheRead)));
    pop.appendChild(row(I18N.cacheWrite, fmtTok(t.cacheWrite)));
    pop.appendChild(row(I18N.cacheShare, fmtPct(s.cacheHitRate)));

    var todaySec = buildTodaySection();
    if (todaySec) pop.appendChild(todaySec);

    var tools = s.tools || {};
    var toolSec = el('div', 'zsb-sec');
    toolSec.appendChild(el('div', 'zsb-pop-title', I18N.toolsTitle));
    var toolList = Array.isArray(tools.list) ? tools.list : [];
    if (!toolList.length) {
      toolSec.appendChild(el('div', 'k', I18N.noData));
    } else {
      toolList.forEach(function (item) {
        var name = item.name || '--';
        var r = el('div', 'zsb-row');
        var k = el('span', 'zsb-tool-k', name);
        k.title = name;
        r.appendChild(k);
        r.appendChild(el('span', 'v', (item.count || 0) + I18N.toolCallsUnit + ' · ' + fmtMsNum(item.durationMs)));
        toolSec.appendChild(r);
      });
    }
    pop.appendChild(toolSec);
  }

  // 今日用量（全库今日 completed 行，来自内核帧的 today 块）：token 总量与平均缓存率。
  // 内核帧缺席（如直接推送 aggregate 的兼容路径）时整组不渲染——宁可少显示，不拿零值冒充。
  function buildTodaySection() {
    var d = state.today;
    if (!d || typeof d !== 'object') return null;
    var input = finNum(d.input);
    var output = finNum(d.output);
    var cacheRead = finNum(d.cache_read);
    // 总量优先取库侧的 computed_total_tokens（与 input+output 同值，实库校验 0 条不符）；
    // 该列缺失时用两项相加兜底，不因此整组降级。
    var total = finNum(d.total);
    if (total == null && input != null && output != null) total = input + output;
    var sec = el('div', 'zsb-sec');
    sec.appendChild(el('div', 'zsb-pop-title', I18N.todayTitle));
    sec.appendChild(row(I18N.todayTokens, total != null ? fmtTok(total) : '--'));
    sec.appendChild(row(I18N.todayCacheRate,
      input != null && cacheRead != null && input > 0 ? fmtPct(cacheRead / input) : '--'));
    return sec;
  }

  // ================= 子代理面板（R2/R3/R4） =================

  // 两种视图共用一次 openPop 的容器：subView.mode 决定画列表还是详情。
  // 详情目标按 key 现查最新数据，不缓存条目对象——子代理在详情页打开期间继续跑，
  // 缓存会让读数冻结在打开那一刻。
  var subView = { mode: 'list', key: null };

  function subItems() {
    var s = state.session || {};
    var sub = s.subagent || {};
    return Array.isArray(sub.list) ? sub.list : [];
  }

  function buildSubagentPanel(pop) {
    if (subView.mode === 'detail') {
      var target = null;
      var list = subItems();
      for (var i = 0; i < list.length; i++) {
        if (list[i].key === subView.key) { target = list[i]; break; }
      }
      if (target) {
        buildSubagentDetail(pop, target);
        return;
      }
      subView.mode = 'list'; // 目标已消失（列表被刷新掉）：退回列表，不留空详情
      subView.key = null;
    }
    var items = subItems();
    var running = items.filter(function (it) { return it.status === 'running'; });
    var done = items.filter(function (it) { return it.status !== 'running'; });
    sectionTitle(pop, I18N.subagents);
    if (!running.length && !done.length) {
      pop.appendChild(el('div', 'k', I18N.noData));
      return;
    }
    appendSubGroup(pop, I18N.subRunning, running);
    appendSubGroup(pop, I18N.subDone, done);
  }

  // 空组不渲染标题：没有运行中条目时不留一个空壳分组（AC9）
  function appendSubGroup(pop, title, items) {
    if (!items.length) return;
    var sec = el('div', 'zsb-subgroup');
    sec.appendChild(el('div', 'zsb-pop-title', title + ' · ' + items.length));
    items.forEach(function (it) {
      var btn = el('button', 'zsb-subrow');
      btn.type = 'button';
      btn.dataset.subkey = it.key;
      var dot = el('i', 'zsb-subdot');
      // 运行中行用绿色（静止；呼吸只留在状态条的绿点上，避免面板内多点同闪）
      if (it.status === 'running') dot.className = 'zsb-subdot zsb-live';
      btn.appendChild(dot);
      // 无类型（历史 Agent 回执缺 agentId、标题前缀也对不上）时用子会话尾号兜底：
      // 任务名无从得知，但至少让几条条目彼此可区分，不显示成一串同名占位。
      var nmText = it.type || shortId(it.childSessionId) || I18N.subUnnamed;
      var nm = el('span', 'nm', nmText);
      nm.title = it.type || '';
      btn.appendChild(nm);
      var tk = el('span', 'tk', it.task || '');
      if (it.task) tk.title = it.task;
      btn.appendChild(tk);
      btn.appendChild(el('span', 'go', '›'));
      sec.appendChild(btn);
    });
    pop.appendChild(sec);
  }

  function buildSubagentDetail(pop, it) {
    var back = el('button', 'zsb-back');
    back.type = 'button';
    back.dataset.act = 'sub-back';
    back.appendChild(el('span', null, '‹ ' + I18N.subBack));
    pop.appendChild(back);
    sectionTitle(pop, it.type || I18N.subUnnamed);
    pop.appendChild(row(I18N.subStatus, subStatusText(it.status)));
    if (it.task) pop.appendChild(row(I18N.subTask, it.task));
    pop.appendChild(row(I18N.subStarted, fmtClock(it.startedAt)));
    pop.appendChild(row(I18N.subDuration, fmtDur(it.durationMs)));
    // 运行中的 token 尚未落库，显示 0 会读成"没产出"。改显占位，不伪造读数。
    if (it.status === 'running') {
      pop.appendChild(row(I18N.subRequests, '--'));
      pop.appendChild(row(I18N.subOutput, '--'));
      pop.appendChild(row(I18N.subTps, '--'));
      return;
    }
    pop.appendChild(row(I18N.subRequests, String(it.requests || 0)));
    pop.appendChild(row(I18N.subInput, fmtTok(it.inputTokens)));
    pop.appendChild(row(I18N.subOutput, fmtTok(it.outputTokens)));
    pop.appendChild(row(I18N.subCache, fmtTok(it.cacheReadTokens) + ' / ' + fmtTok(it.cacheWriteTokens)));
    pop.appendChild(row(I18N.subTps, it.tpsAvg != null ? Math.round(it.tpsAvg) + ' tok/s' : '--'));
  }

  function subStatusText(st) {
    if (st === 'running') return I18N.subStRunning;
    if (st === 'error') return I18N.subStError;
    if (st === 'cancelled') return I18N.subStCancelled;
    return I18N.subStDone;
  }

  // 子会话 id 尾段（后 6 位）：sess_subagent_agent_<uuid> 的 uuid 尾部足够区分同会话内的条目
  function shortId(id) {
    if (typeof id !== 'string' || !id) return '';
    var tail = id.slice(-6);
    return tail.length === 6 ? '#' + tail : '';
  }

  // 起止时间只到分钟：详情页关心"什么时候跑的"，秒级精度对子代理没有意义
  function fmtClock(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '--';
    var d = new Date(ms);
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
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
    var un = el('button', 'zsb-mi danger');
    un.type = 'button';
    un.dataset.act = 'uninstall';
    un.appendChild(el('span', null, I18N.menuUninstall));
    menu.appendChild(un);
    menu.appendChild(el('hr', 'zsb-hr'));
    menu.appendChild(el('div', 'zsb-menu-ver', 'v' + VERSION));
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
    if (act === 'sub-back') {
      subView.mode = 'list';
      subView.key = null;
      openPop('subagent'); // 重建列表；数据取最新，不恢复打开前的缓存
      return;
    }
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

  // 显示 = 用户开关 AND 该 pill 有理由显示。两类"无理由"整只不占位：
  // - 上下文 pill：宿主锚点缺席或占用为 0（R4/R10）
  // - 子代理 pill：本会话还没出现过任何子代理（subSeen 为会话内粘滞标志，
  //   出现过一次后不再回退，避免子代理连续派发时 pill 闪进闪出）
  function renderVisibility() {
    if (!ui) return;
    ['activity', 'usage', 'context', 'subagent', 'gear'].forEach(function (n) {
      var hasReason = n !== 'context' || !!state.context;
      if (n === 'subagent') hasReason = state.subSeen;
      var on = state.visible[n] && hasReason;
      ui.pills[n].style.display = on ? '' : 'none';
    });
  }

  // 自适应降级：容器收窄时按档位隐去次要内容（CSS 见 .zsb-bar[data-fit~="n"]），
  // 保证状态条永远单行、不折行、不横向溢出。
  // 溢出判定不用 bar.scrollWidth：弹层 .zsb-pop 是 bar 的绝对定位子节点，
  // 窄容器下它会外溢，把 scrollWidth 撑大，误判为"读数放不下"。
  // 改为量首个可见 pill 左缘到末个可见 pill 右缘的跨度——恰等于 pill 总宽 + 实际 gap。
  var FIT_MAX = 7;
  var fitLevel = 0;
  var fitAvail = -1; // 上次自适应时的可用宽度；-1 = 尚未测过
  var fitSpan = -1; // 上次收敛后的内容跨度（稳态判据）

  function applyFit(level) {
    if (!ui || !ui.bar || level === fitLevel) return;
    fitLevel = level;
    if (level > 0) {
      var tiers = [];
      for (var i = 1; i <= level; i++) tiers.push(i);
      ui.bar.setAttribute('data-fit', tiers.join(' '));
    } else {
      ui.bar.removeAttribute('data-fit');
    }
  }

  function pillsSpan() {
    var bar = ui.bar;
    var first = null;
    var last = null;
    for (var i = 0; i < bar.children.length; i++) {
      var n = bar.children[i];
      if (!n.dataset || !n.dataset.zsbPill) continue; // 跳过弹层
      if (!(n.offsetWidth > 0)) continue; // 已被档位或用户开关隐去
      if (!first) first = n;
      last = n;
    }
    if (!first) return 0;
    return last.offsetLeft + last.offsetWidth - first.offsetLeft;
  }

  // 每轮 render 与尺寸变化时调。稳态（宽度与内容跨度都没变）直接返回，零属性写入、零抖动；
  // 变窄立刻升到刚好放得下；变宽或内容变短（重置统计、子代理收工）才重新收敛。
  function fitBar() {
    if (!ui || !ui.bar) return;
    var avail = ui.bar.clientWidth;
    if (!avail) return; // 未挂载或宿主隐藏：测不出宽度，保持现状
    if (avail === fitAvail && pillsSpan() === fitSpan) return;
    if (avail !== fitAvail) {
      fitAvail = avail;
      applyFit(0); // 宽度变了：从头重算，不沿用旧档位
    }
    // 升档：溢出就一路升到刚好放下（单调收敛，最多 FIT_MAX 次布局读）；+1 容忍亚像素取整
    while (fitLevel < FIT_MAX && pillsSpan() > avail + 1) applyFit(fitLevel + 1);
    // 降档回补：只探一档，探完仍溢出就立刻回滚（原档必不溢出，故稳定不抖）
    if (fitLevel > 0) {
      applyFit(fitLevel - 1);
      if (pillsSpan() > avail + 1) applyFit(fitLevel + 1);
    }
    fitSpan = pillsSpan(); // 记录收敛后的跨度，作为下一轮的稳态判据
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

  // 会话身份：内核在 detail 上带 mine（本窗口焦点会话 id）；非包裹路径没有该字段。
  // 用于判定"这条数据属于哪个会话"，是粘滞标志的归属依据——同一窗格换会话时
  // paneId 不变、unmountBar 不触发，只能靠它识别切换。
  function sessionOwner(detail) {
    if (!detail || typeof detail !== 'object') return null;
    return typeof detail.mine === 'string' && detail.mine ? detail.mine : null;
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
    if (popMode === 'activity') {
      var detailSpeed = ui.pop.querySelector('.zsb-activity-speed');
      if (detailSpeed) {
        detailSpeed.textContent = sp ? Math.round(sp.v) + ' tok/s' : '--';
        detailSpeed.style.color = ui.speedNum.style.color;
        detailSpeed.className = 'v zsb-activity-speed' + (sp && sp.est ? ' zsb-est' : '');
      }
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

    // ---- 子代理双态（R5）：运行中 = 绿点 · 速度；闲 = 会话累计（中性灰）----
    // subSeen 只在这里翻真：会话内第一次看到子代理时显形，之后不再隐藏（见 renderVisibility）。
    // 翻假只发生在换会话（session 事件里重置），那里同步调了 renderVisibility，
    // 所以这里只需处理翻真这一次，避免每秒重排。
    var subRows = Array.isArray(sub.list) ? sub.list : [];
    if (!state.subSeen && (sub.activeCount > 0 || subRows.length > 0)) {
      state.subSeen = true;
      renderVisibility();
    }
    var subRunning = sub.activeCount > 0;
    var subSpeedOk = subRunning && typeof sub.activeTokPerSec === 'number' && isFinite(sub.activeTokPerSec);
    // 绿点是运行态的二元指示，不呼吸数字本身（呼吸挂点上，对齐原插件 zupulse）
    ui.subLive.style.display = subRunning ? '' : 'none';
    ui.subLive.className = subRunning ? 'zsb-livedot zsb-pulse' : 'zsb-livedot';
    if (subSpeedOk) {
      ui.subSpeed.style.display = '';
      ui.subSpeed.textContent = Math.round(sub.activeTokPerSec) + ' tok/s';
      var rampNow = rampApi();
      // ramp 缺失 → 速度退中性灰（继承基色）
      ui.subSpeed.style.color = rampNow ? rampNow.speedColor(sub.activeTokPerSec) || '' : '';
    } else {
      ui.subSpeed.style.display = 'none';
      ui.subSpeed.style.color = '';
    }
    // 运行态只出绿点 + 速度，不显示活跃数；速度尚不可得时用占位符说明"在跑但读数未到"。
    // 空 span 会占掉一个 flex gap，所以用 display 切换而不是只清空文本。
    var labelText = subRunning ? (subSpeedOk ? '' : '--') : fmtTok(sub.sessionTokens || 0);
    ui.subLabel.textContent = labelText;
    ui.subLabel.style.display = labelText ? '' : 'none';
    ui.pills.subagent.title = subRunning ? I18N.subRunningTip : I18N.subIdleTip;

    // 降级档位依赖"子代理是否在跑"（运行态比闲置态更值得保留），与数据同轮刷新，
    // 避免先按旧状态选档、下一轮才改，造成一次可见的跳动。
    if (ui.bar.dataset.sub !== (subRunning ? 'run' : 'idle')) {
      ui.bar.dataset.sub = subRunning ? 'run' : 'idle';
    }
    fitBar();
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

  // 上下文来源明细：走桥的窄投影 getContextBreakdown（只取 used/size/breakdown），
  // 不碰 getSessionSnapshot——后者是整份会话深拷贝，长会话点一次弹层要拷掉全部消息行。
  // 旧桥无此方法时退回快照路径，两条路都读不到 → null（退单色条，不猜分项）。
  function readContextBreakdown() {
    var bridge = W.__ZCODE_STATUSBAR_BRIDGE__;
    if (!bridge) return null;
    if (typeof bridge.getContextBreakdown === 'function') {
      var r = null;
      try {
        r = bridge.getContextBreakdown();
      } catch (e) {
        return null;
      }
      return r && Array.isArray(r.breakdown) && r.breakdown.length ? r.breakdown : null;
    }
    if (typeof bridge.getSessionSnapshot !== 'function') return null;
    var snap = null;
    try {
      snap = bridge.getSessionSnapshot();
    } catch (e) {
      return null;
    }
    var usage = snap && snap.snapshot && snap.snapshot.usage;
    var cw = usage && usage.contextWindow;
    return cw && Array.isArray(cw.breakdown) && cw.breakdown.length ? cw.breakdown : null;
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

  // 诊断：维护 window.__ZCODE_STATUSBAR_DIAG 供内核 diag 轮询落盘（inject-main 每 16 次推送收集）。
  // 只读快照、永不抛错——诊断通道自身故障不得影响状态条主流程。
  function syncDiag(stage) {
    try {
      W.__ZCODE_STATUSBAR_DIAG = {
        version: VERSION,
        stage: stage || null,
        ts: Date.now(),
        mounted: !!state.mounted,
        paneId: state.paneId || null,
        lastError: state.lastError || null,
        hasBridge: !!W.__ZCODE_STATUSBAR_BRIDGE__,
        hasRamp: !!(W.__ZCODE_STATUSBAR_RAMP__ || W.ZCodeStatusbarRamp),
        hasTurn: !!W.__ZCODE_STATUSBAR_TURN__,
        hasSession: !!state.session,
        sessionReal: !!state.mounted,
      };
    } catch (e) {
      /* 诊断写入失败静默 */
    }
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
    if (resizeObserver) {
      try {
        resizeObserver.disconnect();
      } catch (e) {
        /* 已断开：忽略 */
      }
      resizeObserver = null;
    }
    if (ui && ui.bar && ui.bar.parentNode) ui.bar.parentNode.removeChild(ui.bar);
    ui = null;
    mountAnchor = null;
    state.mounted = false;
    state.context = null;
    state.breakdown = null; // 换会话必须丢弃上一会话的来源明细（防串数）
    // 换会话必须丢弃粘滞标志：否则上个会话的子代理会让新会话的 pill 一直占位（防串数）
    state.subSeen = false;
    subView.mode = 'list';
    subView.key = null;
    fitLevel = 0; // 新 bar 从最高档位重新自适应
    fitAvail = -1; // 宽度缓存失效，下次必测
    fitSpan = -1;
    syncDiag('unmounted');
  }
  function attemptMount() {
    var ident = identityOk();
    if (!ident) {
      unmountBar();
      state.lastError = '身份不可确认（桥缺失或 paneId 为空）';
      syncDiag('identity-failed');
      return;
    }

    var anchor = findAnchor();
    if (!anchor) {
      unmountBar();
      state.lastError = '未找到输入框挂载锚点';
      syncDiag('anchor-missing');
      return;
    }

    // 换会话不重注入脚本（SPA 内切换），所以每轮都要核对：当前会话是否真实、宿主是否换了 DOM。
    var stale = state.mounted && (anchor !== mountAnchor || !D.contains(ui && ui.bar));
    if (stale) unmountBar();
    if (state.mounted) {
      state.paneId = ident.paneId;
      state.lastError = null;
      syncDiag('mounted');
      return;
    }

    if (!isRealSession(anchor)) {
      state.lastError = null; // 首页/新建任务：正常状态，不是错误
      syncDiag('draft-session');
      return;
    }

    var mounted = mountBar(anchor);
    if (!mounted) {
      state.lastError = '挂载点插入失败';
      syncDiag('mount-failed');
      return;
    }
    ui = mounted;
    mountAnchor = anchor;
    state.mounted = true;
    state.paneId = ident.paneId;
    state.lastError = null;
    syncDiag('mounted');
    // turn 事件可能早于本文件事件绑定：挂载时补读全局最新样本
    if (W.__ZCODE_STATUSBAR_TURN__ && typeof W.__ZCODE_STATUSBAR_TURN__ === 'object') {
      state.turn = W.__ZCODE_STATUSBAR_TURN__;
    }
    applyThemeVars(ui.bar);
    renderVisibility();
    render();
    bindBarEvents();
    watchResize();
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
    ui.pills.subagent.addEventListener('click', function () {
      subView.mode = 'list'; // 每次从 pill 进入都回到列表，不停在上次的详情
      subView.key = null;
      togglePop('subagent');
    });
    ui.pills.gear.addEventListener('click', function () {
      togglePop('menu');
    });

    // 菜单动作（事件委托）
    ui.pop.addEventListener('click', function (ev) {
      // 子代理行：进详情（key 由行上的 data-subkey 携带，现查最新条目）
      var subRow = ev.target && ev.target.closest ? ev.target.closest('[data-subkey]') : null;
      if (subRow && ui.pop.contains(subRow)) {
        subView.mode = 'detail';
        subView.key = subRow.dataset.subkey;
        openPop('subagent');
        return;
      }
      var mi = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (mi && ui.pop.contains(mi)) onMenuAction(mi.dataset.act, mi.dataset.pill);
    });
  }

  // 容器宽度变化（拖窗口、收窄侧边栏、切分屏）即时重算档位，不等下一次 1s 渲染。
  // 观察对象是 bar 的父容器而非 bar 本身：bar 宽度由父容器决定，自身尺寸监听在部分宿主里不触发。
  // 宿主无 ResizeObserver（或测试桩无此全局）时降级为 1s 渲染周期内的 fitBar，功能不缺。
  function watchResize() {
    if (resizeObserver || !ui || !ui.bar) return;
    var RO = W.ResizeObserver;
    if (typeof RO !== 'function') return;
    var target = ui.bar.parentElement;
    if (!target) return;
    try {
      resizeObserver = new RO(function () {
        fitBar();
      });
      resizeObserver.observe(target);
    } catch (e) {
      resizeObserver = null; // 观察失败：退回周期渲染路径
    }
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
      var owner = sessionOwner(ev && ev.detail);
      // 换了会话就直接丢上一会话的粘滞标志与面板位置：同一窗格切会话时 paneId 不变、
      // unmountBar 不触发，只靠卸载路径重置会让上一个会话的子代理把新会话的 pill 一直点亮。
      // 重置后必须立刻刷可见性：render() 只在 subSeen 翻真时动 display，翻假没人管。
      if (owner && owner !== state.sessionOwner) {
        state.sessionOwner = owner;
        state.subSeen = false;
        subView.mode = 'list';
        subView.key = null;
        renderVisibility();
      }
      var d = normalizeSession(ev && ev.detail);
      // 今日用量属于全库口径（内核帧顶层 today），与会话 aggregate 各自独立：
      // 任一到达都存，缺席时保留上一次成功帧的读数而不是抹成零。
      var day = ev && ev.detail && ev.detail.today;
      if (day && typeof day === 'object' && !Array.isArray(day)) state.today = day;
      if (d) {
        state.session = d;
        state.sessionAt = Date.now();
        render();
        refreshSubagentPop(); // 面板开着时随之刷新（子代理读数每秒都在变）
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
  syncDiag('boot');
})();
