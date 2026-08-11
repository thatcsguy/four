import type { BossDefinition } from "../../types.js";

export const GLOOP_BOSS_ID = "gloop" as const;

export const GLOOP_BOSS = Object.freeze({
  id: GLOOP_BOSS_ID,
  name: "Gloop",
  maxHealth: 50_000,
  position: Object.freeze({ x: 0, y: 0, z: 0 }),
  aimPoint: Object.freeze({ x: 0, y: 1.6, z: 0 }),
  hitRadius: 1.7,
}) satisfies BossDefinition;
