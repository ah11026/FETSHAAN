import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GAME_SYSTEMS, gameLibraryValidation } from "./game-library.js";

export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const UPLOAD_TTL_MS = 30 * 60 * 1000;
const defaultDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/games");

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

export class LocalGameLibrary {
  constructor({ directory = process.env.GAME_LIBRARY_DIR || defaultDirectory } = {}) {
    this.directory = path.resolve(directory);
    this.catalogPath = path.join(this.directory, "catalog.json");
    this.games = null;
    this.initializing = null;
    this.pendingUploads = new Map();
    this.writeQueue = Promise.resolve();
  }

  async ready() {
    if (this.initializing) return this.initializing;
    if (this.games) return;
    this.initializing = (async () => {
      await mkdir(this.directory, { recursive: true });
      try {
        const catalog = JSON.parse(await readFile(this.catalogPath, "utf8"));
        if (!Array.isArray(catalog)) fail("فهرس الألعاب المحلي غير صالح", 500);
        this.games = catalog;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        this.games = [];
        await this.writeCatalog();
      }
    })();
    try {
      await this.initializing;
    } catch (error) {
      this.initializing = null;
      throw error;
    }
  }

  async writeCatalog() {
    const temporaryPath = `${this.catalogPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.games, null, 2)}\n`, { flag: "wx" });
    await rename(temporaryPath, this.catalogPath);
  }

  async list() {
    await this.ready();
    return { enabled: true, games: this.games.map(game => ({ ...game, downloadUrl: `/api/games/${encodeURIComponent(game.id)}/download` })) };
  }

  async startUpload({ name, system, license, licenseUrl, filename, size }) {
    await this.ready();
    const cleanName = typeof name === "string" ? name.trim().slice(0, 80) : "";
    if (!cleanName) fail("أدخل اسم اللعبة");
    if (!Object.hasOwn(GAME_SYSTEMS, system)) fail("نظام الألعاب غير مدعوم");
    const extension = path.extname(typeof filename === "string" ? filename : "").toLowerCase();
    if (!GAME_SYSTEMS[system].includes(extension)) fail("امتداد الملف لا يناسب النظام المختار");
    if (!Number.isSafeInteger(size) || size <= 0) fail("حجم ملف اللعبة غير صالح");
    const licenseInfo = gameLibraryValidation.validateLicense(license, licenseUrl);
    const uploadId = randomUUID();
    const temporaryPath = path.join(this.directory, `.upload-${uploadId}`);
    const handle = await open(temporaryPath, "wx");
    const upload = {
      uploadId,
      temporaryPath,
      handle,
      name: cleanName,
      system,
      extension,
      ...licenseInfo,
      size,
      received: 0,
      nextChunk: 0,
      totalChunks: Math.ceil(size / UPLOAD_CHUNK_BYTES)
    };
    upload.timer = setTimeout(() => this.discardUpload(uploadId).catch(() => {}), UPLOAD_TTL_MS);
    upload.timer.unref();
    this.pendingUploads.set(uploadId, upload);
    return { uploadId, chunkSize: UPLOAD_CHUNK_BYTES, totalChunks: upload.totalChunks };
  }

  async writeUploadChunk(uploadId, index, bytes) {
    const upload = this.pendingUploads.get(uploadId);
    if (!upload) fail("جلسة الرفع غير موجودة أو انتهت", 404);
    if (!Number.isInteger(index) || index !== upload.nextChunk || index >= upload.totalChunks) fail("ترتيب أجزاء الملف غير صالح");
    const expectedLength = Math.min(UPLOAD_CHUNK_BYTES, upload.size - upload.received);
    if (!Buffer.isBuffer(bytes) || bytes.length !== expectedLength) fail("حجم جزء الرفع غير مطابق للمتوقع");
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
    if (upload.received !== upload.size || upload.nextChunk !== upload.totalChunks) fail("لم يكتمل رفع كل أجزاء الملف", 409);
    this.pendingUploads.delete(uploadId);
    clearTimeout(upload.timer);
    await upload.handle.close();

    const id = randomUUID();
    const filename = `${id}${upload.extension}`;
    const systemDirectory = path.join(this.directory, upload.system);
    const destinationPath = path.join(systemDirectory, filename);
    await mkdir(systemDirectory, { recursive: true });
    await rename(upload.temporaryPath, destinationPath);
    const game = {
      id,
      name: upload.name,
      system: upload.system,
      license: upload.license,
      licenseUrl: upload.licenseUrl,
      filename,
      fileSize: upload.size,
      downloadUrl: `/api/games/${encodeURIComponent(id)}/download`,
      addedAt: new Date().toISOString()
    };

    const operation = this.writeQueue.then(async () => {
      this.games.push(game);
      try {
        await this.writeCatalog();
      } catch (error) {
        this.games.pop();
        throw error;
      }
    });
    this.writeQueue = operation.catch(() => {});
    try {
      await operation;
      return game;
    } catch (error) {
      await unlink(destinationPath).catch(() => {});
      throw error;
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
    await this.ready();
    const game = this.games.find(item => item.id === gameId);
    if (!game) fail("اللعبة غير موجودة في المكتبة", 404);
    return { game, filePath: path.join(this.directory, game.system, game.filename) };
  }
}