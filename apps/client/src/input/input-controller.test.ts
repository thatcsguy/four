import { describe, expect, it } from "vitest";

import {
  InputController,
  combineMovementSources,
  movementBasis,
} from "./input-controller.js";

class FakeDocument extends EventTarget {
  pointerLockElement: Element | null = null;
  exitCount = 0;

  exitPointerLock(): void {
    this.exitCount += 1;
    this.pointerLockElement = null;
  }
}

class FakeCanvas extends EventTarget {
  lockCount = 0;

  requestPointerLock(): void {
    this.lockCount += 1;
  }
}

function event(type: string, values: Readonly<Record<string, unknown>> = {}): Event {
  const result = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(result, key, { value });
  }
  return result;
}

function gamepad(overrides: {
  axes?: readonly number[];
  pressedButtons?: readonly number[];
  connected?: boolean;
  mapping?: GamepadMappingType;
} = {}): Gamepad {
  const pressed = new Set(overrides.pressedButtons ?? []);
  return {
    axes: overrides.axes ?? [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, (_, index) => ({
      pressed: pressed.has(index),
      touched: pressed.has(index),
      value: pressed.has(index) ? 1 : 0,
    })),
    connected: overrides.connected ?? true,
    mapping: overrides.mapping ?? "standard",
  } as unknown as Gamepad;
}

function setup(getGamepads: () => ArrayLike<Gamepad | null> = () => []): {
  canvas: FakeCanvas;
  documentTarget: FakeDocument;
  windowTarget: EventTarget;
  input: InputController;
} {
  const canvas = new FakeCanvas();
  const documentTarget = new FakeDocument();
  const windowTarget = new EventTarget();
  const input = new InputController(canvas, { documentTarget, windowTarget, getGamepads });
  return { canvas, documentTarget, windowTarget, input };
}

describe("movement input", () => {
  it("builds a yaw-only orthonormal basis", () => {
    expect(movementBasis(0)).toEqual({ forwardX: -0, forwardZ: -1, rightX: 1, rightZ: -0 });
    const quarterTurn = movementBasis(Math.PI / 2);
    expect(quarterTurn.forwardX).toBeCloseTo(-1);
    expect(quarterTurn.forwardZ).toBeCloseTo(0);
    expect(quarterTurn.rightX).toBeCloseTo(0);
    expect(quarterTurn.rightZ).toBeCloseTo(-1);
  });

  it("normalizes combined sources exactly once and supports cancellation", () => {
    expect(combineMovementSources(0, 0, 0)).toEqual({ moveX: 0, moveZ: 0 });
    const diagonal = combineMovementSources(0, 1, 1);
    expect(diagonal.moveX).toBeCloseTo(Math.SQRT1_2);
    expect(diagonal.moveZ).toBeCloseTo(-Math.SQRT1_2);
    expect(combineMovementSources(0, 0, 2)).toEqual({ moveX: 0, moveZ: -1 });
  });

  it("keeps camera-relative movement inside the protocol unit circle after rounding", () => {
    const movement = combineMovementSources(-3.129, 1, 1);
    expect(movement.moveX ** 2 + movement.moveZ ** 2).toBeLessThanOrEqual(1);
  });

  it("combines keyboard, mouse-forward, and gamepad before normalizing", () => {
    const pad = gamepad({ axes: [-0.5, 0.5, 0, 0] });
    const { canvas, windowTarget, input } = setup(() => [pad]);
    windowTarget.dispatchEvent(event("keydown", { code: "KeyD" }));
    canvas.dispatchEvent(event("mousedown", { button: 0 }));
    canvas.dispatchEvent(event("mousedown", { button: 2 }));

    const snapshot = input.sampleMovement(0);
    expect(snapshot.moveX).toBeCloseTo(Math.SQRT1_2);
    expect(snapshot.moveZ).toBeCloseTo(-Math.SQRT1_2);
  });

  it("uses a strict per-axis deadzone and gives any active stick full speed", () => {
    let pad = gamepad({ axes: [0.1, -0.1, 0, 0] });
    const { input } = setup(() => [pad]);
    expect(input.sampleMovement(0)).toMatchObject({ moveX: 0, moveZ: 0 });

    pad = gamepad({ axes: [0.1001, 0, 0, 0] });
    expect(input.sampleMovement(0)).toMatchObject({ moveX: 1, moveZ: 0 });

    pad = gamepad({ axes: [0.05, -0.5, 0, 0] });
    const directional = input.sampleMovement(0);
    expect(directional.moveX).toBeGreaterThan(0);
    expect(Math.hypot(directional.moveX, directional.moveZ)).toBeCloseTo(1);
  });

  it("uses standard top face button for held jump and neutralizes disconnects", () => {
    let pads: ArrayLike<Gamepad | null> = [gamepad({ pressedButtons: [3] })];
    const { input } = setup(() => pads);
    expect(input.sampleMovement(0).jump).toBe(true);
    pads = [gamepad({ axes: [1, 0, 0, 0], pressedButtons: [3], connected: false })];
    expect(input.sampleMovement(0)).toEqual({ moveX: 0, moveZ: 0, jump: false });
  });
});

