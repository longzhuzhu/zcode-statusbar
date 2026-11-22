import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { CHROME } from './render-statusbar.mjs';

// 滚动到底部时的间距振荡回归。
//
// 历史：0.1.x 用 dockBottomMargin 在滚动容器内回收底部空白，补偿 margin 会经 sticky
// 钳制与宿主滞后重测量反馈进实测 inset，两态 guard 互斥、渲染节奏驱动 ~5Hz 交替
// （真机采样见 docs/scroll-bottom-oscillation.md）。
//
// 现状：状态条已移出滚动容器（见 check-statusbar-composer-dock.mjs），补偿逻辑整体删除，
// margin 由宿主 timeline 的 padding-bottom 一次性算出，不参与任何反馈环。因此本回归的
// 不变量变成两条，比原「两起点收敛」更强也更好测：
//   1. margin 在整个采样期恒定（只允许至多一次初值写入）
//   2. 状态条位置在滚动全程不随渲染帧变化
const HOST_HTML = (SRC) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, system-ui, sans-serif; }
  .shell { display: flex; height: 600px; flex-direction: column; }
  .pane { position: relative; display: flex; flex: 1 1 0%; min-height: 0; flex-direction: column; }
  .timeline { position: relative; display: flex; min-height: 0; flex: 1 1 0%; flex-direction: column; padding-bottom: 16px; }
  .scroll { min-height: 0; flex: 1 1 0%; overflow-y: auto; }
  .content { display: flex; min-height: 100%; flex-direction: column; }
  .history { height: 1600px; flex: none; background: #f6f7f8; }
  .dock { position: sticky; bottom: 0; display: flex; width: 100%; }
  .dock-content { width: 100%; padding: 0 8px; }
  .composer { border: 1px solid rgba(0,0,0,.14); border-radius: 14px; padding: 12px 14px; height: 72px;
    background: #fff; font-size: 13px; color: rgba(0,0,0,.36); }
  .hidden-usage { display: none; }
  .zsb-ring-fill, .zsb-ctxbar-fill, .zsb-ctxseg { transition: none !important; }
  .zsb-est, .zsb-pulse { animation: none !important; opacity: 1 !important; }
</style></head><body>
<div class="shell"><div class="pane" data-session-id="sess_demo">
  <div class="timeline"><div class="scroll">
    <div class="content">
      <div class="history">历史消息区</div>
      <div class="dock"><div class="dock-content">
        <div class="hidden-usage" data-usage-used="142600" data-usage-max="200000"></div>
        <div class="composer" data-testid="v4-composer">输入消息…</div>
      </div></div>
    </div>
  </div></div>
</div></div>
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

// 在给定滚动位置采样：记录 margin 状态集合、翻转次数与条位置
async function sampleAt(page, scrollFrac, ms) {
  return page.evaluate(async ({ scrollFrac, ms }) => {
    const sc = document.querySelector('.scroll');
    sc.scrollTop = (sc.scrollHeight - sc.clientHeight) * scrollFrac;
    const bar = document.querySelector('.zsb-bar');
    const margins = new Set();
    const tops = new Set();
    let last = null;
    let flips = 0;
    const until = performance.now() + ms;
    while (performance.now() < until) {
      await new Promise(requestAnimationFrame);
      const m = bar.style.marginBottom || '""';
      if (m !== last) {
        if (last !== null) flips++;
        margins.add(m);
        last = m;
      }
      tops.add(Math.round(bar.getBoundingClientRect().top));
    }
    return { scrollFrac, margins: [...margins], tops: [...tops], flips };
  }, { scrollFrac, ms });
}

const browser = await chromium.launch({ executablePath: CHROME });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const fs = await import('node:fs');
  const SRC = fs.readFileSync(new URL('../statusbar/statusbar.js', import.meta.url), 'utf8');
  await page.setContent(HOST_HTML(SRC));
  await page.waitForTimeout(1400);

  const phases = [];
  for (const frac of [0, 0.5, 1]) phases.push(await sampleAt(page, frac, 900));

  const ctx = JSON.stringify({ phases, errors });
  assert.deepEqual(errors, [], ctx);

  for (const p of phases) {
    assert.ok(p.flips <= 1, 'margin 不得持续交替（滚动 ' + p.scrollFrac + '）: ' + ctx);
    assert.equal(p.tops.length, 1, '状态条位置不得随渲染帧变化（滚动 ' + p.scrollFrac + '）: ' + ctx);
  }
  // 全程只应有一个 margin 值：它由宿主 padding 一次性算出，不随滚动或渲染改变
  const allMargins = new Set(phases.flatMap((p) => p.margins));
  assert.equal(allMargins.size, 1, 'margin 在滚动全程恒定: ' + ctx);

  const margin = [...allMargins][0];
  console.log('Passed scroll-stability: margin 全程恒定 ' + margin + '，条位置不随帧变化');
  await page.close();
} finally {
  await browser.close();
}
