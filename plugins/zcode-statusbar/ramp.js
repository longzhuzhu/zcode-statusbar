/**
 * statusbar/ramp.js —— 色阶引擎
 *
 * 纯函数、无 DOM、无第三方依赖。对应契约：design.md §3 / §9、prd.md R3 / R4。
 *
 * 两条互相独立的色阶：
 *   - speedColor(tokPerSec)：0 红 → 150 绿 → 300 蓝 → ≥500 紫（封顶）；
 *   - contextColor(pct)：入参 0–1（占用比例），0 绿 → 0.5 黄 → 0.9 红 → 1 深红。
 *
 * 插值在 hsl 空间分段线性进行：rgb 直接插值会穿过低饱和灰区产生脏色，
 * hsl 插值保证过渡段饱和度/明度平滑；色相沿最短环向路径插值，避免跨 0°/360° 绕远路。
 * 输出统一为 6 位小写 hex（契约未规定输出格式；hex 在 CSS/SVG 描边场景兼容性最好，
 * 也便于与设计稿对照调试）。
 *
 * ---- 实现偏差记录（交检查代理核对）----
 * 1. 负数输入返回中性灰，而非钳制到域下界：负 tok/s、负占用率属于无效数据而非
 *    "极慢/空上下文"，钳制会把坏数据渲染成色阶首色、违背色阶语义。依据实现任务
 *    "NaN/负数/非有限值返回中性灰"的口径；prd 测试清单将 -50/-0.1 列于"域外钳制"
 *    括号内，两处表述冲突，此处按实现任务口径执行，测试同此口径。
 * 2. 估算态呼吸透明度动画、tooltip 声明等由 CSS 与 statusbar.js 承担（design.md §3
 *    原文），本模块不涉及。
 * 3. 中性灰常量 NEUTRAL_COLOR 保持模块私有（契约仅要求导出锚点常量与两条映射函数），
 *    测试按约定值断言；如 statusbar.js 需要复用可再提升为导出项。
 */

'use strict';

/* ============================ 常量区 ============================ */

/**
 * 中性灰（无效输入兜底色）：NaN / ±Infinity / 负数 / 非 number 一律返回此色。
 * 语义对齐宿主 foreground-subtle（数字基色）；宿主未公开该变量的具体色值，
 * 先取无色相中性灰 #8c8c8c，待实机取 foreground-subtle 实际渲染色后固化。
 */
const NEUTRAL_COLOR = '#8c8c8c';

/**
 * 速度色阶锚点（tok/s → 颜色），分段线性插值，≥500 封顶为紫。
 * 语义：0 极慢（红）→ 150 正常（绿）→ 300 快（蓝）→ 500 极快（紫）。
 * 域取实机会话速度分布：常见几十~几百 tok/s，原 2000 档位的蓝→紫段形同虚设，
 * 按需求把极快档压缩到 500 封顶。锚点色值为合理缺省，待实机深浅主题对比度校验后固化。
 */
const SPEED_ANCHORS = Object.freeze([
  Object.freeze({ v: 0, c: '#ce3038' }),   // 红：极慢
  Object.freeze({ v: 150, c: '#27853d' }), // 绿：正常
  Object.freeze({ v: 300, c: '#0879d1' }), // 蓝：快
  Object.freeze({ v: 500, c: '#7c3db0' }), // 紫：极快（≥500 封顶）
]);

/**
 * 上下文色阶锚点（占用比例 0–1 → 颜色），叠加于官方上下文圆环描边。
 * 语义：0 空（绿）→ 0.5 半满（黄）→ 0.9 临界（红）→ 1 满（深红）；
 * 深红比红更暗沉，表达"窗口将尽"的临终强警示。
 * 锚点色值为合理缺省，待实机深浅主题对比度校验后固化。
 */
const CONTEXT_ANCHORS = Object.freeze([
  Object.freeze({ p: 0, c: '#27853d' }),   // 绿：空
  Object.freeze({ p: 0.5, c: '#bd7900' }), // 黄：半满
  Object.freeze({ p: 0.9, c: '#ce3038' }), // 红：临界
  Object.freeze({ p: 1, c: '#901035' }),   // 深红：满（临终警示）
]);

/* ============================ 内部工具 ============================ */

/**
 * hex → {h, s, l}（h ∈ [0,360)，s/l ∈ [0,1]）。
 * 仅供模块内部使用（入参为受控的锚点常量），格式非法时直接抛错、快速失败。
 */
