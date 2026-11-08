# -*- coding: utf-8 -*-
"""data_zusage_snapshot —— zusage.py 快照/投影/CLI 结构与上下文兜底单测（B-fin 数据层）。

覆盖点：
  * 临时 SQLite fixture（tempfile，绝不触碰真实 ~/.zcode）：会话/请求/工具/轮/part 最小表结构；
  * 上下文兜底（R4）：last_request_input = 最近完成请求 input（非 max，会话压缩后须回落）、
    模型目录 contextWindow 查找与 config.json 兜底；
  * snapshot() JSON 结构快照：顶层键集合固定、删除字段（价格/汇率/套餐/远端/项目）确无
    （递归扫描）、保留字段确在；
  * recent = CONTRACT §4.3 请求行投影：主会话 main_turn + 工具行、子代理 model 行
    （isSubagent=true）、辅助 query_source 不投影、空请求不投影（R10 防串数）、行数上限；
  * inputTokens 原值透传（缓存已含在 input，不重复相加）；
  * _parse_query 三协议（JSON sids / 旧逗号 / 旧管道左半段）与未知字段忽略；
  * serve 行协议往返（进程内 stdin/stdout 替身）与一次性行 CLI（main(["json", ...])）；
  * 非法值/缺表防御：库缺 model_usage 表 → local_error 记录、空快照不击穿。
运行：python3 -m unittest tests.data_zusage_snapshot（仓库根）。
"""
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import zusage            # noqa: E402

# fixture 基准毫秒时间戳 = 本地今天 01:00（今日合计查询按 completed_at 落在当天过滤，
# 全部行偏移 ≤10s，稳定落在"今天"内且不依赖运行时刻时钟）。
T0 = int(datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
         .timestamp() * 1000) + 3_600_000
_UNSET = object()   # 夹具缺省哨兵：None 表示"显式写 NULL"，区别于"不传用缺省"

# 相对原插件删除的字段/键（决策 7 零联网零凭据 + PRD Out of Scope）：任何层级不得再现
FORBIDDEN_KEYS = {"cost_usd", "rates", "fx", "scnet_estimate", "provider_fallback",
                  "remote_today", "remote_error", "remote_errors", "remote_targets",
                  "remote_enabled", "workspace_identity", "project", "c"}

SNAPSHOT_TOP_KEYS = {"local_error", "session", "last_turn", "last", "today",
                     "not_local", "known_sids", "context_window", "context_auto",
                     "code", "ctx_exc", "tools", "recent"}

CONTRACT_ROW_KEYS = {"id", "sid", "turnId", "parentSid", "kind", "isSubagent", "model",
                     "thinking", "status", "startedAt", "firstTokenAt", "completedAt",
                     "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
                     "subagentType", "task", "childSessionId"}

SCHEMA = """
create table session(
  id text primary key, project_id text, parent_id text, title text, directory text,
  summary_additions integer, summary_deletions integer, summary_files integer,
  time_created integer, time_updated integer);
create table model_usage(
  id text primary key, session_id text, turn_id text, query_source text,
  provider_id text, model_id text, status text, agent text,
  started_at integer, first_token_at integer, completed_at integer,
  duration_ms integer, time_to_first_token_ms integer,
  input_tokens integer, output_tokens integer, reasoning_tokens integer,
  cache_read_input_tokens integer, cache_creation_input_tokens integer,
  computed_total_tokens integer, retry_count integer, tool_call_count integer,
  context_exceeded integer);
create table tool_usage(
  id text primary key, session_id text, tool_name text, status text,
  tool_call_id text, started_at integer, completed_at integer, duration_ms integer);
create table turn_usage(
  session_id text, turn_id text, status text,
  model_request_count integer, model_retry_count integer,
  tool_call_count integer, tool_error_count integer,
  input_tokens integer, output_tokens integer, reasoning_tokens integer,
  cache_read_input_tokens integer, cache_creation_input_tokens integer,
  computed_total_tokens integer, duration_ms integer, time_to_first_token_ms integer,
  started_at integer, completed_at integer);
create table part(
  session_id text, data text, time_created integer, time_updated integer);
"""

MAIN = "sess_main_1"
SUB = "sess_subagent_a1"
UNKNOWN = "sess_unknown_9"
CALL_SUB = "call_sub_1"


