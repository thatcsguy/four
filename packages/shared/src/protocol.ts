import { z } from "zod";

import {
  COMMAND_HZ,
  MAX_ACTIVE_PLAYERS,
  PROTOCOL_VERSION,
  SIMULATION_HZ,
  SNAPSHOT_HZ,
} from "./constants.js";
import {
  ABILITY_SLOTS,
  COMBAT_CONSTANTS,
  ABILITY_IDS,
  PLAYER_CLASS_IDS,
} from "./combat.js";

const safeNonNegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const finiteNumberSchema = z.number().finite();
const identifierSchema = z.string().min(1).max(128);

export const vector2Schema = z.object({
  x: finiteNumberSchema,
  z: finiteNumberSchema,
}).strict();

export const vector3Schema = z.object({
  x: finiteNumberSchema,
  y: finiteNumberSchema,
  z: finiteNumberSchema,
}).strict();

export const controlPermissionsSchema = z.object({
  allowMove: z.boolean(),
  allowLook: z.boolean(),
  allowActions: z.boolean(),
}).strict();

export const forcedMotionSchema = z.object({
  id: identifierSchema,
  kind: identifierSchema,
  startTick: safeNonNegativeIntegerSchema,
  endTick: safeNonNegativeIntegerSchema,
  start: vector3Schema,
  end: vector3Schema.optional(),
  initialVelocity: vector3Schema.optional(),
  parameters: z.record(z.string(), finiteNumberSchema).optional(),
}).strict().refine((motion) => motion.endTick >= motion.startTick, {
  message: "endTick must not precede startTick",
});

export const controlStateSchema = z.object({
  mode: z.enum(["normal", "restricted", "forcedMotion", "disabled"]),
  revision: safeNonNegativeIntegerSchema,
  permissions: controlPermissionsSchema,
  startedAtTick: safeNonNegativeIntegerSchema,
  endsAtTick: safeNonNegativeIntegerSchema.optional(),
  forcedMotion: forcedMotionSchema.optional(),
}).strict().superRefine((control, context) => {
  if (control.endsAtTick !== undefined && control.endsAtTick < control.startedAtTick) {
    context.addIssue({ code: "custom", message: "endsAtTick must not precede startedAtTick" });
  }
  if (control.mode === "forcedMotion" && control.forcedMotion === undefined) {
    context.addIssue({ code: "custom", message: "forcedMotion mode requires forcedMotion state" });
  }
  if (control.mode !== "forcedMotion" && control.forcedMotion !== undefined) {
    context.addIssue({ code: "custom", message: "forcedMotion state requires forcedMotion mode" });
  }
});

export const buffStateSchema = z.object({
  buffId: identifierSchema,
  stacks: safeNonNegativeIntegerSchema.min(1).max(99),
  expiresAtTick: safeNonNegativeIntegerSchema.optional(),
}).strict();

export const playerCombatStateSchema = z.object({
  classId: z.enum(PLAYER_CLASS_IDS),
  buffs: z.array(buffStateSchema).max(COMBAT_CONSTANTS.maxBuffsPerPlayer),
  globalCooldownEndsAtTick: safeNonNegativeIntegerSchema,
}).strict().refine(
  (combat) => new Set(combat.buffs.map((buff) => buff.buffId)).size === combat.buffs.length,
  { message: "buff IDs must be unique", path: ["buffs"] },
);

export const authoritativePlayerStateSchema = z.object({
  playerId: identifierSchema,
  displayName: z.string().min(1).max(24),
  health: finiteNumberSchema.nonnegative(),
  maxHealth: finiteNumberSchema.positive(),
  position: vector3Schema,
  grounded: z.boolean(),
  verticalVelocity: finiteNumberSchema,
  airborneVelocity: vector2Schema,
  facingAngle: finiteNumberSchema,
  speedModifier: finiteNumberSchema.nonnegative(),
  combat: playerCombatStateSchema,
  control: controlStateSchema,
  stateRevision: safeNonNegativeIntegerSchema,
  lastProcessedInputSequence: safeNonNegativeIntegerSchema,
}).strict().refine((state) => state.health <= state.maxHealth, {
  message: "health must not exceed maxHealth",
  path: ["health"],
});

