'use strict';

/**
 * turn-stats.js 采样逻辑单测（node:test）——经 createTurnSampler 工厂注入假时钟与 readLength stub，
 * 测采样行为（2s 窗换算、无增量归零、新轮回落重置、自校准钩子、静默路径），不测 DOM。
 * 注：turn-stats.js 在浏览器为 IIFE 注入；node 环境额外导出工厂（契约偏差，见模块头注释与 CONTRACT.md）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTurnSampler, CONSTANTS } = require('../statusbar/turn-stats.js');

/** 组装采样器：传入可变 ctx（{t, len}），测试内直接改 ctx 字段后调 tick() */
function make(ctx) {
  const published = [];
  const sampler = createTurnSampler({
    readLength: () => ctx.len,
    now: () => ctx.t,
    publish: (s) => published.push(s),
  });
  return { sampler, published };
}

test('2s 采样窗内字符增量按每 token 2 字符换算；样本形状符合契约', () => {
  const ctx = { t: 0, len: 100 };
  const { sampler, published } = make(ctx);

  sampler.tick(); // 基线：t=0, len=100（首 tick 基线自身 delta=0，发布速度 0）
  ctx.t = 1000;
  ctx.len = 300;
  sampler.tick(); // 窗口 [0,1000]：delta 200 / 1s / 2 = 100 tok/s
  assert.equal(published[0].tokPerSec, 0); // 首 tick：基线尚未产生增量
  assert.equal(published[1].tokPerSec, 100);

  ctx.t = 2000;
  ctx.len = 500;
  sampler.tick(); // 窗口 [0,2000]：delta 400 / 2s / 2 = 100 tok/s
  const last = published[published.length - 1];
  assert.equal(last.tokPerSec, 100);
  assert.equal(last.estimated, true); // 估算态恒真（R3 视觉标识的依据）
  assert.equal(last.updatedAt, 2000);
  assert.equal(typeof last.tokPerSec, 'number');
});

test('无增量时速度归零而非冻结旧值', () => {
  const ctx = { t: 0, len: 100 };
  const { sampler, published } = make(ctx);
  sampler.tick();
  ctx.t = 1000;
  ctx.len = 500;
  sampler.tick();
  assert.equal(published[published.length - 1].tokPerSec, 200); // 400 字符/1s/2

  // 停止增长，推进到增量完全滑出 2s 窗口
  for (ctx.t = 1100; ctx.t <= 3100; ctx.t += 100) sampler.tick();
  const last = published[published.length - 1];
  assert.equal(last.tokPerSec, 0); // 归零，不冻结 200
  assert.equal(last.updatedAt, 1000);
});

test('文本长度回落视为新一轮：窗口重置、速度归零', () => {
  const ctx = { t: 0, len: 100 };
  const { sampler, published } = make(ctx);
  sampler.tick();
  ctx.t = 1000;
  ctx.len = 500;
  sampler.tick();
  assert.equal(published[published.length - 1].tokPerSec, 200);

  ctx.t = 1100;
  ctx.len = 200; // 新一轮开始（长度回落）
  sampler.tick();
  const last = published[published.length - 1];
  assert.equal(last.tokPerSec, 0); // 新轮从 0 开始，不把回落算成负/尖峰
  assert.equal(last.updatedAt, 1100);

  // 新轮恢复增长后正常计算（基线是回落后的 200）
  ctx.t = 2100;
  ctx.len = 600;
  sampler.tick(); // delta 400 / 1s / 2 = 200
  assert.equal(published[published.length - 1].tokPerSec, 200);
});

