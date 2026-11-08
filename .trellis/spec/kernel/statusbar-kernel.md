# 状态栏接入内核约定（core/ 与移植纪律）

> 本项目接入 ZCode 的内核复刻自 zcode-token-usage-statusbar 并做裁剪。改动 core/ 前必读。

## 文件分两类（改错基准会互相破坏）

- **A 类（已适配正本，勿盲目覆盖）**：`uninstall.py`（统一卸载+三缺口）、`runtime_install.py`（安装器+SessionStart 同步）、`inject-main.cjs`（瘦身 loader）、`statusbar-bridge.js`（静态桥）、`core/renderer_bridge.py`、`engine-patch.cjs`、`plugin-updater.cjs`、`plugin-release.cjs`、`release_unpack.py`、`restart_notice.py`、`plugin_auto_update.py`。
- **B 类（原始移植+适配点注释）**：`patch_install.py`、`install.py`、`sync_plugin.py`、`runtime_lock.py`、`install_monitor.py`、`pending_zip_patch.py`、`plugin-storage.cjs`。
- 从源仓库取文件时**禁止整文件盲拷贝覆盖**：先 `rg` 确认同名标识在本仓库的适配差异（zcstatusbar 前缀、opt-out 标记、备份后缀）。

## 命名体系（与原插件共存互不干扰）

| 项 | 值 |
|---|---|
| 插件 id / 运行目录 | `zcode-statusbar` / `~/.zcode/zcode-statusbar/` |
| 豁免标记 | `.plugin-statusbar-optout` |
| asar 临时/备份 | `app.asar.zcstatusbar.tmp` / `app.asar.zstatusbar.bak` |
| 注入行标记 | `[zcode-statusbar]` |
| 环境变量 | `ZCODE_STATUSBAR_*`（旧 `ZUSAGE_*` 已消亡，仅存在于各文件头的改名对照注释，运行时零使用） |

## 双侧同步白名单（改一边必须改另一边）

`core/runtime_lock.py` 的 `RUNTIME_FILE_NAMES` / `OPTIONAL_RUNTIME_FILES` ≡ `core/release_unpack.py` 的 `CORE_FILES`。两处均有中文注释声明此约束。`OPTIONAL_RUNTIME_FILES` 当前 = `{zusage.py, usage_stats.py}`。

## 布局双面性与同步

- 仓库布局：`core/`（内核）+ `statusbar/`（UI）+ 根级 `zusage.py`。
- 分发/运行布局：core 平铺 + `plugins/zcode-statusbar/`（manifest+hooks）。
- 根级 `plugins/zcode-statusbar/` 是 `core/sync_plugin.py` 生成的平面同步副本（生成物），改 `core/`/`statusbar/` 后必须跑 `python3 core/sync_plugin.py`，勿手改副本。

## 渲染端注入与动作通道

- 注入顺序：bridge → turn-stats → ramp → statusbar → EVENT_SHIM（事件桥接，见 `core/inject-main.cjs:1043` 注释「注入顺序固定」）。
  - 注意：`statusbar/CONTRACT.md §1` 将 ramp 排在 turn-stats 之前，与实现注释不一致；两者相对顺序无硬约束，硬约束是 bridge 与二者都先于 statusbar.js。改注入逻辑时以代码注释为基准，并同步修正契约。
- 齿轮动作：渲染端 window 事件 → EVENT_SHIM 翻译进 `__ZCODE_STATUSBAR_REQUESTS__` 队列 → `pollPluginRequests` 白名单执行（refresh / check / uninstall / relaunch / autocompact-* / release-notes*）；未知动作回执 `{ ok: false, error }` 不静默。
- 跨模块契约唯一权威：`statusbar/CONTRACT.md`；改全局名/事件名/数据形状先改契约再改实现。

## 测试约定

完整测试约定见 [../testing.md](../testing.md)。内核侧要点：一切针对 asar/引擎/ZIP 的测试只用临时目录；禁止运行安装器、禁止触碰 `~/.zcode` 与已安装 ZCode。
