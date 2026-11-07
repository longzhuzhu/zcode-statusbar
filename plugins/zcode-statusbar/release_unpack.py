#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Validate a release asset completely before unpacking it into a new directory.

zcode-statusbar 内核移植版。相对原插件差异：
  * PLUGIN/PLUGIN_ID/资产命名/市场名改为 zcode-statusbar 体系；
  * 仓库布局变为「marketplace.json + LICENSE + core/<运行时文件> +
    plugins/zcode-statusbar/<清单与 hooks>」：layout_path 相应放行 core/ 顶层文件
    （仅白名单扩展名，且排除发布工程工具）；BOOTSTRAP_FILES 同步更新；
  * manifest 未声明 commands/skills 时不再强制存在（本插件无命令中心/技能目录）。
校验链（尺寸/比率/本地头复核/身份一致性/原子落盘）原样保留。
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import stat
import struct
import sys
import unicodedata
import zipfile
import zlib

PLUGIN = "zcode-statusbar"
CORE = "core"
PREFIX = "plugins/" + PLUGIN + "/"
CORE_PREFIX = CORE + "/"
PLUGIN_ID = PLUGIN + "@zcode-statusbar-marketplace"
MAX_JSON = 256 * 1024
MAX_ARCHIVE = 16 * 1024 * 1024
MAX_TOTAL = 64 * 1024 * 1024
MAX_FILE = 8 * 1024 * 1024
MAX_ENTRIES = 1000
MAX_RATIO = 1000
SEMVER = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
# 插件目录内允许的文件（清单/hooks/README；运行时文件都在 core/）
PLUGIN_FILES = (
    ".zcode-plugin/plugin.json", ".claude-plugin/plugin.json",
    "hooks/hooks.json", "hooks/session-start.py", "README.md",
)
# core/ 运行时文件白名单：与 runtime_lock.RUNTIME_FILE_NAMES 对齐（按名维护，
# 不 import——解包器运行于发布包校验环境，必须自洽）。改动白名单必须两边同步：
# 本文件与 runtime_lock.py，漏一边会导致发布包校验文件集与运行时同步清单不一致。
CORE_FILES = (
    "runtime_lock.py", "patch_install.py", "install_monitor.py", "pending_zip_patch.py",
    "renderer_bridge.py", "release_unpack.py", "restart_notice.py", "plugin_auto_update.py",
    "uninstall.py", "install.py", "runtime_install.py",
    "inject-main.cjs", "engine-patch.cjs", "plugin-updater.cjs", "plugin-release.cjs",
    "plugin-storage.cjs", "statusbar-bridge.js",
    "turn-stats.js", "ramp.js", "statusbar.js", "session-stats.cjs",
    "zusage.py", "usage_stats.py",
)
ALLOWED_FILES = frozenset(
    ("marketplace.json", "LICENSE")
    + tuple(PREFIX + name for name in PLUGIN_FILES)
    + tuple(CORE_PREFIX + name for name in CORE_FILES)
)
ALLOWED_DIRS = frozenset(parent for name in ALLOWED_FILES
                         for parent in ("/".join(name.split("/")[:i])
                                        for i in range(1, len(name.split("/")))))
# Official releases are complete products, not reduced test fixtures: omitted runtime
# dependencies can pass identity checks but fail when installed.
REQUIRED_FILES = ALLOWED_FILES
BOOTSTRAP_FILES = frozenset(("marketplace.json", "LICENSE") + tuple(PREFIX + name for name in (
    ".zcode-plugin/plugin.json",
    "hooks/hooks.json", "hooks/session-start.py",
)) + tuple(CORE_PREFIX + name for name in (
    "runtime_install.py", "inject-main.cjs", "patch_install.py", "runtime_lock.py",
    "plugin-updater.cjs", "plugin-release.cjs", "plugin-storage.cjs",
    "release_unpack.py", "uninstall.py",
)))


def layout_path(name, is_dir=False):
    if name in (ALLOWED_DIRS if is_dir else ALLOWED_FILES):
        return True
    if name.startswith(CORE_PREFIX) and not is_dir:
        relative = name[len(CORE_PREFIX):]
        # core/ 顶层源码文件：仅白名单扩展名，且排除发布工程工具（release_tool 等
        # 不进分发链）；目录一律拒绝（core/ 无子目录布局）。
        return bool("/" not in relative
                    and re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*\.(?:py|cjs|js)", relative)
                    and relative not in ("release_tool.py", "sync_plugin.py"))
    if not name.startswith(PREFIX):
        return False
    relative = name[len(PREFIX):]
    if is_dir:
        return relative in ("hooks", ".zcode-plugin", ".claude-plugin")
    if "/" not in relative:
        return bool(re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]*", relative)
                    and (relative.endswith(".md") or relative == "LICENSE"))
    return bool(re.fullmatch(r"hooks/[A-Za-z][A-Za-z0-9_-]*\.py", relative)
                or relative in (".zcode-plugin/plugin.json", ".claude-plugin/plugin.json"))