describe("ability input", () => {
  it("maps top-row digits to ordered, one-shot ability presses", () => {
    const { windowTarget, input } = setup();
    for (const code of ["Digit2", "Digit4", "Digit1", "Digit3"]) {
      const keydown = event("keydown", { code, repeat: false });
      windowTarget.dispatchEvent(keydown);
      expect(keydown.defaultPrevented).toBe(true);
    }
    windowTarget.dispatchEvent(event("keydown", { code: "Numpad2", repeat: false }));
    expect(input.consumeAbilityPresses()).toEqual([2, 4, 1, 3]);
    expect(input.consumeAbilityPresses()).toEqual([]);
  });

  it("suppresses repeats, handled events, and editable targets", () => {
    const { windowTarget, input } = setup();
    windowTarget.dispatchEvent(event("keydown", { code: "Digit1", repeat: true }));
    const handled = event("keydown", { code: "Digit2", repeat: false });
    handled.preventDefault();
    windowTarget.dispatchEvent(handled);
    for (const target of [
      { tagName: "INPUT" },
      { tagName: "textarea" },
      { tagName: "SELECT" },
      { tagName: "div", isContentEditable: true },
    ]) {
      windowTarget.dispatchEvent(event("keydown", { code: "Digit3", repeat: false, target }));
    }
    expect(input.consumeAbilityPresses()).toEqual([]);
  });

  it("caps the queue and reset, blur, and dispose clear it", () => {
    const { windowTarget, input } = setup();
    for (let index = 0; index < 20; index += 1) {
      windowTarget.dispatchEvent(event("keydown", { code: "Digit2", repeat: false }));
    }
    expect(input.consumeAbilityPresses()).toHaveLength(16);

    windowTarget.dispatchEvent(event("keydown", { code: "Digit2", repeat: false }));
    input.reset();
    expect(input.consumeAbilityPresses()).toEqual([]);
    windowTarget.dispatchEvent(event("keydown", { code: "Digit2", repeat: false }));
    windowTarget.dispatchEvent(event("blur"));
    expect(input.consumeAbilityPresses()).toEqual([]);
    windowTarget.dispatchEvent(event("keydown", { code: "Digit2", repeat: false }));
    input.dispose();
    expect(input.consumeAbilityPresses()).toEqual([]);
    windowTarget.dispatchEvent(event("keydown", { code: "Digit2", repeat: false }));
    expect(input.consumeAbilityPresses()).toEqual([]);
  });
});

