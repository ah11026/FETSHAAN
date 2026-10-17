import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GameLibrary, MAX_GAME_BYTES, UPLOAD_CHUNK_BYTES, gameLibraryValidation } from "../server/game-library.js";
import { mapRemoteAxis, mapRemoteInput, RemoteInputState } from "../public/js/emulator-controls.js";

const { validateGameFile, validateLicense, validateSource } = gameLibraryValidation;

test("game uploads accept only extensions belonging to their selected system", () => {
  assert.equal(validateGameFile("nes", "homebrew.NES", Buffer.from([1])), ".nes");
  assert.equal(validateGameFile("nds", "homebrew.nds", 1), ".nds");
  assert.throws(() => validateGameFile("nes", "game.exe", Buffer.from([1])), /لا يناسب النظام/);
  assert.throws(() => validateGameFile("unknown", "game.nes", Buffer.from([1])), /غير مدعوم/);
});

test("large uploads use ordered chunks and accept Nintendo DS files", async () => {
  const library = new GameLibrary({ token: "test", repository: "owner/games" });
  const session = await library.startUpload({
    name: "Homebrew DS",
    system: "nds",
    license: "MIT",
    licenseUrl: "https://example.org/license",
    filename: "homebrew.nds",
    size: 3
  });
  assert.equal(session.chunkSize, UPLOAD_CHUNK_BYTES);
  await assert.rejects(library.writeUploadChunk(session.uploadId, 1, Buffer.from([1, 2, 3])), /ترتيب أجزاء/);
  assert.deepEqual(await library.writeUploadChunk(session.uploadId, 0, Buffer.from([1, 2, 3])), {
    received: 3,
    total: 3
  });
  await library.discardUpload(session.uploadId);
  assert.equal(library.pendingUploads.size, 0);
});

