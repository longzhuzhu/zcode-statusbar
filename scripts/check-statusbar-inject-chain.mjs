import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { CHROME } from './render-statusbar.mjs';

// 内核注入链（core/inject-main.cjs injectStatusbar）把四个资产拼成一个脚本串，
// 经 executeJavaScript 在页面全局求值；资产热更新后整串重注入。
// 顶层的 const/let/class 会进页面全局词法环境：第二次注入同一段代码会抛
// "Identifier 'X' has already been declared"，SyntaxError 让整串中断，
// 排在后面的 statusbar.js 不再执行——真机表现是「改了代码但界面没变化」。
// 不变量：每个资产都能在同一页面重复注入，且注入后全局契约就位。
const HERE = path.dirname(new URL(import.meta.url).pathname);
const read = (dir, p) => fs.readFileSync(path.join(HERE, '..', dir, p), 'utf8');
// 与 inject-main.cjs 的注入顺序一致：bridge → turn-stats → ramp → statusbar
const ASSETS = [
  read('core', 'statusbar-bridge.js'),
  read('statusbar', 'turn-stats.js'),
  read('statusbar', 'ramp.js'),
  read('statusbar', 'statusbar.js'),
];

const HOST = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div data-session-id="sess_demo"><div class="dock">
  <div class="chat-composer-region" data-testid="v4-composer">
    <div class="chat-composer-input-surface" contenteditable="true">x</div>
  </div>
</div></div>
<script>
  window.__ZCODE_STATUSBAR_BRIDGE__ = { getPaneId: () => 'workspace-main', getSessionSnapshot: () => null, getContextBreakdown: () => null };
</script></body></html>`;

const browser = await chromium.launch({ executablePath: CHROME });
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.setContent(HOST);

  // 与内核同形：executeJavaScript 在页面全局作用域求值脚本，顶层 let/const/class
  // 因此进入全局词法环境并跨轮保留。这里用 <script> 注入复现同一语义
  //（(0, eval) 每轮新建 var 环境，测不出重声明）。
  const evalGlobal = (src) => page.evaluate((s) => new Promise((resolve) => {
    const onErr = (ev) => {
      window.removeEventListener('error', onErr);
      resolve(String((ev && ev.error && ev.error.name) || 'Error') + ': ' + String((ev && ev.message) || ''));
    };
    window.addEventListener('error', onErr);
    const el = document.createElement('script');
    el.textContent = s;
    document.head.appendChild(el);
    setTimeout(() => {
      window.removeEventListener('error', onErr);
      resolve('ok');
    }, 30);
  }), src);

  const results = [];
  for (let round = 1; round <= 3; round++) {
    // 真实重载会先调 DISPOSE 再重注入；第一轮时它还不存在
    const cleanup = '(function(){if(window.__ZCODE_STATUSBAR_DISPOSE__)window.__ZCODE_STATUSBAR_DISPOSE__();window.__ZCODE_STATUSBAR__=false;})();\n';
    const combined = await evalGlobal(cleanup + ASSETS.join('\n;\n'));
    results.push({ round, combined });
  }

  const ctx = JSON.stringify({ results, pageErrors });
  for (const r of results) {
    assert.equal(r.combined, 'ok', '第 ' + r.round + ' 轮整串注入必须成功: ' + ctx);
  }

  const state = await page.evaluate(() => ({
    hasBridge: !!window.__ZCODE_STATUSBAR_BRIDGE__,
    hasRamp: typeof (window.__ZCODE_STATUSBAR_RAMP__ || window.ZCodeStatusbarRamp),
    hasDispose: typeof window.__ZCODE_STATUSBAR_DISPOSE__,
    bars: document.querySelectorAll('.zsb-bar').length,
  }));
  assert.equal(state.hasBridge, true, '桥必须在位: ' + ctx);
  assert.notEqual(state.hasRamp, 'undefined', 'ramp 必须在位（否则速度与圆环退色）: ' + ctx);
  assert.equal(state.hasDispose, 'function', 'statusbar 必须提供热重载清理钩子: ' + ctx);
  assert.equal(state.bars, 1, '三轮注入后应只保留一条状态条: ' + ctx);

  console.log('Passed inject-chain: 四资产可重复注入，statusbar 每轮都执行');
  await page.close();
} finally {
  await browser.close();
}
