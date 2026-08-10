import type { PredictionDiagnostics } from "../network/index.js";

export class DiagnosticsOverlay {
  readonly element: HTMLElement;

  private readonly metrics: HTMLElement;
  private visible: boolean;
  private latest: PredictionDiagnostics | undefined;
  private disposed = false;

  constructor(root: HTMLElement, initiallyVisible = import.meta.env.DEV) {
    this.visible = initiallyVisible;
    this.element = document.createElement("aside");
    this.element.className = "diagnostics-overlay";
    this.element.setAttribute("aria-label", "Network diagnostics");
    const title = document.createElement("strong");
    title.textContent = "Netcode · ` toggles";
    this.metrics = document.createElement("dl");
    this.element.append(title, this.metrics);
    root.append(this.element);
    window.addEventListener("keydown", this.onKeyDown);
    this.render();
  }

  update(diagnostics: PredictionDiagnostics): void {
    this.latest = diagnostics;
    if (this.visible) this.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("keydown", this.onKeyDown);
    this.element.remove();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== "Backquote" || event.repeat) return;
    this.visible = !this.visible;
    this.render();
  };

  private render(): void {
    this.element.hidden = !this.visible;
    if (!this.visible) return;
    const value = this.latest;
    const rows: ReadonlyArray<readonly [string, string | number]> = value ? [
      ["connection", value.connection],
      ["player", value.localPlayerId?.slice(0, 8) ?? "—"],
      ["server tick", value.serverTick],
      ["snapshot", value.snapshotSequence],
      ["RTT / jitter", `${formatMs(value.rttMs)} / ${formatMs(value.jitterMs)}`],
      ["pending / oldest", `${value.pendingCount} / ${formatMs(value.oldestPendingAgeMs)}`],
      ["sent / ack", `${value.lastSentSequence} / ${value.lastAcknowledgedSequence}`],
      ["correction latest", `${value.latestCorrectionMeters.toFixed(4)} m`],
      ["correction max / count", `${value.maxCorrectionMeters.toFixed(4)} m / ${value.correctionCount}`],
      ["control / revision", `${value.controlMode ?? "—"} / ${value.controlRevision ?? "—"}`],
      ["state revision", value.stateRevision ?? "—"],
      ["interpolation delay", formatMs(value.interpolation.interpolationDelayMs)],
      ["remote buffers", `${value.interpolation.remoteCount} / ${value.interpolation.totalBufferDepth} samples`],
      ["buffer depth min / max", `${value.interpolation.minBufferDepth} / ${value.interpolation.maxBufferDepth}`],
      ["oldest-newest span", formatMs(value.interpolation.oldestNewestSpanMs)],
      ["underruns / extrapolations", `${value.interpolation.underrunCount} / ${value.interpolation.extrapolationCount}`],
      ["resyncs", value.resyncCount],
    ] : [["connection", "idle"]];
    this.metrics.replaceChildren();
    for (const [label, metric] of rows) {
      const term = document.createElement("dt");
      term.textContent = label;
      const definition = document.createElement("dd");
      definition.textContent = String(metric);
      this.metrics.append(term, definition);
    }
  }
}

function formatMs(value: number | undefined): string {
  return value === undefined ? "—" : `${value.toFixed(1)} ms`;
}