test("large Nintendo DS files are streamed as GitHub Release assets, not Git blobs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "klai-release-test-"));
  const temporaryPath = path.join(directory, "homebrew.nds");
  const file = Buffer.from([1, 2, 3, 4]);
  await writeFile(temporaryPath, file);
  let uploaded = Buffer.alloc(0);
  const fetcher = async (url, options = {}) => {
    if (String(url).startsWith("https://api.github.com/") && String(url).endsWith("/releases")) {
      return Response.json({
        id: 17,
        upload_url: "https://uploads.github.com/repos/owner/games/releases/17/assets{?name,label}"
      });
    }
    if (String(url).startsWith("https://uploads.github.com/")) {
      const chunks = [];
      for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
      uploaded = Buffer.concat(chunks);
      return Response.json({ id: 99, name: new URL(url).searchParams.get("name") });
    }
    throw new Error(`Unexpected GitHub request: ${url}`);
  };
  const library = new GameLibrary({ token: "test-token", repository: "owner/games", fetcher });
  try {
    const game = await library.saveReleaseFile({
      name: "Homebrew DS",
      system: "nds",
      license: "MIT",
      licenseUrl: "https://example.org/license",
      filename: "homebrew.nds"
    }, temporaryPath, file.length);

    assert.equal(game.storage, "github-release");
    assert.equal(game.assetName.endsWith(".nds"), true);
    assert.deepEqual(uploaded, file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("GitHub repository imports stream to a release when the source omits Content-Length", async () => {
  const bytes = Buffer.from([5, 4, 3, 2, 1]);
  let uploaded = Buffer.alloc(0);
  const fetcher = async (url, options = {}) => {
    if (String(url).startsWith("https://raw.githubusercontent.com/owner/source/")) {
      return new Response(bytes);
    }
    if (String(url).startsWith("https://api.github.com/") && String(url).endsWith("/releases")) {
      return Response.json({ id: 18, upload_url: "https://uploads.github.com/repos/owner/library/releases/18/assets{?name,label}" });
    }
    if (String(url).startsWith("https://uploads.github.com/")) {
      const chunks = [];
      for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
      uploaded = Buffer.concat(chunks);
      return Response.json({ id: 100 });
    }
    throw new Error(`Unexpected GitHub request: ${url}`);
  };
  const library = new GameLibrary({ token: "test-token", repository: "owner/library", fetcher });
  const game = await library.importFromRepository({
    name: "Homebrew DS",
    system: "nds",
    license: "MIT",
    licenseUrl: "https://example.org/license",
    repository: "owner/source",
    branch: "main",
    filePath: "games/homebrew.nds"
  });
  assert.equal(game.sourceRepository, "owner/source");
  assert.deepEqual(uploaded, bytes);
});

test("private same-repository imports use authenticated Contents API", async () => {
  const bytes = Buffer.from([9, 8, 7, 6]);
  let importedRequest;
  let uploaded = Buffer.alloc(0);
  const fetcher = async (url, options = {}) => {
    if (String(url).includes("/contents/public/games/nds/homebrew.nds?ref=main")) {
      importedRequest = { url: String(url), headers: options.headers };
      return new Response(bytes);
    }
    if (String(url).endsWith("/releases")) {
      return Response.json({ id: 31, upload_url: "https://uploads.github.com/repos/owner/private/releases/31/assets{?name,label}" });
    }
    if (String(url).startsWith("https://uploads.github.com/")) {
      const chunks = [];
      for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
      uploaded = Buffer.concat(chunks);
      return Response.json({ id: 101 });
    }
    throw new Error(`Unexpected GitHub request: ${url}`);
  };
  const library = new GameLibrary({ token: "private-token", repository: "owner/private", fetcher });
  await library.importFromRepository({
    name: "Homebrew DS",
    system: "nds",
    license: "MIT",
    licenseUrl: "https://example.org/license",
    repository: "owner/private",
    branch: "main",
    filePath: "public/games/nds/homebrew.nds"
  });
  assert.equal(importedRequest.headers.Authorization, "Bearer private-token");
  assert.equal(importedRequest.headers.Accept, "application/vnd.github.raw+json");
  assert.deepEqual(uploaded, bytes);
});

test("private release listings use the app download proxy instead of exposing GitHub assets", async () => {
  const game = {
    id: "game-id",
    name: "Private DS",
    system: "nds",
    license: "MIT",
    licenseUrl: "https://example.org/license",
    releaseTag: "klai-game-id",
    assetName: "private-ds.nds",
    storage: "github-release"
  };
  const fetcher = async (url, options = {}) => {
    if (url.includes("contents/public/games/catalog.json")) {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (url.endsWith("releases?per_page=100&page=1")) {
      return Response.json([{ tag_name: game.releaseTag, body: JSON.stringify(game), assets: [{ name: game.assetName }] }]);
    }
    if (url.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "head" } });
    if (url.endsWith("/git/commits/head")) return Response.json({ tree: { sha: "tree" } });
    if (url.endsWith("/git/trees/tree?recursive=1")) return Response.json({ tree: [] });
    throw new Error(`Unexpected GitHub request: ${url}`);
  };
  const library = new GameLibrary({ token: "test-token", repository: "owner/private-games", fetcher });
  const result = await library.list();
  assert.equal(result.games[0].downloadUrl, "/api/games/game-id/download");
});

test("library discovers manual game files from the private Git tree without duplicating catalog entries", async () => {
  const catalogGame = {
    id: "catalog-nes",
    name: "Catalog NES",
    system: "nes",
    path: "public/games/nes/catalog.nes",
    license: "MIT"
  };
  const catalogContent = Buffer.from(JSON.stringify([catalogGame])).toString("base64");
  const fetcher = async (url, options = {}) => {
    if (url.includes("contents/public/games/catalog.json")) {
      return Response.json({ content: catalogContent });
    }
    if (url.endsWith("releases?per_page=100&page=1")) return Response.json([]);
    if (url.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "head" } });
    if (url.endsWith("/git/commits/head")) return Response.json({ tree: { sha: "tree" } });
    if (url.endsWith("/git/trees/tree?recursive=1")) {
      return Response.json({ tree: [
        { type: "blob", path: catalogGame.path, size: 100 },
        { type: "blob", path: "public/games/nds/homebrew.ds.nds", size: 250000000 },
        { type: "blob", path: "public/games/nds/not-a-rom.txt", size: 12 },
        { type: "blob", path: "public/README.md", size: 20 }
      ] });
    }
    if (url.includes("/contents/public/games/nds/homebrew.ds.nds?ref=main")) {
      assert.equal(options.headers.Authorization, "Bearer token");
      assert.equal(options.headers.Accept, "application/vnd.github.raw+json");
      return new Response(Buffer.from([1, 2, 3]));
    }
    throw new Error(`Unexpected GitHub request: ${url}`);
  };
  const library = new GameLibrary({ token: "token", repository: "owner/private", fetcher });
  const result = await library.list();
  assert.equal(result.games.length, 2);
  const manualGame = result.games.find(game => game.system === "nds");
  assert.equal(manualGame.path, "public/games/nds/homebrew.ds.nds");
  assert.equal(result.games.find(game => game.id === "catalog-nes").name, "Catalog NES");
  const download = await library.getGameDownload(manualGame.id);
  assert.deepEqual(Buffer.from(await download.response.arrayBuffer()), Buffer.from([1, 2, 3]));
});

