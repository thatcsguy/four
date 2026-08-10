const DEFAULT_WS_PORT = "8080";

export const CLIENT_NETCODE_CONFIG = {
  /** At most 83.3 ms of commands are produced after a foreground stall. */
  maxCatchUpSteps: 5,
  maxPendingInputs: 120,
  maxPendingAgeMs: 2_000,
  reconnectDelayMs: 750,
  pingIntervalMs: 1_000,
  maxOutstandingPings: 4,
  /** Remotes render behind estimated server time to retain two interpolation samples. */
  remoteInterpolationDelayMs: 100,
  remoteHistoryMaxSamples: 48,
  remoteHistoryMaxAgeMs: 2_000,
  /** Slowly follows transport jitter without making presentation time jump. */
  remoteClockOffsetSmoothing: 0.1,
  /** Below 0.5 mm there is no useful visible correction. */
  visualCorrectionEpsilonMeters: 0.0005,
  /** Larger discontinuities are clearer and safer as immediate snaps. */
  visualSnapDistanceMeters: 1,
  visualCorrectionDurationMs: 120,
} as const;

function validateWebSocketUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError("VITE_WS_URL must use the ws: or wss: protocol");
  }
  return url.toString();
}

export function resolveWebSocketUrl(
  pageLocation: Pick<Location, "protocol" | "hostname" | "host"> = window.location,
): string {
  const override = import.meta.env.VITE_WS_URL?.trim();
  if (override) {
    return validateWebSocketUrl(override);
  }

  const protocol = pageLocation.protocol === "https:" ? "wss:" : "ws:";
  const configuredPort = import.meta.env.VITE_WS_PORT?.trim();
  if (import.meta.env.PROD && !configuredPort) {
    return `${protocol}//${pageLocation.host}`;
  }
  const port = configuredPort || DEFAULT_WS_PORT;
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
    throw new TypeError("VITE_WS_PORT must be an integer between 1 and 65535");
  }

  return `${protocol}//${pageLocation.hostname}:${port}`;
}
