/* zcode-statusbar 注入 loader v1（主进程；移植自 zcode-token-usage-statusbar inject-main.cjs 并裁剪）。
 * 由 patch_install.py 在 app.asar 入口尾部追加一行 import 引入。
 * 职责：
 *   1) 向每个主窗口按序注入渲染端内核与 UI：statusbar-bridge.js（静态桥 shim）→
 *      turn-stats.js（速度采样）→ ramp.js（色阶）→ statusbar.js（状态条 UI）；
 *      前者在先：桥须在消费方读取前就位。mtime 热更新，语法预检后重注入。
 *   2) 触发式数据泵：fs.watch 监听 db 目录，db.sqlite/-wal 一有写入（去抖 300ms）就
 *      经常驻 python（zusage.py serve，stdin/stdout 行协议）查询并推送；限频
 *      config.activity_min_ms（默认 1500ms），到点自动补拉；完全空闲时零进程零轮询，
 *      仅兜底心跳（config.heartbeat_ms，默认 30s）防文件事件丢失。响应经
 *      session-stats.cjs（若已部署）聚合后以 CustomEvent "zcode-statusbar:session"
 *      推送到各窗口（design §9 数据契约）。
 *   3) 主进程子系统：plugin-updater.cjs（Release 自动更新 + 热换）、engine-patch.cjs
 *      （登记 SHA 才打的引擎补丁）、macOS 更新 ZIP 预注入（pending_zip_patch.py）、
 *      ⚙ 面板状态广播与动作白名单（pollPluginRequests 轮询 + 事件桥接 shim）、relaunch。
 *   4) 待重启登记/销账（runtime_lock.py --ack-restart + _hotLoadedAt 热换证据）。
 * 任何失败只打日志，不影响客户端。
 *
 * 相对原插件的裁剪（PRD R11 / Out of Scope / design §1 裁剪清单，均为删除项）：
 *   - 额度客户端（quota-client.cjs）、模型拉取（model-puller.cjs）、quota-secrets、
 *     quota providers IPC 与全部 quota/restart_notice 开关——零凭据、零供应商请求；
 *   - Git 状态旁路（Git 栏）；逐问速率行（turn-text 富文本旁路、answer_rate_line）；
 *   - 远端会话路由（windowWorkspaces/windowTasks/remoteEvidence/remoteSids/
 *     pendingSids、scopes 请求形）——查询请求固定 {sids:[...]}（zusage.py 的
 *     scopes 为可选字段，向后兼容）；多窗口会话隔离由 IPC 焦点会话 + 静态桥承担；
 *   - prompt-submit 相关的一切本就不在主进程（R11）。
 * 保留原语义：常驻泵回退/退避、诊断 diag-<n>.json（install_monitor 依赖其确认注入
 * 生效）、热换销账（_hotLoadedAt）、pending ZIP 预注入、引擎补丁、Release 更新器。
 * 偏差记录：session-stats 聚合缝按 design §9 预留——payload 的 recent 行数组传入
 * aggregate()，聚合结果与原始行一起推送；session-stats.cjs 未部署时仅推原始行。 */
"use strict";
const path = require("path");
const fs = require("fs");
const { spawn, execFile } = require("child_process");
const { createHash } = require("crypto");
const { app, BrowserWindow, webContents } = require("electron");
const { fileURLToPath } = require("url");

const HERE = __dirname;   // 本 loader 被 asar 注入行按绝对 file:// URL import，__dirname 即运行时目录
const CONFIG = path.join(HERE, "config.json");
const BRIDGE_SHIM = path.join(HERE, "statusbar-bridge.js");
const TURN_STATS = path.join(HERE, "turn-stats.js");
const RAMP = path.join(HERE, "ramp.js");
const STATUSBAR = path.join(HERE, "statusbar.js");
const SESSION_STATS = path.join(HERE, "session-stats.cjs");
/* ⚙ 事件→请求桥接 shim（与注入链一同进入渲染端）：状态条以 window 事件表达齿轮动作
 * （CONTRACT.md §3），内核侧的执行通道是 pollPluginRequests 轮询 __ZCODE_STATUSBAR_REQUESTS__
 * 队列——本 shim 把事件翻译进队列，两侧机制就此打通。reset-session 不入队：它是纯渲染端
 * 行为（本地清显示，无内核持久态可清）。 */
const EVENT_SHIM = '(function(){if(window.__ZCODE_STATUSBAR_EVT_SHIM__)return;window.__ZCODE_STATUSBAR_EVT_SHIM__=true;' +
  'function fwd(ev,action){window.addEventListener(ev,function(){' +
  'var q=window.__ZCODE_STATUSBAR_REQUESTS__||(window.__ZCODE_STATUSBAR_REQUESTS__=[]);' +
  'q.push({action:action,requestId:"evt-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,8)});});}' +
  'fwd("zcode-statusbar:refresh","refresh");' +
  'fwd("zcode-statusbar:check-update","check");' +
  'fwd("zcode-statusbar:uninstall","uninstall");})();\n';
const ZUSAGE = path.join(HERE, "zusage.py");
const LOG = (...a) => console.error("[zcode-statusbar]", ...a);
const loadedHashes = { _loadedAt: Date.now() - process.uptime() * 1000 };
for (const name of ["inject-main.cjs", "plugin-updater.cjs", "plugin-release.cjs", "plugin-storage.cjs", "engine-patch.cjs", "statusbar-bridge.js", "turn-stats.js", "ramp.js", "statusbar.js", "session-stats.cjs", "zusage.py"]) {
  try { loadedHashes[name] = createHash("sha256").update(fs.readFileSync(path.join(HERE, name))).digest("hex"); }
  catch (e) { LOG("startup fingerprint unavailable:", name, e.message); }
}
function acknowledgeRestart(done) {
  const helper = path.join(HERE, "runtime_lock.py");
  const finish = () => {
    if (typeof done === "function") { try { done(); } catch (e) { LOG("restart ack callback failed:", e.message); } }
  };
  if (!fs.existsSync(helper)) { finish(); return Promise.resolve(); }
  return new Promise((resolve) => {
    execFile(readCfg().python_path || (process.platform === "win32" ? "python" : "python3"),
      [helper, "--ack-restart", HERE, JSON.stringify(loadedHashes)],
      { windowsHide: true, timeout: 15000, maxBuffer: 65536 },
      (error) => {
        if (error) LOG("restart acknowledgement failed:", error.message);
        // 可选回调——热替换完成后等销账落定再广播状态（红点即时撤下）。
        finish();
        resolve();
      });
  });
}

function readCfg() {
  const c = { resident: true };
  try { Object.assign(c, JSON.parse(fs.readFileSync(CONFIG, "utf8"))); } catch (e) { }
  /* 缺省/空值统一按平台定解释器：Windows 无 python3，macOS/Linux 未必有 python */
  c.python_path = c.python_path || (process.platform === "win32" ? "python" : "python3");
  return c;
}

/* config.json 内容缓存：热更新定时器每 2s 触发，改为 stat mtime 判变化后才读文件 */
let cfgMtime = 0;
let cfgCache = null;
function readCfgCached() {
  let m = 0;
  try { m = fs.statSync(CONFIG).mtimeMs; } catch (e) { }
  if (!cfgCache || m !== cfgMtime) {
    cfgMtime = m;
    cfgCache = readCfg();
  }
  return cfgCache;
}

