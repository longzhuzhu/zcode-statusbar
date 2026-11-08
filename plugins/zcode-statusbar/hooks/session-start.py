#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SessionStart hook：stdin 收 hook 入参 JSON，stdout 只输出 hook 协议 JSON。

职责（由 core/runtime_install.run_hook 承担）：
  同步运行时文件（热更新）；未注入即自动安装（恒开）；待重启/待更新不注入会话文字，
  由状态条齿轮红点承载。任何异常都转成合法 JSON 输出，绝不抛出、绝不影响会话。

相对原插件差异：无 prompt-submit hook（R11 零会话干扰）；不记录提问时刻
（token_rate 属裁剪项）；core/ 目录由本 hook 向上逐级探测（发布布局
<marketplace 根>/core/，开发布局 <仓库根>/core/）。
"""
import json
import os
import sys
import threading
import time
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent


def find_core_root():
    """从插件根逐级向上找 core/runtime_install.py：发布布局在 marketplace 根下，
    仓库开发布局在仓库根下，同构。扁平插件包（ZCode 缓存安装：运行时文件与
    hooks/ 同级）兜底返回插件根自身。找不到返回 None（fail-closed，不猜路径）。"""
    for base in (PLUGIN_ROOT, *PLUGIN_ROOT.parents):
        candidate = base / "core" / "runtime_install.py"
        if candidate.is_file():
            return base / "core"
    if (PLUGIN_ROOT / "runtime_install.py").is_file():
        return PLUGIN_ROOT
    return None


def read_stdin(timeout_s=2.0):
    """消费 stdin（协议要求），设超时兜底：客户端不给 EOF 也不挂起。内容不使用。"""
    result = {"raw": ""}

    def pump():
        try:
            result["raw"] = sys.stdin.read()
        except Exception:
            pass

    t = threading.Thread(target=pump, daemon=True)
    t.start()
    t.join(timeout_s)
    return result["raw"]


def main():
    raw = read_stdin()
    try:
        payload = json.loads(raw or "{}")
    except ValueError:
        payload = {}
    try:
        core = find_core_root()
        if core is None:
            raise FileNotFoundError("未找到 core/runtime_install.py（插件包布局不完整）")
        if str(core) not in sys.path:
            sys.path.insert(0, str(core))
        import runtime_install
        result = runtime_install.run_hook()
    except Exception as e:  # noqa: BLE001 — hook 绝不能抛
        message = f"zcode-statusbar 插件自检失败（已忽略）：{e}"
        result = {"suppressOutput": True}
        try:
            runtime = Path(os.environ.get("ZCODE_STATUSBAR_RUNTIME") or Path.home() / ".zcode/zcode-statusbar")
            opted_out = (runtime / ".plugin-statusbar-optout").exists()
        except (OSError, RuntimeError):
            opted_out = True
        if opted_out:
            print("[zcode-statusbar] " + message, file=sys.stderr)
        else:
            result.update(systemMessage=message, hookSpecificOutput={
                "hookEventName": "SessionStart", "additionalContext": message})
    try:
        runtime = Path(os.environ.get("ZCODE_STATUSBAR_RUNTIME") or Path.home() / ".zcode/zcode-statusbar")
        runtime.mkdir(parents=True, exist_ok=True)
        record = {"time": time.time(), "pluginRoot": str(PLUGIN_ROOT),
                  "source": payload.get("source", "") if isinstance(payload, dict) else "",
                  "sessionId": os.environ.get("ZCODE_SESSION_ID") or os.environ.get("CLAUDE_SESSION_ID") or "",
                  "result": result}
        fd, tmp = None, None
        import tempfile
        fd, tmp = tempfile.mkstemp(prefix=".plugin-session-start.", dir=str(runtime))
        with os.fdopen(fd, "wb") as stream:
            stream.write(json.dumps(record, ensure_ascii=False, indent=2).encode("utf-8"))
        os.replace(tmp, runtime / "plugin-session-start.json")
    except Exception as e:
        print(f"[zcode-statusbar] 会话启动诊断写入失败：{e}", file=sys.stderr)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    # Windows 默认（无全局 PYTHONUTF8）下中文输出会按区域编码（GBK 等）写管道，
    # 宿主按 UTF-8 解码 hook stdout 会得到乱码——与原插件同款防护。
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    main()
