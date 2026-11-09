# -*- coding: utf-8 -*-
"""ZIP 预注入撤销链补充回归（A-fin，design §5 缺口②）。

前序 tests/core_pending_zip_patch.py 已覆盖 undo_zip/undo_all 主链（还原/缺失/absent/
锚点漂移/--undo-all 平台守卫）；本文件补四个增量面：
  * 哈希漂移审计：记录 sha256 与 zip 实际不符时按内容判定还原并在报告标 hashDrifted
    （哈希不匹配不做硬门，内容判定更可靠——官方重下的包必无注入行，absent 收敛）；
  * zipPath 定位：清单记录预注入时的 zip 绝对路径，zip 被移动后仍可还原（跨运行目录
    消费迁移清单的场景）；
  * patch→undo→patch 往返幂等：还原产物可再次预注入，行为与首次一致；
  * --undo-all CLI 合同：stdout 输出报告 JSON、error/skipped 时退出码 1。
全部在临时目录模拟 pending 缓存，不触碰真实缓存与 asar。
运行：python3 -m unittest tests.core_pending_zip_undo_extra（仓库根）。
"""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
import zipfile
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "core"
if str(CORE) not in sys.path:
    sys.path.insert(0, str(CORE))

spec = importlib.util.spec_from_file_location("pzp_undo_extra", CORE / "pending_zip_patch.py")
pzp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pzp)


def make_asar_bytes(entry=b"console.log('official v1');"):
    pkg = json.dumps({"name": "@zcode/desktop", "type": "module",
                      "version": "3.18.0"}).encode()
    header = {"files": {"out": {"files": {"main": {"files": {
        "index.js": {"size": len(entry), "offset": "0"}}}}},
        "package.json": {"size": len(pkg), "offset": str(len(entry))}}}
    raw = json.dumps(header, separators=(",", ":")).encode()
    c = (len(raw) + 7) // 4 * 4
    return struct.pack("<4I", 4, c + 4, c, len(raw)) + raw + \
        b"\0" * (c - len(raw) - 4) + entry + pkg


class PendingZipUndoExtraTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        (self.runtime / "inject-main.cjs").write_text("// fixture", encoding="utf-8")
        self.pending = self.root / "pending"
        self.pending.mkdir()
        self.zip_path = self.pending / "ZCode-3.18.0-mac-arm64.zip"
        cache = mock.patch.object(pzp, "pending_cache_dir", return_value=self.pending)
        cache.start()
        self.addCleanup(cache.stop)
        output = contextlib.redirect_stdout(io.StringIO())
        output.__enter__()
        self.addCleanup(output.__exit__, None, None, None)

    def build_zip(self, path=None):
        target = Path(path) if path else self.zip_path
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("ZCode.app/Contents/Info.plist", b"plist")
            zf.writestr("ZCode.app/Contents/Resources/app.asar", make_asar_bytes())
            zf.writestr("ZCode.app/Contents/MacOS/ZCode", b"#!/bin/sh\n")
        (target.parent / "update-info.json").write_text(json.dumps(
            {"fileName": target.name, "sha512": "official-sha512"}), encoding="utf-8")
        return target

    def entry_of(self, path=None):
        with zipfile.ZipFile(Path(path) if path else self.zip_path) as zf:
            return zf.read("ZCode.app/Contents/Resources/app.asar")

    def patch(self, path=None):
        return pzp.patch_zip(Path(path) if path else self.zip_path, None, self.runtime)

    def test_hash_drift_with_injection_line_still_restores_and_marks_report(self):
        """记录哈希漂移（zip 被手动重打包）但有注入行：按内容判定还原并标 hashDrifted。"""
        self.build_zip()
        self.patch()
        state_path = self.runtime / "pending-zip-patch.json"
        state = json.loads(state_path.read_text())
        state["files"][self.zip_path.name]["sha256"] = "0" * 64   # 漂移：与实际 zip 不符
        state_path.write_text(json.dumps(state))
        result = pzp.undo_all(self.runtime)
        self.assertEqual([r["status"] for r in result], ["restored"], result)
        self.assertTrue(result[0]["hashDrifted"], result)
        self.assertNotIn(b"inject-main.cjs", self.entry_of())

    def test_hash_drift_without_injection_line_converges_absent(self):
        """哈希不匹配且无注入行（官方重下覆盖）：不还原（跳过）、按 absent 收敛记录。"""
        self.build_zip()
        state_path = self.runtime / "pending-zip-patch.json"
        state_path.write_text(json.dumps(
            {"version": 1, "files": {self.zip_path.name: {"sha256": "0" * 64}}}))
        result = pzp.undo_all(self.runtime)
        self.assertEqual([r["status"] for r in result], ["absent"], result)
        self.assertTrue(result[0]["hashDrifted"], result)
        self.assertNotIn(b"inject-main.cjs", self.entry_of())   # 原 zip 一字未动

    def test_record_zip_path_locates_moved_zip(self):
        """清单在运行目录、zip 在记录的 zipPath（缓存目录迁移场景）：按记录定位还原。"""
        moved = self.root / "elsewhere" / "ZCode-3.18.0-mac-arm64.zip"
        moved.parent.mkdir()
        self.build_zip(moved)
        self.patch(moved)
        # 清单里写入记录：zipPath 指向 moved（正常 patch 已记录；显式覆盖确保场景成立）
        state_path = self.runtime / "pending-zip-patch.json"
        state = json.loads(state_path.read_text())
        record = state["files"].pop(moved.name)
        record["zipPath"] = str(moved)
        state["files"][moved.name] = record
        state_path.write_text(json.dumps(state))
        # pending 缓存定位指向空目录：仅靠 zipPath 也必须找到
        with mock.patch.object(pzp, "pending_cache_dir", return_value=self.root / "empty"):
            result = pzp.undo_all(self.runtime)
        self.assertEqual([r["status"] for r in result], ["restored"], result)
        self.assertNotIn(b"inject-main.cjs", self.entry_of(moved))

    def test_patch_undo_patch_round_trip_is_idempotent(self):
        """patch→undo→patch 往返：还原产物可再次预注入，两次 patch 的注入行一致。"""
        self.build_zip()
        self.assertEqual(self.patch(), 0)
        patched_entry = self.entry_of()
        self.assertEqual(pzp.undo_zip(self.zip_path, self.runtime)["status"], "restored")
        undone_entry = self.entry_of()
        self.assertNotIn(b"inject-main.cjs", undone_entry)
        undone_sha = pzp.sha256_of(self.zip_path)
        self.assertEqual(self.patch(), 0)
        self.assertEqual(self.entry_of(), patched_entry)
        # 重新打补丁后清单回到已记录状态（undo 消费过的记录重建，originalSha256 审计正确）
        state = json.loads((self.runtime / "pending-zip-patch.json").read_text())
        record = state["files"][self.zip_path.name]
        self.assertEqual(record["entry"], "ZCode.app/Contents/Resources/app.asar")
        self.assertEqual(record["originalSha256"], undone_sha)

    def test_undo_all_cli_exit_code_and_json_report(self):
        """--undo-all CLI 合同：报告走 stdout JSON；有 error/skipped 退 1，全收敛退 0。"""
        self.build_zip()
        self.patch()
        with contextlib.redirect_stdout(io.StringIO()) as out:
            code_ok = pzp.main(["--undo-all", "--runtime", str(self.runtime)])
        reports = json.loads(out.getvalue().strip().splitlines()[-1])
        self.assertEqual(code_ok, 0)
        self.assertEqual([r["status"] for r in reports], ["restored"])
        # 不可读 zip 记录：error 报告 + 退出码 1
        bad = self.pending / "ZCode-3.19.0-mac-arm64.zip"
        bad.write_bytes(b"PK\x03\x04 truncated garbage")
        state_path = self.runtime / "pending-zip-patch.json"
        state_path.write_text(json.dumps(
            {"version": 1, "files": {bad.name: {"sha256": "0" * 64,
                                                "zipPath": str(bad)}}}))
        with contextlib.redirect_stdout(io.StringIO()) as out:
            code_bad = pzp.main(["--undo-all", "--runtime", str(self.runtime)])
        reports = json.loads(out.getvalue().strip().splitlines()[-1])
        self.assertEqual(code_bad, 1)
        self.assertEqual(reports[0]["status"], "error")
        self.assertTrue(bad.exists())   # 原包保留，不做半还原


if __name__ == "__main__":
    unittest.main()
