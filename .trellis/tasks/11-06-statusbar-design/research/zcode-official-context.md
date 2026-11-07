# 调研：ZCode 官方上下文进度（字体/样式/口径对齐参考）

> 基于本地提交 `a9fe401e`（同步 ZCode v3.17.2）。静态源码分析，非运行时实测。调研时间 2026-11-06。

## 核心结论

新 statusbar 数字应对齐官方悬浮面板的 **`font-mono` + `text-ui-sm` + `text-foreground-subtle`**：

- 默认 **12px**（`--ui-font-size: 14px`，`text-ui-sm = 基准-2px`），随界面字号设置（12–20px）变化。
- **普通字重（400）**，不是粗体；官方摘要未显式设 `tabular-nums`（breakdown 百分比有显式设置）。
- 官方常驻入口只有**圆形进度图标**（14px SVG，`currentColor`，底环 opacity 0.25 / 进度环 0.7），不常驻百分比文字。

## Mono 字体栈（完整，可直接复用）

```css
ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New",
"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", monospace
```

来源：`packages/ui/src/styles.css:145`（后段 CJK fallback 是有意防 Windows 中文落宋体）。

Sans 栈：桌面未覆盖 `--font-sans`（沿 Tailwind 默认）；Web body 为 `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`。

## 主题色

`foreground-subtle` = 前景 60% 与 transparent 的 oklab color-mix（非固定灰）：

| 主题 | foreground | 上下文进度条基色 |
|---|---|---|
| Light | neutral-700 | sky-600 |
| Dark | neutral-200 | sky-500 |
| Zai Light | neutral-800 | `#0b7fff` |
| Zai Dark | neutral-300 | `#4099ff` |

官方圆环**无高占用变色分支**（可能出现的 success/warning 是额度重置语义，非上下文阈值）。

## 上下文数据口径（若与官方同源显示，须遵守）

- UI 读 V4 `ConversationSnapshot.usage.contextWindow`：`usedTokens → used`、`maxTokens → size`，**分母是完整模型 context window**（非 autoCompactThreshold、非扣输出预算）。
- `used` = 本次主轮 input+output（cache 已含在 input，勿重复加）；只接受主轮；compact 成功后改为压缩后水位。
- 格式：`used/total (percent)`，百分比最多一位小数；≥1000 走本地化 compact（K/M/B 或 万/亿）。
- `used<=0`、`size<=0` 或非有限值不展示。
- 隐藏测试节点：`V4ComposerToolbar.tsx:1246` 有 `data-usage-used`、`data-usage-max`（可辅助读取，但非稳定合同）。

## 插件扩展点现状（重要约束）

- **未找到** `registerStatusBarItem` 类正式 statusbar 接口、composer 工具栏公开 slot、经插件 API 订阅 contextWindow 的能力。
- 正式 UI 插件机制 = MCP Apps（对话内联页/侧栏）+ manifest `ui.surfaces` + `getHostContext()`。
- **样式变量桥接可用**（`pluginUiStyleVariables.ts:29-56`）：

| 插件变量 | 宿主来源 |
|---|---|
| `--font-mono` | `--font-mono` |
| `--font-sans` | `--font-sans` |
| `--font-text-sm-size` | `--text-ui-sm` |
| `--font-weight-normal` | `400` |
| `--color-text-primary` | `--color-foreground` |
| `--color-text-secondary` | `--color-foreground-subtle` |

- 注意：host-context 更新比较键**未包含界面字号**，改字号是否即时同步到已打开插件页未实测。
- 内部 React 组合点（`topContent`、`leadingActions`、`submitControl` 等，`ChatPromptEditor.tsx:436-484`）是应用内部 props，不是插件接口——注入方案只能模仿原插件那样做，或用 MCP Apps 页面（位置不满足"状态栏"）。

## 文档/截图锚点

- `docs/ui/chat-input-context.md:10`、`docs/context-window-usage-state.md:1`、`docs/context-cache-hit-rate.md:1`
- `DESIGN.md:259`（字体规范）、`docs/ui/ui-font-tokens.md`
- `UI_PLUGIN.md:296/335/351/355`（插件页面 API）
- 截图：`docs/images/ui-plugins/excalidraw-context-question.png`（输入区，非展开面板；不可作像素测量依据）
