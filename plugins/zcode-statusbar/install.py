# -*- coding: utf-8 -*-
"""「ZCode 状态条」一键安装（标准库实现，零依赖）。

本文件为原始移植+适配版，适配点见下方注释：
  * 运行时清单不再手写：与 runtime_lock.RUNTIME_FILE_NAMES（release_unpack.CORE_FILES
    的镜像）共用同一白名单，独立安装器与插件链同步的文件集保证一致；源位置按新仓库
    布局解析（core/ → statusbar/ → 仓库根）；
  * --remove 收敛到 uninstall.run_uninstall 单一卸载入口（引擎 restore + ZIP 预注入
    撤销 + 渲染桥/asar 剥离）；asar 剥离失败时保留数据目录并输出修复指引（design §5
    缺口③，绝不"失败也删目录"）；
  * MCP 注册与 /usage 命令改为可选：本形态是纯状态条（零 MCP 查询服务），usage_mcp.py
    /usage.command.md 缺席时跳过不阻塞，文件存在时自动启用；
  * 旧插件命名残留清理（zusage 备份/临时文件名、token 用量措辞）。

标准安装形态：仓库只是源码，install.py 把运行时复制到数据目录
  ~/.zcode/zcode-statusbar/
（inject-main.cjs / statusbar UI 四件 / zusage.py + config.json + diag 诊断产物），
asar 注入行与 MCP 注册都指向数据目录 —— 之后 clone 目录可以随意搬走或删除，
已安装实例照常运行，不存在"注入行指向已删除路径"的卸载残留。
（运行时全套基于 __dirname/__file__ 自定位，副本目录即自洽运行。）

用法（仓库根目录）：
  python install.py               # 全量安装：复制运行时 → 注入 asar → 注册 MCP → /usage 命令 → 监控窗口
  python install.py --root PATH   # 指定 ZCode 根目录（自动接上平台固定的 resources/app.asar）；
                                  #   Windows：python install.py --root D:\\Apps\\ZCode
                                  #   macOS：  python install.py --root /Applications/ZCode.app
                                  #   首次成功后记住，之后免传
  python install.py --asar PATH   # 指定 app.asar 完整路径（自动探测失败时用；同样记住）
  python install.py --no-mcp      # 只装状态条，不动 MCP 与 /usage 命令
  python install.py --dev         # 开发模式：不复制运行时，注入直指本仓库目录，配置/诊断留在仓库
                                  #   （作者迭代用，改仓库文件即时热更新；与标准形态重跑 install 即互切）
  python install.py --remove      # 卸载：引擎 restore + ZIP 撤销 + 剥离注入行 + 清理注册与数据目录
  python install.py --dry-run     # 打印将执行的动作，不写任何文件
  python install.py --lang en     # 安装器与各组件的输出语言（zh/en；写入 config.json 供 CLI/MCP 沿用）

升级：git pull 后重跑 python install.py —— 注入行不变则 asar 不重打包（秒级），
renderer/Python 副本刷新后由 loader 热重载；改了 inject-main.cjs（loader）才需要重启 ZCode。

ZCode 安装位置自动探测：环境变量 ZCODE_ASAR → 当前平台常见安装位置下找 resources\\app.asar
（Windows：D:\\ZCode 等；macOS：/Applications、~/Applications 下的 ZCode.app；
Linux：/opt/ZCode、/usr/lib/zcode 等 deb/rpm 布局）；
失败且终端可交互时询问，或用 --root/--asar 指定。非默认位置首次安装成功后路径记住在 config.json
（asar_path 字段），之后的安装/卸载一律免传 --asar。
"""
import argparse
import json
import os
import shutil
import stat
import sys
from pathlib import Path
from runtime_lock import update_config, RUNTIME_FILE_NAMES, OPTIONAL_RUNTIME_FILES

HERE = Path(__file__).parent.resolve()
REPO_ROOT = HERE.parent          # 仓库根（statusbar/ 与 zusage.py 所在）
_STATUSBAR_DIR = REPO_ROOT / "statusbar"


def normalize_asar_arg(p, kind="asar"):
    """把 --asar/--root 的实参归一成 app.asar 路径：三者都接受——
      * 完整 asar 路径（尾部 app.asar，惯用写法）
      * asar 所在目录（.../resources）
      * ZCode 根目录（--root：win/linux 下的安装目录；macOS 下 ZCode.app）
    Electron 布局下相对根目录的路径是固定的（Windows/Linux <root>/resources/app.asar，
    macOS bundle <root>/Contents/Resources/app.asar），所以指向根目录就够了。"""
    p = expand(p)
    if p.is_file():
        return p
    if kind == "root":
        cands = [p / "resources" / "app.asar"]
        if sys.platform == "darwin":
            cands.insert(0, p / "Contents" / "Resources" / "app.asar")
    else:
        cands = [p / "app.asar"]
    for c in cands:
        if c.is_file():
            return c
    return p / "app.asar" if kind == "root" else p