/* 渲染端注入源 + 热更新：mtime 变了就重注入（复位守卫）。载入前用 new Function 校验
 * 语法，避免把写到一半的文件载入页面。注入顺序固定：bridge → turn-stats → ramp →
 * statusbar（依赖方向）；全部可缺失（statusbar 侧文件未同步时降级为只注入内核 shim），
 * 任一 mtime 变化即整体重注入。 */
const RENDERER_ASSETS = [
  { file: BRIDGE_SHIM, key: "bridge" },
  { file: TURN_STATS, key: "turnStats" },
  { file: RAMP, key: "ramp" },
  { file: STATUSBAR, key: "statusbar" },
];
const rendererSrc = { bridge: "", turnStats: "", ramp: "", statusbar: "" };
const rendererMtime = { bridge: 0, turnStats: 0, ramp: 0, statusbar: 0 };
function loadValidatedAsset(file) {
  try {
    const m = fs.statSync(file).mtimeMs;
    const src = fs.readFileSync(file, "utf8");
    new Function(src);
    return { mtime: m, src: src };
  } catch (e) { return null; }
}
{
  for (const asset of RENDERER_ASSETS) {
    const loaded = loadValidatedAsset(asset.file);
    if (loaded) { rendererSrc[asset.key] = loaded.src; rendererMtime[asset.key] = loaded.mtime; }
    else LOG(asset.key + " asset missing (degraded)");
  }
}

function hotReloadIfChanged() {
  let changed = false;
  for (const asset of RENDERER_ASSETS) {
    let m = 0;
    try { m = fs.statSync(asset.file).mtimeMs; } catch (e) { continue; }
    if (m === rendererMtime[asset.key]) continue;   // mtime 未变：不读文件（每 2s 心跳零读盘）
    const loaded = loadValidatedAsset(asset.file);
    if (!loaded) continue;       // 语法没写完：保留旧 mtime，下轮重试
    rendererMtime[asset.key] = loaded.mtime;
    rendererSrc[asset.key] = loaded.src;
    changed = true;
  }
  if (!changed) return;
  LOG("renderer assets changed, hot-reloading");
  for (const wc of webContents.getAllWebContents()) {
    if (!isMainWindowState(wc) || wc.isDestroyed()) continue;
    injectStatusbar(wc, true);
  }
}

function isMainWindowState(wc) {
  try { return wc.getType() === "window"; } catch (e) { return false; }
}

function isLocalHostPage(wc) {   // 与 pollPluginRequests 同口径：只信宿主本地 file: 页面上的渲染端全局
  try {
    const url = wc.getURL();
    if (!url.startsWith("file:")) return false;
    const relative = path.relative(process.resourcesPath, fileURLToPath(url));
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  } catch (e) { return false; }
}

/* 会话快照推送（design §9 数据契约）：CustomEvent "zcode-statusbar:session"，
 * detail 携带 { mine, aggregate?, ...payload }。按窗口注入 mine（本窗口焦点会话 id，
 * 可为空串）；U+2028/2029 转义防 JSON 字面量语法风险。 */
function pushSession(wc, payload) {
  if (!isMainWindowState(wc) || wc.isDestroyed() || !isLocalHostPage(wc) || !payload || typeof payload !== "object") return;
  const detail = Object.assign({}, payload, {
    ...(activeSid.has(wc.id) ? { mine: activeSid.get(wc.id) || "" } : {}),
  });
  const js = `window.dispatchEvent(new CustomEvent("zcode-statusbar:session",{detail:${JSON.stringify(detail).replace(/[\u2028\u2029]/g, (c) => c === "\u2028" ? "\\u2028" : "\\u2029")}}))`;
  wc.executeJavaScript(js, true).catch(() => { });
}

/* 每窗口焦点会话：客户端渲染端把 activeTaskId 经此通道同步给主进程（宿主自带通道），
 * 追加监听器不影响原有处理。值为 "" = 窗口已同步但当前无会话。 */
const IPC_ACTIVE_SID = "zcode:sync-active-task-session";
const activeSid = new Map();   // webContents.id → 会话 id 或 ""
function trustedSender(e) {
  try {
    if (!e || !e.sender || e.sender.isDestroyed() || !isMainWindowState(e.sender)) return false;
    const url = e.sender.getURL();
    if (!url.startsWith("file:")) return false;
    const relative = path.relative(process.resourcesPath, fileURLToPath(url));
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  } catch (e) { return false; }
}
try {
  const { ipcMain } = require("electron");
  ipcMain.on(IPC_ACTIVE_SID, (e, sid) => {
    if (!trustedSender(e)) return;   // 同源宿主通道同款门控：非主窗口/外部页面不得改写本窗会话归属
    const s = typeof sid === "string" ? sid.trim() : "";
    const val = s && s.length <= 255 && /^[A-Za-z0-9_-]+$/.test(s) ? s : "";
    const prev = activeSid.get(e.sender.id);
    activeSid.set(e.sender.id, val);
    if (prev !== val) scheduleRetry(800);   // 会话切换/窗口就绪：尽快按新会话拉一次（限频器仍生效）
  });
} catch (e) { LOG("ipc hook failed:", e.message); }

/* db 活动戳：db.sqlite / -wal / -shm 的最新 mtime。WAL 模式下写入主要落在 -wal。 */
let DB_DIR = null;
function dbDir() {
  if (!DB_DIR) DB_DIR = path.join(app.getPath("home"), ".zcode", "cli", "db");
  return DB_DIR;
}
function dbStamp() {
  let m = 0;
  const dir = dbDir();
  for (const f of ["db.sqlite", "db.sqlite-wal", "db.sqlite-shm"]) {
    try { m = Math.max(m, fs.statSync(path.join(dir, f)).mtimeMs); } catch (e) { }
  }
  return m;
}

let busy = false;
let pushCount = 0;
let lastSpawn = 0;    // 上次发起查询时刻（activity_min_ms 限频用）
let lastStamp = 0;    // 上次拉取时的 db mtime（去重：无新写入不拉）
let lastWants = "";   // 上次查询用的会话 id 集合（变化即拉，防"会话切了但 db 没写入"滞留旧数据）
let lastRequest = { sids: [] };

