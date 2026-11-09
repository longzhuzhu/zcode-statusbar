"use strict";
/* Release 渠道元数据/下载/校验与更新日志服务（内核移植版）。
 * 相对原插件差异（均为插件身份改名，校验语义不变）：
 *   * PLUGIN_ID zcode-token-usage-statusbar@zusage-marketplace →
 *     zcode-statusbar@zcode-statusbar-marketplace；市场名/事务文件名/资产命名
 *     （zcode-statusbar-v<ver>.zip）/清单路径 plugins/zcode-statusbar 同步改名；
 *   * 删除 GitCode 镜像回退（NOTES_GITCODE_MIRROR）：镜像仓库是原插件私有资产，
 *     本插件尚未建立镜像；notes 拉取失败按原状态返回，由调用方降级展示。
 * 下载主机白名单、manifest/清单校验链、缓存 TTL 语义原样保留。 */
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");

const PLUGIN_ID = "zcode-statusbar@zcode-statusbar-marketplace";
const MARKETPLACE_NAME = "zcode-statusbar-marketplace";
// 本地目录/官方市场安装的 marketplace 注册名（仓库 marketplace.json 的 name）；
// readChannel 须同时识别 Release 布局与本地布局两种注册名。
const LOCAL_MARKETPLACE_NAME = "zcode-statusbar";
const MARKETPLACE_NAMES = [MARKETPLACE_NAME, LOCAL_MARKETPLACE_NAME];
const PLUGIN_NAME = "zcode-statusbar";
const PLUGIN_ZIP_PREFIX = "plugins/" + PLUGIN_NAME;
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_ASSET = 16 * 1024 * 1024;
const MAX_JSON = 256 * 1024;
// GitCode 形状于 2026-10-20 实测（原插件取证）：browser_download_url 为 GitHub 风格路径，
// 下载重定向到 file-cdn.gitcode.com；两台主机的形状都必须留在各自白名单里。
const RELEASE_HOSTS = {
  github: {
    assetUrl: /^https:\/\/github\.com\/([^/]+\/[^/]+)(\/releases\/download\/[^?#]+)$/,
    downloadHosts: ["api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"],
  },
  gitcode: {
    assetUrl: /^https:\/\/gitcode\.com\/([^/]+\/[^/]+)(\/releases\/download\/[^?#]+)$/,
    downloadHosts: ["gitcode.com", "file-cdn.gitcode.com"],
  },
};
const DOWNLOAD_HOSTS = Object.values(RELEASE_HOSTS).flatMap((host) => host.downloadHosts);

function githubRepository(value) {
  if (typeof value !== "string") return null;
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)?([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?\/?$/.exec(value);
  return match ? match[1] : null;
}
function gitcodeRepository(value) {
  if (typeof value !== "string") return null;
  const match = /^(?:https:\/\/gitcode\.com\/|ssh:\/\/git@gitcode\.com\/|git@gitcode\.com:)?([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?\/?$/.exec(value);
  return match ? match[1] : null;
}
function sameRepository(a, b) {
  return typeof a === "string" && typeof b === "string" && githubRepository(a) === a && githubRepository(b) === b && a.toLowerCase() === b.toLowerCase();
}
function parseAssetUrl(value) {
  if (typeof value !== "string") return null;
  for (const [host, profile] of Object.entries(RELEASE_HOSTS)) {
    const match = profile.assetUrl.exec(value);
    if (match) return { host, repository: match[1], path: match[2] };
  }
  return null;
}
function sameAssetUrl(actual, expected) {
  const a = parseAssetUrl(actual), b = parseAssetUrl(expected);
  return !!a && !!b && a.host === b.host && sameRepository(a.repository, b.repository) && a.path === b.path;
}
function readCatalog(root) {
  // 市场缓存清单只用来识别“源码清单”这一形态；事务进行中、缺失或损坏时按未知处理，
  // 由后续 Release 流程报出准确原因。注册名随安装来源布局不同，逐个探测。
  try {
    for (const name of MARKETPLACE_NAMES) {
      if (fs.existsSync(path.join(root, "marketplaces", "." + name + ".marketplace.transaction.json"))) return null;
      const file = path.join(root, "marketplaces", name, "marketplace.json");
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    return null;
  } catch (e) { return null; }
}
function readChannel(home, root = require("./plugin-storage.cjs").resolvePluginStorage(home)) {
  const file = path.join(root, "known_marketplaces.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const entries = data && data.marketplaces;
  if (!Array.isArray(entries)) throw new Error("插件市场来源记录无效");
  const matches = entries.filter((m) => m && (MARKETPLACE_NAMES.includes(m.id) || MARKETPLACE_NAMES.includes(m.name)));
  const market = matches.length === 1 ? matches[0] : null;
  if (!market || !market.source || typeof market.source !== "object") throw new Error(`未找到 ${MARKETPLACE_NAME} 的注册来源`);
  const source = market.source;
  if (source.source === "directory") return { kind: "local", marketplace: market };
  // 仓库来源但清单指向源码（默认分支的 ./plugins/... 路径源）时没有可校验的 Release：
  // 按 market 渠道交给宿主插件管理器直接更新，与本地目录来源同一条链。
  const kind = catalogChannel(readCatalog(root)) === "source" ? "market" : "release";
  if (source.source === "git") {
    const gitcode = gitcodeRepository(source.url);
    if (gitcode) return { kind, flavor: "gitcode", repository: gitcode, marketplace: market };
  }
  const repository = source.source === "github" ? githubRepository(source.repo || source.repository)
    : source.source === "git" ? githubRepository(source.url) : null;
  if (!repository) throw new Error("远端自动更新仅支持已注册的 GitHub/GitCode 仓库来源");
  return { kind, flavor: "github", repository, marketplace: market };
}
/* allowedHosts：更新日志拉取传 NOTES_API_HOSTS，把只读 API 域与资产下载域分开维护。 */
/* API 域要 JSON：GitCode v5 对 octet-stream 明确 400；vnd.github+json 在两家 API 均可用。 */
function releaseAcceptHeader(hostname) {
  return hostname === "api.github.com" ? "application/vnd.github+json"
    : hostname === "api.gitcode.com" ? "application/json"
    : "application/octet-stream";
}
async function fetchBytes(url, limit, onProgress, allowedHosts) {
  let activeRequest, activeResponse, timer, settled = false;
  return new Promise((resolve, reject) => {
    const finish = (error, bytes) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) {
        if (activeResponse) activeResponse.destroy();
        if (activeRequest) activeRequest.destroy(error);
        reject(error);
      } else resolve(bytes);
    };
    const visit = (target, redirects) => {
      try {
        const parsed = new URL(target);
        const allowed = parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.port &&
          (allowedHosts || DOWNLOAD_HOSTS).includes(parsed.hostname);
        if (!allowed) throw new Error("拒绝非 GitHub/GitCode HTTPS 更新地址");
        const request = https.get(parsed, { headers: { "User-Agent": PLUGIN_NAME + "-release-updater",
          "Accept": releaseAcceptHeader(parsed.hostname),
          "X-GitHub-Api-Version": "2022-11-28" } }, (response) => {
          if (settled) { response.destroy(); return; }
          activeResponse = response;
          response.on("error", (error) => finish(error));
          response.on("aborted", () => finish(new Error("发布资源下载中断")));
          if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            response.resume();
            if (!response.headers.location || redirects >= 3) { finish(new Error("下载重定向无效")); return; }
            try { visit(new URL(response.headers.location, parsed).href, redirects + 1); }
            catch (error) { finish(error); }
            return;
          }
          if (response.statusCode !== 200) {
            const statusError = new Error(`Release 请求失败 (${response.statusCode})`);
            statusError.status = response.statusCode;   // 更新日志按 404/403/429 分类
            finish(statusError); return;
          }
          const declared = Number(response.headers["content-length"] || 0);
          if (!Number.isSafeInteger(declared) || declared < 0 || declared > limit) { finish(new Error("发布资源超过大小上限")); return; }
          const chunks = []; let length = 0;
          response.on("data", (chunk) => {
            if (settled) return;
            length += chunk.length;
            if (length > limit) finish(new Error("发布资源超过大小上限"));
            else {
              chunks.push(chunk);
              if (typeof onProgress === "function") onProgress(length, declared);
            }
          });
          response.on("end", () => {
            if (!response.complete || (declared && declared !== length)) finish(new Error("发布资源下载不完整"));
            else finish(null, Buffer.concat(chunks));
          });
        });
        activeRequest = request;
        request.setTimeout(30000, () => finish(new Error("Release 请求超时")));
        request.on("error", (error) => finish(error));
      } catch (error) { finish(error); }
    };
    timer = setTimeout(() => finish(new Error("Release 请求超过总时限")), 60000);
    visit(url, 0);
  });
}
function releaseAssetUrl(repository, tag, name) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}
function validateRelease(release, repository) {
  if (!release || release.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string") return null;
  const version = release.tag_name.startsWith("v") ? release.tag_name.slice(1) : "";
  if (!STABLE.test(version)) return null;
  const names = [`${PLUGIN_NAME}-v${version}.zip`, "release-manifest.json"];
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const picked = names.map((name) => assets.filter((a) => a && a.name === name));
  if (picked.some((matches) => matches.length !== 1)) return null;
  const [archive, manifest] = picked.map((matches) => matches[0]);
  for (const asset of [archive, manifest]) {
    const limit = asset === archive ? MAX_ASSET : MAX_JSON;
    if (asset.state !== "uploaded" || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > limit ||
        !sameAssetUrl(asset.browser_download_url, releaseAssetUrl(repository, release.tag_name, asset.name))) throw new Error("GitHub Release 资产来源或大小无效");
  }
  return { flavor: "github", version, tag: release.tag_name, repository, archive, manifest,
    url: `https://github.com/${repository}/releases/tag/${encodeURIComponent(release.tag_name)}` };
}
async function checkRelease(repository, compareVersions, fetch = fetchBytes) {
  if (!githubRepository(repository) || repository !== githubRepository(repository)) throw new Error("GitHub 仓库标识无效");
  let best = null;
  for (let page = 1; page <= 10; page++) {
    const body = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`, 4 * 1024 * 1024);
    const rows = JSON.parse(body.toString("utf8"));
    if (!Array.isArray(rows)) throw new Error("GitHub Release 列表格式无效");
    for (const row of rows) {
      const candidate = validateRelease(row, repository);
      if (candidate && (!best || compareVersions(candidate.version, best.version) > 0)) best = candidate;
    }
    if (rows.length < 100) {
      if (!best) throw new Error("此 GitHub 仓库尚无带完整发布包的正式 Release，不能安装开发分支");
      return best;
    }
  }
  throw new Error("GitHub Release 列表超过安全分页上限，无法确定最新正式版本");
}
function catalogEntryFrom(catalog, repository, flavor, host) {
  // 清单兜底：API 匿名配额按出口 IP 共享（限流常见），而清单刷新走 zipball 下载桶不受限。
  // 从注册 ref 的渠道清单合成与 API 行同构的候选；清单 sha256 随 catalogSha256 保留。
  if (!githubRepository(repository) || repository !== githubRepository(repository)) throw new Error((flavor === "gitcode" ? "GitCode" : "GitHub") + " 仓库标识无效");
  const entries = catalog && catalog.plugins;
  const matches = Array.isArray(entries) ? entries.filter((p) => p && p.name === PLUGIN_NAME) : [];
  const entry = matches.length === 1 ? matches[0] : null;
  const source = entry && entry.source;
  if (!catalog || catalog.name !== MARKETPLACE_NAME || !entry || typeof entry.version !== "string" ||
      !STABLE.test(entry.version) || !source || typeof source !== "object" || source.source !== "url" ||
      source.type !== "zip" || typeof source.url !== "string" || source.headers !== undefined ||
      (source.stripRoot !== undefined && source.stripRoot !== false) ||
      source.path !== PLUGIN_ZIP_PREFIX ||
      typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error((flavor === "gitcode" ? "GitCode" : "GitHub") + " 渠道清单格式无效");
  const tag = "v" + entry.version;
  const archiveName = `${PLUGIN_NAME}-v${entry.version}.zip`;
  const expectedPath = `/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(archiveName)}`;
  const parsed = parseAssetUrl(source.url);
  if (!parsed || parsed.host !== flavor || !sameRepository(parsed.repository, repository) ||
      parsed.path !== expectedPath) throw new Error((flavor === "gitcode" ? "GitCode" : "GitHub") + " 渠道清单下载源与注册仓库或版本不一致");
  return {
    flavor, version: entry.version, tag, repository, catalogSha256: source.sha256,
    archive: { name: archiveName, size: flavor === "github" ? null : null, browser_download_url: flavor === "github" ? source.url : `https://gitcode.com/${repository}${expectedPath}` },
    manifest: { name: "release-manifest.json",
      browser_download_url: `https://${flavor === "github" ? "github.com" : "gitcode.com"}/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent("release-manifest.json")}` },
    url: `https://${flavor === "github" ? "github.com" : "gitcode.com"}/${repository}/releases/tag/${encodeURIComponent(tag)}` };
}
function githubReleaseFromCatalog(catalog, repository) {
  return catalogEntryFrom(catalog, repository, "github");
}
function gitcodeReleaseFromCatalog(catalog, repository) {
  return catalogEntryFrom(catalog, repository, "gitcode");
}
function validateCatalogRelease(release, flavor) {
  // 安装提交后复核清单兜底意图：与 catalogEntryFrom 同一形状门。
  const host = flavor === "gitcode" ? "gitcode.com" : "github.com";
  if (!release || release.flavor !== flavor || !githubRepository(release.repository) ||
      release.repository !== githubRepository(release.repository) || typeof release.version !== "string" ||
      !STABLE.test(release.version) || release.tag !== "v" + release.version ||
      typeof release.catalogSha256 !== "string" || !/^[a-f0-9]{64}$/.test(release.catalogSha256) || !release.archive ||
      release.archive.name !== `${PLUGIN_NAME}-v${release.version}.zip` ||
      release.archive.size !== null) return null;
  const archive = parseAssetUrl(release.archive.browser_download_url);
  const manifest = parseAssetUrl(release.manifest && release.manifest.browser_download_url);
  const downloadPath = `/releases/download/${encodeURIComponent(release.tag)}/`;
  let page = null;
  try { page = new URL(release.url); } catch (e) { }
  if (!archive || archive.host !== flavor || !sameRepository(archive.repository, release.repository) ||
      archive.path !== downloadPath + encodeURIComponent(release.archive.name) ||
      !manifest || manifest.host !== flavor || !sameRepository(manifest.repository, release.repository) ||
      manifest.path !== downloadPath + encodeURIComponent("release-manifest.json") ||
      !page || page.protocol !== "https:" || page.hostname !== host ||
      page.pathname !== `/${release.repository}/releases/tag/${encodeURIComponent(release.tag)}`) return null;
  return { ...release, version: release.version };
}
function validateGithubCatalogRelease(release) {
  return validateCatalogRelease(release, "github");
}
function validateGitcodeRelease(release) {
  return validateCatalogRelease(release, "gitcode");
}
function validateManifest(manifest, release) {
  const asset = manifest && manifest.asset;
  // GitCode 渠道的合成 release 行在下载 manifest 前拿不到资产大小（archive.size 为 null），
  // 大小以下载到的 manifest 为准；GitHub 渠道的 API 行始终带大小，逐项强校验。
  const repositoryOk = sameRepository(manifest.repository, release.repository) ||
    (release.flavor === "gitcode" && typeof manifest.repository === "string" &&
     githubRepository(manifest.repository) === manifest.repository);
  if (!manifest || manifest.schemaVersion !== 1 || !repositoryOk ||
      manifest.version !== release.version || manifest.tag !== release.tag || manifest.pluginId !== PLUGIN_ID || !asset ||
      asset.name !== release.archive.name || (release.archive.size !== null && asset.size !== release.archive.size) ||
      !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ASSET ||
      typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error("发布 manifest 与正式版本、来源或资源不一致");
  return manifest;
}
function unpack(command, args) {
  return new Promise((resolve, reject) => execFile(command, args,
    { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(new Error(String(stderr || error.message).trim().slice(0, 1000))); return; }
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error("发布包校验器未返回有效 JSON")); }
    }));
}
async function downloadRelease(release, python, fetch = fetchBytes, runUnpack = unpack, onProgress) {
  const report = typeof onProgress === "function" ? onProgress : () => { };
  const manifestBody = await fetch(release.manifest.browser_download_url, MAX_JSON);
  const manifest = validateManifest(JSON.parse(manifestBody.toString("utf8")), release);
  report({ stage: "download", loaded: 0, total: manifest.asset.size });
  const bytes = await fetch(release.archive.browser_download_url, MAX_ASSET,
    (loaded, total) => report({ stage: "download", loaded, total: total || manifest.asset.size }));
  if (bytes.length !== manifest.asset.size || crypto.createHash("sha256").update(bytes).digest("hex") !== manifest.asset.sha256) throw new Error("发布包下载大小或 SHA256 校验失败");
  report({ stage: "verify" });
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zcode-statusbar-release-")));
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    const archive = path.join(directory, release.archive.name), info = path.join(directory, "release-manifest.json");
    const output = path.join(directory, "marketplace");
    fs.writeFileSync(archive, bytes, { flag: "wx" }); fs.writeFileSync(info, manifestBody, { flag: "wx" });
    const result = await runUnpack(python, [path.join(__dirname, "release_unpack.py"), "--archive", archive,
      "--manifest", info, "--repository", release.flavor === "gitcode" ? manifest.repository : release.repository,
      "--version", release.version, "--output", output]);
    // 解包器返回 Path.resolve() 后的真实路径；Windows 上 os.tmpdir() 可能是 8.3 短路径，
    // 两侧字符串不等但指向同一目录，须按真实路径归一后再比。
    const canonical = (value) => { try { return fs.realpathSync.native(value); } catch (e) { return value; } };
    if (!result || result.ok !== true || result.version !== release.version ||
        canonical(result.marketplaceRoot) !== canonical(output) ||
        canonical(result.pluginRoot) !== canonical(path.join(output, "plugins", PLUGIN_NAME))) throw new Error("发布包校验或解压结果无效");
    return { directory, marketplaceRoot: output, pluginRoot: result.pluginRoot, release, manifest, cleanup };
  } catch (error) { cleanup(); throw error; }
}
/* 已注册市场的清单指向什么：Release 下载源，还是仓库源码（本地路径/开发分支）。 */
function catalogChannel(catalog, pluginName = PLUGIN_NAME) {
  const entries = catalog && catalog.plugins;
  const matches = Array.isArray(entries) ? entries.filter((p) => p && p.name === pluginName) : [];
  const entry = matches.length === 1 ? matches[0] : null;
  if (!entry) return "unknown";
  const source = entry.source;
  /* 源码清单里 source 常是相对路径字符串（如 "./plugins/zcode-statusbar"） */
  if (typeof source === "string") return "source";
  if (!source || typeof source !== "object") return "unknown";
  return source.source === "url" && source.type === "zip" ? "release" : "source";
}
/* ---------- 更新日志（⚙ 更新页「更新日志」卡片的数据源）----------
 * Release 正文只存在于 GitHub/GitCode 的 Release 里；按需单拉：URL 一律由本模块按
 * 已验证来源构造，渲染进程只允许传 flavor/repository/version。主机白名单独立于资产
 * 下载白名单，匿名 GET，不携带任何凭据。 */
const NOTES_MAX_JSON = 256 * 1024;
const NOTES_LIST_MAX_JSON = 1024 * 1024;
const NOTES_LIST_MAX = 20;   // 历史版本一次最多取 20 条，不做全量扫描
const NOTES_API_HOSTS = {
  github: { repo: githubRepository, api: "api.github.com", base: "https://api.github.com", origin: "https://github.com" },
  gitcode: { repo: gitcodeRepository, api: "api.gitcode.com", base: "https://api.gitcode.com/api/v5", origin: "https://gitcode.com" },
};

function notesTag(version) {
  return typeof version === "string" && STABLE.test(version) ? "v" + version : null;
}
/* GitCode v5 API 与 Gitee 同构：REST 路径在 /api/v5 前缀下；列表默认升序，需显式
 * direction=desc（代码内仍按版本号重排，不依赖该参数）。 */
function notesHost(flavor, repository) {
  const host = NOTES_API_HOSTS[flavor];
  if (!host) return null;
  const repo = host.repo(repository);
  return repo && repo === repository ? { host, repo } : null;
}
function notesRow(row, flavor, repo, tag) {
  if (!row || typeof row !== "object" || typeof row.tag_name !== "string" || row.tag_name !== tag ||
      typeof row.body !== "string" || !row.body.trim()) return null;
  const host = NOTES_API_HOSTS[flavor];
  const name = typeof row.name === "string" && row.name.trim() ? row.name.trim().slice(0, 200) : tag;
  const publishedAt = typeof row.published_at === "string" && row.published_at ? row.published_at
    : typeof row.created_at === "string" ? row.created_at : "";
  return { flavor, repository: repo, version: tag.slice(1), tag, name,
    body: row.body, publishedAt, prerelease: row.prerelease === true,
    url: `${host.origin}/${repo}/releases/tag/${encodeURIComponent(tag)}` };
}
function classifyNotesStatus(code) {
  return code === 404 || code === 422 ? "missing" : code === 403 || code === 429 ? "rate-limited" : "error";
}
/* 更新日志专用取回器：只放行两个只读 API 域，与资产下载白名单分开维护 */
function notesFetch(url, limit) {
  return fetchBytes(url, limit, undefined, Object.values(NOTES_API_HOSTS).map((h) => h.api));
}
async function fetchReleaseNotes(options) {
  const { flavor, repository, version, fetch = notesFetch, limit = NOTES_MAX_JSON } = options || {};
  const found = notesHost(flavor, repository);
  const tag = notesTag(version);
  if (!found || !tag) return { ok: false, reason: "unsupported" };
  const { host, repo } = found;
  let body;
  try { body = await fetch(`${host.base}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, limit); }
  catch (error) {
    if (error && typeof error.status === "number") return { ok: false, reason: classifyNotesStatus(error.status) };
    return { ok: false, reason: "network", message: String((error && error.message) || error).slice(0, 300) };
  }
  let row;
  try { row = JSON.parse(body.toString("utf8")); }
  catch (e) { return { ok: false, reason: "error", message: "更新日志响应不是有效 JSON" }; }
  const notes = notesRow(row, flavor, repo, tag);
  return notes ? { ok: true, notes } : { ok: false, reason: "missing" };
}
async function fetchReleaseNotesList(options) {
  const { flavor, repository, fetch = notesFetch } = options || {};
  const found = notesHost(flavor, repository);
  if (!found) return { ok: false, reason: "unsupported" };
  const { host, repo } = found;
  let body;
  try { body = await fetch(`${host.base}/repos/${repo}/releases?per_page=100&page=1&direction=desc`, NOTES_LIST_MAX_JSON); }
  catch (error) {
    if (error && typeof error.status === "number") return { ok: false, reason: classifyNotesStatus(error.status) };
    return { ok: false, reason: "network", message: String((error && error.message) || error).slice(0, 300) };
  }
  let rows;
  try { rows = JSON.parse(body.toString("utf8")); }
  catch (e) { return { ok: false, reason: "error", message: "更新日志列表响应不是有效 JSON" }; }
  if (!Array.isArray(rows)) return { ok: false, reason: "error", message: "更新日志列表格式无效" };
  // 只保留本项目命名惯例（v+稳定语义版）的条目；prerelease 与更新器候选过滤同规则不放行。
  const seen = new Set(), picked = [];
  for (const row of rows) {
    if (!row || typeof row.tag_name !== "string" || row.prerelease === true) continue;
    const tag = notesTag(row.tag_name.startsWith("v") ? row.tag_name.slice(1) : "");
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    picked.push({ flavor, repository: repo, version: tag.slice(1), tag,
      name: typeof row.name === "string" && row.name.trim() ? row.name.trim().slice(0, 200) : tag,
      publishedAt: typeof row.published_at === "string" && row.published_at ? row.published_at
        : typeof row.created_at === "string" ? row.created_at : "",
      prerelease: row.prerelease === true,
      url: `${host.origin}/${repo}/releases/tag/${encodeURIComponent(tag)}` });
  }
  picked.sort((a, b) => {
    const av = a.version.split(".").map(Number), bv = b.version.split(".").map(Number);
    for (let i = 0; i < 3; i++) { if (av[i] !== bv[i]) return bv[i] - av[i]; }
    return 0;
  });
  return { ok: true, releases: picked.slice(0, NOTES_LIST_MAX) };
}
function createNotesCache(options) {
  const { file, now = Date.now, ttlMs = 60 * 60 * 1000, maxEntries = 24, maxBodyChars = 64 * 1024 } = options || {};
  let entries = null;   // 惰性加载；损坏文件按空缓存处理，下次写入重建，绝不抛错拖垮更新页
  const validNotes = (notes) => {
    // 与 put 同一形状门复用于加载：篡改/损坏的缓存条目按缺失处理。
    if (!notes || typeof notes !== "object") return false;
    if (notes.body !== undefined && (typeof notes.body !== "string" || notes.body.length > maxBodyChars)) return false;
    if (notes.releases !== undefined && !Array.isArray(notes.releases)) return false;
    return true;
  };
  const load = () => {
    if (entries) return entries;
    entries = {};
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const rows = data && typeof data === "object" && !Array.isArray(data) ? data.entries : null;
      if (rows && typeof rows === "object" && !Array.isArray(rows)) {
        for (const key of Object.keys(rows)) {
          const value = rows[key];
          if (typeof key === "string" && key.length <= 400 && value && typeof value === "object" &&
              typeof value.fetchedAt === "number" && Number.isSafeInteger(value.fetchedAt) &&
              value.fetchedAt >= 0 && value.fetchedAt <= 8.64e15 && validNotes(value.notes)) entries[key] = value;
        }
      }
    } catch (e) { if (e.code !== "ENOENT") entries = {}; }
    return entries;
  };
  const persist = () => {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2));
      fs.renameSync(tmp, file);
    } catch (e) { try { fs.unlinkSync(tmp); } catch (_) { } }   // 缓存写失败只少磁盘命中，内存仍有
  };
  return {
    key: (flavor, repository, slot) => `${flavor}|${repository}|${slot || ""}`.slice(0, 400),
    get(key) {
      const row = load()[key];
      return row && row.notes ? row : null;
    },
    fresh(key) {
      const row = this.get(key);
      return !!row && now() - row.fetchedAt >= 0 && now() - row.fetchedAt < ttlMs;
    },
    put(key, notes) {
      const rows = load();
      const trimmed = notes && typeof notes.body === "string" && notes.body.length > maxBodyChars
        ? { ...notes, body: notes.body.slice(0, maxBodyChars), truncated: true } : notes;
      rows[key] = { notes: trimmed, fetchedAt: now() };
      const keys = Object.keys(rows);
      if (keys.length > maxEntries) {
        keys.sort((a, b) => (rows[a].fetchedAt || 0) - (rows[b].fetchedAt || 0));
        for (const k of keys.slice(0, keys.length - maxEntries)) delete rows[k];
      }
      persist();
      return trimmed;
    },
  };
}
function createNotesService(options) {
  const { fetch = notesFetch, cache } = options || {};
  const inflight = new Map();   // 同一身份的并发请求去重：第二次调用复用同一次网络往返
  /* 统一返回形状：成功 = { ok, <notes 字段平铺 | releases>, fromCache?, cachedAt?, stale? }；
   * 失败 = { ok:false, reason, message? }。缓存只存载荷本体，键带 n:/list 命名空间。 */
  async function serve(key, refresh) {
    if (cache && !refresh.fresh && cache.fresh(key)) {
      const row = cache.get(key);
      if (row) return { ...row.notes, ok: true, fromCache: true, cachedAt: row.fetchedAt };
    }
    const pending = inflight.get(key);
    if (pending) return pending;
    const job = (async () => {
      const result = await refresh.run();
      const payload = result.ok ? (result.notes || { releases: result.releases }) : null;
      if (result.ok && cache) return { ...cache.put(key, payload), ok: true };
      if (result.ok) return { ...payload, ok: true };
      if (cache && !refresh.fresh) {
        const row = cache.get(key);
        // 拉取失败但有过期缓存：退回旧值并标 stale，保证限流/离线时仍可读已见过的日志
        if (row) return { ...row.notes, ok: true, fromCache: true, cachedAt: row.fetchedAt, stale: true };
      }
      return result;
    })();
    inflight.set(key, job);
    try { return await job; } finally { inflight.delete(key); }
  }
  return {
    getNotes(params) {
      const { flavor, repository, version, force } = params || {};
      const key = cache ? cache.key(flavor, repository, "n:" + (version || "")) : "n:" + flavor + "|" + repository + "|" + version;
      return serve(key, { fresh: force === true,
        run: () => fetchReleaseNotes({ flavor, repository, version, fetch }) });
    },
    getList(params) {
      const { flavor, repository, force } = params || {};
      const key = cache ? cache.key(flavor, repository, "list") : "list:" + flavor + "|" + repository;
      return serve(key, { fresh: force === true,
        run: () => fetchReleaseNotesList({ flavor, repository, fetch }) });
    },
  };
}

module.exports = { PLUGIN_ID, MARKETPLACE_NAME, PLUGIN_NAME, PLUGIN_ZIP_PREFIX,
  sameRepository, sameAssetUrl, githubRepository, gitcodeRepository, readChannel, checkRelease,
  gitcodeReleaseFromCatalog, githubReleaseFromCatalog, validateGitcodeRelease, validateGithubCatalogRelease,
  downloadRelease, validateRelease, validateManifest, catalogChannel,
  fetchBytes, fetchReleaseNotes, fetchReleaseNotesList, createNotesCache, createNotesService, notesTag, releaseAcceptHeader, NOTES_API_HOSTS, NOTES_MAX_JSON, NOTES_LIST_MAX_JSON, NOTES_LIST_MAX, MAX_ASSET, MAX_JSON };
