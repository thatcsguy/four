import { describe, expect, it } from "vitest";

import { FIXED_DELTA_SECONDS, MOVEMENT_CONSTANTS } from "./constants.js";
import {
  createInitialPlayerState,
  stepPlayer,
  type MovementInput,
  type SimulatedPlayerState,
} from "./movement.js";
import { authoritativePlayerStateSchema } from "./protocol.js";

const neutral: MovementInput = { moveX: 0, moveZ: 0, jump: false };

function initial(): SimulatedPlayerState {
  return createInitialPlayerState({ playerId: "player-1" });
}

function run(
  state: SimulatedPlayerState,
  input: MovementInput,
  ticks: number,
): SimulatedPlayerState {
  let result = state;
  for (let tick = 0; tick < ticks; tick += 1) {
    result = stepPlayer(result, input, FIXED_DELTA_SECONDS, {});
  }
  return result;
}

describe("ground movement", () => {
  it("moves cardinally and normalizes diagonal and oversized intent", () => {
    expect(run(initial(), { moveX: 1, moveZ: 0, jump: false }, 60).position.x).toBeCloseTo(5, 12);

    const diagonal = run(initial(), { moveX: 1, moveZ: 1, jump: false }, 60);
    expect(Math.hypot(diagonal.position.x, diagonal.position.z)).toBeCloseTo(5, 12);
    expect(diagonal.position.x).toBeCloseTo(diagonal.position.z, 12);

    const malicious = run(initial(), { moveX: 30, moveZ: 40, jump: false }, 60);
    expect(malicious.position.x).toBeCloseTo(3, 12);
    expect(malicious.position.z).toBeCloseTo(4, 12);
  });

  it("starts, stops, and reverses immediately", () => {
    const started = stepPlayer(initial(), { moveX: 1, moveZ: 0, jump: false }, 0.1, {});
    expect(started.position.x).toBeCloseTo(0.5, 12);

    const stopped = stepPlayer(started, neutral, 0.1, {});
    expect(stopped.position.x).toBeCloseTo(started.position.x, 12);

    const reversed = stepPlayer(stopped, { moveX: -1, moveZ: 0, jump: false }, 0.1, {});
    expect(reversed.position.x).toBeCloseTo(0, 12);
  });

  it("treats opposing/zero and non-finite intent as neutral", () => {
    const state = { ...initial(), position: { x: 2, y: 0, z: 3 } };
    expect(stepPlayer(state, { moveX: 1 - 1, moveZ: 1 - 1, jump: false }, 1, {}).position)
      .toEqual(state.position);
    expect(stepPlayer(state, { moveX: Number.NaN, moveZ: 1, jump: false }, 1, {}).position)
      .toEqual(state.position);
  });

  it("supports the 1.3 sprint modifier without a sprint input", () => {
    const sprinting = { ...initial(), speedModifier: MOVEMENT_CONSTANTS.sprintSpeedModifier };
    expect(run(sprinting, { moveX: 0, moveZ: 1, jump: false }, 60).position.z)
      .toBeCloseTo(6.5, 12);
  });
});

describe("circular boundary", () => {
  it.each([
    [30, 0, 18.3, 0],
    [-30, 0, -18.3, 0],
    [0, 30, 0, 18.3],
    [30, 40, 10.98, 14.64],
  ])("projects (%s, %s) radially", (x, z, expectedX, expectedZ) => {
    const outside = { ...initial(), position: { x, y: 0, z } };
    const bounded = stepPlayer(outside, neutral, 0, {});
    expect(bounded.position.x).toBeCloseTo(expectedX, 12);
    expect(bounded.position.z).toBeCloseTo(expectedZ, 12);
    expect(Math.hypot(bounded.position.x, bounded.position.z)).toBeCloseTo(18.3, 12);
  });

  it("clamps airborne travel without altering captured velocity", () => {
    const airborne = {
      ...initial(),
      position: { x: 18.29, y: 1, z: 0 },
      grounded: false,
      verticalVelocity: 1,
      airborneVelocity: { x: 5, z: 0 },
    };
    const bounded = stepPlayer(airborne, neutral, 0.1, {});
    expect(bounded.position.x).toBeCloseTo(18.3, 12);
    expect(bounded.airborneVelocity).toEqual({ x: 5, z: 0 });
  });
});

