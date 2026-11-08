# 状态条 UI 层编码约定（statusbar/）

> 适用于 `statusbar/statusbar.js`（940 行 UI 主体）、`statusbar/turn-stats.js`（生成中速度采样）、`statusbar/session-stats.cjs`（主进程聚合）、`statusbar/ramp.js`（色阶引擎）。全部零第三方依赖、无构建步骤。

## 契约先行（最高优先级）

- `statusbar/CONTRACT.md` 是模块间接口的唯一权威。**任何字段/事件/全局名改名必须先改契约再改实现**（`statusbar/CONTRACT.md:5`）。
- 实现与基线契约的偏差必须**显式登记**：模块文件头注释块记录该文件的偏差，`CONTRACT.md §8` 汇总表互指文件位置。这是本仓库的核心协作模式——四个 JS 文件头都有「与契约的偏差（供检查代理核对）」块。
- 新增偏差时两处都要写：文件头 + §8 汇总，注明原因与位置。

## 模块风格：双环境导出

- 渲染端注入文件（statusbar.js、turn-stats.js）用 IIFE 自装配；**非 renderer 环境静默退出**（`statusbar/statusbar.js:24`）。
- 需要单测的采样/纯逻辑走条件导出：node 环境无 window 时 `module.exports = { createTurnSampler, CONSTANTS }`，浏览器路径不变（`statusbar/turn-stats.js:242`，偏差已登记）。
- ramp.js 双导出：CommonJS 对象字面量**简写形式**（便于 cjs-module-lexer 静态识别具名导出），无模块系统时兜底挂 `globalThis.ZCodeStatusbarRamp`（`statusbar/ramp.js:229`）。

## 防串数（R10，贯穿三层的铁律）

宁可少算/不渲染，不可渲染错口径：

- **身份门**：桥缺失或 `getPaneId()` 为空即不渲染；桥恢复时下一轮轮询自动挂上（`statusbar/statusbar.js:795`、CONTRACT §1）。
- **会话门**：`[data-session-id]` 为 `"draft"` 即首页/新建任务，不渲染；切到真实会话下一轮轮询（1s）内挂上（`statusbar/statusbar.js:817`、CONTRACT §6）。
- **形状拒绝**：`normalizeSession()` 按特征键识别数据形状，其余形状一律拒绝、显示占位符（`statusbar/statusbar.js:675`）。
- **严格判定**：聚合只认 `status === 'completed'`（`statusbar/session-stats.cjs:114`）；非有限数值视为缺失逐行跳过（`:38`）。
- 采样无增量时 `tokPerSec` 归零不冻结旧值；文本回落视为新轮重置窗口（CONTRACT §4.1）。

## 静默降级链

每个可选依赖（ramp / bridge / i18n / stream hook / 宿主锚点）均可缺失，每处降级行为登记在 CONTRACT §2 与 §6 表：

- ramp 缺失 → 数字与上下文圆环描边退中性灰 `#8c8c8c`（`statusbar/ramp.js:158`）。
- 选择器失效 → 静默停采/不渲染，永不 console 噪声、永不影响宿主（`statusbar/turn-stats.js:182`）。
- 宿主 `[data-usage-used]` 缺席或占用为 0 → 上下文 pill 整只隐藏，其余控件不受影响（`statusbar/statusbar.js:759`）。
- clipboard 三级降级：navigator.clipboard → textarea+execCommand → 静默（`statusbar/statusbar.js:611`）。

新增可选能力时：先在 CONTRACT §2 加一行（生产者/消费者/缺失降级），再实现。

## 状态管理与渲染

- 单一 `state` 对象集中状态（`statusbar/statusbar.js:128`），事件驱动更新 + 1s 周期 render 兜底（`:952`）。
- 弹层内容打开时一次性构建、不随 1s render 重建；依赖容器像素宽的自绘 SVG（趋势图）在弹层解除 hidden 后补画（layoutTrend 模式：hidden 期间 clientWidth 恒 0，不可定点）。
- **全局监听只注册一次**（`bindGlobalEvents`），**控件监听随 bar 重建**（`bindBarEvents`）。会话切换会拆条重挂，若把 window/document 监听放进 mountBar，每次切换都会叠加一份。
- DOM 全自绘：`el()` 工厂、CSS 字符串数组 join 注入 `<style>`、内联 SVG 图标表——不引入任何模板/框架。
- 交互模式：弹层用事件委托、外点关闭走 capture 阶段、Escape 关闭（`statusbar/statusbar.js:409`）。
- 性能模式：100ms tick + MutationObserver 脏标记闲置降频（`statusbar/turn-stats.js:155`）。

## 只读宿主 DOM（硬约束）

插件对宿主节点**只读**，不写任何属性、class、样式。上下文占用取自宿主自有锚点（CONTRACT §6），
自绘在自己的 pill 里——不改写官方上下文按钮。历史教训：旧版用 `svg.closest('[data-usage-used]')`
改写官方圆环描边，但该属性在独立隐藏 span 上、不在 SVG 祖先链内，代码从未命中，属净死代码。

## 快速失败与兜底的边界

- **纯逻辑模块启动期快速失败**：ramp 锚点校验非法即抛错，「模块加载即抛错，而不是静默产出错乱颜色」（`statusbar/ramp.js:134`）。
- **运行期渲染路径静默降级**（见上节）。
- 常量集中区冻结：`Object.freeze`（`statusbar/ramp.js:42`），测试断言防篡改。

## 可测性

- 依赖注入工厂：`createTurnSampler({ readLength, now, publish })`（`statusbar/turn-stats.js:61`）、`aggregate(rows, now?)` 时钟注入（`statusbar/session-stats.cjs:99`）。新逻辑默认把时钟/IO/发布函数放 opts。
- 口径判定拆独立小函数（`windowBasis` / `rowWindowMs` / `isCountedWindow`，`statusbar/session-stats.cjs:37`），类 docstring/注释声明口径（如「200ms ≤ 窗 < 1h（含下限、不含上限）」）。
- 测试写法见 [../testing.md](../testing.md)。

## 命名空间纪律

| 类别 | 模式 | 出处 |
|---|---|---|
| 渲染端全局 | `__ZCODE_STATUSBAR_*`（CONTRACT §2 八个） | `statusbar/CONTRACT.md` §2 |
| window 事件 | `zcode-statusbar:turn/session/refresh/reset-session/check-update/uninstall`，集中在 `EV` 常量（与 CONTRACT §3 严格同步） | `statusbar/statusbar.js:64` |
| DOM | 样式节点 id `zcode-statusbar-style`、条根 class `zsb-bar`、pill `data-zsb-pill`（值 `activity`/`usage`/`subagent`/`context`/`gear`，即视觉顺序）、上下文填充环 `.zsb-ring-fill`、子代理运行态绿点 `.zsb-livedot`。宿主节点一律只读 | `statusbar/CONTRACT.md` §7 |
| CSS 变量 | `--zcode-font-mono` 等（宿主值采样，缺省官方栈）；`--zsb-live` 按主题取绿点色 | `statusbar/CONTRACT.md` §7 |
| localStorage | `zcode-statusbar.pills`（五键） | `statusbar/CONTRACT.md` §7 |

新增任何全局/事件/DOM 标记前先查此表，模式不一致即视为契约违约。
