# -*- coding: utf-8 -*-
"""zusage.py —— ZCode 状态条数据层：只读 SQLite 查询 + CLI（裁剪版）。

职责（design.md §9）：
  * 只读访问 ~/.zcode/cli/db/db.sqlite（WAL 感知：mode=ro 优先，shm 不可用退普通连接，
    全程仅 SELECT，从不写库）；
  * serve / json 子命令输出机器可读 JSON 快照，供内核泵（core/inject-main.cjs 常驻
    stdin 行协议、一次性 spawn 回退）与「复制诊断」使用；
  * 人类 CLI 子命令：now / today / days N / sessions N / models N / workspace 关键词 /
    session id前缀 / watch 秒。

serve/json 协议：
  * serve：stdin 每行一个请求（空行 = 无指定会话），stdout 每行一个 JSON 快照；
    stdin EOF 即退出（管道断开自清理）。连接跨请求复用，库文件被替换/探活失败/空闲
    超时即重建；
  * 请求行：JSON {"sids": ["session_x", ...]}（新协议；未知字段——如已裁剪的 scopes——
    忽略）或旧逗号分隔 sid 串（兼容旧 "sids|routes" 协议的左半段）；
  * 响应行结构见 snapshot() docstring。

JSON 快照结构（相对原插件 zcode-token-usage-statusbar 的删除清单，决策 7 零联网零凭据）：
  * cost_usd / rates / c：token 价格表、模型牌价与逐段预估费用（token_pricing.py 整链）；
  * fx：USD→CNY 汇率视图；
  * scnet_estimate（及 SCNET_CREDIT_RATES / quota-secrets.json / scnet_official.json）：
    SCNet 套餐额度；
  * provider_fallback：套餐档（account:*）回退字段；
  * remote_today / remote_error / remote_errors / remote_targets / remote_enabled /
    workspace_identity：远端会话路由整链（ssh/wsl/docker 子进程、客户端 setting.json
    凭据条目读取）；
  * project：项目累计（PRD Out of Scope：新状态条不渲染项目累计）；
  * recent 轻量会话行（_light_snapshot）：recent 键语义变更，见下。
  * 键语义变更（偏差登记）：原插件 recent = 最近会话快照列表（overlay 按窗口匹配会话）；
    本版 recent = statusbar/CONTRACT.md §4.3 请求行投影数组（kind/model/thinking/
    isSubagent/status/startedAt/firstTokenAt/completedAt/inputTokens/outputTokens/
    cacheReadTokens/cacheWriteTokens），由内核 inject-main.cjs 原样喂给
    statusbar/session-stats.cjs 的 aggregate() 聚合。会话级快照仅保留顶层 session 键
    （最新活跃会话，供诊断与上下文兜底）。
  * 投影范围（R10 宁可少算不可串数）：仅请求指定的会话；主会话只投影 main_turn/无标记
    的 model 行与全部工具行，子代理只投影 model 行（query_source='subagent' 或
    sess_subagent_* 会话，isSubagent=true）；辅助 query_source（如 session_title）与
    子代理工具行不投影；无指定会话时 recent 为空数组（不推其它会话的数据）。
  * 双实现口径分流（已知并接受，检查代理核对点）：完成态速度以 session-stats.cjs
    （状态条 UI 唯一权威）为准，其对缺 first_token_at 的行按 CONTRACT §4.3 回退
    started_at 窗；本文件 avg_tps/speed_segs 为诊断口径，沿用原插件严格规则
    （first_token_at 缺失即无有效窗，该行不评级）。故两侧数值仅在「缺首字时间的行」
    上不同：UI/诊断并存时以 UI 为准。token 总量（input+output，缓存已含 input 不重复
    相加）与缓存命中率（Σcache_read ÷ Σinput）两实现已对照一致。
"""
import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

try:
    import usage_stats as _ustats   # 同目录口径库（runtime_lock 白名单随 zusage.py 一同同步）
except ImportError:   # 单文件独立运行（手工拷贝部署等）：下方按同值内联兜底，口径不变
    _ustats = None

DB_PATH = Path.home() / ".zcode" / "cli" / "db" / "db.sqlite"
CONFIG_PATH = Path(__file__).parent / "config.json"


def load_config():
    """config.json（脚本目录）：context_window 兜底值与 poll_ms 等杂项；解析失败用缺省。"""
    cfg = {"context_window": 128000, "poll_ms": 2000}
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except Exception:
            pass
    return cfg


def connect():
    """只读连接优先；WAL shm 不可用时退回普通连接（全程只 SELECT）。
    fallback 前先确认文件存在：sqlite3.connect 对不存在的路径会新建空库，
    可能与尚未初始化数据库的 ZCode 产生交互（v32 审查修复）。"""
    try:
        con = sqlite3.connect(f"file:{DB_PATH.as_posix()}?mode=ro", uri=True, timeout=3)
        con.execute("select 1 from model_usage limit 1").fetchone()
    except sqlite3.OperationalError:
        if not DB_PATH.exists():
            raise
        con = sqlite3.connect(str(DB_PATH), timeout=3)
    con.row_factory = sqlite3.Row
    return con


def _ts(ms):
    return datetime.fromtimestamp(ms / 1000) if ms else None


def _day_start(d=None):
    d = d or datetime.now()
    return d.replace(hour=0, minute=0, second=0, microsecond=0)


def _epoch_ms(dt):
    return int(dt.timestamp() * 1000)


def _load_lang():
    """CLI/MCP 输出语言：config.json 的 "lang"（zh/en，缺省 zh）——与安装器同源。
    查找顺序：脚本目录（--dev/仓库直跑）→ 标准运行目录（标准安装的 config 不在脚本目录）。"""
    for base in (CONFIG_PATH,
                 Path.home() / ".zcode" / "zcode-statusbar" / "config.json"):
        try:
            lang = json.loads(base.read_text(encoding="utf-8")).get("lang")
            if lang in ("zh", "en"):
                return lang
        except (OSError, ValueError):
            pass
    return "zh"


_LANG = _load_lang()


def L(zh, en):
    """双语输出（与 install.py 的 L 同款约定）。"""
    return en if _LANG == "en" else zh


def fmt(n):
    n = n or 0
    if n >= 1_000_000_000:
        return f"{n / 1e9:.2f}B"
    if n >= 1_000_000:
        return f"{n / 1e6:.2f}M"
    if n >= 1_000:
        return f"{n / 1e3:.1f}K"
    return str(n)


SESSION_TIMEOUT_MS = 30 * 60 * 1000  # 最近30分钟有请求视为活跃会话
# 有效生成窗口边界（ms）：口径单一来源 = usage_stats（同值内联兜底，见顶部 import）
_TPS_MIN_GEN_MS = _ustats.MIN_GEN_MS if _ustats is not None else 200
_TPS_MAX_GEN_MS = _ustats.MAX_GEN_MS if _ustats is not None else 3_600_000
_TPS_LOOKBACK = 20             # first_token_at 缺失时向前找有效请求的扫描条数上限
_SPEED_SEGS_MAX = 10           # 速度柱状图分段上限（v240 用户规格：17→10）
_ROWS_CAP = 8000               # recent 请求行投影单库查询/总量的行数上限（JSON 体量护栏）

_AGG_TTL_MS = 2000   # 聚合短缓存：今日合计/会话池是慢变量，2s 陈旧无感；泵 1.5s 拉一次省约一半全表聚合
_AGG_CACHE = {}


def _cached_agg(key, fn):
    now = int(time.time() * 1000)
    hit = _AGG_CACHE.get(key)
    if hit and now - hit[0] < _AGG_TTL_MS:
        return hit[1]
    val = fn()
    if len(_AGG_CACHE) > 8:
        _AGG_CACHE.clear()   # 键固定只有几个，正常到不了；保险防膨胀
    _AGG_CACHE[key] = (now, val)
    return val


def _scan_session_ids(con):
    """全库 session_id → max(completed_at) 一次分组扫描（731MB 库 ~55ms）。
    最新会话与 recent 池原先各自独立做同样的全表 group by（3 次 118ms），
    合并为一次扫描并挂 2s TTL。"""
    def run():
        # coalesce：崩溃残留的未完成行 completed_at 为 NULL，全会话皆 NULL 时
        # max() 返回 NULL，下游 max()/sorted() 比较会 TypeError 击穿整帧快照。
        return con.execute(
            """select session_id, max(coalesce(completed_at, 0)) as m
               from model_usage group by session_id""").fetchall()
    return _cached_agg("scan", run)


def session_usage(con, sid):
    # last_request_input 取最近一次 completed 请求的 input_tokens（= 当前上下文容量）。
    # 不能用 max(input_tokens)：会话压缩后 input 骤降，峰值永远不回落（v28 修复）。
    r = con.execute(
        """select count(*), coalesce(sum(input_tokens),0), coalesce(sum(output_tokens),0),
                  coalesce(sum(reasoning_tokens),0), coalesce(sum(cache_read_input_tokens),0),
                  coalesce(sum(cache_creation_input_tokens),0), coalesce(sum(computed_total_tokens),0),
                  coalesce(sum(tool_call_count),0),
                  (select m2.input_tokens from model_usage m2
                    where m2.session_id = m.session_id and m2.status = 'completed'
                    order by m2.completed_at desc, m2.id desc limit 1),
                  count(distinct turn_id), coalesce(sum(retry_count),0)
           from model_usage m where m.session_id=? and status='completed'""",
        (sid,),
    ).fetchone()
    return {
        "requests": r[0], "input": r[1], "output": r[2], "reasoning": r[3],
        "cache_read": r[4], "cache_write": r[5], "total": r[6], "tool_calls": r[7],
        "last_request_input": r[8] or 0, "turns": r[9], "retries": r[10],
    }


def range_usage(con, start_ms, end_ms):
    # 末尾三列（reasoning/retry/cache_write）是 v30/v31 追加，CLI 老代码按索引 0-4 取值不受影响
    return con.execute(
        """select count(*), coalesce(sum(input_tokens),0), coalesce(sum(output_tokens),0),
                  coalesce(sum(cache_read_input_tokens),0), coalesce(sum(computed_total_tokens),0),
                  coalesce(sum(duration_ms),0), coalesce(sum(reasoning_tokens),0),
                  coalesce(sum(retry_count),0), coalesce(sum(cache_creation_input_tokens),0)
           from model_usage where status='completed' and completed_at between ? and ?""",
        (start_ms, end_ms),
    ).fetchone()


