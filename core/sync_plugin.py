# -*- coding: utf-8 -*-
"""把仓库运行时文件同步进 plugins/zcode-statusbar/（插件打包副本，扁平布局）。

本文件为原始移植+适配版，适配点见下方注释：
  * 源位置按新仓库布局解析：core/ 顶层为主、statusbar/ 的 UI 四件、仓库根 zusage.py；
  * 清单直接复用 runtime_lock.RUNTIME_FILE_NAMES（release_unpack.CORE_FILES 的镜像），
    与插件链同步源（runtime_install._sync_runtime_locked 在 PLUGIN_ROOT 的 flat 查找）
    共用同一文件集；OPTIONAL_RUNTIME_FILES 尚未产出时跳过不阻塞；
  * 旧插件命名残留清理（overlay.js/token_rate.py 等旧文件清单整体废弃）。

插件要能脱离仓库独立安装（官方安装记录的 installPath 指向 marketplace 缓存目录里的
plugins/<name>/ 子树，runtime_install 从该目录扁平读取运行时文件），所以插件包里
必须带一份运行时文件副本。改了 core/ 或 statusbar/ 文件后跑一次：

  python3 sync_plugin.py

副本与源文件不一致时退出码 1（CI 可用作漂移检查；加 --check 只查不改）。
"""
import filecmp
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).parent.resolve()          # core/（内核源码正本）
REPO = HERE.parent
PLUGIN = REPO / "plugins" / "zcode-statusbar"
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
from runtime_lock import RUNTIME_FILE_NAMES, OPTIONAL_RUNTIME_FILES  # noqa: E402


def source_of(name):
    """运行时文件在仓库布局中的源位置：core/ → statusbar/ → 仓库根，按序探测。"""
    for base in (HERE, REPO / "statusbar", REPO):
        candidate = base / name
        if candidate.is_file():
            return candidate
    return HERE / name   # 报错时指向最常见位置


def main(check_only=False):
    missing_core = [name for name in RUNTIME_FILE_NAMES
                    if not source_of(name).is_file() and name not in OPTIONAL_RUNTIME_FILES]
    if missing_core:
        print("源文件缺失:", ", ".join(str(source_of(name)) for name in missing_core))
        return 1
    skipped = [name for name in RUNTIME_FILE_NAMES if not source_of(name).is_file()]
    if skipped:
        print("跳过未产出的可选文件:", ", ".join(skipped))
    PLUGIN.mkdir(parents=True, exist_ok=True)
    drift = []
    for name in RUNTIME_FILE_NAMES:
        src = source_of(name)
        if not src.is_file():
            continue   # OPTIONAL：已在上面提示
        dst = PLUGIN / name
        if dst.is_file() and filecmp.cmp(src, dst, shallow=False):
            continue
        drift.append(name)
        if not check_only:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            print(f"已同步 {name}")
    if check_only:
        if drift:
            print("插件副本过期:", ", ".join(drift), "（运行 python3 sync_plugin.py 更新）")
            return 1
        print("插件副本与源文件一致。")
    elif not drift:
        print("无需更新，副本已一致。")
    return 0


if __name__ == "__main__":
    sys.exit(main(check_only="--check" in sys.argv[1:]))
