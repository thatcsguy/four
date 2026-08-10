import { once } from "node:events";

import {
  FIXED_DELTA_SECONDS,
  MAX_ACTIVE_PLAYERS,
  PROTOCOL_VERSION,
  decodeServerMessage,
  encodeClientMessage,
  type InputMessage,
  type ServerMessage,
  type SnapshotMessage,
  type WelcomeMessage,
} from "@four/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import {
  FIXED_STEP_MS,
  MAX_CATCH_UP_STEPS,
  MAX_INPUT_QUEUE_LENGTH,
  MAX_MESSAGE_BYTES,
  MISSING_INPUT_GRACE_TICKS,
} from "./config.js";
import { GameServer, type ServerLogger } from "./game-server.js";

interface TestClient {
  socket: WebSocket;
  messages: ServerMessage[];
  next<T extends ServerMessage>(predicate: (message: ServerMessage) => message is T): Promise<T>;
  next(predicate?: (message: ServerMessage) => boolean): Promise<ServerMessage>;
}

const silentLogger: ServerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("authoritative WebSocket server", () => {
  let now: number;
  let server: GameServer;
  let url: string;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    now = 10_000;
    server = new GameServer({ autoTick: false, now: () => now, logger: silentLogger });
    url = (await server.start()).url;
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      if (client.socket.readyState === WebSocket.OPEN || client.socket.readyState === WebSocket.CONNECTING) {
        client.socket.close();
      }
    }
    await server.stop();
  });

  function pumpTicks(count: number): void {
    for (let tick = 0; tick < count; tick += 1) {
      now += FIXED_STEP_MS;
      server.pump(now);
    }
  }

  async function connect(): Promise<TestClient> {
    const socket = new WebSocket(url);
    const messages: ServerMessage[] = [];
    const waiters: Array<{
      predicate: (message: ServerMessage) => boolean;
      resolve: (message: ServerMessage) => void;
    }> = [];
    socket.on("message", (raw) => {
      const decoded = decodeServerMessage(raw.toString());
      if (!decoded.success) throw new Error(decoded.error.message);
      messages.push(decoded.data);
      const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(decoded.data));
      if (waiterIndex >= 0) {
        const [waiter] = waiters.splice(waiterIndex, 1);
        waiter?.resolve(decoded.data);
      }
    });
    socket.on("error", () => undefined);
    await once(socket, "open");
    function next<T extends ServerMessage>(predicate: (message: ServerMessage) => message is T): Promise<T>;
    function next(predicate?: (message: ServerMessage) => boolean): Promise<ServerMessage>;
    function next(predicate: (message: ServerMessage) => boolean = () => true): Promise<ServerMessage> {
      const existing = messages.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolvePromise) => waiters.push({ predicate, resolve: resolvePromise }));
    }
    const client: TestClient = {
      socket,
      messages,
      next,
    };
    clients.push(client);
    return client;
  }

  async function welcome(client: TestClient): Promise<WelcomeMessage> {
    return client.next((message): message is WelcomeMessage => message.type === "welcome");
  }

  function input(baseline: WelcomeMessage, sequence: number, overrides: Partial<InputMessage> = {}): InputMessage {
    return {
      type: "input",
      protocolVersion: PROTOCOL_VERSION,
      epoch: baseline.epoch,
      sequence,
      clientTick: sequence,
      moveX: 1,
      moveZ: 0,
      jump: false,
      ...overrides,
    };
  }

  async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for server state");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    }
  }

  it("admits four unique deterministic spawns and rejects a fifth cleanly", async () => {
    const admitted = await Promise.all(Array.from({ length: MAX_ACTIVE_PLAYERS }, () => connect()));
    const welcomes = await Promise.all(admitted.map((client) => welcome(client)));
    expect(new Set(welcomes.map((message) => message.playerId)).size).toBe(MAX_ACTIVE_PLAYERS);
    expect(new Set(welcomes.map((message) => message.epoch)).size).toBe(MAX_ACTIVE_PLAYERS);
    expect(welcomes.at(-1)?.baseline.players).toHaveLength(MAX_ACTIVE_PLAYERS);
    expect(new Set(welcomes.at(-1)?.baseline.players.map((player) => `${player.position.x},${player.position.z}`)).size)
      .toBe(MAX_ACTIVE_PLAYERS);

    const rejected = await connect();
    const full = await rejected.next((message) => message.type === "server_full");
    expect(full).toMatchObject({ type: "server_full", maxPlayers: MAX_ACTIVE_PLAYERS });
    const [code] = await once(rejected.socket, "close") as [number, Buffer];
    expect(code).toBe(1013);
    expect(server.diagnostics().activePlayers).toBe(MAX_ACTIVE_PLAYERS);
  });

  it("simulates one queued command per fixed step and acknowledges represented state", async () => {
    const client = await connect();
    const baseline = await welcome(client);
    client.socket.send(encodeClientMessage(input(baseline, 1)));
    client.socket.send(encodeClientMessage(input(baseline, 2, { moveX: 0, moveZ: 1 })));
    await waitFor(() => server.diagnostics().queueLengths[0] === 2);

    pumpTicks(1);
    expect(server.diagnostics().queueLengths[0]).toBe(1);
    pumpTicks(2);
    const snapshot = await client.next((message): message is SnapshotMessage =>
      message.type === "snapshot" && message.serverTick >= 3);
    const state = snapshot.players.find((player) => player.playerId === baseline.playerId);
    const initialState = baseline.baseline.players.find((player) => player.playerId === baseline.playerId);
    expect(state?.lastProcessedInputSequence).toBe(2);
    expect(state?.position.x).toBeCloseTo((initialState?.position.x ?? 0) + 5 * FIXED_DELTA_SECONDS, 10);
    expect(state?.position.z).toBeCloseTo((initialState?.position.z ?? 0) + 10 * FIXED_DELTA_SECONDS, 10);
    expect(snapshot.epoch).toBe(baseline.epoch);

    client.socket.send(encodeClientMessage({
      type: "ping",
      protocolVersion: PROTOCOL_VERSION,
      nonce: 42,
      sentAtMs: 123.5,
    }));
    await expect(client.next((message) => message.type === "pong" && message.nonce === 42))
      .resolves.toMatchObject({ type: "pong", sentAtMs: 123.5 });
  });

  it("moves four clients independently and sends each a recipient-scoped snapshot", async () => {
    const joined = await Promise.all(Array.from({ length: MAX_ACTIVE_PLAYERS }, () => connect()));
    const welcomes = await Promise.all(joined.map((client) => welcome(client)));
    const intents = [
      { moveX: 1, moveZ: 0 },
      { moveX: 0, moveZ: 1 },
      { moveX: -1, moveZ: 0 },
      { moveX: 0, moveZ: -1 },
    ] as const;
    joined.forEach((client, index) => {
      const baseline = welcomes[index];
      const intentOverride = intents[index];
      if (baseline === undefined || intentOverride === undefined) throw new Error("Missing test fixture");
      client.socket.send(encodeClientMessage(input(baseline, 1, intentOverride)));
    });
    await waitFor(() => server.diagnostics().queueLengths.every((length) => length === 1));
    pumpTicks(3);

    const snapshots = await Promise.all(joined.map((client) => client.next(
      (message): message is SnapshotMessage => message.type === "snapshot" && message.serverTick >= 3,
    )));
    snapshots.forEach((snapshot, index) => {
      expect(snapshot.epoch).toBe(welcomes[index]?.epoch);
      expect(snapshot.players).toHaveLength(MAX_ACTIVE_PLAYERS);
      expect(snapshot.players.every((player) => player.lastProcessedInputSequence === 1)).toBe(true);
    });
    const canonical = snapshots[0]?.players;
    canonical?.forEach((player, index) => {
      const spawn = welcomes[index]?.baseline.players.find((candidate) => candidate.playerId === player.playerId);
      const intentOverride = intents[index];
      if (spawn === undefined || intentOverride === undefined) throw new Error("Missing player fixture");
      expect(player.position.x).toBeCloseTo(spawn.position.x + intentOverride.moveX * 15 * FIXED_DELTA_SECONDS, 10);
      expect(player.position.z).toBeCloseTo(spawn.position.z + intentOverride.moveZ * 15 * FIXED_DELTA_SECONDS, 10);
    });
  });

  it("rejects malformed, wrong-version, wrong-epoch, gaps, duplicates, and transforms locally", async () => {
    const client = await connect();
    const baseline = await welcome(client);
    const invalidPayloads = [
      "{",
      JSON.stringify({ ...input(baseline, 1), protocolVersion: 999 }),
      encodeClientMessage(input(baseline, 1, { epoch: "old-epoch" })),
      encodeClientMessage(input(baseline, 2)),
      JSON.stringify({ ...input(baseline, 1), position: { x: 100, y: 0, z: 100 } }),
      JSON.stringify({ ...input(baseline, 1), moveX: 2 }),
      '{"type":"input","protocolVersion":1,"epoch":"x","sequence":1,"clientTick":1,"moveX":NaN,"moveZ":0,"jump":false}',
    ];
    for (const payload of invalidPayloads) client.socket.send(payload);
    await waitFor(() => client.messages.filter((message) => message.type === "protocol_error").length >= invalidPayloads.length);
    expect(client.messages).toContainEqual(expect.objectContaining({ type: "protocol_error", code: "wrong_version" }));

    client.socket.send(encodeClientMessage(input(baseline, 1)));
    await waitFor(() => server.diagnostics().queueLengths[0] === 1);
    client.socket.send(encodeClientMessage(input(baseline, 1)));
    await waitFor(() => client.messages.filter((message) => message.type === "protocol_error").length > invalidPayloads.length);
    expect(server.diagnostics().queueLengths[0]).toBe(1);
  });

  it("bounds per-client traffic and queues, and closes oversized traffic", async () => {
    const client = await connect();
    const baseline = await welcome(client);
    for (let sequence = 1; sequence <= MAX_INPUT_QUEUE_LENGTH; sequence += 1) {
      client.socket.send(encodeClientMessage(input(baseline, sequence)));
    }
    await waitFor(() => server.diagnostics().queueLengths[0] === MAX_INPUT_QUEUE_LENGTH);
    client.socket.send(encodeClientMessage(input(baseline, MAX_INPUT_QUEUE_LENGTH + 1)));
    await expect(client.next((message) => message.type === "protocol_error" && message.code === "rate_limited"))
      .resolves.toMatchObject({ type: "protocol_error", code: "rate_limited" });
    expect(server.diagnostics().queueLengths[0]).toBeLessThanOrEqual(MAX_INPUT_QUEUE_LENGTH);

    const oversized = await connect();
    await welcome(oversized);
    oversized.socket.send("x".repeat(MAX_MESSAGE_BYTES + 1));
    const [closeCode] = await once(oversized.socket, "close") as [number, Buffer];
    expect(closeCode).toBe(1009);
  });

  it("repeats missing held input briefly, then becomes neutral", async () => {
    const client = await connect();
    const baseline = await welcome(client);
    client.socket.send(encodeClientMessage(input(baseline, 1)));
    await waitFor(() => server.diagnostics().queueLengths[0] === 1);
    pumpTicks(1 + MISSING_INPUT_GRACE_TICKS + 2);
    const snapshot = await client.next((message): message is SnapshotMessage =>
      message.type === "snapshot" && message.serverTick >= 1 + MISSING_INPUT_GRACE_TICKS + 2);
    const player = snapshot.players.find((state) => state.playerId === baseline.playerId);
    expect(player?.position.x).toBeCloseTo(
      (baseline.baseline.players[0]?.position.x ?? 0)
        + 5 * FIXED_DELTA_SECONDS * (1 + MISSING_INPUT_GRACE_TICKS),
      10,
    );
  });

  it("caps catch-up work after a stall", async () => {
    const client = await connect();
    await welcome(client);
    now += 60_000;
    expect(server.pump(now)).toBe(MAX_CATCH_UP_STEPS);
    expect(server.diagnostics()).toMatchObject({ serverTick: MAX_CATCH_UP_STEPS, lastPumpSteps: MAX_CATCH_UP_STEPS });
    expect(server.pump(now)).toBe(0);
  });

  it("increments snapshots and removes disconnected players from the next one", async () => {
    const first = await connect();
    const firstWelcome = await welcome(first);
    const second = await connect();
    const secondWelcome = await welcome(second);
    pumpTicks(3);
    const before = await first.next((message): message is SnapshotMessage => message.type === "snapshot");
    expect(before.players).toHaveLength(2);

    second.socket.close();
    await waitFor(() => server.diagnostics().activePlayers === 1);
    pumpTicks(3);
    const after = await first.next((message): message is SnapshotMessage =>
      message.type === "snapshot" && message.snapshotSequence > before.snapshotSequence);
    expect(after.serverTick).toBeGreaterThan(before.serverTick);
    expect(after.snapshotSequence).toBeGreaterThan(before.snapshotSequence);
    expect(after.players.map((player) => player.playerId)).toEqual([firstWelcome.playerId]);
    expect(after.players.some((player) => player.playerId === secondWelcome.playerId)).toBe(false);
  });

  it("gives a refresh a fresh epoch and rejects commands from the old one", async () => {
    const original = await connect();
    const oldWelcome = await welcome(original);
    original.socket.close();
    await waitFor(() => server.diagnostics().activePlayers === 0);

    const refreshed = await connect();
    const newWelcome = await welcome(refreshed);
    expect(newWelcome.epoch).not.toBe(oldWelcome.epoch);
    refreshed.socket.send(encodeClientMessage(input(newWelcome, 1, { epoch: oldWelcome.epoch })));
    await expect(refreshed.next((message) => message.type === "protocol_error"))
      .resolves.toMatchObject({ type: "protocol_error", code: "invalid_message" });
    pumpTicks(3);
    const snapshot = await refreshed.next((message): message is SnapshotMessage => message.type === "snapshot");
    const player = snapshot.players.find((state) => state.playerId === newWelcome.playerId);
    expect(player?.lastProcessedInputSequence).toBe(0);
    expect(player?.position).toEqual(newWelcome.baseline.players[0]?.position);
  });
});
