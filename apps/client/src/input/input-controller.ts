import { CAMERA_CONSTANTS } from "@four/shared";

export interface MovementIntentSnapshot {
  readonly moveX: number;
  readonly moveZ: number;
  readonly jump: boolean;
}

export interface CameraInputSnapshot {
  readonly mouseDeltaX: number;
  readonly mouseDeltaY: number;
  readonly wheelSteps: number;
  readonly gamepadRightX: number;
  readonly gamepadRightY: number;
  readonly zoomModifier: boolean;
}

interface InputDocument extends EventTarget {
  readonly pointerLockElement: Element | null;
  exitPointerLock?(): void;
}

interface InputCanvas extends EventTarget {
  requestPointerLock?(): Promise<void> | void;
}

export interface InputControllerOptions {
  readonly windowTarget?: EventTarget;
  readonly documentTarget?: InputDocument;
  readonly getGamepads?: () => ArrayLike<Gamepad | null>;
}

interface GamepadState {
  readonly leftX: number;
  readonly leftY: number;
  readonly rightX: number;
  readonly rightY: number;
  readonly zoomModifier: boolean;
  readonly jump: boolean;
}

const NEUTRAL_GAMEPAD: GamepadState = {
  leftX: 0,
  leftY: 0,
  rightX: 0,
  rightY: 0,
  zoomModifier: false,
  jump: false,
};

// Leave a tiny margin inside the protocol's unit circle. Normalizing to exactly
// one can round moveX² + moveZ² above one for some camera yaw values.
const MAX_NORMALIZED_MOVEMENT = 1 - 1e-12;

function activeAxis(value: number): number {
  return Number.isFinite(value) && Math.abs(value) > CAMERA_CONSTANTS.gamepadDeadzone ? value : 0;
}

export function movementBasis(yaw: number): {
  readonly forwardX: number;
  readonly forwardZ: number;
  readonly rightX: number;
  readonly rightZ: number;
} {
  return {
    forwardX: -Math.sin(yaw),
    forwardZ: -Math.cos(yaw),
    rightX: Math.cos(yaw),
    rightZ: -Math.sin(yaw),
  };
}

export function combineMovementSources(
  yaw: number,
  localRight: number,
  localForward: number,
): Pick<MovementIntentSnapshot, "moveX" | "moveZ"> {
  const basis = movementBasis(yaw);
  const x = basis.rightX * localRight + basis.forwardX * localForward;
  const z = basis.rightZ * localRight + basis.forwardZ * localForward;
  const magnitude = Math.hypot(x, z);
  if (magnitude === 0) {
    return { moveX: 0, moveZ: 0 };
  }
  let moveX = x / magnitude;
  let moveZ = z / magnitude;
  const normalizedMagnitudeSquared = moveX ** 2 + moveZ ** 2;
  if (normalizedMagnitudeSquared > 1) {
    const safeScale = MAX_NORMALIZED_MOVEMENT / Math.sqrt(normalizedMagnitudeSquared);
    moveX *= safeScale;
    moveZ *= safeScale;
  }
  return {
    moveX: moveX === 0 ? 0 : moveX,
    moveZ: moveZ === 0 ? 0 : moveZ,
  };
}

export class InputController {
  private readonly heldKeys = new Set<string>();
  private readonly windowTarget: EventTarget;
  private readonly documentTarget: InputDocument;
  private readonly getGamepads: () => ArrayLike<Gamepad | null>;
  private leftMouseHeld = false;
  private rightMouseHeld = false;
  private mouseDeltaX = 0;
  private mouseDeltaY = 0;
  private wheelSteps = 0;
  private disposed = false;

  constructor(
    private readonly canvas: InputCanvas,
    options: InputControllerOptions = {},
  ) {
    this.windowTarget = options.windowTarget ?? window;
    this.documentTarget = options.documentTarget ?? document;
    this.getGamepads = options.getGamepads ?? (() => navigator.getGamepads());

    this.windowTarget.addEventListener("keydown", this.onKeyDown);
    this.windowTarget.addEventListener("keyup", this.onKeyUp);
    this.windowTarget.addEventListener("mouseup", this.onMouseUp);
    this.windowTarget.addEventListener("blur", this.onBlur);
    this.canvas.addEventListener("mousedown", this.onMouseDown);
    this.canvas.addEventListener("contextmenu", this.preventDefault);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.documentTarget.addEventListener("mousemove", this.onMouseMove);
    this.documentTarget.addEventListener("pointerlockchange", this.onPointerLockChange);
  }

  sampleMovement(yaw: number): MovementIntentSnapshot {
    const gamepad = this.pollGamepad();
    let localRight = Number(this.heldKeys.has("KeyD")) - Number(this.heldKeys.has("KeyA"));
    let localForward = Number(this.heldKeys.has("KeyW")) - Number(this.heldKeys.has("KeyS"));
    if (this.leftMouseHeld && this.rightMouseHeld) {
      localForward += 1;
    }

    if (gamepad.leftX !== 0 || gamepad.leftY !== 0) {
      localRight += gamepad.leftX;
      localForward -= gamepad.leftY;
    }

    return {
      ...combineMovementSources(yaw, localRight, localForward),
      jump: this.heldKeys.has("Space") || gamepad.jump,
    };
  }

