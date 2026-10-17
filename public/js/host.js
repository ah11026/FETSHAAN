const socket = io({
  transports: ["websocket", "polling"],
  tryAllTransports: true,
  rememberUpgrade: true,
  timeout: 20000,
  reconnection: true,
  reconnectionDelay: 500,
  reconnectionDelayMax: 5000
});
const qr = document.querySelector("#qr");
const qrWrap = document.querySelector(".qr-wrap");
const roomCode = document.querySelector("#roomCode");
const joinUrl = document.querySelector("#joinUrl");
const qrStatus = document.querySelector("#qrStatus");
const players = document.querySelector("#players");
const playerCount = document.querySelector("#playerCount");
const playerTotal = document.querySelector("#playerTotal");
const connection = document.querySelector(".connection");
const connectionLabel = document.querySelector("#connectionLabel");
const inputReadout = document.querySelector("#inputReadout");
const gameStatus = document.querySelector("#gameStatus");
const toast = document.querySelector("#toast");
const libraryList = document.querySelector("#libraryList");
const libraryStatus = document.querySelector("#libraryStatus");
const libraryKey = document.querySelector("#libraryKey");
const emulatorFrame = document.querySelector("#emulatorFrame");
let hostToken = "";
let toastTimeout;
let emulatorReady = false;
let pendingEmulatorGameUrl = "";
const pendingEmulatorMessages = [];

function sendEmulatorMessage(message) {
  if (emulatorReady && emulatorFrame.contentWindow) {
    emulatorFrame.contentWindow.postMessage(message, location.origin);
    return;
  }
  if (pendingEmulatorMessages.length >= 512) {
    pendingEmulatorMessages.length = 0;
    pendingEmulatorMessages.push({ type: "remote-input-release-all" });
  }
  pendingEmulatorMessages.push(message);
}

window.addEventListener("message", event => {
  if (event.origin !== location.origin || event.source !== emulatorFrame.contentWindow) return;
  if (event.data?.type === "emulator-init" && pendingEmulatorGameUrl) {
    emulatorFrame.contentWindow.postMessage({
      type: "emulator-config",
      system: emulatorFrame.dataset.system,
      gameUrl: pendingEmulatorGameUrl
    }, location.origin);
    pendingEmulatorGameUrl = "";
    return;
  }
  if (event.data?.type !== "emulator-ready") return;
  emulatorReady = true;
  while (pendingEmulatorMessages.length) {
    emulatorFrame.contentWindow.postMessage(pendingEmulatorMessages.shift(), location.origin);
  }
});

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("visible"), 1800);
}

