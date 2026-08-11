import { SIMULATION_HZ } from "../../../constants.js";
import type { AbilityDefinition, PlayerClassDefinition } from "../../types.js";

export const DANCER_CLASS_ID = "dancer" as const;
export const DANCER_ABILITY_IDS = [
  "dancer_1",
  "dancer_2",
  "dancer_3",
  "dancer_4",
] as const;
export const DANCER_READINESS_BUFF_IDS = [
  "dancer_1_ready",
  "dancer_3_ready",
  "dancer_4_ready",
] as const;

export const DANCER_GLOBAL_COOLDOWN_SECONDS = 2.5;
export const DANCER_GLOBAL_COOLDOWN_TICKS = DANCER_GLOBAL_COOLDOWN_SECONDS * SIMULATION_HZ;

export const DANCER_ABILITIES = Object.freeze({
  dancer_1: Object.freeze({
    abilityId: "dancer_1",
    classId: DANCER_CLASS_ID,
    slot: 1,
    name: "Crimson Fan",
    damage: 25,
    requiredBuffId: "dancer_1_ready",
    globalCooldownTicks: DANCER_GLOBAL_COOLDOWN_TICKS,
  }),
  dancer_2: Object.freeze({
    abilityId: "dancer_2",
    classId: DANCER_CLASS_ID,
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
    classId: DANCER_CLASS_ID,
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
    classId: DANCER_CLASS_ID,
    slot: 4,
    name: "Golden Fan",
    damage: 25,
    requiredBuffId: "dancer_4_ready",
    globalCooldownTicks: DANCER_GLOBAL_COOLDOWN_TICKS,
  }),
}) satisfies Readonly<Record<(typeof DANCER_ABILITY_IDS)[number], AbilityDefinition>>;

const abilitiesBySlot = Object.freeze(Object.fromEntries(
  Object.values(DANCER_ABILITIES).map((ability) => [ability.slot, ability]),
)) as PlayerClassDefinition["abilitiesBySlot"];

export const DANCER_CLASS: PlayerClassDefinition = Object.freeze({
  id: DANCER_CLASS_ID,
  abilitiesBySlot,
  createInitialState: () => ({
    classId: DANCER_CLASS_ID,
    buffs: [],
    globalCooldownEndsAtTick: 0,
  }),
});
