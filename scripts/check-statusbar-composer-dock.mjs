import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { CHROME } from './render-statusbar.mjs';

// ZCode 3.19.1 真实 dock 形态的回归（层级从 app.asar 的 renderer bundle 反查得到）：
//   #content(pr-1 pb-1) > pane[data-session-id] > timeline(pb-4) > scroll(overflow-y:auto)
//     > content > layer(消息 + 变更摘要卡)  +  dock(sticky bottom-0) > dock-content(px-2)
//       > anchor(relative) > chip(处理中 N/M) + region(class 含 composer)
// 两条 padding 都在滚动容器【外】：timeline 的 pb-4 与 #content 的 pb-1 共 20px，
// 加上状态条自身 4px margin 就是截图红框里那 24px。滚动容器是裁剪边界，
// 所以状态条若住在容器内，「贴底」与「完整可见」在该位置是零和的。
// 四条不变量：
//   A. 状态条落在输入框下方（不是上方，也不能插进 composer 内部当它最后一个子节点）
//   B. 状态条整体可见，且底边到窗口底 ≤ 4px（以窗口底为基准，不是以滚动容器为基准）
//   C. 重复注入（内核热重载）后页面里仍只有一条状态条，且输入框位置不变
//   D. 采样循环只有一套
const HOST_HTML = (src) => `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; overflow: hidden; }
  body { font: 12px -apple-system, system-ui, sans-serif; }
  .shell { display: flex; height: 738px; padding: 0 4px 4px 0; flex-direction: column; }
  .pane { position: relative; display: flex; flex: 1 1 0%; min-height: 0; flex-direction: column; }
  .timeline { position: relative; display: flex; min-height: 0; flex: 1 1 0%; flex-direction: column; padding-bottom: 16px; }
  .scroll { min-height: 0; flex: 1 1 0%; overflow-x: hidden; overflow-y: auto; }
  .content { display: flex; min-height: 100%; flex-direction: column; }
  .layer { position: relative; display: flex; width: 100%; flex-direction: column; }
  .history { height: 2400px; flex: none; background: repeating-linear-gradient(#f6f7f8 0 40px, #fff 40px 80px); }
  .card { display: flex; height: 40px; flex: none; align-items: center; justify-content: space-between;
    margin: 0 8px 8px; padding: 0 12px; border: 1px solid #e5e7eb; border-radius: 12px; background: #fff; }
  .dock { pointer-events: none; position: sticky; bottom: 0; z-index: 20; display: flex; width: 100%; justify-content: center; }
  /* 宿主的宽度基准：dock-content 带 max-w-6xl（72rem=1152px）居中。少了这条，条按
     窗格全宽居中而输入框按内容列居中，左右间隙会差出几百像素（真机实测 220px）。 */
  .dock-content { pointer-events: auto; position: relative; z-index: 10; width: 100%; flex-shrink: 0;
    padding: 0 8px; max-width: 72rem; margin: 0 auto; }
  .anchor { position: relative; }
  .chip { display: block; margin: 0 auto 8px; width: 120px; height: 28px; border-radius: 999px; background: #e9eaee; text-align: center; line-height: 28px; }
  .transition { display: grid; width: 100%; }
  .layer-slot { grid-column-start: 1; grid-row-start: 1; width: 100%; min-width: 0; align-self: end; }
  .region { z-index: 20; width: 100%; flex-shrink: 0; }
  .surface { position: relative; width: 100%; border: 1px solid rgba(0,0,0,.14); border-radius: 16px; padding: 12px; height: 150px; background: #fff; }
  .hidden-usage { display: none; }
  .zsb-est, .zsb-pulse { animation: none !important; opacity: 1 !important; }
</style></head><body>
<div class="shell"><div class="pane" data-session-id="sess_demo">
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
</div></div>
<script>
  window.__ZCODE_STATUSBAR_BRIDGE__ = { getPaneId: () => 'workspace-main', getSessionSnapshot: () => null, getContextBreakdown: () => ({ used: 142600, size: 200000 }) };
  window.__ZCODE_STATUSBAR_VERSION__ = 'test';
  window.__ZCODE_STATUSBAR_TURN__ = { tokPerSec: 87, estimated: true, updatedAt: Date.now() };
  setInterval(() => window.dispatchEvent(new CustomEvent('zcode-statusbar:turn', { detail: window.__ZCODE_STATUSBAR_TURN__ })), 200);
  setInterval(() => window.dispatchEvent(new CustomEvent('zcode-statusbar:session', { detail: { totalTokens: 1, turns: 1, steps: 1 } })), 200);
</script>
<script>${src}</script>
</body></html>`;

