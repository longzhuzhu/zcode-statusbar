# Python 编码约定（core/ 与根级脚本）

> 适用于 `core/*.py` 与根级 `zusage.py` / `usage_stats.py`。全部规则取自现有代码的真实模式，每条附出处。

## 落盘唯一方式：同目录临时文件 + `os.replace`

任何持久化写入必须是「同目录 `mkstemp` → 写入 → `os.replace` 原子替换 → `finally` 清理」五连，禁止直接 `open(path, "w")` 截断写（中途崩溃会损坏宿主文件，见 `core/install.py:409` 注释）。

- 基准实现：`core/runtime_lock.py:98` `_write_marker`（preserve 原 mode/owner）、`core/runtime_install.py:250` `_atomic_write`（同步 mtime 供 loader 热检测）、`core/patch_install.py:554`（含 fsync）、`core/pending_zip_patch.py:135`、`core/install.py:409`。
- cjs 侧对应实现见 [cjs-guidelines.md](./cjs-guidelines.md) 的 `atomicWrite`。

## 文件锁：advisory 锁永不 unlink

- 共享锁助手：`core/runtime_lock.py:40` `file_lock`（flock/msvcrt 双平台），锁文件权限 `0o600`，注释明言 "never unlink the lock file"——unlink 会破坏其他进程正在持有的锁语义。
- 跨进程目标锁：`app.asar.zcstatusbar.lock`（`core/patch_install.py:566`），渲染桥部署链用同一把（`core/renderer_bridge.py:642`），勿另起新名。
- 监控去重锁是独立 try-lock 实现，刻意不共用 `file_lock` 的计时器以免干扰测试（`core/patch_install.py:576`）——新增锁前先确认没有现成的可复用。

## 异常与退出码

- **禁止让异常逃出 CLI 边界**：`main()` 返回退出码，`if __name__ == "__main__": sys.exit(main())` 收尾（`core/release_unpack.py:412`、`core/uninstall.py:182`）。
- **禁止 `sys.exit(bool)`**：`True` 会变成退出码 1（失败）。`core/patch_install.py:1180` 有此陷阱的显式注释。
- 自定义异常继承 `ValueError`：`UnpackError`（`core/release_unpack.py:117`）、`PendingTmpError`/`PendingTmpBusy`（`core/patch_install.py:462`）、`BridgeError`（`core/renderer_bridge.py:344`）。
- 惯用窄捕获：`except (OSError, ValueError): return 默认值`。
- **hook 主链绝不上抛**：SessionStart hook 最外层 `except Exception as e:  # noqa: BLE001 — hook 绝不能抛`（`core/runtime_install.py:908`）。任何新增 hook 路径代码都要被这一层兜住。
- 退出码约定：0 成功；1 可预期的失败（转为可行动提示，参考 `zusage.py:1500` 对 `sqlite3.DatabaseError` 的处理）；2 CLI 参数非法（`zusage.py:1454` `SystemExit(2)`）。

## stdout / stderr 硬分工

- **stdout 只承载协议数据**（hook 协议 JSON、`runtime_lock.py` CLI JSON、uninstall 报告 JSON、`zusage.py serve` 行协议）。
- **人类可读日志一律 `print(..., file=sys.stderr)` 且带 `[zcode-statusbar]` 前缀**（`core/runtime_install.py:187` 等多处）。
- 调用内部会产生可读输出的模块时，用 `contextlib.redirect_stdout(sys.stderr)` 包裹以免污染协议通道（`core/runtime_install.py:743`）。

## 路径处理

- 全程 `pathlib.Path`；每个文件固定开头 `HERE = Path(__file__).parent.resolve()`。
- **两处刻意不用 `.resolve()` 的例外**：`core/patch_install.py:1165` 与 `core/pending_zip_patch.py:455`，用 `os.path.abspath` 只补绝对化——macOS `/var` 符号链接会破坏注入行字面一致性。新写涉及 asar 路径字面匹配的代码沿用此例。
- sudo 场景用 `real_home()` / `sudo_user()` 还原真实用户（`core/runtime_install.py:61`、`core/install.py:81`），产物写完后 `chown_runtime_to_user` 归还（`core/runtime_install.py:673`）。

## 白名单与常量组织

- 模块顶部 `SCREAMING_SNAKE` 元组/frozenset；跨文件共享的文件清单**集中放在 `core/runtime_lock.py` 单点**，不 import 的消费方（如解包器）在自身文件头注释声明镜像约束（见 [statusbar-kernel.md](./statusbar-kernel.md) 双侧同步白名单节）。
- 路径/身份校验一律白名单式：ZIP 成员白名单 + 平台设备名拒绝（`core/release_unpack.py:79`）、asar 身份门 `is_zcode_asar` 读包内 package.json name（`core/runtime_install.py:179`）、下载主机白名单（`core/plugin-release.cjs:30`）。

## 惯用小件

- `L(zh, en)` 双语输出函数：`core/install.py:156`、`core/patch_install.py:112`、`zusage.py:122`，语言取 config.json `lang` 字段。新增面向用户的文案必须走 `L()`，不硬编码单语。
- 同目录导入守卫：`sys.path.insert(0, str(HERE))` 式导入（`core/sync_plugin.py:27`、`core/uninstall.py:29`）——运行布局是平铺目录，不能用包相对导入。
- 文件头 docstring 三要素：移植来源、适配点清单（旧名→新名对照）、测试接缝。基准样例：`core/patch_install.py:1`、`core/runtime_install.py:28`。
- dry-run 语义：承诺不写任何文件（含建目录），见 `core/install.py:517`。

## 测试接缝

- 运行目录/asar 可用 `ZCODE_STATUSBAR_RUNTIME` / `ZCODE_STATUSBAR_ASAR` 环境变量重定向（`core/runtime_install.py:198`、`core/patch_install.py:1159`）——新增需要重定向的路径时优先接入这两个既有变量，而不是发明新的。
- Windows 上 `python3` 可能是 Microsoft Store 存根会静默失败（`core/patch_install.py:66` 用户反馈教训），解释器一律 `PYEXE = sys.executable or "python"`，不猜别名。
