import { randomInt, randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

import {
  COMMAND_HZ,
  COMBAT_CONSTANTS,
  FIXED_DELTA_SECONDS,
  PROTOCOL_VERSION,
  SIMULATION_HZ,
  SNAPSHOT_HZ,
  createInitialPlayerState,
  decodeClientMessage,
  encodeServerMessage,
  isAbilityOnGlobalCooldown,
  resolveAbilityUse,
  stepPlayer,
  type AbilityResultMessage,
  type AbilityUseMessage,
  type AuthoritativePlayerState,
  type BossState,
  type InputMessage,
  type MovementInput,
  type PlayerCombatState,
  type ProtocolErrorMessage,
  type ProjectileState,
  type ServerMessage,
} from "@four/shared";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import {
  FIXED_STEP_MS,
  MAX_CATCH_UP_STEPS,
  MAX_ABILITY_QUEUE_LENGTH,
  MAX_INPUT_QUEUE_LENGTH,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGES_PER_SECOND,
  MISSING_INPUT_GRACE_TICKS,
  RATE_LIMIT_WINDOW_MS,
  SERVER_CAPACITY,
  SNAPSHOT_INTERVAL_TICKS,
  SPAWN_POINTS,
} from "./config.js";
import {
  advanceCombat,
  copyBoss,
  copyProjectile,
  createInitialBossState,
} from "./combat-simulation.js";

const NEUTRAL_INPUT: MovementInput = Object.freeze({ moveX: 0, moveZ: 0, jump: false });

export const PLAYER_NAMES = ["Nova", "Moss", "Pip", "Rune"] as const;

export interface ServerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface GameServerOptions {
  port?: number;
  host?: string;
  autoTick?: boolean;
  now?: () => number;
  logger?: ServerLogger;
  productionClientDirectory?: string;
  random?: () => number;
  /** Test fixture override; production defaults to the shared boss maximum. */
  initialBossHealth?: number;
}

interface PlayerConnection {
  socket: WebSocket;
  playerId: string;
  epoch: string;
  spawnIndex: number;
  state: AuthoritativePlayerState;
  inputQueue: InputMessage[];
  abilityQueue: AbilityUseMessage[];
  lastAbilityRequestId: number;
  lastReceivedSequence: number;
  lastAppliedInput: MovementInput;
  missingInputTicks: number;
  rateWindowStartedAt: number;
  messagesInWindow: number;
  rejectionCount: number;
}

export interface GameServerAddress {
  host: string;
  port: number;
  url: string;
}

export interface ServerDiagnostics {
  serverTick: number;
  snapshotSequence: number;
  activePlayers: number;
  queueLengths: number[];
  abilityQueueLengths: number[];
  bossHealth: number;
  activeProjectiles: number;
  lastPumpSteps: number;
}

const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export class GameServer {
  private readonly options: Required<Pick<GameServerOptions, "host" | "autoTick" | "now" | "logger" | "random">> & GameServerOptions;
  private readonly httpServer: HttpServer;
  private readonly webSocketServer: WebSocketServer;
  private readonly players = new Map<WebSocket, PlayerConnection>();
  private readonly occupiedSpawns = new Set<number>();
  private boss: BossState;
  private projectiles = new Map<string, ProjectileState>();
  private timer: NodeJS.Timeout | undefined;
  private lastClockMs = 0;
  private accumulatorMs = 0;
  private running = false;
  private serverTick = 0;
  private snapshotSequence = 0;
  private lastPumpSteps = 0;

  public constructor(options: GameServerOptions = {}) {
    const initialBoss = createInitialBossState();
    const initialBossHealth = options.initialBossHealth ?? initialBoss.maxHealth;
    if (!Number.isFinite(initialBossHealth) || initialBossHealth < 0 || initialBossHealth > initialBoss.maxHealth) {
      throw new RangeError("initialBossHealth must be finite and between zero and max health");
    }
    this.boss = { ...initialBoss, health: initialBossHealth };
    this.options = {
      ...options,
      host: options.host ?? "127.0.0.1",
      autoTick: options.autoTick ?? true,
      now: options.now ?? (() => performance.now()),
      logger: options.logger ?? console,
      random: options.random ?? (() => randomInt(0x1_0000_0000) / 0x1_0000_0000),
    };
    this.httpServer = createServer((request, response) => this.handleHttp(request, response));
    this.webSocketServer = new WebSocketServer({
      server: this.httpServer,
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    this.webSocketServer.on("connection", (socket) => this.handleConnection(socket));
    this.webSocketServer.on("error", (error) => this.options.logger.error(`websocket server error: ${error.message}`));
  }

  public async start(): Promise<GameServerAddress> {
    if (this.running) {
      return this.address();
    }

    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error): void => reject(error);
      this.httpServer.once("error", onError);
      this.httpServer.listen(this.options.port ?? 0, this.options.host, () => {
        this.httpServer.off("error", onError);
        resolvePromise();
      });
    });
    this.running = true;
    this.lastClockMs = this.options.now();
    if (this.options.autoTick) {
      this.timer = setInterval(() => this.pump(), Math.max(1, Math.floor(FIXED_STEP_MS / 4)));
    }
    return this.address();
  }

  public pump(nowMs = this.options.now()): number {
    if (!this.running) {
      return 0;
    }
    const elapsedMs = Math.max(0, nowMs - this.lastClockMs);
    this.lastClockMs = nowMs;
    this.accumulatorMs = Math.min(
      this.accumulatorMs + elapsedMs,
      FIXED_STEP_MS * MAX_CATCH_UP_STEPS,
    );

    let steps = 0;
    while (this.accumulatorMs >= FIXED_STEP_MS - 1e-7 && steps < MAX_CATCH_UP_STEPS) {
      this.simulateStep();
      this.accumulatorMs = Math.max(0, this.accumulatorMs - FIXED_STEP_MS);
      steps += 1;
    }
    this.lastPumpSteps = steps;
    return steps;
  }

  public diagnostics(): ServerDiagnostics {
    return {
      serverTick: this.serverTick,
      snapshotSequence: this.snapshotSequence,
      activePlayers: this.players.size,
      queueLengths: [...this.players.values()].map((player) => player.inputQueue.length),
      abilityQueueLengths: [...this.players.values()].map((player) => player.abilityQueue.length),
      bossHealth: this.boss.health,
      activeProjectiles: this.projectiles.size,
      lastPumpSteps: this.lastPumpSteps,
    };
  }

  public async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!this.running) {
      return;
    }
    this.running = false;

    for (const socket of this.webSocketServer.clients) {
      socket.close(1001, "Server shutting down");
    }
    await new Promise<void>((resolvePromise) => {
      const forceClose = setTimeout(() => {
        for (const socket of this.webSocketServer.clients) {
          socket.terminate();
        }
      }, 100);
      forceClose.unref();
      this.webSocketServer.close(() => {
        clearTimeout(forceClose);
        resolvePromise();
      });
    });
    await new Promise<void>((resolvePromise, reject) => {
      this.httpServer.close((error) => error === undefined ? resolvePromise() : reject(error));
    });
  }

  private address(): GameServerAddress {
    const address = this.httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Server is not listening on a TCP port");
    }
    return {
      host: this.options.host,
      port: address.port,
      url: `ws://${this.options.host}:${address.port}`,
    };
  }

  private handleConnection(socket: WebSocket): void {
    if (this.players.size >= SERVER_CAPACITY) {
      this.send(socket, {
        type: "server_full",
        protocolVersion: PROTOCOL_VERSION,
        maxPlayers: SERVER_CAPACITY,
        message: "The arena is full",
      });
      socket.close(1013, "Server full");
      return;
    }

    const spawnIndex = this.claimSpawn();
    const playerId = randomUUID();
    const epoch = randomUUID();
    const displayName = this.choosePlayerName();
    const spawn = SPAWN_POINTS[spawnIndex];
    if (spawn === undefined) throw new Error("Claimed spawn index is out of range");
    const player: PlayerConnection = {
      socket,
      playerId,
      epoch,
      spawnIndex,
      state: createInitialPlayerState({ playerId, displayName, position: spawn }),
      inputQueue: [],
      abilityQueue: [],
      lastAbilityRequestId: 0,
      lastReceivedSequence: 0,
      lastAppliedInput: NEUTRAL_INPUT,
      missingInputTicks: MISSING_INPUT_GRACE_TICKS,
      rateWindowStartedAt: this.options.now(),
      messagesInWindow: 0,
      rejectionCount: 0,
    };
    this.players.set(socket, player);
    socket.on("message", (data, isBinary) => this.handleMessage(player, data, isBinary));
    socket.on("close", () => this.removePlayer(player));
    socket.on("error", (error) => this.reject(player, `socket error: ${error.message}`));

    this.send(socket, {
      type: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      playerId,
      epoch,
      rates: { simulationHz: SIMULATION_HZ, commandHz: COMMAND_HZ, snapshotHz: SNAPSHOT_HZ },
      initialServerTick: this.serverTick,
      baseline: {
        snapshotSequence: this.snapshotSequence,
        serverTick: this.serverTick,
        players: this.playerStates(),
        boss: copyBoss(this.boss),
        projectiles: this.projectileStates(),
      },
    });
    this.options.logger.info(`connected player=${playerId} name=${displayName} epoch=${epoch} spawn=${spawnIndex}`);
  }

  private choosePlayerName(): string {
    const assignedNames = new Set([...this.players.values()].map((player) => player.state.displayName));
    const availableNames = PLAYER_NAMES.filter((name) => !assignedNames.has(name));
    return availableNames[randomInt(availableNames.length)] ?? PLAYER_NAMES[0];
  }

  private handleMessage(player: PlayerConnection, data: RawData, isBinary: boolean): void {
    const byteLength = dataByteLength(data);
    if (byteLength > MAX_MESSAGE_BYTES) {
      this.reject(player, `oversized message bytes=${byteLength}`);
      player.socket.close(1009, "Message too large");
      return;
    }
    if (!this.allowMessage(player)) {
      this.sendProtocolError(player.socket, "rate_limited", "Message rate limit exceeded");
      this.reject(player, "message rate limit exceeded");
      player.socket.close(1008, "Rate limit exceeded");
      return;
    }
    if (isBinary) {
      this.sendProtocolError(player.socket, "invalid_message", "Binary messages are not supported");
      this.reject(player, "binary message rejected");
      return;
    }

    const raw = data.toString();
    const decoded = decodeClientMessage(raw);
    if (!decoded.success) {
      const wrongVersion = hasWrongProtocolVersion(raw);
      this.sendProtocolError(
        player.socket,
        wrongVersion ? "wrong_version" : decoded.error.code,
        wrongVersion ? "Unsupported protocol version" : decoded.error.message === "Message is not valid JSON"
          ? decoded.error.message
          : "Message did not match the client protocol",
      );
      this.reject(player, `${wrongVersion ? "wrong version" : decoded.error.code} rejected`);
      return;
    }

    if (decoded.data.type === "ping") {
      this.send(player.socket, {
        type: "pong",
        protocolVersion: PROTOCOL_VERSION,
        nonce: decoded.data.nonce,
        sentAtMs: decoded.data.sentAtMs,
      });
      return;
    }
    if (decoded.data.type === "ability_use") {
      this.acceptAbilityRequest(player, decoded.data);
      return;
    }
    this.acceptInput(player, decoded.data);
  }

  private acceptAbilityRequest(player: PlayerConnection, request: AbilityUseMessage): void {
    if (request.epoch !== player.epoch) {
      this.sendProtocolError(player.socket, "invalid_message", "Ability epoch does not match this connection");
      this.reject(player, `wrong ability epoch request=${request.requestId}`);
      return;
    }
    const expectedRequestId = player.lastAbilityRequestId + 1;
    if (request.requestId !== expectedRequestId) {
      this.sendAbilityResult(player, request, false, "stale_request");
      this.reject(player, `stale/gapped ability request=${request.requestId} expected=${expectedRequestId}`);
      return;
    }
    if (player.abilityQueue.length >= MAX_ABILITY_QUEUE_LENGTH) {
      this.sendAbilityResult(player, request, false, "invalid_request");
      this.reject(player, `ability queue full request=${request.requestId}`);
      return;
    }
    player.abilityQueue.push(request);
    player.lastAbilityRequestId = request.requestId;
  }

  private acceptInput(player: PlayerConnection, input: InputMessage): void {
    if (input.epoch !== player.epoch) {
      this.sendProtocolError(player.socket, "invalid_message", "Input epoch does not match this connection");
      this.reject(player, `wrong epoch sequence=${input.sequence}`);
      return;
    }
    const expectedSequence = player.lastReceivedSequence + 1;
    if (input.sequence !== expectedSequence) {
      const relation = input.sequence < expectedSequence ? "duplicate/stale" : "sequence gap";
      this.sendProtocolError(player.socket, "invalid_message", `Input ${relation}; expected sequence ${expectedSequence}`);
      this.reject(player, `${relation} sequence=${input.sequence} expected=${expectedSequence}`);
      return;
    }
    if (player.inputQueue.length >= MAX_INPUT_QUEUE_LENGTH) {
      this.sendProtocolError(player.socket, "rate_limited", "Input queue is full");
      this.reject(player, `input queue full sequence=${input.sequence}`);
      return;
    }
    player.inputQueue.push(input);
    player.lastReceivedSequence = input.sequence;
  }

  private simulateStep(): void {
    this.serverTick += 1;
    for (const player of this.players.values()) {
      const ability = player.abilityQueue.shift();
      if (ability !== undefined) this.processAbilityRequest(player, ability);
    }
    for (const player of this.players.values()) {
      const command = player.inputQueue.shift();
      let input: MovementInput;
      if (command !== undefined) {
        input = { moveX: command.moveX, moveZ: command.moveZ, jump: command.jump };
        player.lastAppliedInput = input;
        player.missingInputTicks = 0;
      } else {
        player.missingInputTicks += 1;
        input = player.missingInputTicks <= MISSING_INPUT_GRACE_TICKS
          ? player.lastAppliedInput
          : NEUTRAL_INPUT;
      }

      const permittedInput: MovementInput = {
        moveX: player.state.control.permissions.allowMove ? input.moveX : 0,
        moveZ: player.state.control.permissions.allowMove ? input.moveZ : 0,
        jump: player.state.control.permissions.allowActions && input.jump,
      };
      const stepped = stepPlayer(player.state, permittedInput, FIXED_DELTA_SECONDS);
      player.state = command === undefined
        ? stepped
        : { ...stepped, lastProcessedInputSequence: command.sequence };
    }

    const combatStep = advanceCombat(
      this.boss,
      [...this.projectiles.values()],
      FIXED_DELTA_SECONDS,
    );
    this.boss = combatStep.boss;
    this.projectiles = new Map(combatStep.projectiles.map((projectile) => [projectile.projectileId, projectile]));

    if (this.serverTick % SNAPSHOT_INTERVAL_TICKS === 0) {
      this.broadcastSnapshot();
    }
  }

  private processAbilityRequest(player: PlayerConnection, request: AbilityUseMessage): void {
    if (this.boss.health <= 0) {
      this.sendAbilityResult(player, request, false, "boss_defeated");
      return;
    }
    if (this.projectiles.size >= COMBAT_CONSTANTS.maxActiveProjectiles) {
      this.sendAbilityResult(player, request, false, "invalid_request");
      return;
    }
    const combatState = toCombatState(player.state.combat);
    if (isAbilityOnGlobalCooldown(combatState, request.slot, this.serverTick)) {
      this.sendAbilityResult(player, request, false, "global_cooldown");
      return;
    }

    const roll = normalizeRandomRoll(this.options.random());
    if (roll === undefined) {
      this.options.logger.error("random source returned a non-finite value; ability rejected");
      this.sendAbilityResult(player, request, false, "invalid_request");
      return;
    }
    const resolution = resolveAbilityUse(combatState, request.slot, roll, this.serverTick);
    if (!resolution.accepted) {
      const reason = resolution.reason === "missing_buff"
        ? "missing_buff"
        : resolution.reason === "global_cooldown"
          ? "global_cooldown"
          : "invalid_request";
      this.sendAbilityResult(player, request, false, reason);
      return;
    }

    player.state = { ...player.state, combat: resolution.combatState };
    const projectile: ProjectileState = {
      projectileId: randomUUID(),
      ownerPlayerId: player.playerId,
      abilityId: resolution.ability.abilityId,
      targetId: this.boss.bossId,
      position: {
        x: player.state.position.x,
        y: player.state.position.y + COMBAT_CONSTANTS.projectile.spawnHeight,
        z: player.state.position.z,
      },
      speed: COMBAT_CONSTANTS.projectile.speed,
      damage: resolution.ability.damage,
      spawnedAtTick: this.serverTick,
    };
    this.projectiles.set(projectile.projectileId, projectile);
    this.sendAbilityResult(player, request, true, "accepted");
  }

  private sendAbilityResult(
    player: PlayerConnection,
    request: AbilityUseMessage,
    accepted: boolean,
    reason: AbilityResultMessage["reason"],
  ): void {
    this.send(player.socket, {
      type: "ability_result",
      protocolVersion: PROTOCOL_VERSION,
      epoch: player.epoch,
      requestId: request.requestId,
      slot: request.slot,
      accepted,
      reason,
      combat: {
        ...player.state.combat,
        buffs: player.state.combat.buffs.map((buff) => ({ ...buff })),
      },
    });
  }

  private broadcastSnapshot(): void {
    this.snapshotSequence += 1;
    const players = this.playerStates();
    for (const recipient of this.players.values()) {
      this.send(recipient.socket, {
        type: "snapshot",
        protocolVersion: PROTOCOL_VERSION,
        epoch: recipient.epoch,
        snapshotSequence: this.snapshotSequence,
        serverTick: this.serverTick,
        players,
        boss: copyBoss(this.boss),
        projectiles: this.projectileStates(),
      });
    }
  }

  private playerStates(): AuthoritativePlayerState[] {
    return [...this.players.values()].map((player) => ({
      ...player.state,
      position: { ...player.state.position },
      airborneVelocity: { ...player.state.airborneVelocity },
      combat: { ...player.state.combat, buffs: player.state.combat.buffs.map((buff) => ({ ...buff })) },
      control: {
        ...player.state.control,
        permissions: { ...player.state.control.permissions },
        forcedMotion: player.state.control.forcedMotion === undefined
          ? undefined
          : { ...player.state.control.forcedMotion },
      },
    }));
  }

  private projectileStates(): ProjectileState[] {
    return [...this.projectiles.values()].map(copyProjectile);
  }

  private allowMessage(player: PlayerConnection): boolean {
    const now = this.options.now();
    if (now - player.rateWindowStartedAt >= RATE_LIMIT_WINDOW_MS) {
      player.rateWindowStartedAt = now;
      player.messagesInWindow = 0;
    }
    player.messagesInWindow += 1;
    return player.messagesInWindow <= MAX_MESSAGES_PER_SECOND;
  }

  private claimSpawn(): number {
    for (let index = 0; index < SPAWN_POINTS.length; index += 1) {
      if (!this.occupiedSpawns.has(index)) {
        this.occupiedSpawns.add(index);
        return index;
      }
    }
    throw new Error("No spawn available despite capacity check");
  }

  private removePlayer(player: PlayerConnection): void {
    if (!this.players.delete(player.socket)) {
      return;
    }
    player.inputQueue.length = 0;
    player.abilityQueue.length = 0;
    this.occupiedSpawns.delete(player.spawnIndex);
    this.options.logger.info(`disconnected player=${player.playerId} epoch=${player.epoch}`);
  }

  private reject(player: PlayerConnection, reason: string): void {
    player.rejectionCount += 1;
    if (player.rejectionCount <= 5 || player.rejectionCount % 50 === 0) {
      this.options.logger.warn(
        `rejected player=${player.playerId} epoch=${player.epoch} count=${player.rejectionCount} ${reason}`,
      );
    }
  }

  private sendProtocolError(socket: WebSocket, code: ProtocolErrorMessage["code"], message: string): void {
    this.send(socket, { type: "protocol_error", protocolVersion: PROTOCOL_VERSION, code, message });
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(encodeServerMessage(message));
    }
  }

  private handleHttp(request: IncomingMessage, response: ServerResponse): void {
    const clientDirectory = this.options.productionClientDirectory;
    if (clientDirectory === undefined) {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("Four authoritative server\n");
      return;
    }

    const root = resolve(clientDirectory);
    let decodedPath: string;
    try {
      const requestPath = new URL(request.url ?? "/", "http://localhost").pathname;
      decodedPath = decodeURIComponent(requestPath);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
    let filePath = resolve(root, normalize(relativePath));
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      if (extname(relativePath) !== "") {
        response.writeHead(404).end();
        return;
      }
      filePath = join(root, "index.html");
    }
    if (!existsSync(filePath)) {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      response.end("Client build is unavailable");
      return;
    }
    response.writeHead(200, {
      "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      "cache-control": extname(filePath) === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    createReadStream(filePath).pipe(response);
  }
}

function normalizeRandomRoll(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return ((value % 1) + 1) % 1;
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

function dataByteLength(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, part) => total + part.byteLength, 0);
  }
  return data.byteLength;
}

function hasWrongProtocolVersion(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null && "protocolVersion" in value
      && (value as { protocolVersion?: unknown }).protocolVersion !== PROTOCOL_VERSION;
  } catch {
    return false;
  }
}
