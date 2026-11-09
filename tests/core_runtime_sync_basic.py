# -*- coding: utf-8 -*-
"""runtime_lock.RUNTIME_FILE_NAMES 运行时同步基线回归（A-fin）。

前序 tests/core_runtime_sync_guard.py 用真实 Node 验收器覆盖安装竞态/来源篡改/降级
（身份链）；本文件 mock 掉验收器，聚焦文件同步语义本身：
  * RUNTIME_FILE_NAMES 与 release_unpack.CORE_FILES 镜像一致（防单边改白名单）；
  * OPTIONAL_RUNTIME_FILES 缺失跳过不阻塞、存在时照常同步并进 hash 基线；
  * hash 基线保护手改（运行时副本被改后同步跳过并保留）；
  * 无基线迁移（首装）用 mtime；降级（plugin 版本倒退）不覆盖新运行时。
全部临时目录，不触碰 ~/.zcode 与真实 ZCode。
运行：python3 -m unittest tests.core_runtime_sync_basic（仓库根）。
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "core"
if str(CORE) not in sys.path:
    sys.path.insert(0, str(CORE))

spec = importlib.util.spec_from_file_location("sync_basic_installer", CORE / "runtime_install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
import runtime_lock  # noqa: E402
import release_unpack  # noqa: E402

PLUGIN_NAME = "zcode-statusbar"


class RuntimeSyncBasicTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.plugin = self.root / "installed"
        (self.plugin / ".zcode-plugin").mkdir(parents=True)
        self.write_manifest("1.1.0")
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        # 插件缓存目录里放全部非 OPTIONAL 运行时文件（OPTIONAL 由用例自行决定）
        for name in runtime_lock.RUNTIME_FILE_NAMES:
            if name in runtime_lock.OPTIONAL_RUNTIME_FILES:
                continue
            (self.plugin / name).write_bytes(("pkg:" + name).encode())

    def write_manifest(self, version):
        (self.plugin / ".zcode-plugin" / "plugin.json").write_text(
            json.dumps({"name": PLUGIN_NAME, "version": version}), encoding="utf-8")

    def sync(self):
        """mock 身份验收（guard 测试已用真 Node 验收覆盖身份链），只跑文件同步语义。"""
        @contextlib.contextmanager
        def fake_verifier(runtime, target_asar=None):
            yield lambda: None
        with mock.patch.object(installer, "PLUGIN_ROOT", self.plugin), \
                mock.patch.object(installer, "_sync_verifier", fake_verifier), \
                contextlib.redirect_stderr(io.StringIO()):
            return installer.sync_runtime(self.runtime)

    def record(self):
        return json.loads((self.runtime / "plugin-runtime.json").read_text(encoding="utf-8"))

    def hashes(self):
        return {name: hashlib.sha256((self.runtime / name).read_bytes()).hexdigest()
                for name in runtime_lock.RUNTIME_FILE_NAMES if (self.runtime / name).is_file()}

    def test_manifest_mirrors_release_unpack_core_files(self):
        """白名单镜像契约：runtime_lock.RUNTIME_FILE_NAMES ≡ release_unpack.CORE_FILES
        （release_unpack 注释声明的两边同步义务的回归锚）。"""
        self.assertEqual(set(runtime_lock.RUNTIME_FILE_NAMES), set(release_unpack.CORE_FILES))
        self.assertEqual(len(runtime_lock.RUNTIME_FILE_NAMES), len(release_unpack.CORE_FILES))
        self.assertTrue(runtime_lock.OPTIONAL_RUNTIME_FILES <= set(runtime_lock.RUNTIME_FILE_NAMES))
        self.assertEqual(runtime_lock.OPTIONAL_RUNTIME_FILES,
                         frozenset(("zusage.py", "usage_stats.py")))

    def test_optional_missing_skips_without_failing(self):
        """OPTIONAL（zusage.py/usage_stats.py）缺失：同步成功不阻塞；核心文件照常落位。"""
        result = self.sync()
        self.assertNotIn("zusage.py", result["changed"])
        self.assertIn("usage_stats.py", result["skipped"])
        self.assertTrue((self.runtime / "runtime_install.py").is_file())
        self.assertFalse((self.runtime / "usage_stats.py").exists())

    def test_optional_present_syncs_and_enters_hash_baseline(self):
        """OPTIONAL 存在：照常同步并进 hash 基线；缺失转存在后下一轮补齐。"""
        self.sync()
        self.assertFalse((self.runtime / "zusage.py").exists())
        (self.plugin / "zusage.py").write_bytes(b"pkg:zusage")
        result = self.sync()
        self.assertIn("zusage.py", result["changed"])
        self.assertEqual(self.record()["hashes"]["zusage.py"],
                         hashlib.sha256((self.runtime / "zusage.py").read_bytes()).hexdigest())

    def test_core_file_missing_is_hard_error(self):
        """核心文件缺失按硬错误（fail-closed，绝不半装内核）。"""
        (self.plugin / "engine-patch.cjs").unlink()
        with self.assertRaises(ValueError):
            self.sync()
        self.assertFalse((self.runtime / "engine-patch.cjs").exists())

    def test_hash_baseline_steady_state_skips_rewrite(self):
        """稳态（内容一致）按 hash 基线跳过；重复同步幂等不产生新写入。"""
        self.sync()
        before = self.hashes()
        result = self.sync()
        self.assertEqual(result["changed"], [])
        self.assertEqual(self.hashes(), before)

    def test_manual_edit_is_protected_and_kept(self):
        """hash 基线保护手改：运行时副本被改后同步跳过并保留手改（提示手动覆盖）。"""
        self.sync()
        (self.runtime / "statusbar.js").write_bytes(b"user hotfix")
        result = self.sync()
        self.assertIn("statusbar.js", result["preserved"])
        self.assertEqual((self.runtime / "statusbar.js").read_bytes(), b"user hotfix")
        # 基线里仍是插件包版本的手改前 hash：恢复一致后自动重新纳管
        (self.runtime / "statusbar.js").unlink()
        result = self.sync()
        self.assertIn("statusbar.js", result["changed"])

    def test_downgrade_does_not_overwrite_newer_runtime(self):
        """降级阻止：插件版本倒退后源文件即使变化也不覆盖运行时（旧版本不能回滚新版）。"""
        self.sync()
        (self.runtime / "statusbar.js").unlink()   # 清掉副本强制走同步路径
        self.write_manifest("1.0.0")
        (self.plugin / "statusbar.js").write_bytes(b"old downgrade payload")
        result = self.sync()
        self.assertNotIn("statusbar.js", result["changed"])
        self.assertFalse((self.runtime / "statusbar.js").exists())
        # 记录保留旧版本身份，等插件缓存追上
        self.assertEqual(self.record()["version"], "1.1.0")

    def test_first_install_uses_mtime_migration(self):
        """无基线迁移（首装到已有运行时）：副本 mtime 较新时保留（旧副本不能被旧包覆盖）。"""
        (self.runtime / "statusbar.js").write_bytes(b"newer runtime copy")
        stamp = self.plugin.joinpath("statusbar.js").stat().st_mtime_ns + 10_000_000
        import os as _os
        _os.utime(self.runtime / "statusbar.js", ns=(stamp, stamp))
        result = self.sync()
        self.assertIn("statusbar.js", result["preserved"])
        self.assertEqual((self.runtime / "statusbar.js").read_bytes(), b"newer runtime copy")


if __name__ == "__main__":
    unittest.main()
