# -*- coding: utf-8 -*-
"""data_zusage_rate —— zusage.py / usage_stats.py 速度口径纯函数单测（B-fin 数据层）。

覆盖点（任务要求：窗口边界 200ms/1h、思考窗、缓存不重复、子代理排除、非法值防御）：
  * _valid_gen_window：200ms 含下限、1h 不含上限、None/负值防御；
  * _row_gen_ms：首字窗、思考窗（reasoning>0 / Claude 模型）、covers（首块落章）回首字窗、
    非法时间防御；
  * _rate_sample / _turn_rate / _rated_tps：评级、unrated 桶、加权均、除零防御；
  * _covers_from_rows：最小二乘斜率判据的样本量/阈值边界；
  * _is_subagent_row / 投影行：子代理标记、inputTokens 含缓存不重复相加（原值透传）；
  * usage_stats.request_stats / aggregate_requests：同一口径的独立实现对照。
全部纯函数/内存数据，无 I/O、无真实 ~/.zcode 访问。
运行：python3 -m unittest tests.data_zusage_rate（仓库根）。
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import zusage            # noqa: E402
import usage_stats       # noqa: E402


def mrow(**kw):
    """构造 model_usage 行形状的 dict（字段名与 SQLite 列一致）。"""
    base = dict(first_token_at=1000, completed_at=3000, started_at=0,
                reasoning_tokens=0, model_id="glm-5", provider_id="p1",
                output_tokens=100, input_tokens=0)
    base.update(kw)
    return base


class ValidGenWindowTests(unittest.TestCase):
    """有效生成窗口边界：200ms ≤ 窗 < 1h（含下限、不含上限）。"""

    def test_lower_bound_inclusive(self):
        self.assertTrue(zusage._valid_gen_window(200))
        self.assertFalse(zusage._valid_gen_window(199))
        self.assertFalse(zusage._valid_gen_window(0))

    def test_upper_bound_exclusive(self):
        self.assertTrue(zusage._valid_gen_window(3_599_999))
        self.assertFalse(zusage._valid_gen_window(3_600_000))

    def test_invalid_values(self):
        self.assertFalse(zusage._valid_gen_window(None))
        self.assertFalse(zusage._valid_gen_window(-1))
        self.assertFalse(zusage._valid_gen_window(float("nan")))


class RowGenMsTests(unittest.TestCase):
    """单行生成窗口：首字窗为基线，思考/Claude 用 started_at 窗，covers 回首字窗。"""

    def test_first_token_window(self):
        # 无思考：completed_at - first_token_at = 2000ms
        self.assertEqual(zusage._row_gen_ms(mrow()), 2000)

    def test_thinking_row_uses_started_at(self):
        # reasoning>0：思考在首字前流出 → 窗口前移到 started_at（900→3000 = 2100ms）
        self.assertEqual(zusage._row_gen_ms(mrow(reasoning_tokens=50, started_at=900)), 2100)

    def test_claude_model_uses_started_at_even_without_reasoning(self):
        # Claude 系列 reasoning 恒 0 但思考在首字前 → 同样用 started_at 窗
        self.assertEqual(
            zusage._row_gen_ms(mrow(model_id="claude-opus-5-5", started_at=900)), 2100)
        self.assertEqual(
            zusage._row_gen_ms(mrow(model_id="Claude-Sonnet-9", started_at=900)), 2100)   # 不分大小写

    def test_covered_provider_keeps_first_token_window(self):
        # 「首块落章」provider：思考已在首字窗内，不前移（避免把输入预处理摊进生成耗时）
        self.assertEqual(
            zusage._row_gen_ms(mrow(reasoning_tokens=50, started_at=900), covers={"p1"}), 2000)

    def test_zero_started_at_treated_as_missing(self):
        # started_at=0 按「缺失」处理（st 真值判定）：思考行退回首字窗
        self.assertEqual(zusage._row_gen_ms(mrow(reasoning_tokens=50, started_at=0)), 2000)

    def test_missing_or_inverted_times(self):
        self.assertIsNone(zusage._row_gen_ms(mrow(first_token_at=None)))
        self.assertIsNone(zusage._row_gen_ms(mrow(first_token_at=0)))
        self.assertIsNone(zusage._row_gen_ms(mrow(completed_at=None)))
        self.assertIsNone(zusage._row_gen_ms(mrow(first_token_at=3000, completed_at=1000)))
        # started_at 缺失时思考行退回首字窗（st 不成立则不前移）
        self.assertEqual(zusage._row_gen_ms(mrow(reasoning_tokens=50, started_at=None)), 2000)

    def test_provider_column_missing(self):
        # sqlite3.Row 缺 provider_id 列（旧库列漂移）：按无 provider 处理，不抛异常
        row = mrow(reasoning_tokens=50, started_at=900)
        del row["provider_id"]
        self.assertEqual(zusage._row_gen_ms(row), 2100)


class RateSampleTests(unittest.TestCase):
    """单行速度样本：output>0 且窗口有效才评级。"""

    def test_rated_sample(self):
        s = zusage._rate_sample(mrow(output_tokens=300, first_token_at=1000, completed_at=2000))
        self.assertEqual(s, {"tps": 300.0, "startedAt": 0, "endedAt": 2000})

    def test_unrated(self):
        self.assertIsNone(zusage._rate_sample(mrow(output_tokens=0)))
        self.assertIsNone(zusage._rate_sample(mrow(output_tokens=None)))
        # 窗口 199ms（1000→1199）低于下限：不评级
        self.assertIsNone(zusage._rate_sample(
            mrow(output_tokens=300, first_token_at=1000, completed_at=1199)))
        # 窗口恰 1h：不评级（上限不含）
        self.assertIsNone(zusage._rate_sample(
            mrow(output_tokens=300, first_token_at=0, completed_at=3_600_000)))
        self.assertIsNone(zusage._rate_sample(None))


class TurnRateTests(unittest.TestCase):
    """加权均口径：Σ有效输出 ÷ Σ有效窗口；无效段输出进 unrated 桶，绝不进分母。"""

    def test_weighted_average(self):
        rows = [mrow(output_tokens=200, first_token_at=1000, completed_at=2000),   # 200 tok/s
                mrow(output_tokens=300, first_token_at=1000, completed_at=3000)]   # 150 tok/s
        r = zusage._turn_rate(rows)
        # (200+300) / ((1000+2000)/1000) = 166.7
        self.assertEqual(r["tps"], 166.7)
        self.assertEqual(r["rated_output"], 500)
        self.assertEqual(r["unrated_output"], 0)
        self.assertEqual(r["gen_ms"], 3000)

    def test_invalid_rows_go_to_unrated(self):
        rows = [mrow(output_tokens=200, first_token_at=1000, completed_at=2000),
                mrow(output_tokens=999, first_token_at=1000, completed_at=1100),   # 100ms 窗无效
                mrow(output_tokens=1, first_token_at=None, completed_at=3000)]     # 无窗
        r = zusage._turn_rate(rows)
        self.assertEqual(r["rated_output"], 200)
        self.assertEqual(r["unrated_output"], 1000)
        self.assertEqual(r["tps"], 200.0)

    def test_empty_rows(self):
        r = zusage._turn_rate([])
        self.assertEqual(r, {"tps": 0, "rated_output": 0, "unrated_output": 0, "gen_ms": 0})

    def test_rated_tps_zero_guard(self):
        self.assertEqual(zusage._rated_tps(500, 0), 0)
        self.assertEqual(zusage._rated_tps(500, None), 0)
        self.assertEqual(zusage._rated_tps(500, 1000), 500.0)


class CoversFromRowsTests(unittest.TestCase):
    """首块落章判据：斜率 <2.0 ms/token 且样本 ≥5。"""

    @staticmethod
    def agg_row(n, sx, sy, sxy, sxx, provider="pv"):
        return {"n": n, "sx": sx, "sy": sy, "sxy": sxy, "sxx": sxx, "provider_id": provider}

    def test_flat_slope_is_covered(self):
        # 斜率 0（ttft 不随推理量增长：reasoning 0..9，ttft 恒 500）→ 首块落章
        # slope = (n·sxy − sx·sy)/(n·sxx − sx²) = (225000−225000)/(2850−2025) = 0
        rows = [self.agg_row(10, 45, 5000, 22500, 285)]
        self.assertEqual(zusage._covers_from_rows(rows), {"pv"})

    def test_steep_slope_not_covered(self):
        # 斜率 = 10 ms/token ≥ 2.0（ttft = 10×reasoning）：推理在首字前完成 → 不进集合
        rows = [self.agg_row(10, 45, 450, 2850, 285)]
        self.assertEqual(zusage._covers_from_rows(rows), set())

    def test_small_sample_not_covered(self):
        rows = [self.agg_row(4, 100, 5000, 50000, 1000)]
        self.assertEqual(zusage._covers_from_rows(rows), set())

    def test_degenerate_denominator_not_covered(self):
        # 推理量恒定（sxx*n == sx^2）：分母为 0 不判，走保守口径
        rows = [self.agg_row(10, 100, 5000, 50000, 1000)]
        rows[0]["sxx"] = 1000   # n*sxx - sx^2 = 10000-10000 = 0
        self.assertEqual(zusage._covers_from_rows(rows), set())


class SubagentAndProjectionTests(unittest.TestCase):
    """子代理标记与 CONTRACT §4.3 投影行（缓存不重复、字段齐全）。"""

    def test_is_subagent_row(self):
        self.assertTrue(zusage._is_subagent_row("sess_x", "subagent"))
        self.assertTrue(zusage._is_subagent_row("sess_subagent_abc", "main_turn"))
        self.assertFalse(zusage._is_subagent_row("sess_x", "main_turn"))
        self.assertFalse(zusage._is_subagent_row("sess_x", None))
        self.assertFalse(zusage._is_subagent_row(None, None))

    def test_model_contract_row_shape(self):
        r = zusage._model_contract_row({
            "id": 7, "session_id": "sess_x", "turn_id": "turn-1",
            "query_source": "main_turn",
            "model_id": "glm-5", "status": "completed", "started_at": 100,
            "first_token_at": 200, "completed_at": 900,
            # input_tokens=100 已含 cache_read=60（缓存已含在 input，原值透传不重复相加）
            "input_tokens": 100, "output_tokens": 50,
            "reasoning_tokens": 10, "cache_read_input_tokens": 60,
            "cache_creation_input_tokens": 5,
        })
        self.assertEqual(r, {
            "id": "7", "sid": "sess_x", "turnId": "turn-1", "parentSid": None,
            "kind": "model", "isSubagent": False, "model": "glm-5",
            "thinking": True, "status": "completed", "startedAt": 100,
            "firstTokenAt": 200, "completedAt": 900, "inputTokens": 100,
            "outputTokens": 50, "cacheReadTokens": 60, "cacheWriteTokens": 5,
            "subagentType": None, "task": None, "childSessionId": None,
        })
        self.assertEqual(r["inputTokens"] - r["cacheReadTokens"] - r["cacheWriteTokens"], 35)

    def test_model_contract_row_thinking_flag(self):
        r = zusage._model_contract_row({"id": 1, "reasoning_tokens": None})
        self.assertFalse(r["thinking"])   # 非法值防御：NULL 按 0 处理
        r = zusage._model_contract_row({"id": 1, "reasoning_tokens": 3})
        self.assertTrue(r["thinking"])

    def test_model_contract_row_missing_columns(self):
        # 缺列防御（sqlite3.Row 缺列场景等价模拟）：不抛异常，缺省值落位
        r = zusage._model_contract_row({"id": None})
        self.assertEqual(r["id"], "")
        self.assertEqual(r["status"], "")
        self.assertEqual(r["model"], "")
        self.assertFalse(r["thinking"])
        self.assertIsNone(r["completedAt"])

    def test_tool_contract_row_shape(self):
        r = zusage._tool_contract_row({"id": 3, "tool_name": "Bash", "status": "running",
                                       "started_at": 10, "completed_at": None})
        self.assertEqual(r["kind"], "tool")
        self.assertEqual(r["model"], "Bash")
        self.assertEqual(r["status"], "running")
        self.assertIsNone(r["completedAt"])
        self.assertEqual(r["outputTokens"], 0)
        self.assertFalse(r["isSubagent"])


class UsageStatsModuleTests(unittest.TestCase):
    """usage_stats.py（移植库）对照：同口径独立实现的边界与聚合。"""

    def test_request_stats_window_boundaries(self):
        row = {"output_tokens": 200, "reasoning_tokens": 0, "completed_at": 1199,
               "started_at": 1000, "first_token_at": 1000, "model_id": "glm-5",
               "provider_id": "p", "time_to_first_token_ms": 0}
        self.assertEqual(usage_stats.request_stats(row)["rateUnavailableReason"],
                         "generationWindowOutOfRange")
        row["completed_at"] = 1200   # 恰 200ms：有效
        self.assertEqual(usage_stats.request_stats(row)["tokPerSec"], 1000.0)
        row["completed_at"] = 1000 + 3_600_000   # 恰 1h：无效
        self.assertEqual(usage_stats.request_stats(row)["rateUnavailableReason"],
                         "generationWindowOutOfRange")

    def test_request_stats_thinking_window(self):
        row = {"output_tokens": 300, "reasoning_tokens": 10, "completed_at": 4000,
               "started_at": 1000, "first_token_at": 3000, "model_id": "glm-5",
               "provider_id": "p", "time_to_first_token_ms": 2000}
        self.assertEqual(usage_stats.request_stats(row)["genMs"], 3000)
        row["provider_id"] = "covered"   # covers：回首字窗
        self.assertEqual(usage_stats.request_stats(row, covers={"covered"})["genMs"], 1000)

    def test_request_stats_invalid_values(self):
        row = {"output_tokens": None, "reasoning_tokens": 0, "completed_at": float("nan"),
               "started_at": 0, "first_token_at": 0, "model_id": "glm-5",
               "time_to_first_token_ms": -5}
        r = usage_stats.request_stats(row)
        self.assertEqual(r["rateUnavailableReason"], "missingGenerationWindow")
        self.assertIsNone(r["ttftMs"])   # 负 TTFT 非法

    def test_aggregate_requests_weighted(self):
        items = [{"outputTokens": 200, "reasoningTokens": 0, "tokPerSec": 200.0, "genMs": 1000},
                 {"outputTokens": 300, "reasoningTokens": 5, "tokPerSec": None, "genMs": None}]
        agg = usage_stats.aggregate_requests(items)
        self.assertEqual(agg["rated"], 1)
        self.assertEqual(agg["unrated"], 1)
        self.assertEqual(agg["ratedOutput"], 200)
        self.assertEqual(agg["unratedOutput"], 300)
        self.assertEqual(agg["tokPerSec"], 200.0)
        self.assertEqual(agg["totalOutput"], 500)
        self.assertIsNone(usage_stats.aggregate_requests([])["tokPerSec"])

    def test_hides_reasoning_and_round1(self):
        self.assertTrue(usage_stats.hides_reasoning("Claude-Opus"))
        self.assertFalse(usage_stats.hides_reasoning("glm-5"))
        self.assertFalse(usage_stats.hides_reasoning(None))
        self.assertEqual(usage_stats.round1(12.04), 12.0)
        self.assertEqual(usage_stats.round1(12.06), 12.1)
        self.assertIsInstance(usage_stats.round1(12.0), int)

    def test_zusage_constants_match_usage_stats(self):
        # 口径单一来源：zusage 的窗口常量必须与 usage_stats 一致（软导入兜底同值）
        self.assertEqual(zusage._TPS_MIN_GEN_MS, usage_stats.MIN_GEN_MS)
        self.assertEqual(zusage._TPS_MAX_GEN_MS, usage_stats.MAX_GEN_MS)


if __name__ == "__main__":
    unittest.main()