def _sudo_user():
    """sudo 运行时的真实用户名（POSIX；非 sudo / Windows 返回 None）。"""
    if sys.platform != "win32" and os.environ.get("SUDO_USER"):
        try:
            if os.geteuid() == 0:
                return os.environ["SUDO_USER"]
        except AttributeError:
            pass
    return None


def real_home():
    """真实用户家目录：sudo 运行时 Path.home() 是 root 的家，而数据目录/MCP 注册/
    /usage 命令必须落在真实用户的 ~/.zcode（ZCode 客户端与泵都以普通用户身份运行）。
    Linux 上 /opt 等系统安装位置写入需要 root，这是本函数存在的唯一场景。"""
    sudo_user = _sudo_user()
    if sudo_user:
        try:
            import pwd
            return Path(pwd.getpwnam(sudo_user).pw_dir)
        except (KeyError, OSError):
            pass
    return Path.home()


DATA_DIR = real_home() / ".zcode" / "zcode-statusbar"   # 标准安装的数据/运行目录
ZCODE_CONFIG = real_home() / ".zcode" / "cli" / "config.json"
COMMANDS_DIR = real_home() / ".zcode" / "commands"
MCP_NAME = "zcode-statusbar"   # MCP server 注册名（与仓库名一致；老安装叫 token-usage/zusage，自动迁移）
MCP_NAME_OLD = ("token-usage", "zusage")   # 历史注册名
# Linux 兜底扫描前缀（目录名含 zcode 的候选仍须过 is_zcode_app 身份门）
LINUX_FALLBACK_BASES = ("/opt", "/usr/lib", "/usr/local/lib")
# patch_install.py / install_monitor.py 一并进运行目录：待替换包的手动收尾命令
# （install --finalize）只依赖运行目录内这套脚本，clone 被删/移动后仍可执行（issue #163；
# 插件链 RUNTIME_FILES 早已同款在列）。
# 适配差异：清单直接复用插件链白名单 RUNTIME_FILE_NAMES（release_unpack.CORE_FILES 的
# 镜像），两条安装链同步进运行目录的文件集保证一致；改动白名单必须两边同步
# （runtime_lock.py 与 release_unpack.py），本文件只消费不再各自维护。
RUNTIME_FILES = RUNTIME_FILE_NAMES


def runtime_source(name):
    """运行时文件在仓库布局中的源位置：core/ 顶层为主，statusbar UI 四件在兄弟
    statusbar/，zusage.py 在仓库根；按序探测，找不到时返回 core/ 位置供报错展示。"""
    for base in (HERE, _STATUSBAR_DIR, REPO_ROOT):
        candidate = base / name
        if candidate.is_file():
            return candidate
    return HERE / name

# ZCode 安装位置候选：resources/app.asar 存在即命中（按序探测，按当前平台取组）
if sys.platform == "darwin":
    ASAR_CANDIDATES = [
        "/Applications/ZCode.app/Contents/Resources/app.asar",
        "~/Applications/ZCode.app/Contents/Resources/app.asar",
    ]
elif sys.platform.startswith("linux"):
    ASAR_CANDIDATES = [
        "/opt/ZCode/resources/app.asar",       # deb/rpm 官方包默认布局（<root>/zcode）
        "/opt/zcode/resources/app.asar",
        "/usr/lib/zcode/resources/app.asar",
        "/usr/local/ZCode/resources/app.asar",
    ]
else:
    ASAR_CANDIDATES = [
        r"D:\ZCode\resources\app.asar",
        r"C:\ZCode\resources\app.asar",
        r"%LOCALAPPDATA%\Programs\ZCode\resources\app.asar",
        r"%LOCALAPPDATA%\ZCode\resources\app.asar",
        r"%ProgramFiles%\ZCode\resources\app.asar",
    ]

LANG = "zh"   # 输出语言（main 里按 --lang / 已有 config.json 确定）


def L(zh, en):
    """双语输出：按 LANG 返回对应文案（与状态条前端文案约定一致）。"""
    return en if LANG == "en" else zh


def expand(p):
    return Path(os.path.expandvars(os.path.expanduser(p)))