const versionSchema = z.literal(PROTOCOL_VERSION);
const epochSchema = identifierSchema;

export const inputMessageSchema = z.object({
  type: z.literal("input"),
  protocolVersion: versionSchema,
  epoch: epochSchema,
  sequence: safeNonNegativeIntegerSchema,
  clientTick: safeNonNegativeIntegerSchema,
  moveX: finiteNumberSchema.min(-1).max(1),
  moveZ: finiteNumberSchema.min(-1).max(1),
  jump: z.boolean(),
}).strict().refine((input) => input.moveX ** 2 + input.moveZ ** 2 <= 1 + Number.EPSILON, {
  message: "movement vector magnitude must not exceed 1",
  path: ["moveX"],
});

export const abilityUseMessageSchema = z.object({
  type: z.literal("ability_use"),
  protocolVersion: versionSchema,
  epoch: epochSchema,
  requestId: safeNonNegativeIntegerSchema,
  slot: z.union(ABILITY_SLOTS.map((slot) => z.literal(slot))),
}).strict();

export const pingMessageSchema = z.object({
  type: z.literal("ping"),
  protocolVersion: versionSchema,
  nonce: safeNonNegativeIntegerSchema,
  sentAtMs: finiteNumberSchema.nonnegative(),
}).strict();

export const clientMessageSchema = z.discriminatedUnion("type", [
  inputMessageSchema,
  abilityUseMessageSchema,
  pingMessageSchema,
]);

const ratesSchema = z.object({
  simulationHz: z.literal(SIMULATION_HZ),
  commandHz: z.literal(COMMAND_HZ),
  snapshotHz: z.literal(SNAPSHOT_HZ),
}).strict();

export const bossStateSchema = z.object({
  bossId: identifierSchema,
  name: z.string().min(1).max(64),
  health: finiteNumberSchema.nonnegative(),
  maxHealth: finiteNumberSchema.positive(),
  position: vector3Schema,
  hitRadius: finiteNumberSchema.positive(),
  stateRevision: safeNonNegativeIntegerSchema,
}).strict().refine((boss) => boss.health <= boss.maxHealth, {
  message: "health must not exceed maxHealth",
  path: ["health"],
});

export const projectileStateSchema = z.object({
  projectileId: identifierSchema,
  ownerPlayerId: identifierSchema,
  abilityId: z.enum(ABILITY_IDS),
  targetId: identifierSchema,
  position: vector3Schema,
  speed: finiteNumberSchema.positive(),
  damage: finiteNumberSchema.nonnegative(),
  spawnedAtTick: safeNonNegativeIntegerSchema,
}).strict();

export const baselineSchema = z.object({
  snapshotSequence: safeNonNegativeIntegerSchema,
  serverTick: safeNonNegativeIntegerSchema,
  players: z.array(authoritativePlayerStateSchema).max(MAX_ACTIVE_PLAYERS),
  boss: bossStateSchema,
  projectiles: z.array(projectileStateSchema).max(COMBAT_CONSTANTS.maxActiveProjectiles),
}).strict();

export const welcomeMessageSchema = z.object({
  type: z.literal("welcome"),
  protocolVersion: versionSchema,
  playerId: identifierSchema,
  epoch: epochSchema,
  rates: ratesSchema,
  initialServerTick: safeNonNegativeIntegerSchema,
  baseline: baselineSchema,
}).strict().refine((message) => message.initialServerTick === message.baseline.serverTick, {
  message: "initialServerTick must match the baseline serverTick",
});

export const snapshotMessageSchema = z.object({
  type: z.literal("snapshot"),
  protocolVersion: versionSchema,
  epoch: epochSchema,
  snapshotSequence: safeNonNegativeIntegerSchema,
  serverTick: safeNonNegativeIntegerSchema,
  players: z.array(authoritativePlayerStateSchema).max(MAX_ACTIVE_PLAYERS),
  boss: bossStateSchema,
  projectiles: z.array(projectileStateSchema).max(COMBAT_CONSTANTS.maxActiveProjectiles),
}).strict();