// 宿主结构变形的兜底：composer 在一个 overflow:hidden 的外壳里，外壳不是滚动容器。
// 「overflow 非 visible」不足以认定滚动容器——必须真是 auto/scroll 且内容可滚。
// 否则条会被挂到不该挂的层（真机曾因把任意裁剪层当滚动容器而错位）。
const NO_SCROLL_HTML = (src) => `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; overflow: hidden; }
  body { font: 12px -apple-system, system-ui, sans-serif; }
  .pane { position: relative; display: flex; height: 738px; flex-direction: column; padding: 8px; }
  /* overflow:hidden 但不是滚动容器：clip 命中它也不能当成槽位来源 */
  .shell { overflow: hidden; padding-bottom: 16px; }
  .anchor { position: relative; }
  .region { width: 100%; }
  .surface { width: 100%; border: 1px solid rgba(0,0,0,.14); border-radius: 16px; padding: 12px; height: 120px; background: #fff; }
  .hidden-usage { display: none; }
  .zsb-est, .zsb-pulse { animation: none !important; opacity: 1 !important; }
</style></head><body>
<div class="pane" data-session-id="sess_demo">
  <div class="shell"><div class="anchor">
    <div class="region chat-composer-region" data-testid="v4-composer">
      <div class="hidden-usage" data-usage-used="142600" data-usage-max="200000"></div>
      <div class="chat-composer-input-surface surface">输入消息…</div>
    </div>
  </div></div>
</div>
<script>
  window.__ZCODE_STATUSBAR_BRIDGE__ = { getPaneId: () => 'workspace-main', getSessionSnapshot: () => null, getContextBreakdown: () => ({ used: 142600, size: 200000 }) };
  window.__ZCODE_STATUSBAR_VERSION__ = 'test';
  window.__ZCODE_STATUSBAR_TURN__ = { tokPerSec: 87, estimated: true, updatedAt: Date.now() };
</script>
<script>${src}</script>
</body></html>`;

