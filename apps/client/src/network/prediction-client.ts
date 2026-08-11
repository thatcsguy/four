import {
  COMMAND_HZ,
  FIXED_DELTA_SECONDS,
  PROTOCOL_VERSION,
  decodeServerMessage,
  encodeClientMessage,
  isAbilityOnGlobalCooldown,
  stepPlayer,
  type AbilityResultMessage,
  type AbilitySlot,
  type AbilityUseMessage,
  type AuthoritativePlayerState,
  type BossState,
  type ClassChangeResultMessage,
  type InputMessage,
  type MovementInput,
  type PlayerClassId,
  type ProjectileState,
  type ServerMessage,
  type SnapshotMessage,
  type WelcomeMessage,
} from "@four/shared";

import { CLIENT_NETCODE_CONFIG } from "../config.js";
import type { MovementIntentSnapshot } from "../input/index.js";
import {
  RemotePlayerInterpolator,
  type InterpolatedRemoteState,
  type RemoteInterpolationDiagnostics,
} from "./remote-interpolation.js";
import type { ClientTransport, TransportFactory, TransportMessageEvent } from "./transport.js";

const COMMAND_STEP_MS = 1_000 / COMMAND_HZ;
const OPEN_READY_STATE = 1;

export type ConnectionState =
  | "idle"
  | "connecting"
  | "awaiting_baseline"
  | "connected"
  | "resyncing"
  | "disconnected"
  | "full"
  | "error";

export interface PredictionDiagnostics {
  readonly connection: ConnectionState;
  readonly localPlayerId?: string;
  readonly serverTick: number;
  readonly snapshotSequence: number;
  readonly rttMs?: number;
  readonly jitterMs?: number;
  readonly pendingCount: number;
  readonly oldestPendingAgeMs: number;
  readonly lastSentSequence: number;
  readonly lastAcknowledgedSequence: number;
  readonly latestCorrectionMeters: number;
  readonly maxCorrectionMeters: number;
  readonly correctionCount: number;
  readonly controlMode?: AuthoritativePlayerState["control"]["mode"];
  readonly controlRevision?: number;
  readonly stateRevision?: number;
  readonly resyncCount: number;
  readonly interpolation: RemoteInterpolationDiagnostics;
  readonly detail?: string;
}

export interface PredictionClientOptions {
  readonly url: string;
  readonly transportFactory: TransportFactory;
  readonly sampleIntent: () => MovementIntentSnapshot;
  readonly now?: () => number;
  readonly autoSchedule?: boolean;
  readonly setInterval?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
  readonly setTimeout?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly onDiagnostics?: (diagnostics: PredictionDiagnostics) => void;
  readonly onAbilityResult?: (result: AbilityResultMessage) => void;
}

export interface ClientCombatState {
  readonly player: AuthoritativePlayerState["combat"] | undefined;
  readonly boss: BossState | undefined;
  readonly projectiles: readonly ProjectileState[];
}

interface PendingInput {
  readonly command: InputMessage;
  readonly producedAtMs: number;
}

interface MutableVector3 {
  x: number;
  y: number;
  z: number;
}

function copyState(state: Readonly<AuthoritativePlayerState>): AuthoritativePlayerState {
  return structuredClone(state);
}

function distance(a: Readonly<MutableVector3>, b: Readonly<MutableVector3>): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function permittedInput(
  state: Readonly<AuthoritativePlayerState>,
  command: Pick<InputMessage, "moveX" | "moveZ" | "jump">,
): MovementInput {
  return {
    moveX: state.control.permissions.allowMove ? command.moveX : 0,
    moveZ: state.control.permissions.allowMove ? command.moveZ : 0,
    jump: state.control.permissions.allowActions && command.jump,
  };
}

