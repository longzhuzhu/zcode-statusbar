# -*- coding: utf-8 -*-
"""patch_install.py（asar 注入/剥离内核）回归——移植自源仓库 tests/test_pending_asar.py。

覆盖场景：安装竞态（来源在 repack 前后变化即拒）、待收尾包指纹/语法校验、运行中排定
与退出收尾、权限保留（stage 继承属主与 mode）、跨目标隔离、孤儿 stage 清扫、
可复用待收尾包、降级覆盖阻止、CLI 退出码。全部在临时目录模拟，不触碰真实安装。

相对源测试的差异：加载路径 core/patch_install.py；改名后断言
（STATUSBAR_LINE_RE、app.asar.zcstatusbar.tmp.json、"[zcode-statusbar]" 标记）。
运行：python3 -m unittest tests.core_pending_asar（仓库根）。
"""
import contextlib
import ctypes
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "core"
if str(CORE) not in sys.path:
    sys.path.insert(0, str(CORE))


def make_asar(path, entry=b"console.log('official v1');"):
    header = {"files": {"out": {"files": {"main": {"files": {
        "index.js": {"size": len(entry), "offset": "0"}
    }}}}}}
    raw = json.dumps(header, separators=(",", ":")).encode()
    c = (len(raw) + 7) // 4 * 4
    path.write_bytes(struct.pack("<4I", 4, c + 4, c, len(raw)) + raw +
                     b"\0" * (c - len(raw) - 4) + entry)


class PendingAsarTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.home = self.root / "home"
        self.home.mkdir()
        env = mock.patch.dict(os.environ, {"HOME": str(self.home), "USERPROFILE": str(self.home),
                                           "ZCODE_STATUSBAR_NO_MONITOR": "1",
                                           "ZCODE_STATUSBAR_MONITOR_QUIET": ""})
        env.start()
        self.addCleanup(env.stop)
        spec = importlib.util.spec_from_file_location("pending_patch_test", CORE / "patch_install.py")
        self.pi = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.pi)
        self.asar = self.root / "app.asar"
        make_asar(self.asar)
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        (self.runtime / "inject-main.cjs").write_text("// fixture", encoding="utf-8")
        self.pi.set_target(self.asar)
        self.pi.set_runtime(self.runtime)
        self.pi._LANG = "en"
        output = contextlib.redirect_stdout(io.StringIO())
        output.__enter__()
        self.addCleanup(output.__exit__, None, None, None)
        process = mock.patch.object(self.pi, "client_running", return_value=False)
        process.start()
        self.addCleanup(process.stop)
        syntax = mock.patch.object(self.pi, "syntax_check", return_value=True)
        syntax.start()
        self.addCleanup(syntax.stop)

    def prepare(self, operation="install"):
        entry = self.pi.entry_bytes_of(self.asar)
        new = self.pi.STATUSBAR_LINE_RE.sub(b"", entry)
        if operation == "install":
            new += self.pi.INJECT_LINE.encode()
        return self.pi.prepare_tmp({"/" + self.pi.ENTRY: new}, operation)

    def upgrade_asar(self, entry=b"console.log('official v2');"):
        """写入"官方升级版"并强制 mtime 前移：升级模拟必须能被 _same_stamp 的 stat 级
        检测发现（同尺寸替换会逃过惰性批更新的卷）。真实升级相隔分钟级不受影响，
        这里用显式 utime 换确定性；余量取 2s 以覆盖最粗的 FAT32 mtime 粒度。"""
        make_asar(self.asar, entry)
        st = self.asar.stat()
        os.utime(self.asar, ns=(st.st_atime_ns, st.st_mtime_ns + 2_000_000_000))

    def test_generation_records_source_before_repack_and_atomic_sidecar(self):
        source = self.asar.read_bytes()
        observations = []
        repack = self.pi.repack
        def observe(src, modify, dst):
            self.assertFalse(self.pi.TMP_META.exists())
            observations.append(self.asar.stat().st_mtime_ns)
            return repack(src, modify, dst)
        with mock.patch.object(self.pi, "repack", side_effect=observe), \
                mock.patch.object(self.pi.os, "replace", wraps=self.pi.os.replace) as replace:
            self.prepare()
        meta = json.loads(self.pi.TMP_META.read_text())
        self.assertEqual(meta["source"]["sha256"], hashlib.sha256(source).hexdigest())
        self.assertEqual(meta["source"]["mtime_ns"], observations[0])
        self.assertEqual(meta["tmp"]["sha256"], hashlib.sha256(self.pi.TMP.read_bytes()).hexdigest())
        self.assertEqual(meta["asar"], str(self.asar.resolve()))
        self.assertEqual(meta["operation"], "install")
        self.assertEqual(meta["version"], 1)
        self.assertEqual(self.pi.TMP_META.name, "app.asar.zcstatusbar.tmp.json")
        self.assertEqual(Path(replace.call_args.args[1]), self.pi.TMP_META)
        self.assertNotEqual(Path(replace.call_args.args[0]), self.pi.TMP_META)

    def test_upgrade_during_repack_never_replaces_source(self):
        repack = self.pi.repack
        def upgrade(src, modify, dst):
            result = repack(src, modify, dst)
            self.upgrade_asar()
            return result
        with mock.patch.object(self.pi, "repack", side_effect=upgrade), \
                mock.patch.object(self.pi.os, "replace") as replace:
            self.assertFalse(self.pi.install())
        replace.assert_not_called()
        self.assertIn(b"official v2", self.pi.entry_bytes_of(self.asar))
        self.assertFalse(self.pi.TMP_META.exists())

    def test_upgrade_between_entry_read_and_repack_is_rejected(self):
        read = self.pi.entry_bytes_of
        def upgrade(path):
            entry = read(path)
            self.upgrade_asar()
            return entry
        with mock.patch.object(self.pi, "entry_bytes_of", side_effect=upgrade), \
                mock.patch.object(self.pi, "repack") as repack:
            self.assertFalse(self.pi.install())
        repack.assert_not_called()

    def test_finalize_consumes_existing_tmp_without_repacking(self):
        self.prepare()
        with mock.patch.object(self.pi, "repack", side_effect=AssertionError("must not repack")):
            self.assertTrue(self.pi.install(finalize=True))
        self.assertTrue(self.pi.self_check(self.asar))
        self.assertFalse(self.pi.TMP.exists())
        self.assertFalse(self.pi.TMP_META.exists())

    def test_finalize_rejects_upgrade_and_keeps_diagnostic_files(self):
        self.prepare()
        self.upgrade_asar()
        with mock.patch.object(self.pi, "repack") as repack:
            self.assertFalse(self.pi.install(finalize=True))
        repack.assert_not_called()
        self.assertIn(b"official v2", self.pi.entry_bytes_of(self.asar))
        self.assertTrue(self.pi.TMP.exists())
        self.assertTrue(self.pi.TMP_META.exists())

    def test_finalize_requires_client_exit_even_when_os_allows_rename(self):
        self.prepare()
        with mock.patch.object(self.pi, "client_running", return_value=True), \
                mock.patch.object(self.pi.os, "replace") as replace:
            self.assertFalse(self.pi.install(finalize=True))
        replace.assert_not_called()

    def test_finalize_rejects_tampered_tmp_and_same_mtime_source(self):
        for target in (self.pi.TMP, self.asar):
            with self.subTest(target=target):
                self.pi.TMP.unlink(missing_ok=True)
                self.pi.TMP_META.unlink(missing_ok=True)
                make_asar(self.asar)
                self.prepare()
                stamp = target.stat()
                raw = bytearray(target.read_bytes())
                raw[-1] ^= 1
                target.write_bytes(raw)
                os.utime(target, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
                with mock.patch.object(self.pi.os, "replace") as replace:
                    self.assertFalse(self.pi.install(finalize=True))
                replace.assert_not_called()

    def test_hash_check_rejects_changed_content_even_with_forged_stat_metadata(self):
        self.prepare()
        raw = bytearray(self.pi.TMP.read_bytes())
        raw[-1] ^= 1
        self.pi.TMP.write_bytes(raw)
        meta = json.loads(self.pi.TMP_META.read_text())
        meta["tmp"].update(self.pi.file_stamp(self.pi.TMP))
        self.pi.TMP_META.write_text(json.dumps(meta))
        with self.assertRaises(self.pi.PendingTmpError):
            self.pi.finalize_tmp()
        self.assertTrue(self.pi.TMP.exists())

    def test_self_check_and_last_source_stat_are_required_before_replace(self):
        self.prepare()
        check = self.pi.self_check
        def upgrade(path, expect=True):
            result = check(path, expect=expect)
            self.upgrade_asar()
            return result
        with mock.patch.object(self.pi, "self_check", side_effect=upgrade), \
                mock.patch.object(self.pi.os, "replace") as replace:
            with self.assertRaises(self.pi.PendingTmpError):
                self.pi.finalize_tmp()
        replace.assert_not_called()

    def test_target_change_does_not_consume_another_installation_tmp(self):
        self.prepare()
        other = self.root / "other"
        other.mkdir()
        other_asar = other / "app.asar"
        make_asar(other_asar)
        (other / self.pi.TMP.name).write_bytes(self.pi.TMP.read_bytes())
        (other / self.pi.TMP_META.name).write_bytes(self.pi.TMP_META.read_bytes())
        self.pi.set_target(other_asar)
        with mock.patch.object(self.pi.os, "replace") as replace:
            self.assertFalse(self.pi.install(finalize=True))
        replace.assert_not_called()
        self.assertNotIn(b"inject-main.cjs", self.pi.entry_bytes_of(other_asar))

    def test_injection_marker_is_plugin_scoped(self):
        """共存隔离：原插件（[zusage] 标记）的注入行不被本插件的识别正则命中，
        本插件注入行也含插件专属标记——两个插件共存时互不误剥对方注入行。"""
        legacy_line = ('\n;import("file:///old/inject-main.cjs").then(() => null, '
                       '(e) => console.error("[zusage] load failed", e));').encode()
        make_asar(self.asar, b"official;" + legacy_line)
        self.assertFalse(self.pi.injected_state())
        self.assertTrue(self.pi.install())
        entry = self.pi.entry_bytes_of(self.asar)
        self.assertIn(b"[zcode-statusbar] load failed", entry)
        self.assertIn(b"[zusage] load failed", entry)   # 原插件注入行原样保留
        self.assertTrue(self.pi.remove())
        entry = self.pi.entry_bytes_of(self.asar)
        self.assertNotIn(b"[zcode-statusbar] load failed", entry)
        self.assertIn(b"[zusage] load failed", entry)   # 卸载只剥自己的注入行

    def test_remove_cancels_pending_install_even_if_target_is_not_injected(self):
        self.prepare()
        old_tmp = self.pi.TMP.read_bytes()
        self.assertTrue(self.pi.remove())
        meta = json.loads(self.pi.TMP_META.read_text())
        self.assertEqual(meta["operation"], "cancelled")
        self.assertEqual(self.pi.TMP.read_bytes(), old_tmp)
        with self.assertRaises(self.pi.PendingTmpError):
            self.pi.finalize_tmp()
        self.assertNotIn(b"inject-main.cjs", self.pi.entry_bytes_of(self.asar))

    def capture_publish_journal(self):
        """真实 _publish_pending 的 journal 中间态：拦截 _atomic_tmp_metadata 抓到
        cancelled+publishing 形态；发布照常完成后返回 (journal, 终版 meta)。"""
        seen = []
        real = self.pi._atomic_tmp_metadata
        def observe(meta):
            seen.append(dict(meta))
            return real(meta)
        with mock.patch.object(self.pi, "_atomic_tmp_metadata", side_effect=observe):
            self.prepare()
        self.assertEqual(len(seen), 2)
        journal, final = seen
        self.assertEqual(journal["operation"], "cancelled")
        self.assertTrue(journal.get("publishing"))
        return journal, final

    def test_publishing_journal_is_transient_busy_not_hard_cancel(self):
        journal, final = self.capture_publish_journal()
        self.pi._atomic_tmp_metadata(journal)
        with self.assertRaises(self.pi.PendingTmpBusy) as ctx:
            self.pi.pending_tmp(operation=None)
        self.assertIsInstance(ctx.exception, self.pi.PendingTmpError)
        self.assertEqual(self.pi.pending_operation(), "cancelled")
        self.pi._atomic_tmp_metadata(final)
        self.pi.pending_tmp(operation=None)   # 发布完成：不再 Busy（不抛即通过）

    def test_settled_cancelled_sidecar_stays_hard_cancel(self):
        self.prepare()
        meta = json.loads(self.pi.TMP_META.read_text())
        meta["operation"] = "cancelled"
        self.pi._atomic_tmp_metadata(meta)
        with self.assertRaises(self.pi.PendingTmpError) as ctx:
            self.pi.pending_tmp(operation=None)
        self.assertNotIsInstance(ctx.exception, self.pi.PendingTmpBusy)

    def test_remove_on_injected_target_replaces_only_with_remove_package(self):
        make_asar(self.asar, b"official;" + self.pi.INJECT_LINE.encode())
        self.prepare()
        with mock.patch.object(self.pi.os, "replace", side_effect=PermissionError("locked")):
            self.assertFalse(self.pi.remove())
        self.assertTrue(self.pi.remove())
        self.assertNotIn(b"inject-main.cjs", self.pi.entry_bytes_of(self.asar))
        self.assertFalse(self.pi.TMP.exists())

    def test_unknown_tmp_is_neither_installed_deleted_nor_overwritten(self):
        self.pi.TMP.write_bytes(b"user data")
        self.assertFalse(self.pi.install())
        self.assertFalse(self.pi.install(finalize=True))
        self.assertTrue(self.pi.remove())
        self.assertEqual(self.pi.TMP.read_bytes(), b"user data")
        self.assertFalse(self.pi.TMP_META.exists())

    def test_remove_pending_can_be_finalized_but_install_finalize_rejects_it(self):
        make_asar(self.asar, b"official;" + self.pi.INJECT_LINE.encode())
        replace = self.pi.os.replace
        def locked(src, dst):
            if Path(src) == self.pi.TMP:
                raise PermissionError("locked")
            return replace(src, dst)
        with mock.patch.object(self.pi.os, "replace", side_effect=locked):
            self.assertFalse(self.pi.remove())
        self.assertEqual(json.loads(self.pi.TMP_META.read_text())["operation"], "remove")
        self.assertFalse(self.pi.install(finalize=True))
        self.assertTrue(self.pi.finalize_tmp(operation=None))
        self.assertFalse(self.pi.STATUSBAR_LINE_RE.search(self.pi.entry_bytes_of(self.asar)))

    def test_remove_self_check_rejects_injection_from_another_runtime(self):
        other = (self.root / "other-runtime" / "inject-main.cjs").as_uri()
        old_injection = self.pi.INJECT_LINE_TMPL.format(url=other).encode()
        make_asar(self.asar, b"official;" + old_injection)
        source = self.pi.source_fingerprint(self.asar)
        self.pi.TMP.write_bytes(self.asar.read_bytes())
        with self.assertRaises(self.pi.PendingTmpError):
            self.pi.write_tmp_metadata(source, operation="remove")
        with self.assertRaises(self.pi.PendingTmpError):
            self.pi.finalize_tmp(operation=None)
        self.assertTrue(self.pi.TMP.exists())

    def test_unknown_sidecar_is_not_taken_over(self):
        self.pi.TMP_META.write_text('{"user":"data"}')
        self.assertFalse(self.pi.install())
        self.assertFalse(self.pi.remove())
        self.assertEqual(self.pi.TMP_META.read_text(), '{"user":"data"}')

    def test_symlink_tmp_is_not_taken_over(self):
        # macOS/Linux 普通用户可建 symlink；Windows 需特权时跳过（与源测试同守卫）
        try:
            probe = self.root / "symlink-probe"
            probe.write_text("x")
            link = self.root / "symlink-probe-link"
            link.symlink_to(probe)
            link.unlink()
        except (OSError, NotImplementedError):
            self.skipTest("os.symlink requires privileges on this platform")
        self.pi.TMP_META.unlink(missing_ok=True)
        user_file = self.root / "user-data"
        user_file.write_bytes(b"user content")
        self.pi.TMP.symlink_to(user_file)
        self.assertFalse(self.pi.install())
        self.assertEqual(user_file.read_bytes(), b"user content")
        self.assertTrue(self.pi.TMP.is_symlink())

    @unittest.skipIf(os.name == "nt", "POSIX permissions")
    def test_stage_install_and_remove_preserve_asar_mode_and_owner(self):
        self.asar.chmod(0o644)
        before = self.asar.stat()
        self.assertTrue(self.pi.install())
        for after in (self.asar.stat(),):
            self.assertEqual(stat.S_IMODE(after.st_mode), 0o644)
            self.assertEqual((after.st_uid, after.st_gid), (before.st_uid, before.st_gid))
        self.assertTrue(self.pi.remove())
        after = self.asar.stat()
        self.assertEqual(stat.S_IMODE(after.st_mode), 0o644)
        self.assertEqual((after.st_uid, after.st_gid), (before.st_uid, before.st_gid))

    def test_failed_install_syntax_cannot_be_manually_finalized(self):
        original = self.asar.read_bytes()
        with mock.patch.object(self.pi, "syntax_check", return_value=False):
            self.assertFalse(self.pi.install())
        self.assertFalse(self.pi.install(finalize=True))
        self.assertEqual(self.asar.read_bytes(), original)
        self.assertFalse(self.pi.TMP.exists())
        self.assertFalse(self.pi.TMP_META.exists())
        self.assertTrue(self.pi.install())

    def test_failed_remove_syntax_cannot_be_finalized(self):
        make_asar(self.asar, b"official;" + self.pi.INJECT_LINE.encode())
        original = self.asar.read_bytes()
        with mock.patch.object(self.pi, "syntax_check", return_value=False):
            self.assertFalse(self.pi.remove())
        with self.assertRaises(self.pi.PendingTmpError):
            self.pi.finalize_tmp(operation=None)
        self.assertEqual(self.asar.read_bytes(), original)
        self.assertTrue(self.pi.remove())

    def test_partial_repack_failure_can_retry_without_orphan_tmp(self):
        def partial(src, modify, dst):
            self.assertNotEqual(dst, self.pi.TMP)
            Path(dst).write_bytes(b"partial package")
            raise OSError("disk full")
        with mock.patch.object(self.pi, "repack", side_effect=partial):
            self.assertFalse(self.pi.install())
        self.assertFalse(self.pi.TMP.exists())
        self.assertFalse(self.pi.TMP_META.exists())
        self.assertEqual(list(self.root.glob(self.pi.TMP.name + ".*.stage")), [])
        self.assertTrue(self.pi.install())

    def test_stale_orphan_stage_is_swept_by_next_prepare(self):
        orphan = self.root / (self.pi.TMP.name + ".k7h8e75u.stage")
        orphan.write_bytes(b"orphan")
        old = time.time() - self.pi.STALE_STAGE_SECONDS - 60
        os.utime(orphan, (old, old))
        self.prepare()
        self.assertFalse(orphan.exists())

    def test_fresh_stage_survives_next_prepare(self):
        """移交窗口保护：早于阈值的新 stage 绝不删除——它可能是刚崩溃进程的未移交包。"""
        fresh = self.root / (self.pi.TMP.name + ".fresh123.stage")
        fresh.write_bytes(b"fresh")
        self.prepare()
        self.assertTrue(fresh.exists())
        fresh.unlink()

    def test_stale_orphan_stage_is_swept_even_when_publish_is_rejected(self):
        orphan = self.root / (self.pi.TMP.name + ".orphan.stage")
        orphan.write_bytes(b"orphan")
        old = time.time() - self.pi.STALE_STAGE_SECONDS - 60
        os.utime(orphan, (old, old))
        garbage = self.root / ".zcstatusbar-bridge-garbage.stage"
        garbage.write_bytes(b"not an asar")
        with self.assertRaises(self.pi.PendingTmpError):
            self.pi.publish_external_pending(garbage)
        self.assertFalse(orphan.exists())
        self.assertFalse(garbage.exists())

    def test_sweep_never_touches_pending_pair_even_when_stale(self):
        """在途 pending 对（TMP/TMP_META）必须永不被清扫：sidecar 无 .stage 后缀、
        真实场景会老化超阈值（用户长时间不重启）。"""
        self.prepare()
        old = time.time() - self.pi.STALE_STAGE_SECONDS - 60
        os.utime(self.pi.TMP_META, (old, old))
        self.prepare()
        self.assertTrue(self.pi.TMP_META.exists(), "在途 pending 元数据不得被清扫")
        self.assertTrue(self.pi.TMP.exists())

    def test_partial_repack_preserves_previous_owned_pending_pair(self):
        self.prepare()
        before = (self.pi.TMP.read_bytes(), self.pi.TMP_META.read_bytes())
        def partial(src, modify, dst):
            Path(dst).write_bytes(b"half-written")
            raise OSError("disk full")
        with mock.patch.object(self.pi, "repack", side_effect=partial), \
                mock.patch.object(self.pi, "_reusable_pending_install", return_value=False):
            self.assertFalse(self.pi.install())
        self.assertEqual((self.pi.TMP.read_bytes(), self.pi.TMP_META.read_bytes()), before)
        self.assertTrue(self.pi.install())

    def test_upgrade_during_repack_can_retry_against_new_source(self):
        repack = self.pi.repack
        def upgrade(src, modify, dst):
            repack(src, modify, dst)
            self.upgrade_asar()
        with mock.patch.object(self.pi, "repack", side_effect=upgrade):
            self.assertFalse(self.pi.install())
        self.assertFalse(self.pi.TMP.exists())
        self.assertFalse(self.pi.TMP_META.exists())
        self.assertTrue(self.pi.install())
        self.assertIn(b"official v2", self.pi.entry_bytes_of(self.asar))

    def test_sidecar_write_failure_can_retry_before_and_after_tmp_publication(self):
        atomic = self.pi._atomic_tmp_metadata
        for failure in (1, 2):
            with self.subTest(failure=failure):
                make_asar(self.asar)
                calls = []
                def fail(meta):
                    calls.append(meta)
                    if len(calls) == failure:
                        raise OSError("sidecar write failed")
                    return atomic(meta)
                with mock.patch.object(self.pi, "_atomic_tmp_metadata", side_effect=fail):
                    self.assertFalse(self.pi.install())
                self.assertFalse(self.pi.install(finalize=True))
                self.assertNotIn(b"inject-main.cjs", self.pi.entry_bytes_of(self.asar))
                self.assertTrue(self.pi.install())

    def test_unknown_tmp_is_preserved_after_repack_failure(self):
        self.pi.TMP.write_bytes(b"unknown historical TMP")
        with mock.patch.object(self.pi, "repack", side_effect=OSError("disk full")) as repack:
            self.assertFalse(self.pi.install())
        repack.assert_not_called()
        self.assertEqual(self.pi.TMP.read_bytes(), b"unknown historical TMP")

    def test_cli_dispatches_finalize_flag(self):
        with mock.patch.object(self.pi, "install", return_value=True) as install:
            self.pi.main(["install", "--finalize"])
        install.assert_called_once_with(finalize=True)

    def test_consume_flag_arg_parses_both_forms_and_strips_them(self):
        self.assertEqual(self.pi._consume_flag_arg(["install", "--asar", "/x/app.asar", "--finalize"], "asar"),
                         ("/x/app.asar", ["install", "--finalize"]))
        self.assertEqual(self.pi._consume_flag_arg(["--asar=/x/app.asar", "check"], "asar"),
                         ("/x/app.asar", ["check"]))
        self.assertEqual(self.pi._consume_flag_arg(["install", "--finalize"], "asar"),
                         (None, ["install", "--finalize"]))
        self.assertEqual(self.pi._consume_flag_arg(["--asar"], "asar"), (None, ["--asar"]))
        self.assertEqual(self.pi._consume_flag_arg(["--runtime", "/a", "--runtime", "/b"], "runtime"),
                         ("/b", []))
        self.assertEqual(self.pi._consume_flag_arg(["--asar", "--finalize", "install"], "asar"),
                         (None, ["--asar", "--finalize", "install"]))

    def fresh_module(self):
        """未调用 set_target() 的全新实例：standalone 运行时模块级 ASAR 是平台默认猜测路径。"""
        spec = importlib.util.spec_from_file_location("fresh_patch_test", CORE / "patch_install.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_standalone_without_asar_guesses_default_and_reports(self):
        fresh = self.fresh_module()
        buf = io.StringIO()
        with mock.patch.object(fresh, "ASAR", self.root / "not-the-real-install" / "app.asar"), \
                contextlib.redirect_stdout(buf):
            rc = fresh.main(["check"])
        self.assertEqual(rc, 1)
        self.assertIn("读取 asar 失败", buf.getvalue())

    def test_standalone_asar_flag_fixes_default_path_guess(self):
        fresh = self.fresh_module()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), \
                mock.patch.object(fresh, "syntax_check", return_value=True):
            fresh.main(["check", "--asar", str(self.asar)])
        self.assertEqual(fresh.ASAR, self.asar.resolve())
        self.assertIn("asar:", buf.getvalue())

    def test_standalone_zcode_asar_env_fixes_default_path_guess(self):
        fresh = self.fresh_module()
        with mock.patch.dict(os.environ, {"ZCODE_ASAR": str(self.asar)}), \
                contextlib.redirect_stdout(io.StringIO()), \
                mock.patch.object(fresh, "syntax_check", return_value=True):
            fresh.main(["check"])
        self.assertEqual(fresh.ASAR, self.asar.resolve())

    def test_cli_asar_flag_takes_priority_over_env_var(self):
        fresh = self.fresh_module()
        other = self.root / "other.asar"
        make_asar(other)
        with mock.patch.dict(os.environ, {"ZCODE_ASAR": str(other)}), \
                contextlib.redirect_stdout(io.StringIO()), \
                mock.patch.object(fresh, "syntax_check", return_value=True):
            fresh.main(["check", "--asar", str(self.asar)])
        self.assertEqual(fresh.ASAR, self.asar.resolve())

    def test_install_while_running_failure_hint_includes_asar_path(self):
        buf = io.StringIO()
        with mock.patch.object(self.pi, "client_running", return_value=True), \
                mock.patch.object(self.pi, "_replace_pending", side_effect=PermissionError("locked")), \
                mock.patch.object(self.pi, "launch_monitor"), \
                contextlib.redirect_stdout(buf):
            self.assertFalse(self.pi.install())
        output = buf.getvalue()
        self.assertIn(f'--asar "{self.asar.resolve()}"', output)
        self.assertIn(f'--runtime "{self.pi.RUNTIME}"', output)
        tool = self.pi.RUNTIME / "patch_install.py"
        self.assertIn(f'"{sys.executable}" "{tool}"', output)
        self.assertIn("Keep it open", output)

    def test_remove_failure_hint_includes_asar_path(self):
        self.pi.install()
        buf = io.StringIO()
        with mock.patch.object(self.pi, "_replace_pending", side_effect=PermissionError("locked")), \
                contextlib.redirect_stdout(buf):
            self.assertFalse(self.pi.remove())
        output = buf.getvalue()
        self.assertIn(f'--asar "{self.asar.resolve()}"', output)
        self.assertNotIn("--runtime", output)
        tool = self.pi.RUNTIME / "patch_install.py"
        self.assertIn(f'"{sys.executable}" "{tool}"', output)

    def test_check_pending_tmp_hint_includes_asar_path(self):
        self.prepare()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.pi.check()
        output = buf.getvalue()
        self.assertIn(f'--asar "{self.asar.resolve()}"', output)
        self.assertIn(f'--runtime "{self.pi.RUNTIME}"', output)

    def test_check_pending_remove_tmp_hint_suggests_remove_not_install(self):
        self.pi.install()
        self.prepare(operation="remove")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.pi.check()
        output = buf.getvalue()
        self.assertIn(f'remove --asar "{self.asar.resolve()}"', output)
        self.assertNotIn("install --finalize", output)
        self.assertNotIn("--runtime", output)

    def test_runtime_flag_accepts_relative_path_without_crashing(self):
        fresh = self.fresh_module()
        with contextlib.redirect_stdout(io.StringIO()):
            fresh.main(["check", "--asar", str(self.asar), "--runtime", "relative/sub/dir"])   # 不应抛出
        self.assertTrue(fresh.RUNTIME.is_absolute())
        self.assertTrue(str(fresh.RUNTIME).endswith(str(Path("relative/sub/dir"))))

    def test_standalone_finalize_without_runtime_flag_is_rejected_by_sidecar(self):
        self.prepare()
        other_dir = self.root / "elsewhere"
        other_dir.mkdir()
        fresh = self.fresh_module()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), \
                mock.patch.object(fresh, "syntax_check", return_value=True), \
                mock.patch.object(fresh, "client_running", return_value=False):
            result = fresh.main(["install", "--finalize", "--asar", str(self.asar), "--runtime", str(other_dir)])
        self.assertFalse(result)
        self.assertIn("no longer authorized", buf.getvalue())
        self.assertTrue(self.pi.TMP.exists())

    def test_standalone_finalize_with_matching_runtime_flag_succeeds(self):
        self.prepare()
        fresh = self.fresh_module()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), \
                mock.patch.object(fresh, "syntax_check", return_value=True), \
                mock.patch.object(fresh, "client_running", return_value=False):
            result = fresh.main(["install", "--finalize", "--asar", str(self.asar),
                                "--runtime", str(self.runtime)])
        self.assertTrue(result, buf.getvalue())
        self.assertFalse(self.pi.TMP.exists())

    def test_stamp_fields_platform_contract(self):
        fields = self.pi._STAMP_FIELDS
        if sys.platform == "win32":
            self.assertNotIn("ctime_ns", fields)
        else:
            self.assertIn("ctime_ns", fields)
        meta = self.prepare()
        for fingerprint in (meta["source"], meta["tmp"]):
            self.assertEqual({key for key in fingerprint if key != "sha256"}, set(fields))

    def legacy_sidecar(self, **changes):
        """改写成升级前的 sidecar：旧版全平台都记录 ctime_ns（Windows 现已不比对）。"""
        meta = json.loads(self.pi.TMP_META.read_text(encoding="utf-8"))
        for field in ("source", "tmp"):
            meta[field]["ctime_ns"] = 1
        meta.update(changes)
        self.pi.TMP_META.write_text(json.dumps(meta), encoding="utf-8")

    def without_ctime(self):
        fields = tuple(key for key in self.pi._STAMP_FIELDS if key != "ctime_ns")
        return mock.patch.object(self.pi, "_STAMP_FIELDS", fields)

    def test_legacy_sidecar_with_ctime_is_finalized_after_upgrade(self):
        self.prepare()
        self.legacy_sidecar()
        with self.without_ctime():
            self.pi.pending_tmp("install", verify_hash=True)
            self.assertTrue(self.pi.install(finalize=True))
        self.assertTrue(self.pi.self_check(self.asar))
        self.assertFalse(self.pi.TMP.exists())

    def test_legacy_sidecar_still_rejects_hash_mismatch(self):
        meta = self.prepare()
        self.legacy_sidecar(tmp=dict(meta["tmp"], ctime_ns=1, sha256="0" * 64))
        with self.without_ctime(), \
                self.assertRaisesRegex(self.pi.PendingTmpError, "hash mismatch"):
            self.pi.pending_tmp("install", verify_hash=True)
        self.assertTrue(self.pi.TMP.exists())

    def test_reinstall_reclaims_legacy_pending_pair_and_publication_journal(self):
        for journal in (False, True):
            with self.subTest(journal=journal):
                self.pi.TMP.unlink(missing_ok=True)
                self.pi.TMP_META.unlink(missing_ok=True)
                make_asar(self.asar)
                meta = self.prepare()
                if journal:
                    self.legacy_sidecar(operation="cancelled", publishing=True,
                                        tmp=dict(meta["tmp"], sha256="0" * 64),
                                        previous_tmp=dict(meta["tmp"], ctime_ns=1))
                else:
                    self.legacy_sidecar()
                with self.without_ctime():
                    fresh = self.prepare()
                self.assertNotIn("ctime_ns", fresh["tmp"])

    def test_same_fingerprint_treats_missing_fields_as_mismatch(self):
        current = {"size": 1, "sha256": "a"}
        self.assertTrue(self.pi._same_fingerprint(current, dict(current, ctime_ns=5)))
        self.assertFalse(self.pi._same_fingerprint(current, {"sha256": "a"}))
        self.assertFalse(self.pi._same_fingerprint(current, None))

    def test_valid_identical_pending_is_reused_without_repack_or_rewrite(self):
        """客户端持续运行期间每次 SessionStart 自动安装都走到这里：磁盘上已有同来源、
        同运行时、入口内容完全一致的待收尾包时必须复用（stat 级判定）。"""
        self.prepare()
        tmp_bytes = self.pi.TMP.read_bytes()
        meta_bytes = self.pi.TMP_META.read_bytes()
        intent = mock.Mock()
        with mock.patch.object(self.pi, "repack", side_effect=AssertionError("must not repack")), \
                mock.patch.object(self.pi, "client_running", return_value=True), \
                mock.patch.object(self.pi, "launch_monitor") as monitor, \
                mock.patch.object(self.pi.os, "replace", side_effect=PermissionError("locked")):
            self.assertFalse(self.pi.install(before_publish=intent))
        self.assertEqual(self.pi.TMP.read_bytes(), tmp_bytes)
        self.assertEqual(self.pi.TMP_META.read_bytes(), meta_bytes)
        intent.assert_not_called()
        monitor.assert_called_once()

    def test_reused_pending_finalizes_normally_once_client_exits(self):
        self.prepare()
        with mock.patch.object(self.pi, "repack", side_effect=AssertionError("must not repack")), \
                mock.patch.object(self.pi, "launch_monitor"):
            self.assertTrue(self.pi.install())
        self.assertFalse(self.pi.TMP.exists())
        self.assertFalse(self.pi.TMP_META.exists())
        self.assertIn(b";import(", self.pi.entry_bytes_of(self.asar))

    def test_pending_with_divergent_content_is_rebuilt(self):
        entry = self.pi.entry_bytes_of(self.asar)
        stripped = self.pi.STATUSBAR_LINE_RE.sub(b"", entry)
        self.pi.prepare_tmp({"/" + self.pi.ENTRY: stripped + b"/*divergent*/" + self.pi.INJECT_LINE.encode()})
        real_replace = self.pi.os.replace
        def locked_for_target(src, dst, *args, **kwargs):
            if Path(dst) == self.pi.ASAR:
                raise PermissionError("locked")
            return real_replace(src, dst, *args, **kwargs)
        with mock.patch.object(self.pi, "repack", wraps=self.pi.repack) as repack, \
                mock.patch.object(self.pi, "client_running", return_value=True), \
                mock.patch.object(self.pi, "launch_monitor"), \
                mock.patch.object(self.pi.os, "replace", side_effect=locked_for_target):
            self.assertFalse(self.pi.install())
        repack.assert_called_once()
        self.assertEqual(self.pi.entry_bytes_of(self.pi.TMP), stripped + self.pi.INJECT_LINE.encode())

    def test_pending_becomes_stale_after_official_upgrade_and_is_rebuilt(self):
        """复用判定的安全底线：官方升级换了 asar（stamp 变化）后，旧待收尾包绝不能
        被复用去覆盖新版，必须按新来源重建（降级覆盖阻止）。"""
        self.prepare()
        self.upgrade_asar()
        with mock.patch.object(self.pi, "repack", wraps=self.pi.repack) as repack, \
                mock.patch.object(self.pi, "launch_monitor"):
            self.assertTrue(self.pi.install())
        repack.assert_called_once()
        self.assertIn(b"official v2", self.pi.entry_bytes_of(self.asar))
        self.assertIn(b";import(", self.pi.entry_bytes_of(self.asar))