def _today_usage(con, start_ms, end_ms):
    return con.execute(
        """select count(*), coalesce(sum(input_tokens),0), coalesce(sum(output_tokens),0),
                  coalesce(sum(cache_read_input_tokens),0), coalesce(sum(computed_total_tokens),0),
                  coalesce(sum(duration_ms),0), coalesce(sum(reasoning_tokens),0),
                  coalesce(sum(retry_count),0), coalesce(sum(cache_creation_input_tokens),0),
                  min(started_at), max(completed_at)
           from model_usage where status='completed' and completed_at between ? and ?""",
        (start_ms, end_ms),
    ).fetchone()


def daily_usage(con, days):
    """近 N 天（含今天），按本地日聚合。返回 [(date, row), ...] 旧→新。"""
    out = []
    for i in range(days - 1, -1, -1):
        d0 = _day_start(datetime.now() - timedelta(days=i))
        r = range_usage(con, _epoch_ms(d0), _epoch_ms(d0 + timedelta(days=1)))
        out.append((d0.strftime("%m-%d %a"), r))
    return out


def recent_sessions(con, limit=10):
    return con.execute(
        """select s.id, coalesce(s.title,'(无标题)'), coalesce(s.directory,''),
                  count(m.id), coalesce(sum(m.input_tokens),0), coalesce(sum(m.output_tokens),0),
                  coalesce(sum(m.computed_total_tokens),0), max(m.completed_at)
           from model_usage m left join session s on s.id = m.session_id
           where m.status='completed'
           group by m.session_id order by max(m.completed_at) desc limit ?""",
        (limit,),
    ).fetchall()


def model_usage(con, days=7):
    since = _epoch_ms(datetime.now() - timedelta(days=days))
    return con.execute(
        """select provider_id, model_id, count(*), coalesce(sum(input_tokens),0),
                  coalesce(sum(output_tokens),0), coalesce(sum(computed_total_tokens),0)
           from model_usage where status='completed' and completed_at >= ?
           group by provider_id, model_id order by sum(computed_total_tokens) desc""",
        (since,),
    ).fetchall()


# ---------- 展示 ----------

def render_current(con):
    """当前会话 = _scan_session_ids 最近活跃的会话（子代理会话也在候选内）。"""
    rows = _scan_session_ids(con)
    sess, last_at = None, 0
    if rows:
        sid, last_at = max(rows, key=lambda r: r[1])
        sess = con.execute("select * from session where id=?", (sid,)).fetchone()
    lines = []
    if sess is not None:
        u = session_usage(con, sess["id"])
        active = last_at and (int(time.time() * 1000) - last_at) < SESSION_TIMEOUT_MS
        mark = L("🟢 活跃", "🟢 active") if active else L("⚪ 闲置", "⚪ idle")
        lines.append(L(f"■ 当前会话 [{mark}]  ", f"■ Current session [{mark}]  ") + (sess["title"] or ""))
        if sess["directory"]:
            lines.append(L(f"  目录: {sess['directory']}", f"  dir: {sess['directory']}"))
        lines.append(
            L(f"  {u['turns']} 轮 / {u['requests']} 次请求 / {u['tool_calls']} 次工具调用",
              f"  {u['turns']} turns / {u['requests']} requests / {u['tool_calls']} tool calls")
        )
        lines.append(
            L(f"  input {fmt(u['input'])} (其中 cache read {fmt(u['cache_read'])})  "
              f"output {fmt(u['output'])}  合计 {fmt(u['total'])}",
              f"  input {fmt(u['input'])} (incl. cache read {fmt(u['cache_read'])})  "
              f"output {fmt(u['output'])}  total {fmt(u['total'])}")
        )
        lines.append(L(f"  上下文容量 ≈ {fmt(u['last_request_input'])} tokens (最近一次请求输入)",
                       f"  context capacity ≈ {fmt(u['last_request_input'])} tokens (latest request input)"))
        if last_at:
            la = _ts(last_at)
            lines.append(L(f"  最后活动: {la:%H:%M:%S}",
                           f"  last activity: {la:%H:%M:%S}"))
        lines.append("")
    today = range_usage(con, _epoch_ms(_day_start()), _epoch_ms(_day_start() + timedelta(days=1)))
    lines.append(L(f"■ 今日 ({datetime.now():%Y-%m-%d %a})", f"■ Today ({datetime.now():%Y-%m-%d %a})"))
    lines.append(
        L(f"  {today[0]} 次请求  input {fmt(today[1])} (cache read {fmt(today[3])})  "
          f"output {fmt(today[2])}  合计 {fmt(today[4])}",
          f"  {today[0]} requests  input {fmt(today[1])} (cache read {fmt(today[3])})  "
          f"output {fmt(today[2])}  total {fmt(today[4])}")
    )
    return "\n".join(lines)


def render_days(con, days):
    lines = [L(f"■ 近 {days} 天每日用量 (合计=input+output)", f"■ Last {days} days (total=input+output)")]
    for label, r in daily_usage(con, days):
        bar = "█" * max(0, min(30, int(r[4] / 200_000)))
        lines.append(
            L(f"  {label}  {r[0]:>4} 次  in {fmt(r[1]):>8}  out {fmt(r[2]):>7}  合计 {fmt(r[4]):>8}  {bar}",
              f"  {label}  {r[0]:>4} req  in {fmt(r[1]):>8}  out {fmt(r[2]):>7}  total {fmt(r[4]):>8}  {bar}")
        )
    return "\n".join(lines)


def render_sessions(con, limit=10):
    lines = [L(f"■ 最近 {limit} 个会话", f"■ Last {limit} sessions")]
    for sid, title, d, n, inp, outp, total, last in recent_sessions(con, limit):
        t = _ts(last)
        if _LANG == "en" and title == "(无标题)":
            title = "(untitled)"
        dname = d.replace("\\", "/").rsplit("/", 1)[-1] if d else "?"
        lines.append(
            L(f"  {t:%m-%d %H:%M}  {fmt(total):>8}  ({fmt(inp)} in / {fmt(outp)} out, {n} 请求)  ",
              f"  {t:%m-%d %H:%M}  {fmt(total):>8}  ({fmt(inp)} in / {fmt(outp)} out, {n} requests)  ")
            + f"[{dname}]  {title[:32]}  [{sid[:13]}]"
        )
    return "\n".join(lines)


def render_models(con, days=7):
    lines = [L(f"■ 近 {days} 天按模型", f"■ Last {days} days by model")]
    for prov, model, n, inp, outp, total in model_usage(con, days):
        lines.append(
            L(f"  {model:<22} {n:>5} 次  in {fmt(inp):>8}  out {fmt(outp):>7}  合计 {fmt(total):>8}  ({prov})",
              f"  {model:<22} {n:>5} req  in {fmt(inp):>8}  out {fmt(outp):>7}  total {fmt(total):>8}  ({prov})")
        )
    return "\n".join(lines)


# ---------- 工作区报表 ----------
# 口径：主会话 = directory 命中且无父且非 sess_subagent 前缀；子代理按 parent_id 归并去重。
# 子代理会话（sess_subagent_*）的 directory 字段也等于工作区目录，直接按 directory 聚合会把
# 主/子重复计数，必须走 parent_id 归并。报表单连接一次算齐——库实时写入，分次查询之间对不上账。
# 会话迁移过工作区时历史用量全部记在当前目录名下（model_usage 无工作区维度）。

_SUB_PREFIX_LEN = 13   # len("sess_subagent")


def _usage_rows(con, sids):
    """一批会话的 completed 用量（口径与 session_usage 一致），返回 session_id → row。"""
    qm = ",".join("?" * len(sids))
    per = {}
    for r in con.execute(
        f"""select session_id, count(*) n,
                   coalesce(sum(input_tokens),0) inp, coalesce(sum(output_tokens),0) outp,
                   coalesce(sum(reasoning_tokens),0) reas,
                   coalesce(sum(cache_read_input_tokens),0) crd,
                   coalesce(sum(computed_total_tokens),0) tot,
                   min(completed_at) first_at, max(completed_at) last_at
            from model_usage where status='completed' and session_id in ({qm})
            group by session_id""", sids):
        per[r["session_id"]] = r
    return per


def _match_workspaces(con, pattern):
    """工作区目录匹配：子串（SQLite LIKE 对 ASCII 大小写不敏感）或单词首字母缩写
    （abc → **A**pple **B**anana **C**herry）。用户对工作区的称呼常是缩写而非子串。
    返回 [(directory, 会话数)]，按会话数降序。"""
    pat = pattern.lower()
    out = []
    for d, n in con.execute(
            "select directory, count(*) n from session group by directory order by n desc"):
        if pat in d.lower():
            out.append((d, n))
            continue
        initials = "".join(w[0] for w in re.split(r"[^A-Za-z0-9]+", d) if w).lower()
        if len(pat) >= 2 and pat in initials:
            out.append((d, n))
    return out


