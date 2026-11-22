import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { CHROME } from './render-statusbar.mjs';

// ZCode 3.19.1（app.asar: ConversationTimeline.tsx）真实 dock 形态的回归：
//   pane[data-session-id] > timeline(pb-4) > scroll(overflow-y:auto) > content
//     > layer(消息 + 变更摘要卡)  +  dock(sticky bottom-0) > dock-content(px-2)
//       > anchor(relative) > chip(处理中 N/M) + region(class 含 composer)
// 三条不变量：
//   A. 状态条落在输入框下方（不是上方，也不能插进 composer 内部当它最后一个子节点）
//   B. 状态条整体在视口内（贴底滚动时不被时间线 pb-4 推出视野）
//   C. 重复注入（内核热重载）后页面里仍只有一条状态条，且输入框位置不变
const HOST_HTML = (src) => `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; overflow: hidden; }
  body { font: 12px -apple-system, system-ui, sans-serif; }
  .pane { position: relative; display: flex; height: 738px; min-height: 0; flex-direction: column; }
  .timeline { position: relative; display: flex; min-height: 0; flex: 1 1 0%; flex-direction: column; padding-bottom: 16px; }
  .scroll { min-height: 0; flex: 1 1 0%; overflow-x: hidden; overflow-y: auto; }
  .content { display: flex; min-height: 100%; flex-direction: column; }
  .layer { position: relative; display: flex; width: 100%; flex-direction: column; }
  .history { height: 2400px; flex: none; background: repeating-linear-gradient(#f6f7f8 0 40px, #fff 40px 80px); }
  .card { display: flex; height: 40px; flex: none; align-items: center; justify-content: space-between;
    margin: 0 8px 8px; padding: 0 12px; border: 1px solid #e5e7eb; border-radius: 12px; background: #fff; }
  .dock { pointer-events: none; position: sticky; bottom: 0; z-index: 20; display: flex; width: 100%; justify-content: center; }
  .dock-content { pointer-events: auto; position: relative; z-index: 10; width: 100%; flex-shrink: 0; padding: 0 8px; }
  .anchor { position: relative; }
  .chip { display: block; margin: 0 auto 8px; width: 120px; height: 28px; border-radius: 999px; background: #e9eaee; text-align: center; line-height: 28px; }
  .transition { display: grid; width: 100%; }
  .layer-slot { grid-column-start: 1; grid-row-start: 1; width: 100%; min-width: 0; align-self: end; }
  .region { z-index: 20; width: 100%; flex-shrink: 0; }
  .surface { position: relative; width: 100%; border: 1px solid rgba(0,0,0,.14); border-radius: 16px; padding: 12px; height: 150px; background: #fff; }
  .hidden-usage { display: none; }
  .zsb-est, .zsb-pulse { animation: none !important; opacity: 1 !important; }
</style></head><body>
<div class="pane" data-session-id="sess_demo">
  <div class="timeline">
    <div class="scroll">
      <div class="content">
        <div class="layer">
          <div class="history"></div>
          <div class="card"><span>7 个文件已更改 +347 -1</span><span>撤销</span></div>
        </div>
        <div class="dock"><div class="dock-content"><div class="anchor">
          <div class="chip">处理中 5/6</div>
          <div class="transition"><div class="layer-slot">
            <div class="region chat-composer-region" data-testid="v4-composer">
              <div class="hidden-usage" data-usage-used="142600" data-usage-max="200000"></div>
              <div class="chat-composer-input-surface surface">输入消息…</div>
            </div>
          </div></div>
        </div></div></div>
      </div>
    </div>
  </div>
</div>
<script>
  window.__ZCODE_STATUSBAR_BRIDGE__ = { getPaneId: () => 'workspace-main', getSessionSnapshot: () => null, getContextBreakdown: () => ({ used: 142600, size: 200000 }) };
  window.__ZCODE_STATUSBAR_VERSION__ = 'test';
  window.__ZCODE_STATUSBAR_TURN__ = { tokPerSec: 87, estimated: true, updatedAt: Date.now() };
  setInterval(() => window.dispatchEvent(new CustomEvent('zcode-statusbar:turn', { detail: window.__ZCODE_STATUSBAR_TURN__ })), 200);
  setInterval(() => window.dispatchEvent(new CustomEvent('zcode-statusbar:session', { detail: { totalTokens: 1, turns: 1, steps: 1 } })), 200);
</script>
<script>${src}</script>
</body></html>`;

const HERE = path.dirname(new URL(import.meta.url).pathname);
const read = (p) => fs.readFileSync(path.join(HERE, '..', 'statusbar', p), 'utf8');
const ASSETS = [read('ramp.js'), read('statusbar.js')].join('\n;\n');
const CLEANUP = '(function(){if(window.__ZCODE_STATUSBAR_DISPOSE__)window.__ZCODE_STATUSBAR_DISPOSE__();window.__ZCODE_STATUSBAR__=false;})();\n';

