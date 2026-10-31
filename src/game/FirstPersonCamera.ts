import * as THREE from 'three';
import { EYE_HEIGHT, clamp } from '../../shared/physics';
import type { Posture, Vec3 } from '../../shared/protocol';
import { STEADY_AIM_ADS_FACTOR, STEADY_AIM_FLINCH_FACTOR } from '../../shared/weapons';

/** View kick when hit: up to about one degree upward and a little sideways; Steady Aim flinches 40% less. */
export function flinchKick(amount: number, steadyAim: boolean, random: () => number = Math.random): { yaw: number; pitch: number } {
  const strength = Math.min(1, Math.max(0, Number.isFinite(amount) ? amount : 0) / 40) * (steadyAim ? STEADY_AIM_FLINCH_FACTOR : 1);
  return { yaw: (random() - 0.5) * 0.024 * strength, pitch: 0.018 * strength };
}
/** Camera shake and a brief white-out for a blast `distance` metres away (the flash needs a clear view of it). */
export function blastFeedback(distance: number, cause: 'frag' | 'mortar' | 'drone', inSight: boolean): { shake: number; flash: number } {
  if (!Number.isFinite(distance)) return { shake: 0, flash: 0 };
  return { shake: clamp(1 - distance / (cause === 'mortar' ? 26 : 18), 0, 1), flash: inSight && distance < 9 ? 1 - Math.max(0, distance) / 9 : 0 };
}

/** Extra field of view while sprinting, in degrees. */
export const SPRINT_FOV_BONUS = 4;
/** The weapon lowers when the view meets a wall this close, and raises again beyond the second distance. */
export const WALL_BLOCK_NEAR = 0.55, WALL_BLOCK_CLEAR = 0.65;
const approach = (value: number, target: number, step: number) => value < target ? Math.min(target, value + step) : Math.max(target, value - step);
const damp = (value: number, target: number, rate: number, dt: number) => value + (target - value) * (1 - Math.exp(-rate * dt));

export interface MotionFrame {
  dt: number; grounded: boolean; vy: number; posture: Posture; sprinting: boolean;
  /** The player holds aim and the hands are free (not cooking or knifing). */
  aimWanted: boolean;
  /** Map distance along the view from the eye (metres). */
  wallDistance: number;
  adsMs: number; steadyAim: boolean;
}
/** `landed` is the fall speed of a hard landing (0 otherwise); `aim` is the new aim state when it changed. */
export interface MotionEvents { landed: number; slide: boolean; vault: boolean; aim: boolean | null }

/** First-person presentation state that changes frame to frame: aim-down-sights and sprint blends,
 * the wall retract (with hysteresis so the weapon does not flicker), and landing, slide and vault
 * transitions read from the predicted body rather than replayed physics events. */
export class FirstPersonMotion {
  ads = 0;
  sprint = 0;
  wallBlock = 0;
  fireBlocked = false;
  private airborne = false;
  private fall = 0;
  private posture: Posture = 'stand';
  private aimed = false;

  reset(posture: Posture) {
    this.ads = 0; this.sprint = 0; this.wallBlock = 0; this.fireBlocked = false;
    this.airborne = false; this.fall = 0; this.posture = posture; this.aimed = false;
  }
  /** Not in first person (dead, results): nothing is aimed, lowered or blocked. */
  leave() { this.ads = 0; this.sprint = 0; this.fireBlocked = false; this.aimed = false; }

  update(frame: MotionFrame): MotionEvents {
    const dt = Number.isFinite(frame.dt) ? clamp(frame.dt, 0, 0.1) : 0;
    let landed = 0;
    if (!frame.grounded) { this.airborne = true; this.fall = Math.max(this.fall, -frame.vy); }
    else if (this.airborne) { if (this.fall >= 2) landed = this.fall; this.airborne = false; this.fall = 0; }
    const slide = frame.posture === 'slide' && this.posture !== 'slide', vault = frame.posture === 'vault' && this.posture !== 'vault';
    this.posture = frame.posture;
    const distance = Number.isFinite(frame.wallDistance) ? frame.wallDistance : 200;
    this.fireBlocked = this.fireBlocked ? distance < WALL_BLOCK_CLEAR : distance < WALL_BLOCK_NEAR;
    this.wallBlock = damp(this.wallBlock, clamp((0.75 - distance) / 0.25, 0, 1), 12, dt);
    const aiming = frame.aimWanted && this.wallBlock < 0.5 && !frame.sprinting;
    this.ads = approach(this.ads, aiming ? 1 : 0, dt * 1000 / Math.max(1, frame.adsMs * (frame.steadyAim ? STEADY_AIM_ADS_FACTOR : 1)));
    const aim = aiming !== this.aimed ? aiming : null;
    this.aimed = aiming;
    this.sprint = damp(this.sprint, frame.sprinting ? 1 : 0, 8, dt);
    return { landed, slide, vault, aim };
  }
}
/** Camera roll while sliding. */
export const SLIDE_ROLL = THREE.MathUtils.degToRad(4);
const EYE_RATE = 14, ROLL_RATE = 10, DIP_SPRING = 14;

