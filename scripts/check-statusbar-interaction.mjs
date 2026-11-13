import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { pageHtml, CHROME } from './render-statusbar.mjs';

const turnSource = fs.readFileSync(new URL('../statusbar/turn-stats.js', import.meta.url), 'utf8');
const browser = await chromium.launch({ executablePath: CHROME });
try {
  for (const theme of ['light', 'dark']) {
    for (const alignment of ['flow', 'space-between', 'space-around', 'space-evenly', 'center', 'flex-end']) {
      const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
      await page.setContent(pageHtml(theme, 'bar'));
      await page.evaluate(() => {
        window.resizeErrors = [];
        window.addEventListener('error', event => {
          if (event.message.includes('ResizeObserver')) window.resizeErrors.push(event.message);
        });
        document.querySelector('.bubble').setAttribute('data-zcode-stream', '');
        const composer = document.querySelector('[data-zcode-composer]');
        composer.removeAttribute('data-zcode-composer');
        composer.setAttribute('data-v4-composer', '');
      });
      await page.addScriptTag({ content: turnSource });
      await page.waitForTimeout(100);
      await page.evaluate(alignment => {
        window.originalBar = document.querySelector('.zsb-bar');
        const composer = document.querySelector('[data-v4-composer]');
        composer.textContent = '';
        composer.innerHTML = '<section data-tool="AskUserQuestion"><h2>选择实现方式</h2>' +
          '<label><input type="radio" name="answer" value="a">方案 A</label>' +
          '<label><input type="radio" name="answer" value="b">方案 B</label>' +
          '<input aria-label="补充回答"></section>';
        composer.style.minHeight = '300px';
        if (alignment !== 'flow') {
          composer.parentElement.style.cssText = 'display:flex;flex-direction:column;justify-content:' + alignment + ';height:350px;padding-bottom:16px';
        }
      }, alignment);
      await page.getByLabel('方案 B').check();
      await page.getByLabel('补充回答').fill('保留正在输入的回答');
      await page.waitForTimeout(250);
      const trace = await page.evaluate(async () => {
        const positions = [];
        const margins = new Set();
        const bar = document.querySelector('.zsb-bar');
        const question = document.querySelector('[data-tool="AskUserQuestion"]');
        const publish = setInterval(() => {
          window.dispatchEvent(new CustomEvent('zcode-statusbar:session', {
            detail: { totalTokens: 432100, turns: 9, steps: 8, sessionAvgTokPerSec: 100 },
          }));
        }, 150);
        const until = performance.now() + 1600;
        while (performance.now() < until) {
          await new Promise(requestAnimationFrame);
          positions.push([bar.getBoundingClientRect().top, question.getBoundingClientRect().top]);
          margins.add(bar.style.marginBottom);
        }
        clearInterval(publish);
        return {
          frames: positions.length,
          barDrift: Math.max(...positions.map(p => p[0])) - Math.min(...positions.map(p => p[0])),
          questionDrift: Math.max(...positions.map(p => p[1])) - Math.min(...positions.map(p => p[1])),
          margins: [...margins],
          sameBar: bar === window.originalBar,
          bars: document.querySelectorAll('.zsb-bar').length,
          answer: document.querySelector('[aria-label="补充回答"]').value,
          focused: document.activeElement.getAttribute('aria-label'),
          selected: document.querySelector('[name="answer"]:checked')?.value,
          usage: bar.querySelector('[data-zsb-pill="usage"]').textContent,
          errors: window.resizeErrors,
        };
      });
      const context = JSON.stringify({ theme, alignment, ...trace });
      assert.ok(trace.frames >= 30, context);
      assert.ok(trace.barDrift <= 0.75 && trace.questionDrift <= 0.75, context);
      assert.equal(trace.margins.length, 1, context);
      assert.equal(trace.sameBar, true, context);
      assert.equal(trace.bars, 1, context);
      assert.equal(trace.answer, '保留正在输入的回答', context);
      assert.equal(trace.focused, '补充回答', context);
      assert.equal(trace.selected, 'b', context);
      assert.match(trace.usage, /432K tok/, context);
      assert.deepEqual(trace.errors, [], context);
      if (alignment !== 'flow') assert.deepEqual(trace.margins, [''], context);
      await page.evaluate(() => {
        const composer = document.querySelector('[data-v4-composer]');
        composer.textContent = '输入消息…';
        composer.style.minHeight = '';
        composer.parentElement.style.cssText = '';
      });
      await page.waitForTimeout(250);
      const restored = await page.evaluate(() => {
        const bar = document.querySelector('.zsb-bar');
        const composer = document.querySelector('[data-v4-composer]');
        const pane = document.querySelector('[data-session-id]');
        return {
          sameBar: bar === window.originalBar,
          top: bar.getBoundingClientRect().top - composer.getBoundingClientRect().bottom,
          bottom: pane.getBoundingClientRect().bottom - parseFloat(getComputedStyle(pane).borderBottomWidth) - bar.getBoundingClientRect().bottom,
        };
      });
      assert.equal(restored.sameBar, true, context);
      assert.ok(Math.abs(restored.top - 4) <= 0.75 && Math.abs(restored.bottom - 4) <= 0.75, JSON.stringify(restored));
      console.log('Passed AskUserQuestion ' + context);
      await page.close();
    }
  }
} finally {
  await browser.close();
}
