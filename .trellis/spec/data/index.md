# 数据层（根级 zusage.py / usage_stats.py）开发指南

> 只读访问宿主 SQLite 的运行时数据层。`zusage.py` 是查询 CLI + 常驻 serve 进程；`usage_stats.py` 是口径纯函数库。

## 文件索引

| 文件 | 内容 |
|---|---|
| [data-guidelines.md](./data-guidelines.md) | 只读边界、口径单源、serve 行协议、缓存、CLI 退出码、测试 |
| [../testing.md](../testing.md) | 跨层测试约定 |

## Pre-Development Checklist

- [ ] 新查询是否保持只读（mode=ro、仅 SELECT）并有 `_ROWS_CAP` 式上限。
- [ ] 口径变化是否同步 `usage_stats.py` 单源与 `zusage.py` 兜底值，并跑 `tests/data_zusage_rate.py` 的一致性断言。
- [ ] 快照顶层键/行键变化是否更新 `tests/data_zusage_snapshot.py` 的固定键集合断言与 `statusbar/CONTRACT.md §4.3`。
- [ ] 白名单确认：这两个文件在 `OPTIONAL_RUNTIME_FILES`（`core/runtime_lock.py:37`），改动后照常跑 `python3 core/sync_plugin.py`。

## Quality Check

```bash
python3 -m unittest tests.data_zusage_rate tests.data_zusage_snapshot
npm test
python3 core/sync_plugin.py --check
```

- 任何测试不得触碰真实 `~/.zcode`。
- 性能相关改动（缓存、扫描）需在注释中说明护栏策略。
