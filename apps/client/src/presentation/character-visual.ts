import { MOVEMENT_CONSTANTS, PRESENTATION_CONSTANTS } from "@four/shared";
import * as THREE from "three";

import type { PlayerRenderState } from "./visual-state.js";
import { Nameplate } from "./nameplate.js";

const SHADOW_COLOR = 0x07111f;
const ATTACK_DURATION_SECONDS = 0.68;

function smoothstep(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

function segment(progress: number, start: number, end: number): number {
  return smoothstep((progress - start) / (end - start));
}

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
  private readonly upperBody = new THREE.Group();
  private readonly rightHand = new THREE.Group();
  private readonly sword = new THREE.Group();
  private phase = 0;
  private moving = false;
  private isSamurai = false;
  private attackElapsed = ATTACK_DURATION_SECONDS;

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
    this.upperBody.add(torso);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 16, 10), bodyMaterial);
    head.position.y = 1.62;
    head.castShadow = true;
    this.upperBody.add(head);

    const facingMarker = new THREE.Mesh(new THREE.ConeGeometry(0.105, 0.3, 6), faceMaterial);
    facingMarker.rotation.x = Math.PI / 2;
    facingMarker.position.set(0, 1.6, 0.28);
    facingMarker.castShadow = true;
    this.upperBody.add(facingMarker);

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
    this.rightHand.name = "right-hand";
    this.rightHand.position.y = -armLength;
    rightArm.add(this.rightHand);
    leftLeg.position.set(-0.15, 0.75, 0);
    rightLeg.position.set(0.15, 0.75, 0);
    this.upperBody.add(leftArm, rightArm);
    this.root.add(this.upperBody, leftLeg, rightLeg);
    this.limbs = { leftArm, rightArm, leftLeg, rightLeg };

    this.createSword();

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
    this.isSamurai = state.classId === "samurai";
    this.sword.visible = this.isSamurai;
    if (!this.isSamurai) this.attackElapsed = ATTACK_DURATION_SECONDS;
  }

  playAttack(): void {
    if (this.isSamurai) {
      this.attackElapsed = 0;
    }
  }

  update(deltaSeconds: number): void {
    const safeDelta = Math.min(Math.max(deltaSeconds, 0), 0.1);
    if (this.attackElapsed < ATTACK_DURATION_SECONDS) {
      this.attackElapsed = Math.min(ATTACK_DURATION_SECONDS, this.attackElapsed + safeDelta);
      this.updateAttack(this.attackElapsed / ATTACK_DURATION_SECONDS);
      return;
    }

    this.upperBody.rotation.set(0, 0, 0);
    this.setSwordIdlePose();
    this.limbs.leftArm.rotation.z = 0;
    this.limbs.rightArm.rotation.z = 0;
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

  private createSword(): void {
    this.sword.name = "samurai-sword";
    const steel = new THREE.MeshStandardMaterial({
      color: 0xe7edf5,
      metalness: 0.88,
      roughness: 0.22,
      emissive: 0x26384f,
      emissiveIntensity: 0.16,
    });
    const gripMaterial = new THREE.MeshStandardMaterial({ color: 0x251512, roughness: 0.92 });
    const guardMaterial = new THREE.MeshStandardMaterial({ color: 0xc99a3d, metalness: 0.68, roughness: 0.3 });

    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.075, 1.12, 0.035), steel);
    blade.name = "samurai-blade";
    blade.position.y = 0.69;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.041, 0.18, 4), steel);
    tip.position.y = 1.34;
    tip.rotation.y = Math.PI / 4;
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.043, 0.36, 8), gripMaterial);
    grip.position.y = -0.08;
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.055, 0.08), guardMaterial);
    guard.position.y = 0.12;
    for (const mesh of [blade, tip, grip, guard]) {
      mesh.castShadow = true;
      this.sword.add(mesh);
    }
    this.sword.visible = false;
    this.rightHand.add(this.sword);
    this.setSwordIdlePose();
  }

  private setSwordIdlePose(): void {
    // The sword's origin is its hilt, so parenting it here keeps the grip in the hand.
    this.sword.position.set(0, 0, 0);
    this.sword.rotation.set(-0.12, 0.18, -0.24);
  }

  private updateAttack(progress: number): void {
    const windup = segment(progress, 0, 0.28);
    const slash = segment(progress, 0.28, 0.62);
    const recovery = segment(progress, 0.62, 1);
    const active = (1 - recovery);

    // Keep the blade level and sweep it across the target with the shoulders.
    // The hilt never leaves the right-hand attachment point.
    this.sword.position.set(0, 0, 0);
    this.sword.rotation.set(
      THREE.MathUtils.lerp(Math.PI * Math.max(windup, slash), -0.12, recovery),
      THREE.MathUtils.lerp(-0.16 + 0.32 * slash, 0.18, recovery),
      THREE.MathUtils.lerp(0.08 * slash, -0.24, recovery),
    );

    const gripPose = Math.max(windup, slash) * active;
    this.limbs.leftArm.rotation.set(-1.14 * gripPose, 0, 0.58 * gripPose);
    this.limbs.rightArm.rotation.set(-1.48 * gripPose, 0, -0.3 * gripPose);
    this.upperBody.rotation.y = (-0.68 * windup + 1.32 * slash) * active;
    this.upperBody.rotation.z = -0.035 * slash * active;
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
