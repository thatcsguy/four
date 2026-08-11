import { describe, expect, it } from "vitest";

import {
  SAMURAI_GLOBAL_COOLDOWN_TICKS,
  SAMURAI_MELEE_RANGE,
  SAMURAI_STAMP_IDS,
  createInitialCombatState,
  isAbilitySlotUsable,
  resolveAbilityUse,
  type AbilitySlot,
  type PlayerCombatState,
} from "../../index.js";

function useSequence(slots: readonly AbilitySlot[]): PlayerCombatState {
  let state = createInitialCombatState("samurai");
  let tick = 0;
  for (const slot of slots) {
    const result = resolveAbilityUse(state, slot, 0, tick);
    expect(result.accepted).toBe(true);
    state = result.combatState;
    tick += SAMURAI_GLOBAL_COOLDOWN_TICKS;
  }
  return state;
}

describe("Samurai class", () => {
  it("defines three melee strikes and a high-damage ranged finisher", () => {
    for (const slot of [1, 2, 3] as const) {
      const result = resolveAbilityUse(createInitialCombatState("samurai"), slot, 0, 0);
      expect(result).toMatchObject({
        accepted: true,
        ability: { delivery: "melee", maxRange: SAMURAI_MELEE_RANGE },
      });
    }
    const locked = resolveAbilityUse(createInitialCombatState("samurai"), 4, 0, 0);
    expect(locked).toMatchObject({ accepted: false, reason: "missing_buff" });
  });

  it.each([
    [[1, 2, 3], "samurai_stamp_3"],
    [[2, 3, 1], "samurai_stamp_1"],
    [[3, 1, 2], "samurai_stamp_2"],
  ] as const)("awards the stamp belonging to the final strike in %j", (slots, stampId) => {
    const state = useSequence(slots);
    expect(state.buffs).toEqual([{ buffId: stampId, stacks: 1 }]);
  });

  it.each([
    [1, 1],
    [1, 2, 1],
    [3, 2, 3],
  ] as const)("cancels all combo progress when a strike repeats in %j", (...slots) => {
    expect(useSequence(slots).buffs).toEqual([]);
  });

  it("preserves earned stamps when a duplicate cancels progress and allows a fresh combo", () => {
    const cancelled = useSequence([1, 2, 3, 1, 1]);
    expect(cancelled.buffs).toEqual([{ buffId: "samurai_stamp_3", stacks: 1 }]);

    const restarted = useSequence([1, 1, 2, 3, 1]);
    expect(restarted.buffs).toEqual([{ buffId: "samurai_stamp_1", stacks: 1 }]);
  });

  it("keeps earned stamps across combos and consumes all three for ability 4", () => {
    const state = useSequence([2, 3, 1, 3, 1, 2, 1, 2, 3]);
    expect(new Set(state.buffs.map((buff) => buff.buffId))).toEqual(new Set(SAMURAI_STAMP_IDS));
    expect(isAbilitySlotUsable(state, 4)).toBe(true);

    const finisher = resolveAbilityUse(state, 4, 0, 9 * SAMURAI_GLOBAL_COOLDOWN_TICKS);
    expect(finisher).toMatchObject({
      accepted: true,
      ability: { abilityId: "samurai_4", delivery: "projectile", damage: 100 },
      combatState: { buffs: [] },
    });
  });
});
