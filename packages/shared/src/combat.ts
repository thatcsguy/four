export const PLAYER_CLASS_IDS = ["dancer"] as const;
export type PlayerClassId = (typeof PLAYER_CLASS_IDS)[number];

export const ABILITY_SLOTS = [1, 2, 3, 4] as const;
export type AbilitySlot = (typeof ABILITY_SLOTS)[number];

export const DANCER_ABILITY_IDS = [
  "dancer_1",
  "dancer_2",
  "dancer_3",
  "dancer_4",
] as const;
export type AbilityId = (typeof DANCER_ABILITY_IDS)[number];

export const READINESS_BUFF_IDS = [
  "dancer_1_ready",
  "dancer_3_ready",
  "dancer_4_ready",
] as const;
export type ReadinessBuffId = (typeof READINESS_BUFF_IDS)[number];

export const BOSS_ID = "gloop" as const;

export interface BuffState {
  readonly buffId: string;
  readonly stacks: number;
  readonly expiresAtTick?: number;
}

export interface PlayerCombatState {
  readonly classId: PlayerClassId;
  readonly buffs: BuffState[];
  readonly globalCooldownEndsAtTick: number;
}

export interface AbilityDefinition {
  readonly abilityId: AbilityId;
  readonly classId: PlayerClassId;
  readonly slot: AbilitySlot;
  readonly name: string;
  readonly damage: number;
  readonly requiredBuffId?: ReadinessBuffId;
  readonly guaranteedBuffId?: ReadinessBuffId;
  readonly procBuffId?: ReadinessBuffId;
  readonly procChance?: number;
  /** Omit for abilities that neither respect nor trigger the global cooldown. */
  readonly globalCooldownTicks?: number;
}

const DANCER_GLOBAL_COOLDOWN_SECONDS = 2.5;
const DANCER_GLOBAL_COOLDOWN_TICKS = DANCER_GLOBAL_COOLDOWN_SECONDS * SIMULATION_HZ;

export const DANCER_ABILITIES: Readonly<Record<AbilityId, AbilityDefinition>> = Object.freeze({
  dancer_1: Object.freeze({
    abilityId: "dancer_1",
    classId: "dancer",
    slot: 1,
    name: "Crimson Fan",
    damage: 25,
    requiredBuffId: "dancer_1_ready",
    globalCooldownTicks: DANCER_GLOBAL_COOLDOWN_TICKS,
  }),
  dancer_2: Object.freeze({
    abilityId: "dancer_2",
    classId: "dancer",
    slot: 2,
    name: "Quick Toss",
    damage: 10,
    guaranteedBuffId: "dancer_3_ready",
    procBuffId: "dancer_1_ready",
    procChance: 0.5,
    globalCooldownTicks: DANCER_GLOBAL_COOLDOWN_TICKS,
  }),
  dancer_3: Object.freeze({
    abilityId: "dancer_3",
    classId: "dancer",
    slot: 3,
    name: "Twin Step",
    damage: 10,
    requiredBuffId: "dancer_3_ready",
    procBuffId: "dancer_4_ready",
    procChance: 0.5,
    globalCooldownTicks: DANCER_GLOBAL_COOLDOWN_TICKS,
  }),
  dancer_4: Object.freeze({
    abilityId: "dancer_4",
    classId: "dancer",
    slot: 4,
    name: "Golden Fan",
    damage: 25,
    requiredBuffId: "dancer_4_ready",
    globalCooldownTicks: DANCER_GLOBAL_COOLDOWN_TICKS,
  }),
});

export const COMBAT_CONSTANTS = Object.freeze({
  maxBuffsPerPlayer: 16,
  maxActiveProjectiles: 128,
  dancerGlobalCooldownSeconds: DANCER_GLOBAL_COOLDOWN_SECONDS,
  dancerGlobalCooldownTicks: DANCER_GLOBAL_COOLDOWN_TICKS,
  boss: Object.freeze({
    id: BOSS_ID,
    name: "Gloop",
    maxHealth: 50_000,
    position: Object.freeze({ x: 0, y: 0, z: 0 }),
    aimPoint: Object.freeze({ x: 0, y: 1.6, z: 0 }),
    hitRadius: 1.7,
  }),
  projectile: Object.freeze({
    speed: 36,
    spawnHeight: 1.2,
  }),
});

const DANCER_ABILITIES_BY_SLOT: Readonly<Partial<Record<AbilitySlot, AbilityDefinition>>> =
  Object.freeze(Object.fromEntries(
    Object.values(DANCER_ABILITIES).map((ability) => [ability.slot, ability]),
  ));

export function createInitialCombatState(): PlayerCombatState {
  return { classId: "dancer", buffs: [], globalCooldownEndsAtTick: 0 };
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

export function getAbilityForSlot(
  classId: PlayerClassId,
  slot: AbilitySlot,
): AbilityDefinition | undefined {
  return classId === "dancer" ? DANCER_ABILITIES_BY_SLOT[slot] : undefined;
}

export function isAbilitySlotUsable(
  combatState: Readonly<PlayerCombatState>,
  slot: AbilitySlot,
): boolean {
  const ability = getAbilityForSlot(combatState.classId, slot);
  return ability !== undefined
    && (ability.requiredBuffId === undefined
      || combatState.buffs.some((buff) => buff.buffId === ability.requiredBuffId && buff.stacks > 0));
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

  const index = copiedBuffs.findIndex(
    (buff) => buff.buffId === requiredBuffId && buff.stacks > 0,
  );
  if (index === -1) {
    return { consumed: false, combatState: { ...combatState, buffs: copiedBuffs } };
  }

  const buff = copiedBuffs[index];
  if (buff === undefined) {
    return { consumed: false, combatState: { ...combatState, buffs: copiedBuffs } };
  }
  if (buff.stacks === 1) {
    copiedBuffs.splice(index, 1);
  } else {
    copiedBuffs[index] = { ...buff, stacks: buff.stacks - 1 };
  }
  return { consumed: true, combatState: { ...combatState, buffs: copiedBuffs } };
}

export type AbilityResolution =
  | {
    readonly accepted: true;
    readonly ability: AbilityDefinition;
    readonly combatState: PlayerCombatState;
  }
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
  if (ability === undefined) {
    return { accepted: false, reason: "unknown_ability", combatState: unchanged() };
  }
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
  if (ability.guaranteedBuffId !== undefined) {
    nextState = addReadinessBuff(nextState, ability.guaranteedBuffId);
  }
  if (
    ability.procBuffId !== undefined
    && ability.procChance !== undefined
    && roll < ability.procChance
  ) {
    nextState = addReadinessBuff(nextState, ability.procBuffId);
  }
  if (ability.globalCooldownTicks !== undefined) {
    nextState = {
      ...nextState,
      globalCooldownEndsAtTick: Math.min(
        Number.MAX_SAFE_INTEGER,
        currentTick + ability.globalCooldownTicks,
      ),
    };
  }

  return { accepted: true, ability, combatState: nextState };
}
import { SIMULATION_HZ } from "./constants.js";
