import { afterEach, describe, expect, it, vi } from "vitest";

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
    feedbackDurationMs: 100,
  });
  const root = hotbar.root as unknown as FakeElement;
  return { hotbar, onUse, root, buttons: root.children };
}

afterEach(() => vi.useRealTimers());

describe("AbilityHotbar", () => {
  it("creates exactly four ordered accessible buttons and enables only slot 2 initially", () => {
    const { root, buttons } = setup();
    expect(root.tagName).toBe("nav");
    expect(root.attributes.get("aria-label")).toBe("Abilities");
    expect(buttons).toHaveLength(4);
    expect(buttons.map((button) => button.attributes.get("aria-keyshortcuts"))).toEqual(["1", "2", "3", "4"]);
    expect(buttons.map((button) => button.disabled)).toEqual([true, false, true, true]);
    expect(buttons[1]?.children.map((child) => child.textContent)).toEqual(["2", "Quick Toss", "10 damage", ""]);
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
    expect(buttons.every((button) => button.children[3]?.textContent === "Disconnected")).toBe(true);
    hotbar.setState(state(createInitialCombatState(), { bossAlive: false }));
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(buttons.every((button) => button.children[3]?.textContent === "Boss defeated")).toBe(true);
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

  it("supports temporary feedback and dispose clears timers and click listeners", () => {
    vi.useFakeTimers();
    const { hotbar, onUse, buttons } = setup();
    hotbar.showFeedback(2, true);
    expect(buttons[1]?.dataset.feedback).toBe("accepted");
    vi.advanceTimersByTime(100);
    expect(buttons[1]?.dataset.feedback).toBeUndefined();
    hotbar.showFeedback(2, false);
    expect(buttons[1]?.dataset.feedback).toBe("rejected");
    hotbar.dispose();
    expect(buttons[1]?.dataset.feedback).toBeUndefined();
    buttons[1]?.click();
    expect(onUse).not.toHaveBeenCalled();
    hotbar.setState(state());
    vi.runAllTimers();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disables all Dancer slots and counts down the authoritative global cooldown", () => {
    const combat: PlayerCombatState = {
      classId: "dancer",
      buffs: [{ buffId: "dancer_3_ready", stacks: 1 }],
      globalCooldownEndsAtTick: 250,
    };
    const { hotbar, buttons } = setup(state(combat, { serverTick: 100 }));
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(buttons.every((button) => button.dataset.globalCooldown === "true")).toBe(true);
    expect(buttons.every((button) => button.children[3]?.textContent === "GCD 2.5s")).toBe(true);

    hotbar.setState(state(combat, { serverTick: 249 }));
    expect(buttons.every((button) => button.children[3]?.textContent === "GCD 0.1s")).toBe(true);
    hotbar.setState(state(combat, { serverTick: 250 }));
    expect(buttons.map((button) => button.disabled)).toEqual([true, false, false, true]);
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
    expect(buttons[3]?.children[3]?.textContent).toBe("Requires 3 stamps");

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
