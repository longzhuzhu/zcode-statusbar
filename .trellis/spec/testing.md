# 测试约定（跨层）

> 适用 `tests/` 全部测试。两条铁律：**一切测试只用临时目录，绝不触碰真实 `~/.zcode`、真实 asar/引擎/ZIP 与已安装 ZCode**；测试接缝一律走 `ZCODE_STATUSBAR_*` 环境变量重定向（`core/runtime_install.py:198`）。

## 运行命令

```bash
python3 -m unittest discover tests -p "*.py"   # Python 全量（unittest）
npm test                                        # node --test tests/*.test.cjs
```

- **本机 `node --test <目录>` 形式不可用**（目录被当模块解析报 MODULE_NOT_FOUND），必须用 glob `tests/*.test.cjs`。
- 需要 Node 的 Python 测试用 `@unittest.skipUnless(shutil.which("node"), ...)` 守卫（`tests/core_runtime_sync_guard.py:32`）。

## 命名分域

| 前缀 | 域 | 例子 |
|---|---|---|
| `core_` | 内核（core/） | `tests/core_runtime_sync_basic.py`、`tests/core_engine_patch.test.cjs` |
| `data_` | 数据层（根级脚本） | `tests/data_zusage_rate.py`、`tests/data_zusage_snapshot.py` |
| 无前缀 | statusbar UI 纯逻辑 | `tests/stats-turn.test.cjs`、`tests/ramp.test.cjs` |

## Python 测试（unittest）

- 文件头 docstring 三要素：移植来源、覆盖点清单、运行命令（基准样例 `tests/core_runtime_sync_guard.py:12`）。
- fixture：`tempfile.TemporaryDirectory()` + `self.addCleanup`（`tests/core_runtime_sync_guard.py:34`）；数据层内联最小 SQLite schema DDL（`tests/data_zusage_snapshot.py:54`）。
- dict 行工厂只填必要字段、其余缺省（`tests/data_zusage_rate.py:27` `mrow()`）；哨兵 `_UNSET = object()` 区分「显式 NULL」与「不传」（`tests/data_zusage_snapshot.py:39`）。
- 时间敏感测试锚定固定时间基准（如「本地今天 01:00」），不依赖运行时钟。
- **负向结构断言**：`FORBIDDEN_KEYS` 递归扫描确认已删字段不存在；固定键集合断言（`SNAPSHOT_TOP_KEYS` / `CONTRACT_ROW_KEYS`）锁住快照形状（`tests/data_zusage_snapshot.py:42`）。
- 跨实现一致性断言：口径常量两侧必须相等（`tests/data_zusage_rate.py` 尾部 `test_zusage_constants_match_usage_stats`）。
- 测试头注释显式声明隔离承诺（基准样例 `tests/core_uninstall_gaps.py:13`「全部在临时目录模拟 asar/引擎/ZIP，不触碰真实安装」）。

## cjs 测试（node:test + node:assert/strict）

- 文件头注明运行命令（`tests/ramp.test.cjs:3`）。
- DOM 用 vm 沙箱模拟（`tests/core_bridge_shim.test.cjs:20` `makeWindow`/`loadShim`）；内核测试用临时 HOME（`tests/core_engine_patch.test.cjs:297`）。
- 依赖注入驱动：可变 ctx 对象 + 假时钟/readLength stub（`tests/stats-turn.test.cjs:15` `make(ctx)`）。
- **测试侧独立实现转换逻辑，不复用被测模块内部逻辑**，保证验证独立性（`tests/ramp.test.cjs:12` 自建 hex→hsl）。
- 浮点断言用 `Math.abs(x - y) < 1e-9`（`tests/stats-session.test.cjs:91`）；容差常量化（`tests/ramp.test.cjs:33`）。
- 约定值断言防回归：如 ramp 中性灰 `#8c8c8c`（`tests/ramp.test.cjs:29`）。
- 边界覆盖习惯：窗口边界逐点断言（200ms 含 / 199 排除 / 1h 排除 / 1h−1ms 含，`tests/stats-session.test.cjs:65`）；坏行容错逐类喂入（null/数字/字符串/NaN，`:188`）。

## 提交前检查清单

```bash
python3 -m unittest discover tests -p "*.py"
npm test
python3 core/sync_plugin.py --check
```

- 新增测试放对命名域；禁止在测试中运行安装器。
- 测过的行为变了 → 先改测试再改实现；发现新坑 → 回填到对应 spec 的反模式/教训小节。
