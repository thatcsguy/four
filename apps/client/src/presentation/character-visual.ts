import { MOVEMENT_CONSTANTS, PRESENTATION_CONSTANTS } from "@four/shared";
import * as THREE from "three";

import type { PlayerRenderState } from "./visual-state.js";
import { Nameplate } from "./nameplate.js";

const SHADOW_COLOR = 0x07111f;

interface LimbSet {
  readonly leftArm: THREE.Group;
  readonly rightArm: THREE.Group;
  readonly leftLeg: THREE.Group;
  readonly rightLeg: THREE.Group;
}

function createLimb(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  length: number,
): THREE.Group {
  const pivot = new THREE.Group();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = -length / 2;
  mesh.castShadow = true;
  pivot.add(mesh);
  return pivot;
}

export class CharacterVisual {
  readonly root = new THREE.Group();

  private readonly limbs: LimbSet;
  private readonly localMarker: THREE.Mesh;
  private readonly shadow: THREE.Mesh;
  private readonly nameplate: Nameplate;
  private phase = 0;
  private moving = false;

  constructor(color: number, isLocal: boolean) {
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: isLocal ? 0.12 : 0.025,
      roughness: 0.72,
    });
    const darkMaterial = new THREE.MeshStandardMaterial({ color: SHADOW_COLOR, roughness: 0.8 });
    const faceMaterial = new THREE.MeshStandardMaterial({
      color: isLocal ? 0xe0ffff : 0xffffff,
      emissive: isLocal ? 0x2dd4bf : 0x000000,
      emissiveIntensity: isLocal ? 0.45 : 0,
    });

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.29, 0.52, 4, 8), bodyMaterial);
    torso.position.y = 1.12;
    torso.castShadow = true;
    this.root.add(torso);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 16, 10), bodyMaterial);
    head.position.y = 1.62;
    head.castShadow = true;
    this.root.add(head);

    const facingMarker = new THREE.Mesh(new THREE.ConeGeometry(0.105, 0.3, 6), faceMaterial);
    facingMarker.rotation.x = Math.PI / 2;
    facingMarker.position.set(0, 1.6, 0.28);
    facingMarker.castShadow = true;
    this.root.add(facingMarker);

    const armLength = 0.68;
    const legLength = 0.72;
    const armGeometry = new THREE.CapsuleGeometry(0.085, armLength - 0.17, 3, 6);
    const legGeometry = new THREE.CapsuleGeometry(0.105, legLength - 0.21, 3, 6);
    const leftArm = createLimb(armGeometry, bodyMaterial, armLength);
    const rightArm = createLimb(armGeometry, bodyMaterial, armLength);
    const leftLeg = createLimb(legGeometry, darkMaterial, legLength);
    const rightLeg = createLimb(legGeometry, darkMaterial, legLength);
    leftArm.position.set(-0.35, 1.4, 0);
    rightArm.position.set(0.35, 1.4, 0);
    leftLeg.position.set(-0.15, 0.75, 0);
    rightLeg.position.set(0.15, 0.75, 0);
    this.root.add(leftArm, rightArm, leftLeg, rightLeg);
    this.limbs = { leftArm, rightArm, leftLeg, rightLeg };

    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(MOVEMENT_CONSTANTS.playerRadius * 1.05, 24),
      new THREE.MeshBasicMaterial({ color: SHADOW_COLOR, transparent: true, opacity: 0.28, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.018;
    this.root.add(this.shadow);

    this.localMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.46, 0.53, 32),
      new THREE.MeshBasicMaterial({
        color: 0xd9ffff,
        transparent: true,
        opacity: isLocal ? 0.95 : 0,
        side: THREE.DoubleSide,
      }),
    );
    this.localMarker.rotation.x = -Math.PI / 2;
    this.localMarker.position.y = 0.024;
    this.localMarker.visible = isLocal;
    this.root.add(this.localMarker);

    this.nameplate = new Nameplate("Player", 100, 100);
    this.nameplate.sprite.position.y = 2.35;
    this.root.add(this.nameplate.sprite);
  }

  setState(state: PlayerRenderState): void {
    this.root.position.set(state.position.x, state.position.y, state.position.z);
    this.root.rotation.y = state.facing;
    this.moving = state.moving;
    this.shadow.visible = state.grounded;
    this.localMarker.visible = state.isLocal && state.grounded;
    this.nameplate.set(state.name, state.health, state.maxHealth);
  }

  update(deltaSeconds: number): void {
    const safeDelta = Math.min(Math.max(deltaSeconds, 0), 0.1);
    if (this.moving) {
      this.phase = (this.phase + PRESENTATION_CONSTANTS.walkPhaseRate * safeDelta) % (Math.PI * 2);
      const swing = Math.sin(this.phase) * PRESENTATION_CONSTANTS.walkSwingAmplitude;
      this.limbs.leftArm.rotation.x = swing;
      this.limbs.rightArm.rotation.x = -swing;
      this.limbs.leftLeg.rotation.x = -swing;
      this.limbs.rightLeg.rotation.x = swing;
      return;
    }

    const easing = 1 - Math.exp(-PRESENTATION_CONSTANTS.idleReturnRate * safeDelta);
    for (const limb of Object.values(this.limbs)) {
      limb.rotation.x += (0 - limb.rotation.x) * easing;
    }
  }

  dispose(): void {
    this.nameplate.dispose();
    this.root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) {
        return;
      }
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        material.dispose();
      }
    });
  }
}
