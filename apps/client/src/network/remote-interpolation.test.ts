import { SIMULATION_HZ, createInitialPlayerState, type AuthoritativePlayerState } from "@four/shared";
import { describe, expect, it } from "vitest";

import { RemotePlayerInterpolator } from "./remote-interpolation.js";

const TICK_MS = 1_000 / SIMULATION_HZ;

function player(
  playerId: string,
  x = 0,
  facingAngle = 0,
  stateRevision = 0,
): AuthoritativePlayerState {
  return {
    ...createInitialPlayerState({ playerId }),
    position: { x, y: 0, z: 0 },
    facingAngle,
    stateRevision,
  };
}

function stateAt(
  interpolator: RemotePlayerInterpolator,
  playerId: string,
  nowMs: number,
): AuthoritativePlayerState | undefined {
  return interpolator.render(nowMs).get(playerId)?.state;
}

describe("remote interpolation", () => {
  it("interpolates midpoint position and facing across the -pi/pi seam", () => {
    const store = new RemotePlayerInterpolator({ clockOffsetSmoothing: 1 });
    store.acceptBaseline("epoch", "local", 0, 0, [player("local"), player("remote", 0, Math.PI - 0.2)], 0);
    store.acceptSnapshot("epoch", 1, 3, [player("local"), player("remote", 3, -Math.PI + 0.2)], 3 * TICK_MS);

    const midpoint = stateAt(store, "remote", 125);
    expect(midpoint?.position.x).toBeCloseTo(1.5, 10);
    expect(Math.abs(midpoint?.facingAngle ?? 0)).toBeCloseTo(Math.PI, 10);
  });

  it("uses the nearest sample before, between, and after buffered time without extrapolation", () => {
    const store = new RemotePlayerInterpolator({ clockOffsetSmoothing: 1 });
    store.acceptBaseline("epoch", "local", 0, 0, [player("local"), player("remote", 0)], 0);
    store.acceptSnapshot("epoch", 1, 6, [player("local"), player("remote", 6)], 6 * TICK_MS);

    expect(stateAt(store, "remote", 50)?.position.x).toBe(0);
    expect(stateAt(store, "remote", 150)?.position.x).toBeCloseTo(3, 10);
    expect(stateAt(store, "remote", 250)?.position.x).toBe(6);
    expect(store.diagnostics()).toMatchObject({ underrunCount: 2, extrapolationCount: 0 });
  });

  it("rejects duplicate/out-of-order snapshots and bounds histories by count and age", () => {
    const store = new RemotePlayerInterpolator({ maxSamples: 3, maxAgeMs: 100, clockOffsetSmoothing: 0 });
    store.acceptBaseline("epoch", "local", 0, 0, [player("local"), player("remote")], 0);
    expect(store.acceptSnapshot("epoch", 2, 3, [player("local"), player("remote", 1)], 50)).toBe(true);
    expect(store.acceptSnapshot("epoch", 2, 4, [player("local"), player("remote", 99)], 60)).toBe(false);
    expect(store.acceptSnapshot("epoch", 1, 5, [player("local"), player("remote", 99)], 70)).toBe(false);
    store.acceptSnapshot("epoch", 3, 6, [player("local"), player("remote", 2)], 100);
    store.acceptSnapshot("epoch", 4, 9, [player("local"), player("remote", 3)], 150);
    store.acceptSnapshot("epoch", 5, 12, [player("local"), player("remote", 4)], 200);

    expect(store.diagnostics().buffers[0]).toMatchObject({ depth: 3, sampleSpanMs: 100 });
    expect(stateAt(store, "remote", 1_000)?.position.x).toBe(4);
  });

  it("adds, removes, and cleanly re-adds a remote while always excluding the local player", () => {
    const store = new RemotePlayerInterpolator({ clockOffsetSmoothing: 0 });
    store.acceptBaseline("epoch", "local", 0, 0, [player("local"), player("remote", 1)], 0);
    expect([...store.render(100).keys()]).toEqual(["remote"]);

    store.acceptSnapshot("epoch", 1, 3, [player("local")], 50);
    expect(store.render(150).size).toBe(0);
    store.acceptSnapshot("epoch", 2, 6, [player("local"), player("remote", 9)], 100);
    expect(stateAt(store, "remote", 200)?.position.x).toBe(9);
    expect(store.diagnostics().buffers[0]?.depth).toBe(1);
  });

  it("clears incompatible revision, epoch, and disconnected session histories", () => {
    const store = new RemotePlayerInterpolator({ clockOffsetSmoothing: 0 });
    store.acceptBaseline("epoch-1", "local", 0, 0, [player("local"), player("remote", 0)], 0);
    store.acceptSnapshot("epoch-1", 1, 3, [player("local"), player("remote", 3)], 50);
    store.acceptSnapshot("epoch-1", 2, 6, [player("local"), player("remote", 20, 0, 1)], 100);
    expect(stateAt(store, "remote", 150)?.position.x).toBe(20);
    expect(store.diagnostics().buffers[0]?.depth).toBe(1);

    expect(store.acceptSnapshot("epoch-2", 3, 9, [player("local"), player("ghost", 30)], 150)).toBe(false);
    expect(store.render(150).has("ghost")).toBe(false);
    store.acceptBaseline("epoch-2", "new-local", 0, 9, [player("new-local"), player("new-remote", 7)], 150);
    expect([...store.render(250).keys()]).toEqual(["new-remote"]);
    store.clear();
    expect(store.render(300).size).toBe(0);
  });

  it.each([30, 60, 144])("turns 20 Hz snapshots into smooth %s Hz presentation", (renderHz) => {
    const store = new RemotePlayerInterpolator({ clockOffsetSmoothing: 0 });
    store.acceptBaseline("epoch", "local", 0, 0, [player("local"), player("remote")], 0);
    let nextSnapshotMs = 50;
    let snapshotSequence = 1;
    const positions: number[] = [];
    for (let frame = 1; frame <= renderHz; frame += 1) {
      const nowMs = frame * (1_000 / renderHz);
      while (nextSnapshotMs <= nowMs + 1e-7) {
        const tick = Math.round(nextSnapshotMs / TICK_MS);
        store.acceptSnapshot(
          "epoch",
          snapshotSequence,
          tick,
          [player("local"), player("remote", nextSnapshotMs / 200)],
          nextSnapshotMs,
        );
        snapshotSequence += 1;
        nextSnapshotMs += 50;
      }
      if (nowMs >= 150) positions.push(stateAt(store, "remote", nowMs)?.position.x ?? -1);
    }

    positions.forEach((position, index) => {
      if (index > 0) expect(position).toBeGreaterThan(positions[index - 1]!);
    });
    expect(positions.at(-1)).toBeCloseTo(4.5, 6);
  });
});
