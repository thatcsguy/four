import { GLOOP_BOSS, GLOOP_BOSS_ID } from "./gloop/index.js";
import type { BossDefinition, BossId } from "../types.js";

export const BOSS_IDS = [GLOOP_BOSS_ID] as const;
export const ACTIVE_BOSS_ID = GLOOP_BOSS_ID;

export const BOSSES: Readonly<Record<BossId, BossDefinition>> = Object.freeze({
  gloop: GLOOP_BOSS,
});

export function getBossDefinition(bossId: BossId): BossDefinition {
  return BOSSES[bossId];
}