def release_files(data):
    manifest = json_object(data[PREFIX + ".zcode-plugin/plugin.json"], "plugin manifest")
    layout = manifest.get("packageLayout")
    if layout is None:
        require(set(data) == REQUIRED_FILES, "ZIP is missing required release files")
        return
    require(isinstance(layout, dict) and type(layout.get("schemaVersion")) is int and layout["schemaVersion"] == 1,
            "unsupported package layout schema")
    names = layout.get("files")
    require(isinstance(names, list) and all(isinstance(name, str) for name in names)
            and len(names) == len(set(names)), "invalid package layout files")
    files = set(names)
    require(files == set(data) and BOOTSTRAP_FILES <= files and all(layout_path(name) for name in files),
            "package layout is incomplete or outside the bootstrap contract")


class UnpackError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise UnpackError(message)


def absolute_path(value):
    path = Path(value)
    require(path.is_absolute(), "archive, manifest and output paths must be absolute")
    return path


def read_bounded(path, limit):
    require(not path.is_symlink(), "input must not be a symlink: " + str(path))
    with path.open("rb") as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_size <= limit,
                "input is not a regular bounded file: " + str(path))
        data = stream.read(limit + 1)
    require(len(data) <= limit, "input exceeds size limit: " + str(path))
    return data


def json_object(data, name):
    require(len(data) <= MAX_JSON, "JSON exceeds 256KB: " + name)

    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate JSON key in " + name)
            result[key] = value
        return result

    def invalid_constant(value):
        raise UnpackError("invalid JSON constant in " + name + ": " + value)

    value = json.loads(data.decode("utf-8"), object_pairs_hook=pairs,
                       parse_constant=invalid_constant)
    require(isinstance(value, dict), "JSON must be an object: " + name)
    return value


def stable_version(value):
    require(isinstance(value, str) and len(value) <= 64 and re.fullmatch(SEMVER, value),
            "version must be a numeric three-part stable version")
    return value


def repository(value):
    require(isinstance(value, str) and len(value) <= 140 and re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}", value),
        "repository must be explicit owner/repo")
    return value


def release_manifest(data, archive_name, expected_repository, expected_version):
    manifest = json_object(data, "release manifest")
    require(type(manifest.get("schemaVersion")) is int and manifest["schemaVersion"] == 1,
            "unsupported release manifest schema")
    require(repository(manifest.get("repository")).lower() == expected_repository.lower(),
            "release repository disagrees with expected source")
    require(stable_version(manifest.get("version")) == expected_version,
            "release version disagrees with expected version")
    require(manifest.get("tag") == "v" + expected_version and
            manifest.get("pluginId") == PLUGIN_ID, "release tag/plugin identity disagrees")
    if "sourceCommit" in manifest:
        commit = manifest["sourceCommit"]
        require(isinstance(commit, str) and re.fullmatch(r"[0-9a-fA-F]{40}", commit),
                "invalid sourceCommit")
    asset = manifest.get("asset")
    require(isinstance(asset, dict), "release asset must be an object")
    require(asset.get("name") == archive_name == PLUGIN + "-v" + expected_version + ".zip",
            "release asset basename disagrees")
    require(type(asset.get("size")) is int and 0 < asset["size"] <= MAX_ARCHIVE,
            "release asset size exceeds bound or is invalid")
    digest = asset.get("sha256")
    require(isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest),
            "invalid release asset sha256")
    return asset


def member_path(member):
    name = member.orig_filename
    require(name == member.filename and name and name.isascii() and
            "\\" not in name and ":" not in name and "\x00" not in name,
            "unsafe ZIP path: " + repr(name))
    path = name[:-1] if name.endswith("/") else name
    parts = path.split("/")
    for part in parts:
        require(part not in ("", ".", "..") and not part.endswith((".", " ")) and
                not any(ord(char) < 32 or char in '<>"|?*' for char in part),
                "unsafe ZIP component: " + repr(name))
        require(not re.fullmatch(r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])",
                                 part.split(".", 1)[0], re.I),
                "Windows device path: " + repr(name))
    return path


