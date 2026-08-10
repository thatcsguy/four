import { once } from "node:events";

import {
  MAX_ACTIVE_PLAYERS,
  PROTOCOL_VERSION,
  decodeServerMessage,
  encodeClientMessage,
  type InputMessage,
  type ServerMessage,
  type SnapshotMessage,
  type WelcomeMessage,
} from "@four/shared";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { GameServer, type ServerLogger } from "./game-server.js";

interface SmokeClient {
  readonly socket: WebSocket;
  readonly messages: ServerMessage[];
  waitFor<T extends ServerMessage>(predicate: (message: ServerMessage) => message is T): Promise<T>;
}

async function eventually(condition: () => boolean, detail: string): Promise<void> {
  const deadline = performance.now() + 3_000;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error(`Timed out: ${detail}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("milestone four-client smoke", () => {
  const sockets: WebSocket[] = [];
  let server: GameServer | undefined;

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    }
    await server?.stop();
    server = undefined;
  });

  it("covers capacity, independent authority, malformed isolation, leave/reuse, and refresh", async () => {
    const errors: string[] = [];
    const logger: ServerLogger = {
      info: () => undefined,
      warn: () => undefined,
      error: (message) => errors.push(message),
    };
    server = new GameServer({ autoTick: true, logger });
    const { url } = await server.start();

    const connect = async (): Promise<SmokeClient> => {
      const socket = new WebSocket(url);
      sockets.push(socket);
      const messages: ServerMessage[] = [];
      const waiters: Array<{
        predicate: (message: ServerMessage) => boolean;
        resolve: (message: ServerMessage) => void;
      }> = [];
      socket.on("message", (data) => {
        const decoded = decodeServerMessage(data.toString());
        if (!decoded.success) throw new Error(decoded.error.message);
        messages.push(decoded.data);
        const index = waiters.findIndex(({ predicate }) => predicate(decoded.data));
        if (index >= 0) waiters.splice(index, 1)[0]?.resolve(decoded.data);
      });
      socket.on("error", () => undefined);
      await once(socket, "open");
      return {
        socket,
        messages,
        waitFor<T extends ServerMessage>(predicate: (message: ServerMessage) => message is T): Promise<T> {
          const existing = messages.find(predicate);
          return existing
            ? Promise.resolve(existing as T)
            : new Promise<ServerMessage>((resolve) => waiters.push({ predicate, resolve }))
              .then((message) => message as T);
        },
      };
    };

    const clients = await Promise.all(Array.from({ length: MAX_ACTIVE_PLAYERS }, connect));
    const welcomes = await Promise.all(clients.map((client) => client.waitFor(
      (message): message is WelcomeMessage => message.type === "welcome",
    )));
    expect(new Set(welcomes.map(({ playerId }) => playerId)).size).toBe(MAX_ACTIVE_PLAYERS);

    const fifth = await connect();
    await expect(fifth.waitFor((message) => message.type === "server_full"))
      .resolves.toMatchObject({ type: "server_full", maxPlayers: MAX_ACTIVE_PLAYERS });
    const [fifthCloseCode] = await once(fifth.socket, "close") as [number, Buffer];
    expect(fifthCloseCode).toBe(1013);

    const intents = [
      { moveX: 1, moveZ: 0 },
      { moveX: 0, moveZ: 1 },
      { moveX: -1, moveZ: 0 },
      { moveX: 0, moveZ: -1 },
    ] as const;
    for (let clientIndex = 0; clientIndex < clients.length; clientIndex += 1) {
      const client = clients[clientIndex];
      const welcome = welcomes[clientIndex];
      const intent = intents[clientIndex];
      if (!client || !welcome || !intent) throw new Error("Incomplete smoke fixture");
      for (let sequence = 1; sequence <= 6; sequence += 1) {
        const input: InputMessage = {
          type: "input",
          protocolVersion: PROTOCOL_VERSION,
          epoch: welcome.epoch,
          sequence,
          clientTick: sequence,
          ...intent,
          jump: false,
        };
        client.socket.send(encodeClientMessage(input));
      }
    }
    const authoritative = await Promise.all(clients.map((client) => client.waitFor(
      (message): message is SnapshotMessage => message.type === "snapshot"
        && message.players.length === MAX_ACTIVE_PLAYERS
        && message.players.every((player) => player.lastProcessedInputSequence >= 6),
    )));
    for (const snapshot of authoritative) {
      expect(snapshot.players.map(({ playerId }) => playerId).sort())
        .toEqual(welcomes.map(({ playerId }) => playerId).sort());
    }
    for (let index = 0; index < welcomes.length; index += 1) {
      const welcome = welcomes[index]!;
      const state = authoritative[0]!.players.find(({ playerId }) => playerId === welcome.playerId)!;
      const spawn = welcome.baseline.players.find(({ playerId }) => playerId === welcome.playerId)!;
      const intent = intents[index]!;
      expect((state.position.x - spawn.position.x) * intent.moveX
        + (state.position.z - spawn.position.z) * intent.moveZ).toBeGreaterThan(0);
    }

    clients[0]!.socket.send("{");
    await expect(clients[0]!.waitFor((message) => message.type === "protocol_error"))
      .resolves.toMatchObject({ type: "protocol_error", code: "invalid_json" });
    const survivorSnapshotSequence = authoritative[1]!.snapshotSequence;
    await expect(clients[1]!.waitFor(
      (message): message is SnapshotMessage => message.type === "snapshot"
        && message.snapshotSequence > survivorSnapshotSequence,
    )).resolves.toBeDefined();

    const leaving = clients[2]!;
    const leavingWelcome = welcomes[2]!;
    leaving.socket.close(1000, "smoke leave");
    await eventually(() => server!.diagnostics().activePlayers === 3, "player removal");
    await expect(clients[1]!.waitFor(
      (message): message is SnapshotMessage => message.type === "snapshot"
        && !message.players.some(({ playerId }) => playerId === leavingWelcome.playerId),
    )).resolves.toBeDefined();

    const replacement = await connect();
    const replacementWelcome = await replacement.waitFor(
      (message): message is WelcomeMessage => message.type === "welcome",
    );
    const replacementState = replacementWelcome.baseline.players.find(
      ({ playerId }) => playerId === replacementWelcome.playerId,
    );
    const departedSpawn = leavingWelcome.baseline.players.find(({ playerId }) => playerId === leavingWelcome.playerId)?.position;
    expect(replacementState?.position).toEqual(departedSpawn);
    expect(replacementWelcome.epoch).not.toBe(leavingWelcome.epoch);

    replacement.socket.close(1000, "smoke refresh");
    await eventually(() => server!.diagnostics().activePlayers === 3, "refresh cleanup");
    const refreshed = await connect();
    const refreshedWelcome = await refreshed.waitFor(
      (message): message is WelcomeMessage => message.type === "welcome",
    );
    expect(refreshedWelcome.epoch).not.toBe(replacementWelcome.epoch);
    expect(refreshedWelcome.baseline.players.find(
      ({ playerId }) => playerId === refreshedWelcome.playerId,
    )?.lastProcessedInputSequence).toBe(0);
    expect(server.diagnostics().activePlayers).toBe(MAX_ACTIVE_PLAYERS);
    expect(errors).toEqual([]);
  }, 10_000);
});
