import { COMBAT_CONSTANTS, GLOOP_BOSS, type ProjectileState } from "@four/shared";
import { describe, expect, it } from "vitest";

import { advanceCombat, createInitialBossState } from "./combat-simulation.js";

function projectile(overrides: Partial<ProjectileState> = {}): ProjectileState {
  return {
    projectileId: "projectile-1",
    ownerPlayerId: "player-1",
    abilityId: "dancer_2",
    targetId: "gloop",
    position: { x: -10, y: 1.6, z: 0 },
    speed: COMBAT_CONSTANTS.projectile.speed,
    damage: 10,
    spawnedAtTick: 1,
    ...overrides,
  };
}

describe("combat simulation", () => {
  it("moves projectiles by speed times fixed delta toward the boss", () => {
    const result = advanceCombat(createInitialBossState(), [projectile()], 0.2);
    expect(result.projectiles).toHaveLength(1);
    expect(result.projectiles[0]?.position.x).toBeCloseTo(-2.8, 10);
    expect(result.projectiles[0]?.position.y).toBeCloseTo(1.6, 10);
    expect(result.projectiles[0]?.position.z).toBeCloseTo(0, 10);
    expect(result.boss.health).toBe(GLOOP_BOSS.maxHealth);
  });

  it("damages once on collision, clamps health, and removes later impacts in insertion order", () => {
    const boss = { ...createInitialBossState(), health: 20 };
    const first = projectile({ projectileId: "first", damage: 15, position: { x: -2, y: 1.6, z: 0 } });
    const second = projectile({ projectileId: "second", damage: 15, position: { x: 2, y: 1.6, z: 0 } });
    const result = advanceCombat(boss, [first, second], 1 / 60);
    expect(result.projectiles).toEqual([]);
    expect(result.boss.health).toBe(0);
    expect(result.boss.stateRevision).toBe(2);
  });

  it("does not mutate its inputs", () => {
    const boss = createInitialBossState();
    const source = projectile();
    advanceCombat(boss, [source], 1 / 60);
    expect(boss.health).toBe(GLOOP_BOSS.maxHealth);
    expect(source.position.x).toBe(-10);
  });
});
