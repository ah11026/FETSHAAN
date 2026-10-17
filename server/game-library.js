import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const MAX_GAME_BYTES = 250 * 1024 * 1024;
export const GITHUB_TREE_GAME_LIMIT = 15 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const UPLOAD_TTL_MS = 30 * 60 * 1000;
export const GAME_SYSTEMS = Object.freeze({
  nes: [".nes"],
  snes: [".sfc", ".smc"],
  n64: [".n64", ".z64", ".v64"],
  psx: [".bin", ".cue", ".iso", ".chd", ".pbp"],
  nds: [".nds"]
});

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function validateSystem(system) {
  if (!Object.hasOwn(GAME_SYSTEMS, system)) fail("نظام الألعاب غير مدعوم");
  return system;
}

function validateLicense(license, licenseUrl) {
  const name = typeof license === "string" ? license.trim().slice(0, 100) : "";
  if (!name) fail("اذكر ترخيص اللعبة قبل حفظها");

  let url;
  try {
    url = new URL(licenseUrl);
  } catch {
    fail("أضف رابطاً صالحاً يوضح ترخيص اللعبة");
  }
  if (url.protocol !== "https:") fail("يجب أن يكون رابط الترخيص آمناً (HTTPS)");
  return { license: name, licenseUrl: url.toString() };
}

function validateGameFile(system, filename, bytesOrSize) {
  validateSystem(system);
  const extension = path.posix.extname(filename).toLowerCase();
  if (!GAME_SYSTEMS[system].includes(extension)) {
    fail(`امتداد الملف ${extension || "غير معروف"} لا يناسب النظام المختار`);
  }
  const size = typeof bytesOrSize === "number" ? bytesOrSize : bytesOrSize?.length;
  if (!Number.isFinite(size) || size <= 0) fail("ملف اللعبة فارغ");
  if (size > MAX_GAME_BYTES) fail("الحد الأقصى لحجم الملف 250 ميغابايت", 413);
  return extension;
}

function validateSource({ repository, branch, filePath }) {
  if (typeof repository !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      repository.split("/").some(part => part === "." || part === "..")) {
    fail("صيغة المستودع يجب أن تكون owner/repository");
  }
  if (typeof branch !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(branch) || branch === "..") {
    fail("اسم الفرع غير صالح");
  }
  if (typeof filePath !== "string" || filePath.length > 240 ||
      filePath.startsWith("/") || filePath.includes("\\") ||
      filePath.split("/").some(part => !part || part === "." || part === "..")) {
    fail("مسار ملف المصدر غير صالح");
  }
  return {
    repository,
    branch,
    filePath,
    url: `https://raw.githubusercontent.com/${repository}/${encodeURIComponent(branch)}/${filePath.split("/").map(encodeURIComponent).join("/")}`
  };
}

