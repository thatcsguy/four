import { describe, expect, it } from "vitest";

import {
  addReadinessBuff,
  ABILITY_QUEUE_WINDOW_SECONDS,
  ABILITY_QUEUE_WINDOW_TICKS,
  COMBAT_CONSTANTS,
  createInitialCombatState,
  DANCER_ABILITIES,
  DANCER_GLOBAL_COOLDOWN_SECONDS,
  DANCER_GLOBAL_COOLDOWN_TICKS,
  GLOOP_BOSS,
  getAbilityForSlot,
  globalCooldownRemainingTicks,
  isAbilityOnGlobalCooldown,
  isAbilityInGlobalCooldownQueueWindow,
  isAbilitySlotUsable,
  resolveAbilityUse,
  type AbilitySlot,
  type PlayerCombatState,
} from "../../index.js";

describe("combat content", () => {
  it("centralizes the required immutable tuning", () => {
    expect(Object.values(DANCER_ABILITIES).map((ability) => ({
      slot: ability.slot,
      damage: ability.damage,
      requiredBuffId: "requiredBuffId" in ability ? ability.requiredBuffId : undefined,
    }))).toEqual([
      { slot: 1, damage: 25, requiredBuffId: "dancer_1_ready" },
      { slot: 2, damage: 10, requiredBuffId: undefined },
      { slot: 3, damage: 10, requiredBuffId: "dancer_3_ready" },
      { slot: 4, damage: 25, requiredBuffId: "dancer_4_ready" },
    ]);
    expect(DANCER_GLOBAL_COOLDOWN_SECONDS).toBe(2.5);
    expect(DANCER_GLOBAL_COOLDOWN_TICKS).toBe(150);
    expect(ABILITY_QUEUE_WINDOW_SECONDS).toBe(0.5);
    expect(ABILITY_QUEUE_WINDOW_TICKS).toBe(30);
    expect(GLOOP_BOSS).toMatchObject({
      id: "gloop",
      maxHealth: 50_000,
      position: { x: 0, y: 0, z: 0 },
      aimPoint: { x: 0, y: 1.6, z: 0 },
      hitRadius: 1.7,
    });
    expect(COMBAT_CONSTANTS.projectile).toEqual({ speed: 36, spawnHeight: 1.2 });
    expect(Object.isFrozen(DANCER_ABILITIES)).toBe(true);
    expect(Object.values(DANCER_ABILITIES).every(Object.isFrozen)).toBe(true);
  });

  it("maps each Dancer slot to its ability", () => {
    expect(([1, 2, 3, 4] as AbilitySlot[]).map(
      (slot) => getAbilityForSlot("dancer", slot)?.abilityId,
    )).toEqual(["dancer_1", "dancer_2", "dancer_3", "dancer_4"]);
  });
});

