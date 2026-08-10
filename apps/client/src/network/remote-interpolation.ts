import {
  SIMULATION_HZ,
  type AuthoritativePlayerState,
} from "@four/shared";

import { CLIENT_NETCODE_CONFIG } from "../config.js";

const SERVER_TICK_MS = 1_000 / SIMULATION_HZ;
const MOVEMENT_EPSILON_METERS = 0.0001;

export interface RemoteSample {
  readonly serverTick: number;
  readonly snapshotSequence: number;
  readonly state: AuthoritativePlayerState;
  readonly receivedAtLocalTime: number;
}

export interface InterpolatedRemoteState {
  readonly state: AuthoritativePlayerState;
  readonly moving: boolean;
}

export interface RemoteBufferDiagnostics {
  readonly playerId: string;
  readonly depth: number;
  readonly sampleSpanMs: number;
}

export interface RemoteInterpolationDiagnostics {
  readonly interpolationDelayMs: number;
  readonly remoteCount: number;
  readonly totalBufferDepth: number;
  readonly minBufferDepth: number;
  readonly maxBufferDepth: number;
  readonly oldestNewestSpanMs: number;
  readonly underrunCount: number;
  readonly extrapolationCount: number;
  readonly buffers: readonly RemoteBufferDiagnostics[];
}

export interface RemoteInterpolationOptions {
  readonly interpolationDelayMs?: number;
  readonly maxSamples?: number;
  readonly maxAgeMs?: number;
  readonly clockOffsetSmoothing?: number;
}

interface RemoteHistory {
  revision: number;
  samples: RemoteSample[];
}

function copyState(state: Readonly<AuthoritativePlayerState>): AuthoritativePlayerState {
  return structuredClone(state);
}

function normalizeAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

export function interpolateFacing(from: number, to: number, amount: number): number {
  const shortestArc = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return normalizeAngle(from + shortestArc * amount);
}

function movedBetween(a: RemoteSample, b: RemoteSample): boolean {
  return Math.hypot(
    b.state.position.x - a.state.position.x,
    b.state.position.y - a.state.position.y,
    b.state.position.z - a.state.position.z,
  ) > MOVEMENT_EPSILON_METERS;
}

export class RemotePlayerInterpolator {
  private readonly interpolationDelayMs: number;
  private readonly maxSamples: number;
  private readonly maxAgeMs: number;
  private readonly clockOffsetSmoothing: number;
  private readonly histories = new Map<string, RemoteHistory>();
  private epoch: string | undefined;
  private localPlayerId: string | undefined;
  private lastSnapshotSequence = -1;
  private estimatedClockOffsetMs: number | undefined;
  private underrunCount = 0;

  constructor(options: RemoteInterpolationOptions = {}) {
    this.interpolationDelayMs = options.interpolationDelayMs
      ?? CLIENT_NETCODE_CONFIG.remoteInterpolationDelayMs;
    this.maxSamples = options.maxSamples ?? CLIENT_NETCODE_CONFIG.remoteHistoryMaxSamples;
    this.maxAgeMs = options.maxAgeMs ?? CLIENT_NETCODE_CONFIG.remoteHistoryMaxAgeMs;
    this.clockOffsetSmoothing = options.clockOffsetSmoothing
      ?? CLIENT_NETCODE_CONFIG.remoteClockOffsetSmoothing;
    if (this.interpolationDelayMs < 0 || this.maxSamples < 1 || this.maxAgeMs < 0
      || this.clockOffsetSmoothing < 0 || this.clockOffsetSmoothing > 1) {
      throw new RangeError("Invalid remote interpolation tuning");
    }
  }

  acceptBaseline(
    epoch: string,
    localPlayerId: string,
    snapshotSequence: number,
    serverTick: number,
    players: readonly AuthoritativePlayerState[],
    receivedAtLocalTime: number,
  ): void {
    this.clear();
    this.epoch = epoch;
    this.localPlayerId = localPlayerId;
    this.lastSnapshotSequence = snapshotSequence;
    this.observeServerClock(serverTick, receivedAtLocalTime);
    this.replaceMembership(players, serverTick, snapshotSequence, receivedAtLocalTime);
  }

  acceptSnapshot(
    epoch: string,
    snapshotSequence: number,
    serverTick: number,
    players: readonly AuthoritativePlayerState[],
    receivedAtLocalTime: number,
  ): boolean {
    if (epoch !== this.epoch || snapshotSequence <= this.lastSnapshotSequence) return false;
    this.lastSnapshotSequence = snapshotSequence;
    this.observeServerClock(serverTick, receivedAtLocalTime);
    this.replaceMembership(players, serverTick, snapshotSequence, receivedAtLocalTime);
    return true;
  }