/* ---------- 常驻查询进程：zusage.py serve，stdin 请求行 / stdout 响应行 ---------- */
let pyRes = null;        // { proc, buf, waiters, born }
let pyFail = 0;          // 启动 30s 内退出次数（>=3 判不稳定，回退一次性 spawn）
let pyBackoff = 1000;
let residentRestartTimer = 0, residentIdleTimer = 0;
let shuttingDown = false;
function hasWindows() {
  return webContents.getAllWebContents().some((wc) => isMainWindowState(wc) && !wc.isDestroyed());
}
function residentAllowed() {
  return !shuttingDown && readCfgCached().resident !== false && pyFail < 3 && hasWindows();
}
function stopResident(restart = false) {
  clearTimeout(residentRestartTimer);
  clearTimeout(residentIdleTimer);
  const state = pyRes;
  if (!state) return;
  state.intentional = true;
  state.restart = restart;
  try { state.proc.kill(); } catch (e) { }
  state.finish();
}
function armResidentIdle() {
  clearTimeout(residentIdleTimer);
  if (pyRes) residentIdleTimer = setTimeout(() => stopResident(), 30000);
}
function startResident() {
  if (pyRes || !residentAllowed()) return;
  let proc;
  try { proc = spawn(readCfgCached().python_path, [ZUSAGE, "serve"], { windowsHide: true }); }
  catch (e) { LOG("resident spawn failed:", e.message); pyFail++; return; }
  const state = { proc, buf: "", waiters: [], born: Date.now(), finished: false, intentional: false, restart: false };
  pyRes = state;
  LOG("resident python starting");
  state.finish = () => {
    if (state.finished) return;
    state.finished = true;
    if (pyRes === state) pyRes = null;
    clearTimeout(residentIdleTimer);
    const pending = state.waiters;
    state.waiters = [];
    pending.forEach((w) => w(null));
    if (state.intentional) {
      if (state.restart && residentAllowed()) residentRestartTimer = setTimeout(startResident, 0);
      return;
    }
    if (Date.now() - state.born < 30000) {
      pyFail++;
      if (pyFail >= 3) { LOG("resident unstable (3 early exits), fallback to one-shot spawn"); return; }
      if (residentAllowed()) residentRestartTimer = setTimeout(startResident, pyBackoff);
      pyBackoff = Math.min(pyBackoff * 2, 30000);
    } else {
      pyFail = 0;
      pyBackoff = 1000;
      if (residentAllowed()) residentRestartTimer = setTimeout(startResident, 0);
    }
  };
  const fail = (e) => {
    LOG("resident failed:", e.message);
    try { proc.kill(); } catch (e2) { }
    state.finish();
  };
  proc.on("error", fail);
  proc.stdin.on("error", fail);
  proc.on("close", state.finish);
  proc.stdout.on("data", (d) => {
    if (state.finished) return;
    state.buf += d.toString("utf8");
    if (state.buf.length > 8 * 1024 * 1024) {   // 无 newline 的异常输出不再无界累积
      LOG("resident stdout overflow, dropping buffer");
      state.buf = "";
      return;
    }
    let i;
    while ((i = state.buf.indexOf("\n")) >= 0) {
      const line = state.buf.slice(0, i);
      state.buf = state.buf.slice(i + 1);
      const w = state.waiters.shift();
      if (!w) continue;
      let payload = null;
      try { payload = JSON.parse(line); } catch (e) { }
      w(payload);
    }
  });
  proc.stderr.on("data", () => { });
  armResidentIdle();
}

/* 统一查询入口：resident 可用走 JSON 行协议，否则一次性 spawn。
 * 每笔请求只结算一次；error 载荷只留日志（无远端重试链——远端路由已裁剪）。 */
function runQuery(request) {
  busy = true;
  let settled = false;
  const done = (payload) => {
    if (settled) return;
    settled = true;
    busy = false;
    if (payload && !payload.error) {
      if (!shuttingDown && hasWindows()) handlePayload(payload);
    }
    armResidentIdle();
  };
  const line = JSON.stringify(request);
  if (residentAllowed()) {
    clearTimeout(residentRestartTimer);
    if (!pyRes) startResident();
    if (pyRes && pyRes.proc.stdin.writable) {
      clearTimeout(residentIdleTimer);
      const state = pyRes;
      const waiter = (payload) => { clearTimeout(timer); done(payload); };
      const timer = setTimeout(() => {
        LOG("resident query timeout, restarting it");
        stopResident(true);
      }, 15000);
      state.waiters.push(waiter);
      try {
        state.proc.stdin.write(line + "\n", (error) => {
          if (error && !state.finished) {
            LOG("resident write failed:", error.message);
            try { state.proc.kill(); } catch (e) { }
            state.finish();
          }
        });
      } catch (e) {
        LOG("resident write failed:", e.message);
        try { state.proc.kill(); } catch (e2) { }
        state.finish();
      }
      return;
    }
  }
  legacySpawn(line, done);
}

/* 回退路径：一次性 spawn `zusage.py json <request>`，close/timeout 共用单次结算。 */
function legacySpawn(line, done) {
  const args = [ZUSAGE, "json"];
  if (line) args.push(line);
  let py;
  try { py = spawn(readCfgCached().python_path, args, { windowsHide: true }); }
  catch (e) { LOG("spawn failed:", e.message); done(null); return; }
  let out = "", finished = false;   // out 上限 8MB：异常输出止血（15s 超时兜底前不无界累积）
  const finish = (payload) => {
    if (finished) return;
    finished = true;
    clearTimeout(killTimer);
    done(payload);
  };
  const killTimer = setTimeout(() => {
    LOG("query timeout, killing");
    try { py.kill(); } catch (e) { }
    finish(null);
  }, 15000);
  py.stdout.on("data", (d) => { if (out.length < 8 * 1024 * 1024) out += d; });
  py.stderr.on("data", () => { });
  py.on("error", (e) => { LOG("spawn failed:", e.message); finish(null); });
  py.on("close", () => {
    let payload = null;
    try { payload = JSON.parse(out); } catch (e) { }
    finish(payload);
  });
}

/* 触发式拉取：db 有新写入（mtime 变化）才查询；限频不满足时安排补拉，
 * 保证限频窗口结束后最后一笔写入的数据一定被取到。 */
let retryTimer = 0;
function scheduleRetry(ms) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(maybeSpawn, ms);
}
let collectingWants = false;
function maybeSpawn() {
  if (shuttingDown) return;
  if (!hasWindows()) {
    clearTimeout(retryTimer);
    activeSid.clear();
    lastWants = "";
    lastStamp = 0;
    stopResident();
    return;
  }
  if (busy || collectingWants) { scheduleRetry(300); return; }
  const st = dbStamp();
  const cfg = readCfgCached();
  const wait = Math.max(300, cfg.activity_min_ms | 0 || 1500);
  /* 查询会话集合：主进程 IPC 映射（应用自己上报的焦点会话）为准；全部窗口都已同步时
   * 不做页面求值（活跃期省 executeJavaScript）。请求形固定 {sids:[...]}（远端 scopes
   * 已裁剪，zusage.py 对缺省 scopes 只查本地，向后兼容）。 */
  const wcs = webContents.getAllWebContents().filter((wc) => isMainWindowState(wc) && !wc.isDestroyed());
  if (!wcs.length) return;
  const liveIds = new Set(wcs.map((wc) => wc.id));
  for (const id of activeSid.keys()) if (!liveIds.has(id)) activeSid.delete(id);
  const allSynced = wcs.every((wc) => activeSid.has(wc.id));
  if (!allSynced) {
    collectingWants = true;
    const readWantsJs = '(function(){var a=window.__ZCODE_STATUSBAR_WANTS__;if(!a||!a.length){a=[]}return JSON.stringify({s:a})})()';
    Promise.all(wcs.map((wc) => Promise.race([
      Promise.resolve().then(() => wc.executeJavaScript(readWantsJs, true)).catch(() => ""),
      new Promise((r) => setTimeout(() => r(""), 1000)),
    ])))
      .then((vals) => {
        if (shuttingDown || !hasWindows()) { stopResident(); return; }
        const sids = [];
        const add = (sid) => {
          if (typeof sid !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(sid)) return;
          if (!sids.includes(sid)) sids.push(sid);
        };
        wcs.forEach((wc, i) => {
          let parsed = {};
          try { parsed = JSON.parse(vals[i] || "{}"); } catch (e) { }
          const wants = Array.isArray(parsed.s) ? parsed.s : [];
          for (const sid of wants) add(sid);
          if (activeSid.get(wc.id)) add(activeSid.get(wc.id));
        });
        finishCollect(sids);
      })
      .catch(() => { })
      .finally(() => { collectingWants = false; });
  } else {
    const sids = [];
    for (const wc of wcs) {
      const sid = activeSid.get(wc.id);
      if (sid && !sids.includes(sid)) sids.push(sid);
    }
    finishCollect(sids);
  }

  function finishCollect(sids) {
    sids.sort();
    const key = JSON.stringify(sids);
    if (key === lastWants && st && st === lastStamp) return;
    const now = Date.now();
    if (now - lastSpawn < wait) { scheduleRetry(wait - (now - lastSpawn) + 50); return; }
    lastWants = key;
    lastRequest = { sids };
    if (st) lastStamp = st;
    lastSpawn = now;
    runQuery({ sids });
  }
}

