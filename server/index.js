import express from "express";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import QRCode from "qrcode";
import { RoomStore } from "./rooms.js";
import { LocalGameLibrary, UPLOAD_CHUNK_BYTES } from "./local-game-library.js";

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
const gameLibrary = new LocalGameLibrary();
const inputTimes = new Map();

app.use("/games", (_request, response) => response.sendStatus(404));
app.use("/emulator-data", async (request, response) => {
  let assetPath;
  try {
    assetPath = decodeURIComponent(request.path);
  } catch {
    return response.sendStatus(400);
  }
  if (!/^\/[A-Za-z0-9._/-]+$/.test(assetPath) || assetPath.split("/").includes("..")) {
    return response.sendStatus(400);
  }
  try {
    const upstream = await fetch(`https://cdn.emulatorjs.org/stable/data${assetPath}`, {
      signal: AbortSignal.timeout(15000)
    });
    if (!upstream.ok || !upstream.body) return response.sendStatus(upstream.status || 502);
    response.status(upstream.status);
    response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
    response.setHeader("Cache-Control", "public, max-age=86400");
    if (upstream.headers.get("content-length")) response.setHeader("Content-Length", upstream.headers.get("content-length"));
    Readable.fromWeb(upstream.body).on("error", () => response.destroy()).pipe(response);
  } catch {
    response.sendStatus(502);
  }
});
app.use(express.static(path.join(directory, "../public")));
app.get("/", (_request, response) => response.redirect(302, "/host.html"));
app.get("/health", (_request, response) => response.status(200).json({ ok: true }));

app.get("/api/games", async (_request, response) => {
  try {
    response.json(await gameLibrary.list());
  } catch (error) {
    response.status(error.status || 502).json({ error: error.message });
  }
});

function requireLocalLibrary(request, response, next) {
  if (process.env.RENDER_EXTERNAL_URL) {
    return response.status(403).json({ error: "رفع الألعاب متاح عند تشغيل الخادم محلياً على شبكة موثوقة فقط" });
  }
  next();
}

app.post("/api/games/upload/start", requireLocalLibrary, express.json({ limit: "16kb" }),
  async (request, response) => {
    try {
      response.status(201).json(await gameLibrary.startUpload(request.body ?? {}));
    } catch (error) {
      response.status(error.status || 502).json({ error: error.message });
    }
  }
);

app.put("/api/games/upload/:uploadId/chunks/:index", requireLocalLibrary,
  express.raw({ type: "application/octet-stream", limit: `${UPLOAD_CHUNK_BYTES}b` }),
  async (request, response) => {
    try {
      response.json(await gameLibrary.writeUploadChunk(request.params.uploadId, Number(request.params.index), request.body));
    } catch (error) {
      response.status(error.status || 502).json({ error: error.message });
    }
  }
);

app.post("/api/games/upload/:uploadId/finish", requireLocalLibrary, async (request, response) => {
  try {
    const game = await gameLibrary.finishUpload(request.params.uploadId);
    response.status(201).json({ game });
  } catch (error) {
    response.status(error.status || 502).json({ error: error.message });
  }
});

app.delete("/api/games/upload/:uploadId", requireLocalLibrary, async (request, response) => {
  await gameLibrary.discardUpload(request.params.uploadId);
  response.sendStatus(204);
});

async function prepareGameDownload(gameId, response) {
  const { game, filePath } = await gameLibrary.getGameDownload(gameId);
  const { size } = await stat(filePath);
  response.setHeader("Content-Type", "application/octet-stream");
  response.setHeader("Content-Disposition", `attachment; filename="${game.filename}"`);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Length", String(size));
  return filePath;
}

app.head("/api/games/:id/download", async (request, response) => {
  try {
    await prepareGameDownload(request.params.id, response);
    response.status(200).end();
  } catch (error) {
    response.status(error.status || 502).end();
  }
});

app.get("/api/games/:id/download", async (request, response) => {
  try {
    const filePath = await prepareGameDownload(request.params.id, response);
    createReadStream(filePath).on("error", () => response.destroy()).pipe(response);
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
    let localHost = request.get("host");
    if (!configuredBase && /^(localhost|127\.|\[::1\])/.test(localHost)) {
      const addresses = Object.values(os.networkInterfaces()).flat().filter(item => item?.family === "IPv4" && !item.internal).map(item => item.address);
      const preferredAddress = addresses.find(address => address.startsWith("192.168."))
        || addresses.find(address => address.startsWith("10."))
        || addresses[0];
      if (preferredAddress) localHost = `${preferredAddress}:${port}`;
    }
    baseUrl = new URL(configuredBase || `${request.protocol}://${localHost}`);
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