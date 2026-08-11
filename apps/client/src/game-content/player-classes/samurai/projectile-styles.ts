import type { AbilityId } from "@four/shared";
import type { ProjectileStyle } from "../../../presentation/projectile-visual.js";

export const SAMURAI_PROJECTILE_STYLES = Object.freeze({
  samurai_1: Object.freeze({ color: 0xe5e7eb, emissive: 0x64748b, radius: 0.22, opacity: 0.9 }),
  samurai_2: Object.freeze({ color: 0xfca5a5, emissive: 0x991b1b, radius: 0.22, opacity: 0.9 }),
  samurai_3: Object.freeze({ color: 0xfde68a, emissive: 0x92400e, radius: 0.22, opacity: 0.9 }),
  samurai_4: Object.freeze({ color: 0xfef3c7, emissive: 0xdc2626, radius: 0.48, opacity: 1 }),
}) satisfies Readonly<Partial<Record<AbilityId, ProjectileStyle>>>;