/* 监听 db 目录：WAL/主库一有写入立刻（去抖 300ms）触发拉取；完全空闲时零进程零轮询 */
let debounceTimer = 0;
let dbWatcher = null;
function watchDb() {
  if (dbWatcher) return;
  try {
    dbWatcher = fs.watch(dbDir(), (ev, f) => {
      if (f && !/db\.sqlite/.test(f)) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(maybeSpawn, 300);
    });
    dbWatcher.on("error", () => {
      LOG("db watcher error, re-arm in 5s");
      try { dbWatcher.close(); } catch (e) { }
      dbWatcher = null;
      setTimeout(watchDb, 5000);
    });
    LOG("watching", dbDir());
  } catch (e) {
    LOG("fs.watch failed, retry in 5s:", e.message);
    setTimeout(watchDb, 5000);
  }
}

/* 热更新检查（stat mtime，开销可忽略）；config.hot_reload=false 可关闭（改文件需重启
 * ZCode 才生效）。zusage.py 变化时重启常驻进程。间隔启动时定死：显式 true 是开发档
 * 2s，缺省 5s 收敛常驻 stat 开销；false 仍每次 tick 现读、即时禁用。 */
let zusageMtime = 0;
let zusageMtimeKnown = false;
const hotTickMs = readCfg().hot_reload === true ? 2000 : 5000;
setInterval(() => {
  const cfg = readCfgCached();
  if (!residentAllowed()) stopResident();
  if (cfg.hot_reload === false) return;
  hotReloadIfChanged();
  hotReloadMainModules();
  try {
    const m = fs.statSync(ZUSAGE).mtimeMs;
    if (zusageMtimeKnown && m !== zusageMtime && pyRes) {
      LOG("zusage.py changed, restarting resident python");
      killResidentForUpgrade();
    }
    zusageMtime = m;
    zusageMtimeKnown = true;
  } catch (e) { }
}, hotTickMs);
setInterval(maybeSpawn, Math.max(10000, readCfg().heartbeat_ms | 0 || 30000));   // 兜底心跳：防文件事件丢失
watchDb();
maybeSpawn();   // 启动先拉一次

let pluginUpdater = null;
let enginePatcher = null;
let sessionStats = null;   // design §9 聚合缝：statusbar 侧模块，未部署时仅推原始行
let pluginRequestBusy = false;
let lastGoodPayload = null;
function loadSessionStats() {
  // require 失败（未部署/语法错）保留 null：泵与推送照常，聚合缝留待热换补齐
  try { sessionStats = require("./session-stats.cjs"); } catch (e) { sessionStats = null; }
  return sessionStats;
}

function handlePayload(payload) {
  // serve 的 error 是查询失败，不是空快照；保留最后成功数据显示。
  if (!payload || typeof payload !== "object" || payload.error) return;
  lastGoodPayload = payload;
  /* 聚合缝（design §9）：session-stats.cjs 已部署时把 recent 行数组喂给 aggregate()
   *（契约 aggregate(rows) -> { sessionAvgTokPerSec, cacheHitRate, totalTokens,
   * subagent }），聚合结果随事件推送；模块缺席或抛错时仅推原始行（fail-open）。
   * R10 防串数：逐窗口只聚合本窗口焦点会话（IPC 上报的 activeSid）的行；焦点未同步的
   * 窗口给空聚合——宁可少算，不推别的窗口的会话。
   * 分桶键优先 parentSid：子代理行的 sid 是子会话 id（sess_subagent_*），与父会话永远
   * 不等，只按 sid 分桶会让子代理整批落空。parentSid 缺失时回落 sid，旧投影行为不变。 */
  const rows = Array.isArray(payload.recent) ? payload.recent : (Array.isArray(payload.rows) ? payload.rows : []);
  const bySid = new Map();
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const key = typeof r.parentSid === "string" && r.parentSid
      ? r.parentSid
      : (typeof r.sid === "string" ? r.sid : "");
    if (!bySid.has(key)) bySid.set(key, []);
    bySid.get(key).push(r);
  }
  const stats = sessionStats || loadSessionStats();
  const aggregateRows = stats && typeof stats.aggregate === "function"
    ? (list) => {
        try { return stats.aggregate(list); }
        catch (e) { LOG("session aggregate failed:", e.message); return null; }
      }
    : null;
  for (const wc of webContents.getAllWebContents()) {
    if (!isMainWindowState(wc) || wc.isDestroyed()) continue;
    const frame = Object.assign({}, payload);
    if (aggregateRows) {
      const mine = activeSid.has(wc.id) ? (activeSid.get(wc.id) || "") : null;
      const windowRows = mine ? (bySid.get(mine) || []) : [];
      const agg = aggregateRows(windowRows);
      if (agg) frame.aggregate = agg;
    }
    pushSession(wc, frame);
  }
  // 定位诊断：每 ~15 次拉取收集每个窗口各自的桥/引擎状态，写 diag-<n>.json
  // （多窗口互不覆盖，install_monitor 靠它确认注入已加载）。config.diag 显式 false 关闭。
  if (++pushCount % 15 === 1 && readCfgCached().diag !== false) {
    let idx = 0;
    for (const wc of webContents.getAllWebContents()) {
      if (!isMainWindowState(wc) || wc.isDestroyed()) continue;
      const file = path.join(HERE, "diag-" + idx + ".json");
      idx++;
      wc.executeJavaScript("JSON.stringify(window.__ZCODE_STATUSBAR_DIAG||null)", true)
        .then((s) => {
          if (s && s !== "null") {
            try {
              const obj = JSON.parse(s);
              obj.pump = {
                version: 1,
                resident: !!pyRes,
                activeMap: Array.from(activeSid.entries()).slice(0, 12),
                wants: lastWants,
              };
              obj.enginePatch = enginePatcher ? enginePatcher.status() : null;
              fs.writeFileSync(file, JSON.stringify(obj));
            } catch (e2) {
              try { fs.writeFileSync(file, s); } catch (e) { }
            }
          }
        })
        .catch(() => { });
    }
  }
}

