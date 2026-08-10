import {
  FIXED_DELTA_SECONDS,
  PROTOCOL_VERSION,
  createInitialPlayerState,
  stepPlayer,
} from "@four/shared";

import { CameraController } from "./camera/index.js";
import { resolveWebSocketUrl } from "./config.js";
import { DiagnosticsOverlay } from "./diagnostics/index.js";
import { InputController } from "./input/index.js";
import {
  PredictionClient,
  createBrowserTransport,
  withNetworkConditions,
  type ConnectionState,
} from "./network/index.js";
import { createSceneRenderer, type PlayerRenderState } from "./presentation/index.js";
import "./styles.css";

const root = document.querySelector<HTMLElement>("#app");

if (root) {
  const view = createSceneRenderer(root);
  const canvas = root.querySelector<HTMLCanvasElement>(".game-canvas");
  if (!canvas) {
    throw new Error("Scene renderer did not create its game canvas");
  }
  const input = new InputController(canvas);
  const camera = new CameraController(view.camera);
  const diagnosticsOverlay = new DiagnosticsOverlay(root);
  let followedFeet = { x: 0, y: 0, z: 0 };
  let removeFrameListener: (() => void) | undefined;
  let network: PredictionClient | undefined;
  view.setStatus({
    headline: "Presentation ready",
    tone: "good",
    metrics: { protocol: `v${PROTOCOL_VERSION}` },
    ...(import.meta.env.DEV
      ? { detail: "Add ?fixture=players to preview all four player visuals." }
      : {}),
  });

  const query = new URLSearchParams(window.location.search);
  const fixture = import.meta.env.DEV ? query.get("fixture") : null;

  if (fixture === "players") {
    const samples: readonly PlayerRenderState[] = [
      { id: "local", name: "Nova", health: 100, maxHealth: 100, position: { x: -4, y: 0, z: 3 }, facing: 0, grounded: true, moving: true, isLocal: true },
      { id: "remote-a", name: "Moss", health: 82, maxHealth: 100, position: { x: 0, y: 0, z: 5 }, facing: Math.PI / 2, grounded: true, moving: true, isLocal: false },
      { id: "remote-b", name: "Pip", health: 46, maxHealth: 100, position: { x: 4, y: 1.6, z: 3 }, facing: Math.PI, grounded: false, moving: false, isLocal: false },
      { id: "remote-c", name: "Rune", health: 25, maxHealth: 100, position: { x: 0, y: 0, z: -5 }, facing: -Math.PI / 2, grounded: true, moving: false, isLocal: false },
    ];
    for (const sample of samples) {
      view.upsertPlayer(sample);
    }
    followedFeet = { ...samples[0]!.position };
    view.setStatus({
      headline: "Four-player presentation fixture",
      detail: "Local highlight, stable colors, facing, walking, idle, and airborne feet anchor.",
      tone: "good",
      metrics: { players: samples.length, pixelRatioCap: "2x" },
    });
  } else if (fixture === "movement") {
    let player = createInitialPlayerState({ playerId: "local" });
    let accumulator = 0;
    removeFrameListener = view.onFrame(({ deltaSeconds }) => {
      accumulator += Math.min(Math.max(deltaSeconds, 0), 0.25);
      while (accumulator >= FIXED_DELTA_SECONDS) {
        player = stepPlayer(player, input.sampleMovement(camera.yaw), FIXED_DELTA_SECONDS);
        accumulator -= FIXED_DELTA_SECONDS;
      }
      const renderIntent = input.sampleMovement(camera.yaw);
      followedFeet = { ...player.position };
      view.upsertPlayer({
        id: player.playerId,
        name: player.displayName,
        health: player.health,
        maxHealth: player.maxHealth,
        position: player.position,
        facing: player.facingAngle,
        grounded: player.grounded,
        moving: renderIntent.moveX !== 0 || renderIntent.moveZ !== 0,
        isLocal: true,
      });
      camera.update(followedFeet, input.consumeCameraInput(), deltaSeconds);
    });
    view.setStatus({
      headline: "Local movement + camera fixture",
      detail: "WASD/Space, either mouse button to orbit, both to move forward, wheel to zoom.",
      tone: "good",
      metrics: { simulation: "60 Hz", networking: "offline" },
    });
  } else {
    let lastConnection: ConnectionState = "idle";
    const remoteIds = new Set<string>();
    const networkConditions = import.meta.env.DEV ? parseNetworkConditions(query) : undefined;
    network = new PredictionClient({
      url: resolveWebSocketUrl(),
      transportFactory: networkConditions
        ? (url) => withNetworkConditions(createBrowserTransport(url), networkConditions)
        : createBrowserTransport,
      sampleIntent: () => input.sampleMovement(camera.yaw),
      onDiagnostics: (diagnostics) => {
        diagnosticsOverlay.update(diagnostics);
        if (diagnostics.connection !== "connected" && lastConnection === "connected") {
          input.reset();
          view.clearPlayers();
        }
        lastConnection = diagnostics.connection;
        const tone = diagnostics.connection === "connected"
          ? "good"
          : diagnostics.connection === "full" || diagnostics.connection === "error"
            ? "error"
            : diagnostics.connection === "disconnected" || diagnostics.connection === "resyncing"
              ? "warning"
              : "neutral";
        view.setStatus({
          headline: connectionHeadline(diagnostics.connection),
          ...(diagnostics.detail === undefined ? {} : { detail: diagnostics.detail }),
          tone,
          metrics: {
            protocol: `v${PROTOCOL_VERSION}`,
            pending: diagnostics.pendingCount,
            RTT: diagnostics.rttMs === undefined ? "—" : `${diagnostics.rttMs.toFixed(0)} ms`,
            ...(networkConditions ? { networkHarness: describeNetworkConditions(networkConditions) } : {}),
          },
        });
      },
    });
    network.connect();
    const onVisibilityChange = (): void => network?.setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibilityChange);
    removeFrameListener = view.onFrame(({ deltaSeconds }) => {
      const activeNetwork = network;
      if (!activeNetwork) return;
      activeNetwork.advancePresentation(deltaSeconds * 1_000);
      const rendered = activeNetwork.renderedState();
      if (rendered) {
        followedFeet = { ...rendered.position };
        view.upsertPlayer({
          id: rendered.playerId,
          name: rendered.displayName,
          health: rendered.health,
          maxHealth: rendered.maxHealth,
          position: rendered.position,
          facing: rendered.facingAngle,
          grounded: rendered.grounded,
          moving: activeNetwork.movementActive(),
          isLocal: true,
        });
      }

      const presentRemoteIds = new Set<string>();
      for (const [remoteId, remote] of activeNetwork.renderedRemoteStates()) {
        presentRemoteIds.add(remoteId);
        view.upsertPlayer({
          id: remoteId,
          name: remote.state.displayName,
          health: remote.state.health,
          maxHealth: remote.state.maxHealth,
          position: remote.state.position,
          facing: remote.state.facingAngle,
          grounded: remote.state.grounded,
          moving: remote.moving,
          isLocal: false,
        });
      }
      for (const id of remoteIds) {
        if (!presentRemoteIds.has(id)) view.removePlayer(id);
      }
      remoteIds.clear();
      for (const id of presentRemoteIds) remoteIds.add(id);
      camera.update(followedFeet, input.consumeCameraInput(), deltaSeconds);
    });
    const previousRemoveFrameListener = removeFrameListener;
    removeFrameListener = (): void => {
      previousRemoveFrameListener();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }

  if (!removeFrameListener) {
    removeFrameListener = view.onFrame(({ deltaSeconds }) => {
      camera.update(followedFeet, input.consumeCameraInput(), deltaSeconds);
    });
  }

  camera.place(followedFeet);

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    removeFrameListener?.();
    network?.dispose();
    diagnosticsOverlay.dispose();
    input.dispose();
    view.dispose();
  };
  window.addEventListener("pagehide", dispose, { once: true });
  import.meta.hot?.dispose(() => {
    window.removeEventListener("pagehide", dispose);
    dispose();
  });
}

