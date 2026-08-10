import { CAMERA_CONSTANTS } from "@four/shared";
import * as THREE from "three";
import { describe, expect, it } from "vitest";

import type { CameraInputSnapshot } from "../input/index.js";
import { CameraController } from "./camera-controller.js";

const NEUTRAL_INPUT: CameraInputSnapshot = {
  mouseDeltaX: 0,
  mouseDeltaY: 0,
  wheelSteps: 0,
  gamepadRightX: 0,
  gamepadRightY: 0,
  zoomModifier: false,
};

function createController(): CameraController {
  return new CameraController(new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000));
}

describe("camera input", () => {
  it("uses documented mouse signs/sensitivity and clamps pitch", () => {
    const controller = createController();
    controller.update({ x: 0, y: 0, z: 0 }, {
      ...NEUTRAL_INPUT,
      mouseDeltaX: 100,
      mouseDeltaY: 50,
    }, 1);
    expect(controller.yaw).toBeCloseTo(-0.3);
    expect(controller.pitch).toBeCloseTo(0.65);
    controller.update({ x: 0, y: 0, z: 0 }, { ...NEUTRAL_INPUT, mouseDeltaY: 100_000 }, 1);
    expect(controller.pitch).toBe(CAMERA_CONSTANTS.maxPitch);
  });

  it("uses wheel direction steps and clamps requested zoom", () => {
    const controller = createController();
    controller.update({ x: 0, y: 0, z: 0 }, { ...NEUTRAL_INPUT, wheelSteps: -1 }, 0);
    expect(controller.requestedDistance).toBe(13.5);
    controller.update({ x: 0, y: 0, z: 0 }, { ...NEUTRAL_INPUT, wheelSteps: -100 }, 0);
    expect(controller.requestedDistance).toBe(CAMERA_CONSTANTS.minDistance);
    controller.update({ x: 0, y: 0, z: 0 }, { ...NEUTRAL_INPUT, wheelSteps: 100 }, 0);
    expect(controller.requestedDistance).toBe(CAMERA_CONSTANTS.maxDistance);
  });

  it("time-scales gamepad orbit and makes zoom modifier exclusive", () => {
    const controller = createController();
    controller.update({ x: 0, y: 0, z: 0 }, {
      ...NEUTRAL_INPUT,
      gamepadRightX: 1,
      gamepadRightY: -0.5,
    }, 0.4);
    expect(controller.yaw).toBeCloseTo(-1);
    expect(controller.pitch).toBeCloseTo(0);

    controller.update({ x: 0, y: 0, z: 0 }, {
      ...NEUTRAL_INPUT,
      gamepadRightX: 1,
      gamepadRightY: -1,
      zoomModifier: true,
    }, 0.2);
    expect(controller.yaw).toBeCloseTo(-1);
    expect(controller.pitch).toBeCloseTo(0);
    expect(controller.requestedDistance).toBeCloseTo(12);
  });
});

describe("camera placement", () => {
  it("uses the spherical formula and follows feet through a jump", () => {
    const controller = createController();
    controller.yaw = Math.PI / 2;
    controller.pitch = 0;
    controller.requestedDistance = 10;
    const ground = controller.place({ x: 2, y: 0, z: 3 });
    expect(ground.position.x).toBeCloseTo(12);
    expect(ground.position.y).toBeCloseTo(1.35);
    expect(ground.position.z).toBeCloseTo(3);
    const airborne = controller.place({ x: 2, y: 1.6, z: 3 });
    expect(airborne.position.y - ground.position.y).toBeCloseTo(1.6);
    expect(airborne.followPoint.y).toBeCloseTo(2.95);
  });

  it("temporarily shortens for the floor without changing requested zoom", () => {
    const controller = createController();
    controller.pitch = -Math.PI / 6;
    controller.requestedDistance = 15;
    const protectedPlacement = controller.place({ x: 0, y: 0, z: 0 });
    expect(protectedPlacement.effectiveDistance).toBe(CAMERA_CONSTANTS.minDistance);
    expect(protectedPlacement.position.y).toBe(CAMERA_CONSTANTS.minHeight);
    expect(controller.requestedDistance).toBe(15);

    controller.pitch = 0.25;
    const restored = controller.place({ x: 0, y: 0, z: 0 });
    expect(restored.effectiveDistance).toBe(15);
    expect(controller.requestedDistance).toBe(15);
  });

  it("shortens to a floor-safe distance above the minimum when possible", () => {
    const controller = createController();
    controller.pitch = -0.1;
    controller.requestedDistance = 15;
    const placement = controller.place({ x: 0, y: 0, z: 0 });
    expect(placement.effectiveDistance).toBeCloseTo(
      (CAMERA_CONSTANTS.followHeight - CAMERA_CONSTANTS.minHeight) / -Math.sin(-0.1),
    );
    expect(placement.position.y).toBeCloseTo(CAMERA_CONSTANTS.minHeight);
  });

  it("projects screen position along screen-up at multiple zooms", () => {
    for (const distance of [3, 15, 21]) {
      const controller = createController();
      controller.pitch = 0.3;
      controller.requestedDistance = distance;
      controller.setScreenPosition(0.5);
      const centered = controller.place({ x: 0, y: 0, z: 0 });
      expect(centered.lookTarget.distanceTo(centered.followPoint)).toBeCloseTo(0);

      controller.setScreenPosition(0);
      const bottom = controller.place({ x: 0, y: 0, z: 0 });
      const expectedShift = distance * Math.tan(Math.PI / 6);
      expect(bottom.lookTarget.distanceTo(bottom.followPoint)).toBeCloseTo(expectedShift);
      expect(bottom.lookTarget.y).toBeGreaterThan(bottom.followPoint.y);

      controller.setScreenPosition(1);
      const top = controller.place({ x: 0, y: 0, z: 0 });
      expect(top.lookTarget.distanceTo(top.followPoint)).toBeCloseTo(expectedShift);
      expect(top.lookTarget.y).toBeLessThan(top.followPoint.y);
    }
  });

  it("snaps screen position to bounded 0.05 increments", () => {
    const controller = createController();
    controller.setScreenPosition(0.526);
    expect(controller.screenPosition).toBeCloseTo(0.55);
    controller.setScreenPosition(-10);
    expect(controller.screenPosition).toBe(0);
    controller.setScreenPosition(10);
    expect(controller.screenPosition).toBe(1);
  });
});