function killResidentForUpgrade() { stopResident(true); }

let pluginUpdaterInitBusy = false;
/* ack 必须先于更新器初始化：createUpdater 会在创建瞬间快照 marker 状态并作为首帧
 * 推送——若 ack 后跑，已清除的「待重启」会在重启后的第一分钟被误报。 */
acknowledgeRestart(() => { loadSessionStats(); });
/* 初始化提炼为可重入函数——同名热替换循环复用同一套装配代码重建实例。 */
function initPluginUpdater() {
  try {
    const prevState = pluginUpdater && typeof pluginUpdater.status === "function" ? pluginUpdater.status() : null;
    const { createUpdater } = require("./plugin-updater.cjs");
    pluginUpdater = createUpdater({ runtime: HERE, home: app.getPath("home"),
      resourcesPath: process.resourcesPath, executable: process.execPath,
      initialState: prevState,
      notify: (state) => webContents.getAllWebContents().forEach((wc) => pushPluginState(wc, state)),
      /* 安装同步落盘且 busy 释放后先把变更模块热换进内存并销账 marker，再让更新器
       * 发布终态——已热加载的模块不再要求重启，⚙ 红点零闪烁。 */
      onRuntimeSynced: async () => { await hotReloadMainModules(); },
    });
    return pluginUpdater;
  } catch (e) {
    pluginUpdater = null;
    delete loadedHashes["plugin-updater.cjs"];
    delete loadedHashes["plugin-release.cjs"];
    delete loadedHashes["plugin-storage.cjs"];
    LOG("plugin updater unavailable:", e.message);
    return null;
  }
}

/* 引擎补丁（登记 SHA 才打，语义与原插件一致）：开→补丁；关→还原。加载失败只少该功能。 */
function initEnginePatcher() {
  try {
    const { createEnginePatcher } = require("./engine-patch.cjs");
    enginePatcher = createEnginePatcher({
      runtime: HERE,
      resourcesPath: process.resourcesPath,
      appVersion: app.getVersion(),
      isEnabled: () => readCfgCached().auto_compact_patch !== false,   // 缺省开，显式 false 关闭
      log: (...a) => LOG("[engine-patch]", ...a),
    });
    enginePatcher.syncStartup();   // 幂等：已 applied 且引擎未变时只重读字节设状态，不重复写盘
    return enginePatcher;
  } catch (e) {
    enginePatcher = null;
    LOG("engine patcher unavailable:", e.message);
    return null;
  }
}

function pushPluginState(wc, state) {
  if (!isMainWindowState(wc) || wc.isDestroyed() || !isLocalHostPage(wc)) return;
  /* enginePatch 随插件状态一起推送：⚙ 面板/诊断的真值都来自运行时 */
  const payload = { ...state, enginePatch: enginePatcher ? enginePatcher.status() : null, feedbackVersion: 1,
    relaunchSupported: true };   // 能力标记与 relaunch 分支同文件，缺标记=旧主进程必然没有该动作分支
  const js = "window.dispatchEvent(new CustomEvent(\"zcode-statusbar:plugin\",{detail:" +
    JSON.stringify(payload).replace(/[\u2028\u2029]/g, (c) => c === "\u2028" ? "\\u2028" : "\\u2029") + "}))";
  wc.executeJavaScript(js, true).catch(() => { });
}
function broadcastPluginState() {
  const base = pluginUpdater ? pluginUpdater.status() : {};
  webContents.getAllWebContents().forEach((wc) => pushPluginState(wc, base));
}

/* ---------- macOS 更新包预注入（pending zip）：Squirrel.Mac 整包替换前抢先把
 * 更新 zip 内 app.asar 补上注入行，更新重启即生效。Windows 走 NSIS 且安装包带
 * Authenticode 验签，不适用。空闲零成本：无候选 zip 时不 spawn；失败退避。 */
let pendingZipWatcher = null;
let pendingZipTimer = null;
let pendingZipDebounce = 0;
let pendingZipBusy = false;
let pendingZipFails = 0;
let pendingZipLastFailAt = 0;
function updaterCacheDirName() {
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, "app-update.yml"), "utf8");
    const m = yml.match(/^updaterCacheDirName:\s*(.+?)\s*$/m);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  } catch (e) { }
  return "@zcodedesktop-updater";   // 官方 app-update.yml 实测值；读不到时兜底
}
function pendingZipDir() {
  return path.join(app.getPath("home"), "Library", "Caches", updaterCacheDirName(), "pending");
}
function pendingZipCandidate() {
  const infoFile = path.join(pendingZipDir(), "update-info.json");
  let info = null;
  try { info = JSON.parse(fs.readFileSync(infoFile, "utf8")); } catch (e) { return null; }
  let names = [];
  try { names = fs.readdirSync(pendingZipDir()); } catch (e) { return null; }
  for (const name of names) {
    const m = /^ZCode-(\d+(?:\.\d+){1,3})-mac-(?:arm64|x64)\.zip$/.exec(name);
    if (!m || (info.fileName && info.fileName !== name)) continue;
    const have = String(app.getVersion() || "").split(".").map((n) => parseInt(n, 10) || 0);
    const next = m[1].split(".").map((n) => parseInt(n, 10) || 0);
    let newer = false;
    for (let i = 0; i < Math.max(have.length, next.length); i++) {
      const d = (next[i] || 0) - (have[i] || 0);
      if (d) { newer = d > 0; break; }
    }
    if (!newer) continue;   // 只补未来版本：当前版本的残留缓存留给差量下载用
    return path.join(pendingZipDir(), name);
  }
  return null;
}
function patchPendingZip() {
  if (pendingZipBusy || shuttingDown) return;
  if (process.platform !== "darwin" || readCfgCached().pending_zip_patch === false) return;
  if (pendingZipFails >= 3 && Date.now() - pendingZipLastFailAt < 600000) return;   // 失败退避 10 分钟
  const zip = pendingZipCandidate();
  if (!zip) return;
  const resourcesAsar = path.join(process.resourcesPath, "app.asar");
  if (!fs.existsSync(resourcesAsar)) return;
  pendingZipBusy = true;
  const py = spawn(readCfgCached().python_path,
    [path.join(HERE, "pending_zip_patch.py"), "--zip", zip, "--asar", resourcesAsar, "--runtime", HERE],
    { windowsHide: true, timeout: 900000 });   // 看门狗：300MB zip 慢盘余量取 15 分钟
  let out = "";
  py.stdout.on("data", (d) => { out += d; if (out.length > 4000) out = out.slice(-4000); });
  py.stderr.on("data", (d) => { out += d; if (out.length > 4000) out = out.slice(-4000); });
  py.on("error", (e) => {
    pendingZipBusy = false; pendingZipFails++; pendingZipLastFailAt = Date.now();
    LOG("pending zip patch spawn failed:", e.message);
  });
  py.on("close", (code) => {
    pendingZipBusy = false;
    if (code === 0) { pendingZipFails = 0; LOG("pending update zip patched:", path.basename(zip)); return; }
    pendingZipFails++; pendingZipLastFailAt = Date.now();
    LOG("pending zip patch failed (exit " + code + "):", out.trim().slice(-400));
  });
}
{
  if (process.platform === "darwin" && readCfg().pending_zip_patch !== false) {
    pendingZipTimer = setInterval(patchPendingZip, 60000);   // 兜底轮询：fs.watch 事件不保证送达
    try {
      pendingZipWatcher = fs.watch(pendingZipDir(), () => {
        clearTimeout(pendingZipDebounce);
        pendingZipDebounce = setTimeout(patchPendingZip, 3000);   // 下载完成（zip+json 落盘）的去抖
      });
      pendingZipWatcher.on("error", () => {
        try { pendingZipWatcher.close(); } catch (e) { }
        pendingZipWatcher = null;   // 缓存目录被清后由 60s 兜底轮询接管
      });
    } catch (e) { /* 目录尚不存在：等 60s 兜底轮询 */ }
  }
}