def render_workspace(con, pattern, top=15):
    """workspace:<目录关键词>：按工作区聚合主会话+子代理，含按会话与按模型两张明细。"""
    pattern = (pattern or "").strip()
    dirs = _match_workspaces(con, pattern) if pattern else []
    if not dirs:
        lines = [L(f"未找到目录含 {pattern!r} 的工作区。现有工作区（按会话数前 10）：",
                   f"No workspace with directory matching {pattern!r}. Existing workspaces (top 10 by sessions):")]
        for d, n in con.execute(
                "select directory, count(*) n from session group by directory order by n desc limit 10"):
            lines.append(f"  {n:>4}  {d}")
        return "\n".join(lines)

    dir_names = [d for d, _ in dirs]
    qd = ",".join("?" * len(dir_names))
    mains = con.execute(
        f"""select id, title, time_created from session
           where directory in ({qd}) and parent_id is null and substr(id,1,{_SUB_PREFIX_LEN})!='sess_subagent'
           order by time_created""", dir_names).fetchall()
    main_ids = [r["id"] for r in mains]
    subs = []
    if main_ids:
        qm = ",".join("?" * len(main_ids))
        subs = con.execute(
            f"select id, title, parent_id from session where parent_id in ({qm})", main_ids).fetchall()
    all_ids = list(dict.fromkeys(main_ids + [r["id"] for r in subs]))
    per = _usage_rows(con, all_ids) if all_ids else {}
    qm = ",".join("?" * len(all_ids))
    models = con.execute(
        f"""select model_id, count(*) n,
                   coalesce(sum(input_tokens),0) inp, coalesce(sum(output_tokens),0) outp,
                   coalesce(sum(computed_total_tokens),0) tot
            from model_usage where status='completed' and session_id in ({qm})
            group by model_id order by tot desc""", all_ids).fetchall() if all_ids else []

    def agg(ids):
        rows = [per[i] for i in ids if i in per]
        return {k: sum(r[k] for r in rows)
                for k in ("n", "inp", "outp", "reas", "crd", "tot")}

    sub_of = {}
    for s in subs:
        sub_of.setdefault(s["parent_id"], []).append(s["id"])
    sub_ids = [i for ids in sub_of.values() for i in ids]
    tm, ts, ta = agg(main_ids), agg(sub_ids), agg(all_ids)

    if len(dirs) == 1:
        lines = [L(f"■ 工作区 {dirs[0][0]}", f"■ Workspace {dirs[0][0]}")]
    else:
        lines = [L(f"■ 工作区（匹配 {pattern!r}，命中 {len(dirs)} 个）",
                   f"■ Workspaces matching {pattern!r} ({len(dirs)} dirs)")]
        for d, n in dirs[:5]:
            lines.append(f"  {n:>4}  {d}")
    if not per:
        lines.append(L("该工作区暂无 completed 请求。", "No completed requests in this workspace yet."))
        return "\n".join(lines)
    firsts = [r["first_at"] for r in per.values() if r["first_at"]]
    lasts = [r["last_at"] for r in per.values() if r["last_at"]]
    lines.append(L(
        f"主会话 {len(main_ids)} 个（其中无请求 {len(main_ids) - len([i for i in main_ids if i in per])} 个）"
        f" + 子代理 {len(subs)} 个 ｜ "
        f"{_ts(min(firsts)):%m-%d %H:%M} ~ {_ts(max(lasts)):%m-%d %H:%M}",
        f"{len(main_ids)} main sessions ({len(main_ids) - len([i for i in main_ids if i in per])} without requests)"
        f" + {len(subs)} subagents ｜ {_ts(min(firsts)):%m-%d %H:%M} ~ {_ts(max(lasts)):%m-%d %H:%M}"))
    lines.append(L(
        f"请求 {ta['n']:,}（主 {tm['n']:,} / 子 {ts['n']:,}）  "
        f"input {ta['inp']:,}（缓存读 {ta['crd']:,}）  "
        f"output {ta['outp']:,}（含 reasoning {ta['reas']:,}）",
        f"{ta['n']:,} requests (main {tm['n']:,} / sub {ts['n']:,})  "
        f"input {ta['inp']:,} (cache-read {ta['crd']:,})  "
        f"output {ta['outp']:,} (incl. reasoning {ta['reas']:,})"))
    lines.append(L(
        f"合计（=input+output，缓存读已含在 input 内） {ta['tot']:,}",
        f"Total (=input+output; cache-read already inside input) {ta['tot']:,}"))

    ranked = []
    for m in mains:
        if m["id"] in per:
            su = agg(sub_of.get(m["id"], []))
            ranked.append((m, per[m["id"]], su))
    ranked.sort(key=lambda x: -(x[1]["tot"] + x[2]["tot"]))
    lines.append(L(f"■ 按会话（含其子代理，按含子合计降序，前 {top}）",
                   f"■ By session (incl. subagents, top {top} by combined total)"))
    for m, u, su in ranked[:top]:
        nsub = len(sub_of.get(m["id"], []))
        subtxt = (L(f" +子{nsub}个 {su['tot']:,}", f" +{nsub} sub {su['tot']:,}") if nsub else "")
        t = (m["title"] or L("(无标题)", "(untitled)")).replace("\n", " ")
        lines.append(
            f"  {_ts(u['last_at']):%m-%d %H:%M}  {u['n']:,}req  in {u['inp']:,}  out {u['outp']:,}  "
            f"{L('合计', 'total')} {u['tot']:,}{subtxt}  {t[:26]}")
    if len(ranked) > top:
        rest = agg([m["id"] for m, _, _ in ranked[top:]])
        lines.append(L(f"  （另有 {len(ranked) - top} 个会话 合计 {rest['tot']:,}）",
                       f"  (…plus {len(ranked) - top} sessions totalling {rest['tot']:,})"))

    lines.append(L("■ 按模型", "■ By model"))
    for r in models:
        lines.append(
            f"  {r['model_id']:<24} {r['n']:,}req  in {r['inp']:,}  out {r['outp']:,}  "
            f"{L('合计', 'total')} {r['tot']:,}")
    return "\n".join(lines)


# ---------- 机器可读快照（状态条数据源） ----------

# 客户端自带模型目录（Windows 安装布局；其余平台/自定义安装不存在时按 None 降级，
# 上下文窗口走 config.json 的 context_window 兜底——本地静态文件，无网络请求）。
CATALOG_PATH = Path(r"D:\ZCode\resources\model-providers\models_catalog_china_llm_zcode_2026-06-03.json")


_CTX_WINDOW_CACHE = {}


def lookup_context_window(model_id):
    """按模型 id 在客户端自带模型目录里查 contextWindow；查不到返回 None。带缓存。"""
    want = (model_id or "").strip().lower()
    if not want:
        return None
    if want in _CTX_WINDOW_CACHE:
        return _CTX_WINDOW_CACHE[want]
    result = None
    try:
        cat = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return None
    for p in cat.get("providers", []):
        for m in p.get("models", []):
            if str(m.get("id", "")).lower() == want:
                cw = m.get("contextWindow")
                result = int(cw) if cw else None
                break
    _CTX_WINDOW_CACHE[want] = result
    return result


def _prompt_matches(title, prompt):
    """子会话 title 是否为 Agent part prompt 的截断头（ZCode 规则：prompt 前 57 字符 + "..."）。"""
    t = (title or "").strip()
    if not t or not prompt:
        return False
    if t.endswith("..."):
        base = t[:-3]
        return len(base) >= 15 and prompt.startswith(base)
    return prompt.startswith(t)


# 任务名解析缓存（serve 常驻进程内）：like 扫描父会话全部 part 的 data（本会话可达
# 2456 行大 JSON，实测 29ms/次，泵 1.5s 拉一次全付）。失效键 = 父会话 part 的
# 行数+最新 time_updated（索引聚合，<1ms）；普通消息 part 新增也会失效，宁多算不漏算。
_TASK_CACHE = {}


def _sub_agent_tasks(con, sid):
    """父会话的子代理索引（一次 part 扫描，运行中与已结束条目共用）：
      children: 子会话 id → {task, type, call}（回执 agentId 关联，缺回执走标题前缀兜底）
      calls:    tool_call_id → {task, type}（运行中条目没有子会话，只按 callID 取名字与类型）
    失效键 = 父会话 part 行数 + 最新 time_updated（见 _TASK_CACHE 注释）。"""
    stamp = con.execute(
        "select count(*), coalesce(max(time_updated),0) from part where session_id=?", (sid,)
    ).fetchone()
    key = (stamp[0], stamp[1])
    hit = _TASK_CACHE.get(sid)
    if hit and hit[0] == key:
        return hit[1]
    sub_rows_titles = {r[0]: r[1] for r in con.execute(
        "select id, title from session where parent_id=?", (sid,))}
    agent_parts = []
    for prow in con.execute(
        """select data, time_created from part
           where session_id=? and data like '%"tool":"Agent"%' order by time_created""",
        (sid,),
    ):
        try:
            o = json.loads(prow[0])
            st = o.get("state") or {}
            inp = st.get("input") or {}
            agent_parts.append((
                str(o.get("callID") or "").strip() or None,
                str(inp.get("description") or "").strip(),
                str(inp.get("subagent_type") or "").strip() or None,
                str(inp.get("prompt") or "").strip(),
                str(st.get("output") or ""),
            ))
        except Exception:
            continue   # part.data 解析失败跳过该条，不影响其余
    children, calls = {}, {}
    for call, desc, stype, _prompt, out in agent_parts:
        if call:
            calls[call] = {"task": desc or None, "type": stype}
        m = re.search(r"(?:^|\n)agentId:\s*([^\s(]+)", out)
        if m and desc:
            children["sess_subagent_" + m.group(1)] = {"task": desc, "type": stype, "call": call}
    used = set(children)
    for call, desc, stype, prompt, out in agent_parts:
        if not desc or re.search(r"(?:^|\n)agentId:\s*([^\s(]+)", out):
            continue   # 已走回执关联，或无名可绑
        cands = [s for s, t in sub_rows_titles.items()
                 if s not in used and _prompt_matches(t, prompt)]
        if len(cands) == 1:
            children[cands[0]] = {"task": desc, "type": stype, "call": call}
            used.add(cands[0])
    idx = {"children": children, "calls": calls}
    if len(_TASK_CACHE) > 32:   # 防长驻膨胀：会话数有限，正常到不了；超了整表清掉
        _TASK_CACHE.clear()
    _TASK_CACHE[sid] = (key, idx)
    return idx


def _agent_tool_rows(con, sid):
    """本会话的 Agent 工具行（运行中 + 已结束），最近在前。
    缺 tool_call_id 列的旧库/瘦身库返回空列表：没有 join 键就静默降级为空，不猜。"""
    if not _has_column(con, "tool_usage", "tool_call_id"):
        return []
    return con.execute(
        """select t.tool_call_id, t.status, t.started_at, t.completed_at
           from tool_usage t where t.session_id=? and t.tool_name='Agent'
           order by coalesce(t.completed_at, t.started_at) desc""",
        (sid,),
    ).fetchall()


def _sub_item(row, meta, sub_gen, status, now_ms):
    """sub.list 单项：一种形状承载运行中/已结束两态，由 status 判别。
    row = 聚合字段（运行中条目全零）；meta = part 索引的 task/type（可缺）；
    status 按设计 §4.2：Agent 工具行状态优先，无工具行时按 model 行推断（调用方给 completed）。"""
    meta = meta or {}
    sid = row["sid"]
    started = row["started"] or None
    ended = None if status == "running" else (row["last"] or None)
    if status == "running":
        duration = now_ms - started if started else None
    else:
        duration = ended - started if started and ended and ended >= started else None
    return {
        "sid": sid, "agent": row["agent"], "title": row["title"],
        "task": meta.get("task") or "", "type": meta.get("type"),
        "status": status,
        "toolCallId": meta.get("call"),
        "childSessionId": sid or None,
        "started": started or 0, "endedAt": ended, "durationMs": duration,
        "requests": row["requests"], "total": row["total"],
        "input": row["input"], "output": row["output"], "cache_read": row["cache_read"],
        "reasoning": row["reasoning"], "cache_write": row["cache_write"],
        "last": row["last"] or 0,
        "tps_avg": _rated_tps(*sub_gen.get(sid, [0, 0])),
        "active": status == "running" or bool(
            row["last"] and now_ms - row["last"] < 30000),
    }