/** Vertical field of view (degrees) for a horizontal field of view at an aspect ratio. */
export function verticalFov(horizontalDegrees: number, aspect: number): number {
  const horizontal = THREE.MathUtils.degToRad(clamp(Number.isFinite(horizontalDegrees) ? horizontalDegrees : 90, 30, 150));
  return THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(horizontal / 2) / Math.max(0.1, Number.isFinite(aspect) ? aspect : 1)));
}
/** Magnified field of view: a divisor of 1.3 shows 30% larger, like a real optic. */
export function zoomFov(verticalDegrees: number, divisor: number): number {
  const half = THREE.MathUtils.degToRad(verticalDegrees) / 2;
  return THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(half) / Math.max(1, Number.isFinite(divisor) ? divisor : 1)));
}
/** Field of view for one frame: settings, sprint bonus and the weapon's zoom blended by aiming. */
export function cameraFov(horizontalDegrees: number, aspect: number, sprint: number, ads: number, adsZoom: number): number {
  const base = verticalFov(horizontalDegrees, aspect) + SPRINT_FOV_BONUS * clamp(sprint, 0, 1);
  return zoomFov(base, 1 + (Math.max(1, adsZoom) - 1) * clamp(ads, 0, 1));
}

/** Footfalls from distance travelled: two steps per stride cycle. */
export class Stride {
  phase = 0;
  /** Advances by horizontal travel; returns true when a foot lands. */
  update(speed: number, dt: number, stepLength: number, grounded: boolean): boolean {
    if (!grounded || !(speed > 0.4) || !(dt > 0)) return false;
    const before = Math.floor(this.phase / Math.PI);
    this.phase += speed * dt / Math.max(0.2, stepLength) * Math.PI;
    if (this.phase > 1e6) this.phase -= Math.floor(this.phase / (2 * Math.PI)) * 2 * Math.PI;
    return Math.floor(this.phase / Math.PI) !== before;
  }
}
export function stepLength(posture: Posture, sprinting: boolean, dashing: boolean): number {
  return posture === 'crouch' ? 0.55 : dashing ? 1.15 : sprinting ? 1 : 0.75;
}

export interface CameraFrame {
  dt: number;
  /** Predicted feet position after correction smoothing. */
  feet: Vec3;
  posture: Posture; grounded: boolean;
  /** Horizontal speed (m/s) and velocity, for bob and slide roll. */
  speed: number; vx: number; vz: number;
  yaw: number; pitch: number;
  /** Horizontal field of view in degrees (settings). */
  fov: number; aspect: number;
  ads: number; adsZoom: number;
  sprint: number; sprinting: boolean; dashing: boolean;
  /** Vault progress 0..1, or -1 when not vaulting. */
  vault: number;
  reduceMotion: boolean;
}
export interface CameraResult { footstep: boolean; eye: THREE.Vector3; fov: number }

/** First-person eye: posture height with smoothing, stair smoothing, bob, landing dip, slide roll,
 * vault dip and explosion shake. Rotation always equals the sent yaw/pitch (roll aside), so the
 * crosshair is exactly the server's shot ray. */
export class FirstPersonCamera {
  readonly eye = new THREE.Vector3();
  readonly stride = new Stride();
  private eyeHeight: number = EYE_HEIGHT.stand;
  private feetY = 0;
  private initialized = false;
  private dip = 0;
  private dipVelocity = 0;
  private roll = 0;
  private bob = 0;
  private shakeAmount = 0;
  private shakeTime = 0;
  private death: { from: THREE.Vector3; yaw: number; pitch: number; elapsed: number } | null = null;
  private readonly offset = new THREE.Vector3();
  private readonly look = new THREE.Quaternion();
  private readonly target = new THREE.Quaternion();
  private readonly matrix = new THREE.Matrix4();

  /** Jump the eye to a new pose (spawn, teleport); no smoothing carries over. */
  snap(feet: Vec3, posture: Posture) {
    this.feetY = feet.y; this.eyeHeight = EYE_HEIGHT[posture]; this.initialized = true;
    this.dip = 0; this.dipVelocity = 0; this.roll = 0; this.death = null;
  }
  /** Landing impulse from the fall speed (m/s). */
  land(speed: number, reduceMotion = false) {
    if (!(speed > 0)) return;
    this.dipVelocity -= Math.min(4.5, speed * 0.35) * (reduceMotion ? 0.3 : 1);
  }
  /** Explosion shake 0..1 (position only, so aim is not disturbed). */
  shake(intensity: number) { if (intensity > 0) this.shakeAmount = Math.min(1, Math.max(this.shakeAmount, intensity)); }
  get eyeOffset() { return this.eyeHeight; }

