/**
 * tests/ramp.test.cjs —— 色阶引擎单测（node:test）
 * 运行：node --test tests/ramp.test.cjs
 *
 * 覆盖面（对应实现任务清单）：
 *   1. 锚点值精确返回锚点色；
 *   2. 域外钳制（超上界封顶）与无效输入中性灰（含负数，口径见下）；
 *   3. 单调性采样（速度升序色相不回退、上下文同）；
 *   4. 插值中点落在两锚点之间（hsl 比较）；
 *   5. 两条色阶互相独立。
 *
 * 注：测试侧独立实现 hex→hsl 转换与色相展开，不复用被测模块内部逻辑，
 * 保证验证独立性。负数输入返回中性灰而非钳制到域下界——口径依据实现任务
 * "NaN/负数/非有限值返回中性灰"（与模块顶部偏差记录 1 一致）。
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  speedColor,
  contextColor,
  SPEED_ANCHORS,
  CONTEXT_ANCHORS,
} = require('../statusbar/ramp.js');

/** 中性灰兜底色（与模块内 NEUTRAL_COLOR 约定值一致；模块未导出，此处按约定断言） */
const NEUTRAL = '#8c8c8c';

/** 色相/饱和度/明度断言容差：hex 输出为 8bit 量化，hsl 往返误差需留余量 */
const H_TOL = 3;
const SL_TOL = 0.02;

/**
 * 测试侧独立的 hex→hsl 转换（h ∈ [0,360)，s/l ∈ [0,1]）。
 * 同时兼任输出格式校验：非 6 位 hex 直接断言失败。
 */
function hexToHsl(hex) {
  const m = /^#([0-9a-f]{6})$/.exec(hex);
  assert.ok(m, `输出应为 6 位小写 hex，实际：${String(hex)}`);
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) {
    return { h: 0, s: 0, l };
  }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) {
    h = ((g - b) / d) % 6;
  } else if (max === g) {
    h = (b - r) / d + 2;
  } else {
    h = (r - g) / d + 4;
  }
  h *= 60;
  if (h < 0) {
    h += 360;
  }
  return { h, s, l };
}

/**
 * 把色相 h 平移到距 prev 最近的等价表示（展开环形坐标），
 * 用于跨 0°/360° 的单调性与中点比较。
 */
function unwrap(prev, h) {
  let x = h;
  while (x - prev > 180) {
    x -= 360;
  }
  while (prev - x > 180) {
    x += 360;
  }
  return x;
}

