# 数据层编码约定（根级 zusage.py / usage_stats.py）

> 数据层是只读访问宿主 SQLite 的运行时文件：`zusage.py`（只读查询 + CLI + serve 行协议）与 `usage_stats.py`（口径纯函数库）。两者在白名单 `OPTIONAL_RUNTIME_FILES` 中（`core/runtime_lock.py:37`），由内核 `core/inject-main.cjs` 常驻泵调用。

## 只读边界（不可协商）

- 目标库 `~/.zcode/cli/db/db.sqlite`，**连接以 `mode=ro` 优先（WAL 感知），全程仅 SELECT**（`zusage.py:5` 模块 docstring）。
- **fallback 前必须确认文件存在**：`sqlite3.connect` 对不存在的路径会新建空库，`zusage.py:77` `connect()` 有显式存在性检查与注释。新增连接代码必须复制这一守卫。
- 行数护栏：`_ROWS_CAP = 8000`（`zusage.py:144`），聚合查询必须带上限，防大会话拖垮。
- SQL 防 NULL 击穿：聚合列用 `coalesce`（`zusage.py:169`）。

## 口径单源

- 口径常量与窗口规则放 `usage_stats.py`（纯函数、零 I/O、零网络、容忍缺列，`usage_stats.py:2` docstring）；`zusage.py` import 它，**import 失败时内联同值兜底**（`zusage.py:57`），并由 `tests/data_zusage_rate.py` 尾部测试断言两侧常量一致。
- 窗口口径：「200ms ≤ 有效生成窗 < 1h（含下限、不含上限）」，常量 `MIN_GEN_MS`/`MAX_GEN_MS`（`usage_stats.py:19`）。
- **双实现口径分流是已知并接受的偏差**：完成态速度以 `statusbar/session-stats.cjs` 为 UI 唯一权威，`zusage.py` 自身 `avg_tps` 仅为诊断口径——已在 `zusage.py` 模块 docstring 显式登记。修改任一侧口径时检查另一侧并更新登记。

## serve 行协议

常驻进程模式（`zusage.py:1382`）：

- stdin 每行一个请求（JSON `{"sids":[...]}`，兼容旧逗号分隔串），stdout 每行一个 JSON 快照；**EOF 即退出自清理**。
- 连接跨请求复用 + 探活 + 库文件替换检测 + 空闲 60s 重建（`zusage.py:1414`）。
- **单次查询失败不杀常驻进程**：返回 `{"error": ...}` 继续服务（`zusage.py:1437`）。
- 快照形状以 `snapshot()` 为唯一入口（`zusage.py:1252`），顶层键集合有测试固定断言（`tests/data_zusage_snapshot.py` 的 `SNAPSHOT_TOP_KEYS`）。

## 缓存与性能

- 聚合短缓存 2s TTL + 防膨胀清空保护（`zusage.py:146` `_cached_agg`）。
- 全库一次分组扫描合并多次全表 group by（`zusage.py:162`）——新增聚合维度优先并入既有扫描，不要追加独立全表查询。

## CLI 约定

- 子命令结构见 `main()`（`zusage.py:1461`）：json/serve/now/today/days/sessions/models/workspace/session/watch，无参数缺省 `now`，未知命令打印 docstring。
- 退出码：0 正常；1 `sqlite3.DatabaseError` 转可行动提示（不打印查询栈回溯）；2 参数非法 `SystemExit(2)`。
- 双语输出走 `L(zh, en)`（`zusage.py:122`，与 `core/install.py` 同款约定）。

## 测试

见 [../testing.md](../testing.md)。数据层特有：fixture 用 tempfile 内联最小 SQLite schema DDL（`tests/data_zusage_snapshot.py:54`）；时间基准锚定「本地今天 01:00」避免依赖运行时钟；负向结构断言（`FORBIDDEN_KEYS` 递归扫描确认删除字段不存在）；serve 行协议用进程内 stdin/stdout 替身测试。