async function loadQr(code) {
  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(code)}/qr`, {
      headers: { Authorization: `Bearer ${hostToken}` }
    });
    if (!response.ok) throw new Error("QR request failed");
    const data = await response.json();
    qr.src = data.qr;
    joinUrl.textContent = data.url;
    qrWrap.classList.add("has-qr");
    qrStatus.textContent = "امسح الرمز بكاميرا جوالك";
  } catch {
    qrStatus.textContent = "تعذر تجهيز الرمز؛ تحقق من عنوان الشبكة.";
    joinUrl.textContent = "";
  }
}

function renderPlayers(list) {
  playerCount.textContent = String(list.length);
  playerTotal.textContent = String(list.length);
  players.replaceChildren();
  if (!list.length) {
    const empty = document.createElement("li");
    empty.className = "empty-player";
    empty.innerHTML = '<span class="empty-plus">+</span><span>أول لاعب له مكان هنا</span>';
    players.append(empty);
    return;
  }

  for (const player of list) {
    const item = document.createElement("li");
    const avatar = document.createElement("span");
    avatar.className = `player-avatar p${player.player}`;
    avatar.textContent = `P${player.player}`;
    const name = document.createElement("span");
    name.className = "player-name";
    name.textContent = player.name;
    const number = document.createElement("span");
    number.className = "player-number";
    number.textContent = `P${player.player}`;
    item.append(avatar, name, number);
    players.append(item);
  }
}

function renderLibrary(data) {
  libraryList.replaceChildren();
  if (!data.enabled) {
    const empty = document.createElement("li");
    empty.className = "library-empty";
    empty.textContent = "مكتبة GitHub غير مهيأة على الخادم.";
    libraryList.append(empty);
    return;
  }
  if (!data.games.length) {
    const empty = document.createElement("li");
    empty.className = "library-empty";
    empty.textContent = "لا توجد ألعاب محفوظة في المستودع بعد.";
    libraryList.append(empty);
    return;
  }

  for (const game of data.games) {
    const item = document.createElement("li");
    item.className = "library-game";
    const details = document.createElement("div");
    details.className = "library-game-details";
    const title = document.createElement("strong");
    title.textContent = game.name;
    const metadata = document.createElement("span");
    metadata.textContent = `${game.system.toUpperCase()} · ${game.license}`;
    details.append(title, metadata);

    const download = document.createElement("a");
    download.className = "download-game";
    download.href = "#";
    download.textContent = "تنزيل";
    download.setAttribute("aria-label", `تنزيل ${game.name}`);
    download.addEventListener("click", async event => {
      event.preventDefault();
      try {
        location.assign(await getGameDownloadUrl(game.id));
      } catch (error) {
        libraryStatus.textContent = error.message;
      }
    });

    const actions = document.createElement("div");
    actions.className = "library-game-actions";
    const play = document.createElement("button");
    play.className = "play-game";
    play.type = "button";
    play.textContent = "تشغيل";
    play.addEventListener("click", () => launchGame(game));
    actions.append(play, download);
    item.append(details, actions);
    libraryList.append(item);
  }
}

async function getGameDownloadUrl(gameId) {
  if (!libraryKey.value) throw new Error("أدخل مفتاح إدارة المكتبة أولاً.");
  const response = await fetch(`/api/games/${encodeURIComponent(gameId)}/download-ticket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${libraryKey.value}` }
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "تعذر تجهيز تنزيل اللعبة");
  return new URL(result.url, location.origin).toString();
}

async function launchGame(game) {
  if (!new Set(["nes", "snes", "n64", "psx", "nds"]).has(game.system)) {
    libraryStatus.textContent = "نظام اللعبة غير مدعوم.";
    return;
  }
  try {
    const downloadUrl = await getGameDownloadUrl(game.id);
    const url = new URL("/emulator.html", location.origin);
    url.searchParams.set("system", game.system);
    pendingEmulatorGameUrl = downloadUrl;
    emulatorReady = false;
    pendingEmulatorMessages.length = 0;
    document.querySelector("#gameScreen .screen-content").hidden = true;
    emulatorFrame.hidden = false;
    emulatorFrame.dataset.system = game.system;
    emulatorFrame.src = url.toString();
    gameStatus.textContent = `جارٍ تشغيل ${game.name} عبر EmulatorJS...`;
  } catch (error) {
    libraryStatus.textContent = error.message;
  }
}

async function refreshLibrary() {
  if (!libraryKey.value) {
    libraryList.replaceChildren();
    const empty = document.createElement("li");
    empty.className = "library-empty";
    empty.textContent = "أدخل مفتاح إدارة المكتبة لعرض ألعاب المستودع الخاص.";
    libraryList.append(empty);
    return;
  }
  try {
    const headers = libraryKey.value ? { Authorization: `Bearer ${libraryKey.value}` } : {};
    const response = await fetch("/api/games", { headers });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "تعذر تحميل المكتبة");
    renderLibrary(result);
  } catch (error) {
    libraryList.replaceChildren();
    const empty = document.createElement("li");
    empty.className = "library-empty error";
    empty.textContent = error.message;
    libraryList.append(empty);
  }
}

function readGameMetadata() {
  return {
    name: document.querySelector("#gameName").value.trim(),
    system: document.querySelector("#gameSystem").value,
    license: document.querySelector("#gameLicense").value.trim(),
    licenseUrl: document.querySelector("#gameLicenseUrl").value.trim()
  };
}

async function sendLibraryRequest(url, options, button) {
  if (!libraryKey.value) {
    libraryStatus.textContent = "أدخل مفتاح إدارة المكتبة أولاً.";
    return;
  }
  button.disabled = true;
  libraryStatus.textContent = "جارٍ حفظ اللعبة في GitHub...";
  try {
    const response = await fetch(url, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${libraryKey.value}` }
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "تعذر حفظ اللعبة");
    libraryStatus.textContent = `حُفظت «${result.game.name}» في مستودعك.`;
    await refreshLibrary();
  } catch (error) {
    libraryStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

document.querySelector("#uploadGame").addEventListener("click", event => {
  const file = document.querySelector("#gameFile").files[0];
  if (!file) {
    libraryStatus.textContent = "اختر ملف اللعبة أولاً.";
    return;
  }
  if (file.size > 250 * 1024 * 1024) {
    libraryStatus.textContent = "حجم الملف يتجاوز الحد الأقصى البالغ 250 ميغابايت.";
    return;
  }
  uploadGameInChunks(file, readGameMetadata(), event.currentTarget);
});

async function uploadGameInChunks(file, metadata, button) {
  if (!libraryKey.value) {
    libraryStatus.textContent = "أدخل مفتاح إدارة المكتبة أولاً.";
    return;
  }
  button.disabled = true;
  let uploadId;
  const headers = {
    Authorization: `Bearer ${libraryKey.value}`,
    "Content-Type": "application/json"
  };
  try {
    libraryStatus.textContent = "جارٍ تجهيز الرفع المجزأ...";
    const startResponse = await fetch("/api/games/upload/start", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...metadata, filename: file.name, size: file.size })
    });
    const startResult = await startResponse.json();
    if (!startResponse.ok) throw new Error(startResult.error || "تعذر بدء الرفع");
    uploadId = startResult.uploadId;

    for (let index = 0; index < startResult.totalChunks; index += 1) {
      const start = index * startResult.chunkSize;
      const chunk = file.slice(start, Math.min(file.size, start + startResult.chunkSize));
      const chunkResponse = await fetch(`/api/games/upload/${encodeURIComponent(uploadId)}/chunks/${index}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${libraryKey.value}`, "Content-Type": "application/octet-stream" },
        body: chunk
      });
      const chunkResult = await chunkResponse.json();
      if (!chunkResponse.ok) throw new Error(chunkResult.error || "تعذر رفع جزء من الملف");
      const progress = Math.round(chunkResult.received / chunkResult.total * 100);
      libraryStatus.textContent = `جارٍ رفع اللعبة إلى GitHub Releases: ${progress}%`;
    }

    const finishResponse = await fetch(`/api/games/upload/${encodeURIComponent(uploadId)}/finish`, {
      method: "POST",
      headers: { Authorization: `Bearer ${libraryKey.value}` }
    });
    const finishResult = await finishResponse.json();
    if (!finishResponse.ok) throw new Error(finishResult.error || "تعذر إنهاء الرفع");
    libraryStatus.textContent = `اكتمل رفع «${finishResult.game.name}» إلى GitHub Releases.`;
    await refreshLibrary();
  } catch (error) {
    libraryStatus.textContent = error.message;
    if (uploadId) {
      await fetch(`/api/games/upload/${encodeURIComponent(uploadId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${libraryKey.value}` }
      }).catch(() => {});
    }
  } finally {
    button.disabled = false;
  }
}

