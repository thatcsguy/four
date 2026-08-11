import type {
  ABILITY_IDS,
  PLAYER_CLASS_IDS,
  READINESS_BUFF_IDS,
} from "./player-classes/registry.js";
import type { BOSS_IDS } from "./bosses/registry.js";

export const ABILITY_SLOTS = [1, 2, 3, 4] as const;

export type AbilitySlot = (typeof ABILITY_SLOTS)[number];
export type PlayerClassId = (typeof PLAYER_CLASS_IDS)[number];
export type AbilityId = (typeof ABILITY_IDS)[number];
export type ReadinessBuffId = (typeof READINESS_BUFF_IDS)[number];
export type BossId = (typeof BOSS_IDS)[number];

export interface Vector3Definition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface BuffState {
  readonly buffId: string;
  readonly stacks: number;
  readonly expiresAtTick?: number;
}

export interface PlayerCombatState {
  readonly classId: PlayerClassId;
  readonly buffs: BuffState[];
  readonly globalCooldownEndsAtTick: number;
}

export interface AbilityDefinition {
  readonly abilityId: AbilityId;
  readonly classId: PlayerClassId;
  readonly slot: AbilitySlot;
  readonly name: string;
  readonly damage: number;
  readonly delivery?: "projectile" | "melee";
  /** Maximum reach in meters from the attacker to the target's collision boundary. */
  readonly maxRange?: number;
  readonly requiredBuffId?: ReadinessBuffId;
  readonly requiredBuffIds?: readonly ReadinessBuffId[];
  readonly guaranteedBuffId?: ReadinessBuffId;
  readonly procBuffId?: ReadinessBuffId;
  readonly procChance?: number;
  /** Omit for abilities that neither respect nor trigger the global cooldown. */
  readonly globalCooldownTicks?: number;
}

export interface PlayerClassDefinition {
  readonly id: PlayerClassId;
  readonly name: string;
  readonly abilitiesBySlot: Readonly<Partial<Record<AbilitySlot, AbilityDefinition>>>;
  createInitialState(): PlayerCombatState;
  resolveAcceptedAbility?(
    combatState: Readonly<PlayerCombatState>,
    ability: Readonly<AbilityDefinition>,
  ): PlayerCombatState;
}

export interface BossDefinition {
  readonly id: BossId;
  readonly name: string;
  readonly maxHealth: number;
  readonly position: Vector3Definition;
  readonly aimPoint: Vector3Definition;
  readonly hitRadius: number;
}