export const abilityResultMessageSchema = z.object({
  type: z.literal("ability_result"),
  protocolVersion: versionSchema,
  epoch: epochSchema,
  requestId: safeNonNegativeIntegerSchema,
  slot: z.union(ABILITY_SLOTS.map((slot) => z.literal(slot))),
  accepted: z.boolean(),
  reason: z.enum([
    "accepted",
    "missing_buff",
    "global_cooldown",
    "boss_defeated",
    "stale_request",
    "invalid_request",
  ]),
  combat: playerCombatStateSchema,
}).strict().superRefine((result, context) => {
  if (result.accepted !== (result.reason === "accepted")) {
    context.addIssue({
      code: "custom",
      message: "accepted must be true exactly when reason is accepted",
      path: ["accepted"],
    });
  }
});

export const pongMessageSchema = z.object({
  type: z.literal("pong"),
  protocolVersion: versionSchema,
  nonce: safeNonNegativeIntegerSchema,
  sentAtMs: finiteNumberSchema.nonnegative(),
}).strict();

export const serverFullMessageSchema = z.object({
  type: z.literal("server_full"),
  protocolVersion: versionSchema,
  maxPlayers: z.literal(MAX_ACTIVE_PLAYERS),
  message: z.string().min(1).max(256),
}).strict();

export const protocolErrorMessageSchema = z.object({
  type: z.literal("protocol_error"),
  protocolVersion: versionSchema,
  code: z.enum(["invalid_json", "invalid_message", "wrong_version", "rate_limited"]),
  message: z.string().min(1).max(256),
}).strict();

export const serverMessageSchema = z.discriminatedUnion("type", [
  welcomeMessageSchema,
  snapshotMessageSchema,
  abilityResultMessageSchema,
  pongMessageSchema,
  serverFullMessageSchema,
  protocolErrorMessageSchema,
]);

export type Vector2 = z.infer<typeof vector2Schema>;
export type Vector3 = z.infer<typeof vector3Schema>;
export type ControlPermissions = z.infer<typeof controlPermissionsSchema>;
export type ForcedMotion = z.infer<typeof forcedMotionSchema>;
export type ControlState = z.infer<typeof controlStateSchema>;
export type AuthoritativePlayerState = z.infer<typeof authoritativePlayerStateSchema>;
export type InputMessage = z.infer<typeof inputMessageSchema>;
export type AbilityUseMessage = z.infer<typeof abilityUseMessageSchema>;
export type PingMessage = z.infer<typeof pingMessageSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type WelcomeMessage = z.infer<typeof welcomeMessageSchema>;
export type SnapshotMessage = z.infer<typeof snapshotMessageSchema>;
export type AbilityResultMessage = z.infer<typeof abilityResultMessageSchema>;
export type BossState = z.infer<typeof bossStateSchema>;
export type ProjectileState = z.infer<typeof projectileStateSchema>;
export type PongMessage = z.infer<typeof pongMessageSchema>;
export type ServerFullMessage = z.infer<typeof serverFullMessageSchema>;
export type ProtocolErrorMessage = z.infer<typeof protocolErrorMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export type DecodeError = {
  code: "invalid_json" | "invalid_message";
  message: string;
};

export type DecodeResult<T> =
  | { success: true; data: T }
  | { success: false; error: DecodeError };

function decodeWithSchema<T>(raw: string, schema: z.ZodType<T>): DecodeResult<T> {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { success: false, error: { code: "invalid_json", message: "Message is not valid JSON" } };
  }

  const result = schema.safeParse(value);
  if (!result.success) {
    return {
      success: false,
      error: { code: "invalid_message", message: z.prettifyError(result.error) },
    };
  }
  return { success: true, data: result.data };
}

function encodeWithSchema<T>(message: T, schema: z.ZodType<T>): string {
  const result = schema.safeParse(message);
  if (!result.success) {
    throw new TypeError(z.prettifyError(result.error));
  }
  return JSON.stringify(result.data);
}

export function decodeClientMessage(raw: string): DecodeResult<ClientMessage> {
  return decodeWithSchema(raw, clientMessageSchema);
}

export function decodeServerMessage(raw: string): DecodeResult<ServerMessage> {
  return decodeWithSchema(raw, serverMessageSchema);
}

export function encodeClientMessage(message: ClientMessage): string {
  return encodeWithSchema(message, clientMessageSchema);
}

export function encodeServerMessage(message: ServerMessage): string {
  return encodeWithSchema(message, serverMessageSchema);
}
