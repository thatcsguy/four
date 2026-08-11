import { type AbilityId, type ProjectileState } from "@four/shared";
import * as THREE from "three";

import { getProjectileStyle } from "../game-content/player-classes/registry.js";

const MAX_RENDER_DELTA_SECONDS = 0.1;
const EPSILON = 1e-9;

export interface ProjectileStyle {
  readonly color: number;
  readonly emissive: number;
  readonly radius: number;
  readonly opacity: number;
}

export interface Vector3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface MutableVector3Like {
  x: number;
  y: number;
  z: number;
}

export function projectileStyleForAbility(abilityId: AbilityId): ProjectileStyle {
  return getProjectileStyle(abilityId);
}

/** Advances toward a target without overshoot, returning the unchanged position for unsafe deltas. */
export function extrapolateToward(
  position: Vector3Like,
  target: Vector3Like,
  speed: number,
  deltaSeconds: number,
  output: MutableVector3Like = { x: position.x, y: position.y, z: position.z },
): Vector3Like {
  if (
    !Number.isFinite(deltaSeconds)
    || !Number.isFinite(speed)
    || speed <= 0
    || deltaSeconds <= 0
  ) {
    output.x = position.x;
    output.y = position.y;
    output.z = position.z;
    return output;
  }
  const dx = target.x - position.x;
  const dy = target.y - position.y;
  const dz = target.z - position.z;
  const distance = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(distance) || distance <= EPSILON) {
    output.x = position.x;
    output.y = position.y;
    output.z = position.z;
    return output;
  }
  const travel = Math.min(distance, speed * Math.min(deltaSeconds, MAX_RENDER_DELTA_SECONDS));
  const scale = travel / distance;
  output.x = position.x + dx * scale;
  output.y = position.y + dy * scale;
  output.z = position.z + dz * scale;
  return output;
}

export class ProjectileVisual {
  readonly root = new THREE.Group();

  private readonly geometry: THREE.CircleGeometry;
  private readonly material: THREE.MeshStandardMaterial;
  private speed: number;
  private latestServerTick: number;
  private disposed = false;

  constructor(readonly projectileId: string, state: Readonly<ProjectileState>, serverTick: number) {
    const style = projectileStyleForAbility(state.abilityId);
    this.geometry = new THREE.CircleGeometry(style.radius, 8);
    this.material = new THREE.MeshStandardMaterial({
      color: style.color,
      emissive: style.emissive,
      emissiveIntensity: 1.1,
      opacity: style.opacity,
      transparent: style.opacity < 1,
      roughness: 0.35,
      side: THREE.DoubleSide,
    });
    const disc = new THREE.Mesh(this.geometry, this.material);
    disc.rotation.z = Math.PI / 8;
    this.root.add(disc);
    this.speed = state.speed;
    this.latestServerTick = serverTick;
    this.root.position.set(state.position.x, state.position.y, state.position.z);
  }

  setAuthoritativeState(state: Readonly<ProjectileState>, serverTick: number): void {
    if (this.disposed || serverTick <= this.latestServerTick) {
      return;
    }
    this.latestServerTick = serverTick;
    this.speed = state.speed;
    this.root.position.set(state.position.x, state.position.y, state.position.z);
  }

  extrapolate(target: Vector3Like, deltaSeconds: number): void {
    if (this.disposed) {
      return;
    }
    const next = extrapolateToward(
      this.root.position,
      target,
      this.speed,
      deltaSeconds,
      this.root.position,
    );
    const targetDistanceSquared = (target.x - next.x) ** 2
      + (target.y - next.y) ** 2
      + (target.z - next.z) ** 2;
    if (targetDistanceSquared > EPSILON) {
      this.root.lookAt(target.x, target.y, target.z);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.geometry.dispose();
    this.material.dispose();
  }
}

export interface ProjectileVisualHandle {
  readonly root: THREE.Object3D;
  setAuthoritativeState(state: Readonly<ProjectileState>, serverTick: number): void;
  extrapolate(target: Vector3Like, deltaSeconds: number): void;
  dispose(): void;
}

export type ProjectileVisualFactory = (
  state: Readonly<ProjectileState>,
  serverTick: number,
) => ProjectileVisualHandle;

export class ProjectileVisualManager {
  private readonly visuals = new Map<string, ProjectileVisualHandle>();
  private latestServerTick = -1;
  private lastUpdateMilliseconds: number | undefined;
  private disposed = false;

  constructor(
    private readonly parent: THREE.Object3D,
    private readonly createVisual: ProjectileVisualFactory = (state, tick) => (
      new ProjectileVisual(state.projectileId, state, tick)
    ),
  ) {}

  setProjectiles(
    projectiles: readonly Readonly<ProjectileState>[],
    serverTick: number,
    nowMilliseconds: number,
  ): void {
    if (this.disposed || serverTick < this.latestServerTick) {
      return;
    }
    const isNewerSnapshot = serverTick > this.latestServerTick;
    const incomingIds = new Set(projectiles.map((projectile) => projectile.projectileId));
    for (const [id, visual] of this.visuals) {
      if (!incomingIds.has(id)) {
        this.parent.remove(visual.root);
        visual.dispose();
        this.visuals.delete(id);
      }
    }
    for (const projectile of projectiles) {
      let visual = this.visuals.get(projectile.projectileId);
      if (visual === undefined) {
        visual = this.createVisual(projectile, serverTick);
        this.visuals.set(projectile.projectileId, visual);
        this.parent.add(visual.root);
      } else if (isNewerSnapshot) {
        visual.setAuthoritativeState(projectile, serverTick);
      }
    }
    if (isNewerSnapshot) {
      this.latestServerTick = serverTick;
      this.lastUpdateMilliseconds = Number.isFinite(nowMilliseconds) ? nowMilliseconds : undefined;
    }
  }

  clear(): void {
    if (this.disposed) {
      return;
    }
    for (const visual of this.visuals.values()) {
      this.parent.remove(visual.root);
      visual.dispose();
    }
    this.visuals.clear();
    this.latestServerTick = -1;
    this.lastUpdateMilliseconds = undefined;
  }

  update(nowMilliseconds: number, target: Vector3Like): void {
    if (this.disposed || !Number.isFinite(nowMilliseconds)) {
      return;
    }
    const previous = this.lastUpdateMilliseconds;
    this.lastUpdateMilliseconds = nowMilliseconds;
    if (previous === undefined) {
      return;
    }
    const deltaSeconds = (nowMilliseconds - previous) / 1_000;
    for (const visual of this.visuals.values()) {
      visual.extrapolate(target, deltaSeconds);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const visual of this.visuals.values()) {
      this.parent.remove(visual.root);
      visual.dispose();
    }
    this.visuals.clear();
  }
}