def declared_resources(manifest, data):
    for component in ("commands", "skills"):
        values = manifest.get(component)
        if values is None:
            continue   # 本插件可未声明命令/技能目录（裁剪项），声明了才校验
        values = [values] if isinstance(values, str) else values
        require(isinstance(values, list) and values, "missing declared " + component)
        for value in values:
            require(isinstance(value, str), "invalid declared " + component)
            relative = value[2:] if value.startswith("./") else value
            require(relative == component or relative.startswith(component + "/"),
                    "unsafe declared " + component + " path")
            name = PREFIX + relative
            require(name in data or any(key.startswith(name + "/") for key in data),
                    "non-whitelisted declared resource: " + value)
            if name in data:
                require(name in data and (name.endswith(".md") if component == "commands"
                                         else name.endswith("/SKILL.md")),
                        "missing declared resource: " + value)
            else:
                suffix = ".md" if component == "commands" else "/SKILL.md"
                require(any(key.startswith(name + "/") and key.endswith(suffix) for key in data),
                        "empty declared resource directory: " + value)


def referenced_resources(value, data, literal=False):
    if isinstance(value, dict):
        structured = isinstance(value.get("args"), list)
        for key, item in value.items():
            referenced_resources(item, data, key == "args" or (key == "command" and structured))
    elif isinstance(value, list):
        for item in value:
            referenced_resources(item, data, True)
    elif isinstance(value, str) and "${ZCODE_PLUGIN_ROOT}" in value:
        tokens = [value] if literal else shlex.split(value)
        for token in tokens:
            if "${ZCODE_PLUGIN_ROOT}" not in token:
                continue
            require(token.startswith("${ZCODE_PLUGIN_ROOT}/") and
                    (PREFIX + token[len("${ZCODE_PLUGIN_ROOT}/"):] in data or
                     CORE_PREFIX + token[len("${ZCODE_PLUGIN_ROOT}/"):] in data),
                    "missing or unsafe declared plugin resource: " + token)


def identities(data, version):
    market = json_object(data["marketplace.json"], "marketplace.json")
    plugin = json_object(data[PREFIX + ".zcode-plugin/plugin.json"], "plugin manifest")
    compatibility = json_object(data[PREFIX + ".claude-plugin/plugin.json"], "compatibility manifest")
    require(json.dumps(plugin, sort_keys=True) == json.dumps(compatibility, sort_keys=True),
            "plugin manifests disagree")
    require(plugin.get("name") == PLUGIN and stable_version(plugin.get("version")) == version,
            "plugin name/version disagrees")
    require(market.get("name") == "zcode-statusbar-marketplace", "marketplace identity disagrees")
    entries = market.get("plugins")
    require(isinstance(entries, list) and len(entries) == 1 and isinstance(entries[0], dict),
            "marketplace must contain exactly one plugin")
    entry = entries[0]
    require(entry.get("name") == PLUGIN and entry.get("version") == version and
            entry.get("source") in ("./plugins/" + PLUGIN, "plugins/" + PLUGIN),
            "marketplace plugin name/version/source disagrees")
    declared_resources(plugin, data)
    for name, content in data.items():
        if name.endswith(".json"):
            referenced_resources(json_object(content, name), data)


def local_member(payload, member):
    offset = member.header_offset
    require(0 <= offset <= len(payload) - 30, "invalid ZIP local header offset")
    require(payload[offset:offset + 4] == b"PK\x03\x04", "invalid ZIP local header")
    flags, method = struct.unpack_from("<HH", payload, offset + 6)
    crc, compressed, size = struct.unpack_from("<III", payload, offset + 14)
    name_length, extra_length = struct.unpack_from("<HH", payload, offset + 26)
    start = offset + 30 + name_length + extra_length
    require(start + member.compress_size <= len(payload), "ZIP compressed range exceeds archive")
    local_name = payload[offset + 30:offset + 30 + name_length]
    require(local_name == member.filename.encode("ascii") and flags == member.flag_bits and
            method == member.compress_type, "ZIP local header name/flags/compression disagrees")
    if not flags & 8:
        require((crc, compressed, size) == (member.CRC, member.compress_size, member.file_size),
                "ZIP local header CRC/size disagrees")
    if method == zipfile.ZIP_DEFLATED:
        decoder = zlib.decompressobj(-15)
        content = decoder.decompress(payload[start:start + member.compress_size], MAX_FILE + 1)
        require(decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail and
                len(content) == member.file_size, "ZIP deflate stream/size disagrees")


