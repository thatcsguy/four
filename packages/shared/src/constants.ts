export const PROTOCOL_VERSION = 4 as const;

export const SIMULATION_HZ = 60;
export const COMMAND_HZ = 60;
export const SNAPSHOT_HZ = 20;
export const FIXED_DELTA_SECONDS = 1 / SIMULATION_HZ;
export const MAX_ACTIVE_PLAYERS = 4;

export const MOVEMENT_CONSTANTS = {
  playerHeight: 1.8,
  playerRadius: 0.4,
  groundHeight: 0,
  baseSpeed: 5,
  sprintSpeedModifier: 1.3,
  jumpVelocity: 8,
  gravity: 20,
  facingTurnRate: 10,
  arenaRadius: 18.3,
} as const;

export const PRESENTATION_CONSTANTS = {
  walkSwingAmplitude: 0.5,
  walkPhaseRate: 10,
  idleReturnRate: 5,
} as const;

export const CAMERA_CONSTANTS = {
  followHeight: 1.35,
  verticalFovDegrees: 60,
  nearClip: 0.1,
  farClip: 1000,
  initialYaw: 0,
  initialPitch: 0.5,
  minPitch: -Math.PI / 4,
  maxPitch: Math.PI / 2,
  initialDistance: 15,
  minDistance: 3,
  maxDistance: 21,
  minHeight: 0.1,
  mouseOrbitRadiansPerPixel: 0.003,
  gamepadDeadzone: 0.1,
  gamepadOrbitRadiansPerSecond: 2.5,
  gamepadZoomMetersPerSecond: 15,
  wheelZoomStep: 1.5,
  initialScreenPosition: 0.5,
  screenPositionStep: 0.05,
} as const;
