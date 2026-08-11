import type { PlayerClassId } from "@four/shared";

export const PLAYER_COLOR_PALETTE = [
  0x2dd4bf,
  0xfb7185,
  0xfbbf24,
  0x818cf8,
] as const;

export interface FeetPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface PlayerRenderState {
  readonly id: string;
  readonly name: string;
  readonly health: number;
  readonly maxHealth: number;
  readonly position: FeetPosition;
  readonly facing: number;
  readonly grounded: boolean;
  readonly moving: boolean;
  readonly isLocal: boolean;
  readonly classId: PlayerClassId;
}

export function hashPlayerId(id: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function selectPlayerColorIndex(
  id: string,
  occupiedIndices: ReadonlySet<number> = new Set<number>(),
): number {
  const start = hashPlayerId(id) % PLAYER_COLOR_PALETTE.length;
  for (let offset = 0; offset < PLAYER_COLOR_PALETTE.length; offset += 1) {
    const index = (start + offset) % PLAYER_COLOR_PALETTE.length;
    if (!occupiedIndices.has(index)) {
      return index;
    }
  }
  return start;
}

export function playerColorForIndex(index: number): number {
  const normalizedIndex = Math.abs(Math.trunc(index)) % PLAYER_COLOR_PALETTE.length;
  return PLAYER_COLOR_PALETTE[normalizedIndex] ?? PLAYER_COLOR_PALETTE[0];
}
