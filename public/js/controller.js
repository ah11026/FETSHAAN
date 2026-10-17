const socket = io({
  transports: ["websocket", "polling"],
  tryAllTransports: true,
  rememberUpgrade: true,
  timeout: 20000,
  reconnection: true,
  reconnectionDelay: 500,
  reconnectionDelayMax: 5000
});
const roomCode = new URLSearchParams(location.search).get("room");
const status = document.querySelector("#status");
const padStatus = document.querySelector("#padStatus");
const pad = document.querySelector("#pad");
const join = document.querySelector("#join");
const joinButton = document.querySelector("#joinButton");
const pressed = new Set();
const axes = new Map([["left-x", 0], ["left-y", 0]]);
let joined = false;
let joining = false;
let shouldRejoin = false;
let playerName = "";
let stickPointerId = null;
let lastAxisSent = 0;

function send(button, down) {
  if (!joined) return;
  if (down) pressed.add(button);
  else pressed.delete(button);
  socket.timeout(2500).emit("input", { button, pressed: down }, (error, result) => {
    if (!joined) return;
    if (error) {
      padStatus.textContent = "تأخر إرسال الأزرار؛ تحقق من اتصال الهاتف.";
    } else if (!result?.ok) {
      padStatus.textContent = result?.error ?? "تعذر إرسال الزر.";
    } else {
      padStatus.textContent = "متصل بالغرفة · الأزرار تعمل";
    }
  });
}

function sendAxis(axis, value) {
  const normalized = Math.abs(value) < 0.12
    ? 0
    : Math.round(Math.max(-1, Math.min(1, value)) * 100) / 100;
  if (!joined || axes.get(axis) === normalized) return;
  axes.set(axis, normalized);
  socket.timeout(2500).emit("input", { axis, value: normalized }, (error, result) => {
    if (!joined) return;
    if (error) padStatus.textContent = "تأخر إرسال العصا؛ تحقق من اتصال الهاتف.";
    else if (!result?.ok) padStatus.textContent = result?.error ?? "تعذر إرسال العصا.";
    else padStatus.textContent = "متصل بالغرفة · التحكم يعمل";
  });
}

function releaseAxes() {
  for (const axis of axes.keys()) sendAxis(axis, 0);
  document.querySelector("#stickKnob").style.transform = "translate(-50%, -50%)";
}

function releaseAll() {
  if (joined && socket.connected) {
    for (const button of [...pressed]) socket.emit("input", { button, pressed: false });
  }
  releaseAxes();
  pressed.clear();
  document.querySelectorAll("[data-button].pressed").forEach(button => button.classList.remove("pressed"));
}

function showJoin(message, closed = false) {
  releaseAll();
  joined = false;
  joining = false;
  if (closed) shouldRejoin = false;
  pad.classList.remove("active");
  join.hidden = false;
  if (message) status.textContent = message;
}

function joinRoom() {
  if (!roomCode || !/^\d{6}$/.test(roomCode)) {
    status.textContent = "رابط الغرفة غير صالح";
    return false;
  }
  if (!socket.connected) {
    status.textContent = "جارٍ الاتصال بالخادم...";
    return false;
  }
  if (joining || joined) return false;

  joining = true;
  joinButton.disabled = true;
  status.textContent = "جارٍ الانضمام إلى الغرفة...";
  socket.timeout(20000).emit("room:join", {
    code: roomCode,
    name: playerName
  }, (timeoutError, result) => {
    joining = false;
    joinButton.disabled = false;
    if (timeoutError) {
      status.textContent = "لم يرد الخادم؛ تحقق من الاتصال وحاول مجدداً.";
      return;
    }
    if (!result?.ok) {
      status.textContent = result?.error ?? "تعذر الانضمام";
      return;
    }
    joined = true;
    shouldRejoin = false;
    join.hidden = true;
    pad.classList.add("active");
    document.querySelector("#playerLabel").textContent = `اللاعب ${result.player}`;
    padStatus.textContent = "متصل بالغرفة";
  });
  return true;
}

