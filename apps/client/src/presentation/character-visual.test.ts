import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";

import { CharacterVisual } from "./character-visual.js";
import type { PlayerRenderState } from "./visual-state.js";

function state(classId: PlayerRenderState["classId"]): PlayerRenderState {
  return {
    id: "local",
    name: "Samurai",
    health: 100,
    maxHealth: 100,
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    grounded: true,
    moving: false,
    isLocal: true,
    classId,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CharacterVisual Samurai attack", () => {
  it("shows the sword only for Samurai and completes a reusable swing", () => {
    vi.stubGlobal("document", {
      createElement: () => ({ width: 0, height: 0, getContext: () => null }),
    });
    const visual = new CharacterVisual(0x2dd4bf, true);
    const sword = visual.root.getObjectByName("samurai-sword");
    const blade = visual.root.getObjectByName("samurai-blade");
    const rightHand = visual.root.getObjectByName("right-hand");
    expect(sword).toBeDefined();
    expect(blade).toBeDefined();
    expect(rightHand).toBeDefined();

    visual.setState(state("dancer"));
    expect(sword?.visible).toBe(false);
    visual.setState(state("samurai"));
    expect(sword?.visible).toBe(true);

    const idleRotation = sword!.rotation.z;
    visual.playAttack();
    visual.update(0.1);
    visual.update(0.1);
    visual.update(0.1);
    expect(sword!.rotation.z).not.toBeCloseTo(idleRotation);
    const handPosition = rightHand!.getWorldPosition(new THREE.Vector3());
    const hiltPosition = sword!.getWorldPosition(new THREE.Vector3());
    expect(hiltPosition.distanceTo(handPosition)).toBeCloseTo(0);
    const bladeDirection = new THREE.Vector3(0, 1, 0).applyQuaternion(
      blade!.getWorldQuaternion(new THREE.Quaternion()),
    );
    expect(Math.abs(bladeDirection.y)).toBeLessThan(0.2);

    for (let frame = 0; frame < 10; frame += 1) visual.update(0.1);
    expect(sword!.rotation.z).toBeCloseTo(idleRotation);

    visual.playAttack();
    visual.update(0.2);
    expect(sword!.rotation.z).not.toBeCloseTo(idleRotation);
    visual.dispose();
  });
});
