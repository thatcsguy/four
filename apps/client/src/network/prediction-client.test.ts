import {
  COMMAND_HZ,
  FIXED_DELTA_SECONDS,
  PROTOCOL_VERSION,
  SIMULATION_HZ,
  SNAPSHOT_HZ,
  createInitialPlayerState,
  decodeClientMessage,
  encodeServerMessage,
  stepPlayer,
  type AuthoritativePlayerState,
  type AbilityResultMessage,
  type AbilityUseMessage,
  type BossState,
  type InputMessage,
  type ProjectileState,
  type ServerMessage,
  type SnapshotMessage,
  type WelcomeMessage,
} from "@four/shared";
import { describe, expect, it } from "vitest";

import { CLIENT_NETCODE_CONFIG } from "../config.js";
import { PredictionClient, type PredictionDiagnostics } from "./prediction-client.js";
import type { ClientTransport } from "./transport.js";

class FakeTransport implements ClientTransport {
  readyState = 0;
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  closeCount = 0;
  failSend = false;

  send(data: string): void {
    if (this.failSend) throw new Error("send failed");
    this.sent.push(data);
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = 3;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  receive(message: ServerMessage): void {
    this.emit("message", { data: encodeServerMessage(message) });
  }

  disconnect(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const initialBoss: BossState = {
  bossId: "gloop",
  name: "Gloop",
  health: 50_000,
  maxHealth: 50_000,
  position: { x: 0, y: 0, z: 0 },
  hitRadius: 1.7,
  stateRevision: 0,
};

const initialProjectile: ProjectileState = {
  projectileId: "projectile-1",
  ownerPlayerId: "local",
  abilityId: "dancer_2",
  targetId: "gloop",
  position: { x: 1, y: 1.2, z: 2 },
  speed: 36,
  damage: 10,
  spawnedAtTick: 60,
};

function welcome(state = createInitialPlayerState({ playerId: "local" }), epoch = "epoch-1"): WelcomeMessage {
  return {
    type: "welcome",
    protocolVersion: PROTOCOL_VERSION,
    playerId: state.playerId,
    epoch,
    rates: { simulationHz: SIMULATION_HZ, commandHz: COMMAND_HZ, snapshotHz: SNAPSHOT_HZ },
    initialServerTick: 60,
    baseline: {
      snapshotSequence: 4,
      serverTick: 60,
      players: [state],
      boss: initialBoss,
      projectiles: [initialProjectile],
    },
  };
}

function snapshot(
  state: AuthoritativePlayerState,
  sequence: number,
  epoch = "epoch-1",
): SnapshotMessage {
  return {
    type: "snapshot",
    protocolVersion: PROTOCOL_VERSION,
    epoch,
    snapshotSequence: sequence,
    serverTick: 60 + sequence,
    players: [state],
    boss: initialBoss,
    projectiles: [initialProjectile],
  };
}

function setup(intent = { moveX: 1, moveZ: 0, jump: false }): {
  client: PredictionClient;
  transport: FakeTransport;
  setNow(value: number): void;
  diagnostics: PredictionDiagnostics[];
} {
  let now = 0;
  const transport = new FakeTransport();
  const diagnostics: PredictionDiagnostics[] = [];
  const client = new PredictionClient({
    url: "ws://test",
    transportFactory: () => transport,
    sampleIntent: () => intent,
    now: () => now,
    autoSchedule: false,
    onDiagnostics: (value) => diagnostics.push(value),
  });
  client.connect();
  transport.open();
  transport.receive(welcome());
  return { client, transport, setNow: (value) => { now = value; }, diagnostics };
}

function sentInputs(transport: FakeTransport): InputMessage[] {
  return transport.sent.flatMap((raw) => {
    const decoded = decodeClientMessage(raw);
    return decoded.success && decoded.data.type === "input" ? [decoded.data] : [];
  });
}

function sentAbilities(transport: FakeTransport): AbilityUseMessage[] {
  return transport.sent.flatMap((raw) => {
    const decoded = decodeClientMessage(raw);
    return decoded.success && decoded.data.type === "ability_use" ? [decoded.data] : [];
  });
}

function abilityResult(
  requestId: number,
  combat: AuthoritativePlayerState["combat"],
  epoch = "epoch-1",
): AbilityResultMessage {
  return {
    type: "ability_result",
    protocolVersion: PROTOCOL_VERSION,
    epoch,
    requestId,
    slot: 2,
    accepted: true,
    reason: "accepted",
    combat,
  };
}

describe("fixed command production", () => {
  it.each([30, 60, 144])("produces 60 commands over one second at %s Hz render sampling", (renderHz) => {
    const { client, transport, setNow } = setup();
    for (let frame = 1; frame <= renderHz; frame += 1) {
      const now = frame * (1_000 / renderHz);
      setNow(now);
      client.advance(now);
    }
    expect(sentInputs(transport)).toHaveLength(60);
    expect(client.predictedState()?.position.x).toBeCloseTo(5, 10);
    client.dispose();
  });

  it("caps catch-up and explicitly suspends hidden-tab production", () => {
    const { client, transport, setNow } = setup();
    setNow(60_000);
    expect(client.advance(60_000)).toBe(CLIENT_NETCODE_CONFIG.maxCatchUpSteps);
    client.setVisible(false);
    setNow(120_000);
    expect(client.advance(120_000)).toBe(0);
    client.setVisible(true);
    expect(sentInputs(transport)).toHaveLength(CLIENT_NETCODE_CONFIG.maxCatchUpSteps);
    client.dispose();
  });
});

describe("snapshot reconciliation", () => {
  it("removes exactly acknowledged commands and replays the stored remainder", () => {
    const { client, transport, setNow } = setup();
    setNow(50);
    client.advance(50);
    const commands = sentInputs(transport);
    expect(commands).toHaveLength(3);
    const initial = welcome().baseline.players[0]!;
    const authoritative = {
      ...stepPlayer(stepPlayer(initial, commands[0]!, FIXED_DELTA_SECONDS), commands[1]!, FIXED_DELTA_SECONDS),
      lastProcessedInputSequence: 2,
    };
    transport.receive(snapshot(authoritative, 5));
    const expected = stepPlayer(authoritative, commands[2]!, FIXED_DELTA_SECONDS);
    expect(client.diagnostics().pendingCount).toBe(1);
    expect(client.diagnostics().lastAcknowledgedSequence).toBe(2);
    expect(client.predictedState()).toEqual(expected);
    client.dispose();
  });

  it("ignores duplicate, old, reordered, and wrong-epoch snapshots", () => {
    const { client, transport } = setup();
    const original = client.predictedState();
    const changed = { ...original!, position: { x: 9, y: 0, z: 0 } };
    transport.receive(snapshot(changed, 4));
    transport.receive(snapshot(changed, 3));
    transport.receive(snapshot(changed, 99, "stale-epoch"));
    expect(client.predictedState()).toEqual(original);
    expect(client.diagnostics().snapshotSequence).toBe(4);
    client.dispose();
  });

  it("restores the complete mid-jump and boundary-affecting state", () => {
    const { client, transport } = setup({ moveX: 0, moveZ: -1, jump: false });
    const authoritative: AuthoritativePlayerState = {
      ...createInitialPlayerState({ playerId: "local" }),
      position: { x: 18.29, y: 1.2, z: 0 },
      grounded: false,
      verticalVelocity: 2.25,
      airborneVelocity: { x: 5, z: 0 },
      facingAngle: 1.1,
      speedModifier: 1.3,
      control: {
        mode: "restricted",
        revision: 7,
        permissions: { allowMove: false, allowLook: true, allowActions: false },
        startedAtTick: 44,
      },
      stateRevision: 0,
      lastProcessedInputSequence: 0,
    };
    transport.receive(snapshot(authoritative, 5));
    expect(client.predictedState()).toEqual(authoritative);
    client.dispose();
  });

  it("eases only presentation for small corrections and snaps large/revision corrections", () => {
    const { client, transport } = setup({ moveX: 0, moveZ: 0, jump: false });
    const base = client.predictedState()!;
    transport.receive(snapshot({ ...base, position: { x: 0.12, y: 0, z: 0 } }, 5));
    expect(client.predictedState()?.position.x).toBeCloseTo(0.12);
    expect(client.renderedState()?.position.x).toBeCloseTo(0);
    client.advancePresentation(CLIENT_NETCODE_CONFIG.visualCorrectionDurationMs / 2);
    expect(client.renderedState()?.position.x).toBeCloseTo(0.06);

    transport.receive(snapshot({ ...base, position: { x: 2, y: 0, z: 0 } }, 6));
    expect(client.renderedState()?.position.x).toBeCloseTo(2);
    transport.receive(snapshot({ ...base, position: { x: 4, y: 0, z: 0 }, stateRevision: 1 }, 7));
    expect(client.renderedState()?.position.x).toBeCloseTo(4);
    expect(client.diagnostics().pendingCount).toBe(0);
    expect(client.diagnostics().correctionCount).toBe(3);
    client.dispose();
  });

  it("clears incompatible inputs on revision change and waits behind an acknowledgement fence", () => {
    const { client, transport, setNow } = setup();
    setNow(20);
    client.advance(20);
    expect(client.diagnostics().pendingCount).toBe(1);
    const reset = { ...createInitialPlayerState({ playerId: "local" }), stateRevision: 1 };
    transport.receive(snapshot(reset, 5));
    expect(client.diagnostics().pendingCount).toBe(0);
    expect(client.renderedState()).toEqual(reset);
    setNow(40);
    expect(client.advance(40)).toBe(0);

    transport.receive(snapshot({ ...reset, lastProcessedInputSequence: 1 }, 6));
    setNow(60);
    expect(client.advance(60)).toBe(1);
    expect(sentInputs(transport).at(-1)?.sequence).toBe(2);
    client.dispose();
  });
});

describe("authoritative combat networking", () => {
  it("sends one ordered ability command without touching movement sequencing", () => {
    const { client, transport } = setup();
    const before = client.diagnostics();

    expect(client.useAbility(2)).toBe(true);
    expect(client.useAbility(3)).toBe(true);

    expect(sentAbilities(transport)).toEqual([
      { type: "ability_use", protocolVersion: PROTOCOL_VERSION, epoch: "epoch-1", requestId: 1, slot: 2 },
      { type: "ability_use", protocolVersion: PROTOCOL_VERSION, epoch: "epoch-1", requestId: 2, slot: 3 },
    ]);
    expect(sentInputs(transport)).toEqual([]);
    expect(client.diagnostics()).toMatchObject({
      pendingCount: before.pendingCount,
      lastSentSequence: before.lastSentSequence,
      lastAcknowledgedSequence: before.lastAcknowledgedSequence,
    });
    client.dispose();
  });

  it("does not send while disconnected, awaiting a baseline, hidden, or disposed", () => {
    const transport = new FakeTransport();
    const client = new PredictionClient({
      url: "ws://test",
      transportFactory: () => transport,
      sampleIntent: () => ({ moveX: 0, moveZ: 0, jump: false }),
      autoSchedule: false,
    });
    expect(client.useAbility(2)).toBe(false);
    client.connect();
    expect(client.useAbility(2)).toBe(false);
    transport.open();
    expect(client.useAbility(2)).toBe(false);
    transport.receive(welcome());
    client.setVisible(false);
    expect(client.useAbility(2)).toBe(false);
    client.setVisible(true);
    client.dispose();
    expect(client.useAbility(2)).toBe(false);
    expect(sentAbilities(transport)).toEqual([]);
  });

  it("accepts baseline combat world state and replaces it only with a newer same-epoch snapshot", () => {
    const { client, transport } = setup();
    expect(client.combatState()).toEqual({
      player: { classId: "dancer", buffs: [], globalCooldownEndsAtTick: 0 },
      boss: initialBoss,
      projectiles: [initialProjectile],
    });

    const player = client.predictedState()!;
    const nextBoss = { ...initialBoss, health: 475, stateRevision: 1 };
    const nextProjectile = { ...initialProjectile, projectileId: "projectile-2", spawnedAtTick: 61 };
    transport.receive({ ...snapshot(player, 5), boss: nextBoss, projectiles: [nextProjectile] });
    expect(client.combatState()).toMatchObject({ boss: nextBoss, projectiles: [nextProjectile] });

    transport.receive({ ...snapshot(player, 5), boss: initialBoss, projectiles: [] });
    transport.receive({ ...snapshot(player, 99, "wrong-epoch"), boss: initialBoss, projectiles: [] });
    expect(client.combatState()).toMatchObject({ boss: nextBoss, projectiles: [nextProjectile] });
    client.dispose();
  });

  it("applies a valid result only to local combat copies and delivers feedback once", () => {
    const transport = new FakeTransport();
    const feedback: AbilityResultMessage[] = [];
    const client = new PredictionClient({
      url: "ws://test",
      transportFactory: () => transport,
      sampleIntent: () => ({ moveX: 0, moveZ: 0, jump: false }),
      autoSchedule: false,
      onAbilityResult: (result) => feedback.push(result),
    });
    client.connect();
    transport.open();
    transport.receive(welcome());
    const before = client.predictedState()!;
    const combat = {
      classId: "dancer" as const,
      buffs: [{ buffId: "dancer_3_ready", stacks: 1 }],
      globalCooldownEndsAtTick: 210,
    };
    expect(client.useAbility(2)).toBe(true);
    const result = abilityResult(1, combat);
    transport.receive(result);
    transport.receive(result);
    transport.receive(abilityResult(1, {
      classId: "dancer",
      buffs: [],
      globalCooldownEndsAtTick: 0,
    }, "wrong-epoch"));

    const after = client.predictedState()!;
    expect({ ...after, combat: before.combat }).toEqual(before);
    expect(after.combat).toEqual(combat);
    expect(client.renderedState()?.combat).toEqual(combat);
    expect(client.latestSnapshotPlayers()[0]?.combat).toEqual(combat);
    expect(feedback).toEqual([result]);
    expect(client.useAbility(3)).toBe(false);
    client.dispose();
  });

  it("uses conservative recovery for an impossible future result", () => {
    const { client, transport } = setup();
    transport.receive(abilityResult(1, {
      classId: "dancer",
      buffs: [],
      globalCooldownEndsAtTick: 0,
    }));
    expect(client.diagnostics()).toMatchObject({ connection: "resyncing", pendingCount: 0 });
    expect(client.combatState()).toEqual({ player: undefined, boss: undefined, projectiles: [] });
    client.dispose();
  });

  it("returns defensive copies of player, boss, and projectile combat state", () => {
    const { client } = setup();
    const first = client.combatState();
    first.player!.buffs.push({ buffId: "mutated", stacks: 1 });
    first.boss!.position.x = 999;
    first.projectiles[0]!.position.y = 999;
    expect(client.combatState()).toEqual({
      player: { classId: "dancer", buffs: [], globalCooldownEndsAtTick: 0 },
      boss: initialBoss,
      projectiles: [initialProjectile],
    });
    client.dispose();
  });
});

describe("bounded recovery and lifecycle", () => {
  it("resyncs without committing prediction or sequence state when an input send fails", () => {
    const { client, transport, setNow } = setup();
    client.advance(0);
    transport.failSend = true;
    setNow(20);

    expect(client.advance(20)).toBe(0);
    expect(client.diagnostics()).toMatchObject({
      connection: "resyncing",
      pendingCount: 0,
      lastSentSequence: 0,
    });
    expect(transport.closeCount).toBe(1);
    client.dispose();
  });

  it("keeps remote lifecycle separate from the exclusively predicted local player", () => {
    const { client, transport, setNow } = setup({ moveX: 0, moveZ: 0, jump: false });
    const local = client.predictedState()!;
    const remote = {
      ...createInitialPlayerState({ playerId: "remote" }),
      position: { x: 4, y: 0, z: 0 },
    };
    setNow(100);
    transport.receive({
      type: "snapshot",
      protocolVersion: PROTOCOL_VERSION,
      epoch: "epoch-1",
      snapshotSequence: 5,
      serverTick: 63,
      players: [local, remote],
      boss: initialBoss,
      projectiles: [initialProjectile],
    });
    expect([...client.renderedRemoteStates(100).keys()]).toEqual(["remote"]);
    expect(client.renderedRemoteStates(100).has("local")).toBe(false);
    expect(client.predictedState()).toEqual(local);

    transport.receive({
      type: "snapshot",
      protocolVersion: PROTOCOL_VERSION,
      epoch: "epoch-1",
      snapshotSequence: 6,
      serverTick: 66,
      players: [local],
      boss: initialBoss,
      projectiles: [],
    });
    expect(client.renderedRemoteStates(150).size).toBe(0);
    transport.disconnect();
    expect(client.renderedRemoteStates(200).size).toBe(0);
    client.dispose();
  });

  it("resyncs instead of extending a stalled pending queue", () => {
    const { client, transport, setNow } = setup();
    for (let tick = 1; tick <= 121; tick += 1) {
      const now = tick * (1_000 / 60);
      setNow(now);
      client.advance(now);
      if (client.diagnostics().connection === "resyncing") break;
    }
    expect(client.diagnostics().connection).toBe("resyncing");
    expect(client.diagnostics().pendingCount).toBe(0);
    expect(client.diagnostics().resyncCount).toBe(1);
    expect(transport.closeCount).toBe(1);
    client.dispose();
  });

  it("clears old commands on disconnect and waits for a fresh welcome", () => {
    const transports = [new FakeTransport(), new FakeTransport()];
    const created: FakeTransport[] = [];
    const timeouts: Array<() => void> = [];
    let now = 0;
    const client = new PredictionClient({
      url: "ws://test",
      transportFactory: () => {
        const transport = transports.shift()!;
        created.push(transport);
        return transport;
      },
      sampleIntent: () => ({ moveX: 1, moveZ: 0, jump: false }),
      now: () => now,
      autoSchedule: false,
      setTimeout: (callback) => { timeouts.push(callback); return callback; },
      clearTimeout: () => undefined,
    });
    client.connect();
    const first = created[0]!;
    first.open();
    first.receive(welcome());
    expect(client.useAbility(2)).toBe(true);
    expect(sentAbilities(first)[0]?.requestId).toBe(1);
    now = 20;
    client.advance(now);
    first.disconnect();
    expect(client.predictedState()).toBeUndefined();
    expect(client.combatState()).toEqual({ player: undefined, boss: undefined, projectiles: [] });
    expect(client.diagnostics().pendingCount).toBe(0);
    timeouts.shift()?.();
    const second = created[1]!;
    second.open();
    now = 2_000;
    expect(client.advance(now)).toBe(0);
    second.receive(welcome(createInitialPlayerState({ playerId: "new-local" }), "epoch-2"));
    expect(client.diagnostics().localPlayerId).toBe("new-local");
    expect(client.diagnostics().lastSentSequence).toBe(0);
    expect(client.useAbility(2)).toBe(true);
    expect(sentAbilities(second)[0]?.requestId).toBe(1);
    client.dispose();
  });

  it("updates RTT diagnostics without changing predicted simulation", () => {
    const { client, transport, setNow, diagnostics } = setup();
    const before = client.predictedState();
    client.advance(0);
    const ping = transport.sent.map((raw) => decodeClientMessage(raw)).find(
      (decoded) => decoded.success && decoded.data.type === "ping",
    );
    if (!ping?.success || ping.data.type !== "ping") throw new Error("Expected a ping");
    setNow(42);
    transport.receive({ type: "pong", protocolVersion: PROTOCOL_VERSION, nonce: ping.data.nonce, sentAtMs: ping.data.sentAtMs });
    expect(client.diagnostics().rttMs).toBe(42);
    expect(client.predictedState()).toEqual(before);
    expect(diagnostics.at(-1)?.rttMs).toBe(42);
    client.dispose();
  });

  it("holds a typed server-full terminal state after the server closes", () => {
    const { client, transport } = setup();
    transport.receive({
      type: "server_full",
      protocolVersion: PROTOCOL_VERSION,
      maxPlayers: 4,
      message: "The arena is full",
    });
    transport.disconnect();
    expect(client.diagnostics()).toMatchObject({ connection: "full", detail: "The arena is full" });
    expect(client.predictedState()).toBeUndefined();
    client.dispose();
  });
});
