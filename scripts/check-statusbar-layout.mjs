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