def load_lang_from_config(dev):
    """已有 config.json 里存了 lang 就沿用（--dev 时 config 在仓库目录）。"""
    cfg = HERE / "config.json" if dev else DATA_DIR / "config.json"
    try:
        lang = json.loads(cfg.read_text(encoding="utf-8")).get("lang")
        return lang if lang in ("zh", "en") else None
    except (OSError, ValueError):
        return None


def asar_package_name(asar_path):
    """读 asar 内 package.json 的 name 字段，辅助识别"这是不是 ZCode 的 asar"；
    读不到（非 asar / 无 package.json / 条目 unpacked 外置）返回 None。"""
    import struct
    try:
        with open(asar_path, "rb") as f:
            a, b, c, d = struct.unpack("<4I", f.read(16))
            if a != 4:
                return None
            header = json.loads(f.read(d))
        node = header.get("files", {}).get("package.json")
        if not isinstance(node, dict) or "size" not in node:
            return None
        with open(asar_path, "rb") as f:
            f.seek(8 + b + int(node["offset"]))
            data = f.read(int(node["size"]))
        if b"\x00" in data:   # 被 pickle 对齐补零 / 条目加密等异常，放弃识别
            return None
        return json.loads(data.decode("utf-8")).get("name")
    except (OSError, ValueError, KeyError, TypeError, AttributeError, struct.error):
        return None   # 畸形 asar（header/package.json 是合法 JSON 但非对象）按读不到处理，跳过该候选


def is_zcode_app(asar_path):
    """该 asar 是否属于 ZCode：ZCode.exe 与 asar 同级，或包里 package.json 的 name 含 zcode。
    兜底扫描必须过此判定——%LOCALAPPDATA%\\Programs 下可能有其它 Electron 应用
    （如 opencode-aidesktop），按目录名猜会注入错目标：真 ZCode 永不生效。"""
    asar_path = Path(asar_path)
    if (asar_path.parent.parent / "ZCode.exe").is_file():
        return True
    name = asar_package_name(asar_path)
    return isinstance(name, str) and "zcode" in name.lower()


def fixed_drives(letters):
    """本地固定盘盘符：离线的映射网络盘一被访问就触发重连（可卡数秒），光驱/读卡器可能无介质。"""
    try:
        import ctypes
        drive_type = ctypes.windll.kernel32.GetDriveTypeW
    except (ImportError, AttributeError, OSError):
        return []
    return [letter for letter in letters if drive_type(f"{letter}:\\") == 3]   # DRIVE_FIXED


def drive_candidates():
    """自定义盘符安装（如 D:\\Program Files\\ZCode）：逐个本地固定盘枚举三种常见布局
    （%ProgramFiles% 只跟系统盘走；盘根 Programs\\ZCode 是不走安装器的自装位置）。"""
    return [f"{letter}:\\{folder}\\resources\\app.asar"
            for letter in fixed_drives("CDEFGHIJKLMNOPQRSTUVWXYZ")
            for folder in (r"Program Files\ZCode", r"Programs\ZCode", "ZCode")]


def find_asar():
    env = os.environ.get("ZCODE_ASAR")   # 非默认安装位置：设一次环境变量，永久免 --asar
    if env:
        p = expand(env)
        if p.is_file():
            return p    # 用户显式指定的目标不校验身份（自己的选择）
    drives = drive_candidates() if sys.platform == "win32" else []
    for c in dict.fromkeys(ASAR_CANDIDATES + drives):
        p = expand(c)
        # 枚举候选必须过 is_zcode_app：<盘>:\Program Files\ZCode 等路径名不是身份依据，
        # 命中其它 Electron 应用会注入错目标：真 ZCode 永不生效。
        if p.is_file() and is_zcode_app(p):
            return p
    if sys.platform == "win32":
        # 兜底：扫 %LOCALAPPDATA%\Programs 一层子目录
        # （必须过 is_zcode_app：该目录下可能有其它 Electron 应用，命中它们会注入错目标）
        prog = expand(r"%LOCALAPPDATA%\Programs")
        if prog.is_dir():
            for ch in prog.iterdir():
                p = ch / "resources" / "app.asar"
                if p.is_file() and is_zcode_app(p):
                    return p
    elif sys.platform.startswith("linux"):
        # 兜底：扫常见安装前缀一层子目录，目录名含 zcode 即候选，
        # 但必须过 is_zcode_app：该前缀下可能有名字含 zcode 的其它 Electron 应用，
        # 命中它们会注入错目标（与上方 Windows 兜底同款身份门）。
        for base in LINUX_FALLBACK_BASES:
            b = Path(base)
            if not b.is_dir():
                continue
            try:
                children = sorted(b.iterdir())
            except OSError:
                continue
            for ch in children:
                if "zcode" not in ch.name.lower():
                    continue
                p = ch / "resources" / "app.asar"
                if p.is_file() and is_zcode_app(p):
                    return p
    return None


