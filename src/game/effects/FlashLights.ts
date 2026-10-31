import * as THREE from 'three';

/** Short point-light flashes for muzzles and explosions (desktop tiers only). The pool is made once and
 * idle lights stay in the scene at zero brightness: adding or removing lights would make three.js
 * recompile every lit material mid-fight. Light 0 is kept for the local player's own shots. */
export class FlashLights {
  readonly lights: THREE.PointLight[] = [];
  private readonly life: Float32Array;
  private readonly duration: Float32Array;
  private readonly peak: Float32Array;

  constructor(count: number) {
    const total = Math.max(0, Math.floor(count));
    this.life = new Float32Array(total);
    this.duration = new Float32Array(total).fill(1);
    this.peak = new Float32Array(total);
    for (let index = 0; index < total; index++) {
      const light = new THREE.PointLight('#ffb36b', 0, 8, 2);
      light.name = 'combat-flash-light';
      light.castShadow = false;
      this.lights.push(light);
    }
  }

  /** Flashes a light that fades over `duration` seconds. Others take the dimmest shared light. */
  flash(x: number, y: number, z: number, color: THREE.Color, intensity: number, distance: number, duration: number, local: boolean) {
    const count = this.lights.length;
    if (!count || !(intensity > 0) || !(duration > 0) || !(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return;
    let slot = 0;
    if (!local && count > 1) {
      slot = 1;
      for (let index = 2; index < count; index++) if (this.lights[index].intensity < this.lights[slot].intensity) slot = index;
    }
    const light = this.lights[slot];
    light.position.set(x, y, z);
    light.color.copy(color);
    light.distance = distance;
    light.intensity = intensity;
    this.peak[slot] = intensity; this.life[slot] = duration; this.duration[slot] = duration;
  }

  update(dt: number) {
    for (let index = 0; index < this.lights.length; index++) {
      if (this.life[index] <= 0) continue;
      this.life[index] -= dt;
      const remaining = Math.max(0, this.life[index] / this.duration[index]);
      this.lights[index].intensity = remaining > 0 ? this.peak[index] * remaining * remaining : 0;
    }
  }

  clear() { this.life.fill(0); for (const light of this.lights) light.intensity = 0; }

  dispose() { for (const light of this.lights) { light.removeFromParent(); light.dispose(); } }
}
