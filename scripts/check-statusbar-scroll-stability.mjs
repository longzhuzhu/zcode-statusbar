import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { CHROME } from './render-statusbar.mjs';

// 滚动到底部的间距补偿振荡回归：宿主 dock 是滚动容器内的 sticky bottom-0（v4 真机布局），
// bar 的 margin-bottom 参与内容高度后，sticky 钳制偏移会随补偿翻转，把 dockBottomMargin 的
// 实测 inset 推过 ±1 容差——两个 margin 状态在 guard 下互斥，渲染节奏驱动两态交替
// （真机采样：marginBottom 在 -12px 与 "" 间 ~5Hz 翻转，bar 位移 4px，atBottom 反复横跳）。
// 不变量：无论从哪个 margin 起点出发，渲染必须收敛到同一终态且不再交替。
const STICKY_HOST_HTML = (SRC) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, system-ui, sans-serif; }
  .pane { width: 720px; margin: 0 auto; }
  .chat { height: 400px; overflow-y: auto; }
  .history { height: 298px; background: #f6f7f8; margin-bottom: 10px; }
  .dock { position: sticky; bottom: 0; padding-bottom: 16px; background: #fff; }
  .composer { border: 1px solid rgba(0,0,0,.14); border-radius: 14px; padding: 12px 14px; height: 72px;
    background: #fff; font-size: 13px; color: rgba(0,0,0,.36); }
  .hidden-usage { display: none; }
  .zsb-ring-fill, .zsb-ctxbar-fill, .zsb-ctxseg { transition: none !important; }
  .zsb-est, .zsb-pulse { animation: none !important; opacity: 1 !important; }
</style></head><body>
<div class="pane" data-session-id="sess_demo">
  <div class="chat">
    <div class="history">历史消息区：高度让 m=-12 时内容恰好贴底（无 sticky 钳制），m 清空时溢出 12px（sticky 钳制生效）。</div>
    <div class="dock">
      <div class="hidden-usage" data-usage-used="142600" data-usage-max="200000"></div>
      <div data-zcode-composer class="composer">输入消息…</div>
    </div>
  </div>
</div>
<script>
  window.__ZCODE_STATUSBAR_BRIDGE__ = {
    getPaneId: function () { return 'workspace-main'; },
    getSessionSnapshot: function () { return null; },
    getContextBreakdown: function () { return { used: 142600, size: 200000 }; }
  };
  window.__ZCODE_STATUSBAR_VERSION__ = 'test';
  window.__ZCODE_STATUSBAR_TURN__ = { tokPerSec: 87, estimated: true, updatedAt: Date.now() };
  setInterval(function () {
    window.__ZCODE_STATUSBAR_TURN__.updatedAt = Date.now();
    window.dispatchEvent(new CustomEvent('zcode-statusbar:turn', { detail: window.__ZCODE_STATUSBAR_TURN__ }));
  }, 100);
  setInterval(function () {
    window.dispatchEvent(new CustomEvent('zcode-statusbar:session', {
      detail: { totalTokens: 432100, turns: 9, steps: 8, sessionAvgTokPerSec: 100 },
    }));
  }, 100);
</script>
<script>${SRC}</script>
</body></html>`;

// 采样一个阶段：记录 margin 状态集合与翻转次数，断言单一终态、无交替
async function samplePhase(page, label, ms) {
  const trace = await page.evaluate(async ({ label, ms }) => {
    const sc = document.querySelector('.chat');
    sc.scrollTop = 0;
    const bar = document.querySelector('.zsb-bar');
    const margins = new Map();
    let last = null;
    let flips = 0;
    const until = performance.now() + ms;
    while (performance.now() < until) {
      await new Promise(requestAnimationFrame);
      const m = bar.style.marginBottom || '""';
      if (m !== last) {
        if (last !== null) flips++;
        margins.set(m, (margins.get(m) || 0) + 1);
        last = m;
      }
    }
    return { label, margins: [...margins.entries()], flips };
  }, { label, ms });
  return trace;
}

const browser = await chromium.launch({ executablePath: CHROME });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const fs = await import('node:fs');
  const SRC = fs.readFileSync(new URL('../statusbar/statusbar.js', import.meta.url), 'utf8');
  await page.setContent(STICKY_HOST_HTML(SRC));
  await page.waitForTimeout(1400);

  // 阶段一：从「无补偿」起点出发（清空 margin，模拟 guard 判定失败后的状态）
  await page.evaluate(() => { document.querySelector('.zsb-bar').style.marginBottom = ''; });
  const fromCleared = await samplePhase(page, 'from-cleared', 900);

  // 阶段二：从「已补偿 -12px」起点出发（模拟上一轮写入后的状态）
  await page.evaluate(() => { document.querySelector('.zsb-bar').style.marginBottom = '-12px'; });
  const fromCompensated = await samplePhase(page, 'from-compensated', 900);

  const clearedEnd = fromCleared.margins.at(-1)?.[0];
  const compensatedEnd = fromCompensated.margins.at(-1)?.[0];
  const context = JSON.stringify({ fromCleared, fromCompensated, errors });
  assert.deepEqual(errors, [], context);
  // 阶段一从强制清零出发，首轮渲染合法写入一次补偿；除此只允许一个稳定态。
  // 持续交替（flips 远超 1）才是反馈振荡。
  assert.ok(fromCleared.margins.length <= 2 && fromCleared.flips <= 1, '阶段一不得持续交替: ' + context);
  assert.equal(fromCompensated.margins.length, 1, '阶段二不得交替: ' + context);
  assert.equal(clearedEnd, compensatedEnd, '两个起点的终态必须一致（判定不得依赖自身写入的补偿）: ' + context);
  console.log('Passed scroll-stability: 终态 ' + clearedEnd + '，两起点判定一致');
  await page.close();
} finally {
  await browser.close();
}
