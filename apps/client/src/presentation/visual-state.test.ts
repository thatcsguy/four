import { describe, expect, it } from "vitest";

import {
  PLAYER_COLOR_PALETTE,
  hashPlayerId,
  playerColorForIndex,
  selectPlayerColorIndex,
} from "./visual-state.js";

describe("player visual mapping", () => {
  it("hashes an ID consistently", () => {
    expect(hashPlayerId("player-one")).toBe(hashPlayerId("player-one"));
    expect(hashPlayerId("player-one")).not.toBe(hashPlayerId("player-two"));
  });

  it("selects an available palette slot from a stable starting point", () => {
    const first = selectPlayerColorIndex("player-one");
    const occupied = new Set([first]);
    const second = selectPlayerColorIndex("player-one", occupied);

    expect(second).not.toBe(first);
    expect(second).toBe((first + 1) % PLAYER_COLOR_PALETTE.length);
  });

  it("keeps four concurrently assigned players visually distinct", () => {
    const occupied = new Set<number>();
    for (const id of ["alpha", "bravo", "charlie", "delta"]) {
      occupied.add(selectPlayerColorIndex(id, occupied));
    }

    expect(occupied.size).toBe(4);
  });

  it("normalizes arbitrary indices into the palette", () => {
    expect(playerColorForIndex(PLAYER_COLOR_PALETTE.length)).toBe(PLAYER_COLOR_PALETTE[0]);
    expect(playerColorForIndex(-1)).toBe(PLAYER_COLOR_PALETTE[1]);
  });
});