def agent_part_data(desc, agent_id, *, call=None, subagent_type=None):
    """Agent 工具 part 的 data 形状（与宿主写库格式同构：紧凑 JSON + 回执 agentId 行）。
    callID 是运行中条目与 tool_usage.tool_call_id 的 join 键；不给则不写该字段。"""
    o = {"type": "tool",
         "tool": "Agent",
         "state": {"input": {"description": desc, "prompt": "p" * 60},
                   "output": "done\nagentId: " + agent_id}}
    if call:
        o["callID"] = call
    if subagent_type:
        o["state"]["input"]["subagent_type"] = subagent_type
    return json.dumps(o, separators=(",", ":"))


class FixtureBase(unittest.TestCase):
    """临时库夹具：每个用例独立 tempdir + 全新 schema，模块级缓存逐一重置。"""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name)
        self.db = self.tmp / "db.sqlite"
        con = sqlite3.connect(self.db)
        con.executescript(SCHEMA)
        con.commit()
        con.close()
        self.patcher = mock.patch.object(zusage, "DB_PATH", self.db)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        # 模块级缓存跨用例隔离（库文件变了，缓存键不感知库身份）
        zusage._AGG_CACHE.clear()
        zusage._TASK_CACHE.clear()
        zusage._CTX_WINDOW_CACHE.clear()
        zusage._COVERS_CACHE.update(ts=0.0, set=frozenset())
        self.addCleanup(self._reset_caches)

    @staticmethod
    def _reset_caches():
        zusage._AGG_CACHE.clear()
        zusage._TASK_CACHE.clear()
        zusage._CTX_WINDOW_CACHE.clear()
        zusage._COVERS_CACHE.update(ts=0.0, set=frozenset())

    # ---- 数据装载 ----

    def add_session(self, sid, parent=None, title="会话", directory="/w/demo"):
        con = sqlite3.connect(self.db)
        con.execute("insert into session(id, project_id, parent_id, title, directory, time_created)"
                    " values(?,?,?,?,?,?)", (sid, "proj1", parent, title, directory, T0))
        con.commit()
        con.close()

    def add_model(self, rid, sid, *, turn="t1", source="main_turn", model="glm-5",
                  provider="p1", status="completed", started=T0, first=_UNSET,
                  completed=_UNSET, inp=100, out=200, reasoning=0, cache_read=60,
                  cache_write=10, total=_UNSET, ttft=_UNSET, exceeded=0):
        first = T0 + 200 if first is _UNSET else first
        completed = T0 + 1200 if completed is _UNSET else completed
        if total is _UNSET:
            total = (inp or 0) + (out or 0)   # running 行 out=NULL 时 total 按 0+inp 兜底
        if ttft is _UNSET:
            ttft = (first - started) if first else None
        con = sqlite3.connect(self.db)
        con.execute(
            """insert into model_usage(id, session_id, turn_id, query_source, provider_id,
               model_id, status, started_at, first_token_at, completed_at,
               input_tokens, output_tokens, reasoning_tokens,
               cache_read_input_tokens, cache_creation_input_tokens,
               computed_total_tokens, time_to_first_token_ms, context_exceeded)
               values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (rid, sid, turn, source, provider, model, status, started, first, completed,
             inp, out, reasoning, cache_read, cache_write, total, ttft, exceeded))
        con.commit()
        con.close()

    def add_tool(self, rid, sid, name, status="completed", started=T0, completed=_UNSET,
                 call=None):
        completed = T0 + 500 if completed is _UNSET else completed
        duration = (completed - started) if completed is not None else None
        con = sqlite3.connect(self.db)
        con.execute("insert into tool_usage(id, session_id, tool_name, status, tool_call_id,"
                    " started_at, completed_at, duration_ms) values(?,?,?,?,?,?,?,?)",
                    (rid, sid, name, status, call, started, completed, duration))
        con.commit()
        con.close()

    def add_turn_usage(self, sid, turn="t1"):
        con = sqlite3.connect(self.db)
        con.execute(
            """insert into turn_usage(session_id, turn_id, status, model_request_count,
               model_retry_count, tool_call_count, tool_error_count, input_tokens,
               output_tokens, reasoning_tokens, cache_read_input_tokens,
               cache_creation_input_tokens, computed_total_tokens, duration_ms,
               time_to_first_token_ms, started_at, completed_at)
               values(?,?,?,2,0,1,0,200,400,0,60,10,600,1200,200,?,?)""",
            (sid, turn, "completed", T0, T0 + 1200))
        con.commit()
        con.close()

    def add_part(self, sid, data, updated=T0 + 10):
        con = sqlite3.connect(self.db)
        con.execute("insert into part(session_id, data, time_created, time_updated)"
                    " values(?,?,?,?)", (sid, data, T0, updated))
        con.commit()
        con.close()

    def session_snap(self, sid):
        """直接取指定会话的完整快照（snapshot()["session"] 是「最新活跃会话」，
        夹具里未必是被测会话，子代理列表断言走这条确定性入口）。"""
        con = zusage.connect()
        try:
            return zusage._session_snapshot(con, sid, zusage.load_config())
        finally:
            con.close()

    # ---- 断言工具 ----

    def assertNoForbiddenKeys(self, obj, path="root"):
        """递归断言裁剪字段（价格/汇率/套餐/远端/项目）在任何层级都不出现。"""
        if isinstance(obj, dict):
            for k, v in obj.items():
                self.assertNotIn(k, FORBIDDEN_KEYS, f"裁剪字段泄漏于 {path}.{k}")
                self.assertNoForbiddenKeys(v, f"{path}.{k}")
        elif isinstance(obj, list):
            for i, v in enumerate(obj):
                self.assertNoForbiddenKeys(v, f"{path}[{i}]")

    def build_standard_fixture(self):
        """标准场景：主会话 2 完成 + 1 运行中 + 1 辅助 + 1 超限错误 + 2 工具 + 1 子代理会话。"""
        self.add_session(MAIN)
        self.add_session(SUB, parent=MAIN, title="探索仓库")
        # r1：常规完成行（窗口 1000ms 有效；input=100 已含 cache_read=60 + cache_write=10）
        self.add_model("r1", MAIN, turn="t1", completed=T0 + 1200)
        # r2：Claude 模型（reasoning 恒 0），completed 最晚 → 决定 last/ctx
        self.add_model("r2", MAIN, turn="t2", model="claude-opus-5-5", inp=300, out=400,
                       started=T0 + 5000, first=T0 + 5100, completed=T0 + 7000,
                       cache_read=200, cache_write=0, total=700, ttft=100)
        # r3：运行中行（completed 缺失）：不入完成态聚合，但按原样投影（status='running'）
        self.add_model("r3", MAIN, turn="t3", status="running", completed=None,
                       started=T0 + 9000, first=T0 + 9100, inp=50, out=None, total=50)
        # r4：辅助 query_source（session_title）——不投影、不进速度口径（计入今日合计）
        self.add_model("r4", MAIN, turn="t4", source="session_title", inp=10, out=5,
                       cache_read=0, cache_write=0,
                       started=T0 + 8000, first=T0 + 8010, completed=T0 + 8100)
        # r5：上下文超限错误行（ctx_exc 数据源）
        self.add_model("r5", MAIN, turn="t5", status="error", exceeded=1,
                       started=T0 + 9500, first=None, completed=T0 + 9600, inp=0, out=0)
        # 子代理完成行（isSubagent=true）
        self.add_model("s1", SUB, source="subagent", model="glm-5", inp=1000, out=500,
                       started=T0 + 2000, first=T0 + 2200, completed=T0 + 3200,
                       cache_read=0, cache_write=0, total=1500)
        # 工具行：完成 / 运行中 / 错误
        self.add_tool("t1", MAIN, "Bash", "completed")
        self.add_tool("t2", MAIN, "Edit", "running", started=T0 + 9800, completed=None)
        self.add_tool("t3", MAIN, "Read", "error")
        self.add_turn_usage(MAIN, "t1")
        self.add_part(MAIN, agent_part_data("探索仓库", "a1", call=CALL_SUB,
                                           subagent_type="Explore"))
        self.add_tool("ta", MAIN, "Agent", "completed", started=T0 + 2000,
                      completed=T0 + 3200, call=CALL_SUB)


class SnapshotStructureTests(FixtureBase):
    """snapshot() 结构快照：顶层键、裁剪字段确无、保留字段确在。"""

    def test_top_level_keys(self):
        self.build_standard_fixture()
        snap = zusage.snapshot(MAIN)
        self.assertEqual(set(snap.keys()), SNAPSHOT_TOP_KEYS)

    def test_forbidden_keys_absent(self):
        self.build_standard_fixture()
        snap = zusage.snapshot(MAIN)
        self.assertNoForbiddenKeys(snap)

    def test_session_snapshot_fields(self):
        self.build_standard_fixture()
        s = zusage.snapshot(MAIN)["session"]
        for key in ("sid", "title", "active", "turns", "requests", "input", "output",
                    "reasoning", "cache_read", "cache_write", "total", "tool_calls",
                    "retries", "ctx", "updated", "started", "avg_tps", "speed_segs",
                    "sub", "tools", "models", "last_turn", "last", "code", "ctx_exc",
                    "context_window", "context_auto", "last_at", "is_sub", "parent"):
            self.assertIn(key, s)
        self.assertEqual(s["sid"], MAIN)
        self.assertEqual(s["is_sub"], False)
        self.assertEqual(s["parent"], None)

    def test_today_and_known_sids(self):
        self.build_standard_fixture()
        snap = zusage.snapshot(MAIN + "," + UNKNOWN)
        self.assertEqual(snap["known_sids"], [MAIN])
        self.assertEqual(snap["not_local"], [UNKNOWN])
        # 今日合计 = 主会话 + 子代理的全部 completed 行（r1/r2/r4/s1；r3 running、r5 error 不计）
        self.assertEqual(snap["today"]["requests"], 4)
        self.assertEqual(snap["today"]["input"], 100 + 300 + 10 + 1000)
        self.assertEqual(snap["today"]["cache_read"], 60 + 200 + 0 + 0)
        self.assertNotIn("cost_usd", snap["today"])
        self.assertNotIn("models", snap["today"])

    def test_empty_request_returns_empty_rows(self):
        """无指定会话 → recent 空数组（不推其它会话数据，R10 防串数）；session 仍为最新会话。"""
        self.build_standard_fixture()
        snap = zusage.snapshot("")
        self.assertEqual(snap["recent"], [])
        self.assertEqual(snap["session"]["sid"], MAIN)
        self.assertEqual(snap["known_sids"], [])


class RequestRowProjectionTests(FixtureBase):
    """recent 请求行投影：范围、字段形状、缓存不重复、上限。"""

    def rows_of(self, snap):
        return snap["recent"]

    def test_projection_scope_and_shape(self):
        self.build_standard_fixture()
        snap = zusage.snapshot(MAIN)
        rows = self.rows_of(snap)
        self.assertTrue(rows)
        for r in rows:
            self.assertEqual(set(r.keys()), CONTRACT_ROW_KEYS)
        by_id = {r["id"]: r for r in rows}
        # 主会话完成行在投影内
        self.assertIn("r1", by_id)
        self.assertIn("r2", by_id)
        # 辅助 query_source 不投影（宁可少算不可串数）
        self.assertNotIn("r4", by_id)
        # 错误行原样投影（status='error'，消费方自行忽略）
        self.assertEqual(by_id["r5"]["status"], "error")
        # 运行中行原样投影
        self.assertEqual(by_id["r3"]["status"], "running")
        # 子代理行 isSubagent=true，主会话行 false
        self.assertTrue(by_id["s1"]["isSubagent"])
        self.assertFalse(by_id["r1"]["isSubagent"])
        # 工具行 kind='tool'，token 分项恒 0
        tool = next(r for r in rows if r["kind"] == "tool" and r["id"] == "t1")
        self.assertEqual(tool["model"], "Bash")
        self.assertEqual(tool["status"], "completed")
        self.assertEqual(tool["outputTokens"], 0)
        self.assertEqual((tool["inputTokens"], tool["cacheReadTokens"]), (0, 0))
        # 运行中工具行也投影（步数口径由消费方只认 completed）
        self.assertEqual(by_id["t2"]["status"], "running")
        # 空值字段在每种行上都存在（消费方按固定形状读，不做 key 探测）
        for r in rows:
            self.assertIn(r["parentSid"], (None, MAIN))
            for key in ("subagentType", "task", "childSessionId"):
                self.assertIn(key, r)

    def test_parent_sid_marks_subagent_origin(self):
        """parentSid：子代理行带父会话 id（sid 是子会话，内核按它分桶），其余为 None。"""
        self.build_standard_fixture()
        by_id = {r["id"]: r for r in self.rows_of(zusage.snapshot(MAIN))}
        self.assertEqual(by_id["s1"]["sid"], SUB)
        self.assertEqual(by_id["s1"]["parentSid"], MAIN)
        self.assertIsNone(by_id["r1"]["parentSid"])
        self.assertIsNone(by_id["t1"]["parentSid"])
        self.assertIsNone(by_id["ta"]["parentSid"])

    def test_subagent_kind_rows_carry_task_type_and_child(self):
        """Agent 工具行投影为 kind='subagent'：带任务名、类型与回执关联的子会话 id，
        token 恒 0（子代理 token 由 isSubagent 的 model 行承担，不重复计）。"""
        self.build_standard_fixture()
        subs = [r for r in self.rows_of(zusage.snapshot(MAIN)) if r["kind"] == "subagent"]
        self.assertEqual(len(subs), 1)
        row = subs[0]
        self.assertEqual(row["id"], CALL_SUB)
        self.assertEqual(row["sid"], MAIN)
        self.assertEqual(row["parentSid"], MAIN)
        self.assertTrue(row["isSubagent"])
        self.assertEqual(row["status"], "completed")
        self.assertEqual(row["task"], "探索仓库")
        self.assertEqual(row["subagentType"], "Explore")
        self.assertEqual(row["childSessionId"], SUB)
        self.assertEqual(
            (row["inputTokens"], row["outputTokens"],
             row["cacheReadTokens"], row["cacheWriteTokens"]), (0, 0, 0, 0))
        # 同一次调用仍有一条 kind='tool' 行：步数口径保持不变
        tools = [r for r in self.rows_of(zusage.snapshot(MAIN))
                 if r["kind"] == "tool" and r["model"] == "Agent"]
        self.assertEqual(len(tools), 1)

    def test_running_subagent_row_from_tool_usage(self):
        """运行中子代理：tool_usage 的 running Agent 行 + part 的 callID 关联出任务名与类型。"""
        self.build_standard_fixture()
        self.add_tool("trun", MAIN, "Agent", "running", started=T0 + 20000, completed=None,
                      call="call_live_1")
        self.add_part(MAIN, agent_part_data("恢复工具调用明细分组", "a2",
                                           call="call_live_1",
                                           subagent_type="pstack-zcode:poteto-agent"),
                      updated=T0 + 20001)
        zusage._TASK_CACHE.clear()
        rows = self.rows_of(zusage.snapshot(MAIN))
        live = next(r for r in rows if r["kind"] == "subagent"
                    and r["status"] == "running")
        self.assertEqual(live["id"], "call_live_1")
        self.assertEqual(live["parentSid"], MAIN)
        self.assertEqual(live["task"], "恢复工具调用明细分组")
        self.assertEqual(live["subagentType"], "pstack-zcode:poteto-agent")
        self.assertIsNone(live["childSessionId"])   # 子会话还没建
        self.assertIsNone(live["completedAt"])
        self.assertEqual(live["startedAt"], T0 + 20000)

    def test_running_subagent_survives_missing_part(self):
        """工具行在、part 缺失：条目照出，任务名与类型回落 null，绝不抛异常。"""
        self.build_standard_fixture()
        self.add_tool("trun", MAIN, "Agent", "running", started=T0 + 20000, completed=None,
                      call="call_live_2")
        zusage._TASK_CACHE.clear()
        live = next(r for r in self.rows_of(zusage.snapshot(MAIN))
                    if r["id"] == "call_live_2")
        self.assertEqual(live["status"], "running")
        self.assertIsNone(live["task"])
        self.assertIsNone(live["subagentType"])

    def test_malformed_part_does_not_break_projection(self):
        """part.data 非法 JSON：该条静默跳过，其余行与条目照常产出。"""
        self.build_standard_fixture()
        self.add_tool("trun", MAIN, "Agent", "running", started=T0 + 20000, completed=None,
                      call="call_live_3")
        self.add_part(MAIN, "{not json", updated=T0 + 20002)
        zusage._TASK_CACHE.clear()
        rows = self.rows_of(zusage.snapshot(MAIN))
        self.assertTrue(any(r["id"] == "call_live_3" for r in rows))
        self.assertTrue(any(r["id"] == "r1" for r in rows))

    def test_input_tokens_include_cache_without_double_counting(self):
        """inputTokens 原值透传：100 = 净输入 30 + 缓存读 60 + 缓存写 10，绝不重复相加。"""
        self.build_standard_fixture()
        rows = self.rows_of(zusage.snapshot(MAIN))
        r1 = next(r for r in rows if r["id"] == "r1")
        self.assertEqual(r1["inputTokens"], 100)
        self.assertEqual(r1["cacheReadTokens"], 60)
        self.assertEqual(r1["cacheWriteTokens"], 10)
        self.assertEqual(
            r1["inputTokens"] - r1["cacheReadTokens"] - r1["cacheWriteTokens"], 30)

    def test_projection_sorted_and_capped(self):
        self.build_standard_fixture()
        rows = self.rows_of(zusage.snapshot(MAIN))
        times = [(r["completedAt"] if r["completedAt"] is not None else r["startedAt"]) or 0
                 for r in rows]
        self.assertEqual(times, sorted(times))   # 完成时间升序
        # 行数上限：cap=3 时只保留最近 3 行（按 coalesce(completed, started) 取最近）
        con = sqlite3.connect(self.db)
        con.row_factory = sqlite3.Row
        limited = zusage._project_request_rows(con, [MAIN], cap=3)
        con.close()
        self.assertEqual(len(limited), 3)
        self.assertEqual(limited[-1]["id"], "t2")   # 最近时间戳的行保留在末尾

    def test_subagent_rows_only_for_requested_session(self):
        """只投影请求会话及其子代理；兄弟会话的数据绝不混入（R10）。"""
        self.build_standard_fixture()
        other = "sess_other_2"
        self.add_session(other)
        self.add_model("o1", other, inp=77, out=88, completed=T0 + 9999)
        snap = zusage.snapshot(MAIN)
        ids = {r["id"] for r in snap["recent"]}
        self.assertNotIn("o1", ids)
        snap2 = zusage.snapshot(MAIN + "," + other)
        ids2 = {r["id"] for r in snap2["recent"]}
        self.assertIn("o1", ids2)
        self.assertIn("s1", ids2)


class SubagentListTests(FixtureBase):
    """session.sub.list：一种条目形状承载运行中与已结束两态（design §2 / §4.2）。"""

    def item_of(self, status=None, call=None):
        items = self.session_snap(MAIN)["sub"]["list"]
        for it in items:
            if status and it["status"] != status:
                continue
            if call and it["toolCallId"] != call:
                continue
            return it
        self.fail(f"sub.list 无匹配条目 status={status} call={call}: {items}")

    def test_done_item_fields(self):
        self.build_standard_fixture()
        it = self.item_of(status="completed")
        self.assertEqual(it["childSessionId"], SUB)
        self.assertEqual(it["toolCallId"], CALL_SUB)
        self.assertEqual(it["type"], "Explore")
        self.assertEqual(it["task"], "探索仓库")
        self.assertEqual(it["requests"], 1)
        self.assertEqual(it["total"], 1500)
        self.assertEqual(it["started"], T0 + 2000)
        self.assertEqual(it["endedAt"], T0 + 3200)
        self.assertEqual(it["durationMs"], 1200)
        for key in ("sid", "agent", "title", "status", "toolCallId", "childSessionId",
                    "type", "task", "started", "endedAt", "durationMs", "requests",
                    "input", "output", "cache_read", "reasoning", "cache_write",
                    "last", "tps_avg", "active"):
            self.assertIn(key, it)

    def test_running_item_from_agent_tool_row(self):
        self.build_standard_fixture()
        self.add_tool("trun", MAIN, "Agent", "running", started=T0 + 20000, completed=None,
                      call="call_live_1")
        self.add_part(MAIN, agent_part_data("调研留白来源", "a2", call="call_live_1",
                                           subagent_type="Explore"), updated=T0 + 20001)
        zusage._TASK_CACHE.clear()
        it = self.item_of(status="running", call="call_live_1")
        self.assertEqual(it["type"], "Explore")
        self.assertEqual(it["task"], "调研留白来源")
        self.assertIsNone(it["childSessionId"])
        self.assertIsNone(it["endedAt"])
        self.assertEqual(it["requests"], 0)
        self.assertEqual(it["total"], 0)
        self.assertEqual(it["started"], T0 + 20000)
        self.assertIsNotNone(it["durationMs"])
        self.assertGreater(it["durationMs"], 0)
        self.assertTrue(it["active"])

    def test_running_items_sorted_by_dispatch_then_done_by_recency(self):
        self.build_standard_fixture()
        self.add_tool("r2nd", MAIN, "Agent", "running", started=T0 + 22000, completed=None,
                      call="call_b")
        self.add_tool("r1st", MAIN, "Agent", "running", started=T0 + 20000, completed=None,
                      call="call_a")
        zusage._TASK_CACHE.clear()
        items = self.session_snap(MAIN)["sub"]["list"]
        self.assertEqual([it["toolCallId"] for it in items[:2]], ["call_a", "call_b"])
        self.assertEqual(items[-1]["status"], "completed")   # 已结束排在运行中之后

    def test_ended_statuses_follow_tool_row(self):
        """design §4.2 优先级 1：有工具行时取工具行状态（completed / error / cancelled）。"""
        self.add_session(MAIN)
        cases = [("a1", "completed"), ("a2", "error"), ("a3", "cancelled")]
        for agent, status in cases:
            child = "sess_subagent_" + agent
            self.add_session(child, parent=MAIN)
            self.add_model("m_" + agent, child, source="subagent")
            self.add_part(MAIN, agent_part_data("任务" + agent, agent,
                                                call="call_" + agent,
                                                subagent_type="Explore"),
                          updated=T0 + 10)
            self.add_tool("t_" + agent, MAIN, "Agent", status,
                          started=T0 + 1000, completed=T0 + 2000, call="call_" + agent)
        zusage._TASK_CACHE.clear()
        by_child = {it["childSessionId"]: it for it in
                    self.session_snap(MAIN)["sub"]["list"]}
        for agent, status in cases:
            self.assertEqual(by_child["sess_subagent_" + agent]["status"], status,
                             f"{agent} 状态应取工具行")

    def test_status_falls_back_to_completed_without_tool_row(self):
        """design §4.2 优先级 2：无工具行按 model 行推断（查询只取 completed 行 → completed）。"""
        self.add_session(MAIN)
        self.add_session(SUB, parent=MAIN)
        self.add_model("s1", SUB, source="subagent")
        self.add_part(MAIN, agent_part_data("只有模型行", "a1"))
        zusage._TASK_CACHE.clear()
        items = self.session_snap(MAIN)["sub"]["list"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["childSessionId"], SUB)
        self.assertEqual(items[0]["status"], "completed")
        self.assertIsNone(items[0]["toolCallId"])   # 没有工具行就没有 callID

    def test_tool_row_without_child_session_still_listed(self):
        """工具行有回执缺失：条目照出（childSessionId null），不因关联失败而消失。"""
        self.add_session(MAIN)
        self.add_tool("t_orphan", MAIN, "Agent", "completed", started=T0 + 1000,
                      completed=T0 + 2000, call="call_orphan")
        self.add_part(MAIN, json.dumps({"type": "tool", "tool": "Agent",
                                        "callID": "call_orphan",
                                        "state": {"input": {"description": "孤儿任务"},
                                                  "output": ""}},
                                       separators=(",", ":")))
        zusage._TASK_CACHE.clear()
        items = self.session_snap(MAIN)["sub"]["list"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["task"], "孤儿任务")
        self.assertIsNone(items[0]["childSessionId"])
        self.assertEqual(items[0]["status"], "completed")

    def test_missing_tool_call_id_column_degrades_silently(self):
        """瘦身库无 tool_call_id 列：Agent 行不产条目，其余投影与条目照常（不抛异常）。"""
        self.build_standard_fixture()
        con = sqlite3.connect(self.db)
        con.executescript("alter table tool_usage drop column tool_call_id;")
        con.commit()
        con.close()
        zusage._TASK_CACHE.clear()
        snap = zusage.snapshot(MAIN)
        self.assertIsNone(snap["local_error"])
        self.assertFalse(any(r["kind"] == "subagent" for r in snap["recent"]))
        self.assertEqual(
            [i["childSessionId"] for i in self.session_snap(MAIN)["sub"]["list"]], [SUB])


class ContextFallbackTests(FixtureBase):
    """上下文兜底（R4）：最近完成请求 input + 模型目录窗口查找 + config 兜底。"""

    def test_last_request_input_is_latest_completed_not_max(self):
        """ctx = 最近一次 completed 请求的 input（会话压缩后 input 骤降必须回落，非 max）。"""
        self.add_session(MAIN)
        # 早期大请求 input=9000；最近完成请求 input=300 → ctx 必须是 300
        self.add_model("big", MAIN, inp=9000, out=100, completed=T0 + 1000)
        self.add_model("recent", MAIN, model="claude-opus-5-5", inp=300, out=50,
                       started=T0 + 5000, first=T0 + 5100, completed=T0 + 7000)
        s = zusage.snapshot(MAIN)["session"]
        self.assertEqual(s["ctx"], 300)
        # 运行中/错误行不参与（再加一条更晚的 running，不改变 ctx）
        self.add_model("running", MAIN, status="running", inp=99999, out=None,
                       started=T0 + 9000, first=T0 + 9100, completed=None)
        zusage._AGG_CACHE.clear()
        s = zusage.snapshot(MAIN)["session"]
        self.assertEqual(s["ctx"], 300)

    def test_context_window_falls_back_to_config(self):
        self.add_session(MAIN)
        self.add_model("r1", MAIN)
        snap = zusage.snapshot(MAIN)
        # 仓库环境无客户端模型目录（CATALOG_PATH 为 Windows 布局）→ 走 config 兜底
        self.assertEqual(snap["context_window"], 128000)
        self.assertEqual(snap["context_auto"], False)

    def test_lookup_context_window_from_catalog(self):
        """模型目录查找：命中/大小写不敏感/未命中，均带缓存。"""
        catalog = self.tmp / "catalog.json"
        catalog.write_text(json.dumps({"providers": [
            {"models": [{"id": "GLM-5", "contextWindow": 200000},
                        {"id": "kimi-k3", "contextWindow": 256000}]},
        ]}), encoding="utf-8")
        zusage._CTX_WINDOW_CACHE.clear()
        with mock.patch.object(zusage, "CATALOG_PATH", catalog):
            self.assertEqual(zusage.lookup_context_window("glm-5"), 200000)
            self.assertEqual(zusage.lookup_context_window("KIMI-K3"), 256000)
            self.assertIsNone(zusage.lookup_context_window("no-such-model"))
            # 命中结果进缓存：目录移除后仍可读（缓存生效），未命中也缓存 None
            catalog.unlink()
            self.assertEqual(zusage.lookup_context_window("glm-5"), 200000)
        self.assertIsNone(zusage.lookup_context_window(""))


class ParseQueryAndServeTests(FixtureBase):
    """请求行解析三协议与 serve 常驻行协议往返。"""

    def test_parse_query_json(self):
        self.assertEqual(zusage._parse_query('{"sids": ["a", "b"]}'), "a,b")
        # 未知字段（已裁剪的 scopes 等）忽略——内核向后兼容约定
        self.assertEqual(zusage._parse_query('{"sids": ["a"], "scopes": [{"sid": "a"}]}'), "a")
        self.assertEqual(zusage._parse_query('{"sids": []}'), "")
        with self.assertRaises(ValueError):
            zusage._parse_query('{"sids": "a"}')

    def test_parse_query_legacy(self):
        self.assertEqual(zusage._parse_query("a,b"), "a,b")
        # 旧 "sids|routes" 协议：远端路由段已裁剪，只取左半段
        self.assertEqual(zusage._parse_query("a,b|a@t1"), "a,b")
        self.assertEqual(zusage._parse_query(""), "")
        self.assertEqual(zusage._parse_query("  "), "")

    def test_serve_round_trip(self):
        self.build_standard_fixture()
        stdin = io.StringIO(json.dumps({"sids": [MAIN]}) + "\n")
        out = io.StringIO()
        with mock.patch.object(sys, "stdin", stdin), mock.patch.object(sys, "stdout", out):
            zusage.serve()
        lines = [ln for ln in out.getvalue().splitlines() if ln.strip()]
        self.assertEqual(len(lines), 1)
        payload = json.loads(lines[0])
        self.assertEqual(set(payload.keys()), SNAPSHOT_TOP_KEYS)
        self.assertEqual(payload["known_sids"], [MAIN])
        self.assertTrue(any(r["isSubagent"] for r in payload["recent"]))
        self.assertNoForbiddenKeys(payload)

    def test_serve_bad_line_survives(self):
        """坏请求行不杀常驻进程：输出 error JSON，EOF 正常退出。"""
        out = io.StringIO()
        with (mock.patch.object(sys, "stdin", io.StringIO("{broken json\n")),
              mock.patch.object(sys, "stdout", out)):
            zusage.serve()
        payload = json.loads(out.getvalue().strip())
        self.assertIn("error", payload)

    def test_cli_json_command(self):
        self.build_standard_fixture()
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = zusage.main(["json", json.dumps({"sids": [MAIN]})])
        self.assertEqual(rc, 0)
        payload = json.loads(buf.getvalue())
        self.assertEqual(payload["session"]["sid"], MAIN)
        self.assertNoForbiddenKeys(payload)


class ResilienceTests(FixtureBase):
    """非法值/缺表防御：缺 model_usage 表不击穿快照，错误进 local_error。"""

    def test_missing_model_usage_table(self):
        """connect 的 mode=ro 探测失败 → 普通连接兜底 → 查询期缺表 → 空快照 + local_error。"""
        con = sqlite3.connect(self.db)
        con.executescript("drop table model_usage; drop table tool_usage;")
        con.commit()
        con.close()
        zusage._AGG_CACHE.clear()
        snap = zusage.snapshot(MAIN)
        self.assertIsNotNone(snap["local_error"])
        self.assertEqual(snap["session"]["sid"], "")
        self.assertEqual(snap["recent"], [])
        self.assertEqual(snap["today"]["requests"], 0)

    def test_missing_db_file_raises(self):
        """库文件不存在：connect 直接抛错（绝不新建空库），snapshot 落空快照。"""
        self.db.unlink()
        snap = zusage.snapshot(MAIN)
        self.assertIsNotNone(snap["local_error"])
        self.assertEqual(snap["session"]["sid"], "")
        self.assertEqual(snap["recent"], [])

    def test_session_snapshot_empty_session(self):
        """空会话（无任何请求）：全零聚合、ctx=0、不抛异常。"""
        self.add_session(MAIN)
        snap = zusage.snapshot(MAIN)
        s = snap["session"]
        self.assertEqual((s["turns"], s["requests"], s["ctx"], s["total"]), (0, 0, 0, 0))
        self.assertEqual(s["sub"]["list"], [])
        self.assertEqual(s["speed_segs"], [])


if __name__ == "__main__":
    unittest.main()
