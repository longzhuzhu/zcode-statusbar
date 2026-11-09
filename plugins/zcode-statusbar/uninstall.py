# -*- coding: utf-8 -*-
"""zcode-statusbar 卸载编排器（design §5「单一 uninstall 入口」与 ADR-0001 卸载义务）。

三条卸载路径（SessionStart 钩子 remove、/卸载菜单、仓库根 install.py --remove）都收敛到
run_uninstall()，按固定次序补齐原插件的三个卸载闭环缺口：

  缺口①  引擎补丁 restore()：插件 remove 路径显式调用 engine-patch.cjs 的 restore()，
          按当前引擎字节反向还原（引擎本就干净 / 引擎已被官方升级整体替换时为 no-op）；
  缺口②  ZIP 预注入撤销链：读取运行目录 pending-zip-patch.json 撤销清单
          （pending_zip_patch.undo_all），对仍存在的已预注入更新包逐条还原；
  缺口③  asar 剥离失败 → 保留运行目录与全部 state 文件，输出修复指引，绝不删除目录。

另含渲染器静态桥的对称剥离（renderer_bridge.remove_deployed）。卸载保留用户配置
（config.json）、SQLite 统计数据与日志——运行目录在任何失败分支下都不被本模块删除
（AC7：卸载后重装配置仍生效）。

用法：
  python uninstall.py --runtime <运行目录> [--asar <app.asar>]   # CLI 等价入口
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

_HERE = Path(__file__).parent.resolve()
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
import patch_install  # noqa: E402
import pending_zip_patch  # noqa: E402
import renderer_bridge  # noqa: E402

VERIFY_TIMEOUT = 30   # 引擎 restore 单次运行上限（秒）；15MB 引擎的读改写余量充足

PYEXE = sys.executable or "python"


def _log(message):
    print(patch_install.L(f"[uninstall] {message}", f"[uninstall] {message}"))


def _node_candidates(asar):
    """引擎 restore 可用解释器：asar 旁的 ZCode 可执行文件优先（ELECTRON_RUN_AS_NODE），
    缺失/不可执行时回退 PATH 上的 node。任何候选都不做身份保证，启动失败逐个回退。"""
    candidates = []
    if asar is not None:
        exe = patch_install.ui_element_exe_for(patch_install.zcode_exe_for(Path(asar)))
        if exe and Path(exe).is_file():
            candidates.append(Path(exe))
    from shutil import which
    node = which("node")
    if node:
        candidates.append(Path(node))
    return candidates


def restore_engine_patch(resources_path, runtime, asar=None):
    """缺口①：显式调用引擎补丁 restore()。返回 dict：
    {"status": "restored"|"off"|"busy"|"error"|"skipped-*", "detail"}。
    restore 的 fail-closed 语义与 inject-main 运行期一致；此处任何失败都只上报，
    不阻塞卸载其余步骤（引擎补丁残留不产生注入行，asar 剥离照常进行）。"""
    script = (
        "const {createEnginePatcher} = require(process.argv[1]);"
        "const p = createEnginePatcher({"
        "runtime: process.argv[2], resourcesPath: process.argv[3],"
        "isEnabled: () => true, log: () => {}});"
        "process.stdout.write(JSON.stringify(p.restore()));"
    )
    last_error = ""
    for candidate in _node_candidates(asar):
        try:
            result = subprocess.run(
                [str(candidate), "-e", script, str(Path(runtime) / "engine-patch.cjs"),
                 str(runtime), str(resources_path)],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                env=dict(os.environ, ELECTRON_RUN_AS_NODE="1"),
                timeout=VERIFY_TIMEOUT)
        except (OSError, subprocess.TimeoutExpired) as e:
            last_error = str(e)
            continue   # 启动失败/超时：换下一个候选（悬挂候选可能不可执行）
        if result.returncode != 0:
            last_error = (result.stderr or "").strip()[:500] or f"exit {result.returncode}"
            continue
        try:
            state = json.loads(result.stdout)
        except ValueError:
            last_error = "restore() returned invalid JSON"
            continue
        # restore() 返回引擎状态字符串（off/applied/busy/error/...）；off=已干净或已还原
        status = "restored" if state == "off" else str(state)
        return {"status": status, "detail": state if state != "off" else "engine patch restored or already clean"}
    return {"status": "skipped-error", "detail": last_error or "no usable node/electron interpreter"}


def run_uninstall(asar=None, runtime=None, engine_restore=True, zip_undo=True, bridge_remove=True):
    """卸载编排主入口。返回报告 dict：
    {"engine": {...}, "zipUndo": [...], "bridge": {...}, "asar": bool|None, "ok": bool,
     "runtimeKept": True, "repair": [修复指引命令]}
    ok=True 表示全部尝试步骤均已收敛（含「本就干净」）；False 表示存在需人工处理的残留
    （缺口③：此时运行目录与 state 文件原样保留，repair 给出手动命令）。"""
    runtime = Path(runtime) if runtime else _HERE
    runtime.mkdir(parents=True, exist_ok=True)
    asar = Path(asar).resolve() if asar else (patch_install.ASAR if patch_install.ASAR else None)
    report = {"engine": {"status": "skipped-disabled", "detail": "engine restore not requested"},
              "zipUndo": [], "bridge": {"status": "skipped-disabled", "detail": "bridge remove not requested"},
              "asar": None, "ok": True, "runtimeKept": True, "repair": []}

    # 缺口②：ZIP 预注入撤销链（不依赖 asar 是否可读）
    if zip_undo:
        try:
            report["zipUndo"] = pending_zip_patch.undo_all(runtime)
        except Exception as e:  # noqa: BLE001 — 撤销失败只上报，不阻塞卸载
            report["zipUndo"] = [{"zip": "*", "status": "error", "detail": str(e)}]
            report["ok"] = False

    if asar is not None and Path(asar).is_file():
        patch_install.set_target(asar)
        patch_install.set_runtime(runtime)
        resources_path = Path(asar).parent

        # 缺口①：引擎补丁显式 restore（必须在 asar 剥离之前——两者无依赖，但先还原
        # 引擎可以让「asar 剥离失败待收尾」场景下用户重启后引擎已干净）
        if engine_restore:
            try:
                report["engine"] = restore_engine_patch(resources_path, runtime, asar)
            except Exception as e:  # noqa: BLE001
                report["engine"] = {"status": "skipped-error", "detail": str(e)}

        # 渲染器静态桥对称剥离（失败不影响主链，与原插件同约定）
        if bridge_remove:
            try:
                report["bridge"] = renderer_bridge.remove_deployed(asar)
            except Exception as e:  # noqa: BLE001
                report["bridge"] = {"status": "skipped-error", "detail": str(e)}

        # asar 注入行剥离（含待替换包取消）
        try:
            ok = patch_install.remove()
        except Exception as e:  # noqa: BLE001
            ok = False
            _log(f"asar remove raised: {type(e).__name__}: {e}")
        report["asar"] = ok
        if not ok:
            report["ok"] = False
            # 缺口③：绝不删除运行目录与 state 文件；输出修复指引（指向运行目录副本，
            # clone 被删后仍可执行）。
            tool = runtime / "patch_install.py"
            if (runtime / "patch_install.py").is_file() or (_HERE / "patch_install.py").is_file():
                report["repair"].append(
                    f'"{PYEXE}" "{runtime / "patch_install.py"}" remove --asar "{asar}"')
            report["repair"].append(
                f'"{PYEXE}" "{runtime / "uninstall.py"}" --runtime "{runtime}" --asar "{asar}"')
            _log("asar strip failed; runtime dir and state files are KEPT (repair guidance below)")
            for cmd in report["repair"]:
                _log("  repair: " + cmd)
    else:
        if asar is not None:
            _log(f"app.asar not found ({asar}); skipping engine/bridge/asar steps")
            report["asar"] = None
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description="zcode-statusbar uninstall orchestrator")
    parser.add_argument("--runtime", default=None, help="运行目录（默认脚本所在 core/ 目录）")
    parser.add_argument("--asar", default=None, help="app.asar 完整路径（缺省按平台默认位置）")
    args = parser.parse_args(argv)
    runtime = Path(os.path.abspath(os.path.expandvars(os.path.expanduser(args.runtime)))) if args.runtime else _HERE
    asar = os.path.expandvars(os.path.expanduser(args.asar)) if args.asar else None
    if not asar:
        # 未显式给 --asar 时按 patch_install 平台默认位置（config 记忆的 asar_path 由
        # runtime_install.py / install.py 在调用 run_uninstall 前解析并显式传入）。
        asar = patch_install.ASAR_DEFAULT
    report = run_uninstall(asar=asar, runtime=runtime)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