export class PredictionClient {
  private readonly now: () => number;
  private readonly scheduleInterval: (callback: () => void, milliseconds: number) => unknown;
  private readonly cancelInterval: (handle: unknown) => void;
  private readonly scheduleTimeout: (callback: () => void, milliseconds: number) => unknown;
  private readonly cancelTimeout: (handle: unknown) => void;
  private transport: ClientTransport | undefined;
  private intervalHandle: unknown;
  private reconnectHandle: unknown;
  private disposed = false;
  private visible = true;
  private connection: ConnectionState = "idle";
  private detail: string | undefined;
  private playerId: string | undefined;
  private epoch: string | undefined;
  private predicted: AuthoritativePlayerState | undefined;
  private rendered: AuthoritativePlayerState | undefined;
  private latestPlayers: readonly AuthoritativePlayerState[] = [];
  private readonly remotePlayers = new RemotePlayerInterpolator();
  private pending: PendingInput[] = [];
  private nextSequence = 1;
  private clientTick = 0;
  private lastAcknowledgedSequence = 0;
  private lastSnapshotSequence = -1;
  private serverTick = 0;
  private lastAdvanceMs: number;
  private accumulatorMs = 0;
  private resetFenceSequence: number | undefined;
  private correctionStartOffset: MutableVector3 = { x: 0, y: 0, z: 0 };
  private correctionElapsedMs = 0;
  private latestCorrectionMeters = 0;
  private maxCorrectionMeters = 0;
  private correctionCount = 0;
  private resyncCount = 0;
  private nextPingAtMs = 0;
  private nextPingNonce = 1;
  private readonly pings = new Map<number, number>();
  private rttMs: number | undefined;
  private jitterMs: number | undefined;
  private lastMovementActive = false;
  private boss: BossState | undefined;
  private projectiles: readonly ProjectileState[] = [];
  private nextAbilityRequestId = 1;
  private readonly sentAbilityRequests = new Set<number>();
  private readonly deliveredAbilityResults = new Set<number>();

