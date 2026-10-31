import * as THREE from 'three';
import { HEMISPHERE, SUN_COLOR, SUN_DIRECTION, SUN_INTENSITY } from '../Atmosphere';
import { approach } from './spring';

/** Lights for the camera-space viewmodel scene that match the world: the sun and sky are rotated
 * into camera space every frame, so the gun is lit from where the sun really is as the player turns,
 * reflections come from the world's sky, and stepping into shade dims the sun on the gun too. */
export class ViewModelLighting {
  readonly sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  readonly sky = new THREE.HemisphereLight(HEMISPHERE.sky, HEMISPHERE.ground, HEMISPHERE.intensity);
  /** A faint camera-relative fill so the shaded side of the weapon still reads. */
  readonly fill = new THREE.DirectionalLight('#d6e2ee', 0.32);
  /** Muzzle flash light; kept in the scene at zero so toggling it never recompiles shaders. */
  readonly flash = new THREE.PointLight('#ffb466', 0, 1.6, 2);
  readonly sunDirection = new THREE.Vector3();
  private visibility = 1;
  private targetVisibility = 1;
  private readonly inverse = new THREE.Quaternion();
  private readonly up = new THREE.Vector3();

  constructor(private readonly scene: THREE.Scene) {
    this.sun.name = 'viewmodel-sun'; this.sky.name = 'viewmodel-sky'; this.fill.name = 'viewmodel-fill'; this.flash.name = 'viewmodel-flash-light';
    this.fill.position.set(0.5, -0.25, 0.7);
    scene.add(this.sun, this.sun.target, this.sky, this.fill, this.fill.target, this.flash);
    this.follow(new THREE.Quaternion());
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

  update(dt: number, flash: number, flashPosition: THREE.Vector3 | null): void {
    this.visibility = approach(this.visibility, this.targetVisibility, 5, dt);
    this.sun.intensity = SUN_INTENSITY * (0.08 + 0.92 * this.visibility);
    this.flash.intensity = flash * 1.4;
    if (flashPosition) this.flash.position.copy(flashPosition);
  }

  dispose(): void {
    this.sun.dispose(); this.sky.dispose(); this.fill.dispose(); this.flash.dispose();
    this.sun.removeFromParent(); this.sun.target.removeFromParent(); this.sky.removeFromParent();
    this.fill.removeFromParent(); this.fill.target.removeFromParent(); this.flash.removeFromParent();
  }
}
