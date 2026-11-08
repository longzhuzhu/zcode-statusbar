# CommonJS (.cjs/.js) 编码约定（core/ 内核侧）

> 适用于 `core/*.cjs` 与 `core/statusbar-bridge.js`。`statusbar/*.js` 的渲染端注入文件另有约定，见 [statusbar/ui-guidelines.md](../statusbar/ui-guidelines.md)。

## 模块风格

- 全部 CommonJS + 文件头 `"use strict"` + `module.exports = {...}`（`core/engine-patch.cjs:272`、`core/plugin-storage.cjs:62`、`core/plugin-updater.cjs:710`）。
- **依赖注入用工厂函数**：`createUpdater` / `createEnginePatcher` / `createNotesService` / `createNotesCache`，闭包持有 opts（`core/plugin-updater.cjs`、`core/engine-patch.cjs`）。新增内核模块沿用工厂形态，便于测试注入替身。
- 例外：`core/statusbar-bridge.js` 是渲染端 IIFE，无模块系统（`core/statusbar-bridge.js:24`）。

## 日志与错误处理

- 统一日志前缀：`LOG = (...a) => console.error("[zcode-statusbar]", ...a)`（`core/inject-main.cjs:58`）。**不用 `console.log`**——渲染器/主进程的 stdout 不可靠，统一走 stderr 语义。
- 内核侧吞错 + 兜底为主：`try { ... } catch (e) { LOG(...) }`；`readJson(file, fallback)` 带缺省读（`core/plugin-updater.cjs:67`）。
- 渲染端注入代码的错误一概 `.catch(() => {})` 静默——状态条任何故障不得影响宿主。
- CLI 分支：`if (require.main === module)` + `console.error("[zcode-statusbar] ...")` + `process.exitCode = 1`（`core/plugin-updater.cjs:711`）。

## 与 Python 的双侧协议

- Node → Python：`execFile`/`spawn` 调 Python 脚本 + **stdout 单行 JSON 协议**。既有命令面：`runtime_lock.py --hold/--update-config/--record-restart/--ack-restart`（`core/plugin-updater.cjs:104`、`core/inject-main.cjs:64`）。
- 解释器解析链固定：`config.python_path || (win32 ? "python" : "python3")`（`core/inject-main.cjs:87`、`core/plugin-updater.cjs:347`）；或显式走 `ZCODE_STATUSBAR_PLUGIN_PYTHON`（`core/plugin_auto_update.py:74`）。禁止猜测其他别名。
- Python → Node 验收器：Python 内嵌完整 Node 脚本字符串子进程执行（`core/runtime_install.py:393` `_sync_verifier`）——改同步验收逻辑时两侧同改。

## 注入安全细节

- 往渲染器 `executeJavaScript` 拼接 JSON 字面量时必须转义 U+2028/U+2029：`JSON.stringify(detail).replace(/[\u2028\u2029]/g, ...)`（`core/inject-main.cjs:173`、`:648`）。
- 注入顺序固定：bridge → turn-stats → ramp → statusbar → EVENT_SHIM，各自幂等，缺失资产跳过降级（`core/inject-main.cjs:1043`）。注意 `statusbar/CONTRACT.md §1` 把 ramp/turn-stats 顺序写反了，实际以代码注释为准；两者都须先于 statusbar.js。
- 动作白名单：渲染端请求经 `pollPluginRequests` 白名单执行，未知动作要回执 `{ ok: false, error: "unknown action: ..." }` 而非静默丢弃（`core/inject-main.cjs:1027`）。

## 下载与来源校验

- 下载主机白名单：`core/plugin-release.cjs:30`——新增 release 源必须先入表。
- sidecar/待替换文件必须有来源授权链（`core/patch_install.py:774` `pending_tmp` 授权检查），不认无来源的临时文件。
- 更新锁由常驻 Python 子进程持有 `plugin-update-v2.lock`（`core/plugin-updater.cjs:150`），旧代 `plugin-update.lock` 保留兼容探测（`:137`）——升级锁版本时的旧代探测模式照此办理。

## 测试接缝

- `module.exports.__zcodeStatusbarTest = {...}` 暴露内部引用供 vm 沙箱测试复现控制流；生产加载方（asar 动态 import）不用它（`core/inject-main.cjs:1084`）。
- cjs 测试写法与运行命令见 [testing.md](../testing.md)。
