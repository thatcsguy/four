import { afterEach, describe, expect, it, vi } from "vitest";

import {
  withNetworkConditions,
  type ClientTransport,
  type TransportEvent,
} from "./transport.js";

class FakeTransport implements ClientTransport {
  readyState = 1;
  readonly sent: string[] = [];
  readonly listeners = new Map<TransportEvent, Set<(event: unknown) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  addEventListener(type: TransportEvent, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: TransportEvent, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: TransportEvent, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

afterEach(() => vi.useRealTimers());

describe("deterministic network-condition harness", () => {
  it("applies latency in each direction without changing message bytes", () => {
    vi.useFakeTimers();
    const base = new FakeTransport();
    const harness = withNetworkConditions(base, { latencyMs: 75, seed: 42 });
    const received: unknown[] = [];
    harness.addEventListener("message", (event) => received.push(event));

    harness.send("outbound-json");
    base.emit("message", { data: "inbound-json" });
    vi.advanceTimersByTime(74);
    expect(base.sent).toEqual([]);
    expect(received).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(base.sent).toEqual(["outbound-json"]);
    expect(received).toEqual([{ data: "inbound-json" }]);
  });

  it("drops and duplicates snapshots only, never control messages", () => {
    vi.useFakeTimers();
    const droppedBase = new FakeTransport();
    const dropped = withNetworkConditions(droppedBase, { snapshotDropRate: 1, seed: 7 });
    const droppedMessages: string[] = [];
    dropped.addEventListener("message", (event) => droppedMessages.push((event as { data: string }).data));
    droppedBase.emit("message", { data: JSON.stringify({ type: "welcome" }) });
    droppedBase.emit("message", { data: JSON.stringify({ type: "snapshot" }) });
    vi.runAllTimers();
    expect(droppedMessages.map((raw) => JSON.parse(raw).type)).toEqual(["welcome"]);

    const duplicatedBase = new FakeTransport();
    const duplicated = withNetworkConditions(duplicatedBase, { snapshotDuplicateRate: 1, seed: 7 });
    const duplicatedMessages: string[] = [];
    duplicated.addEventListener("message", (event) => duplicatedMessages.push((event as { data: string }).data));
    duplicatedBase.emit("message", { data: JSON.stringify({ type: "pong" }) });
    duplicatedBase.emit("message", { data: JSON.stringify({ type: "snapshot" }) });
    vi.runAllTimers();
    expect(duplicatedMessages.map((raw) => JSON.parse(raw).type)).toEqual(["pong", "snapshot", "snapshot"]);
  });

  it("releases a deterministic burst together and cancels queued work on close", () => {
    vi.useFakeTimers();
    const base = new FakeTransport();
    const harness = withNetworkConditions(base, { burstDeliveryMs: 40, seed: 9 });
    const received: string[] = [];
    harness.addEventListener("message", (event) => received.push((event as { data: string }).data));
    base.emit("message", { data: "one" });
    base.emit("message", { data: "two" });
    vi.advanceTimersByTime(39);
    expect(received).toEqual([]);
    vi.runAllTimers();
    expect(received).toEqual(["one", "two"]);

    base.emit("message", { data: "cancelled" });
    harness.close();
    vi.runAllTimers();
    expect(received).toEqual(["one", "two"]);
    expect(base.readyState).toBe(3);
  });

  it("uses its seed to make jitter schedules reproducible", () => {
    vi.useFakeTimers();
    const arrivals = (seed: number): number[] => {
      const base = new FakeTransport();
      const harness = withNetworkConditions(base, { latencyMs: 50, jitterMs: 25, seed });
      const times: number[] = [];
      harness.addEventListener("message", () => times.push(Date.now()));
      base.emit("message", { data: "a" });
      base.emit("message", { data: "b" });
      vi.runAllTimers();
      return times;
    };
    vi.setSystemTime(0);
    const first = arrivals(123);
    vi.setSystemTime(0);
    const second = arrivals(123);
    expect(second).toEqual(first);
  });
});
