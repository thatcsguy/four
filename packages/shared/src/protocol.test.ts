import { describe, expect, it } from "vitest";

import {
  COMMAND_HZ,
  PROTOCOL_VERSION,
  SIMULATION_HZ,
  SNAPSHOT_HZ,
} from "./constants.js";
import {
  abilityResultMessageSchema,
  abilityUseMessageSchema,
  authoritativePlayerStateSchema,
  bossStateSchema,
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  encodeServerMessage,
  projectileStateSchema,
  type AuthoritativePlayerState,
  type ClientMessage,
  type ServerMessage,
} from "./protocol.js";

const boss = {
  bossId: "gloop",
  name: "Gloop",
  health: 50_000,
  maxHealth: 50_000,
  position: { x: 0, y: 0, z: 0 },
  hitRadius: 1.7,
  stateRevision: 0,
} as const;

const player: AuthoritativePlayerState = {
  playerId: "player-1",
  displayName: "Nova",
  health: 100,
  maxHealth: 100,
  position: { x: 1, y: 0, z: -2 },
  grounded: true,
  verticalVelocity: 0,
  airborneVelocity: { x: 0, z: 0 },
  facingAngle: 0,
  speedModifier: 1,
  combat: { classId: "dancer", buffs: [], globalCooldownEndsAtTick: 0 },
  control: {
    mode: "normal",
    revision: 0,
    permissions: { allowMove: true, allowLook: true, allowActions: true },
    startedAtTick: 0,
  },
  stateRevision: 0,
  lastProcessedInputSequence: 7,
};

describe("protocol round trips", () => {
  it("round-trips valid client messages", () => {
    const messages: ClientMessage[] = [
      {
        type: "input",
        protocolVersion: PROTOCOL_VERSION,
        epoch: "epoch-1",
        sequence: 8,
        clientTick: 12,
        moveX: 0.6,
        moveZ: 0.8,
        jump: true,
      },
      {
        type: "ability_use",
        protocolVersion: PROTOCOL_VERSION,
        epoch: "epoch-1",
        requestId: 1,
        slot: 2,
      },
      {
        type: "ping",
        protocolVersion: PROTOCOL_VERSION,
        nonce: 4,
        sentAtMs: 123.5,
      },
    ];

    for (const message of messages) {
      expect(decodeClientMessage(encodeClientMessage(message))).toEqual({ success: true, data: message });
    }
  });

  it("round-trips valid server messages", () => {
    const messages: ServerMessage[] = [
      {
        type: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        playerId: "player-1",
        epoch: "epoch-1",
        rates: { simulationHz: SIMULATION_HZ, commandHz: COMMAND_HZ, snapshotHz: SNAPSHOT_HZ },
        initialServerTick: 10,
        baseline: {
          snapshotSequence: 1,
          serverTick: 10,
          players: [player],
          boss,
          projectiles: [],
        },
      },
      {
        type: "snapshot",
        protocolVersion: PROTOCOL_VERSION,
        epoch: "epoch-1",
        snapshotSequence: 2,
        serverTick: 13,
        players: [player],
        boss,
        projectiles: [{
          projectileId: "projectile-1",
          ownerPlayerId: "player-1",
          abilityId: "dancer_2",
          targetId: "gloop",
          position: { x: 1, y: 1.2, z: -2 },
          speed: 36,
          damage: 10,
          spawnedAtTick: 12,
        }],
      },
      {
        type: "ability_result",
        protocolVersion: PROTOCOL_VERSION,
        epoch: "epoch-1",
        requestId: 1,
        slot: 2,
        accepted: true,
        reason: "accepted",
        combat: {
          classId: "dancer",
          buffs: [{ buffId: "dancer_3_ready", stacks: 1 }],
          globalCooldownEndsAtTick: 150,
        },
      },
      {
        type: "pong",
        protocolVersion: PROTOCOL_VERSION,
        nonce: 4,
        sentAtMs: 123.5,
      },
      {
        type: "server_full",
        protocolVersion: PROTOCOL_VERSION,
        maxPlayers: 4,
        message: "The arena is full",
      },
      {
        type: "protocol_error",
        protocolVersion: PROTOCOL_VERSION,
        code: "invalid_message",
        message: "Invalid input",
      },
    ];

    for (const message of messages) {
      expect(decodeServerMessage(encodeServerMessage(message))).toEqual({ success: true, data: message });
    }
  });
});