describe("mouse and camera input lifecycle", () => {
  it("requests and releases pointer lock while keeping either button active", () => {
    const { canvas, documentTarget, windowTarget, input } = setup();
    canvas.dispatchEvent(event("mousedown", { button: 0 }));
    canvas.dispatchEvent(event("mousedown", { button: 2 }));
    expect(canvas.lockCount).toBe(2);
    documentTarget.pointerLockElement = canvas as unknown as Element;
    windowTarget.dispatchEvent(event("mouseup", { button: 0 }));
    expect(documentTarget.exitCount).toBe(0);
    expect(input.sampleMovement(0).moveZ).toBeCloseTo(0);
    windowTarget.dispatchEvent(event("mouseup", { button: 2 }));
    expect(documentTarget.exitCount).toBe(1);
  });

  it("consumes mouse deltas and direction-only wheel steps once", () => {
    const { canvas, documentTarget, input } = setup();
    canvas.dispatchEvent(event("mousedown", { button: 0 }));
    documentTarget.dispatchEvent(event("mousemove", { movementX: 12, movementY: -4 }));
    const wheel = event("wheel", { deltaY: 120 });
    canvas.dispatchEvent(wheel);
    canvas.dispatchEvent(event("wheel", { deltaY: -3 }));
    expect(wheel.defaultPrevented).toBe(true);
    expect(input.consumeCameraInput()).toMatchObject({
      mouseDeltaX: 12,
      mouseDeltaY: -4,
      wheelSteps: 0,
    });
    expect(input.consumeCameraInput()).toMatchObject({ mouseDeltaX: 0, mouseDeltaY: 0, wheelSteps: 0 });
  });

  it("clears held input on blur and pointer-lock loss", () => {
    const { canvas, documentTarget, windowTarget, input } = setup();
    windowTarget.dispatchEvent(event("keydown", { code: "KeyW" }));
    canvas.dispatchEvent(event("mousedown", { button: 0 }));
    canvas.dispatchEvent(event("mousedown", { button: 2 }));
    documentTarget.dispatchEvent(event("mousemove", { movementX: 9, movementY: 3 }));
    windowTarget.dispatchEvent(event("blur"));
    expect(input.sampleMovement(0)).toEqual({ moveX: 0, moveZ: 0, jump: false });
    expect(input.consumeCameraInput().mouseDeltaX).toBe(0);

    canvas.dispatchEvent(event("mousedown", { button: 0 }));
    documentTarget.pointerLockElement = canvas as unknown as Element;
    documentTarget.dispatchEvent(event("pointerlockchange"));
    documentTarget.pointerLockElement = null;
    documentTarget.dispatchEvent(event("pointerlockchange"));
    expect(input.consumeCameraInput().mouseDeltaX).toBe(0);
  });

  it("suppresses context menu and detaches listeners on disposal", () => {
    const { canvas, windowTarget, input } = setup();
    const contextMenu = event("contextmenu");
    canvas.dispatchEvent(contextMenu);
    expect(contextMenu.defaultPrevented).toBe(true);
    input.dispose();
    windowTarget.dispatchEvent(event("keydown", { code: "KeyW" }));
    const afterDispose = event("contextmenu");
    canvas.dispatchEvent(afterDispose);
    expect(afterDispose.defaultPrevented).toBe(false);
    expect(input.sampleMovement(0)).toEqual({ moveX: 0, moveZ: 0, jump: false });
  });
});

describe("gamepad camera controls", () => {
  it("applies deadzones and makes LB zoom exclusive with orbit", () => {
    let pad = gamepad({ axes: [0, 0, 0.1, -0.1] });
    const { input } = setup(() => [pad]);
    expect(input.consumeCameraInput()).toMatchObject({ gamepadRightX: 0, gamepadRightY: 0 });
    pad = gamepad({ axes: [0, 0, 0.7, -0.8], pressedButtons: [4] });
    expect(input.consumeCameraInput()).toMatchObject({
      gamepadRightX: 0.7,
      gamepadRightY: -0.8,
      zoomModifier: true,
    });
  });
});
