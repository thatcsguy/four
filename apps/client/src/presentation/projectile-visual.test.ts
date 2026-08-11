import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";

import type { ProjectileState } from "@four/shared";

import {
  ProjectileVisualManager,
  extrapolateToward,
  projectileStyleForAbility,
  type ProjectileVisualHandle,
} from "./projectile-visual.js";

function projectile(
  projectileId: string,
  x = 0,
  abilityId: ProjectileState["abilityId"] = "dancer_2",
): ProjectileState {
  return {
    projectileId,
    ownerPlayerId: "player-1",
    abilityId,
    targetId: "gloop",
    position: { x, y: 1.2, z: 0 },
    speed: 36,
    damage: abilityId === "dancer_1" || abilityId === "dancer_4" ? 25 : 10,
    spawnedAtTick: 1,
  };
}

describe("projectile presentation math", () => {
  it("moves toward the aim point without overshooting and clamps large frame deltas", () => {
    expect(extrapolateToward({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 10, 0.05)).toEqual({
      x: 0.5,
      y: 0,
      z: 0,
    });
    expect(extrapolateToward({ x: 0, y: 0, z: 0 }, { x: 0.25, y: 0, z: 0 }, 10, 1)).toEqual({
      x: 0.25,
      y: 0,
      z: 0,
    });
    expect(extrapolateToward({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 10, 1).x).toBe(1);
  });

  it("handles zero distance and non-finite or backwards deltas safely", () => {
    const position = { x: 2, y: 3, z: 4 };
    expect(extrapolateToward(position, position, 36, 0.05)).toEqual(position);
    expect(extrapolateToward(position, { x: 0, y: 0, z: 0 }, 36, Number.NaN)).toEqual(position);
    expect(extrapolateToward(position, { x: 0, y: 0, z: 0 }, 36, -1)).toEqual(position);
  });

  it("uses deterministic, stronger styling for slots 1 and 4", () => {
    expect(projectileStyleForAbility("dancer_1")).toEqual(projectileStyleForAbility("dancer_1"));
    expect(projectileStyleForAbility("dancer_1").radius).toBeGreaterThan(
      projectileStyleForAbility("dancer_2").radius,
    );
    expect(projectileStyleForAbility("dancer_4").radius).toBeGreaterThan(
      projectileStyleForAbility("dancer_3").radius,
    );
    expect(projectileStyleForAbility("dancer_1").color).not.toBe(
      projectileStyleForAbility("dancer_4").color,
    );
  });
});

describe("ProjectileVisualManager", () => {
  it("creates, updates, and removes ID-stable visuals without duplicate disposal", () => {
    const parent = new THREE.Group();
    const handles = new Map<string, ProjectileVisualHandle>();
    const factory = vi.fn((state: Readonly<ProjectileState>): ProjectileVisualHandle => {
      const handle = {
        root: new THREE.Group(),
        setAuthoritativeState: vi.fn(),
        extrapolate: vi.fn(),
        dispose: vi.fn(),
      };
      handles.set(state.projectileId, handle);
      return handle;
    });
    const manager = new ProjectileVisualManager(parent, factory);
    manager.setProjectiles([projectile("a"), projectile("b")], 10, 1_000);
    manager.setProjectiles([projectile("a"), projectile("b")], 10, 1_010);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(parent.children).toHaveLength(2);
    expect(handles.get("a")?.setAuthoritativeState).not.toHaveBeenCalled();

    manager.setProjectiles([projectile("a", 4)], 11, 1_050);
    expect(handles.get("a")?.setAuthoritativeState).toHaveBeenCalledOnce();
    expect(handles.get("b")?.dispose).toHaveBeenCalledOnce();
    expect(parent.children).toHaveLength(1);

    manager.dispose();
    manager.dispose();
    expect(handles.get("a")?.dispose).toHaveBeenCalledOnce();
    expect(handles.get("b")?.dispose).toHaveBeenCalledOnce();
    expect(parent.children).toHaveLength(0);
  });

  it("snaps a newer authoritative position over prior extrapolation", () => {
    const parent = new THREE.Group();
    const manager = new ProjectileVisualManager(parent);
    manager.setProjectiles([projectile("a", 0)], 10, 1_000);
    manager.update(1_050, { x: 10, y: 1.2, z: 0 });
    expect(parent.children[0]?.position.x).toBeGreaterThan(0);
    manager.setProjectiles([projectile("a", 3)], 11, 1_060);
    expect(parent.children[0]?.position.x).toBe(3);
    manager.dispose();
  });

  it("clears an abandoned epoch and accepts a fresh lower-tick baseline", () => {
    const parent = new THREE.Group();
    const manager = new ProjectileVisualManager(parent);
    manager.setProjectiles([projectile("old")], 100, 1_000);
    manager.clear();
    expect(parent.children).toHaveLength(0);
    manager.setProjectiles([projectile("fresh")], 1, 1_100);
    expect(parent.children).toHaveLength(1);
    manager.dispose();
  });
});
