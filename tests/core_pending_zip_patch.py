# -*- coding: utf-8 -*-
"""pending_zip_patch（macOS pending 更新包预注入 + 撤销链）回归——移植自源仓库
tests/test_pending_zip_patch.py 并按 design §5 缺口②扩展。

覆盖：注入行写入与其它条目保留、状态命中免解压、update-info.json 竞态锚点、
陈旧缓存拒打、非 ZCode asar 拒绝、坏 zip 拒绝、幂等（已打补丁短路）、平台守卫；
新增撤销链：undo_zip 反向剥离保留元数据、undo_all 逐条还原并清空清单、
zip 缺失/无注入行的记录收敛。全程临时目录，不触碰真实 pending 缓存与 asar。
运行：python3 -m unittest tests.core_pending_zip_patch（仓库根）。
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
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


def make_asar(path, entry=b"console.log('official v1');",
              package=None):
    pkg = json.dumps(package or {"name": "@zcode/desktop", "type": "module",
                                 "version": "3.18.0"}).encode()
    header = {"files": {"out": {"files": {"main": {"files": {
        "index.js": {"size": len(entry), "offset": "0"}}}}},
        "package.json": {"size": len(pkg), "offset": str(len(entry))}}}
    raw = json.dumps(header, separators=(",", ":")).encode()
    c = (len(raw) + 7) // 4 * 4
    path.write_bytes(struct.pack("<4I", 4, c + 4, c, len(raw)) + raw +
                     b"\0" * (c - len(raw) - 4) + entry + pkg)


class PendingZipPatchTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        (self.runtime / "inject-main.cjs").write_text("// fixture", encoding="utf-8")
        self.pending = self.root / "pending"
        self.pending.mkdir()
        self.zip_path = self.pending / "ZCode-3.18.0-mac-arm64.zip"
        self.other = b"#!/bin/sh\necho hello\n"
        self.plist = b"plist-bytes"
        spec = importlib.util.spec_from_file_location(
            "pending_zip_patch_test", CORE / "pending_zip_patch.py")
        self.pzp = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.pzp)
        output = contextlib.redirect_stdout(io.StringIO())
        output.__enter__()
        self.addCleanup(output.__exit__, None, None, None)
        # 撤销链的缓存定位按测试目录：真机缓存定位函数打桩到 self.pending
        cache = mock.patch.object(self.pzp, "pending_cache_dir", return_value=self.pending)
        cache.start()
        self.addCleanup(cache.stop)

    def build_zip(self, asar_bytes, name="ZCode.app/Contents/Resources/app.asar"):
        # 显式 ZipInfo：external_attr（POSIX mode 位 + MS-DOS 标志）、create_system、
        # 压缩方式与 date_time 是 Squirrel 解包恢复权限的关键元数据，rewrite_zip 必须
        # 逐字段保留——缺执行位更新后的 app 无法启动，且无任何链路可兜底。
        def info(entry, mode, stored=False, is_dir=False):
            item = zipfile.ZipInfo(entry, date_time=(2026, 1, 2, 3, 4, 6))   # 偶数秒：DOS 时间戳 2 秒粒度
            item.create_system = 3   # unix
            item.external_attr = (mode << 16) | (0x10 if is_dir else 0x20)
            item.compress_type = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
            return item

        with zipfile.ZipFile(self.zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(info("ZCode.app/Contents/Info.plist", 0o644, stored=True), self.plist)
            zf.writestr(info(name, 0o644), asar_bytes)
            zf.writestr(info("ZCode.app/Contents/MacOS/ZCode", 0o755), self.other)
            zf.writestr(info("ZCode.app/Contents/Resources/", 0o755, is_dir=True), b"")
        self.write_update_info()
        return self.zip_path

    def write_update_info(self, file_name=None, sha512="official-sha512"):
        (self.pending / "update-info.json").write_text(json.dumps(
            {"fileName": file_name if file_name is not None else self.zip_path.name,
             "sha512": sha512, "isAdminRightsRequired": False}), encoding="utf-8")

    def official_asar(self):
        asar = self.root / "source.asar"
        make_asar(asar)
        return asar.read_bytes()

    def run_patch(self):
        return self.pzp.patch_zip(self.zip_path, None, self.runtime)

    def read_entry(self, name="ZCode.app/Contents/Resources/app.asar"):
        with zipfile.ZipFile(self.zip_path) as zf:
            return zf.read(name)

    def assert_zip_intact_except_asar(self):
        self.assertEqual(self.read_entry("ZCode.app/Contents/Info.plist"), self.plist)
        self.assertEqual(self.read_entry("ZCode.app/Contents/MacOS/ZCode"), self.other)
        expected = {
            "ZCode.app/Contents/Info.plist": (0o644 << 16) | 0x20,
            "ZCode.app/Contents/Resources/app.asar": (0o644 << 16) | 0x20,
            "ZCode.app/Contents/MacOS/ZCode": (0o755 << 16) | 0x20,
            "ZCode.app/Contents/Resources/": (0o755 << 16) | 0x10,
        }
        with zipfile.ZipFile(self.zip_path) as zf:
            for item in zf.infolist():
                self.assertEqual(item.external_attr, expected[item.filename], item.filename)
                self.assertEqual(item.compress_type,
                                 zipfile.ZIP_STORED if item.filename.endswith("Info.plist")
                                 else zipfile.ZIP_DEFLATED, item.filename)
                self.assertEqual(item.date_time, (2026, 1, 2, 3, 4, 6), item.filename)
                self.assertEqual(item.create_system, 3, item.filename)
            self.assertEqual([i.filename for i in zf.infolist() if i.is_dir()],
                             ["ZCode.app/Contents/Resources/"])

    def test_patch_adds_injection_and_keeps_entries(self):
        self.build_zip(self.official_asar())
        self.assertEqual(self.run_patch(), 0)
        self.assertIn(b"inject-main.cjs", self.read_entry())
        self.assertIn(b"[zcode-statusbar] load failed", self.read_entry())
        self.assert_zip_intact_except_asar()
        # update-info.json 绝不改动：它是宿主缓存有效性的判定依据
        info = json.loads((self.pending / "update-info.json").read_text())
        self.assertEqual(info["sha512"], "official-sha512")
        state = json.loads((self.runtime / "pending-zip-patch.json").read_text())
        record = state["files"][self.zip_path.name]
        self.assertEqual(record["sha256"], hashlib.sha256(self.zip_path.read_bytes()).hexdigest())
        self.assertEqual(record["asarVersion"], "3.18.0")

    def test_state_hit_skips_without_touching_zip(self):
        self.build_zip(self.official_asar())
        self.assertEqual(self.run_patch(), 0)
        patched = self.zip_path.read_bytes()
        with mock.patch.object(self.pzp, "patch_asar_bytes",
                               side_effect=AssertionError("must not decompress on state hit")):
            self.assertEqual(self.run_patch(), 0)
        self.assertEqual(self.zip_path.read_bytes(), patched)

    def test_update_info_anchor_drift_aborts(self):
        self.build_zip(self.official_asar())
        original = self.zip_path.read_bytes()
        update_info = self.pending / "update-info.json"
        real_rewrite = self.pzp.rewrite_zip

        def rewrite_then_host_redownload(*args, **kwargs):
            result = real_rewrite(*args, **kwargs)
            update_info.write_text('{"fileName":"other.zip","sha512":"new"}')  # 宿主重下会重写 json
            return result

        with mock.patch.object(self.pzp, "rewrite_zip",
                               side_effect=rewrite_then_host_redownload):
            self.assertEqual(self.run_patch(), 1)
        self.assertEqual(self.zip_path.read_bytes(), original)

    def test_stale_cache_file_name_refused(self):
        self.build_zip(self.official_asar())
        original = self.zip_path.read_bytes()
        self.write_update_info(file_name="ZCode-3.19.0-mac-arm64.zip")
        self.assertEqual(self.run_patch(), 1)
        self.assertEqual(self.zip_path.read_bytes(), original)
        self.assertFalse((self.runtime / "pending-zip-patch.json").exists())

    def test_non_zcode_asar_refused(self):
        asar = self.root / "foreign.asar"
        make_asar(asar, package={"name": "someone-else", "type": "module", "version": "1.0"})
        self.build_zip(asar.read_bytes())
        original = self.zip_path.read_bytes()
        self.assertEqual(self.run_patch(), 1)
        self.assertEqual(self.zip_path.read_bytes(), original)

    def test_missing_asar_entry_refused(self):
        with zipfile.ZipFile(self.zip_path, "w") as zf:
            zf.writestr("ZCode.app/Contents/Info.plist", self.plist)
        self.write_update_info()
        self.assertEqual(self.run_patch(), 1)

    def test_corrupt_zip_refused(self):
        self.zip_path.write_bytes(b"PK\x03\x04 truncated garbage")
        self.write_update_info()
        original = self.zip_path.read_bytes()
        self.assertEqual(self.run_patch(), 1)
        self.assertEqual(self.zip_path.read_bytes(), original)

    def test_already_patched_zip_short_circuits(self):
        asar = self.root / "source.asar"
        make_asar(asar)
        self.build_zip(asar.read_bytes())
        self.assertEqual(self.run_patch(), 0)
        entry = self.read_entry()
        # 状态清掉后重跑：内容判定路径也必须判已打，且不再改 zip
        (self.runtime / "pending-zip-patch.json").unlink()
        with zipfile.ZipFile(self.zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("ZCode.app/Contents/Info.plist", self.plist)
            zf.writestr("ZCode.app/Contents/Resources/app.asar", entry)
            zf.writestr("ZCode.app/Contents/MacOS/ZCode", self.other)
        self.write_update_info()
        before = self.zip_path.read_bytes()
        with mock.patch.object(self.pzp, "rewrite_zip",
                               side_effect=AssertionError("already-patched must not rewrite")):
            self.assertEqual(self.run_patch(), 0)
        self.assertEqual(self.zip_path.read_bytes(), before)
        state = json.loads((self.runtime / "pending-zip-patch.json").read_text())
        self.assertIn(self.zip_path.name, state["files"])

    def test_main_platform_guard(self):
        self.build_zip(self.official_asar())
        original = self.zip_path.read_bytes()
        with mock.patch.object(self.pzp.sys, "platform", "win32"), \
                mock.patch.object(self.pzp, "patch_zip",
                                  side_effect=AssertionError("win32 must not patch")) as guard:
            self.assertEqual(self.pzp.main(["--zip", str(self.zip_path),
                                            "--runtime", str(self.runtime)]), 0)
        guard.assert_not_called()
        self.assertEqual(self.zip_path.read_bytes(), original)

    # ---------- 撤销链（design §5 缺口②）----------

    def test_undo_zip_strips_injection_and_keeps_metadata(self):
        self.build_zip(self.official_asar())
        self.assertEqual(self.run_patch(), 0)
        self.assertIn(b"inject-main.cjs", self.read_entry())
        result = self.pzp.undo_zip(self.zip_path, self.runtime)
        self.assertEqual(result["status"], "restored", result)
        self.assertNotIn(b"inject-main.cjs", self.read_entry())
        self.assert_zip_intact_except_asar()   # 元数据逐字段保留（权限/压缩/日期）
        info = json.loads((self.pending / "update-info.json").read_text())
        self.assertEqual(info["sha512"], "official-sha512")

    def test_undo_all_restores_every_patched_zip_and_clears_manifest(self):
        first = self.build_zip(self.official_asar())
        self.assertEqual(self.run_patch(), 0)
        second = self.pending / "ZCode-3.19.0-mac-arm64.zip"
        old = self.zip_path
        self.zip_path = second
        self.build_zip(self.official_asar())
        self.assertEqual(self.run_patch(), 0)
        self.zip_path = old
        self.assertIn(b"inject-main.cjs", self.pzp and zipfile.ZipFile(first).read(
            "ZCode.app/Contents/Resources/app.asar"))
        results = self.pzp.undo_all(self.runtime)
        self.assertEqual([r["status"] for r in results], ["restored", "restored"], results)
        with zipfile.ZipFile(first) as zf:
            self.assertNotIn(b"inject-main.cjs", zf.read("ZCode.app/Contents/Resources/app.asar"))
        with zipfile.ZipFile(second) as zf:
            self.assertNotIn(b"inject-main.cjs", zf.read("ZCode.app/Contents/Resources/app.asar"))
        # 清单已消费清空：重复 undo 是 no-op
        self.assertEqual(self.pzp.undo_all(self.runtime), [])
        state = json.loads((self.runtime / "pending-zip-patch.json").read_text())
        self.assertEqual(state["files"], {})

    def test_undo_missing_zip_only_drops_record(self):
        self.build_zip(self.official_asar())
        self.assertEqual(self.run_patch(), 0)
        self.zip_path.unlink()
        results = self.pzp.undo_all(self.runtime)
        self.assertEqual(results[0]["status"], "missing")
        state = json.loads((self.runtime / "pending-zip-patch.json").read_text())
        self.assertEqual(state["files"], {})

    def test_undo_zip_without_injection_line_is_absent(self):
        self.build_zip(self.official_asar())
        self.assertEqual(self.run_patch(), 0)
        results = self.pzp.undo_all(self.runtime)   # 先正常还原一次
        self.assertEqual(results[0]["status"], "restored")
        # 手动把 zip 放回清单（模拟记录与实际状态漂移）：无注入行按 absent 收敛
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.pzp.patch_zip(self.zip_path, None, self.runtime), 0)
        results = self.pzp.undo_all(self.runtime)
        self.assertEqual(results[0]["status"], "restored")
        # 再造一个从未打过补丁的 zip 并塞进清单
        clean = self.pending / "ZCode-3.20.0-mac-arm64.zip"
        old = self.zip_path
        self.zip_path = clean
        self.build_zip(self.official_asar())
        self.zip_path = old
        with mock.patch.object(self.pzp, "load_state", return_value={
                "version": 1, "files": {clean.name: {"sha256": "0" * 64}}}):
            results = self.pzp.undo_all(self.runtime)
        self.assertEqual(results[0]["status"], "absent", results)
        self.assertNotIn(b"inject-main.cjs", zipfile.ZipFile(clean).read(
            "ZCode.app/Contents/Resources/app.asar"))

    def test_undo_anchor_drift_keeps_original_zip(self):
        self.build_zip(self.official_asar())
        self.assertEqual(self.run_patch(), 0)
        original = self.zip_path.read_bytes()
        update_info = self.pending / "update-info.json"
        real_rewrite = self.pzp.rewrite_zip

        def rewrite_then_host_redownload(*args, **kwargs):
            result = real_rewrite(*args, **kwargs)
            update_info.write_text('{"fileName":"other.zip","sha512":"new"}')
            return result

        with mock.patch.object(self.pzp, "rewrite_zip",
                               side_effect=rewrite_then_host_redownload):
            result = self.pzp.undo_zip(self.zip_path, self.runtime)
        self.assertEqual(result["status"], "skipped", result)
        self.assertEqual(self.zip_path.read_bytes(), original)

    def test_undo_main_platform_guard_not_applicable(self):
        """--undo-all 不受 darwin 平台守卫（清单可能来自备份迁移等场景）。"""
        self.build_zip(self.official_asar())
        self.assertEqual(self.run_patch(), 0)
        with mock.patch.object(self.pzp.sys, "platform", "win32"):
            self.assertEqual(self.pzp.main(["--undo-all", "--runtime", str(self.runtime)]), 0)
        self.assertNotIn(b"inject-main.cjs", self.read_entry())


if __name__ == "__main__":
    unittest.main()
