export type TransportEvent = "open" | "message" | "close" | "error";

export interface TransportMessageEvent {
  readonly data: unknown;
}

export interface ClientTransport {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: TransportEvent, listener: (event: unknown) => void): void;
  removeEventListener(type: TransportEvent, listener: (event: unknown) => void): void;
}

export type TransportFactory = (url: string) => ClientTransport;

export interface NetworkConditionOptions {
  /** Constant one-way delay applied to inbound and outbound traffic. */
  readonly latencyMs?: number;
  /** Deterministic +/- one-way delay variation. */
  readonly jitterMs?: number;
  /** Snapshot-only loss probability in the inclusive range 0..1. */
  readonly snapshotDropRate?: number;
  /** Snapshot-only duplication probability in the inclusive range 0..1. */
  readonly snapshotDuplicateRate?: number;
  /** Holds inbound messages for this interval, then releases the batch together. */
  readonly burstDeliveryMs?: number;
  readonly seed?: number;
}

export function createBrowserTransport(url: string): ClientTransport {
  const socket = new WebSocket(url);
  return {
    get readyState(): number {
      return socket.readyState;
    },
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    addEventListener: (type, listener) => socket.addEventListener(type, listener as EventListener),
    removeEventListener: (type, listener) => socket.removeEventListener(type, listener as EventListener),
  };
}

function bounded(value: number | undefined, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, value));
}

function seededRandom(seed: number): () => number {
  let state = Math.trunc(seed) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function isSnapshotEvent(event: unknown): boolean {
  const data = (event as Partial<TransportMessageEvent> | null)?.data;
  if (typeof data !== "string") return false;
  try {
    const value = JSON.parse(data) as { type?: unknown };
    return value.type === "snapshot";
  } catch {
    return false;
  }
}

/**
 * Development/test transport harness. It changes delivery timing only; messages
 * remain valid production-protocol JSON and snapshot loss/duplication is scoped
 * to the receive path.
 */
export function withNetworkConditions(
  transport: ClientTransport,
  options: Readonly<NetworkConditionOptions>,
): ClientTransport {
  const latencyMs = bounded(options.latencyMs, 0, 10_000);
  const jitterMs = bounded(options.jitterMs, 0, 10_000);
  const dropRate = bounded(options.snapshotDropRate, 0, 1);
  const duplicateRate = bounded(options.snapshotDuplicateRate, 0, 1);
  const burstDeliveryMs = bounded(options.burstDeliveryMs, 0, 10_000);
  const random = seededRandom(options.seed ?? 1);
  const listenerWrappers = new Map<TransportEvent, Map<(event: unknown) => void, (event: unknown) => void>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const burstQueue: Array<() => void> = [];
  let burstTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let lastInboundDueAt = 0;
  let lastOutboundDueAt = 0;

  const schedule = (callback: () => void, delayMs: number): void => {
    const handle = setTimeout(() => {
      timers.delete(handle);
      if (!closed) callback();
    }, delayMs);
    timers.add(handle);
  };
  const networkDelay = (): number => Math.max(0, latencyMs + (random() * 2 - 1) * jitterMs);
  const orderedNetworkDelay = (direction: "inbound" | "outbound"): number => {
    const now = performance.now();
    const candidate = now + networkDelay();
    const previous = direction === "inbound" ? lastInboundDueAt : lastOutboundDueAt;
    // Browsers and Node round timer delays; a small gap keeps reliable frames
    // ordered even when adjacent jitter samples would otherwise share a bucket.
    const dueAt = Math.max(candidate, previous + 2);
    if (direction === "inbound") lastInboundDueAt = dueAt;
    else lastOutboundDueAt = dueAt;
    return Math.max(0, dueAt - now);
  };
  const deliverInbound = (callback: () => void): void => {
    if (burstDeliveryMs === 0) {
      schedule(callback, orderedNetworkDelay("inbound"));
      return;
    }
    schedule(() => {
      burstQueue.push(callback);
      if (burstTimer !== undefined) return;
      burstTimer = setTimeout(() => {
        timers.delete(burstTimer!);
        burstTimer = undefined;
        const batch = burstQueue.splice(0);
        if (!closed) batch.forEach((deliver) => deliver());
      }, burstDeliveryMs);
      timers.add(burstTimer);
    }, orderedNetworkDelay("inbound"));
  };

  return {
    get readyState(): number {
      return transport.readyState;
    },
    send(data): void {
      schedule(() => {
        if (transport.readyState === 1) transport.send(data);
      }, orderedNetworkDelay("outbound"));
    },
    close(code, reason): void {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      burstQueue.length = 0;
      burstTimer = undefined;
      transport.close(code, reason);
    },
    addEventListener(type, listener): void {
      const byType = listenerWrappers.get(type) ?? new Map();
      const wrapped = type === "message"
        ? (event: unknown): void => {
          const snapshot = isSnapshotEvent(event);
          if (snapshot && random() < dropRate) return;
          deliverInbound(() => {
            if (byType.get(listener) === undefined) return;
            listener(event);
            if (snapshot && random() < duplicateRate) listener(event);
          });
        }
        : type === "close"
          ? (event: unknown): void => deliverInbound(() => {
            if (byType.get(listener) !== undefined) listener(event);
          })
          : listener;
      byType.set(listener, wrapped);
      listenerWrappers.set(type, byType);
      transport.addEventListener(type, wrapped);
    },
    removeEventListener(type, listener): void {
      const byType = listenerWrappers.get(type);
      const wrapped = byType?.get(listener);
      if (wrapped) {
        transport.removeEventListener(type, wrapped);
        byType?.delete(listener);
      }
    },
  };
}

/** Backward-compatible fixed-RTT helper used by earlier fixtures. */
export function withArtificialLatency(transport: ClientTransport, roundTripMs: number): ClientTransport {
  return withNetworkConditions(transport, { latencyMs: Math.max(0, roundTripMs / 2) });
}
