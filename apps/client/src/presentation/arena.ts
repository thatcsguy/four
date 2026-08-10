import { MOVEMENT_CONSTANTS } from "@four/shared";
import * as THREE from "three";

const ARENA_RADIUS = MOVEMENT_CONSTANTS.arenaRadius;

function createAxisArrow(direction: THREE.Vector3, color: number): THREE.ArrowHelper {
  return new THREE.ArrowHelper(direction, new THREE.Vector3(0, 0.045, 0), ARENA_RADIUS - 0.8, color, 0.65, 0.35);
}

export function createArena(): THREE.Group {
  const arena = new THREE.Group();

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(ARENA_RADIUS, 96),
    new THREE.MeshStandardMaterial({ color: 0x13243a, roughness: 0.96, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  arena.add(floor);

  const cues = new THREE.PolarGridHelper(ARENA_RADIUS, 16, 4, 64, 0x4b6b8a, 0x29445f);
  cues.position.y = 0.012;
  arena.add(cues);

  const edge = new THREE.Mesh(
    new THREE.RingGeometry(ARENA_RADIUS - 0.12, ARENA_RADIUS + 0.12, 128),
    new THREE.MeshBasicMaterial({ color: 0x78dce8, side: THREE.DoubleSide }),
  );
  edge.rotation.x = -Math.PI / 2;
  edge.position.y = 0.025;
  arena.add(edge);

  arena.add(
    createAxisArrow(new THREE.Vector3(1, 0, 0), 0xff6b6b),
    createAxisArrow(new THREE.Vector3(-1, 0, 0), 0x7f2942),
    createAxisArrow(new THREE.Vector3(0, 0, 1), 0x60a5fa),
    createAxisArrow(new THREE.Vector3(0, 0, -1), 0x264f85),
  );

  return arena;
}
