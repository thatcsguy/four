import { describe, expect, it, vi } from "vitest";

import { createInitialCombatState, type PlayerCombatState } from "@four/shared";

import { AbilityHotbar, type AbilityHotbarState } from "./ability-hotbar.js";

class FakeElement extends EventTarget {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  className = "";
  disabled = false;
  textContent = "";
  type = "";
  readonly style = {
    values: new Map<string, string>(),
    setProperty(name: string, value: string): void {
      this.values.set(name, value);
    },
    getPropertyValue(name: string): string {
      return this.values.get(name) ?? "";
    },
  };

  constructor(readonly tagName: string) {
    super();
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  click(): void {
    this.dispatchEvent(new Event("click"));
  }
}

class FakeDocument {
  createElement(tagName: string): HTMLElement {
    return new FakeElement(tagName) as unknown as HTMLElement;
  }
}

function state(
  combat: PlayerCombatState = createInitialCombatState(),
  overrides: Partial<Omit<AbilityHotbarState, "combat">> = {},
): AbilityHotbarState {
  return { combat, connected: true, bossAlive: true, serverTick: 0, ...overrides };
}

function setup(initialState: AbilityHotbarState = state()) {
  const onUse = vi.fn();
  const hotbar = new AbilityHotbar({
    state: initialState,
    onUse,
    documentTarget: new FakeDocument(),
  });
  const root = hotbar.root as unknown as FakeElement;
  return { hotbar, onUse, root, buttons: root.children };
}

describe("AbilityHotbar", () => {
  it("creates exactly four ordered accessible buttons and enables only slot 2 initially", () => {
    const { root, buttons } = setup();
    expect(root.tagName).toBe("nav");
    expect(root.attributes.get("aria-label")).toBe("Abilities");
    expect(buttons).toHaveLength(4);
    expect(buttons.map((button) => button.attributes.get("aria-keyshortcuts"))).toEqual(["1", "2", "3", "4"]);
    expect(buttons.map((button) => button.disabled)).toEqual([true, false, true, true]);
    expect(buttons[1]?.children.map((child) => child.textContent)).toEqual(["2", ""]);
    expect(buttons[1]?.children[1]?.attributes.get("aria-hidden")).toBe("true");
  });

  it.each([
    ["dancer_1_ready", 0],
    ["dancer_3_ready", 2],
    ["dancer_4_ready", 3],
  ] as const)("buff %s enables and marks only its proc slot", (buffId, enabledIndex) => {
    const combat: PlayerCombatState = {
      classId: "dancer",
      buffs: [{ buffId, stacks: 1 }],
      globalCooldownEndsAtTick: 0,
    };
    const { buttons } = setup(state(combat));
    expect(buttons.map((button) => button.disabled)).toEqual(
      [0, 1, 2, 3].map((index) => index !== 1 && index !== enabledIndex),
    );
    expect(buttons.map((button) => button.dataset.procReady)).toEqual(
      [0, 1, 2, 3].map((index) => String(index === enabledIndex)),
    );
  });

  it("disables all slots with the right reason when disconnected or defeated", () => {
    const { hotbar, buttons } = setup(state());
    hotbar.setState(state(createInitialCombatState(), { connected: false }));
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(buttons.every((button) => button.attributes.get("aria-label")?.includes("Disconnected"))).toBe(true);
    hotbar.setState(state(createInitialCombatState(), { bossAlive: false }));
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(buttons.every((button) => button.attributes.get("aria-label")?.includes("Boss defeated"))).toBe(true);
  });

  it("routes enabled clicks only and setState reuses all nodes and listeners", () => {
    const { hotbar, onUse, root, buttons } = setup();
    buttons[0]?.click();
    buttons[1]?.click();
    expect(onUse).toHaveBeenCalledTimes(1);
    expect(onUse).toHaveBeenLastCalledWith(2);
    const originalButtons = [...buttons];
    hotbar.setState(state({
      classId: "dancer",
      buffs: [{ buffId: "dancer_1_ready", stacks: 1 }],
      globalCooldownEndsAtTick: 0,
    }));
    expect(root.children).toEqual(originalButtons);
    buttons[0]?.click();
    expect(onUse).toHaveBeenLastCalledWith(1);
    expect(onUse).toHaveBeenCalledTimes(2);
  });

  it("dispose removes click listeners and ignores later state", () => {
    const { hotbar, onUse, buttons } = setup();
    hotbar.dispose();
    buttons[1]?.click();
    expect(onUse).not.toHaveBeenCalled();
    hotbar.setState(state());
  });

  it("disables all Dancer slots and advances the authoritative radial global cooldown", () => {
    const combat: PlayerCombatState = {
      classId: "dancer",
      buffs: [{ buffId: "dancer_3_ready", stacks: 1 }],
      globalCooldownEndsAtTick: 250,
    };
    const { hotbar, buttons } = setup(state(combat, { serverTick: 100 }));
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(buttons.every((button) => button.dataset.globalCooldown === "true")).toBe(true);
    expect(buttons.every((button) => button.style.getPropertyValue("--gcd-remaining") === "360deg")).toBe(true);

    hotbar.setState(state(combat, { serverTick: 175 }));
    expect(buttons.every((button) => button.style.getPropertyValue("--gcd-remaining") === "180deg")).toBe(true);
    hotbar.setState(state(combat, { serverTick: 219 }));
    expect(buttons.every((button) => button.disabled)).toBe(true);
    hotbar.setState(state(combat, { serverTick: 220 }));
    expect(buttons.map((button) => button.disabled)).toEqual([true, false, false, true]);
    expect(buttons.every((button) => button.dataset.globalCooldown === "true")).toBe(true);
    hotbar.setState(state(combat, { serverTick: 250 }));
    expect(buttons.map((button) => button.disabled)).toEqual([true, false, false, true]);
    expect(buttons.every((button) => button.style.getPropertyValue("--gcd-remaining") === "0deg")).toBe(true);
  });

  it("snaps a renewed global cooldown to the start instead of animating backward", () => {
    const endingCooldown: PlayerCombatState = {
      classId: "dancer",
      buffs: [{ buffId: "dancer_3_ready", stacks: 1 }],
      globalCooldownEndsAtTick: 250,
    };
    const { hotbar, buttons } = setup(state(endingCooldown, { serverTick: 249 }));
    for (const button of buttons) {
      expect(Number.parseFloat(button.style.getPropertyValue("--gcd-remaining"))).toBeCloseTo(2.4);
    }

    const renewedCooldown: PlayerCombatState = {
      ...endingCooldown,
      globalCooldownEndsAtTick: 400,
    };
    hotbar.setState(state(renewedCooldown, { serverTick: 250 }));
    expect(buttons.every((button) => button.dataset.cooldownRestarted === "true")).toBe(true);
    expect(buttons.every((button) => button.style.getPropertyValue("--gcd-remaining") === "360deg")).toBe(true);

    hotbar.setState(state(renewedCooldown, { serverTick: 251 }));
    expect(buttons.every((button) => button.dataset.cooldownRestarted === "false")).toBe(true);
    for (const button of buttons) {
      expect(Number.parseFloat(button.style.getPropertyValue("--gcd-remaining"))).toBeCloseTo(357.6);
    }
  });

  it("shows Samurai stamps over slots 1-3 and unlocks the finisher with all three", () => {
    const combat: PlayerCombatState = {
      classId: "samurai",
      buffs: [
        { buffId: "samurai_stamp_1", stacks: 1 },
        { buffId: "samurai_stamp_2", stacks: 1 },
      ],
      globalCooldownEndsAtTick: 0,
    };
    const { hotbar, buttons } = setup(state(combat));
    expect(buttons.map((button) => button.dataset.stamp)).toEqual(["earned", "earned", "missing", "hidden"]);
    expect(buttons.map((button) => button.disabled)).toEqual([false, false, false, true]);
    expect(buttons[3]?.attributes.get("aria-label")).toContain("Requires 3 stamps");

    hotbar.setState(state({
      ...combat,
      buffs: [...combat.buffs, { buffId: "samurai_stamp_3", stacks: 1 }],
    }));
    expect(buttons[3]?.disabled).toBe(false);
    expect(buttons[3]?.dataset.procReady).toBe("true");
  });

  it("marks only unpressed Samurai combo steps as needed", () => {
    const combat = (buffIds: readonly string[]): PlayerCombatState => ({
      classId: "samurai",
      buffs: buffIds.map((buffId) => ({ buffId, stacks: 1 })),
      globalCooldownEndsAtTick: 0,
    });
    const { hotbar, buttons } = setup(state(combat([])));
    expect(buttons.map((button) => button.dataset.comboNeeded)).toEqual(["false", "false", "false", "false"]);

    hotbar.setState(state(combat(["samurai_combo_1"])));
    expect(buttons.map((button) => button.dataset.comboNeeded)).toEqual(["false", "true", "true", "false"]);
    expect(buttons[1]?.attributes.get("aria-label")).toContain("needed to complete combo");

    hotbar.setState(state(combat(["samurai_combo_1", "samurai_combo_2"])));
    expect(buttons.map((button) => button.dataset.comboNeeded)).toEqual(["false", "false", "true", "false"]);

    hotbar.setState(state(combat(["samurai_stamp_3"])));
    expect(buttons.map((button) => button.dataset.comboNeeded)).toEqual(["false", "false", "false", "false"]);
  });
});