function hexToHsl(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`[ramp] 非法 hex 颜色值：${String(hex)}`);
  }
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) {
    return { h: 0, s: 0, l }; // 无色相（纯灰），色相值无意义
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
 * hsl → 6 位小写 hex。h 允许任意实数（插值中间值可能超出 [0,360)，内部回绕）。
 * 分量先钳制到 [0,255] 再转字符串，避免浮点误差产生 "100" 这类三位段。
 */
function hslToHex(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) {
    r = c; g = x;
  } else if (hue < 120) {
    r = x; g = c;
  } else if (hue < 180) {
    g = c; b = x;
  } else if (hue < 240) {
    g = x; b = c;
  } else if (hue < 300) {
    r = x; b = c;
  } else {
    r = c; b = x;
  }
  const to2 = (v) => Math.max(0, Math.min(255, Math.round((v + m) * 255)))
    .toString(16).padStart(2, '0');
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

/**
 * 把公开锚点常量编译为插值用的停靠点数组（位置 + 原始 hex + 预解析 hsl），
 * 避免每次调用重复做 hex→hsl 换算；同时校验位置严格递增，
 * 锚点顺序被改错时模块加载即抛错，而不是静默产出错乱颜色。
 */
function compileStops(anchors, key, name) {
  const stops = anchors.map((a) => {
    const pos = a[key];
    if (typeof pos !== 'number' || !Number.isFinite(pos)) {
      throw new Error(`[ramp] ${name} 锚点位置非法：${String(pos)}`);
    }
    return { pos, hex: a.c, ...hexToHsl(a.c) };
  });
  for (let i = 1; i < stops.length; i += 1) {
    if (!(stops[i].pos > stops[i - 1].pos)) {
      throw new Error(`[ramp] ${name} 锚点位置必须严格递增（index ${i}）`);
    }
  }
  return stops;
}

/**
 * 插值核心：数值 x → 颜色（hex）。
 * 规则：
 *   - 非 number / NaN / ±Infinity / 负数 → 中性灰（无效数据不上色阶，见顶部偏差记录 1）；
 *   - x 低于首锚点 → 首锚点色；x 高于末锚点 → 末锚点色（域外钳制封顶）；
 *   - 段内 h/s/l 分段线性插值，色相沿最短环向路径（|Δh| ≤ 180°）。
 */
function rampAt(stops, x) {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) {
    return NEUTRAL_COLOR;
  }
  if (x <= stops[0].pos) {
    return stops[0].hex;
  }
  const last = stops[stops.length - 1];
  if (x >= last.pos) {
    return last.hex;
  }
  for (let i = 0; i < stops.length - 1; i += 1) {
    const a = stops[i];
    const b = stops[i + 1];
    if (x <= b.pos) {
      const t = (x - a.pos) / (b.pos - a.pos);
      // 命中锚点（含段端点）直接返回锚点原色，避免 hsl→hex 量化往返引入偏差
      if (t >= 1) {
        return b.hex;
      }
      if (t <= 0) {
        return a.hex;
      }
      // 色相走最短环向路径：Δh 归一到 (-180, 180]，防止跨 0°/360° 绕远路出脏色
      let dh = b.h - a.h;
      if (dh > 180) {
        dh -= 360;
      } else if (dh < -180) {
        dh += 360;
      }
      return hslToHex(
        a.h + dh * t,
        a.s + (b.s - a.s) * t,
        a.l + (b.l - a.l) * t,
      );
    }
  }
  return last.hex; // 理论不可达（x < last.pos 必命中某段），兜底防御
}

const SPEED_STOPS = compileStops(SPEED_ANCHORS, 'v', 'SPEED_ANCHORS');
const CONTEXT_STOPS = compileStops(CONTEXT_ANCHORS, 'p', 'CONTEXT_ANCHORS');

/* ============================ 公开 API ============================ */

/**
 * 速度色阶：tok/s → 颜色（hex）。
 * 0 红 → 150 绿 → 300 蓝 → ≥500 紫（封顶）；hsl 分段线性插值，域外钳制封顶。
 * 无效输入（NaN/±Infinity/负数/非 number）返回中性灰（见顶部偏差记录 1）。
 * @param {number} tokPerSec 每秒输出 token 数
 * @returns {string} 6 位小写 hex 颜色
 */
function speedColor(tokPerSec) {
  return rampAt(SPEED_STOPS, tokPerSec);
}

/**
 * 上下文色阶：占用比例（0–1）→ 颜色（hex）。
 * 0 绿 → 0.5 黄 → 0.9 红 → 1 深红；插值与钳制规则同 speedColor。
 * 入参口径为 0–1 比例（design.md §9），不做百分制自动探测——
 * 90 与 0.9 存在语义歧义，口径由调用方保证。
 * @param {number} pct 上下文占用比例，0–1
 * @returns {string} 6 位小写 hex 颜色
 */
function contextColor(pct) {
  return rampAt(CONTEXT_STOPS, pct);
}

/* ============================== 导出 ============================== */

// 环境检测：CommonJS（Node require / 宿主注入 loader）为主契约；
// 无模块系统环境（renderer 注入 IIFE 拼装）时兜底挂 globalThis，供 statusbar.js 取用。
const HAS_COMMONJS = typeof module !== 'undefined' && module != null
  && module.exports !== undefined;

if (HAS_COMMONJS) {
  // 对象字面量简写形式便于 Node 的 cjs-module-lexer 静态识别具名导出，
  // ESM 侧 `import { speedColor } from './ramp.js'` 可直接使用（双兼容，design.md §9）。
  module.exports = { speedColor, contextColor, SPEED_ANCHORS, CONTEXT_ANCHORS };
} else if (typeof globalThis !== 'undefined') {
  globalThis.ZCodeStatusbarRamp = {
    speedColor,
    contextColor,
    SPEED_ANCHORS,
    CONTEXT_ANCHORS,
  };
}