def validate_zip(payload, version):
    data, seen, total = {}, set(), 0
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        members = archive.infolist()
        require(len(members) <= MAX_ENTRIES, "ZIP entry count exceeds limit")
        for member in members:
            path = member_path(member)
            canonical = unicodedata.normalize("NFC", path).casefold()
            require(canonical not in seen, "duplicate or colliding ZIP path: " + path)
            seen.add(canonical)
            is_dir = member.is_dir()
            require(layout_path(path, is_dir),
                    "non-whitelisted ZIP path: " + path)
            mode = stat.S_IFMT(member.external_attr >> 16)
            require(mode in (0, stat.S_IFDIR if is_dir else stat.S_IFREG) and
                    (is_dir or not member.external_attr & 0x10),
                    "ZIP contains a symlink/device or invalid directory")
            require(not member.flag_bits & 0x41 and member.compress_type in
                    (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
                    "encrypted or unsupported ZIP compression")
            require(0 <= member.file_size <= MAX_FILE and
                    0 <= member.compress_size <= len(payload), "ZIP file size exceeds limit")
            require(member.compress_type != zipfile.ZIP_STORED or
                    member.compress_size == member.file_size, "stored ZIP size disagrees")
            require(member.file_size <= max(member.compress_size, 1) * MAX_RATIO,
                    "ZIP compression ratio exceeds limit")
            require(not is_dir or member.file_size == 0, "nonempty ZIP directory")
            require(not path.endswith(".json") or member.file_size <= MAX_JSON,
                    "ZIP JSON exceeds 256KB")
            total += member.file_size
            require(total <= MAX_TOTAL, "ZIP extracted total exceeds limit")
        files = {member_path(member) for member in members if not member.is_dir()}
        require(BOOTSTRAP_FILES <= files, "ZIP is missing required release files")
        # Read every member (including directories) to validate CRC and advertised size.
        # No directory or package code is touched until every member and identity is valid.
        for member in members:
            local_member(payload, member)
            with archive.open(member) as stream:
                content = stream.read(MAX_FILE + 1)
                require(len(content) == member.file_size and not stream.read(1),
                        "ZIP actual size disagrees: " + member.filename)
            if not member.is_dir():
                data[member.filename] = content
    release_files(data)
    identities(data, version)
    return data


def unpack(archive, manifest, expected_repository, expected_version, output):
    archive, manifest, output = map(absolute_path, (archive, manifest, output))
    expected_repository = repository(expected_repository)
    expected_version = stable_version(expected_version)
    require(not os.path.lexists(str(output)), "output directory already exists")
    record = release_manifest(read_bounded(manifest, MAX_JSON), archive.name,
                              expected_repository, expected_version)
    payload = read_bounded(archive, MAX_ARCHIVE)
    require(len(payload) == record["size"] and hashlib.sha256(payload).hexdigest() == record["sha256"],
            "archive size/sha256 disagrees")
    data = validate_zip(payload, expected_version)
    # mkdir(exist_ok=False) also protects against another writer creating output during validation.
    output.mkdir()
    owned = output.stat()
    try:
        for name, content in data.items():
            destination = output / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open("xb") as stream:
                stream.write(content)
    except BaseException:
        try:
            current = output.lstat()
            if (current.st_dev, current.st_ino) == (owned.st_dev, owned.st_ino):
                shutil.rmtree(output)
        except OSError:
            pass
        raise
    return {"ok": True, "marketplaceRoot": str(output.resolve()),
            "pluginRoot": str((output / "plugins" / PLUGIN).resolve()),
            "coreRoot": str((output / CORE).resolve()),
            "version": expected_version}


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise UnpackError(message)


def main(argv=None):
    try:
        parser = Parser(description=__doc__)
        parser.add_argument("--archive", required=True)
        parser.add_argument("--manifest", required=True)
        parser.add_argument("--repository", required=True)
        parser.add_argument("--version", required=True)
        parser.add_argument("--output", required=True)
        args = parser.parse_args(argv)
        result = unpack(args.archive, args.manifest, args.repository, args.version, args.output)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ValueError, OSError, TypeError, RuntimeError, EOFError, RecursionError,
            zipfile.BadZipFile, zipfile.LargeZipFile, zlib.error) as error:
        print("release_unpack: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