test("private GitHub Release downloads use authenticated asset API responses", async () => {
  const game = {
    id: "private-game-id",
    name: "Private DS",
    system: "nds",
    releaseTag: "klai-game-private-game-id",
    assetName: "private-ds.nds",
    storage: "github-release"
  };
  const bytes = Buffer.from([8, 7, 6]);
  const fetcher = async (url, options = {}) => {
    if (url.includes("contents/public/games/catalog.json")) {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (url.endsWith("releases?per_page=100&page=1")) {
      return Response.json([{ tag_name: game.releaseTag, body: JSON.stringify(game), assets: [{ name: game.assetName }] }]);
    }
    if (url.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "head" } });
    if (url.endsWith("/git/commits/head")) return Response.json({ tree: { sha: "tree" } });
    if (url.endsWith("/git/trees/tree?recursive=1")) return Response.json({ tree: [] });
    if (url.endsWith(`/releases/tags/${game.releaseTag}`)) {
      return Response.json({ assets: [{ id: 22, name: game.assetName }] });
    }
    if (url.endsWith("/releases/assets/22")) {
      assert.equal(options.headers.Accept, "application/octet-stream");
      assert.equal(options.headers.Authorization, "Bearer test-token");
      return new Response(bytes);
    }
    throw new Error(`Unexpected GitHub request: ${url}`);
  };
  const library = new GameLibrary({ token: "test-token", repository: "owner/private-games", fetcher });
  const result = await library.getGameDownload(game.id);
  assert.equal(result.game.id, game.id);
  assert.deepEqual(Buffer.from(await result.response.arrayBuffer()), bytes);
});

test("game uploads require a secure license reference and enforce the 250 MB file size cap", () => {
  assert.equal(validateLicense("MIT", "https://example.org/license").license, "MIT");
  assert.throws(() => validateLicense("", "https://example.org/license"), /اذكر ترخيص/);
  assert.throws(() => validateLicense("MIT", "http://example.org/license"), /HTTPS/);
  assert.equal(MAX_GAME_BYTES, 250 * 1024 * 1024);
  assert.throws(() => validateGameFile("nes", "game.nes", MAX_GAME_BYTES + 1), /250 ميغابايت/);
});

test("GitHub source validation rejects traversal and only builds raw GitHub URLs", () => {
  const source = validateSource({ repository: "games/homebrew", branch: "main", filePath: "releases/demo.nes" });
  assert.equal(source.url, "https://raw.githubusercontent.com/games/homebrew/main/releases/demo.nes");
  assert.throws(() => validateSource({ repository: "games/homebrew", branch: "main", filePath: "../secret.nes" }), /غير صالح/);
  assert.throws(() => validateSource({ repository: "https://evil.example/file", branch: "main", filePath: "game.nes" }), /owner\/repository/);
});

test("remote controller inputs map presses and releases even when assigned to player two", () => {
  assert.deepEqual(mapRemoteInput({ player: 2, button: "a", pressed: true }), {
    player: 1, index: 8, value: 1
  });
  assert.deepEqual(mapRemoteInput({ player: 2, button: "a", pressed: false }), {
    player: 1, index: 8, value: 0
  });
  assert.equal(mapRemoteInput({ player: 2, button: "unknown", pressed: true }), null);
  assert.deepEqual(mapRemoteInput({ player: 4, button: "right", pressed: true }), {
    player: 3, index: 7, value: 1
  });
});