  update(camera: THREE.PerspectiveCamera, frame: CameraFrame): CameraResult {
    const dt = Number.isFinite(frame.dt) ? clamp(frame.dt, 0, 0.1) : 0;
    this.death = null;
    if (!this.initialized) this.snap(frame.feet, frame.posture);
    // Step-ups (stairs, curbs) glide; falls, jumps and teleports follow immediately.
    const rise = frame.feet.y - this.feetY;
    this.feetY = frame.grounded && rise > 0 && rise <= 0.5 ? this.feetY + rise * (1 - Math.exp(-dt * 18)) : frame.feet.y;
    this.eyeHeight += (EYE_HEIGHT[frame.posture] - this.eyeHeight) * (1 - Math.exp(-dt * EYE_RATE));
    // Critically damped landing spring.
    this.dipVelocity += (-DIP_SPRING * DIP_SPRING * this.dip - 2 * DIP_SPRING * this.dipVelocity) * dt;
    this.dip = clamp(this.dip + this.dipVelocity * dt, -0.18, 0.05);
    const motion = frame.reduceMotion ? 0 : 1;
    const footstep = this.stride.update(frame.speed, dt, stepLength(frame.posture, frame.sprinting, frame.dashing), frame.grounded && frame.posture !== 'slide' && frame.posture !== 'vault');
    const amplitude = !frame.grounded || frame.posture === 'slide' || frame.posture === 'vault' ? 0
      : clamp(frame.speed / 5, 0, 1.6) * (frame.posture === 'crouch' ? 0.02 : frame.dashing ? 0.034 : frame.sprinting ? 0.03 : 0.024) * (1 - 0.75 * clamp(frame.ads, 0, 1));
    this.bob += (amplitude * motion - this.bob) * (1 - Math.exp(-dt * 8));
    const phase = this.stride.phase;
    const lateralSpeed = frame.vx * Math.cos(frame.yaw) + frame.vz * Math.sin(frame.yaw);
    const side = frame.posture === 'slide' ? (Math.abs(lateralSpeed) > 0.5 ? Math.sign(lateralSpeed) : 1) : 0;
    this.roll += (SLIDE_ROLL * side * motion - this.roll) * (1 - Math.exp(-dt * ROLL_RATE));
    const vaultDip = frame.vault >= 0 ? -0.07 * Math.sin(Math.PI * clamp(frame.vault, 0, 1)) * (frame.reduceMotion ? 0.3 : 1) : 0;
    this.shakeTime += dt;
    this.shakeAmount = Math.max(0, this.shakeAmount - dt * 2.2);
    const shake = this.shakeAmount * this.shakeAmount * 0.06 * (frame.reduceMotion ? 0.25 : 1);
    // Bob offsets move along the view's right and world up; they never rotate the view.
    const right = { x: Math.cos(frame.yaw), z: Math.sin(frame.yaw) };
    const sway = this.bob * 0.6 * Math.sin(phase) + shake * Math.sin(this.shakeTime * 71);
    const lift = this.bob * (Math.sin(phase) ** 2 - 0.5) + this.dip + vaultDip + shake * Math.sin(this.shakeTime * 53 + 1.3);
    this.eye.set(frame.feet.x + right.x * sway, this.feetY + this.eyeHeight + lift, frame.feet.z + right.z * sway);
    camera.position.copy(this.eye);
    camera.rotation.set(frame.pitch, -frame.yaw, this.roll, 'YXZ');
    const fov = cameraFov(frame.fov, frame.aspect, frame.sprint, frame.ads, frame.adsZoom);
    if (Math.abs(camera.fov - fov) > 1e-4 || camera.aspect !== frame.aspect) { camera.fov = fov; camera.aspect = frame.aspect; camera.updateProjectionMatrix(); }
    return { footstep, eye: this.eye, fov };
  }

  /** After an elimination the view sinks and turns toward the attacker until the respawn. */
  updateDeath(camera: THREE.PerspectiveCamera, dt: number, killer: Vec3 | null, reduceMotion: boolean) {
    if (!this.death) {
      const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
      this.death = { from: camera.position.clone(), yaw: -euler.y, pitch: euler.x, elapsed: 0 };
    }
    const death = this.death;
    death.elapsed += Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    const t = 1 - Math.exp(-death.elapsed * 3);
    const floor = Math.max(0, this.feetY) + 0.45;
    camera.position.set(death.from.x, death.from.y + (floor - death.from.y) * t, death.from.z);
    this.look.setFromEuler(new THREE.Euler(death.pitch, -death.yaw, (reduceMotion ? 0.1 : 0.35) * t, 'YXZ'));
    if (killer && Number.isFinite(killer.x) && Number.isFinite(killer.y) && Number.isFinite(killer.z)) {
      this.offset.set(killer.x, killer.y + 1.2, killer.z);
      if (this.offset.distanceToSquared(camera.position) > 0.25) {
        this.matrix.lookAt(camera.position, this.offset, camera.up);
        this.target.setFromRotationMatrix(this.matrix);
        this.look.slerp(this.target, clamp((death.elapsed - 0.4) * 1.5, 0, 1));
      }
    }
    camera.quaternion.copy(this.look);
  }
}
