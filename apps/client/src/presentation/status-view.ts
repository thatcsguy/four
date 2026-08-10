export type StatusTone = "neutral" | "good" | "warning" | "error";

export interface StatusContent {
  readonly headline: string;
  readonly detail?: string;
  readonly tone?: StatusTone;
  readonly metrics?: Readonly<Record<string, string | number>>;
}

export class StatusView {
  readonly element: HTMLElement;

  private readonly headline: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly metrics: HTMLElement;

  constructor() {
    this.element = document.createElement("aside");
    this.element.className = "status-panel";
    this.element.setAttribute("aria-live", "polite");

    this.headline = document.createElement("strong");
    this.headline.className = "status-panel__headline";
    this.detail = document.createElement("span");
    this.detail.className = "status-panel__detail";
    this.metrics = document.createElement("dl");
    this.metrics.className = "status-panel__metrics";
    this.element.append(this.headline, this.detail, this.metrics);
  }

  set(content: StatusContent): void {
    this.element.dataset.tone = content.tone ?? "neutral";
    this.headline.textContent = content.headline;
    this.detail.textContent = content.detail ?? "";
    this.detail.hidden = !content.detail;
    this.metrics.replaceChildren();

    for (const [label, value] of Object.entries(content.metrics ?? {})) {
      const term = document.createElement("dt");
      term.textContent = label;
      const definition = document.createElement("dd");
      definition.textContent = String(value);
      this.metrics.append(term, definition);
    }
    this.metrics.hidden = !content.metrics || Object.keys(content.metrics).length === 0;
  }
}