# Agent 工具行可表达的子代理状态（未登记的状态一律不产条目，宁可少算）
_SUBAGENT_STATUSES = ("running", "completed", "error", "cancelled")


def _sub_list(sub_rows, sub_index, sub_gen, agent_tools, now_ms):
    """sub.list：已结束（子会话 model 聚合）+ 运行中/已结束（Agent 工具行）合并为一种形状。
    子会话与工具行经 part 的 callID ←→ agentId 回执关联；关联不上的各出一行（宁可两行，
    不把一个子代理的数据混作另一个）。排序：运行中按派发先后，已结束按最近活动倒序。"""
    children = (sub_index or {}).get("children") or {}
    calls_meta = (sub_index or {}).get("calls") or {}
    by_call = {_col(t, "tool_call_id"): t for t in agent_tools or [] if _col(t, "tool_call_id")}
    child_of = {m.get("call"): c for c, m in children.items() if m.get("call")}
    items, seen = [], set()
    for r in sub_rows:
        child = r[0]
        meta = children.get(child) or {}
        tool = by_call.get(meta.get("call")) if meta.get("call") else None
        status = _col(tool, "status") if tool is not None else None
        if status not in _SUBAGENT_STATUSES:
            status = "completed"   # 查询只取 completed 的 model 行，无工具行即按已完成兜底
        tool_completed = _col(tool, "completed_at") if tool is not None else None
        tool_started = _col(tool, "started_at") if tool is not None else None
        items.append(_sub_item({
            "sid": child, "agent": r[1], "title": r[2],
            "requests": r[3], "total": r[4], "input": r[5], "output": r[6],
            "cache_read": r[7], "reasoning": r[8], "cache_write": r[9],
            "last": r[10] or tool_completed,
            "started": r[12] or tool_started,
        }, meta, sub_gen, status, now_ms))
        seen.add(child)
        if meta.get("call"):
            seen.add("call:" + meta["call"])
    for t in agent_tools or []:
        call, status = _col(t, "tool_call_id"), _col(t, "status")
        if not call or status not in _SUBAGENT_STATUSES:
            continue
        child = child_of.get(call) or ""
        if child in seen or ("call:" + call) in seen:
            continue   # 已有 model 行聚合条目或已产过本行
        started, ended = _col(t, "started_at"), _col(t, "completed_at")
        meta = dict(calls_meta.get(call) or {}, call=call)
        items.append(_sub_item({
            "sid": child, "agent": "", "title": "",
            "requests": 0, "total": 0, "input": 0, "output": 0,
            "cache_read": 0, "reasoning": 0, "cache_write": 0,
            "last": ended, "started": started,
        }, meta, sub_gen, status, now_ms))
        seen.add(child or ("call:" + call))
    running = sorted((i for i in items if i["status"] == "running"),
                     key=lambda i: i["started"] or 0)
    done = sorted((i for i in items if i["status"] != "running"),
                  key=lambda i: i["endedAt"] or i["last"] or 0, reverse=True)
    return running + done


def render_session_detail(con, prefix):
    """session:<id前缀>：会话总量 + 按模型 + 子代理明细（任务名与状态条"子智能体目录"同源）。"""
    prefix = (prefix or "").strip()
    if not prefix:
        return L("session 需要一个非空 id 前缀（session:<前缀>）",
                 "session requires a non-empty id prefix (session:<prefix>)")
    # 真实会话 id 形如 session_<hex>，含 LIKE 通配符 _/%；不转义会把 session_ab 前缀
    # 匹配到任意第三字符，且无 ORDER BY 时 rows[0] 可能选错会话。
    esc_prefix = prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    pattern = esc_prefix + "%"
    rows = con.execute("select id from session where id like ? escape '\\'", (pattern,)).fetchall()
    if not rows:
        rows = con.execute(
            "select distinct session_id from model_usage where session_id like ? escape '\\'",
            (pattern,)).fetchall()
    if not rows:
        return L(f"未找到 id 前缀为 {prefix!r} 的会话",
                 f"No session found with id prefix {prefix!r}")
    sid = rows[0][0]
    sess = con.execute("select * from session where id=?", (sid,)).fetchone()
    u = session_usage(con, sid)
    head = L(f"■ 会话 {sid}", f"■ Session {sid}")
    if sess is not None:
        head += f"  {sess['title']}"
        if sess["directory"]:
            head += L(f"\n  目录: {sess['directory']}", f"\n  dir: {sess['directory']}")
    body = L(
        f"  {u['turns']} 轮 / {u['requests']} 次请求\n"
        f"  input {fmt(u['input'])} (其中 cache read {fmt(u['cache_read'])})  "
        f"output {fmt(u['output'])}  合计 {fmt(u['total'])}（合计=input+output，缓存读已含在 input 内）\n"
        f"  上下文容量 ≈ {fmt(u['last_request_input'])} tokens",
        f"  {u['turns']} turns / {u['requests']} requests\n"
        f"  input {fmt(u['input'])} (incl. cache read {fmt(u['cache_read'])})  "
        f"output {fmt(u['output'])}  total {fmt(u['total'])} (total=input+output; cache-read already inside input)\n"
        f"  context capacity ≈ {fmt(u['last_request_input'])} tokens")
    lines = [head, body]
    last = con.execute(
        "select max(completed_at) from model_usage where session_id=?", (sid,)).fetchone()[0]
    if last:
        lines.append(L(f"  最后活动: {_ts(last):%m-%d %H:%M}",
                       f"  last activity: {_ts(last):%m-%d %H:%M}"))
    mrows = con.execute(
        """select model_id, count(*) n, coalesce(sum(input_tokens),0),
                  coalesce(sum(output_tokens),0), coalesce(sum(computed_total_tokens),0)
           from model_usage where session_id=? and status='completed'
           group by model_id order by sum(computed_total_tokens) desc limit 6""",
        (sid,)).fetchall()
    if mrows:
        lines.append(L("  按模型:", "  By model:"))
        for r in mrows:
            lines.append(
                f"    {r['model_id']:<24} {r['n']:,}req  in {fmt(r[2])}  out {fmt(r[3])}  "
                f"{L('合计', 'total')} {fmt(r[4])}")
    sub_rows = con.execute(
        """select m.session_id, coalesce(s2.title,''), count(*),
                  coalesce(sum(m.computed_total_tokens),0), max(m.completed_at)
           from model_usage m join session s2 on m.session_id = s2.id
           where m.query_source='subagent' and s2.parent_id=? and m.status='completed'
           group by m.session_id order by max(m.completed_at) desc""", (sid,)).fetchall()
    if sub_rows:
        tasks = _sub_agent_tasks(con, sid)
        lines.append(L(
            f"  子代理: {len(sub_rows)} 个 / {sum(r[2] for r in sub_rows):,}req / "
            f"合计 {sum(r[3] for r in sub_rows):,}",
            f"  Subagents: {len(sub_rows)} / {sum(r[2] for r in sub_rows):,}req / "
            f"total {sum(r[3] for r in sub_rows):,}"))
        for r in sub_rows[:8]:
            name = tasks.get(r[0]) or r[1] or r[0]
            lines.append(
                f"    {fmt(r[3]):>8}  {r[2]:>3}req  {str(name).replace(chr(10), ' ')[:30]}  [{r[0][-6:]}]")
        if len(sub_rows) > 8:
            lines.append(L(f"    （另有 {len(sub_rows) - 8} 个）", f"    (…plus {len(sub_rows) - 8} more)"))
    return "\n".join(lines)


def _session_start_ms(con, sid, srow=None):
    """会话起点：首个已完成请求的 started_at；无请求（纯新建/纯问答）回退会话创建时间。
    供「会话累计」起始时间展示用。"""
    r = con.execute(
        "select min(started_at) from model_usage where session_id=? and status='completed'",
        (sid,),
    ).fetchone()
    if r and r[0]:
        return int(r[0])
    if srow is None:
        srow = con.execute("select time_created from session where id=?", (sid,)).fetchone()
    return int(srow["time_created"]) if srow and srow["time_created"] else 0


# ---------- 速度口径（纯函数，独立可单测） ----------

def hides_reasoning(model_id):
    """Claude 系列不单独上报思考 token：reasoning_tokens 恒为 0，output_tokens 却已含思考，
    且思考在 first_token_at 之前流出。按首字窗口计时会把思考期漏出分母，须同含思考段一样
    从 started_at 起算。转发口径库 usage_stats.hides_reasoning（同规则单一来源）。"""
    if _ustats is not None:
        return _ustats.hides_reasoning(model_id)
    return "claude" in (model_id or "").lower()


def _valid_gen_window(gen_ms):
    """有效生成窗口判定：200ms ≤ 窗 < 1h（含下限不含上限；滤掉瞬时元请求与挂起僵尸行）。
    独立小函数，便于单测边界。"""
    return gen_ms is not None and _TPS_MIN_GEN_MS <= gen_ms < _TPS_MAX_GEN_MS


def _row_gen_ms(r, covers=frozenset()):
    """按 usage_stats.request_stats 同款口径算一行 model_usage 的生成时长；first_token_at
    缺失或窗口非正则不可信，返回 None（该请求不参与速度计算）。
    含思考段（reasoning>0）默认 completed_at − started_at（推理在首字前流出的 provider，
    漏出分母会虚高）；provider 在 covers（首块落章，见 _provider_first_token_covers）时
    思考已在首字窗口内，改用 completed_at − first_token_at，不把首块前的输入预处理
    摊进生成耗时。Claude 系列恒用 started_at（hides_reasoning）。"""
    ft, ct, st = r["first_token_at"], r["completed_at"], r["started_at"]
    if not ft or not ct or ct <= ft:
        return None
    gen_ms = ct - ft
    if (r["reasoning_tokens"] or hides_reasoning(r["model_id"])) and st and ct > st:
        try:
            pid = r["provider_id"]
        except (KeyError, IndexError):
            pid = None
        if pid not in covers:
            gen_ms = ct - st   # 推理前置/Claude/判定缺证据：窗口前移到 started_at
    return gen_ms


