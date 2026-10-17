import express from "express";
import http from "node:http";
import path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import QRCode from "qrcode";
import { RoomStore } from "./rooms.js";
import { GameLibrary, MAX_GAME_BYTES, UPLOAD_CHUNK_BYTES } from "./game-library.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 16 * 1024,
  pingInterval: 25000,
  pingTimeout: 60000
});
const rooms = new RoomStore();
const gameLibrary = new GameLibrary();
const inputTimes = new Map();

app.use("/games", (_request, response) => response.sendStatus(404));
app.use(express.static(path.join(directory, "../public")));
app.get("/", (_request, response) => response.redirect(302, "/host.html"));
app.get("/health", (_request, response) => response.status(200).json({ ok: true }));

app.get("/api/games", requireGameLibraryAdmin, async (_request, response) => {
  try {
    response.json(await gameLibrary.list());
  } catch (error) {
    response.status(error.status || 502).json({ error: error.message });
  }
});

function requireGameLibraryAdmin(request, response, next) {
  const expectedKey = process.env.GAME_LIBRARY_ADMIN_KEY;
  const authorization = request.get("authorization") ?? "";
  const suppliedKey = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!expectedKey) return response.status(503).json({ error: "مفتاح إدارة مكتبة الألعاب غير مضبوط على الخادم" });

  const expected = Buffer.from(expectedKey);
  const supplied = Buffer.from(suppliedKey);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return response.status(403).json({ error: "مفتاح إدارة المكتبة غير صحيح" });
  }
  if (!gameLibrary.enabled) {
    return response.status(503).json({ error: "صلاحيات GitHub لمكتبة الألعاب غير مضبوطة على الخادم" });
  }
  next();
}

app.post("/api/games/upload/start", requireGameLibraryAdmin, express.json({ limit: "16kb" }),
  async (request, response) => {
    try {
      response.status(201).json(await gameLibrary.startUpload(request.body ?? {}));
    } catch (error) {
      response.status(error.status || 502).json({ error: error.message });
    }
  }
);

app.put("/api/games/upload/:uploadId/chunks/:index", requireGameLibraryAdmin,
  express.raw({ type: "application/octet-stream", limit: `${UPLOAD_CHUNK_BYTES}b` }),
  async (request, response) => {
    try {
      response.json(await gameLibrary.writeUploadChunk(request.params.uploadId, Number(request.params.index), request.body));
    } catch (error) {
      response.status(error.status || 502).json({ error: error.message });
    }
  }
);

app.post("/api/games/upload/:uploadId/finish", requireGameLibraryAdmin, async (request, response) => {
  try {
    const game = await gameLibrary.finishUpload(request.params.uploadId);
    response.status(201).json({ game });
  } catch (error) {
    response.status(error.status || 502).json({ error: error.message });
  }
});

app.delete("/api/games/upload/:uploadId", requireGameLibraryAdmin, async (request, response) => {
  await gameLibrary.discardUpload(request.params.uploadId);
  response.sendStatus(204);
});

app.post("/api/games/import", requireGameLibraryAdmin, express.json({ limit: "16kb" }),
  async (request, response) => {
    try {
      const game = await gameLibrary.importFromRepository(request.body ?? {});
      response.status(201).json({ game });
    } catch (error) {
      response.status(error.status || 502).json({ error: error.message });
    }
  }
);

function makeGameDownloadTicket(gameId) {
  const payload = Buffer.from(JSON.stringify({ gameId, expiresAt: Date.now() + 10 * 60 * 1000 })).toString("base64url");
  const signature = createHmac("sha256", process.env.GAME_LIBRARY_ADMIN_KEY).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function validGameDownloadTicket(gameId, ticket) {
  if (!process.env.GAME_LIBRARY_ADMIN_KEY || typeof ticket !== "string") return false;
  const [payload, signature] = ticket.split(".");
  if (!payload || !signature) return false;
  const expected = createHmac("sha256", process.env.GAME_LIBRARY_ADMIN_KEY).update(payload).digest();
  let supplied;
  try {
    supplied = Buffer.from(signature, "base64url");
  } catch {
    return false;
  }
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.gameId === gameId && Number.isFinite(data.expiresAt) && data.expiresAt > Date.now();
  } catch {
    return false;
  }
}

