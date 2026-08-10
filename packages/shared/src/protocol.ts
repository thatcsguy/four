import { z } from "zod";

import {
  COMMAND_HZ,
  MAX_ACTIVE_PLAYERS,
  PROTOCOL_VERSION,
  SIMULATION_HZ,
  SNAPSHOT_HZ,
} from "./constants.js";

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

export const authoritativePlayerStateSchema = z.object({
  playerId: identifierSchema,
  position: vector3Schema,
  grounded: z.boolean(),
  verticalVelocity: finiteNumberSchema,
  airborneVelocity: vector2Schema,
  facingAngle: finiteNumberSchema,
  speedModifier: finiteNumberSchema.nonnegative(),
  control: controlStateSchema,
  stateRevision: safeNonNegativeIntegerSchema,
  lastProcessedInputSequence: safeNonNegativeIntegerSchema,
}).strict();

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

export const pingMessageSchema = z.object({
  type: z.literal("ping"),
  protocolVersion: versionSchema,
  nonce: safeNonNegativeIntegerSchema,
  sentAtMs: finiteNumberSchema.nonnegative(),
}).strict();

export const clientMessageSchema = z.discriminatedUnion("type", [
  inputMessageSchema,
  pingMessageSchema,
]);

const ratesSchema = z.object({
  simulationHz: z.literal(SIMULATION_HZ),
  commandHz: z.literal(COMMAND_HZ),
  snapshotHz: z.literal(SNAPSHOT_HZ),
}).strict();

const baselineSchema = z.object({
  snapshotSequence: safeNonNegativeIntegerSchema,
  serverTick: safeNonNegativeIntegerSchema,
  players: z.array(authoritativePlayerStateSchema).max(MAX_ACTIVE_PLAYERS),
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
}).strict();

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
export type PingMessage = z.infer<typeof pingMessageSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type WelcomeMessage = z.infer<typeof welcomeMessageSchema>;
export type SnapshotMessage = z.infer<typeof snapshotMessageSchema>;
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
