import { once } from "node:events";

import {
  MAX_ACTIVE_PLAYERS,
  PROTOCOL_VERSION,
  decodeServerMessage,
  encodeClientMessage,
  isAbilitySlotUsable,
  type AbilityResultMessage,
  type AbilitySlot,
  type AbilityUseMessage,
  type AuthoritativePlayerState,
  type InputMessage,
  type PlayerCombatState,
  type ServerMessage,
  type SnapshotMessage,
  type WelcomeMessage,
} from "@four/shared";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { FIXED_STEP_MS } from "./config.js";
import { GameServer, type ServerLogger } from "./game-server.js";

interface SmokeClient {
  readonly socket: WebSocket;
  readonly messages: ServerMessage[];
  waitFor<T extends ServerMessage>(predicate: (message: ServerMessage) => message is T): Promise<T>;
}

function toCombatState(combat: AuthoritativePlayerState["combat"]): PlayerCombatState {
  return {
    classId: combat.classId,
    globalCooldownEndsAtTick: combat.globalCooldownEndsAtTick,
    buffs: combat.buffs.map((buff) => buff.expiresAtTick === undefined
      ? { buffId: buff.buffId, stacks: buff.stacks }
      : { buffId: buff.buffId, stacks: buff.stacks, expiresAtTick: buff.expiresAtTick }),
  };
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

  it("covers the deterministic Dancer combat milestone across two clients", async () => {
    let now = 10_000;
    server = new GameServer({
      autoTick: false,
      initialBossHealth: 500,
      now: () => now,
      random: () => 0,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
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
    const pumpTicks = (count: number): void => {
      for (let tick = 0; tick < count; tick += 1) {
        now += FIXED_STEP_MS;
        server!.pump(now);
      }
    };
    let nextAbilityTick = 0;
    const sendAbility = async (
      client: SmokeClient,
      welcome: WelcomeMessage,
      requestId: number,
      slot: AbilitySlot,
    ): Promise<AbilityResultMessage> => {
      const currentTick = server!.diagnostics().serverTick;
      if (currentTick < nextAbilityTick) pumpTicks(nextAbilityTick - currentTick);
      const request: AbilityUseMessage = {
        type: "ability_use",
        protocolVersion: PROTOCOL_VERSION,
        epoch: welcome.epoch,
        requestId,
        slot,
      };
      client.socket.send(encodeClientMessage(request));
      await eventually(
        () => server!.diagnostics().abilityQueueLengths.some((length) => length > 0),
        `ability ${requestId} queued`,
      );
      pumpTicks(1);
      const result = await client.waitFor(
        (message): message is AbilityResultMessage => message.type === "ability_result"
          && message.requestId === requestId,
      );
      if (result.accepted) nextAbilityTick = result.combat.globalCooldownEndsAtTick;
      return result;
    };
    const settleProjectiles = (): void => {
      for (let tick = 0; server!.diagnostics().activeProjectiles > 0 && tick < 120; tick += 1) {
        pumpTicks(1);
      }
      if (server!.diagnostics().activeProjectiles > 0) throw new Error("Projectiles did not settle");
    };
    const snapshotAtHealth = async (client: SmokeClient, health: number): Promise<SnapshotMessage> => {
      for (let tick = 0; tick < 3; tick += 1) pumpTicks(1);
      return client.waitFor(
        (message): message is SnapshotMessage => message.type === "snapshot" && message.boss.health === health,
      );
    };

    const first = await connect();
    const firstWelcome = await first.waitFor(
      (message): message is WelcomeMessage => message.type === "welcome",
    );
    const freshCombat = firstWelcome.baseline.players.find(
      (player) => player.playerId === firstWelcome.playerId,
    )!.combat;
    expect(freshCombat.classId).toBe("dancer");
    expect([1, 2, 3, 4].filter((slot) => isAbilitySlotUsable(toCombatState(freshCombat), slot as AbilitySlot))).toEqual([2]);

    const unavailable = await sendAbility(first, firstWelcome, 1, 3);
    expect(unavailable).toMatchObject({ accepted: false, reason: "missing_buff" });
    expect(server.diagnostics()).toMatchObject({ bossHealth: 500, activeProjectiles: 0 });

    const opening = await sendAbility(first, firstWelcome, 2, 2);
    expect(opening).toMatchObject({ accepted: true, slot: 2 });
    expect(isAbilitySlotUsable(toCombatState(opening.combat), 3)).toBe(true);
    expect(server.diagnostics().activeProjectiles).toBe(1);

    first.socket.send(encodeClientMessage({
      type: "ability_use",
      protocolVersion: PROTOCOL_VERSION,
      epoch: firstWelcome.epoch,
      requestId: 2,
      slot: 2,
    }));
    const duplicate = await first.waitFor(
      (message): message is AbilityResultMessage => message.type === "ability_result"
        && message.requestId === 2 && message.reason === "stale_request",
    );
    expect(duplicate.accepted).toBe(false);
    expect(server.diagnostics()).toMatchObject({ bossHealth: 500, activeProjectiles: 1 });

    const second = await connect();
    const secondWelcome = await second.waitFor(
      (message): message is WelcomeMessage => message.type === "welcome",
    );
    expect(secondWelcome.baseline.boss.health).toBe(500);
    expect(secondWelcome.baseline.projectiles).toHaveLength(1);

    settleProjectiles();
    expect(server.diagnostics().bossHealth).toBe(490);
    const [firstImpact, secondImpact] = await Promise.all([
      snapshotAtHealth(first, 490),
      snapshotAtHealth(second, 490),
    ]);
    expect(firstImpact.boss).toEqual(secondImpact.boss);
    expect(firstImpact.projectiles).toEqual(secondImpact.projectiles);

    const third = await sendAbility(first, firstWelcome, 3, 3);
    expect(third.accepted).toBe(true);
    expect(isAbilitySlotUsable(toCombatState(third.combat), 3)).toBe(false);
    settleProjectiles();
    expect(server.diagnostics().bossHealth).toBe(480);

    const strongOne = await sendAbility(first, firstWelcome, 4, 1);
    expect(strongOne.accepted).toBe(true);
    settleProjectiles();
    expect(server.diagnostics().bossHealth).toBe(455);
    const strongFour = await sendAbility(first, firstWelcome, 5, 4);
    expect(strongFour.accepted).toBe(true);
    settleProjectiles();
    expect(server.diagnostics().bossHealth).toBe(430);

    let requestId = 5;
    for (const slot of [2, 3, 2, 3] as const) {
      requestId += 1;
      expect((await sendAbility(first, firstWelcome, requestId, slot)).accepted).toBe(true);
    }
    settleProjectiles();
    expect(server.diagnostics().bossHealth).toBe(390);

    for (let cycle = 0; cycle < 5; cycle += 1) {
      for (const slot of [2, 1, 3, 4] as const) {
        requestId += 1;
        expect((await sendAbility(first, firstWelcome, requestId, slot)).accepted).toBe(true);
      }
    }
    settleProjectiles();
    expect(server.diagnostics().bossHealth).toBe(40);
    for (const slot of [2, 1, 3] as const) {
      requestId += 1;
      expect((await sendAbility(first, firstWelcome, requestId, slot)).accepted).toBe(true);
    }
    settleProjectiles();
    expect(server.diagnostics().bossHealth).toBe(0);

    const [firstDefeat, secondDefeat] = await Promise.all([
      snapshotAtHealth(first, 0),
      snapshotAtHealth(second, 0),
    ]);
    expect(firstDefeat.boss).toEqual(secondDefeat.boss);
    expect(firstDefeat.projectiles).toEqual(secondDefeat.projectiles);
    expect(firstDefeat.boss).toMatchObject({ health: 0, maxHealth: 50_000 });

    requestId += 1;
    const afterDefeat = await sendAbility(first, firstWelcome, requestId, 2);
    expect(afterDefeat).toMatchObject({ accepted: false, reason: "boss_defeated" });
    expect(server.diagnostics()).toMatchObject({ bossHealth: 0, activeProjectiles: 0 });
  }, 15_000);
});
