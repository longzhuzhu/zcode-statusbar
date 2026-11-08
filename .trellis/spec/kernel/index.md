# 内核层（core/）开发指南

> `core/` 是接入 ZCode 宿主的内核：安装/注入/更新/卸载链，Python 为主 + CommonJS 混合，标准库零第三方依赖。

## 文件索引

| 文件 | 内容 |
|---|---|
| [statusbar-kernel.md](./statusbar-kernel.md) | 移植纪律（A/B 类文件）、命名体系、双侧同步白名单、布局双面性、注入与动作通道 |
| [python-guidelines.md](./python-guidelines.md) | Python 侧：原子写、文件锁、异常与退出码、stdout/stderr 分工、路径、白名单、`L()` 双语 |
| [cjs-guidelines.md](./cjs-guidelines.md) | cjs 侧：CommonJS/工厂注入、LOG 前缀、Node↔Python 协议、注入安全、下载校验、测试接缝 |
| [../testing.md](../testing.md) | 跨层测试约定（Python unittest + node:test、临时目录铁律） |

## Pre-Development Checklist

改 `core/` 之前确认：

- [ ] 已读 [statusbar-kernel.md](./statusbar-kernel.md)：确认目标文件是 A 类（已适配正本）还是 B 类（原始移植），禁止从源仓库整文件盲拷贝覆盖。
- [ ] 涉及全局名/事件名/文件清单的改动：先改 `statusbar/CONTRACT.md` 契约或白名单双侧（`core/runtime_lock.py` ≡ `core/release_unpack.py`），再改实现。
- [ ] 新的落盘写入是否用「同目录 mkstemp + os.replace」；新的锁是否复用现有锁文件而非另起名。
- [ ] 改完 `core/` 或 `statusbar/` 后运行 `python3 core/sync_plugin.py` 同步生成副本（勿手改 `plugins/zcode-statusbar/`）。

## Quality Check

提交前验证：

```bash
python3 -m unittest discover tests -p "*.py"   # Python 全量
npm test                                        # node --test tests/*.test.cjs
python3 core/sync_plugin.py --check             # 生成副本漂移检查
```

- 所有针对 asar/引擎/ZIP 的测试只用临时目录；禁止运行安装器、禁止触碰 `~/.zcode` 与已安装 ZCode。
- 退出码检查：CLI 不得 `sys.exit(bool)`（`True` 是 1）；hook 链异常必须被兜住不上抛。
