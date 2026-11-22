# 滚动到底部时输入框与状态条的持续抖动

## 定位结果

真机（ZCode Desktop，2026-11-22）在会话滚动到底部时，输入框与状态条以约 5Hz
持续抖动刷屏。真机诊断采样（运行目录 `statusbar-bridge.js` 内的临时 `[ZSB-DIAG]`
采样器，经 inject-main 每 15 次泵拉取落盘 `diag-0.json` 的 `zsamples`）捕获到
62 个样本，`marginBottom` 只在 `-12px` 与清空两态间翻转：

```text
{"t":5402,"k":"chg","barTop":695.5,"m":"-12px","scTop":5238,"scMax":5238,"atBottom":true}
{"t":6004,"k":"chg","barTop":691.5,"m":"","scTop":5238,"scMax":5242,"atBottom":false}
{"t":6555,"k":"b","barTop":695.5,"m":"-12px","scMax":5238,"atBottom":true}
{"t":6657,"k":"b","barTop":691.5,"m":"","scMax":5242,"atBottom":false}
```

机制：`dockBottomMargin()` 把「实测 inset 与结构 inset 是否吻合」作为 guard，
而实测值会被自身写入的补偿污染。宿主 v4 布局里 dock 是滚动容器内的
`sticky bottom-0` 元素，bar 的 margin 变化经 sticky 钳制、flex 剩余空间分配
与宿主滞后重测量（虚拟化历史层、输入框自适应）反馈回实测 inset，两个 margin
状态在 guard 下互斥。`render()` 在 turn 样本、session 帧与每秒定时器里都会跑
`balanceDockGap()`，于是渲染节奏驱动两态持续交替；只有贴底（视口被滚动钉住）
时位移与 `atBottom` 翻转才可见，这正是「下拉到底部才抖」的原因。

0.2.1 的修复只切断了 gap 一侧（gap 改取 CSS `margin-top`），guard 一侧的
实测 inset 仍以自身补偿为输入，该类反馈环并未闭合。真机此前运行 0.1.3
时代代码（marketplace 0.2.1 的同步被 Nov 18 采样器手改触发的「疑似手改热修」
保护挡住），但按本机制 0.2.1 在同一宿主下同样存在风险。

## 修复

- `dockBottomMargin()` 测量前先清掉自身写入的补偿，在「无补偿基准态」下取
  全部几何。判定与写入解耦：每轮都从同一自然几何收敛到同一目标，两态互斥
  失去输入来源，振荡从结构上不可能。
- `balanceDockGap()` 无条件写回非 null 目标。测量用的清零必须被恢复；「同值
  跳写」优化会让恢复缺失，反而在基准态测量下制造新的两态交替（回归测试在
  修复过程中抓到过这一环）。
- `syncDiag()` 增加 `bar.margin` / `bar.top` 字段：无需临时采样器即可在真机
  diag 落盘里直接读状态条 margin 与位置，验证贴底稳定性。
- sticky 钳制区内补偿自洽（实测 inset 与 margin 无关），行为不变；钳制释放
  区（过度补偿）回退正常流，与 0.2.1 的 flex 回退语义一致。

## 验证

```sh
npm run test:scroll-stability   # 本文档场景：sticky 宿主两起点判定一致、无持续交替
npm test
npm run test:layout
npm run test:interaction
python3 -m unittest discover -s tests -p "core_*.py"
python3 core/sync_plugin.py --check
```

真机验收：`core/install.py --no-mcp` 覆盖运行目录（同时移除 Nov 18 的采样器
手改），完全退出重开 ZCode 后读取 `~/.zcode/zcode-statusbar/diag-0.json`，
`bar.margin` 应稳定为同一值（或 null），`bar.top` 不随渲染帧交替。