joinButton.addEventListener("click", () => {
  playerName = document.querySelector("#name").value.trim();
  joinRoom();
});

document.querySelector("#name").addEventListener("keydown", event => {
  if (event.key === "Enter") joinButton.click();
});

document.querySelectorAll("[data-button]").forEach(button => {
  const name = button.dataset.button;
  button.addEventListener("pointerdown", event => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    button.classList.add("pressed");
    send(name, true);
  });

  const release = event => {
    event.preventDefault();
    button.classList.remove("pressed");
    send(name, false);
  };
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
  button.addEventListener("lostpointercapture", () => {
    button.classList.remove("pressed");
    send(name, false);
  });
});

const leftStick = document.querySelector("#leftStick");
const stickKnob = document.querySelector("#stickKnob");

function moveStick(event) {
  const bounds = leftStick.getBoundingClientRect();
  const radius = bounds.width / 2;
  const dx = Math.max(-1, Math.min(1, (event.clientX - (bounds.left + radius)) / (radius * 0.62)));
  const dy = Math.max(-1, Math.min(1, (event.clientY - (bounds.top + radius)) / (radius * 0.62)));
  stickKnob.style.transform = `translate(calc(-50% + ${dx * radius * 0.48}px), calc(-50% + ${dy * radius * 0.48}px))`;
  const now = performance.now();
  if (now - lastAxisSent < 30) return;
  lastAxisSent = now;
  sendAxis("left-x", dx);
  sendAxis("left-y", dy);
}

leftStick.addEventListener("pointerdown", event => {
  event.preventDefault();
  stickPointerId = event.pointerId;
  lastAxisSent = 0;
  leftStick.setPointerCapture(event.pointerId);
  moveStick(event);
});
leftStick.addEventListener("pointermove", event => {
  if (event.pointerId === stickPointerId) moveStick(event);
});

function finishStick(event) {
  if (event.pointerId !== stickPointerId) return;
  stickPointerId = null;
  releaseAxes();
}

leftStick.addEventListener("pointerup", finishStick);
leftStick.addEventListener("pointercancel", finishStick);
leftStick.addEventListener("lostpointercapture", finishStick);

document.querySelectorAll("[data-move-mode]").forEach(button => {
  button.addEventListener("click", () => {
    releaseAxes();
    for (const heldButton of document.querySelectorAll("[data-button].pressed")) {
      send(heldButton.dataset.button, false);
      heldButton.classList.remove("pressed");
    }
    const stickMode = button.dataset.moveMode === "stick";
    document.querySelector("#dpad").hidden = stickMode;
    leftStick.hidden = !stickMode;
    for (const modeButton of document.querySelectorAll("[data-move-mode]")) {
      const active = modeButton === button;
      modeButton.classList.toggle("active", active);
      modeButton.setAttribute("aria-pressed", String(active));
    }
  });
});

window.addEventListener("blur", releaseAll);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) releaseAll();
});

socket.on("connect", () => {
  if (shouldRejoin && playerName) {
    status.textContent = "عاد الاتصال؛ جارٍ إعادة الانضمام...";
    joinRoom();
  } else if (!joined) {
    status.textContent = roomCode ? "أدخل اسمك للانضمام" : "رابط الغرفة غير صالح";
  }
});

socket.on("disconnect", () => {
  shouldRejoin = joined || shouldRejoin;
  showJoin(shouldRejoin ? "انقطع الاتصال؛ سنعيد الانضمام عند عودة الشبكة." : "انقطع الاتصال؛ أعد الاتصال للانضمام.");
});

socket.on("connect_error", () => {
  status.textContent = "تعذر الاتصال بالخادم؛ جارٍ إعادة المحاولة...";
});

socket.on("room:closed", () => showJoin("أغلق المضيف الغرفة.", true));