# 状态条 UI 层（statusbar/）开发指南

> 渲染端注入三件套 + 主进程聚合，构成状态条的产品形态。零第三方依赖、无构建步骤。

## 文件索引

| 文件 | 内容 |
|---|---|
| [ui-guidelines.md](./ui-guidelines.md) | 契约先行与偏差登记、双环境导出、防串数（R10）、静默降级、状态管理、命名空间纪律 |
| [CONTRACT.md](../../../statusbar/CONTRACT.md) | 模块间契约唯一权威（源码旁，非 spec）——改字段/事件/全局名先改它 |

## Pre-Development Checklist

改 `statusbar/` 之前确认：

- [ ] 改动是否涉及全局名/事件名/数据形状？是 → 先改 `statusbar/CONTRACT.md`，再改实现，并在 §8 偏差表登记任何与基线的偏离。
- [ ] 新增可选依赖是否定义了缺失降级行为，并在 CONTRACT §2 表登记。
- [ ] 新逻辑是否可以不依赖 DOM 单测（依赖注入工厂 + 条件导出）。
- [ ] 是否遵守 R10：宁可少算/占位符，不渲染错口径。
- [ ] 注入顺序约束：ramp/turn-stats 均先于 statusbar.js，bridge 先于挂载重试窗口（实际顺序以 `core/inject-main.cjs:1043` 为准）。

## Quality Check

```bash
npm test           # stats-turn / stats-session / ramp 等纯逻辑单测
python3 core/sync_plugin.py   # 改完源码同步生成副本
```

- 渲染行为无法在单测覆盖的部分（挂载、事件绑定）在 CONTRACT §7 内核对齐点逐条自查。
- 任何新全局/事件/DOM 标记与 [ui-guidelines.md](./ui-guidelines.md) 命名空间表核对。
