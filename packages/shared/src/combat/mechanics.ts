import { PLAYER_CLASSES } from "./player-classes/registry.js";
import type {
  AbilityDefinition,
  AbilitySlot,
  PlayerClassId,
  PlayerCombatState,
  ReadinessBuffId,
} from "./types.js";

export function createInitialCombatState(classId: PlayerClassId = "dancer"): PlayerCombatState {
  return PLAYER_CLASSES[classId].createInitialState();
}

export function getAbilityForSlot(
  classId: PlayerClassId,
  slot: AbilitySlot,
): AbilityDefinition | undefined {
  return PLAYER_CLASSES[classId].abilitiesBySlot[slot];
}

export function globalCooldownRemainingTicks(
  combatState: Readonly<Pick<PlayerCombatState, "globalCooldownEndsAtTick">>,
  currentTick: number,
): number {
  if (!Number.isSafeInteger(currentTick) || currentTick < 0) return 0;
  return Math.max(0, combatState.globalCooldownEndsAtTick - currentTick);
}

export function isAbilityOnGlobalCooldown(
  combatState: Readonly<Pick<PlayerCombatState, "classId" | "globalCooldownEndsAtTick">>,
  slot: AbilitySlot,
  currentTick: number,
): boolean {
  const ability = getAbilityForSlot(combatState.classId, slot);
  return ability?.globalCooldownTicks !== undefined
    && globalCooldownRemainingTicks(combatState, currentTick) > 0;
}

export function isAbilitySlotUsable(
  combatState: Readonly<PlayerCombatState>,
  slot: AbilitySlot,
): boolean {
  const ability = getAbilityForSlot(combatState.classId, slot);
  return ability !== undefined
    && [ability.requiredBuffId, ...(ability.requiredBuffIds ?? [])]
      .filter((buffId): buffId is ReadinessBuffId => buffId !== undefined)
      .every((buffId) => combatState.buffs.some((buff) => buff.buffId === buffId && buff.stacks > 0));
}

export function addReadinessBuff(
  combatState: Readonly<PlayerCombatState>,
  buffId: ReadinessBuffId,
): PlayerCombatState {
  if (combatState.buffs.some((buff) => buff.buffId === buffId)) {
    return { ...combatState, buffs: combatState.buffs.map((buff) => ({ ...buff })) };
  }
  return {
    ...combatState,
    buffs: [...combatState.buffs.map((buff) => ({ ...buff })), { buffId, stacks: 1 }],
  };
}

export interface ConsumeRequiredBuffResult {
  readonly consumed: boolean;
  readonly combatState: PlayerCombatState;
}

export function consumeRequiredBuff(
  combatState: Readonly<PlayerCombatState>,
  requiredBuffId: ReadinessBuffId | undefined,
): ConsumeRequiredBuffResult {
  const copiedBuffs = combatState.buffs.map((buff) => ({ ...buff }));
  if (requiredBuffId === undefined) {
    return { consumed: true, combatState: { ...combatState, buffs: copiedBuffs } };
  }
  const index = copiedBuffs.findIndex((buff) => buff.buffId === requiredBuffId && buff.stacks > 0);
  if (index === -1) {
    return { consumed: false, combatState: { ...combatState, buffs: copiedBuffs } };
  }
  const buff = copiedBuffs[index];
  if (buff === undefined) {
    return { consumed: false, combatState: { ...combatState, buffs: copiedBuffs } };
  }
  if (buff.stacks === 1) copiedBuffs.splice(index, 1);
  else copiedBuffs[index] = { ...buff, stacks: buff.stacks - 1 };
  return { consumed: true, combatState: { ...combatState, buffs: copiedBuffs } };
}

export type AbilityResolution =
  | { readonly accepted: true; readonly ability: AbilityDefinition; readonly combatState: PlayerCombatState }
  | {
    readonly accepted: false;
    readonly reason: "unknown_ability" | "missing_buff" | "global_cooldown" | "invalid_roll" | "invalid_tick";
    readonly combatState: PlayerCombatState;
  };

export function resolveAbilityUse(
  combatState: Readonly<PlayerCombatState>,
  slot: AbilitySlot,
  roll: number,
  currentTick: number,
): AbilityResolution {
  const unchanged = (): PlayerCombatState => ({
    ...combatState,
    buffs: combatState.buffs.map((buff) => ({ ...buff })),
  });
  const ability = getAbilityForSlot(combatState.classId, slot);
  if (ability === undefined) return { accepted: false, reason: "unknown_ability", combatState: unchanged() };
  if (!Number.isSafeInteger(currentTick) || currentTick < 0) {
    return { accepted: false, reason: "invalid_tick", combatState: unchanged() };
  }
  if (isAbilityOnGlobalCooldown(combatState, slot, currentTick)) {
    return { accepted: false, reason: "global_cooldown", combatState: unchanged() };
  }
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1) {
    return { accepted: false, reason: "invalid_roll", combatState: unchanged() };
  }
  const consumed = consumeRequiredBuff(combatState, ability.requiredBuffId);
  if (!consumed.consumed) {
    return { accepted: false, reason: "missing_buff", combatState: consumed.combatState };
  }
  let nextState = consumed.combatState;
  for (const requiredBuffId of ability.requiredBuffIds ?? []) {
    const nextConsumed = consumeRequiredBuff(nextState, requiredBuffId);
    if (!nextConsumed.consumed) {
      return { accepted: false, reason: "missing_buff", combatState: unchanged() };
    }
    nextState = nextConsumed.combatState;
  }
  if (ability.guaranteedBuffId !== undefined) nextState = addReadinessBuff(nextState, ability.guaranteedBuffId);
  if (ability.procBuffId !== undefined && ability.procChance !== undefined && roll < ability.procChance) {
    nextState = addReadinessBuff(nextState, ability.procBuffId);
  }
  if (ability.globalCooldownTicks !== undefined) {
    nextState = {
      ...nextState,
      globalCooldownEndsAtTick: Math.min(Number.MAX_SAFE_INTEGER, currentTick + ability.globalCooldownTicks),
    };
  }
  nextState = PLAYER_CLASSES[combatState.classId].resolveAcceptedAbility?.(nextState, ability) ?? nextState;
  return { accepted: true, ability, combatState: nextState };
}