test('setCharsPerToken / calibrateFromTurn：自校准钩子生效并钳制到合理区间', () => {
  const ctx = { t: 0, len: 100 };
  const { sampler, published } = make(ctx);
  sampler.tick();

  // 校准：上轮 100 token / 400 字符 → 每 token 4 字符
  assert.equal(sampler.calibrateFromTurn({ outputTokens: 100, charCount: 400 }), 4);

  ctx.t = 1000;
  ctx.len = 500; // delta 400 字符 / 4 / 1s = 100 tok/s（未校准则为 200）
  sampler.tick();
  assert.equal(published[published.length - 1].tokPerSec, 100);

  // 钳制：上限 10、下限 0.5、非法值回默认 2
  assert.equal(sampler.setCharsPerToken(9999), CONSTANTS.CHARS_PER_TOKEN_MAX);
  assert.equal(sampler.setCharsPerToken(0.01), CONSTANTS.CHARS_PER_TOKEN_MIN);
  assert.equal(sampler.setCharsPerToken(-1), CONSTANTS.DEFAULT_CHARS_PER_TOKEN);
  assert.equal(sampler.calibrateFromTurn({ outputTokens: 0, charCount: 400 }), CONSTANTS.DEFAULT_CHARS_PER_TOKEN); // 坏输入不动
});

test('readLength 返回 null（选择器失效）时静默：不发布、不残留旧值发布', () => {
  const ctx = { t: 0, len: 100 };
  const { sampler, published } = make(ctx);
  sampler.tick();
  assert.equal(published.length, 1);

  ctx.len = null; // 模拟容器消失
  assert.equal(sampler.tick(), null);
  assert.equal(published.length, 1); // 无新发布
});

test('窗口滑动：速度按窗口内增量计算，旧增量不永久计入', () => {
  const ctx = { t: 0, len: 0 };
  const { sampler, published } = make(ctx);
  sampler.tick(); // 基线 t=0 len=0
  ctx.t = 1000;
  ctx.len = 400;
  sampler.tick(); // 400/1s/2 = 200
  assert.equal(published[published.length - 1].tokPerSec, 200);
  ctx.t = 2000;
  ctx.len = 800;
  sampler.tick(); // 全窗 [0,2000] delta 800/2s/2 = 200
  assert.equal(published[published.length - 1].tokPerSec, 200);
  // 此后维持速度：窗口 [200,2200] 内继续等速增长
  ctx.t = 2200;
  ctx.len = 880;
  sampler.tick();
  // 保留跨窗口左界的 t=0 基线：880 字符 / 2.2s / 2 = 200 tok/s
  assert.ok(Math.abs(published[published.length - 1].tokPerSec - 200) < 1e-9);
});

test('reset：显式重置后基线重建', () => {
  const ctx = { t: 0, len: 100 };
  const { sampler, published } = make(ctx);
  sampler.tick();
  ctx.t = 500;
  ctx.len = 300;
  sampler.tick();
  assert.equal(published[published.length - 1].tokPerSec, 200);

  ctx.t = 600;
  sampler.reset(); // 基线重建为 (600, 300)
  ctx.t = 1600;
  ctx.len = 500;
  sampler.tick(); // delta 200/1s/2 = 100
  assert.equal(published[published.length - 1].tokPerSec, 100);
});


test('中英混排按文字类型估算；显式校准覆盖估算系数', () => {
  const ctx = { t: 0, len: '' };
  const { sampler } = make(ctx);
  sampler.tick();
  ctx.t = 1000;
  ctx.len = '中文测试'.repeat(25);
  assert.equal(sampler.tick().tokPerSec, 100);
  ctx.t = 2000;
  ctx.len += 'abcd'.repeat(100);
  assert.equal(sampler.tick().tokPerSec, 100);
  sampler.calibrateFromTurn({ outputTokens: 100, charCount: 400 });
  ctx.t = 3000;
  ctx.len += '中文测试'.repeat(100);
  assert.equal(sampler.tick().tokPerSec, 100);
});

test('空闲样本会过期，不持续遮住完成态会话均值', () => {
  const ctx = { t: 0, len: 0 };
  const { sampler } = make(ctx);
  sampler.tick();
  ctx.t = 1000;
  ctx.len = 200;
  sampler.tick();
  ctx.t = 5000;
  const idle = sampler.tick();
  assert.equal(idle.tokPerSec, 0);
  assert.equal(idle.updatedAt, 1000);
  assert.ok(ctx.t - idle.updatedAt >= 3000);
});

test('稀疏采样保留窗口基线，不把生成速度错误归零', () => {
  const ctx = { t: 0, len: 0 };
  const { sampler } = make(ctx);
  sampler.tick();
  ctx.t = 2100;
  ctx.len = 420;
  assert.equal(sampler.tick().tokPerSec, 100);
});
