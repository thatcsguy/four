import { type BossId, type BossState, GLOOP_BOSS } from "@four/shared";

import { DEFAULT_GLOOP_STATE, GloopVisual } from "./gloop/index.js";
import type { BossVisualHandle } from "./types.js";

const BOSS_VISUAL_FACTORIES: Readonly<Record<BossId, (state: Readonly<BossState>) => BossVisualHandle>> = {
  gloop: (state) => new GloopVisual(state),
};

export const DEFAULT_BOSS_STATE = DEFAULT_GLOOP_STATE;

export function createBossVisual(state: Readonly<BossState> = DEFAULT_BOSS_STATE): BossVisualHandle {
  const factory = BOSS_VISUAL_FACTORIES[state.bossId as BossId];
  if (factory === undefined) throw new Error(`No visual registered for boss ${state.bossId}`);
  return factory(state);
}

export function bossAimPoint(bossId: BossId): typeof GLOOP_BOSS.aimPoint {
  if (bossId !== GLOOP_BOSS.id) throw new Error(`No aim point registered for boss ${bossId}`);
  return GLOOP_BOSS.aimPoint;
}
