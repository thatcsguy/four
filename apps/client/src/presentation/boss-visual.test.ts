import { afterEach, describe, expect, it, vi } from "vitest";

import type { BossState } from "@four/shared";

import { BossVisual, DEFAULT_BOSS_STATE } from "./boss-visual.js";
import { Nameplate } from "./nameplate.js";

function boss(health: number, stateRevision: number): BossState {
  return { ...DEFAULT_BOSS_STATE, health, stateRevision };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BossVisual", () => {
  it("updates the nameplate from authoritative health revisions and stays visible at zero", () => {
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => null,
      }),
    });
    const setNameplate = vi.spyOn(Nameplate.prototype, "set");
    const visual = new BossVisual(boss(50_000, 0));
    setNameplate.mockClear();

    visual.setState(boss(35_000, 1));
    expect(setNameplate).toHaveBeenLastCalledWith("Gloop", 35_000, 50_000);
    visual.setState(boss(35_000, 1));
    expect(setNameplate).toHaveBeenCalledTimes(1);
    visual.setState(boss(0, 2));
    expect(setNameplate).toHaveBeenLastCalledWith("Gloop", 0, 50_000);
    expect(visual.root.visible).toBe(true);

    visual.dispose();
  });
});