def _rate_sample(row, covers=frozenset()):
    """单行有效速度样本：output>0 且窗口有效才评级；None = 不可信样本。"""
    if row and (row["output_tokens"] or 0) > 0:
        gen_ms = _row_gen_ms(row, covers)
        if _valid_gen_window(gen_ms):
            return {"tps": round(row["output_tokens"] / (gen_ms / 1000), 1),
                    "startedAt": row["started_at"] or 0, "endedAt": row["completed_at"] or 0}
    return None


def _last_valid_rate(con, sid, last, covers=frozenset()):
    """最近有效生成速度及同一请求的起止；最多回查 3 倍扫描窗（60 条），缺有效样本时隐藏。"""
    sample = _rate_sample(last, covers)
    if sample is not None:
        return sample
    rows = con.execute(
        """select output_tokens, first_token_at, completed_at, started_at, reasoning_tokens, model_id, provider_id
           from model_usage where session_id=? and status='completed'
           order by completed_at desc limit ?""",
        (sid, _TPS_LOOKBACK * 3),
    ).fetchall()
    for row in rows:
        sample = _rate_sample(row, covers)
        if sample is not None:
            return sample
    return {"tps": 0, "startedAt": 0, "endedAt": 0}


def _turn_rate(rows, covers=frozenset()):
    """加权平均口径（R2 会话均）：Σ有效输出 ÷ Σ有效生成窗口；无效段的输出进 unrated 桶
    （不进分母，也绝不丢——unrated_output 供展示层说明覆盖率）。"""
    output, unrated, duration = 0, 0, 0
    for row in rows:
        tokens = row["output_tokens"] or 0
        gen_ms = _row_gen_ms(row, covers)
        if tokens > 0 and _valid_gen_window(gen_ms):
            output += tokens
            duration += gen_ms
        else:
            unrated += tokens
    return {"tps": round(output / (duration / 1000), 1) if duration else 0,
            "rated_output": output, "unrated_output": unrated, "gen_ms": duration}


def _rated_tps(tokens, gen_ms):
    """加权平均 t/s：Σ有效 output ÷ Σ有效生成窗口；窗口为 0（无有效样本）时返回 0。"""
    return round(tokens / (gen_ms / 1000), 1) if gen_ms else 0


_COVERS_TTL_S = 60.0
_COVERS_CACHE = {"ts": 0.0, "set": frozenset()}   # 首块落章 provider 集合缓存（原地更新）


def _covers_from_rows(rows):
    """纯函数：按 provider 聚合行 (n, sx, sy, sxy, sxx, provider_id) 判定「首块落章」集合——
    对 (reasoning_tokens, time_to_first_token_ms) 做最小二乘，斜率 <2.0 ms/token
    （首字时间不随推理量增长）即首块落章；样本 <5 条或分母非正不判（宁可走保守口径）。"""
    out = set()
    for r in rows:
        n = r["n"] or 0
        sx = r["sx"] or 0
        denom = n * (r["sxx"] or 0) - sx * sx
        if n < 5 or denom <= 0:
            continue
        slope = (n * (r["sxy"] or 0) - sx * (r["sy"] or 0)) / denom
        if slope < 2.0:
            out.add(r["provider_id"])
    return out


def _provider_first_token_covers(con):
    """「首块即落章」的 provider 集合（fork z1908144712 判据收编）：这些 provider 的
    first_token_at 就是首个流式块，思考 token 在首字之后随输出流出，首字窗口已含思考；
    若一律从 started_at 起算，会把首块前的输入预处理（大上下文实测 8~10s）摊进生成
    耗时，速度系统性偏低。斜率判据见 _covers_from_rows（纯函数）。样本不足不判（不进
    集合，按既有「推理前置」口径兜底）。Claude 不受影响：reasoning 恒 0 进不了聚合。
    聚合是全表扫描（~17ms/270MB），60s TTL 缓存摊薄。测试改库后须重置 _COVERS_CACHE。"""
    now = time.monotonic()
    if now - _COVERS_CACHE["ts"] < _COVERS_TTL_S:
        return _COVERS_CACHE["set"]
    out = set()
    if con is not None:
        try:
            rows = con.execute(
                """select provider_id, count(*) n,
                          sum(reasoning_tokens) sx, sum(time_to_first_token_ms) sy,
                          sum(reasoning_tokens * time_to_first_token_ms) sxy,
                          sum(reasoning_tokens * reasoning_tokens) sxx
                   from model_usage
                   where reasoning_tokens > 0 and time_to_first_token_ms is not null
                     and provider_id is not null
                   group by provider_id""").fetchall()
            out = _covers_from_rows(rows)
        except sqlite3.Error:
            out = set()   # 旧库缺列等读不了聚合：判不出就全走既有口径
    _COVERS_CACHE.update(ts=now, set=frozenset(out))
    return _COVERS_CACHE["set"]


def _speed_segments(con, sid, covers=frozenset()):
    """当前会话最近 ≤10 轮（可跨天）已完成 main_turn 有效速度段（速度 tooltip 柱状图）。
    按轮（turn_id）聚合：一次提问的全部模型请求合并为一柱——v = 轮内有效行
    Σoutput ÷ Σ生成窗口（_row_gen_ms 窗口 + 200ms–1h 有效段过滤，辅助 query_source 与
    子代理行不计）；v 保留原始浮点不 round（柱高与档位判断用原始值，显示层才取一位小数）。
    随段携带悬停卡明细：m=轮内最大输出有效行的模型、i/o=轮内已完成行输入/输出合计、
    n=轮内已完成请求数（费用字段 c 已按决策 7 裁剪）。t 为轮内最后完成时间毫秒；
    先取最近 3×10 个轮窗口再取行，无效轮顺延补位，按轮完成时间升序返回。"""
    windows = con.execute(
        """select turn_id, max(completed_at) from model_usage
           where session_id=? and status='completed'
             and (query_source is null or query_source='main_turn')
           group by turn_id order by 2 desc, turn_id limit ?""",
        (sid, _SPEED_SEGS_MAX * 3),
    ).fetchall()
    if not windows:
        return []
    ids = [w[0] for w in windows if w[0] is not None]
    groups = {}
    if ids:
        marks = ",".join("?" * len(ids))
        for row in con.execute(
            f"""select turn_id, output_tokens, input_tokens, cache_read_input_tokens,
                       cache_creation_input_tokens, first_token_at, completed_at, started_at,
                       reasoning_tokens, model_id, provider_id
                from model_usage where session_id=? and status='completed'
                  and (query_source is null or query_source='main_turn') and turn_id in ({marks})""",
            (sid, *ids),
        ):
            groups.setdefault(row["turn_id"], []).append(row)
    if any(w[0] is None for w in windows):
        # turn_id 缺失的旧行归并为一组（SQLite group by 同样把 NULL 归为一类）
        for row in con.execute(
            """select turn_id, output_tokens, input_tokens, cache_read_input_tokens,
                      cache_creation_input_tokens, first_token_at, completed_at, started_at,
                      reasoning_tokens, model_id, provider_id
               from model_usage where session_id=? and status='completed'
                 and (query_source is null or query_source='main_turn') and turn_id is null
               order by completed_at desc, rowid desc limit 500""",
            (sid,),
        ):
            groups.setdefault(None, []).append(row)   # 防御上限 500 行（取最近）：turn_id 缺失的存量超长会话截断聚合
    out = []
    for tid, _ in windows:
        rows = groups.get(tid)
        if not rows:
            continue
        valid_out = valid_ms = 0
        best_out, best_model = -1.0, ""
        tin = tout = 0
        for row in rows:
            tokens = row["output_tokens"] or 0
            tin += row["input_tokens"] or 0
            tout += tokens
            gen_ms = _row_gen_ms(row, covers)
            if tokens > 0 and _valid_gen_window(gen_ms):
                valid_out += tokens
                valid_ms += gen_ms
                if tokens > best_out:
                    best_out, best_model = tokens, row["model_id"] or ""
        if not valid_ms:
            continue
        seg = {"v": valid_out / (valid_ms / 1000), "t": max(r["completed_at"] or 0 for r in rows)}
        if best_model:
            seg["m"] = best_model
        seg["i"], seg["o"], seg["n"] = tin, tout, len(rows)
        out.append(seg)
        if len(out) >= _SPEED_SEGS_MAX:
            break
    out.reverse()
    return out


