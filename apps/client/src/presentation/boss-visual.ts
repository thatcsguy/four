import * as THREE from "three";

import { Nameplate } from "./nameplate.js";

export const BOSS = Object.freeze({ name: "Gloop", health: 500, maxHealth: 500 });

export class BossVisual {
  readonly root = new THREE.Group();

  private readonly body: THREE.Group;
  private readonly nameplate: Nameplate;
  private elapsed = 0;

  constructor() {
    this.root.position.set(0, 0, 0);
    this.body = new THREE.Group();
    this.root.add(this.body);

    const slimeMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x74e45d,
      emissive: 0x1b6b2a,
      emissiveIntensity: 0.18,
      roughness: 0.3,
      transmission: 0.08,
      clearcoat: 0.65,
    });
    const darkMaterial = new THREE.MeshStandardMaterial({ color: 0x10251b, roughness: 0.5 });
    const shineMaterial = new THREE.MeshBasicMaterial({ color: 0xeaffea });

    const core = new THREE.Mesh(new THREE.SphereGeometry(1.72, 32, 20), slimeMaterial);
    core.scale.set(1.15, 0.92, 1.05);
    core.position.y = 1.62;
    core.castShadow = true;
    this.body.add(core);

    for (const [x, z, scale] of [[-1.25, 0.2, 0.72], [1.2, 0.25, 0.76], [-0.65, -1.05, 0.62], [0.75, -1, 0.66]] as const) {
      const lobe = new THREE.Mesh(new THREE.SphereGeometry(0.78, 20, 12), slimeMaterial);
      lobe.scale.set(scale * 1.35, scale * 0.66, scale);
      lobe.position.set(x, 0.58, z);
      lobe.castShadow = true;
      this.body.add(lobe);
    }

    for (const x of [-0.55, 0.55]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 10), darkMaterial);
      eye.position.set(x, 2.05, 1.62);
      eye.scale.y = 1.35;
      this.body.add(eye);
      const glint = new THREE.Mesh(new THREE.SphereGeometry(0.052, 10, 8), shineMaterial);
      glint.position.set(x - 0.045, 2.13, 1.78);
      this.body.add(glint);
    }

    const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.055, 8, 20, Math.PI), darkMaterial);
    mouth.position.set(0, 1.55, 1.72);
    mouth.rotation.z = Math.PI;
    this.body.add(mouth);

    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(2.15, 32),
      new THREE.MeshBasicMaterial({ color: 0x06110d, transparent: true, opacity: 0.42, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.025;
    this.root.add(shadow);

    this.nameplate = new Nameplate(BOSS.name, BOSS.health, BOSS.maxHealth, 4.5);
    this.nameplate.sprite.position.y = 4.3;
    this.root.add(this.nameplate.sprite);
  }

  update(deltaSeconds: number): void {
    this.elapsed += Math.min(Math.max(deltaSeconds, 0), 0.1);
    const pulse = 1 + Math.sin(this.elapsed * 1.8) * 0.025;
    this.body.scale.set(1 / Math.sqrt(pulse), pulse, 1 / Math.sqrt(pulse));
  }

  dispose(): void {
    this.nameplate.dispose();
    this.root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    });
  }
}