libraryKey.addEventListener("change", refreshLibrary);

document.querySelector("#importGame").addEventListener("click", event => {
  const payload = {
    ...readGameMetadata(),
    repository: document.querySelector("#sourceRepository").value.trim(),
    branch: document.querySelector("#sourceBranch").value.trim(),
    filePath: document.querySelector("#sourcePath").value.trim()
  };
  sendLibraryRequest("/api/games/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }, event.currentTarget);
});

document.querySelector("#refreshLibrary").addEventListener("click", refreshLibrary);
document.querySelectorAll("[data-library-mode]").forEach(button => {
  button.addEventListener("click", () => {
    const activeButton = document.querySelector("[data-library-mode].active");
    activeButton?.classList.remove("active");
    activeButton?.setAttribute("aria-pressed", "false");
    button.classList.add("active");
    button.setAttribute("aria-pressed", "true");
    document.querySelector("#uploadPanel").hidden = button.dataset.libraryMode !== "upload";
    document.querySelector("#importPanel").hidden = button.dataset.libraryMode !== "import";
  });
});

socket.on("connect", () => {
  connection.classList.add("connected");
  connectionLabel.textContent = "متصل بالخادم";
  socket.emit("room:create", async result => {
    if (!result?.ok) {
      qrStatus.textContent = result?.error ?? "تعذر إنشاء الغرفة";
      return;
    }
    hostToken = result.hostToken;
    roomCode.textContent = result.code;
    await loadQr(result.code);
  });
});

socket.on("disconnect", () => {
  connection.classList.remove("connected");
  connectionLabel.textContent = "انقطع الاتصال";
  qrStatus.textContent = "انقطع الاتصال بالخادم";
  sendEmulatorMessage({ type: "remote-input-release-all" });
});

socket.on("connect_error", () => {
  connection.classList.remove("connected");
  connectionLabel.textContent = "إعادة محاولة الاتصال";
});

socket.on("room:state", state => renderPlayers(state.players));

socket.on("game:input", event => {
  inputReadout.textContent = event.axis
    ? `P${event.player} · عصا ${event.axis} ${event.value.toFixed(2)}`
    : `P${event.player} · ${event.pressed ? "ضغط" : "أفلت"} ${event.button}`;
  window.dispatchEvent(new CustomEvent("remote-game-input", { detail: event }));
  sendEmulatorMessage({ type: "remote-game-input", detail: event });
});

socket.on("room:closed", () => {
  qrStatus.textContent = "أغلق المضيف الغرفة";
  renderPlayers([]);
});

document.querySelectorAll("[data-system]").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelector(".system-item.selected")?.classList.remove("selected");
    button.classList.add("selected");
    document.querySelector("#gameSystem").value = button.dataset.core;
    gameStatus.textContent = `تم اختيار ${button.dataset.system}. اختر لعبة من المكتبة واضغط «تشغيل».`;
  });
});

document.querySelector("#copyLink").addEventListener("click", async () => {
  const value = joinUrl.textContent;
  if (!value.startsWith("http")) return;
  try {
    await navigator.clipboard.writeText(value);
    showToast("تم نسخ رابط الانضمام");
  } catch {
    showToast("تعذر نسخ الرابط من هذا المتصفح");
  }
});

refreshLibrary();