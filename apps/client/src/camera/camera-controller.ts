import { CAMERA_CONSTANTS } from "@four/shared";
import * as THREE from "three";

import type { CameraInputSnapshot } from "../input/index.js";

export interface FeetPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface CameraPlacement {
  readonly position: Readonly<THREE.Vector3>;
  readonly followPoint: Readonly<THREE.Vector3>;
  readonly lookTarget: Readonly<THREE.Vector3>;
  readonly effectiveDistance: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export class CameraController {
  yaw: number = CAMERA_CONSTANTS.initialYaw;
  pitch: number = CAMERA_CONSTANTS.initialPitch;
  requestedDistance: number = CAMERA_CONSTANTS.initialDistance;
  screenPosition: number = CAMERA_CONSTANTS.initialScreenPosition;

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  setScreenPosition(value: number): void {
    const bounded = clamp(value, 0, 1);
    const snapped = Math.round(bounded / CAMERA_CONSTANTS.screenPositionStep)
      * CAMERA_CONSTANTS.screenPositionStep;
    this.screenPosition = clamp(snapped, 0, 1);
  }

  update(feet: Readonly<FeetPosition>, input: Readonly<CameraInputSnapshot>, deltaSeconds: number): CameraPlacement {
    this.yaw -= input.mouseDeltaX * CAMERA_CONSTANTS.mouseOrbitRadiansPerPixel;
    this.pitch += input.mouseDeltaY * CAMERA_CONSTANTS.mouseOrbitRadiansPerPixel;
    this.requestedDistance += input.wheelSteps * CAMERA_CONSTANTS.wheelZoomStep;

    if (input.zoomModifier) {
      this.requestedDistance += input.gamepadRightY
        * CAMERA_CONSTANTS.gamepadZoomMetersPerSecond
        * deltaSeconds;
    } else {
      this.yaw -= input.gamepadRightX
        * CAMERA_CONSTANTS.gamepadOrbitRadiansPerSecond
        * deltaSeconds;
      this.pitch += input.gamepadRightY
        * CAMERA_CONSTANTS.gamepadOrbitRadiansPerSecond
        * deltaSeconds;
    }

    this.pitch = clamp(this.pitch, CAMERA_CONSTANTS.minPitch, CAMERA_CONSTANTS.maxPitch);
    this.requestedDistance = clamp(
      this.requestedDistance,
      CAMERA_CONSTANTS.minDistance,
      CAMERA_CONSTANTS.maxDistance,
    );

    return this.place(feet);
  }

  place(feet: Readonly<FeetPosition>): CameraPlacement {
    const followPoint = new THREE.Vector3(feet.x, feet.y + CAMERA_CONSTANTS.followHeight, feet.z);
    const sinPitch = Math.sin(this.pitch);
    let effectiveDistance = this.requestedDistance;
    if (sinPitch < 0) {
      const maximumFloorSafeDistance = (followPoint.y - CAMERA_CONSTANTS.minHeight) / -sinPitch;
      effectiveDistance = Math.max(
        CAMERA_CONSTANTS.minDistance,
        Math.min(effectiveDistance, maximumFloorSafeDistance),
      );
    }

    const cosPitch = Math.cos(this.pitch);
    const position = new THREE.Vector3(
      followPoint.x + effectiveDistance * Math.sin(this.yaw) * cosPitch,
      followPoint.y + effectiveDistance * sinPitch,
      followPoint.z + effectiveDistance * Math.cos(this.yaw) * cosPitch,
    );
    position.y = Math.max(position.y, CAMERA_CONSTANTS.minHeight);

    const viewDirection = followPoint.clone().sub(position).normalize();
    const cameraRight = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const screenUp = cameraRight.cross(viewDirection).normalize();
    const verticalShift = (0.5 - this.screenPosition)
      * 2
      * effectiveDistance
      * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const lookTarget = followPoint.clone().addScaledVector(screenUp, verticalShift);

    this.camera.position.copy(position);
    this.camera.lookAt(lookTarget);
    return { position, followPoint, lookTarget, effectiveDistance };
  }
}