test('输出格式：任意采样均为 6 位小写 hex', () => {
  const speedSamples = [0, 1, 75, 150, 323, 800, 1400, 1999, 2000, 5000];
  const ctxSamples = [0, 0.01, 0.25, 0.5, 0.7, 0.9, 0.95, 1, 1.5];
  for (const v of speedSamples) {
    assert.match(speedColor(v), /^#[0-9a-f]{6}$/);
  }
  for (const p of ctxSamples) {
    assert.match(contextColor(p), /^#[0-9a-f]{6}$/);
  }
});

test('锚点值精确返回锚点色（速度 + 上下文全锚点）', () => {
  for (const a of SPEED_ANCHORS) {
    assert.equal(speedColor(a.v), a.c, `speedColor(${a.v}) 应精确等于 ${a.c}`);
  }
  for (const a of CONTEXT_ANCHORS) {
    assert.equal(contextColor(a.p), a.c, `contextColor(${a.p}) 应精确等于 ${a.c}`);
  }
});

test('域外钳制：超上界封顶为末端锚点色', () => {
  // 速度域 [0, 2000]：远超上界与边界外一点都封顶为紫
  const purple = SPEED_ANCHORS[SPEED_ANCHORS.length - 1].c;
  assert.equal(speedColor(9999), purple);
  assert.equal(speedColor(1e9), purple);
  assert.equal(speedColor(2000.0001), purple);
  // 上下文域 [0, 1]：封顶为深红
  const darkRed = CONTEXT_ANCHORS[CONTEXT_ANCHORS.length - 1].c;
  assert.equal(contextColor(1.2), darkRed);
  assert.equal(contextColor(100), darkRed);
});

test('无效输入返回中性灰：NaN / ±Infinity / 负数 / 非 number', () => {
  // 负数归灰的口径：负 tok/s、负占用率是无效数据而非"极慢/空上下文"，
  // 钳制到域下界会把坏数据渲染成色阶首色（红/绿），违背色阶语义。
  const badNumbers = [NaN, Infinity, -Infinity, -50, -0.1];
  for (const bad of badNumbers) {
    assert.equal(speedColor(bad), NEUTRAL, `speedColor(${bad}) 应返回中性灰`);
    assert.equal(contextColor(bad), NEUTRAL, `contextColor(${bad}) 应返回中性灰`);
  }
  // 非 number 输入同样兜底为灰（契约签名为 number，此处验证不抛错、不产怪色）
  for (const bad of [undefined, null, '100', {}, true]) {
    assert.equal(speedColor(bad), NEUTRAL, `speedColor(${String(bad)}) 应返回中性灰`);
    assert.equal(contextColor(bad), NEUTRAL, `contextColor(${String(bad)}) 应返回中性灰`);
  }
});

test('速度色阶：采样升序色相单调不回退', () => {
  // 采样 0..2000（步长 25），色相沿最短路径展开后应单调非递减（红→绿→蓝→紫）
  let prev = hexToHsl(speedColor(0)).h;
  for (let v = 25; v <= 2000; v += 25) {
    const h = hexToHsl(speedColor(v)).h;
    const cur = unwrap(prev, h);
    assert.ok(
      cur >= prev - H_TOL,
      `v=${v} 色相回退：${prev.toFixed(2)}° → ${cur.toFixed(2)}°`,
    );
    prev = cur;
  }
});

test('上下文色阶：采样升序色相单调不回退（方向为递减）', () => {
  // 采样 0..1（步长 0.01），色相展开后应单调非递增（绿→黄→红→深红）
  let prev = hexToHsl(contextColor(0)).h;
  for (let i = 1; i <= 100; i += 1) {
    const p = i / 100;
    const h = hexToHsl(contextColor(p)).h;
    const cur = unwrap(prev, h);
    assert.ok(
      cur <= prev + H_TOL,
      `p=${p} 色相回退：${prev.toFixed(2)}° → ${cur.toFixed(2)}°`,
    );
    prev = cur;
  }
});

/**
 * 中点断言：getColor(mid) 的 h/s/l 应落在锚点 hexA、hexB 之间（hsl 比较）。
 * h 先展开到 hexA 的坐标下再比较，兼容跨 0°/360° 的段。
 */
function assertMidpoint(getColor, mid, hexA, hexB, label) {
  const a = hexToHsl(hexA);
  const b = hexToHsl(hexB);
  const m = hexToHsl(getColor(mid));
  const bU = unwrap(a.h, b.h); // b 沿最短路径展开到 a 的坐标系
  const mU = unwrap(a.h, m.h);
  const lo = Math.min(a.h, bU);
  const hi = Math.max(a.h, bU);
  assert.ok(
    mU >= lo - H_TOL && mU <= hi + H_TOL,
    `${label}：h=${m.h.toFixed(1)}° 不在两端 [${lo.toFixed(1)}°, ${hi.toFixed(1)}°] 内`,
  );
  assert.ok(
    Math.abs(mU - (a.h + bU) / 2) <= H_TOL,
    `${label}：h=${mU.toFixed(1)}° 偏离段中点 ${(a.h + bU) / 2}° 超容差`,
  );
  assert.ok(
    m.s >= Math.min(a.s, b.s) - SL_TOL && m.s <= Math.max(a.s, b.s) + SL_TOL,
    `${label}：s=${m.s.toFixed(3)} 不在两端饱和度之间`,
  );
  assert.ok(
    m.l >= Math.min(a.l, b.l) - SL_TOL && m.l <= Math.max(a.l, b.l) + SL_TOL,
    `${label}：l=${m.l.toFixed(3)} 不在两端明度之间`,
  );
}

test('插值中点落在两锚点之间（hsl 比较，速度 3 段）', () => {
  // 0–150 段中点（跨 0°/360°：红 358° → 绿 131° 沿 +133° 方向）
  assertMidpoint(speedColor, 75, SPEED_ANCHORS[0].c, SPEED_ANCHORS[1].c, '速度 75');
  // 150–800 段中点（绿 → 蓝）
  assertMidpoint(speedColor, 475, SPEED_ANCHORS[1].c, SPEED_ANCHORS[2].c, '速度 475');
  // 800–2000 段中点（蓝 → 紫）
  assertMidpoint(speedColor, 1400, SPEED_ANCHORS[2].c, SPEED_ANCHORS[3].c, '速度 1400');
});

test('插值中点落在两锚点之间（hsl 比较，上下文 3 段）', () => {
  assertMidpoint(contextColor, 0.25, CONTEXT_ANCHORS[0].c, CONTEXT_ANCHORS[1].c, '占用 0.25');
  // 0.5–0.9 段中点（黄 60° → 红 358° 沿 -62° 方向，跨 0° 边界）
  assertMidpoint(contextColor, 0.7, CONTEXT_ANCHORS[1].c, CONTEXT_ANCHORS[2].c, '占用 0.7');
  assertMidpoint(contextColor, 0.95, CONTEXT_ANCHORS[2].c, CONTEXT_ANCHORS[3].c, '占用 0.95');
});

test('两条色阶互相独立', () => {
  // 键名域不同：速度锚点用 v（tok/s），上下文锚点用 p（0–1 占用比）
  for (const a of SPEED_ANCHORS) {
    assert.ok('v' in a && 'c' in a && !('p' in a), '速度锚点应含 v/c 且不含 p');
  }
  for (const a of CONTEXT_ANCHORS) {
    assert.ok('p' in a && 'c' in a && !('v' in a), '上下文锚点应含 p/c 且不含 v');
  }
  assert.notDeepEqual(
    SPEED_ANCHORS.map((a) => a.c),
    CONTEXT_ANCHORS.map((a) => a.c),
    '两条色阶的锚点色集合不应完全相同',
  );
  // 同一数值入参在两条色阶下映射不同：0.5 tok/s 落在速度阶极慢红区，0.5 占用是黄
  assert.notEqual(speedColor(0.5), contextColor(0.5));
  // 上下文阶全程不出现速度阶特有的蓝色锚点（上下文链为绿→黄→红→深红，不含蓝 240°）
  for (let i = 0; i <= 100; i += 1) {
    const m = hexToHsl(contextColor(i / 100));
    const blueDist = Math.min(Math.abs(m.h - 240), 360 - Math.abs(m.h - 240));
    assert.ok(blueDist > 30, `contextColor(${i / 100}) 色相意外接近蓝区：${m.h.toFixed(1)}°`);
  }
});

test('锚点常量冻结，防运行时篡改', () => {
  assert.ok(Object.isFrozen(SPEED_ANCHORS), 'SPEED_ANCHORS 应被冻结');
  assert.ok(Object.isFrozen(CONTEXT_ANCHORS), 'CONTEXT_ANCHORS 应被冻结');
  for (const a of SPEED_ANCHORS) {
    assert.ok(Object.isFrozen(a), '速度锚点元素应被冻结');
  }
  for (const a of CONTEXT_ANCHORS) {
    assert.ok(Object.isFrozen(a), '上下文锚点元素应被冻结');
  }
});

test('纯函数：同输入重复调用输出一致', () => {
  for (const v of [0, 42, 137.5, 800, 1723]) {
    assert.equal(speedColor(v), speedColor(v), `speedColor(${v}) 应无状态、可复现`);
  }
  for (const p of [0, 0.13, 0.5, 0.77, 1]) {
    assert.equal(contextColor(p), contextColor(p), `contextColor(${p}) 应无状态、可复现`);
  }
});