/* ---------- 更新日志：⚙ 更新页按需拉取当前 Release 渠道的发布说明。独立 try：
 * 拉取/缓存失败只少日志卡片，不拖垮更新链。渲染进程只传 version/force，flavor 与
 * repository 一律取自主进程读到的注册渠道。缓存落运行目录 plugin-notes-cache.json。 */
let releaseNotes = null;
function initReleaseNotes() {
  try {
    const { createNotesService, createNotesCache } = require("./plugin-release.cjs");
    releaseNotes = createNotesService({ cache: createNotesCache({ file: path.join(HERE, "plugin-notes-cache.json") }) });
    return releaseNotes;
  } catch (e) {
    releaseNotes = null;
    LOG("release notes unavailable:", e.message);
    return null;
  }
}

/* ---------- 主进程子模块热替换（更新除 inject-main.cjs 引导壳以外的主进程模块后
 * 零重启生效、零红点闪烁）。按 mtime 轮询热换：语法预检 → 清 require.cache → 重建
 * 实例 → 刷新 loadedHashes 与 _hotLoadedAt → acknowledgeRestart 销账 → 广播状态。
 * inject-main.cjs 自身不在热换面内：它持有 ipcMain 注册与常驻泵，只能随客户端完全
 * 重启生效。 */
const HOT_MAIN_MODULES = ["plugin-storage.cjs", "plugin-release.cjs", "plugin-updater.cjs", "engine-patch.cjs", "session-stats.cjs"];
const hotModuleMtimes = {};
for (const name of HOT_MAIN_MODULES) {
  try { hotModuleMtimes[name] = fs.statSync(path.join(HERE, name)).mtimeMs; } catch (e) { }
}
let hotMainBusy = false;
function hotReloadMainModules() {
  if (hotMainBusy) return Promise.resolve(false);   // 与在途热替换/销账互斥：顺延下一 tick
  hotMainBusy = true;
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  let result;
  try {
    result = hotReloadMainModulesOnce();
  } catch (e) {
    LOG("hot reload failed:", (e && e.message) || e);
    hotMainBusy = false;
    done(false);
    return finished;
  }
  Promise.resolve(result)
    .then((v) => done(v), (e) => { LOG("hot reload failed:", (e && e.message) || e); done(false); })
    .then(() => { hotMainBusy = false; });
  return finished;
}
function hotReloadMainModulesOnce() {
  const changed = [], mtimes = {};
  for (const name of HOT_MAIN_MODULES) {
    let m = 0;
    try { m = fs.statSync(path.join(HERE, name)).mtimeMs; } catch (e) { continue; }
    if (hotModuleMtimes[name] === m) continue;
    changed.push(name);
    mtimes[name] = m;   // 启动时缺文件后来补齐的也会进 changed：热换路径顺带恢复缺失的子系统
  }
  if (!changed.length) return Promise.resolve(false);
  const sources = {};
  for (const name of changed) {
    try {
      const src = fs.readFileSync(path.join(HERE, name), "utf8");
      new Function(src);   // 语法预检：半截文件/独占锁留到下轮重试
      sources[name] = src;
    } catch (e) {
      LOG("hot reload skipped (unreadable or invalid):", name, (e && e.message) || e);
      return Promise.resolve(false);   // 不更新 mtime：保留旧实例，下轮重试
    }
  }
  if (changed.some((n) => n === "plugin-updater.cjs" || n === "plugin-release.cjs" || n === "plugin-storage.cjs") &&
      pluginUpdater && pluginUpdater.status().busy) {
    LOG("hot reload deferred: updater busy");   // 旧更新链还持有旧实例闭包，等 busy=false 再换
    return Promise.resolve(false);
  }
  const purge = (name) => { try { delete require.cache[require.resolve("./" + name)]; } catch (e) { } };
  const ok = {};   // 模块名 -> 重建是否成功：销账与 mtime 只认成功换入者
  if (changed.includes("session-stats.cjs")) {
    purge("session-stats.cjs");
    sessionStats = null;
    ok["session-stats.cjs"] = !!loadSessionStats();
  }
  if (changed.includes("engine-patch.cjs")) {
    purge("engine-patch.cjs");
    ok["engine-patch.cjs"] = !!initEnginePatcher();
  }
  const updaterGroup = changed.filter((n) => n === "plugin-updater.cjs" || n === "plugin-release.cjs" || n === "plugin-storage.cjs");
  if (updaterGroup.length) {
    // updater 顶层解构捕获 release/storage 导出（CJS 加载期绑定）：单改依赖时也必须
    // 让 updater 自身重求值，否则新实例仍绑旧导出。
    for (const name of ["plugin-updater.cjs", ...updaterGroup]) purge(name);
    ok["plugin-release.cjs"] = !!initReleaseNotes();
    ok["plugin-updater.cjs"] = !!initPluginUpdater();
    if (updaterGroup.includes("plugin-storage.cjs")) ok["plugin-storage.cjs"] = ok["plugin-updater.cjs"];
  }
  const succeeded = changed.filter((name) => ok[name]);
  const failed = changed.filter((name) => !ok[name]);
  if (!succeeded.length) {
    LOG("hot reload failed, keeping old instances:", failed.join(", "));
    return Promise.resolve(false);
  }
  const hotAt = Date.now();
  const prevHot = Object.assign({}, loadedHashes._hotLoadedAt);
  for (const key of Object.keys(prevHot)) {
    if (!failed.includes(key)) prevHot[key] = hotAt;   // 多轮热换：刷新既有条目的证据戳
  }
  for (const name of succeeded) {
    hotModuleMtimes[name] = mtimes[name];
    try { loadedHashes[name] = createHash("sha256").update(sources[name]).digest("hex"); } catch (e) { }
    prevHot[name] = hotAt;
  }
  loadedHashes._hotLoadedAt = prevHot;
  LOG("hot reloaded main modules:", succeeded.join(", ") + (failed.length ? "（失败保留待重启: " + failed.join(", ") + "）" : ""));
  if (failed.length) {
    // 部分失败：不销账（marker 原样保留，重启兜底仍在），只广播让 UI 用上已换入的模块
    broadcastPluginState();
    return Promise.resolve(true);
  }
  // 销账先行完成再广播：runtime_lock ack_restart 凭 _hotLoadedAt+digest 清除已热加载条目。
  return acknowledgeRestart(() => {
    if (pluginUpdater && typeof pluginUpdater.noteRuntimeAcked === "function") {
      try { pluginUpdater.noteRuntimeAcked(); } catch (e) { }
    }
    broadcastPluginState();
  }).then(() => true);
}

