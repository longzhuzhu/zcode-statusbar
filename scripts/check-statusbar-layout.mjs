import { chromium } from 'playwright';
import { pageHtml, CHROME } from './render-statusbar.mjs';

const cases = [];
for (const theme of ['light', 'dark']) {
  for (const width of [320, 800]) {
    for (const gutter of [0, 4, 8, 40]) {
      for (const padding of [0, 4, 16, 32]) {
        cases.push({ theme, width, gutter, padding });
      }
    }
  }
}
cases.push(
  { nested: true, gutter: 8, padding: 16 },
  { zoom: 1.25, nested: true, gutter: 8, padding: 16 },
  { zoom: 1.5, gutter: 40, padding: 32 },
  { fixed: true, gutter: 8, padding: 16 },
  { fixed: true, upperPane: true, gutter: 8, padding: 16 },
  { borderless: true, gutter: 8, padding: 0 },
  { borderless: true, gutter: 40, padding: 16 },
  { borderless: true, nested: true, gutter: 8, padding: 16 },
  { clipped: true, gutter: 8, padding: 16 },
  { officialAnchor: true, gutter: 8, padding: 16 },
  { split: true, gutter: 8, padding: 16 },
  { footer: true, gutter: 8, padding: 16 },
  { unknownSpace: true, gutter: 8, padding: 16 },
  { dynamic: true, nested: true, gutter: 8, padding: 16 },
);

function setup(config) {
  const pane = document.querySelector('[data-session-id]');
  const dock = document.querySelector('.dock');
  document.querySelector('.stage').style.paddingBottom = config.gutter + 'px';
  dock.style.paddingBottom = config.padding + 'px';
  if (config.officialAnchor) {
    const composer = pane.querySelector('[data-zcode-composer]');
    composer.removeAttribute('data-zcode-composer');
    composer.setAttribute('data-v4-composer', '');
  }
  if (config.borderless) {
    pane.style.borderWidth = '0';
    pane.style.paddingBottom = '0';
  }
  if (config.clipped) pane.style.overflow = 'hidden';
  if (config.zoom) pane.style.zoom = config.zoom;
  if (config.nested) {
    for (let i = 0; i < 2; i++) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'padding-bottom:5px;border-bottom:2px solid transparent;margin-bottom:3px';
      dock.parentElement.insertBefore(wrap, dock);
      wrap.appendChild(dock);
    }
  }
  if (config.fixed || config.unknownSpace) {
    pane.style.height = '480px';
    if (config.fixed) {
      pane.style.display = 'flex';
      pane.style.flexDirection = 'column';
      dock.style.marginTop = 'auto';
    }
  }
  if (config.split) {
    const other = pane.cloneNode(true);
    other.dataset.sessionId = 'sess_other';
    other.style.height = '340px';
    other.style.marginLeft = '8px';
    pane.parentElement.appendChild(other);
    pane.parentElement.style.flexDirection = 'row';
    pane.parentElement.style.alignItems = 'flex-end';
  }
  if (config.upperPane) {
    pane.parentElement.style.justifyContent = 'flex-start';
    pane.style.height = '320px';
    const other = document.createElement('div');
    other.style.cssText = 'height:200px;margin-top:16px';
    other.textContent = 'Another session pane';
    pane.parentElement.appendChild(other);
  }
  if (config.footer) {
    const footer = document.createElement('div');
    footer.className = 'fixture-footer';
    footer.textContent = 'Session footer';
    footer.style.height = '24px';
    pane.appendChild(footer);
  }
}