describe("ability resolution", () => {
  it("starts a Dancer with only slot 2 usable", () => {
    const state = createInitialCombatState();
    expect(state).toEqual({ classId: "dancer", buffs: [], globalCooldownEndsAtTick: 0 });
    expect(([1, 2, 3, 4] as AbilitySlot[]).map(
      (slot) => isAbilitySlotUsable(state, slot),
    )).toEqual([false, true, false, false]);
  });

  it.each([0, 0.499999])("slot 2 always grants slot 3 and procs slot 1 for roll %s", (roll) => {
    const result = resolveAbilityUse(createInitialCombatState(), 2, roll, 10);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.ability).toBe(DANCER_ABILITIES.dancer_2);
    expect(result.combatState.buffs).toEqual([
      { buffId: "dancer_3_ready", stacks: 1 },
      { buffId: "dancer_1_ready", stacks: 1 },
    ]);
    expect(result.combatState.globalCooldownEndsAtTick).toBe(160);
  });

  it.each([0.5, 0.999999])("does not proc at or above the boundary for roll %s", (roll) => {
    const result = resolveAbilityUse(createInitialCombatState(), 2, roll, 0);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.combatState.buffs).toEqual([{ buffId: "dancer_3_ready", stacks: 1 }]);
  });

  it("slot 3 consumes only its readiness and may grant slot 4", () => {
    const state: PlayerCombatState = {
      classId: "dancer",
      globalCooldownEndsAtTick: 0,
      buffs: [
        { buffId: "dancer_1_ready", stacks: 1 },
        { buffId: "dancer_3_ready", stacks: 1 },
      ],
    };
    const result = resolveAbilityUse(state, 3, 0, 0);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.combatState.buffs).toEqual([
      { buffId: "dancer_1_ready", stacks: 1 },
      { buffId: "dancer_4_ready", stacks: 1 },
    ]);
  });

  it.each([
    [1, "dancer_1_ready"],
    [4, "dancer_4_ready"],
  ] as const)("slot %s consumes its readiness", (slot, buffId) => {
    const result = resolveAbilityUse(
      { classId: "dancer", buffs: [{ buffId, stacks: 1 }], globalCooldownEndsAtTick: 0 },
      slot,
      0.75,
      0,
    );
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.combatState.buffs).toEqual([]);
  });

  it("keeps repeated grants at one stack and failed procs preserve active buffs", () => {
    const state = addReadinessBuff(
      addReadinessBuff(createInitialCombatState(), "dancer_1_ready"),
      "dancer_1_ready",
    );
    const result = resolveAbilityUse(state, 2, 0.9, 0);
    expect(state.buffs).toEqual([{ buffId: "dancer_1_ready", stacks: 1 }]);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.combatState.buffs).toEqual([
      { buffId: "dancer_1_ready", stacks: 1 },
      { buffId: "dancer_3_ready", stacks: 1 },
    ]);
  });

  it("rejects unavailable slots and invalid rolls without mutation", () => {
    const state = createInitialCombatState();
    const before = structuredClone(state);
    expect(resolveAbilityUse(state, 1, 0, 0)).toMatchObject({
      accepted: false,
      reason: "missing_buff",
    });
    for (const roll of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1]) {
      expect(resolveAbilityUse(state, 2, roll, 0)).toMatchObject({
        accepted: false,
        reason: "invalid_roll",
      });
    }
    expect(state).toEqual(before);
  });

  it("never mutates prior state and returns independent buff objects", () => {
    const state: PlayerCombatState = {
      classId: "dancer",
      globalCooldownEndsAtTick: 0,
      buffs: [{ buffId: "dancer_3_ready", stacks: 1 }],
    };
    const before = structuredClone(state);
    const result = resolveAbilityUse(state, 3, 0.75, 0);
    expect(state).toEqual(before);
    expect(result.combatState).not.toBe(state);
    expect(result.combatState.buffs).not.toBe(state.buffs);
  });

  it("blocks every Dancer ability for exactly 2.5 seconds without consuming state", () => {
    const first = resolveAbilityUse(createInitialCombatState(), 2, 0, 40);
    expect(first.accepted).toBe(true);
    if (!first.accepted) return;
    expect(globalCooldownRemainingTicks(first.combatState, 40)).toBe(150);
    expect(isAbilityOnGlobalCooldown(first.combatState, 3, 189)).toBe(true);
    expect(resolveAbilityUse(first.combatState, 3, 0, 189)).toMatchObject({
      accepted: false,
      reason: "global_cooldown",
      combatState: first.combatState,
    });
    expect(isAbilityOnGlobalCooldown(first.combatState, 3, 190)).toBe(false);
    expect(resolveAbilityUse(first.combatState, 3, 0, 190)).toMatchObject({ accepted: true });
  });

  it("opens the global-cooldown action queue for only the final 500 milliseconds", () => {
    const state: PlayerCombatState = {
      classId: "dancer",
      buffs: [],
      globalCooldownEndsAtTick: 100,
    };
    expect(isAbilityInGlobalCooldownQueueWindow(state, 2, 69)).toBe(false);
    expect(isAbilityInGlobalCooldownQueueWindow(state, 2, 70)).toBe(true);
    expect(isAbilityInGlobalCooldownQueueWindow(state, 2, 99)).toBe(true);
    expect(isAbilityInGlobalCooldownQueueWindow(state, 2, 100)).toBe(false);
  });
});
