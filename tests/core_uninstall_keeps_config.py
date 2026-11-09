# -*- coding: utf-8 -*-
"""卸载编排补充回归（A-fin）：config.json 保留与重装配置生效（AC7 尾环）、
引擎 restore 确经 subprocess 调用（缺口①的显式性断言）。

前序 tests/core_uninstall_gaps.py 已覆盖三缺口行为本身（restore 往返、ZIP 撤销、
剥离失败保留目录）；本文件只补其未覆盖的两个断言面：
  1. 卸载成功后 config.json 原样保留，重复卸载幂等（重装后配置仍生效的前提）；
  2. run_uninstall 的引擎 restore 走 ELECTRON_RUN_AS_NODE 子进程（经 engine-patch.cjs），
     不在卸载进程内直接改引擎字节。
全部在临时目录模拟 asar/引擎，不触碰真实安装。需要 node（缺口①走真实子进程）。
运行：python3 -m unittest tests.core_uninstall_keeps_config（仓库根）。
"""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "core"
if str(CORE) not in sys.path:
    sys.path.insert(0, str(CORE))
import patch_install  # noqa: E402
import uninstall  # noqa: E402

HAVE_NODE = shutil.which("node") is not None


def make_asar(path, entry=b"console.log('official v1');"):
    """最小合法 asar 夹具（/out/main/index.js + /package.json）。"""
    pkg = json.dumps({"name": "@zcode/desktop", "type": "module",
                      "version": "3.18.0"}).encode()
    header = {"files": {"out": {"files": {"main": {"files": {
        "index.js": {"size": len(entry), "offset": "0"}}}}},
        "package.json": {"size": len(pkg), "offset": str(len(entry))}}}
    raw = json.dumps(header, separators=(",", ":")).encode()
    c = (len(raw) + 7) // 4 * 4
    path.write_bytes(struct_pack(len(raw), c) + raw +
                     b"\0" * (c - len(raw) - 4) + entry + pkg)


def struct_pack(raw_len, c):
    import struct
    return struct.pack("<4I", 4, c + 4, c, raw_len)


@unittest.skipUnless(HAVE_NODE, "需要 Node 跑真实引擎补丁 restore 子进程")
class UninstallKeepsConfigTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.root / "home"
        self.home.mkdir()
        env = mock.patch.dict(os.environ, {"HOME": str(self.home), "USERPROFILE": str(self.home),
                                           "ZCODE_STATUSBAR_NO_MONITOR": "1",
                                           "ZCODE_STATUSBAR_MONITOR_QUIET": ""})
        env.start()
        self.addCleanup(env.stop)
        self.resources = self.root / "resources"
        self.resources.mkdir(parents=True)
        # 干净引擎夹具：restore 对无补丁引擎按 no-op 收敛（off），与真机引擎本就干净同形
        engine_dir = self.resources / "glm"
        engine_dir.mkdir()
        (engine_dir / "zcode.cjs").write_text('#!/usr/bin/env node\n"use strict";\n', encoding="utf-8")
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        # 引擎补丁脚本进运行目录（restore 子进程 require 的就是这份副本）
        shutil.copy2(CORE / "engine-patch.cjs", self.runtime / "engine-patch.cjs")
        (self.runtime / "runtime_lock.py").write_text("// not needed by restore", encoding="utf-8")
        # loader 夹具（重装场景 install() 要求运行目录里有 loader）
        (self.runtime / "inject-main.cjs").write_text("// fixture", encoding="utf-8")
        # 预置用户配置（AC7：卸载保留，重装生效）
        self.config = self.runtime / "config.json"
        self.config.write_text(json.dumps({
            "python_path": "/usr/bin/python3", "asar_path": "/Applications/ZCode.app/Contents/Resources/app.asar",
            "activity_min_ms": 1500, "lang": "zh"}), encoding="utf-8")
        self.asar = self.resources / "app.asar"
        make_asar(self.asar, b"official;" + patch_install.INJECT_LINE.encode())

    def test_engine_restore_runs_via_subprocess_with_engine_patch_cjs(self):
        """缺口①显式性：restore 经 ELECTRON_RUN_AS_NODE 子进程 require 运行目录的
        engine-patch.cjs，不在卸载进程内直接改引擎字节。"""
        with mock.patch.object(uninstall.subprocess, "run", wraps=subprocess.run) as spawn:
            with contextlib.redirect_stdout(io.StringIO()):
                report = uninstall.run_uninstall(asar=self.asar, runtime=self.runtime)
        self.assertTrue(report["ok"], report)
        engine_calls = [call for call in spawn.call_args_list
                        if len(call.args[0]) > 3 and str(call.args[0][1]) == "-e"]
        self.assertTrue(engine_calls, "引擎 restore 应经 node -e 子进程")
        argv = engine_calls[0].args[0]
        self.assertIn("engine-patch.cjs", argv[3])
        self.assertEqual(argv[4], str(self.runtime))
        self.assertEqual(engine_calls[0].kwargs.get("env", {}).get("ELECTRON_RUN_AS_NODE"), "1")

    def test_uninstall_keeps_config_json_and_repeat_is_idempotent(self):
        """卸载成功后 config.json 原样保留；重复卸载幂等（ok 收敛），配置仍可读——
        重装（sync/安装链不动 config）后用户配置继续生效（AC7）。"""
        original = json.loads(self.config.read_text(encoding="utf-8"))
        with contextlib.redirect_stdout(io.StringIO()):
            first = uninstall.run_uninstall(asar=self.asar, runtime=self.runtime)
        self.assertTrue(first["ok"], first)
        self.assertEqual(json.loads(self.config.read_text(encoding="utf-8")), original)
        self.assertTrue((self.runtime / "config.json").is_file())
        # 已干净的 asar 上重复卸载：全部步骤按「本就干净」收敛，配置不动
        with contextlib.redirect_stdout(io.StringIO()):
            second = uninstall.run_uninstall(asar=self.asar, runtime=self.runtime)
        self.assertTrue(second["ok"], second)
        self.assertEqual(json.loads(self.config.read_text(encoding="utf-8")), original)
        self.assertIs(second["asar"], True)
        # uninstall 包装语义：restore() 的 off（已干净/已还原）上报为 "restored"
        self.assertEqual(second["engine"]["status"], "restored")

    def test_reinstall_redirects_injection_and_config_survives_next_uninstall(self):
        """重装（重写注入行指向运行目录）→ 再次卸载收敛 → 配置历经两轮卸载仍在。"""
        original = json.loads(self.config.read_text(encoding="utf-8"))
        with contextlib.redirect_stdout(io.StringIO()):
            first = uninstall.run_uninstall(asar=self.asar, runtime=self.runtime)
        self.assertTrue(first["ok"], first)
        patch_install.set_target(self.asar)
        patch_install.set_runtime(self.runtime)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(patch_install.install())
        self.assertEqual(patch_install.injected_state(), True)
        with contextlib.redirect_stdout(io.StringIO()):
            second = uninstall.run_uninstall(asar=self.asar, runtime=self.runtime)
        self.assertTrue(second["ok"], second)
        self.assertEqual(patch_install.injected_state(), False)
        self.assertEqual(json.loads(self.config.read_text(encoding="utf-8")), original)


if __name__ == "__main__":
    unittest.main()
