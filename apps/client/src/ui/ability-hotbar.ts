import {
  ABILITY_SLOTS,
  getAbilityForSlot,
  globalCooldownRemainingTicks,
  isAbilityInGlobalCooldownQueueWindow,
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
}

interface SlotElements {
  readonly slot: AbilitySlot;
  readonly button: HTMLButtonElement;
  readonly key: HTMLElement;
  readonly onClick: () => void;
  lastCooldownTicks: number;
}

export class AbilityHotbar {
  readonly root: HTMLElement;

  private state: AbilityHotbarState;
  private readonly slots: SlotElements[] = [];
  private disposed = false;

  constructor(private readonly options: AbilityHotbarOptions) {
    const documentTarget = options.documentTarget ?? document;
    this.state = options.state;
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
      const cooldownOverlay = documentTarget.createElement("span");
      cooldownOverlay.className = "ability-hotbar__cooldown";
      cooldownOverlay.setAttribute("aria-hidden", "true");

      button.append(key, cooldownOverlay);
      const onClick = (): void => {
        if (!this.disposed && !button.disabled) {
          this.options.onUse(slot);
        }
      };
      button.addEventListener("click", onClick);
      this.root.append(button);
      this.slots.push({ slot, button, key, onClick, lastCooldownTicks: 0 });
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

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const elements of this.slots) {
      elements.button.removeEventListener("click", elements.onClick);
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
      const cooldownRestarted = cooldownTicks > elements.lastCooldownTicks;
      const queueWindowOpen = isAbilityInGlobalCooldownQueueWindow(
        this.state.combat,
        elements.slot,
        this.state.serverTick,
      );
      const cooldownRemaining = ability?.globalCooldownTicks === undefined
        ? 0
        : Math.min(1, cooldownTicks / ability.globalCooldownTicks);
      const enabled = this.state.connected
        && this.state.bossAlive
        && combatUsable
        && (!onGlobalCooldown || queueWindowOpen);
      const reason = !this.state.connected
        ? "Disconnected"
        : !this.state.bossAlive
          ? "Boss defeated"
          : onGlobalCooldown
            ? "Global cooldown"
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
      elements.button.disabled = !enabled;
      elements.button.style.setProperty("--gcd-remaining", `${cooldownRemaining * 360}deg`);
      elements.button.dataset.procReady = String(procReady);
      elements.button.dataset.stamp = showsStamp ? (stampEarned ? "earned" : "missing") : "hidden";
      elements.button.dataset.comboNeeded = String(comboNeeded);
      elements.button.dataset.globalCooldown = String(onGlobalCooldown);
      elements.button.dataset.cooldownRestarted = String(cooldownRestarted);
      elements.button.dataset.state = enabled ? "enabled" : "locked";
      elements.button.setAttribute(
        "aria-label",
        `${elements.slot}: ${ability?.name ?? "Unknown ability"}${ability === undefined ? "" : `, ${ability.damage} damage`}${comboNeeded ? ", needed to complete combo" : ""}${reason === "" ? "" : `, ${reason}`}`,
      );
      elements.lastCooldownTicks = cooldownTicks;
    }
  }
}