async function checkLayouts({ baseHtml, cases, setupSource }) {
  const results = [];
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  // 弹层水平锚定契约：弹层中心对齐被点 pill 中心；越界时夹进视口留 8px；
  // 锚点 pill 被降级阶梯隐藏时弹层自动关闭。
  // 分两段验证：先宽视口（不触发夹取）验居中，再逐步收窄验夹取与自动关闭。
  async function checkPopAnchors(frame, config) {
    const doc = frame.contentDocument;
    const pane = doc.querySelector('[data-session-id]');
    const bar = pane.querySelector('.zsb-bar');
    const pop = pane.querySelector('.zsb-pop');
    const usagePill = bar.querySelector('[data-zsb-pill="usage"]');
    const pills = ['activity', 'usage', 'subagent', 'context', 'gear'];
    const fail = message => {
      throw new Error(message + ' ' + JSON.stringify({ config, anchor: pop.dataset.zsbAnchor }));
    };
    const openOn = name => {
      // 已开在同一 pill 上就不再点（再点是 toggle 关闭）
      if (pop.hidden || pop.dataset.zsbAnchor !== name) bar.querySelector('[data-zsb-pill="' + name + '"]').click();
      if (pop.hidden) fail('Popover did not open on ' + name);
      if (pop.dataset.zsbAnchor !== name) fail('Popover anchored to ' + pop.dataset.zsbAnchor + ' instead of ' + name);
    };
    const centerDeviation = pill => {
      const a = pill.getBoundingClientRect();
      const b = pop.getBoundingClientRect();
      return { dx: Math.abs(a.left + a.width / 2 - (b.left + b.width / 2)), box: b };
    };
    // 未夹取的 pill 中心必被严格对准：没有这条，整个用例会被「全部夹取」蒙混过关
    const expectCentered = (name) => {
      const pill = bar.querySelector('[data-zsb-pill="' + name + '"]');
      if (!pill || !pill.offsetWidth) return false;
      openOn(name);
      const { dx, box } = centerDeviation(pill);
      const viewportW = doc.documentElement.clientWidth;
      if (Math.abs(box.left - 8) < 1 || Math.abs(box.right - (viewportW - 8)) < 1) return false; // 被夹取
      if (dx > 1) fail('Popover is not centered on its pill (' + name + ', dx=' + dx + ')');
      return true;
    };
    const expectContained = name => {
      const pill = bar.querySelector('[data-zsb-pill="' + name + '"]');
      if (!pill || !pill.offsetWidth) return;
      openOn(name);
      const { box } = centerDeviation(pill);
      const viewportW = doc.documentElement.clientWidth;
      if (box.left < 8 - 0.5) fail('Popover overflows the left edge (' + name + ')');
      if (box.right > viewportW - 8 + 0.5) fail('Popover overflows the right edge (' + name + ')');
    };

    // 1) 宽视口：中间的 pill 必须严格居中（activity/gear 在该宽度下会被夹取，只验完整可见）
    frame.style.width = '800px';
    await wait(150);
    if (!expectCentered('usage')) fail('usage pill unavailable in the wide fixture');
    if (!expectCentered('subagent')) fail('subagent pill unavailable in the wide fixture');
    for (const name of pills) expectContained(name);

    // 2) 收窄：贴边 pill 的弹层被夹进视口，仍整只可见
    frame.style.width = '480px';
    await wait(150);
    for (const name of ['activity', 'gear']) expectContained(name);

    // 3) 继续收窄到 usage pill 被 data-fit 隐藏：弹层必须自动关闭且不留锚点标记
    if (usagePill && usagePill.offsetWidth) openOn('usage');
    if (!pop.hidden) {
      for (const width of [360, 320, 280, 240, 200]) {
        frame.style.width = width + 'px';
        await wait(150);
        if (!usagePill.offsetWidth) break;
      }
      if (!usagePill.offsetWidth) {
        if (!pop.hidden) fail('Popover stayed open after its anchor pill was hidden');
        if (pop.getAttribute('data-zsb-anchor')) fail('Anchor marker left behind after auto-close');
      }
    }
  }

  function check(frame, config) {
    const doc = frame.contentDocument;
    const pane = doc.querySelector('[data-session-id]');
    const bar = pane.querySelector('.zsb-bar');
    if (!bar) throw new Error('Statusbar did not mount');
    const style = frame.contentWindow.getComputedStyle(pane);
    const scale = bar.getBoundingClientRect().height / bar.offsetHeight;
    const paneBottom = pane.getBoundingClientRect().bottom - parseFloat(style.borderBottomWidth) * scale;
    const box = bar.getBoundingClientRect();
    const composer = pane.querySelector('[data-zcode-composer],[data-v4-composer]').getBoundingClientRect();
    const top = (box.top - composer.bottom) / scale;
    const bottom = (paneBottom - box.bottom) / scale;
    const fail = message => { throw new Error(message + ' ' + JSON.stringify({ config, top, bottom })); };
    if (config.footer || config.unknownSpace) {
      if (bar.style.marginBottom) fail('Unrecognized content must keep normal flow');
      if (config.footer && box.bottom > doc.querySelector('.fixture-footer').getBoundingClientRect().top) fail('Footer overlap');
    } else if (Math.abs(top - bottom) > 0.75 || Math.abs(top - 4) > 0.75) {
      fail('Unequal pane spacing');
    }
    if (box.bottom > paneBottom + 0.75) fail('Statusbar extends beyond the pane');
    if (pane.querySelectorAll('.zsb-bar').length !== 1) fail('Duplicate statusbars');
    return { top, bottom };
  }
  for (let index = 0; index < cases.length; index++) {
    const config = { width: 800, gutter: 8, padding: 16, ...cases[index] };
    const frame = document.createElement('iframe');
    frame.style.cssText = 'display:block;border:0;width:' + config.width + 'px;height:700px';
    const themeHtml = baseHtml[config.theme || 'light'];
    const html = themeHtml.replace('<script>', '<script>(' + setupSource + ')(' + JSON.stringify(config) + ');</' + 'script><script>');
    const loaded = new Promise(resolve => frame.onload = resolve);
    frame.srcdoc = html;
    document.body.appendChild(frame);
    await loaded;
    await wait(40);
    const pane = frame.contentDocument.querySelector('[data-session-id]');
    const hostNodes = [pane, ...pane.querySelectorAll('.dock,.composer')];
    const hostStyles = hostNodes.map(node => node.getAttribute('style'));
    try {
      const initial = check(frame, config);
      if (config.dynamic) {
        const win = frame.contentWindow;
        const refresh = async () => {
          win.dispatchEvent(new win.CustomEvent('zcode-statusbar:turn', {
            detail: { tokPerSec: 80, updatedAt: Date.now(), estimated: true },
          }));
          await wait(40);
          check(frame, config);
        };
        pane.parentElement.style.paddingBottom = '64px';
        await refresh();
        frame.style.width = '360px';
        await refresh();
        pane.querySelector('.composer').style.minHeight = '160px';
        await refresh();
        pane.style.paddingBottom = '12px';
        await refresh();
        const composer = pane.querySelector('[data-zcode-composer]');
        composer.replaceWith(composer.cloneNode(true));
        await wait(1100);
        check(frame, config);
        pane.querySelector('[data-zsb-pill="activity"]').click();
        const pop = pane.querySelector('.zsb-pop').getBoundingClientRect();
        const bar = pane.querySelector('.zsb-bar').getBoundingClientRect();
        const scale = bar.height / pane.querySelector('.zsb-bar').offsetHeight;
        if (Math.abs((bar.top - pop.bottom) / scale - 10) > 0.75) throw new Error('Popover gap changed');
        await checkPopAnchors(frame, config);
      } else {
        await wait(80);
        const steady = check(frame, config);
        if (Math.abs(initial.bottom - steady.bottom) > 0.5) throw new Error('Layout drift');
        if (hostNodes.some((node, i) => node.getAttribute('style') !== hostStyles[i])) throw new Error('Host styles changed');
      }
      results.push({ config, ...initial });
    } catch (error) {
      results.push({ config, error: String(error) });
    }
    frame.remove();
  }
  return results;
}

const baseHtml = { light: pageHtml('light', 'bar'), dark: pageHtml('dark', 'bar') };
const browser = await chromium.launch({ executablePath: CHROME });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await page.goto('about:blank');
  const results = await page.evaluate(checkLayouts, { baseHtml, cases, setupSource: setup.toString() });
  const failed = results.filter(item => item.error);
  if (failed.length) {
    console.error(JSON.stringify(failed, null, 2));
    process.exitCode = 1;
  } else {
    console.log('Passed ' + results.length + ' pane layout scenarios');
  }
} finally {
  await browser.close();
}
