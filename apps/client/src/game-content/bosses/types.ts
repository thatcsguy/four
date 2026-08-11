import type { BossState } from "@four/shared";
import type * as THREE from "three";

export interface BossVisualHandle {
  readonly root: THREE.Object3D;
  setState(state: Readonly<BossState>): void;
  update(deltaSeconds: number): void;
  dispose(): void;
}
