import { SIMULATION_HZ } from "../../../constants.js";
import type {
  AbilityDefinition,
  PlayerClassDefinition,
  PlayerCombatState,
  ReadinessBuffId,
} from "../../types.js";

export const SAMURAI_CLASS_ID = "samurai" as const;
export const SAMURAI_ABILITY_IDS = [
  "samurai_1",
  "samurai_2",
  "samurai_3",
  "samurai_4",
] as const;
export const SAMURAI_STAMP_IDS = [
  "samurai_stamp_1",
  "samurai_stamp_2",
  "samurai_stamp_3",
] as const;
export const SAMURAI_COMBO_BUFF_IDS = [
  "samurai_combo_1",
  "samurai_combo_2",
  "samurai_combo_3",
] as const;
export const SAMURAI_READINESS_BUFF_IDS = [
  ...SAMURAI_STAMP_IDS,
  ...SAMURAI_COMBO_BUFF_IDS,
] as const;

export const SAMURAI_GLOBAL_COOLDOWN_TICKS = 1.5 * SIMULATION_HZ;
export const SAMURAI_MELEE_RANGE = 4;

export const SAMURAI_ABILITIES = Object.freeze({
  samurai_1: Object.freeze({
    abilityId: "samurai_1",
    classId: SAMURAI_CLASS_ID,
    slot: 1,
    name: "One",
    damage: 18,
    delivery: "melee",
    maxRange: SAMURAI_MELEE_RANGE,
    globalCooldownTicks: SAMURAI_GLOBAL_COOLDOWN_TICKS,
  }),
  samurai_2: Object.freeze({
    abilityId: "samurai_2",
    classId: SAMURAI_CLASS_ID,
    slot: 2,
    name: "Two",
    damage: 20,
    delivery: "melee",
    maxRange: SAMURAI_MELEE_RANGE,
    globalCooldownTicks: SAMURAI_GLOBAL_COOLDOWN_TICKS,
  }),
  samurai_3: Object.freeze({
    abilityId: "samurai_3",
    classId: SAMURAI_CLASS_ID,
    slot: 3,
    name: "Three",
    damage: 22,
    delivery: "melee",
    maxRange: SAMURAI_MELEE_RANGE,
    globalCooldownTicks: SAMURAI_GLOBAL_COOLDOWN_TICKS,
  }),
  samurai_4: Object.freeze({
    abilityId: "samurai_4",
    classId: SAMURAI_CLASS_ID,
    slot: 4,
    name: "Four",
    damage: 100,
    delivery: "projectile",
    requiredBuffIds: SAMURAI_STAMP_IDS,
    globalCooldownTicks: SAMURAI_GLOBAL_COOLDOWN_TICKS,
  }),
}) satisfies Readonly<Record<(typeof SAMURAI_ABILITY_IDS)[number], AbilityDefinition>>;

const abilitiesBySlot = Object.freeze(Object.fromEntries(
  Object.values(SAMURAI_ABILITIES).map((ability) => [ability.slot, ability]),
)) as PlayerClassDefinition["abilitiesBySlot"];

function hasBuff(state: Readonly<PlayerCombatState>, buffId: ReadinessBuffId): boolean {
  return state.buffs.some((buff) => buff.buffId === buffId && buff.stacks > 0);
}

function addBuff(state: Readonly<PlayerCombatState>, buffId: ReadinessBuffId): PlayerCombatState {
  if (hasBuff(state, buffId)) return { ...state, buffs: state.buffs.map((buff) => ({ ...buff })) };
  return { ...state, buffs: [...state.buffs.map((buff) => ({ ...buff })), { buffId, stacks: 1 }] };
}

function clearCombo(state: Readonly<PlayerCombatState>): PlayerCombatState {
  return {
    ...state,
    buffs: state.buffs
      .filter((buff) => !SAMURAI_COMBO_BUFF_IDS.includes(
        buff.buffId as (typeof SAMURAI_COMBO_BUFF_IDS)[number],
      ))
      .map((buff) => ({ ...buff })),
  };
}

function resolveSamuraiAbility(
  state: Readonly<PlayerCombatState>,
  ability: Readonly<AbilityDefinition>,
): PlayerCombatState {
  if (ability.slot === 4) return { ...state, buffs: state.buffs.map((buff) => ({ ...buff })) };
  const comboId = `samurai_combo_${ability.slot}` as ReadinessBuffId;
  if (hasBuff(state, comboId)) return clearCombo(state);
  let next = addBuff(state, comboId);
  if (!SAMURAI_COMBO_BUFF_IDS.every((id) => hasBuff(next, id))) return next;

  const stampId = `samurai_stamp_${ability.slot}` as ReadinessBuffId;
  next = clearCombo(next);
  return addBuff(next, stampId);
}

export const SAMURAI_CLASS: PlayerClassDefinition = Object.freeze({
  id: SAMURAI_CLASS_ID,
  name: "Samurai",
  abilitiesBySlot,
  createInitialState: () => ({
    classId: SAMURAI_CLASS_ID,
    buffs: [],
    globalCooldownEndsAtTick: 0,
  }),
  resolveAcceptedAbility: resolveSamuraiAbility,
});
