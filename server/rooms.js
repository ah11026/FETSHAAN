import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const MAX_PLAYERS = 4;
export const ALLOWED_BUTTONS = new Set([
  "up", "down", "left", "right", "a", "b", "x", "y",
  "start", "select", "l1", "r1", "l2", "r2", "l3", "r3"
]);
export const ALLOWED_AXES = new Set(["left-x", "left-y", "right-x", "right-y"]);

export class RoomStore {
  rooms = new Map();
  socketRooms = new Map();

  create(hostId) {
    if (this.socketRooms.has(hostId)) return null;

    let code;
    do {
      code = String(randomInt(100000, 1000000));
    } while (this.rooms.has(code));

    const hostToken = randomBytes(32).toString("hex");
    this.rooms.set(code, {
      code,
      hostId,
      hostToken,
      players: new Map(),
      pressed: new Map(),
      axes: new Map()
    });
    this.socketRooms.set(hostId, code);
    return { code, hostToken, players: [] };
  }

  authenticateHost(code, token) {
    const room = this.rooms.get(String(code));
    if (!room || typeof token !== "string") return false;
    const expected = Buffer.from(room.hostToken);
    const actual = Buffer.from(token);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  join(code, socketId, name) {
    const room = this.rooms.get(String(code ?? ""));
    if (!room) return { ok: false, error: "الغرفة غير موجودة" };
    const existingMember = room.players.get(socketId);
    if (existingMember) {
      return {
        ok: true,
        player: existingMember.player,
        code: room.code,
        state: this.state(room)
      };
    }
    if (this.socketRooms.has(socketId)) {
      return { ok: false, error: "هذا الاتصال منضم بالفعل" };
    }
    if (room.players.size >= MAX_PLAYERS) {
      return { ok: false, error: "الغرفة ممتلئة" };
    }

    const occupied = new Set([...room.players.values()].map(player => player.player));
    const player = Array.from({ length: MAX_PLAYERS }, (_, index) => index + 1)
      .find(number => !occupied.has(number));
    const safeName = typeof name === "string" ? name.trim().slice(0, 24) : "";
    const member = {
      id: socketId,
      player,
      name: safeName || `لاعب ${player}`
    };

    room.players.set(socketId, member);
    room.pressed.set(socketId, new Set());
    room.axes.set(socketId, new Map());
    this.socketRooms.set(socketId, room.code);
    return { ok: true, player, code: room.code, state: this.state(room) };
  }

  input(socketId, payload) {
    const code = this.socketRooms.get(socketId);
    const room = this.rooms.get(code);
    const member = room?.players.get(socketId);
    if (!room || !member) return { ok: false, error: "غير مسجل كلاعب" };

    const { button, pressed, axis, value } = payload ?? {};
    if (typeof axis === "string") {
      if (!ALLOWED_AXES.has(axis) || typeof value !== "number" || !Number.isFinite(value) || value < -1 || value > 1) {
        return { ok: false, error: "محور العصا غير صالح" };
      }
      const normalized = Math.abs(value) < 0.12 ? 0 : Math.round(value * 100) / 100;
      const axisState = room.axes.get(socketId);
      if (axisState.get(axis) === normalized) return { ok: true, changed: false };
      axisState.set(axis, normalized);
      return {
        ok: true,
        changed: true,
        hostId: room.hostId,
        event: { player: member.player, axis, value: normalized, at: Date.now() }
      };
    }

    if (!ALLOWED_BUTTONS.has(button) || typeof pressed !== "boolean") {
      return { ok: false, error: "مدخل غير صالح" };
    }

    const state = room.pressed.get(socketId);
    if (state.has(button) === pressed) return { ok: true, changed: false };
    if (pressed) state.add(button);
    else state.delete(button);

    return {
      ok: true,
      changed: true,
      hostId: room.hostId,
      event: { player: member.player, button, pressed, at: Date.now() }
    };
  }

  state(room) {
    return {
      code: room.code,
      players: [...room.players.values()].map(({ id, player, name }) => ({ id, player, name }))
    };
  }

  leave(socketId) {
    const code = this.socketRooms.get(socketId);
    this.socketRooms.delete(socketId);
    const room = this.rooms.get(code);
    if (!room) return null;

    if (room.hostId === socketId) {
      const playerIds = [...room.players.keys()];
      this.rooms.delete(code);
      for (const playerId of playerIds) this.socketRooms.delete(playerId);
      return { type: "closed", code, playerIds };
    }

    const member = room.players.get(socketId);
    if (!member) return null;
    const released = [...(room.pressed.get(socketId) ?? [])].map(button => ({
      player: member.player,
      button,
      pressed: false,
      at: Date.now()
    }));
    for (const [axis, value] of room.axes.get(socketId) ?? []) {
      if (value !== 0) released.push({ player: member.player, axis, value: 0, at: Date.now() });
    }
    room.players.delete(socketId);
    room.pressed.delete(socketId);
    room.axes.delete(socketId);
    return { type: "left", code, hostId: room.hostId, released, state: this.state(room) };
  }
}