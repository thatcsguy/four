import { PLAYER_CLASSES, type PlayerClassId } from "@four/shared";

export interface ClassSwitcherOptions {
  readonly classId: PlayerClassId;
  readonly connected: boolean;
  readonly onSelect: (classId: PlayerClassId) => void;
  readonly documentTarget?: Pick<Document, "createElement">;
}

export class ClassSwitcher {
  readonly root: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly menu: HTMLElement;
  private readonly choices = new Map<PlayerClassId, HTMLButtonElement>();
  private classId: PlayerClassId;
  private connected: boolean;
  private open = false;

  constructor(private readonly options: ClassSwitcherOptions) {
    const documentTarget = options.documentTarget ?? document;
    this.classId = options.classId;
    this.connected = options.connected;
    this.root = documentTarget.createElement("div");
    this.root.className = "class-switcher";
    this.toggle = documentTarget.createElement("button");
    this.toggle.type = "button";
    this.toggle.className = "class-switcher__toggle";
    this.toggle.textContent = "Switch Class";
    this.toggle.setAttribute("aria-haspopup", "menu");
    this.menu = documentTarget.createElement("div");
    this.menu.className = "class-switcher__menu";
    this.menu.setAttribute("role", "menu");
    for (const playerClass of Object.values(PLAYER_CLASSES)) {
      const choice = documentTarget.createElement("button");
      choice.type = "button";
      choice.className = "class-switcher__choice";
      choice.textContent = playerClass.name;
      choice.setAttribute("role", "menuitemradio");
      choice.addEventListener("click", () => {
        if (!this.connected || playerClass.id === this.classId) return;
        this.options.onSelect(playerClass.id);
        this.setOpen(false);
      });
      this.choices.set(playerClass.id, choice);
      this.menu.append(choice);
    }
    this.toggle.addEventListener("click", () => this.setOpen(!this.open));
    this.root.append(this.toggle, this.menu);
    this.render();
  }

  setState(classId: PlayerClassId, connected: boolean): void {
    this.classId = classId;
    this.connected = connected;
    if (!connected) this.open = false;
    this.render();
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.render();
  }

  private render(): void {
    this.toggle.disabled = !this.connected;
    this.toggle.setAttribute("aria-expanded", String(this.open));
    this.menu.hidden = !this.open;
    for (const [id, choice] of this.choices) {
      const selected = id === this.classId;
      choice.disabled = !this.connected || selected;
      choice.dataset.selected = String(selected);
      choice.setAttribute("aria-checked", String(selected));
    }
  }
}