function slugify(value) {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

export class GameLibrary {
  constructor({
    token = process.env.GAME_LIBRARY_GITHUB_TOKEN,
    repository = process.env.GAME_LIBRARY_REPOSITORY,
    branch = process.env.GAME_LIBRARY_BRANCH || "main",
    fetcher = fetch
  } = {}) {
    this.token = token;
    this.repository = repository;
    this.branch = branch;
    this.fetcher = fetcher;
    this.pendingUploads = new Map();
  }

  get enabled() {
    return Boolean(this.token && this.repository && this.branch);
  }

  async request(endpoint, options = {}) {
    if (!this.enabled) fail("مكتبة الألعاب غير مهيأة على الخادم", 503);
    const response = await this.fetcher(`https://api.github.com/repos/${this.repository}/${endpoint}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Klai-Game-Library",
        ...options.headers
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const status = response.status === 409 || response.status === 422 ? 409 : 502;
      fail(data.message || "تعذر الاتصال بواجهة GitHub", status);
    }
    return data;
  }

  async readCatalog() {
    if (!this.enabled) fail("مكتبة الألعاب غير مهيأة على الخادم", 503);
    const endpoint = `contents/public/games/catalog.json?ref=${encodeURIComponent(this.branch)}`;
    const response = await this.fetcher(`https://api.github.com/repos/${this.repository}/${endpoint}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Klai-Game-Library"
      }
    });
    if (response.status === 404) return [];
    const data = await response.json().catch(() => ({}));
    if (!response.ok) fail(data.message || "تعذر قراءة مكتبة الألعاب من GitHub", 502);
    try {
      const catalog = JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
      return Array.isArray(catalog) ? catalog : fail("ملف فهرس الألعاب غير صالح", 502);
    } catch (error) {
      if (error.status) throw error;
      fail("تعذر تحليل فهرس الألعاب في GitHub", 502);
    }
  }

  async list() {
    if (!this.enabled) return { enabled: false, games: [] };
    const games = await this.readCatalog();
    for (let page = 1; ; page += 1) {
      const releases = await this.request(`releases?per_page=100&page=${page}`);
      if (!Array.isArray(releases)) fail("استجابة إصدارات GitHub غير صالحة", 502);
      for (const release of releases) {
        if (!release.tag_name?.startsWith("klai-game-")) continue;
        try {
          const game = JSON.parse(release.body || "{}");
          if (!game.id || !game.assetName || !release.assets?.some(asset => asset.name === game.assetName)) continue;
          games.push({ ...game, downloadUrl: `/api/games/${encodeURIComponent(game.id)}/download` });
        } catch {
          continue;
        }
      }
      if (releases.length < 100) break;
    }

    const indexedPaths = new Set(games.map(game => game.path).filter(Boolean));
    const reference = await this.request(`git/ref/heads/${encodeURIComponent(this.branch)}`);
    const head = await this.request(`git/commits/${reference.object.sha}`);
    const tree = await this.request(`git/trees/${head.tree.sha}?recursive=1`);
    for (const entry of tree.tree ?? []) {
      if (entry.type !== "blob" || indexedPaths.has(entry.path)) continue;
      const match = entry.path.match(/^public\/games\/(nes|snes|n64|psx|nds)\/(.+)$/);
      if (!match) continue;
      const [, system, fileName] = match;
      const extension = path.posix.extname(fileName).toLowerCase();
      if (!GAME_SYSTEMS[system].includes(extension)) continue;
      const id = `tree-${createHash("sha256").update(entry.path).digest("hex").slice(0, 24)}`;
      games.push({
        id,
        name: path.posix.basename(fileName, extension),
        system,
        license: "غير محدد",
        licenseUrl: "",
        sourceRepository: this.repository,
        storage: "git-tree",
        path: entry.path,
        addedAt: null
      });
      indexedPaths.add(entry.path);
    }

    return {
      enabled: true,
      games: games.map(game => ({
        ...game,
        downloadUrl: `/api/games/${encodeURIComponent(game.id)}/download`
      }))
    };
  }

  async findGame(gameId) {
    const { games } = await this.list();
    return games.find(game => game.id === gameId) ?? null;
  }

  async save({ name, system, license, licenseUrl, filename, bytes, sourceRepository = "رفع مباشر" }) {
    const cleanName = typeof name === "string" ? name.trim().slice(0, 80) : "";
    if (!cleanName) fail("أدخل اسم اللعبة");
    const extension = validateGameFile(system, filename, bytes);
    const licenseInfo = validateLicense(license, licenseUrl);
    if (bytes.length > GITHUB_TREE_GAME_LIMIT) {
      fail("الملف كبير جداً للتخزين داخل GitHub Git tree؛ ارفعه كأصل GitHub Release", 413);
    }
    const catalog = await this.readCatalog();
    const fileName = `${slugify(cleanName) || system}-${randomUUID().slice(0, 8)}${extension}`;
    const filePath = `public/games/${system}/${fileName}`;
    const downloadUrl = `https://raw.githubusercontent.com/${this.repository}/${this.branch}/${filePath.split("/").map(encodeURIComponent).join("/")}`;
    const game = {
      id: randomUUID(),
      name: cleanName,
      system,
      license: licenseInfo.license,
      licenseUrl: licenseInfo.licenseUrl,
      sourceRepository,
      path: filePath,
      downloadUrl,
      addedAt: new Date().toISOString()
    };
    const updatedCatalog = [...catalog, game];

    const reference = await this.request(`git/ref/heads/${encodeURIComponent(this.branch)}`);
    const headSha = reference.object.sha;
    const head = await this.request(`git/commits/${headSha}`);
    const [gameBlob, catalogBlob] = await Promise.all([
      this.request("git/blobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: Buffer.from(bytes).toString("base64"), encoding: "base64" })
      }),
      this.request("git/blobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: JSON.stringify(updatedCatalog, null, 2) + "\n", encoding: "utf-8" })
      })
    ]);
    const tree = await this.request("git/trees", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base_tree: head.tree.sha,
        tree: [
          { path: filePath, mode: "100644", type: "blob", sha: gameBlob.sha },
          { path: "public/games/catalog.json", mode: "100644", type: "blob", sha: catalogBlob.sha }
        ]
      })
    });
    const commit = await this.request("git/commits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Add licensed ${system} game: ${cleanName}`,
        tree: tree.sha,
        parents: [headSha]
      })
    });
    await this.request(`git/refs/heads/${encodeURIComponent(this.branch)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: commit.sha, force: false })
    });

    return game;
  }

  async importFromRepository(input) {
    const source = validateSource(input);
    const filename = path.posix.basename(source.filePath);
    const isConfiguredRepository = source.repository.toLowerCase() === this.repository.toLowerCase();
    const sourceUrl = isConfiguredRepository
      ? `https://api.github.com/repos/${this.repository}/contents/${source.filePath.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(source.branch)}`
      : source.url;
    const response = await this.fetcher(sourceUrl, {
      redirect: "error",
      headers: isConfiguredRepository ? {
        Accept: "application/vnd.github.raw+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Klai-Game-Library"
      } : { "User-Agent": "Klai-Game-Library" },
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok || !response.body) fail("تعذر تنزيل الملف من المستودع المحدد", 400);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_GAME_BYTES) {
      fail("حجم ملف المصدر يتجاوز 250 ميغابايت", 413);
    }
    const temporaryPath = path.join(tmpdir(), `klai-import-${randomUUID()}`);
    let size = 0;
    try {
      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          if (size > MAX_GAME_BYTES) callback(Object.assign(new Error("حجم ملف المصدر يتجاوز 250 ميغابايت"), { status: 413 }));
          else callback(null, chunk);
        }
      });
      await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(temporaryPath, { flags: "wx" }));
      const game = await this.saveReleaseFile({ ...input, filename }, temporaryPath, size, source.repository);
      return game;
    } catch (error) {
      throw error;
    } finally {
      const { unlink } = await import("node:fs/promises");
      await unlink(temporaryPath).catch(() => {});
    }
  }

  async upload(input, bytes) {
    return this.save({ ...input, bytes, sourceRepository: "رفع مباشر" });
  }

  prepareUpload({ name, system, license, licenseUrl, filename, size }) {
    const cleanName = typeof name === "string" ? name.trim().slice(0, 80) : "";
    if (!cleanName) fail("أدخل اسم اللعبة");
    const extension = validateGameFile(system, filename, size);
    return {
      name: cleanName,
      system,
      extension,
      ...validateLicense(license, licenseUrl),
      filename: path.posix.basename(filename),
      size
    };
  }

  async saveReleaseFile(metadata, temporaryPath, size, sourceRepository = "رفع مباشر") {
    if (!this.enabled) fail("مكتبة الألعاب غير مهيأة على الخادم", 503);
    const prepared = this.prepareUpload({ ...metadata, size });
    const id = randomUUID();
    const assetName = `${slugify(prepared.name) || prepared.system}-${id.slice(0, 8)}${prepared.extension}`;
    const releaseTag = `klai-game-${id}`;
    const game = {
      id,
      name: prepared.name,
      system: prepared.system,
      license: prepared.license,
      licenseUrl: prepared.licenseUrl,
      sourceRepository,
      storage: "github-release",
      releaseTag,
      assetName,
      fileSize: size,
      downloadUrl: `/api/games/${id}/download`,
      addedAt: new Date().toISOString()
    };
    const release = await this.request("releases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag_name: releaseTag,
        target_commitish: this.branch,
        name: prepared.name,
        body: JSON.stringify(game),
        draft: false,
        prerelease: false
      })
    });
    try {
      const uploadUrl = release.upload_url.replace(/\{.*$/, "");
      const assetUrl = new URL(uploadUrl);
      assetUrl.searchParams.set("name", assetName);
      const response = await this.fetcher(assetUrl, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Klai-Game-Library",
          "Content-Type": "application/octet-stream",
          "Content-Length": String(size)
        },
        body: createReadStream(temporaryPath),
        duplex: "half"
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) fail(data.message || "تعذر رفع ملف اللعبة إلى GitHub Releases", 502);
      return game;
    } catch (error) {
      await this.request(`releases/${release.id}`, { method: "DELETE" }).catch(() => {});
      throw error;
    }
  }

  async startUpload(metadata) {
    const prepared = this.prepareUpload(metadata);
    const uploadId = randomUUID();
    const temporaryPath = path.join(tmpdir(), `klai-upload-${uploadId}`);
    const handle = await open(temporaryPath, "wx");
    const upload = {
      ...prepared,
      uploadId,
      temporaryPath,
      handle,
      received: 0,
      nextChunk: 0,
      totalChunks: Math.ceil(prepared.size / UPLOAD_CHUNK_BYTES)
    };
    upload.timer = setTimeout(() => {
      this.discardUpload(uploadId).catch(() => {});
    }, UPLOAD_TTL_MS);
    upload.timer.unref();
    this.pendingUploads.set(uploadId, upload);
    return { uploadId, chunkSize: UPLOAD_CHUNK_BYTES, totalChunks: upload.totalChunks };
  }

  async writeUploadChunk(uploadId, index, bytes) {
    const upload = this.pendingUploads.get(uploadId);
    if (!upload) fail("جلسة الرفع غير موجودة أو انتهت", 404);
    if (!Number.isInteger(index) || index !== upload.nextChunk || index >= upload.totalChunks) {
      fail("ترتيب أجزاء الملف غير صالح");
    }
    const expectedLength = Math.min(UPLOAD_CHUNK_BYTES, upload.size - upload.received);
    if (!Buffer.isBuffer(bytes) || bytes.length !== expectedLength) {
      fail("حجم جزء الرفع غير مطابق للمتوقع");
    }

    let written = 0;
    while (written < bytes.length) {
      const result = await upload.handle.write(bytes, written, bytes.length - written, upload.received + written);
      written += result.bytesWritten;
    }
    upload.received += bytes.length;
    upload.nextChunk += 1;
    return { received: upload.received, total: upload.size };
  }

  async finishUpload(uploadId) {
    const upload = this.pendingUploads.get(uploadId);
    if (!upload) fail("جلسة الرفع غير موجودة أو انتهت", 404);
    if (upload.received !== upload.size || upload.nextChunk !== upload.totalChunks) {
      fail("لم يكتمل رفع كل أجزاء الملف", 409);
    }

    this.pendingUploads.delete(uploadId);
    clearTimeout(upload.timer);
    await upload.handle.close();
    try {
      return await this.saveReleaseFile(upload, upload.temporaryPath, upload.size);
    } finally {
      await unlink(upload.temporaryPath).catch(() => {});
    }
  }

  async discardUpload(uploadId) {
    const upload = this.pendingUploads.get(uploadId);
    if (!upload) return;
    this.pendingUploads.delete(uploadId);
    clearTimeout(upload.timer);
    await upload.handle.close().catch(() => {});
    await unlink(upload.temporaryPath).catch(() => {});
  }

  async getGameDownload(gameId) {
    const game = await this.findGame(gameId);
    if (!game) fail("اللعبة غير موجودة في المكتبة", 404);

    let response;
    if (game.storage === "github-release") {
      const release = await this.request(`releases/tags/${encodeURIComponent(game.releaseTag)}`);
      const asset = release.assets?.find(item => item.name === game.assetName);
      if (!asset) fail("ملف اللعبة غير موجود في GitHub Release", 404);
      response = await this.fetcher(`https://api.github.com/repos/${this.repository}/releases/assets/${asset.id}`, {
        headers: {
          Accept: "application/octet-stream",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Klai-Game-Library"
        },
        redirect: "follow"
      });
    } else {
      const filePath = game.path.split("/").map(encodeURIComponent).join("/");
      response = await this.fetcher(`https://api.github.com/repos/${this.repository}/contents/${filePath}?ref=${encodeURIComponent(this.branch)}`, {
        headers: {
          Accept: "application/vnd.github.raw+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Klai-Game-Library"
        },
        redirect: "follow"
      });
    }
    if (!response.ok || !response.body) fail("تعذر تنزيل اللعبة من GitHub", 502);
    return { game, response };
  }
}

export const gameLibraryValidation = Object.freeze({
  validateGameFile,
  validateLicense,
  validateSource
});