import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import { PredictionClient } from "../../client/src/network/prediction-client.ts";
import { withNetworkConditions } from "../../client/src/network/transport.ts";
import { GameServer } from "./game-server.ts";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function nodeTransport(url) {
  const socket = new WebSocket(url);
  const listenerMaps = new Map();
  return {
    get readyState() {
      return socket.readyState;
    },
    send(data) {
      socket.send(data);
    },
    close(code, reason) {
      socket.close(code, reason);
    },
    addEventListener(type, listener) {
      const wrapped = type === "message"
        ? (event) => listener({ data: typeof event.data === "string" ? event.data : event.data.toString() })
        : listener;
      const byType = listenerMaps.get(type) ?? new Map();
      byType.set(listener, wrapped);
      listenerMaps.set(type, byType);
      socket.addEventListener(type, wrapped);
    },
    removeEventListener(type, listener) {
      const byType = listenerMaps.get(type);
      const wrapped = byType?.get(listener);
      if (wrapped) {
        socket.removeEventListener(type, wrapped);
        byType.delete(listener);
      }
    },
  };
}

async function waitFor(condition, timeoutMs = 2_000) {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error("Timed out waiting for real-server integration state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("prediction client against the real authoritative server", () => {
  it("predicts immediately, drains acknowledgements, and converges exactly", async () => {
    const server = new GameServer({ autoTick: true, logger: silentLogger });
    const address = await server.start();
    const client = new PredictionClient({
      url: address.url,
      transportFactory: nodeTransport,
      sampleIntent: () => ({ moveX: 1, moveZ: 0, jump: false }),
    });

    try {
      client.connect();
      await waitFor(() => client.diagnostics().connection === "connected");
      const baselineX = client.predictedState().position.x;
      await waitFor(() => client.diagnostics().lastSentSequence >= 12);
      expect(client.predictedState().position.x).toBeGreaterThan(baselineX);

      client.setVisible(false);
      await waitFor(() => client.diagnostics().pendingCount === 0);
      const localId = client.diagnostics().localPlayerId;
      const authoritative = client.latestSnapshotPlayers().find((player) => player.playerId === localId);
      expect(authoritative).toBeDefined();
      expect(client.predictedState()).toEqual(authoritative);
      expect(client.diagnostics().lastAcknowledgedSequence).toBe(client.diagnostics().lastSentSequence);
      expect(client.diagnostics().connection).toBe("connected");
    } finally {
      client.dispose();
      await server.stop();
    }
  });

  it("stays canonical under 150 ms RTT, jitter, snapshot loss/duplication, and bursts", async () => {
    const server = new GameServer({ autoTick: true, logger: silentLogger });
    const address = await server.start();
    let intent = { moveX: 1, moveZ: 0, jump: false };
    const client = new PredictionClient({
      url: address.url,
      transportFactory: (url) => withNetworkConditions(nodeTransport(url), {
        latencyMs: 75,
        jitterMs: 20,
        snapshotDropRate: 0.1,
        snapshotDuplicateRate: 0.2,
        burstDeliveryMs: 20,
        seed: 2026,
      }),
      sampleIntent: () => intent,
    });

    try {
      client.connect();
      await waitFor(() => client.diagnostics().connection === "connected", 3_000);
      await waitFor(() => client.diagnostics().lastSentSequence >= 60, 3_000).catch((error) => {
        throw new Error(`${error.message}: ${JSON.stringify(client.diagnostics())}`);
      });
      intent = { moveX: 0, moveZ: 0, jump: false };
      await waitFor(() => client.diagnostics().lastSentSequence >= 72, 2_000);
      client.setVisible(false);
      await waitFor(() => client.diagnostics().pendingCount === 0, 3_000);

      const diagnostics = client.diagnostics();
      const authoritative = client.latestSnapshotPlayers().find(
        (player) => player.playerId === diagnostics.localPlayerId,
      );
      expect(authoritative).toBeDefined();
      expect(client.predictedState()).toEqual(authoritative);
      expect(diagnostics.rttMs).toBeGreaterThanOrEqual(100);
      expect(diagnostics.maxCorrectionMeters).toBeLessThan(1);
      expect(diagnostics.resyncCount).toBe(0);
      expect(server.diagnostics().activePlayers).toBe(1);
    } finally {
      client.dispose();
      await server.stop();
    }
  }, 12_000);
});