def ask_asar():
    if not sys.stdin.isatty():
        return None
    try:
        s = input(L("未自动找到 ZCode，请输入 app.asar 完整路径（回车取消）: ",
                    "ZCode was not found automatically. Enter the full path to app.asar (Enter to cancel): ")).strip('" ')
    except (EOFError, KeyboardInterrupt):
        return None
    p = Path(s)
    return p if p.is_file() else None


def find_installed_asar(explicit=None):
    """卸载时定位 asar：--asar > config 记住的安装位置（数据目录与仓库 config 都查）> 自动探测 > 询问。"""
    if explicit:
        return Path(explicit)
    for cfg in (DATA_DIR / "config.json", HERE / "config.json"):
        try:
            p = json.loads(cfg.read_text(encoding="utf-8")).get("asar_path")
            if p and Path(p).is_file():
                return Path(p)
        except (OSError, ValueError):
            pass
    return find_asar() or ask_asar()


def update_runtime_config(runtime, changes, defaults=None):
    runtime = Path(runtime)
    runtime.mkdir(parents=True, exist_ok=True)
    chown_to_user(runtime)
    try:
        return update_config(runtime, changes, defaults)
    finally:
        for name in ("config.json", "plugin-config.lock"):
            if (runtime / name).exists():
                chown_to_user(runtime / name)


def remember_asar(asar, dev):
    """安装后把 asar 路径记进 config.json 的 asar_path 字段（其余组件忽略未知字段），
    之后的安装/卸载免传 --asar。config 定位与 load_lang_from_config 同款（--dev 在仓库目录）。"""
    cfg = HERE / "config.json" if dev else DATA_DIR / "config.json"
    try:
        changed = update_runtime_config(cfg.parent, {"asar_path": str(asar)})
    except (OSError, ValueError, TimeoutError):
        print(L(f"[配置] 保留不可更新的 {cfg}", f"[config] keeping config that could not be updated: {cfg}"))
        return
    if changed:
        print(L(f"[目标] 已记住安装位置 → {cfg}", f"[target] install location remembered -> {cfg}"))


def chown_to_user(path):
    """sudo 运行时把产物归还给真实用户（数据目录、config、注册文件）；
    asar 属系统安装（root 所有），保持原属主不动。非 sudo 是 no-op。"""
    sudo_user = _sudo_user()
    if not sudo_user:
        return
    try:
        import pwd
        st = pwd.getpwnam(sudo_user)
        os.chown(path, st.pw_uid, st.pw_gid)
    except (KeyError, OSError, AttributeError):
        pass


def copy_runtime(dry):
    """复制运行时清单（RUNTIME_FILES = runtime_lock.RUNTIME_FILE_NAMES 白名单）到数据目录
    （无条件覆盖：副本 mtime 变化会让 loader 热重载 renderer/Python 子模块）。
    可缺失文件（OPTIONAL_RUNTIME_FILES，如 zusage.py/usage_stats.py 尚未产出）跳过不阻塞；
    核心内核文件缺失按硬错误（fail-closed，绝不半装内核）。"""
    missing = [name for name in RUNTIME_FILES if not runtime_source(name).is_file()]
    core_missing = [name for name in missing if name not in OPTIONAL_RUNTIME_FILES]
    assert not core_missing, L(
        "缺少运行时文件：" + ", ".join(str(runtime_source(name)) for name in core_missing),
        "Missing runtime files: " + ", ".join(str(runtime_source(name)) for name in core_missing))
    copying = len(RUNTIME_FILES) - len(missing)
    skipped_note = L(
        f"（跳过未产出的可选文件 {len(missing)} 个：{', '.join(missing)}）",
        f" (skipping {len(missing)} optional files not produced yet: {', '.join(missing)})") if missing else ""
    print(L(f"[运行时] 复制 {copying} 个文件 → {DATA_DIR}",
            f"[runtime] copying {copying} files -> {DATA_DIR}") + skipped_note)
    if not dry:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        chown_to_user(DATA_DIR)
        for name in RUNTIME_FILES:
            src = runtime_source(name)
            if not src.is_file():
                continue   # OPTIONAL：已在上面统计并提示
            shutil.copy2(src, DATA_DIR / name)
            chown_to_user(DATA_DIR / name)
    return True