function deliverPluginResult(wc, requestId, result) {
  /* 返回已处理的 promise（true=渲染端已执行回调）；调用方忽略返回值，行为不变。 */
  if (!wc || wc.isDestroyed() || !isLocalHostPage(wc) || typeof requestId !== "string" || requestId.length > 120) return Promise.resolve(false);
  const js = "window.__ZCODE_STATUSBAR_RESULT && window.__ZCODE_STATUSBAR_RESULT(" + JSON.stringify(Object.assign({ id: requestId }, result || {})) + ")";
  return wc.executeJavaScript(js, true).then(() => true).catch(() => false);
}

/* 引擎补丁开关（⚙ 面板可选）：写 config.json 的 auto_compact_patch，并即时打补丁/还原。 */
async function setAutoCompactPatch(enabled, wc, requestId) {
  try {
    const { updateConfig } = require("./plugin-updater.cjs");
    await updateConfig(HERE, { auto_compact_patch: enabled }, readCfgCached().python_path || (process.platform === "win32" ? "python" : "python3"));
    cfgCache = null;
    if (enginePatcher) { if (enabled) enginePatcher.ensure(); else enginePatcher.restore(); }
    broadcastPluginState();
    deliverPluginResult(wc, requestId, { ok: true, enginePatch: enginePatcher ? enginePatcher.status() : null });
  } catch (e) {
    LOG("auto_compact_patch toggle failed:", e.message);
    deliverPluginResult(wc, requestId, { ok: false, error: e.message });
  }
}
/* 阈值数值：白名单归一后写运行目录 autocompact.json。引擎 hook 每轮决策读该文件——
 * 写完下一轮即生效，无需重启。 */
function handleAutoCompactConfig(req, wc) {
  const respond = (result) => deliverPluginResult(wc, req.requestId, result);
  if (!enginePatcher) { respond({ ok: false, error: "engine patcher unavailable; fully restart ZCode to load it" }); return; }
  try {
    const config = enginePatcher.writeConfig(String(req.mode || ""), req.value);
    broadcastPluginState();
    respond({ ok: true, config });
  } catch (e) {
    respond({ ok: false, error: e.message });
  }
}

/* 渠道门控：Release 渠道取本渠道 Release；market（源码）渠道取注册仓库的同号 Release，
 * 响应带 verified:false 由状态条标注「参考/未核实」；local 无仓库身份回 unsupported-channel。 */
async function handleReleaseNotesRequest(req, wc) {
  const respond = (result) => deliverPluginResult(wc, req.requestId, result);
  try {
    if (!releaseNotes) { respond({ ok: false, reason: "unsupported" }); return; }
    let channel = null;
    try { channel = require("./plugin-release.cjs").readChannel(app.getPath("home")); } catch (e) { channel = null; }
    if (!channel || channel.kind === "local" || !channel.repository) { respond({ ok: false, reason: "unsupported-channel" }); return; }
    const flavor = channel.flavor === "gitcode" ? "gitcode" : "github";
    const repository = channel.repository || "";
    const verified = channel.kind === "release";
    if (req.action === "release-notes-list") {
      const result = await releaseNotes.getList({ flavor, repository, force: req.force === true });
      respond(result.ok ? { ...result, verified } : result);
      return;
    }
    const version = typeof req.version === "string" ? req.version.slice(0, 32) : "";
    const result = await releaseNotes.getNotes({ flavor, repository, version, force: req.force === true });
    respond(result.ok ? { ...result, verified } : result);
  } catch (e) {
    LOG("release notes request failed:", e.message);
    respond({ ok: false, reason: "error", message: String((e && e.message) || e).slice(0, 300) });
  }
}

/* ⚙ 立即刷新：清去重键强制重查（db mtime 未变也拉一次），并广播插件状态真值。 */
function forceRefresh(wc, requestId) {
  try { lastWants = ""; lastStamp = 0; } catch (e) { }
  maybeSpawn();
  pushPluginState(wc, pluginUpdater ? pluginUpdater.status() : {});
  deliverPluginResult(wc, requestId, { ok: true });
}

let uninstallBusy = false;
/* ⚙ 卸载：统一入口 uninstall.py（引擎 restore + ZIP 撤销 + asar 剥离 + 保留配置/统计），
 * 成功后重启 ZCode 卸净本进程内已注入代码；失败不重启，回执带错误摘要供齿轮提示。 */
function runUninstallAndRelaunch(wc, requestId) {
  if (uninstallBusy) { deliverPluginResult(wc, requestId, { ok: false, error: "uninstall in progress" }); return; }
  uninstallBusy = true;
  const py = readCfgCached().python_path || (process.platform === "win32" ? "python" : "python3");
  const asar = path.join(process.resourcesPath, "app.asar");
  execFile(py, [path.join(HERE, "uninstall.py"), "--runtime", HERE, "--asar", asar], { timeout: 120000 }, (err, stdout, stderr) => {
    uninstallBusy = false;
    if (err) {
      LOG("gear uninstall failed:", (err && err.message) || String(err));
      deliverPluginResult(wc, requestId, { ok: false, error: String((err && err.message) || err).slice(0, 200) + " " + String(stderr || "").slice(0, 200) });
      return;
    }
    LOG("gear uninstall done; relaunching");
    Promise.resolve(deliverPluginResult(wc, requestId, { ok: true })).then(() => {
      try {
        for (const win of BrowserWindow.getAllWindows()) {
          try { if (win.isVisible()) win.hide(); } catch (e2) { }
        }
        app.relaunch();
        app.quit();
      } catch (e2) { LOG("relaunch after uninstall failed:", e2.message); }
    });
  });
}