describe("network boundary validation", () => {
  const validInput = {
    type: "input",
    protocolVersion: PROTOCOL_VERSION,
    epoch: "epoch-1",
    sequence: 1,
    clientTick: 1,
    moveX: 0,
    moveZ: 0,
    jump: false,
  };

  it("rejects invalid JSON and unknown message types", () => {
    expect(decodeClientMessage("{" ).success).toBe(false);
    expect(decodeClientMessage(JSON.stringify({ ...validInput, type: "teleport" })).success).toBe(false);
  });

  it("rejects wrong versions and unexpected fields", () => {
    expect(decodeClientMessage(JSON.stringify({ ...validInput, protocolVersion: 999 })).success).toBe(false);
    expect(decodeClientMessage(JSON.stringify({ ...validInput, position: { x: 10 } })).success).toBe(false);
  });

  it("rejects non-finite equivalents and non-finite values before encoding", () => {
    expect(decodeClientMessage(JSON.stringify({ ...validInput, moveX: "NaN" })).success).toBe(false);
    expect(decodeClientMessage('{"type":"input","protocolVersion":1,"epoch":"epoch-1","sequence":1,"clientTick":1,"moveX":Infinity,"moveZ":0,"jump":false}').success).toBe(false);
    expect(() => encodeClientMessage({ ...validInput, moveX: Number.NaN } as ClientMessage)).toThrow();
    expect(() => encodeClientMessage({ ...validInput, moveX: Number.POSITIVE_INFINITY } as ClientMessage)).toThrow();
  });

  it("rejects component and vector magnitude overflow", () => {
    expect(decodeClientMessage(JSON.stringify({ ...validInput, moveX: 1.01 })).success).toBe(false);
    expect(decodeClientMessage(JSON.stringify({ ...validInput, moveX: 0.8, moveZ: 0.8 })).success).toBe(false);
  });

  it("rejects unsafe sequence values", () => {
    expect(decodeClientMessage(JSON.stringify({ ...validInput, sequence: Number.MAX_SAFE_INTEGER + 1 })).success).toBe(false);
    expect(decodeClientMessage(JSON.stringify({ ...validInput, clientTick: -1 })).success).toBe(false);
  });

  it("rejects malformed ability requests and inconsistent results", () => {
    const request = {
      type: "ability_use",
      protocolVersion: PROTOCOL_VERSION,
      epoch: "epoch-1",
      requestId: 1,
      slot: 2,
    };
    expect(abilityUseMessageSchema.safeParse({ ...request, slot: 5 }).success).toBe(false);
    expect(abilityUseMessageSchema.safeParse({ ...request, requestId: 1.5 }).success).toBe(false);
    expect(abilityUseMessageSchema.safeParse({ ...request, requestId: Number.MAX_SAFE_INTEGER + 1 }).success)
      .toBe(false);
    expect(abilityUseMessageSchema.safeParse({ ...request, extra: true }).success).toBe(false);
    expect(abilityResultMessageSchema.safeParse({
      type: "ability_result",
      protocolVersion: PROTOCOL_VERSION,
      epoch: "epoch-1",
      requestId: 1,
      slot: 2,
      accepted: false,
      reason: "accepted",
      combat: player.combat,
    }).success).toBe(false);
  });

  it("rejects malformed combat world state", () => {
    expect(bossStateSchema.safeParse({ ...boss, health: 50_001 }).success).toBe(false);
    expect(bossStateSchema.safeParse({ ...boss, health: Number.NaN }).success).toBe(false);
    expect(bossStateSchema.safeParse({ ...boss, position: { ...boss.position, extra: 1 } }).success)
      .toBe(false);
    const projectile = {
      projectileId: "p-1",
      ownerPlayerId: "player-1",
      abilityId: "dancer_2",
      targetId: "gloop",
      position: { x: 0, y: 1.2, z: 0 },
      speed: 36,
      damage: 10,
      spawnedAtTick: 1,
    };
    expect(projectileStateSchema.safeParse(projectile).success).toBe(true);
    expect(projectileStateSchema.safeParse({ ...projectile, abilityId: "unknown" }).success).toBe(false);
    expect(projectileStateSchema.safeParse({ ...projectile, speed: Number.POSITIVE_INFINITY }).success)
      .toBe(false);
    expect(projectileStateSchema.safeParse({ ...projectile, spawnedAtTick: -1 }).success).toBe(false);

    const snapshotWithoutBoss = {
      type: "snapshot",
      protocolVersion: PROTOCOL_VERSION,
      epoch: "epoch-1",
      snapshotSequence: 1,
      serverTick: 1,
      players: [player],
      projectiles: [],
    };
    expect(decodeServerMessage(JSON.stringify(snapshotWithoutBoss)).success).toBe(false);
    expect(decodeServerMessage(JSON.stringify({
      ...snapshotWithoutBoss,
      boss,
      projectiles: Array.from({ length: 129 }, (_, index) => ({
        ...projectile,
        projectileId: `p-${index}`,
      })),
    })).success).toBe(false);
  });
});

it("serializes every future-affecting player movement field", () => {
  const parsed = authoritativePlayerStateSchema.parse(player);
  expect(Object.keys(parsed).sort()).toEqual([
    "airborneVelocity",
    "combat",
    "control",
    "displayName",
    "facingAngle",
    "grounded",
    "health",
    "lastProcessedInputSequence",
    "maxHealth",
    "playerId",
    "position",
    "speedModifier",
    "stateRevision",
    "verticalVelocity",
  ]);
  expect(JSON.parse(JSON.stringify(parsed))).toEqual(player);
});