class ProtectedTargetTests(unittest.TestCase):
    """受保护目录：可写性判定必须以真实写入探针兜底（os.access 会谎报可写）。"""

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
        spec = importlib.util.spec_from_file_location("protected_patch_test", CORE / "patch_install.py")
        self.pi = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.pi)
        self.pi._LANG = "en"
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        (self.runtime / "inject-main.cjs").write_text("// fixture", encoding="utf-8")

    def protected_target(self):
        directory = self.root / "Program Files" / "ZCode" / "resources"
        directory.mkdir(parents=True)
        asar = directory / "app.asar"
        make_asar(asar)
        os.chmod(directory, 0o555)
        self.addCleanup(os.chmod, directory, 0o755)
        return directory, asar

    def refuse_root(self):
        if os.name == "nt":
            self.skipTest("POSIX chmod 夹具在 Windows 上模拟不了受保护目录")
        if os.name == "posix" and os.geteuid() == 0:
            self.skipTest("root 对只读目录仍可写，无法模拟权限拒绝")

    def test_target_writable_probes_real_write_when_access_lies(self):
        self.refuse_root()
        directory, asar = self.protected_target()
        self.pi.set_target(asar)
        self.pi.set_runtime(self.runtime)
        with mock.patch.object(self.pi.os, "access", return_value=True):
            self.assertFalse(self.pi.target_writable())
        os.chmod(directory, 0o755)
        self.assertTrue(self.pi.target_writable())
        self.assertEqual([p.name for p in directory.iterdir()], ["app.asar"])

    def test_target_writable_probe_denial_is_not_writable(self):
        asar = self.root / "probe-denied.asar"
        make_asar(asar)
        self.pi.set_target(asar)
        self.pi.set_runtime(self.runtime)
        with mock.patch.object(self.pi.tempfile, "mkstemp",
                               side_effect=PermissionError(5, "denied")):
            self.assertFalse(self.pi.target_writable())

    def test_install_on_access_lying_target_hints_instead_of_spawning_monitor(self):
        self.refuse_root()
        directory, asar = self.protected_target()
        self.pi.set_target(asar)
        self.pi.set_runtime(self.runtime)
        os.chmod(directory, 0o755)
        with contextlib.redirect_stdout(io.StringIO()):
            self.pi.prepare_tmp({"/" + self.pi.ENTRY:
                                 self.pi.entry_bytes_of(asar) + self.pi.INJECT_LINE.encode()})
            with self.pi._target_lock():
                pass
        os.chmod(directory, 0o555)
        with mock.patch.object(self.pi.os, "access", return_value=True), \
                mock.patch.object(self.pi, "client_running", return_value=True), \
                mock.patch.object(self.pi, "launch_monitor") as launch:
            with contextlib.redirect_stdout(io.StringIO()):
                ok = self.pi.install()
        self.assertFalse(ok)
        launch.assert_not_called()
        self.assertTrue(self.pi.TMP.exists())
        self.assertTrue(self.pi.TMP_META.exists())

    def test_access_check_still_blocks_readonly_asar_in_writable_dir(self):
        if os.name == "posix" and os.geteuid() == 0:
            self.skipTest("root 对只读文件仍可写，无法模拟权限拒绝")
        asar = self.root / "readonly.asar"
        make_asar(asar)
        self.pi.set_target(asar)
        self.pi.set_runtime(self.runtime)
        os.chmod(asar, 0o444)
        self.addCleanup(os.chmod, asar, 0o644)
        self.assertFalse(self.pi.target_writable())

    def test_is_elevated_matches_identity(self):
        with mock.patch.object(self.pi, "IS_WIN", False):
            if os.name == "posix":
                self.assertEqual(self.pi.is_elevated(), os.geteuid() == 0)
            else:
                self.assertFalse(self.pi.is_elevated())
            with mock.patch.object(self.pi.os, "geteuid", return_value=0, create=True):
                self.assertTrue(self.pi.is_elevated())
            with mock.patch.object(self.pi.os, "geteuid", side_effect=AttributeError, create=True):
                self.assertFalse(self.pi.is_elevated())

    def test_is_elevated_windows_branch_uses_shell_check(self):
        windll = mock.Mock()
        windll.shell32.IsUserAnAdmin.return_value = 1
        with mock.patch.object(self.pi, "IS_WIN", True), \
                mock.patch.object(ctypes, "windll", windll, create=True):
            self.assertTrue(self.pi.is_elevated())
            windll.shell32.IsUserAnAdmin.return_value = 0
            self.assertFalse(self.pi.is_elevated())


class CliExitCodeTests(unittest.TestCase):
    """`sys.exit(main())` 不能把 bool 直接当退出码（True→1、False→0 颠倒）。"""

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

    def run_cli(self, *argv):
        return subprocess.run(
            [sys.executable, "-B", str(CORE / "patch_install.py"), *argv],
            capture_output=True, env=dict(os.environ), timeout=60)

    def test_check_exit_code_distinguishes_success_and_failure(self):
        asar = self.root / "app.asar"
        make_asar(asar)
        ok = self.run_cli("check", "--asar", str(asar))
        self.assertEqual(ok.returncode, 0, ok.stderr.decode("utf-8", "replace"))
        bad = self.run_cli("check", "--asar", str(self.root / "missing.asar"))
        self.assertEqual(bad.returncode, 1, bad.stdout.decode("utf-8", "replace"))

    def test_finalize_exit_code_is_zero_only_on_success(self):
        asar = self.root / "app.asar"
        make_asar(asar)
        denied = self.run_cli("install", "--finalize", "--asar", str(asar),
                              "--runtime", str(self.root / "runtime"))
        self.assertEqual(denied.returncode, 1, denied.stdout.decode("utf-8", "replace"))


if __name__ == "__main__":
    unittest.main()