async function pollPluginRequests() {
  if (pluginRequestBusy) return;
  pluginRequestBusy = true;
  try {
    for (const wc of webContents.getAllWebContents()) {
      if (!isMainWindowState(wc) || wc.isDestroyed()) continue;
      // 仅在宿主本地窗口读取固定动作；外部网页不能触发插件更新或配置写入。
      const url = wc.getURL();
      if (!url.startsWith("file:")) continue;
      const local = fileURLToPath(url);
      const relative = path.relative(process.resourcesPath, local);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      const requests = await Promise.race([
        wc.executeJavaScript('(function(){var q=window.__ZCODE_STATUSBAR_REQUESTS__;return Array.isArray(q)?q.splice(0,8):[]})()', true),
        new Promise((resolve) => setTimeout(() => resolve([]), 1000)),
      ]);
      if (!Array.isArray(requests)) continue;
      for (const req of requests) {
        if (req && ["auto", "check", "update"].includes(req.action)) {
          if (pluginUpdater) pluginUpdater.request(req).catch((e) => LOG("plugin update action failed:", e.message));
        } else if (req && req.action === "refresh") {   // ⚙ 立即刷新：清去重键强制重查
          forceRefresh(wc, req.requestId);
        } else if (req && req.action === "uninstall") {   // ⚙ 卸载：统一 uninstall 入口 + 重启生效
          runUninstallAndRelaunch(wc, req.requestId);
        } else if (req && req.action === "autocompact-patch" && typeof req.enabled === "boolean") {
          setAutoCompactPatch(req.enabled, wc, req.requestId);
        } else if (req && req.action === "autocompact-config") {
          handleAutoCompactConfig(req, wc);
        } else if (req && (req.action === "release-notes" || req.action === "release-notes-list")) {   // ⚙ 更新日志
          handleReleaseNotesRequest(req, wc);
        } else if (req && req.action === "relaunch") {   // ⚙ 更新页「重启 ZCode」按钮（状态条已二次确认）
          if (pluginUpdater && pluginUpdater.status().busy) {   // 更新进行中拒绝重启：quit 会打断下载/安装
            deliverPluginResult(wc, req.requestId, { ok: false, error: "update in progress" });
          } else {
            // 回执送达（executeJavaScript 已在渲染端执行回调）后 30ms 即退出；真正的等待在
            // 宿主 app.quit 优雅退出链，插件侧不再叠加固定延迟；渲染端无响应时 800ms 硬兜底。
            let quitArmed = false;
            const unhideWindows = () => {
              try {
                for (const win of BrowserWindow.getAllWindows()) {
                  try { if (!win.isVisible()) win.show(); } catch (e2) { }
                }
              } catch (e2) { LOG("relaunch unhide windows failed:", e2.message); }
            };
            const quitNow = () => {
              if (quitArmed) return;
              quitArmed = true;
              try {
                for (const win of BrowserWindow.getAllWindows()) {
                  try { if (win.isVisible()) win.hide(); } catch (e2) { }
                }
              } catch (e2) { LOG("relaunch hide windows failed:", e2.message); }
              try { app.relaunch(); app.quit(); } catch (e) {
                LOG("relaunch failed:", e.message);
                unhideWindows();
              }
            };
            const quitFallback = setTimeout(quitNow, 800);
            const unhideSentinel = setTimeout(() => {
              if (!app.isQuitting && quitArmed) unhideWindows();
            }, 15000);
            if (unhideSentinel && typeof unhideSentinel.unref === "function") unhideSentinel.unref();
            Promise.resolve(deliverPluginResult(wc, req.requestId, { ok: true })).then(() => {
              clearTimeout(quitFallback);
              setTimeout(quitNow, 30);
            });
          }
        } else if (req && typeof req.requestId === "string") {   // 白名单外动作兜底回执——
          // 状态条热更/主进程冷加载的版本错位窗口里，未知动作不再静默丢弃。
          deliverPluginResult(wc, req.requestId, { ok: false, error: "unknown action: " + String(req.action).slice(0, 60) });
        }
      }
    }
  } catch (e) { LOG("plugin request poll failed:", e.message); }
  finally { pluginRequestBusy = false; }
}
setInterval(pollPluginRequests, 1000);
setInterval(() => { if (pluginUpdater) pluginUpdater.tick().catch((e) => LOG("plugin auto update:", e.message)); }, 60000);
if (pluginUpdater) pluginUpdater.tick().catch((e) => LOG("plugin auto update:", e.message));

function injectStatusbar(wc, reload = false) {
  if (!isMainWindowState(wc) || wc.isDestroyed() || !isLocalHostPage(wc)) return;   // 外部页面不注入
  const cleanup = '(function(){if(window.__ZCODE_STATUSBAR_DISPOSE__)window.__ZCODE_STATUSBAR_DISPOSE__();window.__ZCODE_STATUSBAR__=false;})();\n';
  /* 注入顺序固定：bridge → turn-stats → ramp → statusbar → 事件桥接 shim（各自幂等）。
   * 缺失的资产跳过（statusbar 侧文件未同步时降级为只注入内核 shim，DB 轮询链兜底）。 */
  const src = [rendererSrc.bridge, rendererSrc.turnStats, rendererSrc.ramp, rendererSrc.statusbar, EVENT_SHIM]
    .filter((s) => s).join("\n;\n");
  if (!src) return;
  wc.executeJavaScript((reload ? cleanup : "") + src, true).then(() => {
    /* 无条件推送：updater 不可用时也要让面板拿到状态真值 */
    pushPluginState(wc, pluginUpdater ? pluginUpdater.status() : {});
    /* 注入即补推最近一次成功快照：maybeSpawn 的去重在 wants/db mtime 均未变化时
     * 直接短路，新窗口/整页重载后若无新写入就没有下一次推送。 */
    if (lastGoodPayload) {
      pushSession(wc, lastGoodPayload);
    }
  }).catch(() => { });
}

const hook = (wc) => {
  if (!isMainWindowState(wc)) return;
  startResident();   // 首个主窗出现即预热常驻 python：与其后 ≤1s 的页面装载重叠，
                     // 省重启后首查的串行解释器启动；预热后无查询则随 30s 空闲自停回收。
  wc.on("destroyed", () => {
    activeSid.delete(wc.id);
    if (!hasWindows()) {
      clearTimeout(retryTimer);
      lastWants = "";
      lastStamp = 0;
      stopResident();
    }
  });
  /* dom-ready 即注入：did-finish-load 要等全部子资源结束才触发，重启后条晚出现数秒；
   * dom-ready 在 DOM 可用时到达，statusbar 自带输入框轮询等待。did-finish-load 保留
   * 兜底（SPA 内部导航后重新装载的情况）。 */
  wc.on("dom-ready", () => injectStatusbar(wc));
  wc.on("did-finish-load", () => injectStatusbar(wc));
  if (wc.isLoading()) return;
  injectStatusbar(wc);
};
app.on("web-contents-created", (e, wc) => hook(wc));
for (const wc of webContents.getAllWebContents()) hook(wc);

/* 测试接缝：vm 沙箱加载后取内部引用复现真实控制流；生产加载方（asar 动态 import）不用它。 */
if (typeof module === "object" && module && module.exports) {
  module.exports.__zcodeStatusbarTest = {
    handlePayload, maybeSpawn, runQuery, activeSid: () => activeSid,
    hotReloadMainModules,   // 热替换循环测试入口
    hotModuleState: () => ({ mtimes: { ...hotModuleMtimes }, busy: hotMainBusy, hashes: { ...loadedHashes } }),
    rendererAssets: () => ({ src: { ...rendererSrc }, mtime: { ...rendererMtime } }),
    injectStatusbar,
    pushSession,
  };
}

LOG("injected v1 (statusbar kernel: bridge/turn-stats/ramp/statusbar injection, resident zusage.py pump, session-stats aggregate seam, engine patch, pending zip patch, release updater + hot swap)");

app.on("before-quit", () => {
  shuttingDown = true;
  clearTimeout(retryTimer);
  clearTimeout(debounceTimer);
  clearTimeout(pendingZipDebounce);
  stopResident();
  if (dbWatcher) { try { dbWatcher.close(); } catch (e) { } dbWatcher = null; }
  if (pendingZipWatcher) { try { pendingZipWatcher.close(); } catch (e) { } pendingZipWatcher = null; }
  if (pendingZipTimer) { clearInterval(pendingZipTimer); pendingZipTimer = null; }
});
