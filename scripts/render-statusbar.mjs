/**
 * 渲染 README 截图：在 headless Chrome 里跑 statusbar/statusbar.js 并截取状态条与各弹层。
 *
 * 请求行是演示数据，但聚合走真实 session-stats.cjs，渲染走真实 statusbar.js。
 *
 * 用法：node scripts/render-statusbar.mjs [出图目录]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const OUT_DIR = process.argv[2] || path.join(REPO, 'docs', 'screenshots');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const CHROME = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error('找不到 Chrome。设置 CHROME_PATH 指向 chrome 或 chromium 可执行文件。');
  process.exit(1);
}

const aggregate = require(path.join(REPO, 'statusbar', 'session-stats.cjs')).aggregate;

const NOW = Date.UTC(2026, 10, 8, 15, 30, 0);

function mainRequest(i) {
  return {
    id: 'req_' + i,
    sid: 'sess_demo',
    turnId: 'turn_' + Math.floor(i / 2),
    kind: 'model',
    isSubagent: false,
    model: 'deepseek-v4.1',
    thinking: false,
    status: 'completed',
    startedAt: NOW - (40 - i) * 6000,
    firstTokenAt: NOW - (40 - i) * 6000 + 1200,
    completedAt: NOW - (40 - i) * 6000 + 5200,
    inputTokens: 18400,
    outputTokens: 240,
    cacheReadTokens: 15600,
    cacheWriteTokens: 900,
  };
}

function toolCall(i, name, ms) {
  return {
    id: 'tool_' + i,
    sid: 'sess_demo',
    turnId: 'turn_' + Math.floor(i / 4),
    kind: 'tool',
    isSubagent: false,
    model: name,
    status: 'completed',
    startedAt: NOW - (30 - i) * 4000,
    completedAt: NOW - (30 - i) * 4000 + ms,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function subagentRows() {
  const rows = [];
  const running = [
    { id: 'a1', type: 'Explore', task: '梳理宿主状态栏锚点与注入时序', ago: 96000 },
    { id: 'b2', type: 'general-purpose', task: '核对 SQLite 投影字段与聚合口径', ago: 41000 },
  ];
  running.forEach((s, i) => {
    const child = 'sess_subagent_' + s.id;
    rows.push({
      id: 'row_' + s.id,
      sid: child,
      kind: 'subagent',
      isSubagent: true,
      model: 'Agent',
      status: 'running',
      startedAt: NOW - s.ago,
      completedAt: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      subagentType: s.type,
      task: s.task,
      childSessionId: child,
    });
    rows.push({
      id: 'model_' + s.id,
      sid: child,
      turnId: 'subt_' + i,
      kind: 'model',
      isSubagent: true,
      model: 'deepseek-v4.1',
      status: 'completed',
      startedAt: NOW - 12000 - i * 3000,
      firstTokenAt: NOW - 12000 - i * 3000 + 900,
      completedAt: NOW - 6200 - i * 3000,
      inputTokens: 8200,
      outputTokens: 310,
      cacheReadTokens: 6800,
      cacheWriteTokens: 300,
      childSessionId: child,
    });
  });
  const doneChild = 'sess_subagent_agent_9f3c1a';
  rows.push({
    id: 'row_done',
    sid: doneChild,
    kind: 'subagent',
    isSubagent: true,
    model: 'Agent',
    status: 'completed',
    startedAt: NOW - 250000,
    completedAt: NOW - 180000,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    subagentType: 'Plan',
    task: '拆分状态条四件套的模块边界',
    childSessionId: doneChild,
  });
  rows.push({
    id: 'model_done',
    sid: doneChild,
    turnId: 'subt_done',
    kind: 'model',
    isSubagent: true,
    model: 'deepseek-v4.1',
    status: 'completed',
    startedAt: NOW - 250000,
    firstTokenAt: NOW - 249000,
    completedAt: NOW - 238000,
    inputTokens: 15200,
    outputTokens: 1180,
    cacheReadTokens: 12400,
    cacheWriteTokens: 400,
    childSessionId: doneChild,
  });
  return rows;
}

function buildRows() {
  const rows = [];
  for (let i = 0; i < 34; i++) rows.push(mainRequest(i));
  const tools = [
    ['Read', 900], ['Bash', 2400], ['Edit', 700], ['Grep', 500],
    ['Read', 800], ['Bash', 3100], ['Read', 600], ['Write', 1200],
    ['TodoWrite', 300], ['Read', 750], ['Bash', 1800], ['Grep', 450],
  ];
  tools.forEach((t, i) => rows.push(toolCall(i, t[0], t[1])));
  return rows.concat(subagentRows());
}

const SESSION = aggregate(buildRows(), NOW);

const TODAY = {
  requests: 212,
  input: 14820000,
  output: 246800,
  cache_read: 12960000,
  cache_write: 812000,
  total: 15066800,
  reasoning: 0,
  retries: 0,
  started: NOW - 7 * 3600 * 1000,
  last_at: NOW - 60000,
};

const CONTEXT = {
  used: 142600,
  size: 200000,
  breakdown: [
    { source: 'system_prompt', chars: 18400 },
    { source: 'meta_user_context', chars: 3100 },
    { source: 'skills', chars: 9200 },
    { source: 'tool_prompt', chars: 12800 },
    { source: 'system_tool_schemas', chars: 26800 },
    { source: 'mcp_tool_schemas', chars: 6400 },
    { source: 'messages', chars: 64200 },
  ],
};

const TURN = { tokPerSec: 87, estimated: true, updatedAt: NOW };
const VERSION = require(path.join(REPO, 'package.json')).version;

const STATUSBAR_SRC = fs.readFileSync(path.join(REPO, 'statusbar', 'statusbar.js'), 'utf8');
const RAMP_SRC = fs.readFileSync(path.join(REPO, 'statusbar', 'ramp.js'), 'utf8');

const PILL_OF_VIEW = {
  activity: 'activity',
  usage: 'usage',
  context: 'context',
  subagent: 'subagent',
  menu: 'gear',
};

const STAGE_BOTTOM_PAD = { panel: 18, bar: 30 };

function pageHtml(theme, view) {
  const dark = theme === 'dark';
  const click = PILL_OF_VIEW[view] || null;
  const bottomPad = view === 'bar' ? STAGE_BOTTOM_PAD.bar : STAGE_BOTTOM_PAD.panel;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: ${dark ? '#1a1a1c' : '#ffffff'};
    font-family: -apple-system, "PingFang SC", system-ui, sans-serif;
    color: ${dark ? '#e6e8eb' : '#232629'};
  }
  html, body { height: 100%; }
  .stage {
    display: flex; flex-direction: column; justify-content: flex-end;
    min-height: 100%; padding: 20px 24px ${bottomPad}px;
  }
  .pane { max-width: 720px; margin: 0 auto; }
  .bubble {
    background: ${dark ? '#25262a' : '#f6f7f8'};
    border-radius: 12px; padding: 12px 16px; margin-bottom: 10px;
    font-size: 13px; line-height: 1.7;
    color: ${dark ? 'rgb(200,205,211)' : 'rgb(86,90,96)'};
  }
  .bubble.me { background: ${dark ? '#2f3b52' : '#eef4ff'}; max-width: 70%; margin-left: auto; }
  .dock { padding-bottom: 16px; }
  .composer {
    display: flex; align-items: center;
    border: 1px solid ${dark ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.14)'};
    border-radius: 14px; padding: 12px 14px; min-height: 72px;
    background: ${dark ? '#232427' : '#fff'};
    font-size: 13px; color: ${dark ? 'rgba(255,255,255,.4)' : 'rgba(0,0,0,.36)'};
  }
  // 过渡会把读数截在插值中的帧：圆环描边取不到目标色阶（灰而非橙）。动画同样钉在首帧，
  // 否则呼吸灯会停在半透明上。估算态与运行态本身仍由文字和绿点表达。
  .zsb-ring-fill, .zsb-ctxbar-fill, .zsb-ctxseg { transition: none !important; }
  .zsb-est, .zsb-pulse { animation: none !important; opacity: 1 !important; }

  .hidden-usage { display: none; }
</style></head>
<body>
<div class="stage"><div class="pane">
  <div class="bubble">帮我核对一下状态条的聚合口径，顺便看看上下文现在用了多少。</div>
  <div class="bubble me">好的，我先读一遍 CONTRACT。</div>
  <div class="dock" data-session-id="sess_demo">
    <div class="hidden-usage" data-usage-used="${CONTEXT.used}" data-usage-max="${CONTEXT.size}"></div>
    <div data-zcode-composer class="composer">输入消息…</div>
  </div>
</div></div>
<script>
  window.__ZCODE_STATUSBAR_BRIDGE__ = {
    getPaneId: function () { return 'pane_demo'; },
    getSessionSnapshot: function () { return null; },
    getContextBreakdown: function () { return ${JSON.stringify(CONTEXT)}; }
  };
  window.__ZCODE_STATUSBAR_VERSION__ = ${JSON.stringify(VERSION)};
  // updatedAt 必须持续新鲜：statusbar.js 用 3s 新鲜度判定估算态，而 --virtual-time-budget
  // 会让虚拟时钟推进数秒。定时刷新等效于真实生成中每秒都有新样本。
  window.__ZCODE_STATUSBAR_TURN__ = ${JSON.stringify(TURN)};
  setInterval(function () {
    window.__ZCODE_STATUSBAR_TURN__.updatedAt = Date.now();
  }, 200);
</script>
<script>${RAMP_SRC}</script>
<script>window.__ZCODE_STATUSBAR_RAMP__ = {
  speedColor: window.ZCodeStatusbarRamp.speedColor,
  contextColor: window.ZCodeStatusbarRamp.contextColor
};</script>
<script>${STATUSBAR_SRC}</script>
<script>
  window.dispatchEvent(new CustomEvent('zcode-statusbar:session', {
    detail: ${JSON.stringify({ aggregate: SESSION, today: TODAY, mine: 'sess_demo' })}
  }));
  var pill = ${JSON.stringify(click)};
  if (pill) {
    setTimeout(function () {
      var btn = document.querySelector('[data-zsb-pill="' + pill + '"]');
      if (btn) btn.click();
    }, 60);
  }
</script>
</body></html>`;
}

function shoot(file, html, size) {
  const tmp = path.join(OUT_DIR, '.page.html');
  fs.writeFileSync(tmp, html);
  const out = path.join(OUT_DIR, file + '.png');
  execFileSync(
    CHROME,
    [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      '--virtual-time-budget=3000',
      '--window-size=' + size,
      '--screenshot=' + out,
      tmp,
    ],
    { stdio: 'ignore' }
  );
  fs.unlinkSync(tmp);
  return out;
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const written = [];
for (const theme of ['light', 'dark']) {
  written.push(shoot('bar-' + theme, pageHtml(theme, 'bar'), '800,270'));
}
const PANEL_HEIGHT = { activity: 470, usage: 730, context: 400, subagent: 450, menu: 600 };
for (const view of Object.keys(PANEL_HEIGHT)) {
  written.push(shoot('panel-' + view, pageHtml('light', view), '800,' + PANEL_HEIGHT[view]));
}

console.log(
  JSON.stringify(
    {
      turns: SESSION.turns,
      steps: SESSION.steps,
      totalTokens: SESSION.totalTokens,
      cacheHitRate: SESSION.cacheHitRate,
      sessionAvgTokPerSec: SESSION.sessionAvgTokPerSec,
      subagents: SESSION.subagent.list.length,
      active: SESSION.subagent.activeCount,
      written,
    },
    null,
    2
  )
);
