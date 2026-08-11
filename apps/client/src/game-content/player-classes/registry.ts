import type { AbilityId } from "@four/shared";

import type { ProjectileStyle } from "../../presentation/projectile-visual.js";
import { DANCER_PROJECTILE_STYLES } from "./dancer/index.js";

const PROJECTILE_STYLES: Readonly<Record<AbilityId, ProjectileStyle>> = DANCER_PROJECTILE_STYLES;

export function getProjectileStyle(abilityId: AbilityId): ProjectileStyle {
  return PROJECTILE_STYLES[abilityId];
}
