import { describe, expect, it, vi } from "vitest";

import { ClassSwitcher } from "./class-switcher.js";

class FakeElement extends EventTarget {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  className = "";
  disabled = false;
  hidden = false;
  textContent = "";
  type = "";

  constructor(readonly tagName: string) { super(); }

  append(...nodes: FakeElement[]): void { this.children.push(...nodes); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  click(): void { this.dispatchEvent(new Event("click")); }
}

class FakeDocument {
  createElement(tagName: string): HTMLElement {
    return new FakeElement(tagName) as unknown as HTMLElement;
  }
}

describe("ClassSwitcher", () => {
  it("lists both classes and sends only a connected non-current selection", () => {
    const onSelect = vi.fn();
    const switcher = new ClassSwitcher({
      classId: "dancer",
      connected: true,
      onSelect,
      documentTarget: new FakeDocument(),
    });
    const root = switcher.root as unknown as FakeElement;
    const [toggle, menu] = root.children;
    expect(toggle?.textContent).toBe("Switch Class");
    toggle?.click();
    expect(menu?.hidden).toBe(false);
    expect(menu?.children.map((choice) => choice.textContent)).toEqual(["Dancer", "Samurai"]);
    expect(menu?.children[0]?.disabled).toBe(true);
    menu?.children[1]?.click();
    expect(onSelect).toHaveBeenCalledWith("samurai");
    expect(menu?.hidden).toBe(true);

    switcher.setState("samurai", false);
    expect(toggle?.disabled).toBe(true);
    expect(menu?.children.every((choice) => choice.disabled)).toBe(true);
  });
});