def prepare_config(dry, dev):
    """config.json：已存在沿用；缺失时仓库有旧配置则迁移（保留 python_path），否则按模板生成。
    标准安装落在数据目录，--dev 落在仓库目录（与旧版行为一致）。
    显式给出 --lang 时写回 config（CLI/MCP 等组件沿用同一语言）。"""
    cfg = HERE / "config.json" if dev else DATA_DIR / "config.json"
    if cfg.exists():
        if args_lang:
            if not dry:
                try:
                    update_runtime_config(cfg.parent, {"lang": LANG})
                except (OSError, ValueError, TimeoutError):
                    pass
            print(L(f"[配置] 沿用已有 {cfg}（lang = {LANG}）", f"[config] keeping {cfg} (lang = {LANG})"))
        else:
            print(L(f"[配置] 沿用已有 {cfg}", f"[config] keeping existing {cfg}"))
        return True
    if not dev and (HERE / "config.json").exists():
        print(L(f"[配置] 迁移旧配置 {HERE / 'config.json'} → {cfg}",
                f"[config] migrating old config {HERE / 'config.json'} -> {cfg}"))
        if not dry:
            try:
                migrated = json.loads((HERE / "config.json").read_text(encoding="utf-8"))
                if not isinstance(migrated, dict):
                    raise ValueError("config.json is not an object")
                update_runtime_config(cfg.parent, {}, migrated)
            except (OSError, ValueError, TimeoutError):
                return False
        return True
    vals = {
        "python_path": sys.executable,
        "activity_min_ms": 1500,
        "heartbeat_ms": 30000,
        "hot_reload": True,
        "context_window": 1000000,
        "lang": LANG,
    }
    print(L(f"[配置] 生成 {cfg}（python_path = {sys.executable}）",
            f"[config] generating {cfg} (python_path = {sys.executable})"))
    if not dry:
        cfg.parent.mkdir(parents=True, exist_ok=True)
        chown_to_user(cfg.parent)
        update_runtime_config(cfg.parent, {}, vals)
        chown_to_user(cfg)
    return True


def _write_host_config_atomic(text):
    """宿主 config.json 同目录临时文件 + os.replace 原子替换：截断写中途崩溃/断电
    会损坏宿主 CLI 自身配置；备份只留副本不会自动恢复，原子替换消除该窗口。
    替换后按原文件 mode 归位（umask 会让新文件偏离原权限，如 0600 被放宽）。"""
    tmp = ZCODE_CONFIG.with_name(ZCODE_CONFIG.name + ".zstatusbar.tmp")
    tmp.write_text(text, encoding="utf-8")
    mode = None
    try:
        mode = stat.S_IMODE(ZCODE_CONFIG.stat().st_mode)
    except OSError:
        pass
    try:
        os.replace(tmp, ZCODE_CONFIG)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
    if mode is not None:
        try:
            os.chmod(ZCODE_CONFIG, mode)
        except OSError:
            pass