def _session_snapshot(con, sid, cfg):
    """单个会话的完整快照（最新会话诊断用；费用/牌价字段已按决策 7 裁剪）。"""
    srow = con.execute("select * from session where id=?", (sid,)).fetchone()
    u = session_usage(con, sid)
    last = con.execute(
        """select coalesce(duration_ms,0) as duration_ms, coalesce(time_to_first_token_ms,0), completed_at, turn_id, model_id,
                  output_tokens, first_token_at, started_at, reasoning_tokens, provider_id
           from model_usage where session_id=? and status='completed'
             and (query_source is null or query_source='main_turn')
           order by completed_at desc limit 1""",
        (sid,),
    ).fetchone()
    covers = _provider_first_token_covers(con)
    # 会话平均生成速度：全会话已完成 main_turn 段的加权平均——Σ有效输出 ÷ Σ有效生成窗口
    # （_turn_rate 同款口径：_row_gen_ms 窗口 + 200ms–1h 有效段过滤，无效段不进分母；
    # 子代理与辅助 query_source 行不计）。诊断快照用；状态条主数字走
    # session-stats.cjs 的 aggregate()（同一口径的 JS 实现）。
    sess_avg = _turn_rate(con.execute(
        """select output_tokens, first_token_at, completed_at, started_at, reasoning_tokens, model_id, provider_id
           from model_usage where session_id=? and status='completed'
             and (query_source is null or query_source='main_turn')""",
        (sid,),
    ).fetchall(), covers)["tps"]
    # 本轮数据源 = turn_usage 表的每轮完整聚合（v30 起，替代从 model_usage 手工按轮求和）：
    # 自带请求/重试/工具/工具错误计数与 reasoning 拆分，一轮一行。
    lt = {"requests": 0, "retries": 0, "tool_calls": 0, "tool_errors": 0, "input": 0,
          "output": 0, "reasoning": 0, "cache_read": 0, "cache_write": 0,
          "total": 0, "duration_ms": 0, "ttft_ms": 0, "avg_duration_ms": 0, "avg_ttft_ms": 0,
          "started": 0, "ended": 0,
          "tps": 0, "rated_output": 0, "unrated_output": 0, "gen_ms": 0}
    if last and last["turn_id"]:
        t = con.execute(
            """select coalesce(model_request_count,0), coalesce(model_retry_count,0),
                      coalesce(tool_call_count,0), coalesce(tool_error_count,0),
                      coalesce(input_tokens,0), coalesce(output_tokens,0), coalesce(reasoning_tokens,0),
                      coalesce(cache_read_input_tokens,0), coalesce(cache_creation_input_tokens,0),
                      coalesce(computed_total_tokens,0),
                      coalesce(duration_ms,0), coalesce(time_to_first_token_ms,0)
               from turn_usage where session_id=? and turn_id=? and status='completed'""",
            (sid, last["turn_id"]),
        ).fetchone()
        # 本轮起止：首个请求的 started_at / 最后完成请求的 completed_at（tooltip 时间范围用）
        ts_row = con.execute(
            """select min(started_at), max(completed_at) from model_usage
               where session_id=? and turn_id=? and status='completed'""",
            (sid, last["turn_id"]),
        ).fetchone()
        turn_started = (ts_row[0] or 0) if ts_row else 0
        turn_ended = (ts_row[1] or 0) if ts_row else 0
        if t:
            lt = {"requests": t[0], "retries": t[1], "tool_calls": t[2], "tool_errors": t[3],
                  "input": t[4], "output": t[5], "reasoning": t[6], "cache_read": t[7],
                  "cache_write": t[8], "total": t[9], "duration_ms": t[10], "ttft_ms": t[11],
                  "started": turn_started, "ended": turn_ended}
        else:
            # 轮进行中 turn_usage 还没落 completed 行：回退 model_usage 现场聚合，保持实时显示
            r = con.execute(
                """select count(*), coalesce(sum(input_tokens),0), coalesce(sum(output_tokens),0),
                          coalesce(sum(computed_total_tokens),0), coalesce(sum(duration_ms),0),
                          coalesce(sum(cache_read_input_tokens),0), coalesce(sum(reasoning_tokens),0),
                          coalesce(sum(cache_creation_input_tokens),0)
                   from model_usage where session_id=? and turn_id=? and status='completed'""",
                (sid, last["turn_id"]),
            ).fetchone()
            lt = {"requests": r[0], "retries": 0, "tool_calls": 0, "tool_errors": 0,
                  "input": r[1], "output": r[2], "reasoning": r[6], "cache_read": r[5],
                  "cache_write": r[7], "total": r[3], "duration_ms": r[4], "ttft_ms": 0,
                  "started": turn_started, "ended": turn_ended}
        # 本轮平均耗时/平均首字延迟（v211 用户规格）：对 model_usage 该轮已完成 main_turn 行
        # 直接求均值——turn_usage 的 ttft_ms 聚合列实测既非 Σ 也非 μ（宿主口径不明），不可依赖；
        # >0 过滤无效样本（缺首字/零耗时行不进均值，同测速无效段哲学）
        av = con.execute(
            """select avg(case when duration_ms > 0 then duration_ms end),
                      avg(case when time_to_first_token_ms > 0 then time_to_first_token_ms end)
               from model_usage where session_id=? and turn_id=? and status='completed'
                 and (query_source is null or query_source='main_turn')""",
            (sid, last["turn_id"]),
        ).fetchone()
        lt["avg_duration_ms"] = round(av[0] or 0)
        lt["avg_ttft_ms"] = round(av[1] or 0)
        lt.update(_turn_rate(con.execute(
            """select output_tokens, first_token_at, completed_at, started_at, reasoning_tokens, model_id, provider_id
               from model_usage where session_id=? and turn_id=? and status='completed'""",
            (sid, last["turn_id"]),
        ).fetchall(), covers))
    lr = con.execute("select max(completed_at) from model_usage where session_id=?", (sid,)).fetchone()
    active = bool(lr and lr[0] and int(time.time() * 1000) - lr[0] < SESSION_TIMEOUT_MS)
    ctx_auto = lookup_context_window(last["model_id"]) if last else None
    rate = _last_valid_rate(con, sid, last, covers)
    sub_rows = con.execute(
        """select m.session_id, coalesce(m.agent,''), coalesce(s2.title,''), count(*),
                  coalesce(sum(m.computed_total_tokens),0),
                  coalesce(sum(m.input_tokens),0), coalesce(sum(m.output_tokens),0),
                  coalesce(sum(m.cache_read_input_tokens),0), coalesce(sum(m.reasoning_tokens),0),
                  coalesce(sum(m.cache_creation_input_tokens),0), max(m.completed_at), s2.time_created,
                  min(m.started_at)
           from model_usage m join session s2 on m.session_id = s2.id
           where m.query_source='subagent' and s2.parent_id=? and m.status='completed'
           group by m.session_id order by max(m.completed_at) desc""",
        (sid,),
    ).fetchall()
    # 子代理任务名：Agent 工具调用 part 的 input.description（与宿主"子智能体目录"面板同源）。
    # 主关联用官方回执：完成后 part.state.output 尾部带 "agentId: agent_xxx" 行，
    # 子会话 id 即 "sess_subagent_"+agentId（客户端自己的硬关联，无歧义）。
    # 兜底只给运行中尚未出现回执的条目：prompt 前缀匹配且候选唯一才绑（同前缀多候选宁可
    # 无名，不做时间猜测——历史 part 不带 childSessionId，时间最近邻存在错位风险）。
    sub_tasks = _sub_agent_tasks(con, sid) if sub_rows else {}
    # 子代理已完成段速率（v97）：每子会话 Σ有效 output / Σ有效生成窗口的加权平均，
    # 口径与 _turn_rate 完全一致（first_token_at 缺失即无窗、含思考段窗口用 started_at）；
    # 无效段不进分母。运行中的请求未入库，这里只有已完成段。
    sub_gen = {}
    if sub_rows:
        for r in con.execute(
            """select m.session_id, m.output_tokens, m.first_token_at, m.completed_at,
                      m.started_at, m.reasoning_tokens, m.model_id, m.provider_id
               from model_usage m join session s2 on m.session_id = s2.id
               where m.query_source='subagent' and s2.parent_id=? and m.status='completed'""",
            (sid,),
        ):
            g = sub_gen.setdefault(r["session_id"], [0, 0])
            tokens = r["output_tokens"] or 0
            gen_ms = _row_gen_ms(r, covers)
            if tokens > 0 and _valid_gen_window(gen_ms):
                g[0] += tokens
                g[1] += gen_ms
    now_ms = int(time.time() * 1000)
    sub = {
        "requests": sum(r[3] for r in sub_rows),
        "total": sum(r[4] for r in sub_rows),
        "input": sum(r[5] for r in sub_rows),
        "output": sum(r[6] for r in sub_rows),
        "cache_read": sum(r[7] for r in sub_rows),
        "reasoning": sum(r[8] for r in sub_rows),
        "cache_write": sum(r[9] for r in sub_rows),
        "active": any(r[10] and now_ms - r[10] < 30000 for r in sub_rows),
        "rate_avg": _rated_tps(sum(g[0] for g in sub_gen.values()),
                               sum(g[1] for g in sub_gen.values())),
        "list": [
            _sub_item(r, sub_tasks, sub_gen)
            for r in sub_rows
        ],
    }
    # 工具调用明细（tool_usage 表，本会话按工具分组；status=running 的行不计入）
    tool_rows = con.execute(
        """select tool_name, count(*), coalesce(sum(duration_ms),0),
                  sum(case when status='error' then 1 else 0 end)
           from tool_usage where session_id=? and status in ('completed','error')
           group by tool_name order by count(*) desc, tool_name""",
        (sid,),
    ).fetchall()
    tools = {
        "total": sum(r[1] for r in tool_rows),
        "errors": sum(r[3] or 0 for r in tool_rows),
        "list": [
            {"name": r[0], "count": r[1], "duration_ms": r[2], "errors": r[3] or 0}
            for r in tool_rows
        ],
    }
    # 模型明细（v163，v164 起全量不截断）：按模型分组的 completed 用量（原 v202 在同一条
    # GROUP BY 上顺带计费的链路已按决策 7 裁剪，只保留计数/用量）。
    models = _session_models(con, sid)
    return {
        "sid": sid,
        "title": (srow["title"] if srow is not None else "") or "",
        "active": active,
        "turns": u["turns"] if u else 0,
        "requests": u["requests"] if u else 0,
        "input": u["input"] if u else 0,
        "output": u["output"] if u else 0,
        "reasoning": u["reasoning"] if u else 0,
        "cache_read": u["cache_read"] if u else 0,
        "cache_write": u["cache_write"] if u else 0,
        "total": u["total"] if u else 0,
        "tool_calls": u["tool_calls"] if u else 0,
        "retries": u["retries"] if u else 0,
        # 上下文兜底（R4）：最近完成请求 input（=当前上下文容量）+ 模型目录 contextWindow
        "ctx": u["last_request_input"] if u else 0,
        "updated": (_ts(lr[0]).strftime("%H:%M:%S") if lr and lr[0] else ""),
        "started": _session_start_ms(con, sid, srow),
        "avg_tps": sess_avg,
        "speed_segs": _speed_segments(con, sid, covers),
        "sub": sub,
        "tools": tools,
        "models": models,
        "last_turn": lt,
        "last": {
            "duration_ms": last["duration_ms"] if last else 0,
            "ttft_ms": last[1] if last else 0,
            "model": last["model_id"] if last else "",
            # v94：当前模型归属。可选字段——消费端按缺省 "" 容错（last.startedAt 同款先例）。
            "provider_id": (last["provider_id"] or "") if last else "",
            **rate,
        },
        # 代码变更统计（session 表 summary_* 列，ZCode 目前未填充、全库为 NULL，有值才会显示）
        "code": {
            "add": (srow["summary_additions"] if srow is not None else None),
            "del": (srow["summary_deletions"] if srow is not None else None),
            "files": (srow["summary_files"] if srow is not None else None),
        },
        # 最近一次"上下文超限被拒"的时刻（该请求 status=error，不会进 completed 统计）；
        # 晚于最近成功请求 = 仍处于超限状态，进度条亮红告警
        "ctx_exc": con.execute(
            """select coalesce(max(coalesce(completed_at, started_at)),0)
               from model_usage where session_id=? and context_exceeded=1""",
            (sid,),
        ).fetchone()[0],
        "context_window": ctx_auto or cfg["context_window"],
        "context_auto": ctx_auto is not None,
        "last_at": con.execute(
            "select max(completed_at) from model_usage where session_id=? and status='completed'", (sid,),
        ).fetchone()[0] or 0,
        "is_sub": sid.startswith("sess_subagent"),
        "parent": (srow["parent_id"] if srow is not None else None),
    }