  constructor(private readonly options: PredictionClientOptions) {
    this.now = options.now ?? (() => performance.now());
    this.scheduleInterval = options.setInterval ?? ((callback, milliseconds) => globalThis.setInterval(callback, milliseconds));
    this.cancelInterval = options.clearInterval ?? ((handle) => globalThis.clearInterval(handle as number));
    this.scheduleTimeout = options.setTimeout ?? ((callback, milliseconds) => globalThis.setTimeout(callback, milliseconds));
    this.cancelTimeout = options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle as number));
    this.lastAdvanceMs = this.now();
    if (options.autoSchedule ?? true) {
      this.intervalHandle = this.scheduleInterval(() => this.advance(this.now()), Math.max(1, COMMAND_STEP_MS / 4));
    }
  }

  connect(): void {
    if (this.disposed || this.connection === "connecting" || this.connection === "awaiting_baseline" || this.connection === "connected") {
      return;
    }
    this.cancelReconnect();
    this.clearSession();
    this.setConnection("connecting");
    let transport: ClientTransport;
    try {
      transport = this.options.transportFactory(this.options.url);
    } catch (error) {
      this.fail(`WebSocket creation failed: ${String(error)}`);
      return;
    }
    this.transport = transport;
    transport.addEventListener("open", this.onOpen);
    transport.addEventListener("message", this.onMessage);
    transport.addEventListener("close", this.onClose);
    transport.addEventListener("error", this.onError);
  }

  reconnect(reason = "Manual resync"): void {
    if (this.disposed) return;
    this.resyncCount += 1;
    this.detail = reason;
    this.setConnection("resyncing");
    const oldTransport = this.transport;
    this.detachTransport();
    this.clearSession();
    if (oldTransport && oldTransport.readyState <= OPEN_READY_STATE) {
      oldTransport.close(1000, "Client resync");
    }
    this.scheduleReconnect();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.accumulatorMs = 0;
    this.lastAdvanceMs = this.now();
  }

  advance(nowMs = this.now()): number {
    const elapsedMs = Math.max(0, nowMs - this.lastAdvanceMs);
    this.lastAdvanceMs = nowMs;
    if (!this.visible || this.connection !== "connected" || !this.predicted || !this.epoch) {
      this.accumulatorMs = 0;
      return 0;
    }

    this.maybePing(nowMs);
    if (this.isPendingUnsafe(nowMs)) {
      this.reconnect("Input acknowledgements stalled");
      return 0;
    }
    if (this.resetFenceSequence !== undefined) {
      return 0;
    }

    this.accumulatorMs = Math.min(
      this.accumulatorMs + elapsedMs,
      COMMAND_STEP_MS * CLIENT_NETCODE_CONFIG.maxCatchUpSteps,
    );
    let steps = 0;
    while (this.accumulatorMs >= COMMAND_STEP_MS - 1e-7 && steps < CLIENT_NETCODE_CONFIG.maxCatchUpSteps) {
      if (!this.produceCommand(nowMs)) break;
      this.accumulatorMs = Math.max(0, this.accumulatorMs - COMMAND_STEP_MS);
      steps += 1;
    }
    this.emitDiagnostics();
    return steps;
  }

  advancePresentation(deltaMs: number): void {
    if (!this.predicted || !this.rendered) return;
    const safeDelta = Math.min(Math.max(deltaMs, 0), CLIENT_NETCODE_CONFIG.visualCorrectionDurationMs);
    this.correctionElapsedMs = Math.min(
      CLIENT_NETCODE_CONFIG.visualCorrectionDurationMs,
      this.correctionElapsedMs + safeDelta,
    );
    const progress = this.correctionElapsedMs / CLIENT_NETCODE_CONFIG.visualCorrectionDurationMs;
    this.rendered = {
      ...copyState(this.predicted),
      position: {
        x: this.predicted.position.x + this.correctionStartOffset.x * (1 - progress),
        y: this.predicted.position.y + this.correctionStartOffset.y * (1 - progress),
        z: this.predicted.position.z + this.correctionStartOffset.z * (1 - progress),
      },
    };
  }

  predictedState(): AuthoritativePlayerState | undefined {
    return this.predicted && copyState(this.predicted);
  }

  renderedState(): AuthoritativePlayerState | undefined {
    return this.rendered && copyState(this.rendered);
  }

  latestSnapshotPlayers(): readonly AuthoritativePlayerState[] {
    return this.latestPlayers.map(copyState);
  }

  renderedRemoteStates(nowMs = this.now()): ReadonlyMap<string, InterpolatedRemoteState> {
    return this.remotePlayers.render(nowMs);
  }

  movementActive(): boolean {
    return this.lastMovementActive;
  }

  useAbility(slot: AbilitySlot): boolean {
    if (
      this.disposed
      || !this.visible
      || this.connection !== "connected"
      || !this.playerId
      || !this.epoch
      || !this.predicted
      || !this.transport
      || this.transport.readyState !== OPEN_READY_STATE
    ) {
      return false;
    }
    if (this.nextAbilityRequestId > Number.MAX_SAFE_INTEGER) {
      this.reconnect("Ability request range exhausted");
      return false;
    }
    if (isAbilityOnGlobalCooldown(this.predicted.combat, slot, this.serverTick)) {
      return false;
    }

    const request: AbilityUseMessage = {
      type: "ability_use",
      protocolVersion: PROTOCOL_VERSION,
      epoch: this.epoch,
      requestId: this.nextAbilityRequestId,
      slot,
    };
    let encoded: string;
    try {
      encoded = encodeClientMessage(request);
    } catch (error) {
      this.reconnect(`Failed to encode ability command: ${String(error)}`);
      return false;
    }

    this.sentAbilityRequests.add(request.requestId);
    this.nextAbilityRequestId += 1;
    try {
      this.transport.send(encoded);
    } catch (error) {
      this.reconnect(`Failed to send ability command: ${String(error)}`);
      return false;
    }
    return true;
  }

  changeClass(classId: PlayerClassId): boolean {
    if (
      this.disposed
      || !this.visible
      || this.connection !== "connected"
      || !this.epoch
      || !this.transport
      || this.transport.readyState !== OPEN_READY_STATE
    ) return false;
    try {
      this.transport.send(encodeClientMessage({
        type: "class_change",
        protocolVersion: PROTOCOL_VERSION,
        epoch: this.epoch,
        classId,
      }));
    } catch (error) {
      this.reconnect(`Failed to change class: ${String(error)}`);
      return false;
    }
    return true;
  }

  combatState(): ClientCombatState {
    return {
      player: this.predicted?.combat === undefined ? undefined : structuredClone(this.predicted.combat),
      boss: this.boss === undefined ? undefined : structuredClone(this.boss),
      projectiles: this.projectiles.map((projectile) => structuredClone(projectile)),
    };
  }

  diagnostics(): PredictionDiagnostics {
    const oldest = this.pending[0];
    return {
      connection: this.connection,
      ...(this.playerId === undefined ? {} : { localPlayerId: this.playerId }),
      serverTick: this.serverTick,
      snapshotSequence: Math.max(0, this.lastSnapshotSequence),
      ...(this.rttMs === undefined ? {} : { rttMs: this.rttMs }),
      ...(this.jitterMs === undefined ? {} : { jitterMs: this.jitterMs }),
      pendingCount: this.pending.length,
      oldestPendingAgeMs: oldest ? Math.max(0, this.now() - oldest.producedAtMs) : 0,
      lastSentSequence: this.nextSequence - 1,
      lastAcknowledgedSequence: this.lastAcknowledgedSequence,
      latestCorrectionMeters: this.latestCorrectionMeters,
      maxCorrectionMeters: this.maxCorrectionMeters,
      correctionCount: this.correctionCount,
      ...(this.predicted === undefined ? {} : {
        controlMode: this.predicted.control.mode,
        controlRevision: this.predicted.control.revision,
        stateRevision: this.predicted.stateRevision,
      }),
      resyncCount: this.resyncCount,
      interpolation: this.remotePlayers.diagnostics(),
      ...(this.detail === undefined ? {} : { detail: this.detail }),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.intervalHandle !== undefined) this.cancelInterval(this.intervalHandle);
    this.cancelReconnect();
    const oldTransport = this.transport;
    this.detachTransport();
    this.clearSession();
    if (oldTransport && oldTransport.readyState <= OPEN_READY_STATE) oldTransport.close(1000, "Client disposed");
    this.connection = "idle";
  }

  private readonly onOpen = (): void => {
    this.lastAdvanceMs = this.now();
    this.setConnection("awaiting_baseline");
  };

  private readonly onMessage = (event: unknown): void => {
    const data = (event as TransportMessageEvent).data;
    if (typeof data !== "string") {
      this.reconnect("Non-text server message");
      return;
    }
    const decoded = decodeServerMessage(data);
    if (!decoded.success) {
      this.reconnect(`Invalid server message: ${decoded.error.code}`);
      return;
    }
    this.handleServerMessage(decoded.data);
  };

  private readonly onClose = (): void => {
    if (this.disposed || this.connection === "full") return;
    this.detachTransport();
    this.clearSession();
    this.setConnection("disconnected", "Connection closed; retrying");
    this.scheduleReconnect();
  };

  private readonly onError = (): void => {
    if (this.connection !== "full") this.setConnection("error", "WebSocket transport error");
  };

  private handleServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case "welcome":
        this.acceptWelcome(message);
        break;
      case "snapshot":
        this.acceptSnapshot(message);
        break;
      case "ability_result":
        this.acceptAbilityResult(message);
        break;
      case "class_change_result":
        this.acceptClassChangeResult(message);
        break;
      case "pong":
        this.acceptPong(message.nonce);
        break;
      case "server_full":
        this.setConnection("full", message.message);
        this.clearSession();
        this.cancelReconnect();
        break;
      case "protocol_error":
        this.reconnect(`Protocol error (${message.code}): ${message.message}`);
        break;
    }
  }

  private acceptWelcome(message: WelcomeMessage): void {
    if (this.connection !== "awaiting_baseline") return;
    const local = message.baseline.players.find((player) => player.playerId === message.playerId);
    if (!local) {
      this.reconnect("Welcome baseline omitted the local player");
      return;
    }
    this.playerId = message.playerId;
    this.epoch = message.epoch;
    this.predicted = copyState(local);
    this.rendered = copyState(local);
    this.latestPlayers = message.baseline.players.map(copyState);
    this.boss = structuredClone(message.baseline.boss);
    this.projectiles = message.baseline.projectiles.map((projectile) => structuredClone(projectile));
    this.remotePlayers.acceptBaseline(
      message.epoch,
      message.playerId,
      message.baseline.snapshotSequence,
      message.baseline.serverTick,
      message.baseline.players,
      this.now(),
    );
    this.lastSnapshotSequence = message.baseline.snapshotSequence;
    this.serverTick = message.baseline.serverTick;
    this.lastAcknowledgedSequence = local.lastProcessedInputSequence;
    this.nextSequence = local.lastProcessedInputSequence + 1;
    this.clientTick = message.initialServerTick;
    this.nextAbilityRequestId = 1;
    this.pending = [];
    this.accumulatorMs = 0;
    this.lastAdvanceMs = this.now();
    this.nextPingAtMs = this.lastAdvanceMs;
    this.detail = undefined;
    this.setConnection("connected");
  }

  private acceptSnapshot(message: SnapshotMessage): void {
    if (!this.epoch || message.epoch !== this.epoch || message.snapshotSequence <= this.lastSnapshotSequence) return;
    const authoritative = message.players.find((player) => player.playerId === this.playerId);
    if (!authoritative || !this.predicted || !this.rendered) {
      this.reconnect("Snapshot omitted the local player");
      return;
    }
    if (authoritative.lastProcessedInputSequence < this.lastAcknowledgedSequence
      || authoritative.lastProcessedInputSequence > this.nextSequence - 1) {
      this.reconnect("Irrecoverable input acknowledgement");
      return;
    }

    const previousPredicted = this.predicted;
    const revisionChanged = authoritative.stateRevision !== previousPredicted.stateRevision;
    this.lastSnapshotSequence = message.snapshotSequence;
    this.serverTick = message.serverTick;
    this.latestPlayers = message.players.map(copyState);
    this.boss = structuredClone(message.boss);
    this.projectiles = message.projectiles.map((projectile) => structuredClone(projectile));
    this.remotePlayers.acceptSnapshot(
      message.epoch,
      message.snapshotSequence,
      message.serverTick,
      message.players,
      this.now(),
    );
    this.lastAcknowledgedSequence = authoritative.lastProcessedInputSequence;
    this.pending = this.pending.filter(({ command }) => command.sequence > this.lastAcknowledgedSequence);

    if (revisionChanged) {
      this.resetFenceSequence = this.nextSequence - 1 > this.lastAcknowledgedSequence
        ? this.nextSequence - 1
        : undefined;
      this.pending = [];
      this.predicted = copyState(authoritative);
      this.snapRendered();
      this.recordCorrection(distance(previousPredicted.position, authoritative.position));
      this.emitDiagnostics();
      return;
    }
    if (this.resetFenceSequence !== undefined) {
      this.predicted = copyState(authoritative);
      this.snapRendered();
      if (this.lastAcknowledgedSequence >= this.resetFenceSequence) this.resetFenceSequence = undefined;
      this.emitDiagnostics();
      return;
    }

    let replayed = copyState(authoritative);
    for (const { command } of this.pending) {
      replayed = stepPlayer(replayed, permittedInput(replayed, command), FIXED_DELTA_SECONDS);
    }
    const correction = distance(previousPredicted.position, replayed.position);
    this.predicted = replayed;
    this.applyVisualCorrection(correction);
    this.recordCorrection(correction);
    this.emitDiagnostics();
  }

  private acceptAbilityResult(message: AbilityResultMessage): void {
    if (!this.epoch || message.epoch !== this.epoch) return;
    if (this.deliveredAbilityResults.has(message.requestId)) return;
    if (message.requestId >= this.nextAbilityRequestId) {
      this.reconnect("Received an impossible future ability result");
      return;
    }
    if (!this.sentAbilityRequests.has(message.requestId)) return;
    if (!this.playerId || !this.predicted || !this.rendered) {
      this.reconnect("Ability result arrived without initialized local state");
      return;
    }

    const combat = structuredClone(message.combat);
    this.predicted = { ...this.predicted, combat: structuredClone(combat) };
    this.rendered = { ...this.rendered, combat: structuredClone(combat) };
    this.latestPlayers = this.latestPlayers.map((player) => player.playerId === this.playerId
      ? { ...player, combat: structuredClone(combat) }
      : player);
    this.deliveredAbilityResults.add(message.requestId);
    this.options.onAbilityResult?.(structuredClone(message));
  }

  private acceptClassChangeResult(message: ClassChangeResultMessage): void {
    if (!this.epoch || message.epoch !== this.epoch || !this.playerId || !this.predicted || !this.rendered) return;
    const combat = structuredClone(message.combat);
    this.predicted = { ...this.predicted, combat: structuredClone(combat) };
    this.rendered = { ...this.rendered, combat: structuredClone(combat) };
    this.latestPlayers = this.latestPlayers.map((player) => player.playerId === this.playerId
      ? { ...player, combat: structuredClone(combat) }
      : player);
  }

  private produceCommand(nowMs: number): boolean {
    if (!this.predicted || !this.epoch || !this.transport || this.transport.readyState !== OPEN_READY_STATE) return false;
    if (this.nextSequence > Number.MAX_SAFE_INTEGER || this.clientTick >= Number.MAX_SAFE_INTEGER) {
      this.reconnect("Sequence range exhausted");
      return false;
    }
    const intent = this.options.sampleIntent();
    const command: InputMessage = {
      type: "input",
      protocolVersion: PROTOCOL_VERSION,
      epoch: this.epoch,
      sequence: this.nextSequence,
      clientTick: this.clientTick + 1,
      moveX: intent.moveX,
      moveZ: intent.moveZ,
      jump: intent.jump,
    };
    let encoded: string;
    try {
      encoded = encodeClientMessage(command);
      this.transport.send(encoded);
    } catch (error) {
      this.reconnect(`Failed to send input command: ${String(error)}`);
      return false;
    }
    this.lastMovementActive = command.moveX !== 0 || command.moveZ !== 0;
    const before = this.predicted;
    const after = stepPlayer(before, permittedInput(before, command), FIXED_DELTA_SECONDS);
    this.predicted = after;
    if (this.rendered) {
      this.rendered = {
        ...copyState(after),
        position: {
          x: this.rendered.position.x + (after.position.x - before.position.x),
          y: this.rendered.position.y + (after.position.y - before.position.y),
          z: this.rendered.position.z + (after.position.z - before.position.z),
        },
      };
    }
    this.pending.push({ command, producedAtMs: nowMs });
    this.nextSequence += 1;
    this.clientTick += 1;
    return true;
  }

  private applyVisualCorrection(correction: number): void {
    if (!this.predicted || !this.rendered) return;
    if (correction <= CLIENT_NETCODE_CONFIG.visualCorrectionEpsilonMeters) {
      this.snapRendered();
      return;
    }
    if (correction >= CLIENT_NETCODE_CONFIG.visualSnapDistanceMeters) {
      this.snapRendered();
      return;
    }
    this.correctionStartOffset = {
      x: this.rendered.position.x - this.predicted.position.x,
      y: this.rendered.position.y - this.predicted.position.y,
      z: this.rendered.position.z - this.predicted.position.z,
    };
    this.correctionElapsedMs = 0;
  }

  private snapRendered(): void {
    if (!this.predicted) return;
    this.rendered = copyState(this.predicted);
    this.correctionStartOffset = { x: 0, y: 0, z: 0 };
    this.correctionElapsedMs = CLIENT_NETCODE_CONFIG.visualCorrectionDurationMs;
  }

  private recordCorrection(correction: number): void {
    this.latestCorrectionMeters = correction;
    this.maxCorrectionMeters = Math.max(this.maxCorrectionMeters, correction);
    if (correction > CLIENT_NETCODE_CONFIG.visualCorrectionEpsilonMeters) this.correctionCount += 1;
  }

  private maybePing(nowMs: number): void {
    if (nowMs < this.nextPingAtMs || !this.transport || this.transport.readyState !== OPEN_READY_STATE) return;
    while (this.pings.size >= CLIENT_NETCODE_CONFIG.maxOutstandingPings) {
      const oldestNonce = this.pings.keys().next().value as number | undefined;
      if (oldestNonce === undefined) break;
      this.pings.delete(oldestNonce);
    }
    const nonce = this.nextPingNonce;
    this.nextPingNonce = this.nextPingNonce >= Number.MAX_SAFE_INTEGER ? 1 : this.nextPingNonce + 1;
    this.pings.set(nonce, nowMs);
    this.transport.send(encodeClientMessage({
      type: "ping",
      protocolVersion: PROTOCOL_VERSION,
      nonce,
      sentAtMs: nowMs,
    }));
    this.nextPingAtMs = nowMs + CLIENT_NETCODE_CONFIG.pingIntervalMs;
  }

  private acceptPong(nonce: number): void {
    const sentAt = this.pings.get(nonce);
    if (sentAt === undefined) return;
    this.pings.delete(nonce);
    const sample = Math.max(0, this.now() - sentAt);
    if (this.rttMs === undefined) {
      this.rttMs = sample;
      this.jitterMs = 0;
    } else {
      const difference = Math.abs(sample - this.rttMs);
      this.rttMs += (sample - this.rttMs) * 0.125;
      this.jitterMs = (this.jitterMs ?? 0) + (difference - (this.jitterMs ?? 0)) * 0.25;
    }
    this.emitDiagnostics();
  }

  private isPendingUnsafe(nowMs: number): boolean {
    if (this.pending.length >= CLIENT_NETCODE_CONFIG.maxPendingInputs) return true;
    const oldest = this.pending[0];
    return oldest !== undefined && nowMs - oldest.producedAtMs >= CLIENT_NETCODE_CONFIG.maxPendingAgeMs;
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.connection === "full" || this.reconnectHandle !== undefined) return;
    this.reconnectHandle = this.scheduleTimeout(() => {
      this.reconnectHandle = undefined;
      this.connect();
    }, CLIENT_NETCODE_CONFIG.reconnectDelayMs);
  }

  private cancelReconnect(): void {
    if (this.reconnectHandle === undefined) return;
    this.cancelTimeout(this.reconnectHandle);
    this.reconnectHandle = undefined;
  }

  private detachTransport(): void {
    const transport = this.transport;
    if (!transport) return;
    transport.removeEventListener("open", this.onOpen);
    transport.removeEventListener("message", this.onMessage);
    transport.removeEventListener("close", this.onClose);
    transport.removeEventListener("error", this.onError);
    this.transport = undefined;
  }

  private clearSession(): void {
    this.playerId = undefined;
    this.epoch = undefined;
    this.predicted = undefined;
    this.rendered = undefined;
    this.latestPlayers = [];
    this.remotePlayers.clear();
    this.pending = [];
    this.nextSequence = 1;
    this.clientTick = 0;
    this.lastAcknowledgedSequence = 0;
    this.lastSnapshotSequence = -1;
    this.serverTick = 0;
    this.resetFenceSequence = undefined;
    this.accumulatorMs = 0;
    this.pings.clear();
    this.rttMs = undefined;
    this.jitterMs = undefined;
    this.correctionStartOffset = { x: 0, y: 0, z: 0 };
    this.correctionElapsedMs = 0;
    this.latestCorrectionMeters = 0;
    this.maxCorrectionMeters = 0;
    this.correctionCount = 0;
    this.lastMovementActive = false;
    this.boss = undefined;
    this.projectiles = [];
    this.nextAbilityRequestId = 1;
    this.sentAbilityRequests.clear();
    this.deliveredAbilityResults.clear();
  }

  private fail(detail: string): void {
    this.setConnection("error", detail);
    this.scheduleReconnect();
  }

  private setConnection(connection: ConnectionState, detail?: string): void {
    this.connection = connection;
    if (detail !== undefined) this.detail = detail;
    this.emitDiagnostics();
  }

  private emitDiagnostics(): void {
    this.options.onDiagnostics?.(this.diagnostics());
  }
}