const HERE = path.dirname(new URL(import.meta.url).pathname);const read = (p) => fs.readFileSync(path.join(HERE, '..', 'statusbar', p), 'utf8');
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
    // 条盒子与输入框的左右边界差：宿主输入框被限制在 max-w-6xl 内容列内，条若按窗格
    // 全宽布局，两者边界会差出几百像素。用 pill 跨度测不出来（flex center 会自己居中），
    // 必须用盒子的实际边界。
    const barBox = bar.getBoundingClientRect();
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
      // 死区以窗口底为基准：滚动容器底沿不是可视边界，容器外的 padding 同样留在窗口里
      deadGap: Math.round(window.innerHeight - b.bottom),
      // 条到会话面板底的间距：上下对称的判据用这条（面板底是条真正对齐的基准）
      gapBelowPane: Math.round(document.querySelector('[data-session-id]').getBoundingClientRect().bottom - b.bottom),
      clipped: b.bottom > clipBottom + 0.5,
      toClip: Math.round(clipBottom - b.bottom),
      // 条的盒子相对输入框的内缩（px-2 = 8px），左右必须一致且量级正确
      boxLeftInset: Math.round(region.left - barBox.left),
      boxRightInset: Math.round(barBox.right - region.right),
    };
  });

  const first = await measure();
  const ctx = JSON.stringify({ first, errors });

  assert.deepEqual(errors, [], 'page errors: ' + ctx);
  assert.equal(first.count, 1, '挂载后应只有一条状态条: ' + ctx);
  assert.equal(first.insideComposer, false, '状态条不得插进 composer 内部: ' + ctx);
  assert.ok(first.bar[0] >= first.composer[1] - 0.5, '状态条应位于输入框下方: ' + ctx);
  // 不变量 B：条必须完整可见（不得被滚动容器裁掉），且上下两条间距必须相等。
  //
  // 这里曾经踩过两个坑，都是「测试绿但真机丑」：
  //   1. 断言基准取滚动容器底，于是窗口底下那 20px（timeline pb-4 + #content pb-1）
  //      从未被检查，24px 死区在测试里恒绿。
  //   2. 只断言「上方 4px」，把下方留白单独放宽到 6~12px，于是「上 4 / 下 12」的
  //      不对称也能过。用户两次反馈「贴边框」「上下不对称」都来自这里。
  // 正确的不变量是一条：上方间距 == 下方间距（条到底边）。
  assert.equal(first.clipped, false, '状态条不得被任何祖先裁剪: ' + ctx);
  assert.ok(first.gapAbove >= 6, '输入框到状态条应留出可见间距: ' + ctx);
  assert.ok(first.deadGap >= 0, '状态条不得溢出窗口底: ' + ctx);
  // 下方以面板底为基准：壳层的透明 pb-1 不属于条的可控留白
  assert.ok(Math.abs(first.gapBelowPane - first.gapAbove) <= 2,
    '上下间距必须对称（上方 ' + first.gapAbove + ' / 下方 ' + first.gapBelowPane + '）: ' + ctx);
  // 条盒子应与输入框左右各内缩 8px（宿主 dock-content 的 px-2）。真机曾因条按窗格
  // 全宽布局而右沿超出输入框 220px，表现为「左右间隙不对等」。
  assert.ok(Math.abs(first.boxLeftInset - 8) <= 2,
    '条左边界应比输入框内缩 8px: ' + ctx);
  assert.ok(Math.abs(first.boxRightInset - 8) <= 2,
    '条右边界应比输入框内缩 8px: ' + ctx);

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

  // F：槽位契约。真机结构下必须走 outer（滚动容器外），否则死区无法归零。
  const slotInfo = await page.evaluate(() => {
    const bar = document.querySelector('.zsb-bar');
    return { slot: bar.getAttribute('data-zsb-slot'), parentTag: bar.parentElement.className || bar.parentElement.tagName };
  });
  assert.equal(slotInfo.slot, 'outer', '真机结构下应挂到滚动容器外: ' + JSON.stringify(slotInfo));

  // G：结构认不出时必须回退到旧挂载，且条仍在（宁可有死区，不丢条）。
  // 用一个没有滚动容器的宿主页面：composer 直接放在普通流里，任何祖先都不裁剪。
  const fallbackPage = await browser.newPage({ viewport: { width: 1280, height: 738 } });
  try {
    await fallbackPage.setContent(NO_SCROLL_HTML(ASSETS));
    await fallbackPage.waitForTimeout(1600);
    const fallback = await fallbackPage.evaluate(() => {
      const bars = [...document.querySelectorAll('.zsb-bar')];
      const bar = bars[bars.length - 1];
      const composer = document.querySelector('[data-testid="v4-composer"]');
      return {
        count: bars.length,
        slot: bar ? bar.getAttribute('data-zsb-slot') : null,
        // 回退后条应插在 composer 之后（同一父节点）
        parentIsComposerParent: bar ? bar.parentElement === composer.parentElement : false,
      };
    });
    assert.equal(fallback.count, 1, '回退挂载后仍应只有一条状态条: ' + JSON.stringify(fallback));
    assert.equal(fallback.slot, 'inner', '结构认不出时应回退到 inner: ' + JSON.stringify(fallback));
    assert.equal(fallback.parentIsComposerParent, true, '回退后条应插在 composer 之后: ' + JSON.stringify(fallback));
  } finally {
    await fallbackPage.close();
  }

  console.log('Passed composer-dock: 状态条在输入框下方、完整可见、重载与重复注入都不累积');
  await page.close();
} finally {
  await browser.close();
}