def _session_models(con, sid):
    """会话按模型明细（v163，v164 起全量不截断）：completed 行 GROUP BY model_id，
    按 total 降序。原 v202 在同一条查询上顺带预估费用的链路已按决策 7 裁剪。"""
    acc = {}
    for r in con.execute(
        """select model_id, count(*), coalesce(sum(computed_total_tokens),0)
           from model_usage where session_id=? and status='completed'
           group by model_id""", (sid,)).fetchall():
        a = acc.setdefault(r[0] or "", [0, 0])
        a[0] += r[1]
        a[1] += r[2]
    models = [{"model": k, "requests": v[0], "total": v[1]} for k, v in acc.items()]
    models.sort(key=lambda m: -m["total"])
    return models


_EMPTY_TURN = {"requests": 0, "retries": 0, "tool_calls": 0, "tool_errors": 0, "input": 0,
               "output": 0, "reasoning": 0, "cache_read": 0, "cache_write": 0,
               "total": 0, "duration_ms": 0, "ttft_ms": 0, "avg_duration_ms": 0, "avg_ttft_ms": 0,
               "started": 0, "ended": 0,
               "tps": 0, "rated_output": 0, "unrated_output": 0, "gen_ms": 0}


# ---------- CONTRACT §4.3 请求行投影（recent 键，供 session-stats.cjs aggregate()） ----------

def _col(r, name, default=None):
    """行字段安全读取：sqlite3.Row 缺列（旧库列漂移/瘦身夹具）返回 default，不击穿整帧。"""
    try:
        v = r[name]
    except (KeyError, IndexError):
        return default
    return v


def _is_subagent_row(session_id, query_source):
    """子代理行判定（纯函数）：query_source='subagent' 或会话 id 为 sess_subagent_* 前缀。"""
    return (query_source == "subagent"
            or str(session_id or "").startswith("sess_subagent"))


def _has_column(con, table, column):
    """列存在性探测（只读 PRAGMA）。旧库/瘦身夹具缺列时 SELECT 会整条查询失败，
    投影需按实际 schema 拼接可选列。探测失败一律视为不存在。"""
    try:
        for r in con.execute(f"pragma table_info({table})"):
            if str(_col(r, "name") or "") == column:
                return True
    except Exception:
        return False
    return False


def _model_contract_row(r):
    """model_usage 行 → CONTRACT §4.3 请求行（纯函数）。
    thinking = 思考请求标记（reasoning_tokens>0）；Claude 系的 started_at 窗由消费方
    （session-stats.windowBasis）按 model 前缀自判，此处不重复判定。
    时间/token 取原值：缺失即 null，消费方按「非有限数值 = 缺失，逐行跳过」容错。
    sid = 投影来源会话 id（CONTRACT §4.3 扩展）：内核按窗口焦点会话过滤后聚合，防串数（R10）。
    turnId = 用户输入轮标识（CONTRACT §4.3 扩展）：一轮的工具循环会产生多次模型请求，
    聚合端按它去重才等于用户输入轮数；旧库缺列 → null，由消费方按独立一轮兜底。"""
    return {
        "id": str(_col(r, "id") if _col(r, "id") is not None else ""),
        "sid": str(_col(r, "session_id") or ""),
        "turnId": _col(r, "turn_id"),
        "kind": "model",
        "isSubagent": _is_subagent_row(_col(r, "session_id"), _col(r, "query_source")),
        "model": _col(r, "model_id") or "",
        "thinking": (_col(r, "reasoning_tokens") or 0) > 0,
        "status": _col(r, "status") or "",
        "startedAt": _col(r, "started_at"),
        "firstTokenAt": _col(r, "first_token_at"),
        "completedAt": _col(r, "completed_at"),
        "inputTokens": _col(r, "input_tokens"),
        "outputTokens": _col(r, "output_tokens"),
        "cacheReadTokens": _col(r, "cache_read_input_tokens"),
        "cacheWriteTokens": _col(r, "cache_creation_input_tokens"),
    }


def _tool_contract_row(r):
    """tool_usage 行 → CONTRACT §4.3 请求行（kind='tool'）。工具行无 token 分项，恒 0；
    status 原样透传（session-stats 仅统计 completed 的步数，running/error 忽略）。
    sid = 投影来源会话 id（同 _model_contract_row，供内核按窗口过滤）。
    turnId = 所属输入轮（§4.3 扩展）：工具行不参与 turns 计数，仅为与 model 行同形状而投影。"""
    return {
        "id": str(_col(r, "id") if _col(r, "id") is not None else ""),
        "sid": str(_col(r, "session_id") or ""),
        "turnId": _col(r, "turn_id"),
        "kind": "tool",
        "isSubagent": False,
        "model": _col(r, "tool_name") or "",
        "thinking": False,
        "status": _col(r, "status") or "",
        "startedAt": _col(r, "started_at"),
        "firstTokenAt": None,
        "completedAt": _col(r, "completed_at"),
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheReadTokens": 0,
        "cacheWriteTokens": 0,
    }


def _model_row_cols(con):
    """model 行投影列清单；turn_id 列存在才取（缺列时 SELECT 会整条失败）。
    其余列是 CONTRACT §4.3 的既有字段，按现网 schema 恒在，不做逐个探测。"""
    turn = "m.turn_id" if _has_column(con, "model_usage", "turn_id") else "NULL as turn_id"
    return f"""m.id, m.session_id, {turn}, m.query_source, m.model_id, m.status,
       m.started_at, m.first_token_at, m.completed_at, m.input_tokens, m.output_tokens,
       m.reasoning_tokens, m.cache_read_input_tokens, m.cache_creation_input_tokens"""


def _project_request_rows(con, sids, cap=_ROWS_CAP):
    """把请求指定的会话投影为 CONTRACT §4.3 请求行（recent 键；注入内核 aggregate 缝）。
    范围（模块头注释「投影范围」同款，R10 宁可少算不可串数）：
      * 主会话：main_turn/无标记的 model 行 + 全部 tool_usage 行（含 running，步数口径只
        认 completed，running 行供消费方自行取舍）；
      * 子代理：子会话（parent_id 指向请求会话）的 model 行，isSubagent=true；
      * 辅助 query_source（session_title 等）与子代理工具行不投影——混入会污染主口径。
    排序按完成时间升序（聚合端按 completedAt 排趋势）；单查询与总量各限 cap 行
    （超长会话取最近，防 JSON 体量失控击穿内核 8MB stdout 护栏）。
    turn_id：列存在才投影（旧库/瘦身夹具可能没有该列），缺列时行带 turnId=None，
    聚合端按「独立一轮」兜底，不影响其余字段。"""
    if not sids:
        return []
    qm = ",".join("?" * len(sids))
    has_tool_turn = _has_column(con, "tool_usage", "turn_id")
    tool_turn_col = "t.turn_id" if has_tool_turn else "NULL as turn_id"
    model_cols = _model_row_cols(con)
    rows = []
    # 主会话 model 行（辅助 query_source 不投影）
    for r in con.execute(
        f"""select {model_cols}
            from model_usage m where m.session_id in ({qm})
              and (m.query_source is null or m.query_source='main_turn')
            order by coalesce(m.completed_at, m.started_at) desc limit ?""",
        (*sids, cap),
    ):
        rows.append(_model_contract_row(r))
    # 子代理 model 行（isSubagent=true；子会话由 session.parent_id 关联）
    for r in con.execute(
        f"""select {model_cols}
            from model_usage m where m.query_source='subagent'
              and m.session_id in (select id from session where parent_id in ({qm}))
            order by coalesce(m.completed_at, m.started_at) desc limit ?""",
        (*sids, cap),
    ):
        rows.append(_model_contract_row(r))
    # 主会话工具行（kind='tool'）
    for r in con.execute(
        f"""select t.id, t.session_id, {tool_turn_col}, t.tool_name, t.status, t.started_at, t.completed_at
            from tool_usage t where t.session_id in ({qm})
            order by coalesce(t.completed_at, t.started_at) desc limit ?""",
        (*sids, cap),
    ):
        rows.append(_tool_contract_row(r))

    def sort_key(row):
        t = row["completedAt"] if row["completedAt"] is not None else row["startedAt"]
        return t if t is not None else 0

    rows.sort(key=sort_key)
    return rows[-cap:] if len(rows) > cap else rows


def _empty_snapshot(sid, cfg):
    return {"sid": sid, "title": "", "active": False, "turns": 0, "requests": 0,
            "input": 0, "output": 0, "reasoning": 0, "cache_read": 0, "cache_write": 0,
            "total": 0, "tool_calls": 0, "retries": 0, "ctx": 0, "updated": "", "last_at": 0, "started": 0, "avg_tps": 0,
            "speed_segs": [],
            "last_turn": dict(_EMPTY_TURN), "last": {"duration_ms": 0, "ttft_ms": 0, "model": "", "tps": 0, "startedAt": 0, "endedAt": 0},
            "code": {"add": None, "del": None, "files": None}, "ctx_exc": 0,
            "tools": {"total": 0, "errors": 0, "list": []},
            "sub": {"requests": 0, "total": 0, "input": 0, "output": 0, "cache_read": 0,
                    "reasoning": 0, "cache_write": 0, "active": False, "rate_avg": 0, "list": []},
            "context_window": cfg["context_window"], "context_auto": False}