app.post("/api/games/:id/download-ticket", requireGameLibraryAdmin, async (request, response) => {
  try {
    const game = await gameLibrary.findGame(request.params.id);
    if (!game) return response.status(404).json({ error: "اللعبة غير موجودة" });
    response.json({ url: `/api/games/${encodeURIComponent(game.id)}/download?ticket=${encodeURIComponent(makeGameDownloadTicket(game.id))}` });
  } catch (error) {
    response.status(error.status || 502).json({ error: error.message });
  }
});

app.get("/api/games/:id/download", async (request, response) => {
  if (!validGameDownloadTicket(request.params.id, request.query.ticket)) {
    return response.status(403).json({ error: "رابط التنزيل غير صالح أو انتهت صلاحيته" });
  }
  try {
    const { game, response: upstream } = await gameLibrary.getGameDownload(request.params.id);
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(game.assetName || path.basename(game.path))}`);
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (upstream.headers.get("content-length")) response.setHeader("Content-Length", upstream.headers.get("content-length"));
    Readable.fromWeb(upstream.body).on("error", () => response.destroy()).pipe(response);
  } catch (error) {
    response.status(error.status || 502).json({ error: error.message });
  }
});

app.get("/api/rooms/:code/qr", async (request, response) => {
  const { code } = request.params;
  const authorization = request.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  if (!rooms.authenticateHost(code, token)) {
    return response.status(403).json({ error: "غير مصرح" });
  }

  const configuredBase = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL;
  let baseUrl;
  try {
    baseUrl = new URL(configuredBase || `${request.protocol}://${request.get("host")}`);
    if (!["http:", "https:"].includes(baseUrl.protocol)) throw new Error("Invalid protocol");
  } catch {
    return response.status(500).json({ error: "عنوان الخادم العام غير صالح" });
  }

  const joinUrl = new URL("/controller.html", baseUrl);
  joinUrl.searchParams.set("room", code);

  try {
    response.json({ url: joinUrl.toString(), qr: await QRCode.toDataURL(joinUrl.toString()) });
  } catch {
    response.status(500).json({ error: "تعذر إنشاء رمز QR" });
  }
});

io.on("connection", socket => {
  socket.on("room:create", ack => {
    const room = rooms.create(socket.id);
    if (!room) return ack?.({ ok: false, error: "لديك غرفة نشطة بالفعل" });
    socket.join(room.code);
    ack?.({ ok: true, ...room });
  });

  socket.on("room:join", (payload, ack) => {
    const result = rooms.join(payload?.code, socket.id, payload?.name);
    if (!result.ok) return ack?.(result);
    socket.join(result.code);
    ack?.({ ok: true, player: result.player, code: result.code });
    io.to(rooms.rooms.get(result.code).hostId).emit("room:state", result.state);
  });

  socket.on("input", (payload, ack) => {
    const now = Date.now();
    const recent = (inputTimes.get(socket.id) ?? []).filter(time => now - time < 1000);
    if (recent.length >= 120) {
      inputTimes.set(socket.id, recent);
      return ack?.({ ok: false, error: "تجاوزت معدل الإدخال المسموح" });
    }
    recent.push(now);
    inputTimes.set(socket.id, recent);

    const result = rooms.input(socket.id, payload);
    if (!result.ok) return ack?.(result);
    if (result.changed) io.to(result.hostId).emit("game:input", result.event);
    ack?.({ ok: true });
  });

  socket.on("disconnect", () => {
    inputTimes.delete(socket.id);
    const result = rooms.leave(socket.id);
    if (!result) return;

    if (result.type === "closed") {
      for (const playerId of result.playerIds) {
        io.to(playerId).emit("room:closed");
      }
      io.in(result.code).socketsLeave(result.code);
      return;
    }

    for (const event of result.released) io.to(result.hostId).emit("game:input", event);
    io.to(result.hostId).emit("room:state", result.state);
  });
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, "0.0.0.0", () => {
  console.log(`Klai party play listening on port ${port}`);
});