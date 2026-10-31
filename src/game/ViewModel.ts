import * as THREE from 'three';
import type { Posture, WeaponId } from '../../shared/protocol';
import { loadWeaponModels, type WeaponInstance, type WeaponLibrary } from './WeaponModels';

/** Everything the first-person arms and weapon react to, sampled each frame by GameView. */
export interface ViewModelState {
  weapon: WeaponId;
  /** Aim-down-sights blend 0..1. */
  ads: number;
  /** Sprint pose blend 0..1; `dash` raises the weapon into the faster-sprint pose. */
  sprint: number; dash: boolean;
  posture: Posture;
  /** Horizontal speed (m/s) and whether the feet are on the ground, for bob and landing. */
  speed: number; grounded: boolean;
  /** View rotation since the previous frame (radians), for sway. */
  lookDelta: { yaw: number; pitch: number };
  /** Reload progress 0..1 or -1; `reloadEmpty` selects the longer empty reload choreography. */
  reload: number; reloadEmpty: boolean;
  /** Weapon raise 0 (lowered, after swap/spawn) .. 1 (ready). */
  raise: number;
  /** Retract near walls 0..1. */
  wallBlock: number;
  /** Grenade cook 0..1, or -1. */
  cook: number;
  /** Fully scoped: hide the weapon. */
  scoped: boolean;
  reduceMotion: boolean;
}

/** First-person arms and weapon, drawn over the world with cleared depth in the same field of view.
 * Contract stub: the viewmodel workstream replaces the body; the public surface stays. */
export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.01, 10);
  readonly ready: Promise<void>;
  private library: WeaponLibrary | null = null;
  private current: WeaponInstance | null = null;
  private kick = 0;
  private disposed = false;

  constructor(renderer: THREE.WebGLRenderer) {
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#55504a', 1.4));
    this.ready = loadWeaponModels(renderer).then(library => { if (this.disposed) library.dispose(); else this.library = library; });
  }
  /** Vertical field of view (degrees) and aspect follow the world camera. */
  setProjection(fov: number, aspect: number) { this.camera.fov = fov; this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }
  update(state: ViewModelState, dt: number, _time: number) {
    if (!this.library) return;
    if (this.current?.id !== state.weapon) {
      if (this.current) this.scene.remove(this.current.root);
      this.current = this.library.weapon(state.weapon, 'view'); this.scene.add(this.current.root);
    }
    this.kick *= Math.exp(-dt * 18);
    const root = this.current.root;
    root.visible = !state.scoped;
    root.position.set(0.16 * (1 - state.ads), -0.16 + 0.06 * state.ads - (1 - state.raise) * 0.3, -0.38 + this.kick * 0.05);
  }
  fire() { this.kick = 1; }
  melee() {}
  throwGrenade() {}
  land(_intensity: number) {}
  vault() {}
  /** World-space muzzle for tracers, mapped from viewmodel space through the world camera. */
  muzzleWorld(worldCamera: THREE.Camera, target: THREE.Vector3): THREE.Vector3 {
    if (!this.current) return target.setFromMatrixPosition(worldCamera.matrixWorld);
    this.scene.updateMatrixWorld();
    this.current.anchors.muzzle.getWorldPosition(target);
    return target.applyMatrix4(worldCamera.matrixWorld);
  }
  dispose() { this.disposed = true; this.library?.dispose(); this.library = null; }
}
