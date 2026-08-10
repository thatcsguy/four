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
  type InputMessage,
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

function welcome(state = createInitialPlayerState({ playerId: "local" }), epoch = "epoch-1"): WelcomeMessage {
  return {
    type: "welcome",
    protocolVersion: PROTOCOL_VERSION,
    playerId: state.playerId,
    epoch,
    rates: { simulationHz: SIMULATION_HZ, commandHz: COMMAND_HZ, snapshotHz: SNAPSHOT_HZ },
    initialServerTick: 60,
    baseline: { snapshotSequence: 4, serverTick: 60, players: [state] },
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
    now = 20;
    client.advance(now);
    first.disconnect();
    expect(client.predictedState()).toBeUndefined();
    expect(client.diagnostics().pendingCount).toBe(0);
    timeouts.shift()?.();
    const second = created[1]!;
    second.open();
    now = 2_000;
    expect(client.advance(now)).toBe(0);
    second.receive(welcome(createInitialPlayerState({ playerId: "new-local" }), "epoch-2"));
    expect(client.diagnostics().localPlayerId).toBe("new-local");
    expect(client.diagnostics().lastSentSequence).toBe(0);
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
