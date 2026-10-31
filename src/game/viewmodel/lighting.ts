import * as THREE from 'three';
import { HEMISPHERE, SUN_COLOR, SUN_DIRECTION, SUN_INTENSITY } from '../Atmosphere';
import { approach } from './spring';

/** Peak muzzle-light intensity (candela) for a flash of strength 1. A glove 0.3 m from it gets a little
 * less light than direct sun at the peak: a warm flicker on the gun's front, not an orange glare. */
export const MUZZLE_LIGHT_CANDELA = 0.28;
/** The light sits this far ahead of the muzzle, in the flame rather than on the hands. */
export const MUZZLE_LIGHT_LEAD = 0.15;

/** Lights for the camera-space viewmodel scene that match the world: the sun and sky are rotated
 * into camera space every frame, so the gun is lit from where the sun really is as the player turns,
 * reflections come from the world's sky, and stepping into shade dims the sun on the gun too. */
export class ViewModelLighting {
  readonly sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  readonly sky = new THREE.HemisphereLight(HEMISPHERE.sky, HEMISPHERE.ground, HEMISPHERE.intensity);
  /** A faint camera-relative fill so the shaded side of the weapon still reads. */
  readonly fill = new THREE.DirectionalLight('#d6e2ee', 0.32);
  /** Muzzle flash light. While enabled it stays in the scene at zero between shots, so a shot never
   * changes the light count (which would recompile every shader); tiers without a muzzle light
   * leave it out entirely, so their shaders never pay for it. */
  readonly flash = new THREE.PointLight('#ffb466', 0, 1.2, 2);
  readonly sunDirection = new THREE.Vector3();
  private visibility = 1;
  private targetVisibility = 1;
  private readonly inverse = new THREE.Quaternion();
  private readonly up = new THREE.Vector3();

  constructor(private readonly scene: THREE.Scene, flash = true) {
    this.sun.name = 'viewmodel-sun'; this.sky.name = 'viewmodel-sky'; this.fill.name = 'viewmodel-fill'; this.flash.name = 'viewmodel-flash-light';
    this.fill.position.set(0.5, -0.25, 0.7);
    scene.add(this.sun, this.sun.target, this.sky, this.fill, this.fill.target);
    this.setFlashEnabled(flash);
    this.follow(new THREE.Quaternion());
  }

  /** Whether the muzzle light is part of the scene. */
  get flashEnabled(): boolean { return this.flash.parent === this.scene; }
  /** Adds or removes the muzzle light; changing it recompiles the viewmodel's shaders once. */
  setFlashEnabled(enabled: boolean): void {
    if (enabled === this.flashEnabled) return;
    this.flash.intensity = 0;
    if (enabled) this.scene.add(this.flash); else this.flash.removeFromParent();
  }

  /** `cameraQuaternion` is the world camera's world rotation. */
  follow(cameraQuaternion: THREE.Quaternion): void {
    this.inverse.copy(cameraQuaternion).invert();
    this.sunDirection.copy(SUN_DIRECTION).applyQuaternion(this.inverse);
    this.sun.position.copy(this.sunDirection).multiplyScalar(5);
    this.sky.position.copy(this.up.set(0, 1, 0).applyQuaternion(this.inverse));
    // r185 samples the environment with the transpose of this rotation: hand it the inverse so the
    // camera-space lookup lands on the world direction.
    this.scene.environmentRotation.setFromQuaternion(this.inverse);
  }

  /** 0 in full shade .. 1 in direct sun, matching the characters' sun visibility. */
  setSunVisibility(value: number): void { this.targetVisibility = Number.isFinite(value) ? THREE.MathUtils.clamp(value, 0, 1) : 1; }
  get sunVisibility(): number { return this.visibility; }

  /** `flash` is the flash strength this frame (0 = none) and `flashPosition` where it burns. */
  update(dt: number, flash: number, flashPosition: THREE.Vector3 | null): void {
    this.visibility = approach(this.visibility, this.targetVisibility, 5, dt);
    this.sun.intensity = SUN_INTENSITY * (0.08 + 0.92 * this.visibility);
    this.flash.intensity = this.flashEnabled && flash > 0 ? flash * MUZZLE_LIGHT_CANDELA : 0;
    if (flashPosition) this.flash.position.copy(flashPosition);
  }

  dispose(): void {
    this.sun.dispose(); this.sky.dispose(); this.fill.dispose(); this.flash.dispose();
    this.sun.removeFromParent(); this.sun.target.removeFromParent(); this.sky.removeFromParent();
    this.fill.removeFromParent(); this.fill.target.removeFromParent(); this.flash.removeFromParent();
  }
}