test("each player input is independent and held controls are released on disconnect", () => {
  const state = new RemoteInputState();
  assert.deepEqual(state.apply({ player: 1, button: "bad", pressed: true }), []);
  assert.deepEqual(state.apply({ player: 1, button: "a", pressed: true }), [{ player: 0, index: 8, value: 1 }]);
  assert.deepEqual(state.apply({ player: 2, button: "a", pressed: true }), [{ player: 1, index: 8, value: 1 }]);
  assert.deepEqual(state.apply({ player: 1, button: "a", pressed: true }), []);
  assert.deepEqual(state.apply({ player: 1, button: "a", pressed: false }), [{ player: 0, index: 8, value: 0 }]);
  state.apply({ player: 3, button: "up", pressed: true });
  assert.deepEqual(state.releaseAll(), [
    { player: 1, index: 8, value: 0 },
    { player: 2, index: 4, value: 0 }
  ]);
});

test("analog axes map both directions to EmulatorJS indexes and release cleanly", () => {
  assert.deepEqual(mapRemoteAxis({ player: 2, axis: "left-x", value: 0.5 }), [
    { player: 1, index: 16, value: 16384 },
    { player: 1, index: 17, value: 0 }
  ]);
  assert.deepEqual(mapRemoteAxis({ player: 2, axis: "left-y", value: -1 }), [
    { player: 1, index: 18, value: 0 },
    { player: 1, index: 19, value: 32767 }
  ]);
  assert.equal(mapRemoteAxis({ player: 1, axis: "left-x", value: 1.5 }), null);

  const state = new RemoteInputState();
  state.apply({ player: 1, axis: "left-x", value: 0.6 });
  assert.deepEqual(state.releaseAll(), [{ player: 0, index: 16, value: 0 }]);
});

test("all gamepad controls map to libretro indexes for each of four players", () => {
  const expected = {
    b: 0, y: 1, select: 2, start: 3,
    up: 4, down: 5, left: 6, right: 7,
    a: 8, x: 9, l1: 10, r1: 11,
    l2: 12, r2: 13, l3: 14, r3: 15
  };
  for (let player = 1; player <= 4; player++) {
    for (const [button, index] of Object.entries(expected)) {
      assert.deepEqual(mapRemoteInput({ player, button, pressed: true }), {
        player: player - 1, index, value: 1
      });
    }
  }
});

test("saving a licensed game commits the binary and catalog to the configured branch", async () => {
  const calls = [];
  let blobNumber = 0;
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes("/contents/public/games/catalog.json")) {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }
    if (url.endsWith("/git/ref/heads/main")) {
      return Response.json({ object: { sha: "head-sha" } });
    }
    if (url.endsWith("/git/commits/head-sha")) {
      return Response.json({ tree: { sha: "base-tree" } });
    }
    if (url.endsWith("/git/blobs")) {
      blobNumber += 1;
      return Response.json({ sha: `blob-${blobNumber}` });
    }
    if (url.endsWith("/git/trees")) return Response.json({ sha: "new-tree" });
    if (url.endsWith("/git/commits")) return Response.json({ sha: "new-commit" });
    if (url.endsWith("/git/refs/heads/main")) return Response.json({ ref: "refs/heads/main" });
    throw new Error(`Unexpected GitHub request: ${url}`);
  };
  const library = new GameLibrary({
    token: "test-token",
    repository: "test-owner/test-games",
    branch: "main",
    fetcher
  });

  const game = await library.upload({
    name: "My Demo",
    system: "nes",
    license: "MIT",
    licenseUrl: "https://example.org/license",
    filename: "demo.nes"
  }, Buffer.from([1, 2, 3]));

  assert.equal(game.path.startsWith("public/games/nes/my-demo-"), true);
  assert.equal(calls.filter(call => call.url.endsWith("/git/blobs")).length, 2);
  const treeRequest = calls.find(call => call.url.endsWith("/git/trees"));
  const treePayload = JSON.parse(treeRequest.options.body);
  assert.deepEqual(treePayload.tree.map(entry => entry.path).sort(), [
    game.path,
    "public/games/catalog.json"
  ].sort());
  assert.equal(calls.some(call => call.url.endsWith("/git/refs/heads/main") && call.options.method === "PATCH"), true);
});