  render(nowLocalTime: number): ReadonlyMap<string, InterpolatedRemoteState> {
    const rendered = new Map<string, InterpolatedRemoteState>();
    if (this.estimatedClockOffsetMs === undefined) return rendered;
    const presentationTick = (nowLocalTime - this.estimatedClockOffsetMs - this.interpolationDelayMs) / SERVER_TICK_MS;
    for (const [playerId, history] of this.histories) {
      const samples = history.samples;
      const first = samples[0];
      const newest = samples.at(-1);
      if (!first || !newest) continue;

      if (presentationTick <= first.serverTick) {
        if (presentationTick < first.serverTick) this.underrunCount += 1;
        rendered.set(playerId, { state: copyState(first.state), moving: false });
        continue;
      }
      if (presentationTick >= newest.serverTick) {
        if (presentationTick > newest.serverTick) this.underrunCount += 1;
        const previous = samples.at(-2);
        rendered.set(playerId, {
          state: copyState(newest.state),
          moving: previous === undefined ? false : movedBetween(previous, newest),
        });
        continue;
      }

      const upperIndex = samples.findIndex((sample) => sample.serverTick >= presentationTick);
      const upper = samples[upperIndex];
      const lower = samples[upperIndex - 1];
      if (!lower || !upper || upper.serverTick === lower.serverTick) {
        const nearest = upper ?? lower ?? newest;
        rendered.set(playerId, { state: copyState(nearest.state), moving: false });
        continue;
      }
      const amount = (presentationTick - lower.serverTick) / (upper.serverTick - lower.serverTick);
      const nearest = amount < 0.5 ? lower : upper;
      rendered.set(playerId, {
        state: {
          ...copyState(nearest.state),
          position: {
            x: lower.state.position.x + (upper.state.position.x - lower.state.position.x) * amount,
            y: lower.state.position.y + (upper.state.position.y - lower.state.position.y) * amount,
            z: lower.state.position.z + (upper.state.position.z - lower.state.position.z) * amount,
          },
          facingAngle: interpolateFacing(lower.state.facingAngle, upper.state.facingAngle, amount),
        },
        moving: movedBetween(lower, upper),
      });
    }
    return rendered;
  }

  diagnostics(): RemoteInterpolationDiagnostics {
    const buffers = [...this.histories].map(([playerId, history]) => {
      const first = history.samples[0];
      const newest = history.samples.at(-1);
      return {
        playerId,
        depth: history.samples.length,
        sampleSpanMs: first && newest ? (newest.serverTick - first.serverTick) * SERVER_TICK_MS : 0,
      };
    });
    const depths = buffers.map((buffer) => buffer.depth);
    return {
      interpolationDelayMs: this.interpolationDelayMs,
      remoteCount: buffers.length,
      totalBufferDepth: depths.reduce((total, depth) => total + depth, 0),
      minBufferDepth: depths.length === 0 ? 0 : Math.min(...depths),
      maxBufferDepth: depths.length === 0 ? 0 : Math.max(...depths),
      oldestNewestSpanMs: buffers.length === 0 ? 0 : Math.max(...buffers.map((buffer) => buffer.sampleSpanMs)),
      underrunCount: this.underrunCount,
      extrapolationCount: 0,
      buffers,
    };
  }

  clear(): void {
    this.histories.clear();
    this.epoch = undefined;
    this.localPlayerId = undefined;
    this.lastSnapshotSequence = -1;
    this.estimatedClockOffsetMs = undefined;
    this.underrunCount = 0;
  }

  private observeServerClock(serverTick: number, receivedAtLocalTime: number): void {
    const observedOffset = receivedAtLocalTime - serverTick * SERVER_TICK_MS;
    this.estimatedClockOffsetMs = this.estimatedClockOffsetMs === undefined
      ? observedOffset
      : this.estimatedClockOffsetMs
        + (observedOffset - this.estimatedClockOffsetMs) * this.clockOffsetSmoothing;
  }

  private replaceMembership(
    players: readonly AuthoritativePlayerState[],
    serverTick: number,
    snapshotSequence: number,
    receivedAtLocalTime: number,
  ): void {
    const presentRemoteIds = new Set<string>();
    for (const state of players) {
      if (state.playerId === this.localPlayerId) continue;
      presentRemoteIds.add(state.playerId);
      this.addSample({
        serverTick,
        snapshotSequence,
        state: copyState(state),
        receivedAtLocalTime,
      });
    }
    for (const playerId of this.histories.keys()) {
      if (!presentRemoteIds.has(playerId)) this.histories.delete(playerId);
    }
  }

  private addSample(sample: RemoteSample): void {
    let history = this.histories.get(sample.state.playerId);
    if (!history || history.revision !== sample.state.stateRevision) {
      history = { revision: sample.state.stateRevision, samples: [] };
      this.histories.set(sample.state.playerId, history);
    }
    if (history.samples.some((existing) => existing.snapshotSequence >= sample.snapshotSequence)) return;
    history.samples.push(sample);
    history.samples.sort((a, b) => a.serverTick - b.serverTick || a.snapshotSequence - b.snapshotSequence);
    const oldestAllowedTime = sample.receivedAtLocalTime - this.maxAgeMs;
    history.samples = history.samples.filter((existing) => existing.receivedAtLocalTime >= oldestAllowedTime);
    if (history.samples.length > this.maxSamples) {
      history.samples.splice(0, history.samples.length - this.maxSamples);
    }
  }
}
