import { SIMULATION_HZ } from "../constants.js";

export const ABILITY_QUEUE_WINDOW_SECONDS = 0.5;
export const ABILITY_QUEUE_WINDOW_TICKS = ABILITY_QUEUE_WINDOW_SECONDS * SIMULATION_HZ;

export const COMBAT_CONSTANTS = Object.freeze({
  maxBuffsPerPlayer: 16,
  maxActiveProjectiles: 128,
  projectile: Object.freeze({
    speed: 36,
    spawnHeight: 1.2,
  }),
});
