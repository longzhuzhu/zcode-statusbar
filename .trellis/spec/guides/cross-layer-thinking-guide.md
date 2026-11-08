# 跨层数据流思维指南

> **目的**：实现前先想清楚数据怎么跨层流动。
>
> 大多数 bug 发生在层边界，不在层内。本仓库的层：内核（core/）→ 数据层（zusage.py/usage_stats.py）→ 聚合（session-stats.cjs）→ 渲染（statusbar.js）。

---

## 实现跨层功能之前

### 第一步：画数据流

```
SQLite 请求行 → zusage.py 投影(recent) → 内核泵(JSON 行协议)
  → session-stats.aggregate(rows) → webContents 推送 zcode-statusbar:session
  → statusbar.js normalizeSession → 渲染
```

对每条箭头问：格式是什么？哪里会出错？谁负责校验？

### 第二步：认边界

| 边界 | 本仓库的既有契约 |
|---|---|
| Node ↔ Python 进程 | stdout 单行 JSON 协议（`core/plugin-updater.cjs:104` 调 `runtime_lock.py`） |
| SQLite → 聚合输入 | CONTRACT §4.3 行形状；非有限数值 = 缺失逐行跳过 |
| 聚合 → 渲染 | CONTRACT §4.2 aggregate 输出形状 |
| 渲染端 ↔ 内核 | window 事件 + `__ZCODE_STATUSBAR_REQUESTS__` 队列白名单 |

### 第三步：定契约与校验位置

**校验在数据入口做一次**，不层层散落：`normalizeSession()` 在渲染端入口拒绝未知形状（`statusbar/statusbar.js:616`）；`connect()` 在数据层入口拒绝不存在的库文件（`zusage.py:77`）。

---

## 本仓库的跨层纪律

### 纪律 1：契约先行 + 偏差显式登记

`statusbar/CONTRACT.md:5`：「任何字段/事件改名必须先改本文」。实现与基线的偏差登记在两个文件头注释块 + CONTRACT §8 汇总表，互相引用（如 §8 第 5 条 ↔ `session-stats.cjs` 头注释）。**新增字段/事件：先改契约 → 再改实现 → 偏差两处登记**。

### 纪律 2：R10 防串数贯穿三层

宁可少算/不渲染，不可渲染错口径。同一铁律在三层各有落点：

- 数据层：投影范围限制（`zusage.py` docstring 行 37-40）
- 聚合层：严格 `status === 'completed'`、非有限值跳过（`statusbar/session-stats.cjs:114`）
- 渲染层：身份门 + 形状拒绝（`statusbar/statusbar.js:779`、`:616`）

给任一层加数据通路时，检查 R10 在新通路上是否仍然成立。

### 纪律 3：改名联动表

内核改名不是单文件操作。`core/patch_install.py:8` 的文件头记录了完整联动表（`.zusage.lock` → `.zcstatusbar.lock` 等），涉及锁文件、sidecar、监控、桥、环境变量跨文件改名。**改名前先 rg 旧名，把命中清单列为联动表，逐项改完后清残留**（见 [code-reuse-thinking-guide.md](./code-reuse-thinking-guide.md) 教训 4）。

### 纪律 4：布局双面性

仓库布局（`core/` + `statusbar/` + 根级脚本）≠ 分发/运行布局（core 平铺 + `plugins/zcode-statusbar/` 扁平副本）。改动源码后不同步生成物的后果：插件包内是旧代码、`--check` 漂移退出 1。收尾动作固定：`python3 core/sync_plugin.py`。

### 纪律 5：双侧协议改动同改两处

Node 侧调用面（`core/plugin-updater.cjs:104` 的 `--hold/--update-config/...`）与 Python 侧解析面（`core/runtime_lock.py` CLI）必须同改；内嵌 Node 验收器字符串（`core/runtime_install.py:393`）同理。改协议任何一侧前，先 rg 另一侧的命令字面量。

---

## 跨层功能检查表

实现前：

- [ ] 画出完整数据流，认出所有边界
- [ ] 每个边界的输入/输出格式写进 CONTRACT.md 或对应 spec
- [ ] 决定校验发生在哪一层（入口一次，不散落）

实现后：

- [ ] 边界坏数据逐类喂过（null/空/非法/NaN——参考 `tests/stats-session.test.cjs:188`）
- [ ] 数据往返无损失（SQLite 行 → JSON 快照 → 渲染状态）
- [ ] 新字段进了 CONTRACT §2/§3/§4 对应小节；偏差进了 §8
- [ ] 生成副本已同步（`python3 core/sync_plugin.py --check` 通过）
