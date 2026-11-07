# -*- coding: utf-8 -*-
"""usage_stats.py —— 用量口径纯函数库（CLI 与快照共用；不触数据库、不依赖宿主状态）。

职责（design §9 白名单文件，自源仓库 zcode-token-usage-statusbar/usage_stats.py 移植）：
  * 请求级口径计算：有效生成窗口（200ms ≤ 窗 < 1h）、思考/Claude 的 started_at 窗、
    首字窗退化、TTFT 合法性、加权均速度（Σ有效输出 ÷ Σ有效生成窗口）；
  * 本模块为纯函数库：零 I/O、零网络、零凭据（R10 数据边界），可独立单测。

移植说明：
  * 语义与源仓库逐行等价（request_stats / aggregate_requests / hides_reasoning /
    round1 / MIN_GEN_MS / MAX_GEN_MS），仅注释与 docstring 改为中文；
  * 源仓库本就无费用/价格引用，无需裁剪；zusage.py 复用本模块的常量与
    hides_reasoning（口径单一来源），request_stats/aggregate_requests 供
    CLI/诊断/测试复用；状态条 JS 侧同口径实现在 statusbar/session-stats.cjs。
"""
import math

# 有效生成窗口边界（ms）：下限滤掉瞬时元请求/探测请求；上限滤掉挂起的僵尸行
MIN_GEN_MS = 200
MAX_GEN_MS = 3_600_000


def hides_reasoning(model_id):
    """Claude 系列不单独上报思考 token（reasoning_tokens 恒 0、思考在首字前流出），
    其生成窗口须从 started_at 起算；其余模型按各调用方口径处理。"""
    return "claude" in (model_id or "").lower()


def round1(value):
    """保留一位小数；整数值收敛为 int（JSON 输出更紧凑，12.0 → 12）。"""
    rounded = round(value, 1)
    return int(rounded) if rounded == int(rounded) else rounded


def _number(value):
    """有限数值判定：bool 与非有限浮点（inf/nan）都视为非法。"""
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value))


def request_stats(row, covers=frozenset()):
    """单请求口径统计。输出 token 含思考。

    缺失/非法生成窗口的请求不评级（rateUnavailableReason 说明原因）。
    思考行（reasoning>0 或 Claude 系）缺省用 started_at 窗（思考在首字之前流出）；
    `covers` 里的 provider「首块即落章」，思考在首字之后随输出流出、已含在首字窗内，
    故其窗口保持 first_token_at 基准（避免把首块前的输入预处理摊进生成耗时）。
    """
    output = row["output_tokens"] or 0
    reasoning = row["reasoning_tokens"] or 0
    completed = row["completed_at"]
    thinking = reasoning > 0 or hides_reasoning(row["model_id"])
    try:
        pid = row["provider_id"]
    except (KeyError, IndexError):
        pid = None   # sqlite3.Row 等映射缺列（旧库列漂移）按无 provider 处理
    start = row["started_at"] if thinking and pid not in covers else row["first_token_at"]
    duration = completed - start if _number(completed) and _number(start) and completed > start else None
    reason = None
    if duration is None:
        reason = "missingGenerationWindow"
    elif not MIN_GEN_MS <= duration < MAX_GEN_MS:
        reason = "generationWindowOutOfRange"
    elif not _number(output) or output <= 0:
        reason = "noOutput"
    rated = reason is None
    ttft = row["time_to_first_token_ms"]
    return {
        "model": row["model_id"],
        "outputTokens": output,
        "reasoningTokens": reasoning,
        "ttftMs": ttft if _number(ttft) and ttft >= 0 else None,
        "genMs": duration,
        "tokPerSec": round1(output / duration * 1000) if rated else None,
        "completedAt": completed,
        "ratedOutput": output if rated else 0,
        "unratedOutput": 0 if rated else output,
        "rateUnavailableReason": reason,
    }


def aggregate_requests(items):
    """请求列表聚合：加权速度只用评级通过的输出/窗口，绝不把全部输出当分子。"""
    items = list(items)
    rated = [item for item in items if item["tokPerSec"] is not None]
    output = sum(item["outputTokens"] for item in items)
    rated_output = sum(item["outputTokens"] for item in rated)
    duration = sum(item["genMs"] for item in rated)
    return {
        "requests": len(items),
        "rated": len(rated),
        "unrated": len(items) - len(rated),
        "totalOutput": output,
        "totalReasoning": sum(item["reasoningTokens"] for item in items),
        "ratedOutput": rated_output,
        "unratedOutput": output - rated_output,
        "rateCoverage": rated_output / output if output > 0 else None,
        "genMs": duration,
        "tokPerSec": round1(rated_output / duration * 1000) if rated else None,
        "peak": max((item["tokPerSec"] for item in rated), default=None),
    }
