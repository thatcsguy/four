import { MAX_ACTIVE_PLAYERS, SIMULATION_HZ, SNAPSHOT_HZ } from "@four/shared";

export const SERVER_DEFAULT_PORT = 8080;
export const SERVER_CAPACITY = MAX_ACTIVE_PLAYERS;
export const FIXED_STEP_MS = 1_000 / SIMULATION_HZ;
export const SNAPSHOT_INTERVAL_TICKS = SIMULATION_HZ / SNAPSHOT_HZ;

/** At most 83.3 ms of simulation is recovered after a long event-loop stall. */
export const MAX_CATCH_UP_STEPS = 5;
/** Repeat the last processed held intent for at most 100 ms, then go neutral. */
export const MISSING_INPUT_GRACE_TICKS = 6;
export const MAX_INPUT_QUEUE_LENGTH = 120;
export const MAX_MESSAGE_BYTES = 4_096;
export const MAX_MESSAGES_PER_SECOND = 120;
export const RATE_LIMIT_WINDOW_MS = 1_000;

export const SPAWN_POINTS = [
  { x: -2, y: 0, z: -2 },
  { x: 2, y: 0, z: -2 },
  { x: -2, y: 0, z: 2 },
  { x: 2, y: 0, z: 2 },
] as const;

export function configuredPort(value = process.env.WS_PORT): number {
  const parsed = Number.parseInt(value ?? String(SERVER_DEFAULT_PORT), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65_535
    ? parsed
    : SERVER_DEFAULT_PORT;
}
