import { MOVEMENT_CONSTANTS } from "./constants.js";
import type { AuthoritativePlayerState, Vector3 } from "./protocol.js";

export type SimulatedPlayerState = AuthoritativePlayerState;

export interface PlayerSpawn {
  playerId: string;
  position?: Readonly<Vector3>;
  facingAngle?: number;
}

export interface MovementInput {
  moveX: number;
  moveZ: number;
  jump: boolean;
}

/** Reserved for deterministic simulation inputs that are not player commands. */
export type MovementStepContext = Readonly<Record<never, never>>;

export const DEFAULT_MOVEMENT_STEP_CONTEXT: MovementStepContext = Object.freeze({});

function clampToArena(x: number, z: number): { x: number; z: number } {
  const distance = Math.hypot(x, z);

  if (distance <= MOVEMENT_CONSTANTS.arenaRadius) {
    return { x, z };
  }

  const scale = MOVEMENT_CONSTANTS.arenaRadius / distance;
  return { x: x * scale, z: z * scale };
}

function normalizedIntent(input: Readonly<MovementInput>): { x: number; z: number } {
  if (!Number.isFinite(input.moveX) || !Number.isFinite(input.moveZ)) {
    return { x: 0, z: 0 };
  }

  const magnitude = Math.hypot(input.moveX, input.moveZ);
  if (magnitude === 0) {
    return { x: 0, z: 0 };
  }

  const divisor = Math.max(1, magnitude);
  return { x: input.moveX / divisor, z: input.moveZ / divisor };
}

function shortestAngleDelta(from: number, to: number): number {
  const fullTurn = Math.PI * 2;
  return ((to - from + Math.PI) % fullTurn + fullTurn) % fullTurn - Math.PI;
}

export function createInitialPlayerState(spawn: Readonly<PlayerSpawn>): SimulatedPlayerState {
  const position = spawn.position ?? { x: 0, y: MOVEMENT_CONSTANTS.groundHeight, z: 0 };
  const boundedPosition = clampToArena(position.x, position.z);

  return {
    playerId: spawn.playerId,
    position: {
      x: boundedPosition.x,
      y: MOVEMENT_CONSTANTS.groundHeight,
      z: boundedPosition.z,
    },
    grounded: true,
    verticalVelocity: 0,
    airborneVelocity: { x: 0, z: 0 },
    facingAngle: spawn.facingAngle ?? 0,
    speedModifier: 1,
    control: {
      mode: "normal",
      revision: 0,
      permissions: { allowMove: true, allowLook: true, allowActions: true },
      startedAtTick: 0,
    },
    stateRevision: 0,
    lastProcessedInputSequence: 0,
  };
}

/**
 * Advances one deterministic movement step.
 *
 * Order is intentional: derive bounded intent and ground velocity; apply either
 * ground travel/takeoff or captured air travel; integrate gravity and height;
 * project XZ to the arena; then turn facing from the live intent.
 */
export function stepPlayer(
  state: Readonly<SimulatedPlayerState>,
  input: Readonly<MovementInput>,
  fixedDelta: number,
  _context: MovementStepContext = DEFAULT_MOVEMENT_STEP_CONTEXT,
): SimulatedPlayerState {
  if (!Number.isFinite(fixedDelta) || fixedDelta < 0) {
    throw new RangeError("fixedDelta must be a finite, non-negative number");
  }

  const intent = normalizedIntent(input);
  const speed = MOVEMENT_CONSTANTS.baseSpeed * state.speedModifier;
  const groundVelocity = { x: intent.x * speed, z: intent.z * speed };
  let x = state.position.x;
  let y = state.position.y;
  let z = state.position.z;
  let grounded = state.grounded;
  let verticalVelocity = state.verticalVelocity;
  let airborneVelocity = { ...state.airborneVelocity };

  if (grounded) {
    x += groundVelocity.x * fixedDelta;
    z += groundVelocity.z * fixedDelta;

    if (input.jump) {
      grounded = false;
      verticalVelocity = MOVEMENT_CONSTANTS.jumpVelocity;
      airborneVelocity = { ...groundVelocity };
    }
  } else {
    x += airborneVelocity.x * fixedDelta;
    z += airborneVelocity.z * fixedDelta;
  }

  if (!grounded) {
    verticalVelocity -= MOVEMENT_CONSTANTS.gravity * fixedDelta;
    y += verticalVelocity * fixedDelta;

    if (y <= MOVEMENT_CONSTANTS.groundHeight) {
      y = MOVEMENT_CONSTANTS.groundHeight;
      grounded = true;
      verticalVelocity = 0;
      airborneVelocity = { x: 0, z: 0 };
    }
  } else {
    y = MOVEMENT_CONSTANTS.groundHeight;
  }

  const boundedPosition = clampToArena(x, z);
  let facingAngle = state.facingAngle;
  if (intent.x !== 0 || intent.z !== 0) {
    const desiredFacing = Math.atan2(intent.x, intent.z);
    const delta = shortestAngleDelta(facingAngle, desiredFacing);
    const maximumTurn = MOVEMENT_CONSTANTS.facingTurnRate * fixedDelta;
    facingAngle += Math.max(-maximumTurn, Math.min(maximumTurn, delta));
  }

  return {
    ...state,
    position: { x: boundedPosition.x, y, z: boundedPosition.z },
    grounded,
    verticalVelocity,
    airborneVelocity,
    facingAngle,
  };
}
