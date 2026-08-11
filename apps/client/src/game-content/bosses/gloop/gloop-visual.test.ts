import { afterEach, describe, expect, it, vi } from "vitest";

import type { BossState } from "@four/shared";

import { DEFAULT_GLOOP_STATE, GloopVisual } from "./gloop-visual.js";
import { Nameplate } from "../../../presentation/nameplate.js";

function boss(health: number, stateRevision: number): BossState {
  return { ...DEFAULT_GLOOP_STATE, health, stateRevision };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GloopVisual", () => {
  it("updates the nameplate from authoritative health revisions and stays visible at zero", () => {
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => null,
      }),
    });
    const setNameplate = vi.spyOn(Nameplate.prototype, "set");
    const visual = new GloopVisual(boss(50_000, 0));
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