  consumeCameraInput(): CameraInputSnapshot {
    const gamepad = this.pollGamepad();
    const orbiting = this.leftMouseHeld || this.rightMouseHeld;
    const snapshot: CameraInputSnapshot = {
      mouseDeltaX: orbiting ? this.mouseDeltaX : 0,
      mouseDeltaY: orbiting ? this.mouseDeltaY : 0,
      wheelSteps: this.wheelSteps,
      gamepadRightX: gamepad.rightX,
      gamepadRightY: gamepad.rightY,
      zoomModifier: gamepad.zoomModifier,
    };
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.wheelSteps = 0;
    return snapshot;
  }

  /** Clears held device state when a network epoch or baseline is abandoned. */
  reset(): void {
    this.clearHeldInput();
    this.wheelSteps = 0;
    this.releasePointerLock();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.reset();
    this.windowTarget.removeEventListener("keydown", this.onKeyDown);
    this.windowTarget.removeEventListener("keyup", this.onKeyUp);
    this.windowTarget.removeEventListener("mouseup", this.onMouseUp);
    this.windowTarget.removeEventListener("blur", this.onBlur);
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    this.canvas.removeEventListener("contextmenu", this.preventDefault);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.documentTarget.removeEventListener("mousemove", this.onMouseMove);
    this.documentTarget.removeEventListener("pointerlockchange", this.onPointerLockChange);
    this.releasePointerLock();
  }

  private readonly onKeyDown = (event: Event): void => {
    const code = (event as KeyboardEvent).code;
    if (code === "KeyW" || code === "KeyA" || code === "KeyS" || code === "KeyD" || code === "Space") {
      this.heldKeys.add(code);
      event.preventDefault();
    }
  };

  private readonly onKeyUp = (event: Event): void => {
    this.heldKeys.delete((event as KeyboardEvent).code);
  };

  private readonly onMouseDown = (event: Event): void => {
    const button = (event as MouseEvent).button;
    if (button !== 0 && button !== 2) {
      return;
    }
    event.preventDefault();
    this.leftMouseHeld ||= button === 0;
    this.rightMouseHeld ||= button === 2;
    try {
      const request = this.canvas.requestPointerLock?.();
      if (request) {
        void request.catch(() => undefined);
      }
    } catch {
      // Pointer lock may be denied by browser policy; held-button orbit still works.
    }
  };

  private readonly onMouseUp = (event: Event): void => {
    const button = (event as MouseEvent).button;
    if (button === 0) {
      this.leftMouseHeld = false;
    } else if (button === 2) {
      this.rightMouseHeld = false;
    }
    if (!this.leftMouseHeld && !this.rightMouseHeld) {
      this.mouseDeltaX = 0;
      this.mouseDeltaY = 0;
      this.releasePointerLock();
    }
  };

  private readonly onMouseMove = (event: Event): void => {
    if (!this.leftMouseHeld && !this.rightMouseHeld) {
      return;
    }
    const mouseEvent = event as MouseEvent;
    this.mouseDeltaX += mouseEvent.movementX;
    this.mouseDeltaY += mouseEvent.movementY;
  };

  private readonly onWheel = (event: Event): void => {
    const deltaY = (event as WheelEvent).deltaY;
    event.preventDefault();
    if (deltaY !== 0) {
      this.wheelSteps += Math.sign(deltaY);
    }
  };

  private readonly preventDefault = (event: Event): void => event.preventDefault();

  private readonly onBlur = (): void => this.clearHeldInput();

  private readonly onPointerLockChange = (): void => {
    if (this.documentTarget.pointerLockElement !== this.canvas) {
      this.clearMouseInput();
    }
  };

  private clearHeldInput(): void {
    this.heldKeys.clear();
    this.clearMouseInput();
  }

  private clearMouseInput(): void {
    this.leftMouseHeld = false;
    this.rightMouseHeld = false;
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
  }

  private releasePointerLock(): void {
    if (this.documentTarget.pointerLockElement === this.canvas) {
      try {
        this.documentTarget.exitPointerLock?.();
      } catch {
        // Some browsers restrict programmatic exit; cleanup above is still authoritative.
      }
    }
  }

  private pollGamepad(): GamepadState {
    const gamepads = this.getGamepads();
    for (let index = 0; index < gamepads.length; index += 1) {
      const gamepad = gamepads[index];
      if (!gamepad?.connected || gamepad.mapping !== "standard") {
        continue;
      }
      const rawLeftX = Number.isFinite(gamepad.axes[0]) ? (gamepad.axes[0] ?? 0) : 0;
      const rawLeftY = Number.isFinite(gamepad.axes[1]) ? (gamepad.axes[1] ?? 0) : 0;
      const movementActive = Math.abs(rawLeftX) > CAMERA_CONSTANTS.gamepadDeadzone
        || Math.abs(rawLeftY) > CAMERA_CONSTANTS.gamepadDeadzone;
      return {
        leftX: movementActive ? rawLeftX : 0,
        leftY: movementActive ? rawLeftY : 0,
        rightX: activeAxis(gamepad.axes[2] ?? 0),
        rightY: activeAxis(gamepad.axes[3] ?? 0),
        zoomModifier: gamepad.buttons[4]?.pressed ?? false,
        jump: gamepad.buttons[3]?.pressed ?? false,
      };
    }
    return NEUTRAL_GAMEPAD;
  }
}