def _string_values(obj):
    """遍历任意 JSON 值里的全部字符串（旧 MCP 注册迁移用：不能 json.dumps 后做子串
    匹配——反斜杠会被转义成 \\\\，Windows 路径永不命中，旧注册会残留）。"""
    if isinstance(obj, dict):
        for v in obj.values():
            yield from _string_values(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _string_values(v)
    elif isinstance(obj, str):
        yield obj


def register_mcp(dry, dev):
    """向 ~/.zcode/cli/config.json 注册 MCP server（同名覆盖即更新指向；
    旧名 token-usage/zusage 仅当指向本工具（仓库或数据目录）时迁移删除）。
    适配差异：本形态是纯状态条（零 MCP 查询服务），usage_mcp.py 缺席时跳过注册
    不阻塞安装；文件存在（未来补齐）时自动启用。"""
    usage_mcp = HERE / "usage_mcp.py" if dev else DATA_DIR / "usage_mcp.py"
    if not usage_mcp.is_file():
        print(L("[MCP] 本版本不带 MCP 查询服务（usage_mcp.py 缺席），跳过注册。",
                "[mcp] no MCP query service in this build (usage_mcp.py absent); skipping registration."))
        return True
    entry = {"command": sys.executable, "args": [str(usage_mcp)]}
    if not ZCODE_CONFIG.is_file():
        data = {"mcp": {"servers": {}}}
    else:
        try:
            data = json.loads(ZCODE_CONFIG.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            print(L(f"[MCP] 跳过：{ZCODE_CONFIG} 不是有效 JSON（{e}），请手动注册。",
                    f"[mcp] skipped: {ZCODE_CONFIG} is not valid JSON ({e}); register manually."))
            return False
        if not isinstance(data, dict):
            print(L(f"[MCP] 跳过：{ZCODE_CONFIG} 是合法 JSON 但不是对象，拒绝改写（不做默默重建）。",
                    f"[mcp] skipped: {ZCODE_CONFIG} is valid JSON but not an object; refusing to rewrite (no silent rebuild)."))
            return False
    mcp = data.get("mcp")
    if mcp is not None and not isinstance(mcp, dict):
        print(L(f"[MCP] 跳过：{ZCODE_CONFIG} 的 mcp 段不是对象，拒绝改写。",
                f"[mcp] skipped: the mcp section of {ZCODE_CONFIG} is not an object; refusing to rewrite."))
        return False
    if mcp is None:
        mcp = data["mcp"] = {}
    servers = mcp.get("servers")
    if servers is not None and not isinstance(servers, dict):
        print(L(f"[MCP] 跳过：{ZCODE_CONFIG} 的 mcp.servers 段不是对象，拒绝改写。",
                f"[mcp] skipped: the mcp.servers section of {ZCODE_CONFIG} is not an object; refusing to rewrite."))
        return False
    if servers is None:
        servers = mcp["servers"] = {}
    servers[MCP_NAME] = entry
    ours = (str(HERE / "usage_mcp.py"), str(DATA_DIR / "usage_mcp.py"))
    removed = []
    for old_name in MCP_NAME_OLD:
        old = servers.get(old_name)
        if isinstance(old, dict) and any(p in s for s in _string_values(old) for p in ours):
            del servers[old_name]      # 旧注册指向本工具 → 迁移到新名字
            removed.append(old_name)
    removed_note = L(f"（同时移除旧注册 {', '.join(removed)}）", f" (also removed old registration {', '.join(removed)})") if removed else ""
    print(L(f"[MCP] 注册 {MCP_NAME} → {usage_mcp}", f"[mcp] registering {MCP_NAME} -> {usage_mcp}") + removed_note)
    if not dry:
        ZCODE_CONFIG.parent.mkdir(parents=True, exist_ok=True)
        chown_to_user(ZCODE_CONFIG.parent)
        if ZCODE_CONFIG.is_file():
            shutil.copy2(ZCODE_CONFIG, ZCODE_CONFIG.with_suffix(".json.zstatusbar.bak"))
        _write_host_config_atomic(json.dumps(data, indent=2, ensure_ascii=False))
        chown_to_user(ZCODE_CONFIG)
    return True


def install_command(dry):
    """复制 /usage 命令模板到 ~/.zcode/commands/usage.md。
    适配差异：模板缺席（纯状态条形态）时跳过不阻塞。"""
    src = HERE / "usage.command.md"
    if not src.is_file():
        print(L("[命令] 本版本不带 /usage 命令模板，跳过。",
                "[command] no /usage command template in this build; skipping."))
        return True
    dst = COMMANDS_DIR / "usage.md"
    print(L(f"[命令] {dst}", f"[command] {dst}"))
    if not dry:
        COMMANDS_DIR.mkdir(parents=True, exist_ok=True)   # dry-run 承诺不写任何文件（含建目录）
        shutil.copy2(src, dst)
        chown_to_user(COMMANDS_DIR)
        chown_to_user(dst)
    return True


def remove_mcp(dry):
    if not ZCODE_CONFIG.is_file():
        return True
    try:
        data = json.loads(ZCODE_CONFIG.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return True
    if not isinstance(data, dict):
        print(L(f"[MCP] 跳过：{ZCODE_CONFIG} 是合法 JSON 但不是对象，拒绝改写。",
                f"[mcp] skipped: {ZCODE_CONFIG} is valid JSON but not an object; refusing to rewrite."))
        return False
    mcp = data.get("mcp")
    servers = mcp.get("servers") if isinstance(mcp, dict) else None
    if not isinstance(servers, dict):
        if "mcp" in data:
            print(L(f"[MCP] 跳过：mcp/mcp.servers 段不是对象，拒绝改写。",
                    f"[mcp] skipped: the mcp/mcp.servers section is not an object; refusing to rewrite."))
        return True   # 无可移除项/结构异常不阻塞卸载其余步骤
    gone = []
    for name in (MCP_NAME, *MCP_NAME_OLD):
        if name in servers:
            del servers[name]
            gone.append(name)
    if not gone:
        return True
    print(L(f"[MCP] 移除注册：{', '.join(gone)}", f"[mcp] removing registration: {', '.join(gone)}"))
    if not dry:
        shutil.copy2(ZCODE_CONFIG, ZCODE_CONFIG.with_suffix(".json.zstatusbar.bak"))
        _write_host_config_atomic(json.dumps(data, indent=2, ensure_ascii=False))
    return True


def remove_command(dry):
    dst = COMMANDS_DIR / "usage.md"
    if dst.is_file():
        print(L(f"[命令] 删除 {dst}", f"[command] deleting {dst}"))
        if not dry:
            dst.unlink()
    return True


def remove_data_dir(dry):
    """删除标准数据目录（运行时副本+配置+诊断）。--dev 安装没有数据目录，此处自然跳过。"""
    if not DATA_DIR.exists():
        return True
    print(L(f"[数据] 删除数据目录 {DATA_DIR}", f"[data] deleting data directory {DATA_DIR}"))
    if not dry:
        shutil.rmtree(DATA_DIR)
    return True


def main():
    global LANG, args_lang
    # 轻量预解析：--help 打印时 LANG 必须已定，否则帮助文本恒为中文
    pre = argparse.ArgumentParser(add_help=False)
    pre.add_argument("--lang", choices=("zh", "en"))
    pre.add_argument("--dev", action="store_true")
    pre_args, _ = pre.parse_known_args()
    LANG = pre_args.lang or load_lang_from_config(pre_args.dev) or "zh"

    ap = argparse.ArgumentParser(description=L("ZCode 状态条 一键安装",
                                               "ZCode statusbar one-shot installer"))
    ap.add_argument("--asar", help=L("app.asar 完整路径（默认自动探测；也可传 --root 指向安装目录）",
                                     "full path to app.asar (auto-detected by default; or use --root for the install directory)"))
    ap.add_argument("--root", help=L("ZCode 根目录（如 D:\\Apps\\ZCode 或 ZCode.app；自动接上平台固定的 resources/app.asar）",
                                     "ZCode root directory (e.g. D:\\Apps\\ZCode or ZCode.app; the platform-fixed resources/app.asar is appended)"))
    ap.add_argument("--no-mcp", action="store_true", help=L("跳过 MCP 注册与 /usage 命令", "skip MCP registration and the /usage command"))
    ap.add_argument("--dev", action="store_true", help=L("开发模式：不复制运行时，注入直指本仓库目录（配置/诊断留在仓库）",
                                                         "dev mode: no runtime copy; injection points at this repo (config/diagnostics stay in the repo)"))
    ap.add_argument("--remove", action="store_true", help=L("卸载", "uninstall"))
    ap.add_argument("--dry-run", action="store_true", help=L("只打印动作不落盘", "print actions without writing anything"))
    ap.add_argument("--lang", choices=("zh", "en"), default=None,
                    help=L("输出语言（默认 zh；写入 config.json 供 CLI/MCP 沿用）",
                           "output language (default zh; written to config.json for CLI/MCP)"))
    args = ap.parse_args()
    args_lang = args.lang
    if args.lang:   # 显式 --lang 优先于 config.json（预解析阶段已按 config 确定过一次默认值）
        LANG = args.lang

    import patch_install as pi   # 同目录，脚本式导入即可

    if args.remove:
        # 适配差异（design §5 单一卸载入口 + 缺口③）：卸载不再就地 pi.remove() 后
        # 无条件删目录，而是收敛到 uninstall.run_uninstall——引擎补丁 restore（缺口①）
        # → ZIP 预注入撤销（缺口②）→ 渲染桥/asar 注入行剥离；报告 ok=False（通常为
        # asar 剥离失败）时保留数据目录与 state 文件并输出修复指引，绝不"失败也删目录"。
        if args.dry_run:
            print(L("[卸载] （dry-run）引擎 restore + ZIP 预注入撤销 + 剥离 asar 注入行/渲染桥 + 清理 MCP 注册与 /usage 命令 + 删除数据目录",
                    "[uninstall] (dry-run) engine restore + pending-zip undo + strip asar injection line/renderer bridge + MCP & /usage command cleanup + data dir removal"))
            return 0
        asar = find_installed_asar(args.asar)
        if asar and asar.is_file():
            print(L(f"[目标] {asar}", f"[target] {asar}"))
        else:
            asar = None
            print(L("[卸载] 未找到 app.asar（ZCode 可能已卸载或换了位置），跳过 asar 剥离，仅清理注册与数据。",
                    "[uninstall] app.asar not found (ZCode may be uninstalled or relocated); skipping the asar strip, cleaning registration & data only."))
        # 运行目录：标准安装的副本与状态文件（引擎哨兵/ZIP 撤销清单）在数据目录；
        # --dev 或纯仓库卸载回退脚本目录。
        import uninstall   # 同目录，脚本式导入
        report = uninstall.run_uninstall(asar=asar, runtime=DATA_DIR if DATA_DIR.is_dir() else HERE)
        ok = report["ok"]
        for command in report.get("repair", []):
            print(L("[修复指引] ", "[repair] ") + command)
        if args.no_mcp:
            return 0 if ok else 1
        if not ok:
            # 缺口③：未收敛就不清注册/不删数据目录——悬空注入行待修复，配置/统计留给重装（AC7）
            print(L("卸载未完全收敛：数据目录已保留（修复指引见上），注册与数据目录未清理。",
                    "Uninstall did not fully converge: the data directory is KEPT (see repair guidance above); registration and the data dir were not cleaned."))
            return 1
        remove_mcp(args.dry_run)
        remove_command(args.dry_run)
        remove_data_dir(args.dry_run)
        print(L("卸载完成。", "Uninstall complete."))
        return 0

    asar = normalize_asar_arg(args.root, "root") if args.root else (
        normalize_asar_arg(args.asar) if args.asar else (find_asar() or ask_asar()))
    if not asar or not asar.is_file():
        if sys.platform == "win32":
            example = r"--root D:\Apps\ZCode"
        elif sys.platform.startswith("linux"):
            example = "--root /opt/ZCode"
        else:
            example = "--root /Applications/ZCode.app"
        print(L(f"找不到 app.asar。用 --root 指向 ZCode 安装目录，例如：python install.py {example}",
                f"app.asar not found. Point --root at the ZCode install directory, e.g.: python install.py {example}"))
        print(L("（也可用 --asar 指定 app.asar 完整路径）",
                "(or specify the full app.asar path with --asar)"))
        return 1
    print(L(f"[目标] {asar}", f"[target] {asar}"))
    if (sys.platform != "win32" and os.geteuid() != 0
            and not os.access(asar, os.W_OK)):
        hint = " ".join(sys.argv[1:])
        print(L(f"[权限] {asar.parent} 不可写（系统级安装位置，Linux 上常见），需要 sudo：",
                f"[permission] {asar.parent} is not writable (a system-level install location, common on Linux); sudo is required:"))
        print(L(f"  sudo {Path(sys.executable).name} {Path(__file__).name} {hint}".rstrip(),
                f"  sudo {Path(sys.executable).name} {Path(__file__).name} {hint}".rstrip()))
        print(L("（数据目录/MCP 注册会自动落到你的用户家目录，产物归属普通用户；asar 本身保持 root 属主）",
                "(the data dir / MCP registration go to your real user home with user ownership; the asar keeps its root ownership)"))
        if not args.dry_run:
            return 1
    if not args.dry_run:
        pi.set_target(asar)
        if not args.dev:
            pi.set_runtime(DATA_DIR)   # 注入行指向数据目录副本（泵在副本目录自洽运行）

    if not args.dev:
        copy_runtime(args.dry_run)
    prepare_config(args.dry_run, args.dev)
    if args.dry_run:
        print(L("[注入] （dry-run）python patch_install.py install",
                "[inject] (dry-run) python patch_install.py install"))
        ok = True
    else:
        ok = pi.install()
        remember_asar(asar, args.dev)   # 无论注入是否收尾成功都记住（卸载/收尾要用）
    if not ok:
        # 收尾/重试命令指向运行目录副本并带上本次目标：clone 被删/移动后提示仍可执行
        # （issue #163；--dev 时运行目录即本仓库，同一文件），standalone 不读 config
        # 里记住的 asar_path，非默认安装位置必须显式给 --asar。
        tool = HERE / "patch_install.py" if args.dev else DATA_DIR / "patch_install.py"
        print(L(f'asar 注入未完成，MCP/命令部分仍会继续（可稍后重跑：python "{tool}" install --asar "{asar}"）。',
                f'asar injection did not finish; MCP/command parts will continue (re-run later: python "{tool}" install --asar "{asar}").'))
    if not args.no_mcp:
        register_mcp(args.dry_run, args.dev)
        install_command(args.dry_run)
    print("\n" + L("全部完成。重启 ZCode 后输入框下方出现状态条。",
                   "All done. After restarting ZCode the floating bar appears at the bottom of the window; use /usage in chat to query."))
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
