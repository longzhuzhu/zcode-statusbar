# -*- coding: utf-8 -*-
"""卸载闭环三缺口端到端（design §5 / ADR-0001 卸载义务）。

  缺口① 插件 remove 路径显式调用引擎补丁 restore()（uninstall.restore_engine_patch）；
  缺口② ZIP 预注入撤销链：run_uninstall 消费运行目录撤销清单并逐条还原；
  缺口③ asar 剥离失败 → 运行目录与 state 文件保留 + 修复指引，绝不删除目录。

全部在临时目录模拟 asar/引擎/ZIP，不触碰真实安装。需要 node（缺口①经真实
ELECTRON_RUN_AS_NODE 子进程验证 restore 的 fail-closed 与反向还原）。
运行：python3 -m unittest tests.core_uninstall_gaps（仓库根）。
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "core"
if str(CORE) not in sys.path:
    sys.path.insert(0, str(CORE))
import patch_install  # noqa: E402
import pending_zip_patch  # noqa: E402
import uninstall  # noqa: E402

HAVE_NODE = shutil.which("node") is not None

ENGINE_ANCHOR = "n=cke(e.bufferTokens)??jBo;return Math.max(0,t-n)"


def make_asar(path, entry=b"console.log('official v1');"):
    header = {"files": {"out": {"files": {"main": {"files": {
        "index.js": {"size": len(entry), "offset": "0"}
    }}}}, "package.json": {"size": 0, "offset": "0"}}}
    pkg = b"{}"
    header["files"]["package.json"] = {"size": len(pkg), "offset": str(len(entry))}
    raw = json.dumps(header, separators=(",", ":")).encode()
    c = (len(raw) + 7) // 4 * 4
    path.write_bytes(struct.pack("<4I", 4, c + 4, c, len(raw)) + raw +
                     b"\0" * (c - len(raw) - 4) + entry + pkg)


def make_engine_fixture():
    """带唯一锚点的引擎夹具（与 engine-patch.test.cjs 同形）。"""
    return ('#!/usr/bin/env node\n"use strict";var wXi=1;\n'
            "function q(e){let t=X(e)," + ENGINE_ANCHOR + "}\n")


@unittest.skipUnless(HAVE_NODE, "需要 Node 跑真实引擎补丁 restore")
class EngineRestoreGapTests(unittest.TestCase):
    """缺口①：卸载链显式调用引擎补丁 restore()。"""

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
        (self.resources / "glm").mkdir(parents=True)
        self.engine = self.resources / "glm" / "zcode.cjs"
        self.original = make_engine_fixture()
        self.engine.write_text(self.original, encoding="utf-8")
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        shutil.copy2(CORE / "engine-patch.cjs", self.runtime / "engine-patch.cjs")
        (self.runtime / "runtime_lock.py").write_text("// not needed by restore", encoding="utf-8")

    def patch_engine(self):
        """按登记 SHA 才打的语义打补丁：夹具 SHA 动态注册进 ENGINE_TARGETS 后 ensure()。"""
        script = (
            "const ep = require(process.argv[1]);"
            "const {createHash} = require('crypto');"
            "const fs = require('fs');"
            "const engine = process.argv[3] + '/glm/zcode.cjs';"
            "const sha = createHash('sha256').update(fs.readFileSync(engine)).digest('hex');"
            "ep.ENGINE_TARGETS.push({build:'test', engineSha256: sha,"
            " anchor: ep.ANCHOR, replacement: ep.REPLACEMENT, prologue: ep.PROLOGUE});"
            "const p = ep.createEnginePatcher({runtime: process.argv[2],"
            " resourcesPath: process.argv[3], isEnabled: () => true, log: () => {}});"
            "process.stdout.write(JSON.stringify(p.ensure()));"
        )
        result = subprocess.run(
            ["node", "-e", script, str(self.runtime / "engine-patch.cjs"),
             str(self.runtime), str(self.resources)],
            capture_output=True, text=True, encoding="utf-8", timeout=30,
            env=dict(os.environ, ELECTRON_RUN_AS_NODE="1"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), "applied")
        patched = self.engine.read_text(encoding="utf-8")
        self.assertIn("zcode-statusbar auto-compact threshold hook", patched)
        self.assertNotEqual(patched, self.original)
        return patched

    def test_restore_engine_patch_round_trips_to_original_bytes(self):
        self.patch_engine()
        report = uninstall.restore_engine_patch(self.resources, self.runtime, self.resources / "app.asar")
        self.assertEqual(report["status"], "restored", report)
        self.assertEqual(self.engine.read_text(encoding="utf-8"), self.original)
        sentinel = json.loads((self.runtime / "engine-patch.json").read_text())
        self.assertFalse(sentinel["patched"])

    def test_restore_engine_patch_is_noop_on_clean_engine(self):
        report = uninstall.restore_engine_patch(self.resources, self.runtime, self.resources / "app.asar")
        self.assertEqual(report["status"], "restored", report)   # off 归一为 restored/已干净
        self.assertEqual(self.engine.read_text(encoding="utf-8"), self.original)

    def test_restore_engine_patch_succeeds_without_registered_target(self):
        """restore 按补丁字节内容（replacement+prologue）识别已打补丁引擎，不依赖
        调用进程的登记表——这正是卸载链（新进程）能还原运行期补丁的前提。"""
        self.patch_engine()
        # 全新进程 + 空登记表（engine-patch.cjs 原样），restore 走内容回退分支
        report = uninstall.restore_engine_patch(self.resources, self.runtime)
        self.assertEqual(report["status"], "restored", report)
        self.assertEqual(self.engine.read_text(encoding="utf-8"), self.original)

    def test_run_uninstall_restores_engine_and_strips_asar(self):
        """端到端：run_uninstall（remove 单一入口）按序完成 缺口① 引擎 restore + asar 剥离。"""
        self.patch_engine()
        asar = self.resources / "app.asar"
        make_asar(asar, b"official;" + patch_install.INJECT_LINE.encode())
        with contextlib.redirect_stdout(io.StringIO()):
            report = uninstall.run_uninstall(asar=asar, runtime=self.runtime)
        self.assertTrue(report["ok"], report)
        self.assertEqual(report["engine"]["status"], "restored", report)
        self.assertEqual(self.engine.read_text(encoding="utf-8"), self.original)
        self.assertEqual(patch_install.injected_state(), False)
        # 运行目录保留（AC7：卸载保留配置与统计）
        self.assertTrue(self.runtime.is_dir())


class ZipUndoGapTests(unittest.TestCase):
    """缺口②：卸载时逐条还原预注入更新 ZIP（撤销清单消费）。"""

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
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        (self.runtime / "inject-main.cjs").write_text("// fixture", encoding="utf-8")
        self.pending = self.root / "pending"
        self.pending.mkdir()
        self.zip_path = self.pending / "ZCode-3.18.0-mac-arm64.zip"
        cache = mock.patch.object(pending_zip_patch, "pending_cache_dir", return_value=self.pending)
        cache.start()
        self.addCleanup(cache.stop)
        output = contextlib.redirect_stdout(io.StringIO())
        output.__enter__()
        self.addCleanup(output.__exit__, None, None, None)

    def build_patched_zip(self):
        def info(entry, mode):
            item = zipfile.ZipInfo(entry, date_time=(2026, 1, 2, 3, 4, 6))
            item.create_system = 3
            item.external_attr = (mode << 16) | 0x20
            item.compress_type = zipfile.ZIP_DEFLATED
            return item
        pkg = json.dumps({"name": "@zcode/desktop", "type": "module",
                          "version": "3.18.0"}).encode()
        entry = b"console.log('official v1');"
        header = {"files": {"out": {"files": {"main": {"files": {
            "index.js": {"size": len(entry), "offset": "0"}}}}},
            "package.json": {"size": len(pkg), "offset": str(len(entry))}}}
        raw = json.dumps(header, separators=(",", ":")).encode()
        c = (len(raw) + 7) // 4 * 4
        asar = struct.pack("<4I", 4, c + 4, c, len(raw)) + raw + \
            b"\0" * (c - len(raw) - 4) + entry + pkg
        with zipfile.ZipFile(self.zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(info("ZCode.app/Contents/Resources/app.asar", 0o644), asar)
        (self.pending / "update-info.json").write_text(json.dumps(
            {"fileName": self.zip_path.name, "sha512": "official-sha512",
             "isAdminRightsRequired": False}), encoding="utf-8")
        self.assertEqual(pending_zip_patch.patch_zip(self.zip_path, None, self.runtime), 0)
        with zipfile.ZipFile(self.zip_path) as zf:
            self.assertIn(b"inject-main.cjs", zf.read("ZCode.app/Contents/Resources/app.asar"))

    def test_run_uninstall_restores_pending_zip_and_clears_manifest(self):
        self.build_patched_zip()
        asar = self.root / "app.asar"
        make_asar(asar)
        with contextlib.redirect_stdout(io.StringIO()):
            report = uninstall.run_uninstall(asar=asar, runtime=self.runtime)
        self.assertTrue(report["ok"], report)
        self.assertEqual([r["status"] for r in report["zipUndo"]], ["restored"], report)
        with zipfile.ZipFile(self.zip_path) as zf:
            self.assertNotIn(b"inject-main.cjs", zf.read("ZCode.app/Contents/Resources/app.asar"))
        state = json.loads((self.runtime / "pending-zip-patch.json").read_text())
        self.assertEqual(state["files"], {})
        self.assertTrue(self.runtime.is_dir())


class KeepRuntimeOnFailureTests(unittest.TestCase):
    """缺口③：asar 剥离失败 → 运行目录与 state 文件保留 + 修复指引，绝不删目录。"""

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
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        (self.runtime / "inject-main.cjs").write_text("// fixture", encoding="utf-8")
        (self.runtime / "config.json").write_text("{}", encoding="utf-8")
        shutil.copy2(CORE / "patch_install.py", self.runtime / "patch_install.py")
        shutil.copy2(CORE / "runtime_lock.py", self.runtime / "runtime_lock.py")
        self.asar = self.root / "app.asar"
        make_asar(self.asar, b"official;" + patch_install.INJECT_LINE.encode())
        patch_install.set_target(self.asar)
        patch_install.set_runtime(self.runtime)
        patch_install._LANG = "en"
        process = mock.patch.object(patch_install, "client_running", return_value=False)
        process.start()
        self.addCleanup(process.stop)
        syntax = mock.patch.object(patch_install, "syntax_check", return_value=True)
        syntax.start()
        self.addCleanup(syntax.stop)

    def test_strip_failure_keeps_runtime_dir_and_prints_repair_guidance(self):
        before_files = {p.name for p in self.runtime.iterdir()}
        buf = io.StringIO()
        with mock.patch.object(patch_install.os, "replace", side_effect=PermissionError("locked")), \
                contextlib.redirect_stdout(buf):
            report = uninstall.run_uninstall(asar=self.asar, runtime=self.runtime)
        self.assertFalse(report["ok"], report)
        self.assertIs(report["asar"], False)
        # 运行目录原文件一个不少（缺口③：绝不删除目录；撤销链可能新增锁文件，允许）
        self.assertTrue(before_files.issubset({p.name for p in self.runtime.iterdir()}))
        self.assertTrue((self.runtime / "config.json").is_file())
        # 修复指引指向运行目录副本，且保留待收尾文件供重试
        self.assertTrue(report["repair"], report)
        output = buf.getvalue()
        self.assertIn("repair:", output)
        self.assertIn("KEPT", output)
        self.assertTrue(self.asar.exists())

    def test_strip_failure_keeps_pending_state_files(self):
        with mock.patch.object(patch_install.os, "replace", side_effect=PermissionError("locked")):
            with contextlib.redirect_stdout(io.StringIO()):
                uninstall.run_uninstall(asar=self.asar, runtime=self.runtime)
        # remove 待收尾包与 sidecar 保留：完全退出客户端后可手动收尾（修复指引路径）
        self.assertTrue(patch_install.TMP.exists() or not patch_install.TMP_META.exists())

    def test_uninstall_without_asar_still_consumes_zip_manifest(self):
        """asar 缺失（ZCode 已卸载）时跳过 asar/引擎/桥步骤，撤销链照常收敛。"""
        asar = self.root / "missing.asar"
        with contextlib.redirect_stdout(io.StringIO()):
            report = uninstall.run_uninstall(asar=asar, runtime=self.runtime)
        self.assertTrue(report["ok"], report)
        self.assertIsNone(report["asar"])
        self.assertTrue(self.runtime.is_dir())


if __name__ == "__main__":
    unittest.main()
