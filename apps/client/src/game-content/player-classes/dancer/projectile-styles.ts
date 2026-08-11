import type { AbilityId } from "@four/shared";

import type { ProjectileStyle } from "../../../presentation/projectile-visual.js";

export const DANCER_PROJECTILE_STYLES: Readonly<Record<AbilityId, ProjectileStyle>> = Object.freeze({
  dancer_1: Object.freeze({ color: 0xff6b73, emissive: 0xff2438, radius: 0.34, opacity: 1 }),
  dancer_2: Object.freeze({ color: 0x7dd3fc, emissive: 0x1976a3, radius: 0.24, opacity: 0.9 }),
  dancer_3: Object.freeze({ color: 0xc4b5fd, emissive: 0x654fb8, radius: 0.24, opacity: 0.9 }),
  dancer_4: Object.freeze({ color: 0xffd86b, emissive: 0xff8a1f, radius: 0.36, opacity: 1 }),
});
