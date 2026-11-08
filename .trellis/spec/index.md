# zcode-statusbar 编码规范总览

> ZCode 客户端状态栏插件：输入区附近一行视觉控件，呈现生成速度（tok/s）、Token 消耗、缓存命中、子代理状态与官方上下文圆环增强。术语以根目录 [CONTEXT.md](../../CONTEXT.md) 为准。

## 仓库结构 → spec 包映射

| 代码位置 | 角色 | spec 包 |
|---|---|---|
| `core/` | 接入内核：安装/注入/更新/卸载链（Python + cjs，标准库零依赖） | [kernel/](./kernel/index.md) |
| `statusbar/` | 渲染端三件套 + 主进程聚合（注入 JS） | [statusbar/](./statusbar/index.md) |
| 根级 `zusage.py` / `usage_stats.py` | 只读 SQLite 数据层 + 口径纯函数 | [data/](./data/index.md) |
| `tests/` | Python 178 例 + node 62 例 | [testing.md](./testing.md) |
| `plugins/zcode-statusbar/` | **生成物**：`core/sync_plugin.py` 平面同步副本，勿手改 | kernel（布局双面性节） |
| `statusbar/CONTRACT.md` | 跨模块契约唯一权威 | statusbar（契约先行节） |

## 跨包铁律（每包 spec 都引用）

1. **白名单双侧镜像**：`core/runtime_lock.py` 的 `RUNTIME_FILE_NAMES` ≡ `core/release_unpack.py` 的 `CORE_FILES`，改一边必须改另一边（`tests/core_runtime_sync_basic.py` 有镜像断言）。
2. **生成物纪律**：改 `core/` / `statusbar/` / 根级脚本后必须跑 `python3 core/sync_plugin.py`，禁止手改 `plugins/zcode-statusbar/`。
3. **契约先行**：全局名/事件名/数据形状改动先改 `statusbar/CONTRACT.md`，偏差显式登记。
4. **测试隔离**：只用临时目录，绝不触碰 `~/.zcode` 与真实安装。

## 思维指南

[guides/](./guides/index.md) — 代码复用与跨层数据流的思维检查表，案例取自本仓库真实教训。
