import * as THREE from "three";

const TEXTURE_WIDTH = 512;
const TEXTURE_HEIGHT = 128;

/** A camera-facing, depth-independent name and health display. */
export class Nameplate {
  readonly sprite: THREE.Sprite;

  private readonly canvas: HTMLCanvasElement;
  private readonly texture: THREE.CanvasTexture;
  private lastName = "";
  private lastHealth = -1;
  private lastMaxHealth = -1;

  constructor(name: string, health: number, maxHealth: number, width = 3.2) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = TEXTURE_WIDTH;
    this.canvas.height = TEXTURE_HEIGHT;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;

    const material = new THREE.SpriteMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.sprite = new THREE.Sprite(material);
    this.sprite.scale.set(width, width * (TEXTURE_HEIGHT / TEXTURE_WIDTH), 1);
    this.sprite.renderOrder = 1000;
    this.set(name, health, maxHealth);
  }

  set(name: string, health: number, maxHealth: number): void {
    if (name === this.lastName && health === this.lastHealth && maxHealth === this.lastMaxHealth) return;
    this.lastName = name;
    this.lastHealth = health;
    this.lastMaxHealth = maxHealth;

    const context = this.canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = "700 48px system-ui, sans-serif";
    context.lineWidth = 10;
    context.strokeStyle = "rgba(4, 10, 20, 0.95)";
    context.strokeText(name, TEXTURE_WIDTH / 2, 38);
    context.fillStyle = "#ffffff";
    context.fillText(name, TEXTURE_WIDTH / 2, 38);

    const x = 46;
    const y = 82;
    const width = TEXTURE_WIDTH - x * 2;
    const height = 28;
    context.fillStyle = "rgba(3, 8, 16, 0.9)";
    context.fillRect(x - 5, y - 5, width + 10, height + 10);
    context.fillStyle = "#3b1620";
    context.fillRect(x, y, width, height);
    const ratio = maxHealth > 0 ? Math.max(0, Math.min(1, health / maxHealth)) : 0;
    context.fillStyle = ratio > 0.3 ? "#36d66b" : "#ff5263";
    context.fillRect(x, y, width * ratio, height);
    context.strokeStyle = "rgba(255, 255, 255, 0.9)";
    context.lineWidth = 3;
    context.strokeRect(x, y, width, height);
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
    this.sprite.material.dispose();
  }
}