describe("jump", () => {
  it("uses gravity-before-position integration for a stationary sampled arc", () => {
    const takeoff = stepPlayer(initial(), { ...neutral, jump: true }, FIXED_DELTA_SECONDS, {});
    expect(takeoff.grounded).toBe(false);
    expect(takeoff.verticalVelocity).toBeCloseTo(8 - 20 / 60, 12);
    expect(takeoff.position.y).toBeCloseTo((8 - 20 / 60) / 60, 12);
    expect(takeoff.airborneVelocity).toEqual({ x: 0, z: 0 });

    let state = takeoff;
    let apex = state.position.y;
    let flightTicks = 1;
    while (!state.grounded && flightTicks < 100) {
      state = stepPlayer(state, neutral, FIXED_DELTA_SECONDS, {});
      apex = Math.max(apex, state.position.y);
      flightTicks += 1;
    }
    expect(apex).toBeCloseTo(1.5333333333333334, 12);
    expect(flightTicks).toBe(48);
    expect(state.position.y).toBe(0);
    expect(state.verticalVelocity).toBe(0);
    expect(state.airborneVelocity).toEqual({ x: 0, z: 0 });
  });

  it("captures moving takeoff velocity exactly once and has no air control", () => {
    const takeoff = stepPlayer(initial(), { moveX: 1, moveZ: 0, jump: true }, 0.1, {});
    expect(takeoff.position.x).toBeCloseTo(0.5, 12);
    expect(takeoff.airborneVelocity).toEqual({ x: 5, z: 0 });

    const changed = stepPlayer(
      { ...takeoff, speedModifier: 1.3 },
      { moveX: 0, moveZ: -1, jump: true },
      0.1,
      {},
    );
    expect(changed.position.x).toBeCloseTo(1, 12);
    expect(changed.position.z).toBeCloseTo(0, 12);
    expect(changed.airborneVelocity).toEqual({ x: 5, z: 0 });
    expect(changed.verticalVelocity).toBeLessThan(takeoff.verticalVelocity);
  });

  it("does not double jump and repeats one step after held-jump landing", () => {
    let state = stepPlayer(initial(), { ...neutral, jump: true }, FIXED_DELTA_SECONDS, {});
    const velocityAfterTakeoff = state.verticalVelocity;
    state = stepPlayer(state, { ...neutral, jump: true }, FIXED_DELTA_SECONDS, {});
    expect(state.verticalVelocity).toBeCloseTo(velocityAfterTakeoff - 20 / 60, 12);

    while (!state.grounded) {
      state = stepPlayer(state, { ...neutral, jump: true }, FIXED_DELTA_SECONDS, {});
    }
    expect(state.verticalVelocity).toBe(0);

    state = stepPlayer(state, { ...neutral, jump: true }, FIXED_DELTA_SECONDS, {});
    expect(state.grounded).toBe(false);
    expect(state.verticalVelocity).toBeCloseTo(8 - 20 / 60, 12);
  });
});

describe("facing", () => {
  it("uses positive Z as zero and retains facing while idle", () => {
    const state = { ...initial(), facingAngle: 0.7 };
    expect(stepPlayer(state, { moveX: 0, moveZ: 1, jump: false }, 1, {}).facingAngle)
      .toBeCloseTo(0, 12);
    expect(stepPlayer(state, neutral, 1, {}).facingAngle).toBe(0.7);
  });

  it("turns at the maximum rate and takes the shortest wraparound arc", () => {
    const limited = stepPlayer(initial(), { moveX: 1, moveZ: 0, jump: false }, 0.05, {});
    expect(limited.facingAngle).toBeCloseTo(0.5, 12);

    const nearPositivePi = { ...initial(), facingAngle: Math.PI - 0.05 };
    const desired = -Math.PI + 0.05;
    const wrapped = stepPlayer(
      nearPositivePi,
      { moveX: Math.sin(desired), moveZ: Math.cos(desired), jump: false },
      0.02,
      {},
    );
    expect(wrapped.facingAngle).toBeCloseTo(Math.PI + 0.05, 12);
  });

  it("follows live air input while physical momentum stays locked", () => {
    const airborne = {
      ...initial(),
      position: { x: 0, y: 1, z: 0 },
      grounded: false,
      verticalVelocity: 1,
      airborneVelocity: { x: 0, z: 5 },
    };
    const result = stepPlayer(airborne, { moveX: 1, moveZ: 0, jump: false }, 0.1, {});
    expect(result.position).toMatchObject({ x: 0, z: 0.5 });
    expect(result.facingAngle).toBeCloseTo(1, 12);
  });

  it("chooses the negative turn for the exact opposite-angle tie", () => {
    const result = stepPlayer(initial(), { moveX: 0, moveZ: -1, jump: false }, 0.01, {});
    expect(result.facingAngle).toBeCloseTo(-0.1, 12);
  });
});

describe("purity, determinism, and reconciliation", () => {
  const commands: MovementInput[] = [
    { moveX: 1, moveZ: 0, jump: false },
    { moveX: 1, moveZ: 1, jump: true },
    { moveX: -1, moveZ: 0, jump: false },
    { moveX: 0, moveZ: -1, jump: false },
    neutral,
  ];

  it("produces deeply equal output for cloned state and inputs", () => {
    const a = commands.reduce((state, input) => stepPlayer(state, input, 0.1, {}), initial());
    const b = structuredClone(commands).reduce(
      (state, input) => stepPlayer(state, input, 0.1, {}),
      structuredClone(initial()),
    );
    expect(a).toEqual(b);
  });

  it("matches uninterrupted simulation after restore and replay", () => {
    const uninterrupted = commands.reduce(
      (state, input) => stepPlayer(state, input, 0.1, {}),
      initial(),
    );
    const authoritativeAtAck = commands.slice(0, 2).reduce(
      (state, input) => stepPlayer(state, input, 0.1, {}),
      initial(),
    );
    const replayed = commands.slice(2).reduce(
      (state, input) => stepPlayer(state, input, 0.1, {}),
      structuredClone(authoritativeAtAck),
    );
    expect(replayed).toEqual(uninterrupted);
  });

  it("does not mutate state or input", () => {
    const state = initial();
    const input = { moveX: 1, moveZ: 0, jump: true };
    const stateBefore = structuredClone(state);
    const inputBefore = structuredClone(input);
    const result = stepPlayer(state, input, FIXED_DELTA_SECONDS, {});
    expect(state).toEqual(stateBefore);
    expect(input).toEqual(inputBefore);
    expect(result).not.toBe(state);
    expect(result.position).not.toBe(state.position);
  });

  it("creates schema-complete serializable state without retaining spawn references", () => {
    const position = { x: 30, y: 99, z: 40 };
    const state = createInitialPlayerState({ playerId: "spawned", position });
    position.x = 0;
    expect(state.position).toEqual({ x: 10.98, y: 0, z: 14.64 });
    expect(authoritativePlayerStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("rejects invalid fixed deltas", () => {
    expect(() => stepPlayer(initial(), neutral, -0.1, {})).toThrow(RangeError);
    expect(() => stepPlayer(initial(), neutral, Number.NaN, {})).toThrow(RangeError);
  });
});
