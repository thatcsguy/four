import {
  COMBAT_CONSTANTS,
  type BossState,
  type ProjectileState,
} from "@four/shared";

export interface CombatStepResult {
  readonly boss: BossState;
  readonly projectiles: ProjectileState[];
}

export function createInitialBossState(): BossState {
  const definition = COMBAT_CONSTANTS.boss;
  return {
    bossId: definition.id,
    name: definition.name,
    health: definition.maxHealth,
    maxHealth: definition.maxHealth,
    position: { ...definition.position },
    hitRadius: definition.hitRadius,
    stateRevision: 0,
  };
}

export function advanceCombat(
  boss: Readonly<BossState>,
  projectiles: readonly Readonly<ProjectileState>[],
  fixedDeltaSeconds: number,
): CombatStepResult {
  if (!Number.isFinite(fixedDeltaSeconds) || fixedDeltaSeconds < 0) {
    throw new RangeError("fixedDeltaSeconds must be finite and non-negative");
  }

  let nextBoss: BossState = copyBoss(boss);
  const remaining: ProjectileState[] = [];
  const target = {
    x: boss.position.x + COMBAT_CONSTANTS.boss.aimPoint.x - COMBAT_CONSTANTS.boss.position.x,
    y: boss.position.y + COMBAT_CONSTANTS.boss.aimPoint.y - COMBAT_CONSTANTS.boss.position.y,
    z: boss.position.z + COMBAT_CONSTANTS.boss.aimPoint.z - COMBAT_CONSTANTS.boss.position.z,
  };

  for (const projectile of projectiles) {
    const dx = target.x - projectile.position.x;
    const dy = target.y - projectile.position.y;
    const dz = target.z - projectile.position.z;
    const distance = Math.hypot(dx, dy, dz);
    const maximumStep = projectile.speed * fixedDeltaSeconds;

    if (distance <= nextBoss.hitRadius + maximumStep) {
      const damage = nextBoss.health > 0 ? Math.min(nextBoss.health, projectile.damage) : 0;
      if (damage > 0) {
        nextBoss = {
          ...nextBoss,
          health: nextBoss.health - damage,
          stateRevision: nextBoss.stateRevision + 1,
        };
      }
      continue;
    }

    const scale = distance === 0 ? 0 : maximumStep / distance;
    remaining.push({
      ...projectile,
      position: {
        x: projectile.position.x + dx * scale,
        y: projectile.position.y + dy * scale,
        z: projectile.position.z + dz * scale,
      },
    });
  }

  return { boss: nextBoss, projectiles: remaining };
}

export function copyBoss(boss: Readonly<BossState>): BossState {
  return { ...boss, position: { ...boss.position } };
}

export function copyProjectile(projectile: Readonly<ProjectileState>): ProjectileState {
  return { ...projectile, position: { ...projectile.position } };
}
