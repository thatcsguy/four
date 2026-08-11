import {
  CAMERA_CONSTANTS,
  COMBAT_CONSTANTS,
  type BossState,
  type ProjectileState,
} from "@four/shared";
import * as THREE from "three";

import { createArena } from "./arena.js";
import { CharacterVisual } from "./character-visual.js";
import { BossVisual, DEFAULT_BOSS_STATE } from "./boss-visual.js";
import { ProjectileVisualManager } from "./projectile-visual.js";
import { StatusView, type StatusContent } from "./status-view.js";
import {
  playerColorForIndex,
  selectPlayerColorIndex,
  type PlayerRenderState,
} from "./visual-state.js";

const MAX_PIXEL_RATIO = 2;

export interface RenderFrame {
  readonly deltaSeconds: number;
  readonly nowMilliseconds: number;
}

export type RenderFrameListener = (frame: RenderFrame) => void;

export interface SceneRenderer {
  readonly camera: THREE.PerspectiveCamera;
  upsertPlayer(state: PlayerRenderState): void;
  removePlayer(id: string): void;
  clearPlayers(): void;
  setBossState(boss: Readonly<BossState>): void;
  setProjectiles(
    projectiles: readonly Readonly<ProjectileState>[],
    serverTick: number,
    nowMilliseconds: number,
  ): void;
  clearProjectiles(): void;
  setStatus(content: StatusContent): void;
  onFrame(listener: RenderFrameListener): () => void;
  renderOnce(deltaSeconds?: number): void;
  dispose(): void;
}

export function createSceneRenderer(root: HTMLElement): SceneRenderer {
  root.replaceChildren();
  root.classList.add("game-shell");

  const viewport = document.createElement("div");
  viewport.className = "game-viewport";
  root.append(viewport);

  const status = new StatusView();
  root.append(status.element);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.className = "game-canvas";
  renderer.domElement.setAttribute("aria-label", "Four 3D arena");
  viewport.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07111f);
  scene.fog = new THREE.Fog(0x07111f, 34, 74);
  scene.add(createArena());
  const boss = new BossVisual();
  scene.add(boss.root);
  const projectileVisuals = new ProjectileVisualManager(scene);
  const bossAimPoint = new THREE.Vector3(
    DEFAULT_BOSS_STATE.position.x + COMBAT_CONSTANTS.boss.aimPoint.x,
    DEFAULT_BOSS_STATE.position.y + COMBAT_CONSTANTS.boss.aimPoint.y,
    DEFAULT_BOSS_STATE.position.z + COMBAT_CONSTANTS.boss.aimPoint.z,
  );

  const camera = new THREE.PerspectiveCamera(
    CAMERA_CONSTANTS.verticalFovDegrees,
    1,
    CAMERA_CONSTANTS.nearClip,
    CAMERA_CONSTANTS.farClip,
  );
  camera.position.set(0, 8.54, 13.16);
  camera.lookAt(0, CAMERA_CONSTANTS.followHeight, 0);

  scene.add(new THREE.HemisphereLight(0xcfe9ff, 0x13243a, 1.45));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(-9, 18, 11);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -24;
  sun.shadow.camera.right = 24;
  sun.shadow.camera.top = 24;
  sun.shadow.camera.bottom = -24;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 50;
  scene.add(sun);

  const players = new Map<string, CharacterVisual>();
  const colorIndices = new Map<string, number>();
  const frameListeners = new Set<RenderFrameListener>();
  const clock = new THREE.Clock();
  let animationFrame: number | undefined;
  let disposed = false;
  let lastWidth = 0;
  let lastHeight = 0;
  let lastPixelRatio = 0;

  function resizeIfNeeded(): void {
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    if (width === lastWidth && height === lastHeight && pixelRatio === lastPixelRatio) {
      return;
    }
    lastWidth = width;
    lastHeight = height;
    lastPixelRatio = pixelRatio;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function renderOnce(deltaSeconds = clock.getDelta()): void {
    resizeIfNeeded();
    const frame = { deltaSeconds, nowMilliseconds: performance.now() };
    for (const listener of frameListeners) {
      listener(frame);
    }
    for (const visual of players.values()) {
      visual.update(deltaSeconds);
    }
    boss.update(deltaSeconds);
    projectileVisuals.update(frame.nowMilliseconds, bossAimPoint);
    renderer.render(scene, camera);
  }

  function animate(): void {
    animationFrame = undefined;
    if (disposed || document.hidden) {
      return;
    }
    renderOnce();
    animationFrame = window.requestAnimationFrame(animate);
  }

  function resume(): void {
    if (disposed || document.hidden || animationFrame !== undefined) {
      return;
    }
    clock.start();
    animationFrame = window.requestAnimationFrame(animate);
  }

  function onVisibilityChange(): void {
    if (document.hidden) {
      if (animationFrame !== undefined) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = undefined;
      }
      clock.stop();
      return;
    }
    resume();
  }

  const resizeObserver = new ResizeObserver(() => resizeIfNeeded());
  resizeObserver.observe(viewport);
  document.addEventListener("visibilitychange", onVisibilityChange);
  resizeIfNeeded();
  resume();

  return {
    camera,
    upsertPlayer(state): void {
      let visual = players.get(state.id);
      if (!visual) {
        const occupied = new Set(colorIndices.values());
        const colorIndex = selectPlayerColorIndex(state.id, occupied);
        colorIndices.set(state.id, colorIndex);
        visual = new CharacterVisual(playerColorForIndex(colorIndex), state.isLocal);
        players.set(state.id, visual);
        scene.add(visual.root);
      }
      visual.setState(state);
    },
    removePlayer(id): void {
      const visual = players.get(id);
      if (!visual) {
        return;
      }
      scene.remove(visual.root);
      visual.dispose();
      players.delete(id);
      colorIndices.delete(id);
    },
    clearPlayers(): void {
      for (const [id, visual] of players) {
        scene.remove(visual.root);
        visual.dispose();
        players.delete(id);
      }
      colorIndices.clear();
    },
    setBossState(state): void {
      boss.setState(state);
      bossAimPoint.set(
        state.position.x + COMBAT_CONSTANTS.boss.aimPoint.x,
        state.position.y + COMBAT_CONSTANTS.boss.aimPoint.y,
        state.position.z + COMBAT_CONSTANTS.boss.aimPoint.z,
      );
    },
    setProjectiles(projectiles, serverTick, nowMilliseconds): void {
      projectileVisuals.setProjectiles(projectiles, serverTick, nowMilliseconds);
    },
    clearProjectiles(): void {
      projectileVisuals.clear();
    },
    setStatus(content): void {
      status.set(content);
    },
    onFrame(listener): () => void {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    renderOnce,
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      if (animationFrame !== undefined) {
        window.cancelAnimationFrame(animationFrame);
      }
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      for (const visual of players.values()) {
        visual.dispose();
      }
      projectileVisuals.dispose();
      boss.dispose();
      players.clear();
      colorIndices.clear();
      frameListeners.clear();
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh || object instanceof THREE.Line)) {
          return;
        }
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          material.dispose();
        }
      });
      renderer.dispose();
      root.replaceChildren();
      root.classList.remove("game-shell");
    },
  };
}