function connectionHeadline(connection: ConnectionState): string {
  switch (connection) {
    case "idle": return "Offline";
    case "connecting": return "Connecting";
    case "awaiting_baseline": return "Waiting for baseline";
    case "connected": return "Authoritative session connected";
    case "resyncing": return "Resynchronizing";
    case "disconnected": return "Disconnected";
    case "full": return "Arena full";
    case "error": return "Connection error";
  }
}

function parseNetworkConditions(query: URLSearchParams): {
  latencyMs: number;
  jitterMs: number;
  snapshotDropRate: number;
  snapshotDuplicateRate: number;
  burstDeliveryMs: number;
  seed: number;
} | undefined {
  const halfRtt = numericQuery(query, "latency", 0, 2_000) / 2;
  const latencyMs = numericQuery(query, "netLatency", 0, 1_000, halfRtt);
  const jitterMs = numericQuery(query, "netJitter", 0, 1_000);
  const snapshotDropRate = numericQuery(query, "netDrop", 0, 1);
  const snapshotDuplicateRate = numericQuery(query, "netDuplicate", 0, 1);
  const burstDeliveryMs = numericQuery(query, "netBurst", 0, 2_000);
  const seed = Math.trunc(numericQuery(query, "netSeed", 0, 0xffff_ffff, 1));
  if (latencyMs + jitterMs + snapshotDropRate + snapshotDuplicateRate + burstDeliveryMs === 0) return undefined;
  return { latencyMs, jitterMs, snapshotDropRate, snapshotDuplicateRate, burstDeliveryMs, seed };
}

function numericQuery(
  query: URLSearchParams,
  name: string,
  minimum: number,
  maximum: number,
  fallback = 0,
): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function describeNetworkConditions(conditions: ReturnType<typeof parseNetworkConditions>): string {
  if (!conditions) return "off";
  return `${conditions.latencyMs}±${conditions.jitterMs} ms one-way · drop ${conditions.snapshotDropRate} · dup ${conditions.snapshotDuplicateRate} · burst ${conditions.burstDeliveryMs} ms · seed ${conditions.seed}`;
}
