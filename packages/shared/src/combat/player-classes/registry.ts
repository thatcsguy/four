import {
  DANCER_ABILITY_IDS,
  DANCER_CLASS,
  DANCER_CLASS_ID,
  DANCER_READINESS_BUFF_IDS,
} from "./dancer/index.js";

export const PLAYER_CLASS_IDS = [DANCER_CLASS_ID] as const;
export const ABILITY_IDS = [...DANCER_ABILITY_IDS] as const;
export const READINESS_BUFF_IDS = [...DANCER_READINESS_BUFF_IDS] as const;

export const PLAYER_CLASSES = Object.freeze({
  dancer: DANCER_CLASS,
});
