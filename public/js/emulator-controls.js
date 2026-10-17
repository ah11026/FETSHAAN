const buttonIndexes = Object.freeze({
  b: 0,
  y: 1,
  select: 2,
  start: 3,
  up: 4,
  down: 5,
  left: 6,
  right: 7,
  a: 8,
  x: 9,
  l1: 10,
  r1: 11,
  l2: 12,
  r2: 13,
  l3: 14,
  r3: 15
});
const axisIndexes = Object.freeze({
  "left-x": [16, 17],
  "left-y": [18, 19],
  "right-x": [20, 21],
  "right-y": [22, 23]
});

export function mapRemoteInput(input) {
  if (!input || !Number.isInteger(input.player) || input.player < 1 || input.player > 4 ||
      typeof input.pressed !== "boolean" || !Object.hasOwn(buttonIndexes, input.button)) return null;
  return {
    player: input.player - 1,
    index: buttonIndexes[input.button],
    value: input.pressed ? 1 : 0
  };
}

export function mapRemoteAxis(input) {
  if (!input || !Number.isInteger(input.player) || input.player < 1 || input.player > 4 ||
      !Object.hasOwn(axisIndexes, input.axis) || typeof input.value !== "number" ||
      !Number.isFinite(input.value) || input.value < -1 || input.value > 1) return null;
  const [positiveIndex, negativeIndex] = axisIndexes[input.axis];
  const value = Math.abs(input.value) < 0.12 ? 0 : input.value;
  return [
    { player: input.player - 1, index: positiveIndex, value: Math.round(Math.max(0, value) * 32767) },
    { player: input.player - 1, index: negativeIndex, value: Math.round(Math.max(0, -value) * 32767) }
  ];
}

export class RemoteInputState {
  values = new Map();

  apply(input) {
    let commands;
    if (typeof input?.axis === "string") {
      commands = mapRemoteAxis(input);
    } else {
      const command = mapRemoteInput(input);
      commands = command ? [command] : null;
    }
    if (!commands) return [];
    return commands.filter(command => {
      const key = `${command.player}:${command.index}`;
      if (this.values.get(key) === command.value) return false;
      this.values.set(key, command.value);
      return true;
    });
  }

  releaseAll() {
    const releases = [...this.values.entries()]
      .filter(([, value]) => value !== 0)
      .map(([key]) => {
        const [player, index] = key.split(":").map(Number);
        return { player, index, value: 0 };
      });
    this.values.clear();
    return releases;
  }
}