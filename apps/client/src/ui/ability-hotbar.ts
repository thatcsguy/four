import {
  ABILITY_SLOTS,
  SIMULATION_HZ,
  getAbilityForSlot,
  globalCooldownRemainingTicks,
  isAbilitySlotUsable,
  type AbilitySlot,
  type PlayerCombatState,
} from "@four/shared";

export interface AbilityHotbarState {
  readonly combat: Readonly<PlayerCombatState>;
  readonly connected: boolean;
  readonly bossAlive: boolean;
  readonly serverTick: number;
}

export interface AbilityHotbarOptions {
  readonly state: AbilityHotbarState;
  readonly onUse: (slot: AbilitySlot) => void;
  readonly documentTarget?: Pick<Document, "createElement">;
  readonly feedbackDurationMs?: number;
}

interface SlotElements {
  readonly slot: AbilitySlot;
  readonly button: HTMLButtonElement;
  readonly key: HTMLElement;
  readonly name: HTMLElement;
  readonly damage: HTMLElement;
  readonly reason: HTMLElement;
  readonly onClick: () => void;
}

const DEFAULT_FEEDBACK_DURATION_MS = 450;

export class AbilityHotbar {
  readonly root: HTMLElement;

  private state: AbilityHotbarState;
  private readonly slots: SlotElements[] = [];
  private readonly feedbackTimers = new Map<AbilitySlot, ReturnType<typeof setTimeout>>();
  private readonly feedbackDurationMs: number;
  private disposed = false;

  constructor(private readonly options: AbilityHotbarOptions) {
    const documentTarget = options.documentTarget ?? document;
    this.state = options.state;
    this.feedbackDurationMs = options.feedbackDurationMs ?? DEFAULT_FEEDBACK_DURATION_MS;
    this.root = documentTarget.createElement("nav");
    this.root.className = "ability-hotbar";
    this.root.setAttribute("aria-label", "Abilities");

    for (const slot of ABILITY_SLOTS) {
      const button = documentTarget.createElement("button");
      button.type = "button";
      button.className = "ability-hotbar__slot";
      button.setAttribute("aria-keyshortcuts", String(slot));

      const key = documentTarget.createElement("kbd");
      key.className = "ability-hotbar__key";
      const name = documentTarget.createElement("span");
      name.className = "ability-hotbar__name";
      const damage = documentTarget.createElement("span");
      damage.className = "ability-hotbar__damage";
      const reason = documentTarget.createElement("span");
      reason.className = "ability-hotbar__reason";

      button.append(key, name, damage, reason);
      const onClick = (): void => {
        if (!this.disposed && !button.disabled) {
          this.options.onUse(slot);
        }
      };
      button.addEventListener("click", onClick);
      this.root.append(button);
      this.slots.push({ slot, button, key, name, damage, reason, onClick });
    }
    this.render();
  }

  setState(state: AbilityHotbarState): void {
    if (this.disposed) {
      return;
    }
    this.state = state;
    this.render();
  }

  showFeedback(slot: AbilitySlot, accepted: boolean): void {
    if (this.disposed) {
      return;
    }
    const elements = this.slots.find((candidate) => candidate.slot === slot);
    if (elements === undefined) {
      return;
    }
    const priorTimer = this.feedbackTimers.get(slot);
    if (priorTimer !== undefined) {
      clearTimeout(priorTimer);
    }
    elements.button.dataset.feedback = accepted ? "accepted" : "rejected";
    const timer = setTimeout(() => {
      delete elements.button.dataset.feedback;
      this.feedbackTimers.delete(slot);
    }, this.feedbackDurationMs);
    this.feedbackTimers.set(slot, timer);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const timer of this.feedbackTimers.values()) {
      clearTimeout(timer);
    }
    this.feedbackTimers.clear();
    for (const elements of this.slots) {
      elements.button.removeEventListener("click", elements.onClick);
      delete elements.button.dataset.feedback;
    }
  }

  private render(): void {
    for (const elements of this.slots) {
      const ability = getAbilityForSlot(this.state.combat.classId, elements.slot);
      const combatUsable = isAbilitySlotUsable(this.state.combat, elements.slot);
      const cooldownTicks = ability?.globalCooldownTicks === undefined
        ? 0
        : globalCooldownRemainingTicks(this.state.combat, this.state.serverTick);
      const onGlobalCooldown = cooldownTicks > 0;
      const enabled = this.state.connected && this.state.bossAlive && combatUsable && !onGlobalCooldown;
      const reason = !this.state.connected
        ? "Disconnected"
        : !this.state.bossAlive
          ? "Boss defeated"
          : onGlobalCooldown
            ? `GCD ${Math.max(0.1, cooldownTicks / SIMULATION_HZ).toFixed(1)}s`
          : !combatUsable
            ? this.state.combat.classId === "samurai" && elements.slot === 4
              ? "Requires 3 stamps"
              : "Requires proc"
            : "";
      const procReady = (ability?.requiredBuffId !== undefined || (ability?.requiredBuffIds?.length ?? 0) > 0)
        && combatUsable;
      const stampId = `samurai_stamp_${elements.slot}`;
      const showsStamp = this.state.combat.classId === "samurai" && elements.slot <= 3;
      const stampEarned = showsStamp && this.state.combat.buffs.some(
        (buff) => buff.buffId === stampId && buff.stacks > 0,
      );
      const comboStarted = this.state.combat.classId === "samurai" && this.state.combat.buffs.some(
        (buff) => /^samurai_combo_[123]$/.test(buff.buffId) && buff.stacks > 0,
      );
      const comboStepComplete = this.state.combat.buffs.some(
        (buff) => buff.buffId === `samurai_combo_${elements.slot}` && buff.stacks > 0,
      );
      const comboNeeded = comboStarted && elements.slot <= 3 && !comboStepComplete;

      elements.key.textContent = String(elements.slot);
      elements.name.textContent = ability?.name ?? `Ability ${elements.slot}`;
      elements.damage.textContent = ability === undefined ? "" : `${ability.damage} damage`;
      elements.reason.textContent = reason;
      elements.button.disabled = !enabled;
      elements.button.dataset.procReady = String(procReady);
      elements.button.dataset.stamp = showsStamp ? (stampEarned ? "earned" : "missing") : "hidden";
      elements.button.dataset.comboNeeded = String(comboNeeded);
      elements.button.dataset.globalCooldown = String(onGlobalCooldown);
      elements.button.dataset.state = enabled ? "enabled" : "locked";
      elements.button.setAttribute(
        "aria-label",
        `${elements.slot}: ${ability?.name ?? "Unknown ability"}${ability === undefined ? "" : `, ${ability.damage} damage`}${comboNeeded ? ", needed to complete combo" : ""}${reason === "" ? "" : `, ${reason}`}`,
      );
    }
  }
}