const browser = await chromium.launch({ executablePath: CHROME });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 738 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setContent(HOST_HTML(ASSETS));
  await page.waitForTimeout(1500);

  const measure = () => page.evaluate(async () => {
    const sc = document.querySelector('.scroll');
    sc.scrollTop = sc.scrollHeight;
    for (let i = 0; i < 20; i++) await new Promise(requestAnimationFrame);
    const bars = [...document.querySelectorAll('.zsb-bar')];
    const bar = bars[bars.length - 1];
    const b = bar.getBoundingClientRect();
    const region = document.querySelector('.region').getBoundingClientRect();
    const dock = document.querySelector('.dock').getBoundingClientRect();
    // 最近的可裁剪祖先内沿：状态条越过它就是被裁掉的部分
    let clipBottom = Infinity;
    for (let n = bar.parentElement; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.overflowY !== 'visible') {
        clipBottom = n.getBoundingClientRect().bottom - parseFloat(cs.borderBottomWidth);
        break;
      }
    }
    const marginBottom = bar.style.marginBottom || null;
    return {
      count: bars.length,
      // 状态条是 region 的后代 = 插进了 composer 内部（错位形态）
      insideComposer: document.querySelector('.region').contains(bar),
      bar: [Math.round(b.top), Math.round(b.bottom)],
      composer: [Math.round(region.top), Math.round(region.bottom)],
      dock: [Math.round(dock.top), Math.round(dock.bottom)],
      viewportH: window.innerHeight,
      marginBottom,
      gapAbove: Math.round(b.top - region.bottom),
      gapBelow: Math.round(clipBottom - b.bottom),
    };
  });

  const first = await measure();
  const ctx = JSON.stringify({ first, errors });

  assert.deepEqual(errors, [], 'page errors: ' + ctx);
  assert.equal(first.count, 1, '挂载后应只有一条状态条: ' + ctx);
  assert.equal(first.insideComposer, false, '状态条不得插进 composer 内部: ' + ctx);
  assert.ok(first.bar[0] >= first.composer[1] - 0.5, '状态条应位于输入框下方: ' + ctx);
  // 状态条与输入框的间距应为 CSS margin-top（4px），且下方要留出可见余量：
  // 宿主 dock 在滚动容器内时，把容器外的 padding（timeline pb-4）当可回收空白会
  // 把条压到裁剪边界，真机表现为下半截被裁掉。
  assert.ok(Math.abs(first.gapAbove - 4) <= 1, '输入框到状态条的间距应保持 4px: ' + ctx);
  assert.ok(first.gapBelow >= 3, '状态条下方需保留可见余量（不得贴裁切边）: ' + ctx);

  // C：内核渲染端热重载会整段重注入；旧实例必须先自清，否则每轮多一条并把 composer 顶起。
  for (let i = 1; i <= 2; i++) {
    await page.evaluate((src) => { (0, eval)(src); }, CLEANUP + ASSETS);
    await page.waitForTimeout(1200);
    const after = await measure();
    const label = 'hot-reload #' + i;
    assert.equal(after.count, 1, label + ' 后应仍只有一条状态条: ' + JSON.stringify({ after, errors }));
    assert.deepEqual(after.composer, first.composer, label + ' 后输入框位置不得漂移: ' + JSON.stringify({ first, after }));
  }

  // D：不带 cleanup 的重复注入（dom-ready 与 did-finish-load 同毫秒各触发一次的形态）
  // 也必须收敛到一条：实例自己接管清理，旧实例停手后不能再把条挂回来。
  for (let i = 1; i <= 2; i++) {
    await page.evaluate((src) => { (0, eval)(src); }, ASSETS);
    await page.waitForTimeout(2400); // 跨过旧实例那一轮 1s 轮询才看得出是否会复活
    const after = await measure();
    const label = 'bare re-inject #' + i;
    assert.equal(after.count, 1, label + ' 后应仍只有一条状态条: ' + JSON.stringify({ after, errors }));
    assert.deepEqual(after.composer, first.composer, label + ' 后输入框位置不得漂移: ' + JSON.stringify({ first, after }));
  }

  // E：采样循环只能有一套。重复注入若各留一个 100ms 定时器，turn 事件会成倍派发。
  const turnRate = await page.evaluate(async () => {
    const before = window.__ZCODE_STATUSBAR_TURN_API__;
    let n = 0;
    const on = () => { n++; };
    window.addEventListener('zcode-statusbar:turn', on);
    await new Promise((r) => setTimeout(r, 1500));
    window.removeEventListener('zcode-statusbar:turn', on);
    return { sameApi: window.__ZCODE_STATUSBAR_TURN_API__ === before, turns: n };
  });
  assert.equal(turnRate.sameApi, true, '重复注入后应只有最后一套采样 API: ' + JSON.stringify(turnRate));

  console.log('Passed composer-dock: 状态条在输入框下方、完整可见、重载与重复注入都不累积');
  await page.close();
} finally {
  await browser.close();
}