def snapshot(force_sid="", serve_con=None):
    """单次快照（一次查询一帧，全部数据只读本库产出）。
    force_sid：各窗口当前会话 id，逗号分隔（泵按窗口汇总上报焦点会话），全部强制纳入
    known_sids/not_local 判定与 recent 请求行投影——不在池里的会话（新开的、久远的）
    也能被各窗口按 sid 取到请求行（v32 起多窗口多 sid）。
    serve_con：serve 常驻进程传入的复用连接（None = 自建自关，CLI/json 一次性路径）。
    连接所有权归调用方：serve 模式下查询期出错会就地 close（调用方下次探活重建），
    finally 不重复关闭。

    返回结构（键相对原插件的删除清单见模块 docstring）：
      local_error          本地库错误摘要（None = 正常）
      session              最新活跃会话完整快照（诊断 + 上下文兜底数据）
      last_turn / last     session 的同源引用（顶层便捷键，原结构保留）
      today                今日合计（requests/input/output/cache_read/total/reasoning/…）
      known_sids           请求 sid 中本地库存在的
      not_local            请求 sid 中本地库不存在的（诊断提示「确无此会话」）
      context_window / context_auto / code / ctx_exc / tools   session 同源便捷键
      recent               CONTRACT §4.3 请求行投影（语义变更见模块 docstring）"""
    cfg = load_config()
    con = serve_con
    owns_con = serve_con is None
    local_error = None
    if owns_con:
        try:
            con = connect()
        except sqlite3.Error as exc:
            local_error = str(exc)[:200]
            con = None
    try:
        force_sids = []
        for fs in str(force_sid).split(","):
            fs = fs.strip()
            if fs and re.fullmatch(r"[A-Za-z0-9_-]+", fs) and fs not in force_sids:
                force_sids.append(fs)
        today, rows, have_local = (0,) * 11, [], set()
        if con is not None:
            try:
                day = _day_start()
                start_ms, end_ms = _epoch_ms(day), _epoch_ms(day + timedelta(days=1))
                today = _cached_agg(("today", start_ms), lambda: _today_usage(
                    con, start_ms, end_ms))
                rows = _scan_session_ids(con)
                if force_sids:
                    qmarks = ",".join("?" * len(force_sids))
                    have_local = {r[0] for r in con.execute(
                        f"select id from session where id in ({qmarks})", force_sids)}
                    have_local |= {r[0] for r in con.execute(
                        f"select distinct session_id from model_usage where session_id in ({qmarks})",
                        force_sids)}
            except sqlite3.Error as exc:
                local_error = str(exc)[:200]
                con.close()
                con = None
                today, rows, have_local = (0,) * 11, [], set()
        known_sids = [s for s in force_sids if s in have_local]
        # 本地库里没有的请求会话（数据还没落库/他机会话）。渲染端据此给提示：
        # 零值不再只能靠用户猜"插件坏了"（原 issue #14 提示键保留）。
        not_local = [s for s in force_sids if s not in have_local] if force_sids else []

        def local_snapshot(sid):
            nonlocal local_error
            if con is None:
                return _empty_snapshot(sid, cfg)
            try:
                return _session_snapshot(con, sid, cfg)
            except sqlite3.Error as exc:
                # 单会话明细表缺失/列漂移不击穿整帧：空快照 + local_error 记录。
                local_error = str(exc)[:200]
                return _empty_snapshot(sid, cfg)

        latest_sid = max(rows, key=lambda r: r[1])[0] if rows else None
        base = local_snapshot(latest_sid) if latest_sid else _empty_snapshot("", cfg)
        # 请求行投影：仅覆盖请求指定的会话（空请求不投影——无焦点会话不推其它会话数据，R10）
        recent_rows = []
        if con is not None and force_sids:
            try:
                recent_rows = _project_request_rows(con, force_sids)
            except sqlite3.Error as exc:
                local_error = str(exc)[:200]
                recent_rows = []
        return {
            "local_error": local_error,
            "session": base,
            "last_turn": base["last_turn"],
            "last": base["last"],
            "today": {
                "requests": today[0], "input": today[1], "output": today[2],
                "cache_read": today[3], "total": today[4],
                "reasoning": today[6], "retries": today[7], "cache_write": today[8],
                "started": today[9] or 0, "last_at": today[10] or 0,
            },
            "not_local": not_local,
            "known_sids": known_sids,
            "context_window": base["context_window"],
            "context_auto": base["context_auto"],
            "code": base["code"],
            "ctx_exc": base["ctx_exc"],
            "tools": base["tools"],
            "recent": recent_rows,
        }
    finally:
        if con is not None and owns_con:
            con.close()


# ---------- CLI ----------

_SERVE_IDLE_S = 60.0   # serve 复用连接的空闲重建阈值（测试把它调成负数即可覆盖回收分支）


def _parse_query(line):
    """请求行解析：JSON {"sids":[...]}（新协议；未知字段——如已裁剪的 scopes——忽略）或
    旧逗号分隔 sid 串（兼容旧 "sids|routes" 协议的左半段，路由已裁剪）。
    返回逗号拼接的 sid 串，与 snapshot(force_sid) 对齐。"""
    line = (line or "").strip()
    if not line:
        return ""
    if line.startswith("{"):
        data = json.loads(line)
        if not isinstance(data, dict):
            raise ValueError("query must be an object")
        sids = data.get("sids") or []
        if not isinstance(sids, list):
            raise ValueError("sids must be an array")
        return ",".join(str(s) for s in sids)
    if "|" in line:
        line = line.split("|", 1)[0]   # 旧协议路由段：远端链已裁剪，丢弃
    return line.strip()


def serve():
    """常驻查询服务（泵配套）：省每次 ~60-100ms 的解释器启动+模块加载费。
    stdin 每行一个请求（空行 = 无强制会话），stdout 每行一个 JSON 快照。
    stdin EOF = 泵已退出（管道断开），随即 exit——孤儿进程自清理。
    本地库连接跨请求复用（fork perf/only 同源收编，326MB 库实测单查询 22.6→5.4ms）：
    全部 SELECT 走 autocommit 且游标迭代到穷尽，空闲连接不持读锁、不碍 WAL checkpoint；
    连接在空闲超 60s 后的下一次请求前、库文件被替换（st_dev/st_ino 变化）时、
    探活失败或查询异常后重建。json 一次性路径仍每请求开-关。"""
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    con = None
    stamp = None
    last_used = 0.0

    def _drop():
        nonlocal con
        if con is not None:
            try:
                con.close()
            except sqlite3.Error:
                pass
            con = None

    while True:
        line = sys.stdin.readline()
        if not line:
            _drop()
            return
        now = time.monotonic()
        fresh = False
        try:
            st = os.stat(DB_PATH)
            stamp_now = (st.st_dev, st.st_ino)
            fresh = stamp_now == stamp
        except OSError:
            stamp_now = None
        if con is not None and (not fresh or now - last_used > _SERVE_IDLE_S):
            _drop()   # 长空闲后的旧连接/被替换的库文件：宁可重开一次也不带病复用
        if con is not None:
            try:
                con.execute("select 1")
            except sqlite3.Error:
                _drop()   # 上一轮查询期出错被 snapshot 就地 close：探活即重建
        if con is None:
            try:
                con = connect()
                if stamp_now is not None:
                    stamp = stamp_now
            except sqlite3.Error:
                con = None
        try:
            force_sid = _parse_query(line.strip())
            out = json.dumps(snapshot(force_sid, serve_con=con))
        except Exception as e:
            out = json.dumps({"error": str(e)[:200]})   # 单次查询失败不杀常驻进程
            _drop()   # 异常路径下连接状态未知：弃用，下轮重建
        last_used = time.monotonic()
        sys.stdout.write(out + "\n")
        sys.stdout.flush()


def _cli_count(argv, default):
    """CLI 正整数参数（days/sessions/models/watch 的 N/秒）：非数字或 <1 给可读提示
    退出，不再 ValueError traceback 或 watch 0 忙循环。缺省走 default。"""
    if len(argv) <= 1:
        return default
    try:
        v = int(argv[1])
    except ValueError:
        print(L(f"无效参数：{argv[1]!r} 应为正整数", f"invalid argument: {argv[1]!r} expects a positive integer"))
        raise SystemExit(2)
    if v < 1:
        print(L(f"无效参数：{argv[1]!r} 应为正整数", f"invalid argument: {argv[1]!r} expects a positive integer"))
        raise SystemExit(2)
    return v


def main(argv):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    cmd = argv[0] if argv else "now"
    try:
        if cmd == "json":
            force_sid = _parse_query(argv[1] if len(argv) > 1 else "")
            print(json.dumps(snapshot(force_sid)))
            return 0
        if cmd == "serve":
            serve()
            return 0
        con = connect()
        if cmd == "now":
            print(render_current(con))
        elif cmd == "today":
            print(render_today(con))
        elif cmd == "days":
            print(render_days(con, _cli_count(argv, 7)))
        elif cmd == "sessions":
            print(render_sessions(con, _cli_count(argv, 10)))
        elif cmd == "models":
            print(render_models(con, _cli_count(argv, 7)))
        elif cmd == "workspace":
            print(render_workspace(con, argv[1] if len(argv) > 1 else ""))
        elif cmd == "session":
            print(render_session_detail(con, argv[1] if len(argv) > 1 else ""))
        elif cmd == "watch":
            sec = _cli_count(argv, 5)
            while True:
                print("\x1b[2J\x1b[H", end="")
                print(render_current(con), flush=True)
                print(L(f"\n(每 {sec}s 刷新, Ctrl+C 退出)", f"(refreshes every {sec}s, Ctrl+C to quit)"), flush=True)
                time.sleep(sec)
        else:
            print(__doc__)
        con.close()
    except sqlite3.DatabaseError as e:
        # 列/表变更不在 connect 的表存在性探测内（那会破坏按需裁剪的测试夹具库），
        # 在入口统一转换成可行动提示，替代整段查询栈回溯。
        print(L(f"查询失败：{e}", f"query failed: {e}"))
        print(L("多半是 ZCode 升级改了用量库结构（表/列变更）。请更新本插件后再查询；"
                "已落库的历史数据不受影响。",
                "Most likely ZCode changed the usage DB schema in an update. "
                "Update this plugin before querying; stored history is unaffected."))
        return 1
    return 0


def render_today(con):
    today = range_usage(con, _epoch_ms(_day_start()), _epoch_ms(_day_start() + timedelta(days=1)))
    head = L(f"■ 今日 ({datetime.now():%Y-%m-%d %a})", f"■ Today ({datetime.now():%Y-%m-%d %a})")
    row = L(f"  {today[0]} 次请求  input {fmt(today[1])} (cache read {fmt(today[3])})  "
            f"output {fmt(today[2])}  合计 {fmt(today[4])}",
            f"  {today[0]} requests  input {fmt(today[1])} (cache read {fmt(today[3])})  "
            f"output {fmt(today[2])}  total {fmt(today[4])}")
    return head + "\n" + row


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
