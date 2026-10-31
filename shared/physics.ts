import { ARENA_LIMITS, OBSTACLES, groundSurfaceAt, surfaceOf, type MapObstacle } from './map.js';
import type { HitZone, InputFrame, Posture, SurfaceKind, Vec3, VaultState } from './protocol.js';

/** Shared, deterministic movement for the server and client prediction. Distances are metres,
 * `ctx.now` is the server clock in milliseconds and `ctx.dt` is seconds. */
export const PLAYER_RADIUS = 0.42;
/** Standing height. Crouch, slide and vault bodies are lower; see POSTURE_HEIGHT. */
export const PLAYER_HEIGHT = 1.8;
export const POSTURE_HEIGHT: Readonly<Record<Posture, number>> = { stand: 1.8, crouch: 1.25, slide: 1.0, vault: 1.25 };
export const EYE_HEIGHT: Readonly<Record<Posture, number>> = { stand: 1.62, crouch: 1.12, slide: 0.92, vault: 1.12 };
export const MOVE = {
  walk: 5.0, back: 4.0, strafe: 4.5, crouch: 2.6, sprint: 6.9, dash: 8.2,
  accel: 40, brake: 30, airControl: 0.2, gravity: 19, jumpSpeed: 6.0, maxFall: 30,
  slideSpeed: 8.8, slideMinStartSpeed: 6.0, slideEndSpeed: 3.5, slideMs: 800, slideCooldownMs: 600, slideJumpKeep: 0.9, slideSteer: 1.2,
  dashMs: 3000, dashRefillMs: 4000, dashFadeStamina: 0.2,
  vaultMin: 0.5, vaultMax: 2.1, vaultBaseMs: 250, vaultPerMeterMs: 150, vaultReach: 0.75, vaultThin: 0.6, vaultMinExitSpeed: 3.5,
  stepHeight: 0.45,
} as const;
export const WALK_SPEED = MOVE.walk;
export const SPRINT_SPEED = MOVE.sprint;
export const DASH_SPEED = MOVE.dash;
export const GRAVITY = MOVE.gravity;

export interface KinematicState extends Vec3 { vx: number; vy: number; vz: number; yaw: number; pitch: number }
export interface MoveState extends KinematicState {
  posture: Posture; stamina: number; slideUntil: number; slideCooldownUntil: number; vault: VaultState | null;
  sprinting?: boolean; dashing?: boolean;
}
export interface MoveContext {
  /** Server clock (ms). Prediction passes its predicted server time. */
  now: number;
  /** Seconds, clamped to [0, 0.1]. */
  dt: number;
  /** Rising edges this step, computed by the caller from the previous accepted input. */
  jumpPressed: boolean; crouchPressed: boolean;
  /** Equipped weapon handling: hip movement factor and aimed movement factor. */
  moveFactor: number; adsFactor: number;
  /** False while server-only actions forbid sprinting (cooking a grenade, knifing). */
  canSprint: boolean;
}
export interface MoveEvents { jumped: boolean; landedSpeed: number; slideStarted: boolean; slideEnded: boolean; vaultStarted: boolean; vaultEnded: boolean }
export const moveDefaults = (): Pick<MoveState, 'posture' | 'stamina' | 'slideUntil' | 'slideCooldownUntil' | 'vault' | 'sprinting' | 'dashing'> =>
  ({ posture: 'stand', stamina: 1, slideUntil: 0, slideCooldownUntil: 0, vault: null, sprinting: false, dashing: false });

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export function directionFromAngles(yaw: number, pitch: number): Vec3 {
  return { x: Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
}
/** Unit vector to the player's right for a view yaw. */
export const rightFromYaw = (yaw: number): Vec3 => ({ x: Math.cos(yaw), y: 0, z: Math.sin(yaw) });
export const subtract = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const scale = (v: Vec3, k: number): Vec3 => ({ x: v.x * k, y: v.y * k, z: v.z * k });
export const magnitude = (v: Vec3) => Math.hypot(v.x, v.y, v.z);
export function normalize(v: Vec3): Vec3 { const len = magnitude(v); return len > 0 ? scale(v, 1 / len) : { x: 0, y: 0, z: -1 }; }

const boxMin = (box: MapObstacle): Vec3 => ({ x: box.x - box.w / 2, y: box.y - box.h / 2, z: box.z - box.d / 2 });
const boxMax = (box: MapObstacle): Vec3 => ({ x: box.x + box.w / 2, y: box.y + box.h / 2, z: box.z + box.d / 2 });
/** Entry and exit distances of a ray through a box, or null. Entry is 0 when the origin is inside. */
export function rayBoxSpan(origin: Vec3, direction: Vec3, min: Vec3, max: Vec3, limit = 200): [number, number] | null {
  let near = 0; let far = limit;
  for (const axis of ['x', 'y', 'z'] as const) {
    if (Math.abs(direction[axis]) < 1e-8) { if (origin[axis] < min[axis] || origin[axis] > max[axis]) return null; continue; }
    const a = (min[axis] - origin[axis]) / direction[axis]; const b = (max[axis] - origin[axis]) / direction[axis];
    near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
    if (near > far) return null;
  }
  return far >= 0 && near <= limit ? [near, far] : null;
}
export function rayBox(origin: Vec3, direction: Vec3, min: Vec3, max: Vec3, limit = 200): number {
  return rayBoxSpan(origin, direction, min, max, limit)?.[0] ?? Infinity;
}
export function raycastMap(origin: Vec3, direction: Vec3, limit = 200): number {
  let result = limit;
  for (const box of OBSTACLES) result = Math.min(result, rayBox(origin, direction, boxMin(box), boxMax(box), limit));
  if (direction.y < -1e-6) { const floor = -origin.y / direction.y; if (floor >= 0) result = Math.min(result, floor); }
  return result;
}
export interface MapHit { distance: number; point: Vec3; normal: Vec3; obstacle: MapObstacle | null; surface: SurfaceKind }
/** Nearest world contact with its face normal and material; null when nothing is hit within `limit`. */
export function raycastMapDetailed(origin: Vec3, direction: Vec3, limit = 200): MapHit | null {
  let best: MapHit | null = null;
  for (const box of OBSTACLES) {
    const min = boxMin(box), max = boxMax(box);
    const span = rayBoxSpan(origin, direction, min, max, best?.distance ?? limit);
    if (!span || (best && span[0] >= best.distance)) continue;
    const point = add(origin, scale(direction, span[0]));
    let normal: Vec3 = scale(normalize(direction), -1), closest = Infinity;
    for (const axis of ['x', 'y', 'z'] as const) for (const [face, sign] of [[min[axis], -1], [max[axis], 1]] as const) {
      const gap = Math.abs(point[axis] - face);
      if (gap < closest && direction[axis] * sign < 0) { closest = gap; normal = { x: 0, y: 0, z: 0 }; normal[axis] = sign; }
    }
    best = { distance: span[0], point, normal, obstacle: box, surface: surfaceOf(box) };
  }
  if (direction.y < -1e-6) {
    const floor = -origin.y / direction.y;
    if (floor >= 0 && floor <= (best?.distance ?? limit)) {
      const point = add(origin, scale(direction, floor));
      best = { distance: floor, point: { ...point, y: 0 }, normal: { x: 0, y: 1, z: 0 }, obstacle: null, surface: groundSurfaceAt(point.x, point.z) };
    }
  }
  return best;
}

function overlapsXZ(state: Vec3, box: MapObstacle, radius = PLAYER_RADIUS) {
  return state.x + radius > box.x - box.w / 2 && state.x - radius < box.x + box.w / 2 &&
    state.z + radius > box.z - box.d / 2 && state.z - radius < box.z + box.d / 2;
}
function supportAt(state: Vec3): number {
  let support = 0;
  for (const box of OBSTACLES) { const top = box.y + box.h / 2; if (overlapsXZ(state, box) && top <= state.y + 0.06) support = Math.max(support, top); }
  return support;
}
/** Visual animation shares the real supporting surface, including steps/platforms. */
export function isPlayerGrounded(state: Vec3 & { vy: number }): boolean {
  return state.vy <= 0.1 && Math.abs(state.y - supportAt(state)) < 0.06;
}
export function supportHeight(state: Vec3): number { return supportAt(state); }
export const playerHeight = (posture: Posture) => POSTURE_HEIGHT[posture];
/** True when a body of `height` with its feet at `position` overlaps no obstacle. */
export function spaceFree(position: Vec3, height: number, radius = PLAYER_RADIUS): boolean {
  if (Math.abs(position.x) > ARENA_LIMITS.x - radius + 1e-6 || Math.abs(position.z) > ARENA_LIMITS.z - radius + 1e-6) return false;
  for (const box of OBSTACLES) {
    if (!overlapsXZ(position, box, radius)) continue;
    if (position.y + height > box.y - box.h / 2 + 0.02 && position.y < box.y + box.h / 2 - 0.02) return false;
  }
  return true;
}
export const hasHeadroom = (state: Vec3, height: number) => spaceFree(state, height);

export function eyePosition(state: Vec3 & { posture: Posture }): Vec3 {
  return { x: state.x, y: state.y + EYE_HEIGHT[state.posture], z: state.z };
}
/** Cosmetic muzzle point in front of and below the eye, pulled back so it never sits inside a wall. */
export function weaponMuzzle(eye: Vec3, yaw: number, pitch: number): Vec3 {
  const forward = directionFromAngles(yaw, pitch), right = rightFromYaw(yaw);
  const target = add(add(add(eye, scale(forward, 0.55)), scale(right, 0.13)), { x: 0, y: -0.1, z: 0 });
  const delta = subtract(target, eye), length = magnitude(delta), wall = raycastMap(eye, normalize(delta), length);
  return wall < length ? add(eye, scale(normalize(delta), Math.max(0, wall - 0.05))) : target;
}

/** [zone, bottom, top, half width] relative to the feet, per posture; yaw independent. */
const ZONES: Readonly<Record<Posture, ReadonlyArray<readonly [HitZone, number, number, number]>>> = {
  stand: [['head', 1.45, 1.8, 0.15], ['torso', 0.85, 1.45, 0.3], ['legs', 0, 0.85, 0.25]],
  crouch: [['head', 0.95, 1.25, 0.15], ['torso', 0.5, 0.95, 0.3], ['legs', 0, 0.5, 0.28]],
  slide: [['head', 0.72, 1.0, 0.15], ['torso', 0.35, 0.72, 0.3], ['legs', 0, 0.35, 0.3]],
  vault: [['head', 0.95, 1.25, 0.15], ['torso', 0.5, 0.95, 0.3], ['legs', 0, 0.5, 0.28]],
};
export interface Hitbox { zone: HitZone; min: Vec3; max: Vec3 }
/** Head, torso and legs boxes, head first. */
export function hitboxes(state: Vec3 & { posture: Posture }): Hitbox[] {
  return ZONES[state.posture].map(([zone, bottom, top, half]) => ({
    zone, min: { x: state.x - half, y: state.y + bottom, z: state.z - half }, max: { x: state.x + half, y: state.y + top, z: state.z + half },
  }));
}
/** Nearest hitbox along a ray within `limit`, or null. */
export function rayHitboxes(origin: Vec3, direction: Vec3, state: Vec3 & { posture: Posture }, limit: number): { distance: number; zone: HitZone } | null {
  let best: { distance: number; zone: HitZone } | null = null;
  for (const box of hitboxes(state)) {
    const distance = rayBox(origin, direction, box.min, box.max, best?.distance ?? limit);
    if (distance < (best?.distance ?? limit)) best = { distance, zone: box.zone };
  }
  return best;
}

const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
const easeInOut = (t: number) => t * t * (3 - 2 * t);
function worldWish(input: InputFrame): { x: number; z: number; magnitude: number } {
  let mx = input.moveX, mz = input.moveZ; const length = Math.hypot(mx, mz);
  if (length < 1e-6) return { x: 0, z: 0, magnitude: 0 };
  mx /= length; mz /= length;
  return { x: mx * Math.cos(input.yaw) + mz * Math.sin(input.yaw), z: mx * Math.sin(input.yaw) - mz * Math.cos(input.yaw), magnitude: Math.min(1, length) };
}
function pathClear(fromX: number, fromZ: number, to: Vec3, height: number): boolean {
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    if (!spaceFree({ x: fromX + (to.x - fromX) * t, y: to.y, z: fromZ + (to.z - fromZ) * t }, height, 0.3)) return false;
  }
  return true;
}

/** A vault or mantle the player can start now, or null. Needs forward input; the nearest obstacle
 * in front decides: low enough to climb, thin ones are vaulted over, thick ones mantled onto. */
export function findVault(state: MoveState, input: InputFrame, now: number): VaultState | null {
  if (input.moveZ < 0.3 || state.posture === 'vault') return null;
  const fx = Math.sin(input.yaw), fz = -Math.cos(input.yaw);
  const origin = { x: state.x, y: 0, z: state.z }, direction = { x: fx, y: 0, z: fz };
  const bodyTop = state.y + POSTURE_HEIGHT[state.posture];
  let nearest: { box: MapObstacle; distance: number } | null = null;
  for (const box of OBSTACLES) {
    const bottom = box.y - box.h / 2, top = box.y + box.h / 2;
    // Only obstacles in front of the lower body matter; lintels above windows are checked as clearance.
    if (top <= state.y + 0.06 || bottom > state.y + 0.35 || bottom >= bodyTop) continue;
    const grown = { x: PLAYER_RADIUS, y: 0, z: PLAYER_RADIUS };
    const distance = rayBox(origin, direction, { x: box.x - box.w / 2 - grown.x, y: -1, z: box.z - box.d / 2 - grown.z },
      { x: box.x + box.w / 2 + grown.x, y: 1, z: box.z + box.d / 2 + grown.z }, MOVE.vaultReach + 0.05);
    if (distance === Infinity) continue;
    if (!nearest || distance < nearest.distance - 1e-4 || (Math.abs(distance - nearest.distance) <= 1e-4 && top > nearest.box.y + nearest.box.h / 2)) nearest = { box, distance };
  }
  if (!nearest) return null;
  const box = nearest.box, top = box.y + box.h / 2, rise = top - state.y;
  if (rise < MOVE.vaultMin || rise > MOVE.vaultMax) return null;
  const span = rayBoxSpan(origin, direction, { ...boxMin(box), y: -1 }, { ...boxMax(box), y: 1 }, 10);
  if (!span) return null;
  // The body must be able to rise in place before crossing.
  if (!spaceFree({ x: state.x, y: top + 0.02, z: state.z }, POSTURE_HEIGHT.vault, 0.3)) return null;
  const horizontal = Math.hypot(state.vx, state.vz);
  const make = (to: Vec3): VaultState => ({
    fromX: state.x, fromY: state.y, fromZ: state.z, toX: to.x, toY: to.y, toZ: to.z,
    start: now, end: now + MOVE.vaultBaseMs + MOVE.vaultPerMeterMs * rise,
    exitSpeed: clamp(horizontal * 0.95, MOVE.vaultMinExitSpeed, MOVE.dash), exitYaw: input.yaw,
  });
  if (span[1] - span[0] <= MOVE.vaultThin) {
    const reach = span[1] + PLAYER_RADIUS + 0.12;
    const over = { x: state.x + fx * reach, y: top + 0.02, z: state.z + fz * reach };
    if (spaceFree(over, POSTURE_HEIGHT.vault) && pathClear(state.x, state.z, over, POSTURE_HEIGHT.vault)) return make(over);
  }
  const reach = span[0] + PLAYER_RADIUS + 0.12;
  const onto = { x: state.x + fx * reach, y: top, z: state.z + fz * reach };
  if (spaceFree(onto, POSTURE_HEIGHT.vault) && pathClear(state.x, state.z, onto, POSTURE_HEIGHT.vault)) return make(onto);
  return null;
}

function endSlide(state: MoveState, now: number, crouchHeld: boolean, jumping: boolean) {
  state.posture = !jumping && crouchHeld ? 'crouch' : spaceFree(state, POSTURE_HEIGHT.stand) ? 'stand' : 'crouch';
  state.slideUntil = 0; state.slideCooldownUntil = now + MOVE.slideCooldownMs;
}
function startSlide(state: MoveState, now: number) {
  const horizontal = Math.hypot(state.vx, state.vz);
  const boost = Math.max(horizontal, MOVE.slideSpeed) / Math.max(horizontal, 1e-6);
  state.posture = 'slide'; state.slideUntil = now + MOVE.slideMs;
  state.vx *= boost; state.vz *= boost; state.sprinting = false; state.dashing = false;
}
function advanceVault(state: MoveState, input: InputFrame, ctx: MoveContext, events: MoveEvents) {
  const vault = state.vault!, duration = Math.max(1, vault.end - vault.start);
  const t = clamp((ctx.now - vault.start) / duration, 0, 1);
  const rise = easeOut(clamp(t / 0.55, 0, 1)), cross = easeInOut(clamp((t - 0.25) / 0.75, 0, 1));
  state.x = vault.fromX + (vault.toX - vault.fromX) * cross;
  state.z = vault.fromZ + (vault.toZ - vault.fromZ) * cross;
  state.y = vault.fromY + (vault.toY - vault.fromY) * rise;
  // Presentation velocity for animation; position is scripted while vaulting.
  state.vx = (vault.toX - vault.fromX) / (duration / 1000); state.vz = (vault.toZ - vault.fromZ) / (duration / 1000); state.vy = 0;
  if (t < 1) return;
  state.vault = null; events.vaultEnded = true;
  state.posture = spaceFree(state, POSTURE_HEIGHT.stand) ? 'stand' : 'crouch';
  state.vx = Math.sin(vault.exitYaw) * vault.exitSpeed; state.vz = -Math.cos(vault.exitYaw) * vault.exitSpeed;
  // Holding crouch through a fast vault chains straight into a slide.
  if (input.crouch && vault.exitSpeed >= MOVE.slideMinStartSpeed && isPlayerGrounded(state) && ctx.now >= state.slideCooldownUntil) {
    startSlide(state, ctx.now); events.slideStarted = true;
  }
}

/** Advance one player by one input. Mutates `state`; returns what happened for presentation. */
export function movePlayer(state: MoveState, input: InputFrame, ctx: MoveContext): MoveEvents {
  const events: MoveEvents = { jumped: false, landedSpeed: 0, slideStarted: false, slideEnded: false, vaultStarted: false, vaultEnded: false };
  const dt = clamp(Number.isFinite(ctx.dt) ? ctx.dt : 0, 0, 0.1);
  state.yaw = input.yaw; state.pitch = input.pitch;
  if (state.vault) { advanceVault(state, input, ctx, events); state.sprinting = false; state.dashing = false; return events; }
  const wish = worldWish(input);
  const grounded = isPlayerGrounded(state);
  const wasSprinting = !!state.sprinting;
  const forwardish = input.moveZ > 0.3 && Math.abs(input.moveX) <= input.moveZ * 1.2;
  const wantsSprint = ctx.canSprint && input.sprint && forwardish && !input.aim && !input.fire;

  if (state.posture === 'slide') {
    if (ctx.jumpPressed && grounded) {
      endSlide(state, ctx.now, input.crouch, true); events.slideEnded = true;
      state.vx *= MOVE.slideJumpKeep; state.vz *= MOVE.slideJumpKeep; state.vy = MOVE.jumpSpeed; events.jumped = true;
    } else if (!grounded || ctx.now >= state.slideUntil || Math.hypot(state.vx, state.vz) <= MOVE.slideEndSpeed + 0.05) {
      endSlide(state, ctx.now, input.crouch, false); events.slideEnded = true;
    }
  } else if (ctx.jumpPressed && (grounded || state.vy > -4)) {
    const vault = findVault(state, input, ctx.now);
    if (vault) {
      state.vault = vault; state.posture = 'vault'; state.sprinting = false; state.dashing = false; state.vy = 0;
      events.vaultStarted = true; advanceVault(state, input, ctx, events); return events;
    }
    if (grounded) {
      if (state.posture === 'crouch') { if (spaceFree(state, POSTURE_HEIGHT.stand)) state.posture = 'stand'; }
      else { state.vy = MOVE.jumpSpeed; events.jumped = true; }
    }
  }
  if (!events.jumped && state.posture === 'stand' && grounded && ctx.crouchPressed && wasSprinting
    && Math.hypot(state.vx, state.vz) >= MOVE.slideMinStartSpeed && ctx.now >= state.slideCooldownUntil) {
    startSlide(state, ctx.now); events.slideStarted = true;
  } else if (state.posture === 'stand' && input.crouch && !wantsSprint && !events.jumped && grounded) {
    state.posture = 'crouch';
  } else if (state.posture === 'crouch' && (!input.crouch || wantsSprint) && spaceFree(state, POSTURE_HEIGHT.stand)) {
    state.posture = 'stand';
  }

  const sprinting = state.posture === 'stand' && wantsSprint && (grounded || wasSprinting);
  const dashing = sprinting && input.dash && state.stamina > 0;
  state.sprinting = sprinting; state.dashing = dashing;
  state.stamina = dashing ? Math.max(0, state.stamina - dt * 1000 / MOVE.dashMs) : Math.min(1, state.stamina + dt * 1000 / MOVE.dashRefillMs);

  if (state.posture === 'slide') {
    const speed = Math.hypot(state.vx, state.vz);
    const next = Math.max(0, speed - (MOVE.slideSpeed - MOVE.slideEndSpeed) / (MOVE.slideMs / 1000) * dt);
    let heading = Math.atan2(state.vx, -state.vz);
    if (wish.magnitude > 0.1) {
      const desired = Math.atan2(wish.x, -wish.z), delta = Math.atan2(Math.sin(desired - heading), Math.cos(desired - heading));
      heading += clamp(delta, -MOVE.slideSteer * dt, MOVE.slideSteer * dt);
    }
    state.vx = Math.sin(heading) * next; state.vz = -Math.cos(heading) * next;
  } else if (grounded || wish.magnitude > 0.001) {
    let speed = 0;
    if (wish.magnitude > 0.001) {
      const forwardness = input.moveZ / Math.max(1e-6, Math.hypot(input.moveX, input.moveZ));
      speed = forwardness >= 0 ? MOVE.strafe + (MOVE.walk - MOVE.strafe) * forwardness : MOVE.strafe + (MOVE.back - MOVE.strafe) * -forwardness;
      if (state.posture === 'crouch') speed = MOVE.crouch;
      if (sprinting) speed = dashing ? MOVE.sprint + (MOVE.dash - MOVE.sprint) * Math.min(1, state.stamina / MOVE.dashFadeStamina) : MOVE.sprint;
      speed *= ctx.moveFactor * (input.aim && !sprinting ? ctx.adsFactor : 1) * wish.magnitude;
    }
    const targetX = wish.x * speed, targetZ = wish.z * speed;
    const dx = targetX - state.vx, dz = targetZ - state.vz, difference = Math.hypot(dx, dz);
    if (difference > 1e-6) {
      const accelerating = speed >= Math.hypot(state.vx, state.vz) - 1e-6;
      const rate = (accelerating ? MOVE.accel : MOVE.brake) * (grounded ? 1 : MOVE.airControl) * dt;
      const k = Math.min(1, rate / difference);
      state.vx += dx * k; state.vz += dz * k;
    }
  }

  const height = POSTURE_HEIGHT[state.posture];
  const steps = Math.max(1, Math.ceil(dt / (1 / 90))); const step = dt / steps;
  for (let index = 0; index < steps; index++) {
    for (const axis of ['x', 'z'] as const) {
      const velocity = axis === 'x' ? 'vx' : 'vz';
      const prior = state[axis]; state[axis] += state[velocity] * step;
      state[axis] = clamp(state[axis], -ARENA_LIMITS[axis] + PLAYER_RADIUS, ARENA_LIMITS[axis] - PLAYER_RADIUS);
      for (const box of OBSTACLES) {
        if (!overlapsXZ(state, box) || state.y + height <= box.y - box.h / 2 + 0.02 || state.y >= box.y + box.h / 2 - 0.01) continue;
        const rise = box.y + box.h / 2 - state.y;
        if (rise <= MOVE.stepHeight && state.vy <= 0.1) state.y = box.y + box.h / 2;
        else { state[axis] = prior; state[velocity] = 0; break; }
      }
    }
    const previousY = state.y; const falling = -state.vy;
    state.vy = Math.max(-MOVE.maxFall, state.vy - MOVE.gravity * step); state.y += state.vy * step;
    for (const box of OBSTACLES) {
      if (!overlapsXZ(state, box)) continue;
      const top = box.y + box.h / 2; const bottom = box.y - box.h / 2;
      if (state.vy <= 0 && previousY >= top - 0.03 && state.y < top) { if (!grounded) events.landedSpeed = Math.max(events.landedSpeed, falling); state.y = top; state.vy = 0; }
      if (state.vy > 0 && previousY + height <= bottom + 0.03 && state.y + height > bottom) { state.y = bottom - height; state.vy = 0; }
    }
    if (state.y < 0) { if (!grounded) events.landedSpeed = Math.max(events.landedSpeed, falling); state.y = 0; state.vy = 0; }
  }
  if (events.landedSpeed < 2) events.landedSpeed = 0;
  return events;
}

/** Thrown grenades share one deterministic fixed-step simulation on the server and every client. */
export interface GrenadeBody extends Vec3 { vx: number; vy: number; vz: number }
export const GRENADE = { radius: 0.07, gravity: 14, restitution: 0.38, impactFriction: 0.7, rollFriction: 0.94, rest: 0.6, stepMs: 1000 / 60 } as const;
function grenadeBlocked(body: Vec3, axis: 'x' | 'y' | 'z'): boolean {
  if (axis === 'y' && body.y < GRENADE.radius) return true;
  if (axis !== 'y' && Math.abs(body[axis]) > ARENA_LIMITS[axis] - GRENADE.radius) return true;
  for (const box of OBSTACLES) {
    if (Math.abs(body.x - box.x) < box.w / 2 + GRENADE.radius && Math.abs(body.y - box.y) < box.h / 2 + GRENADE.radius && Math.abs(body.z - box.z) < box.d / 2 + GRENADE.radius) return true;
  }
  return false;
}
/** One fixed step. Returns the impact speed of a hard bounce (> 1.2 m/s), else 0. */
export function stepGrenade(body: GrenadeBody, dt = GRENADE.stepMs / 1000): number {
  let impact = 0;
  body.vy -= GRENADE.gravity * dt;
  for (const axis of ['x', 'y', 'z'] as const) {
    const velocity = `v${axis}` as 'vx' | 'vy' | 'vz';
    const prior = body[axis]; body[axis] += body[velocity] * dt;
    if (!grenadeBlocked(body, axis)) continue;
    body[axis] = prior;
    const speed = Math.abs(body[velocity]);
    body[velocity] = -body[velocity] * GRENADE.restitution;
    const friction = speed > 1.2 ? GRENADE.impactFriction : GRENADE.rollFriction;
    for (const other of ['vx', 'vy', 'vz'] as const) if (other !== velocity) body[other] *= friction;
    if (axis === 'y' && Math.abs(body.vy) < GRENADE.rest) body.vy = 0;
    if (speed > 1.2) impact = Math.max(impact, speed);
  }
  return impact;
}
/** Launch point and velocity for a throw from the eye. */
export function grenadeLaunch(eye: Vec3, yaw: number, pitch: number, carrier: { vx: number; vz: number }, speed = 16, lift = 3): { from: Vec3; velocity: Vec3 } {
  const forward = directionFromAngles(yaw, pitch), reach = 0.45, wall = raycastMap(eye, forward, reach);
  const from = add(eye, scale(forward, Math.max(0, Math.min(reach, wall - 0.12))));
  return { from, velocity: { x: forward.x * speed + carrier.vx * 0.5, y: forward.y * speed + lift, z: forward.z * speed + carrier.vz * 0.5 } };
}
/** Replays a throw with fixed steps; callers keep one per grenade and advance it to an elapsed time. */
export class GrenadeTrajectory {
  readonly body: GrenadeBody;
  private elapsed = 0;
  constructor(from: Vec3, velocity: Vec3) { this.body = { ...from, vx: velocity.x, vy: velocity.y, vz: velocity.z }; }
  /** Advances to `elapsedMs` after the throw; returns impact speeds of hard bounces on the way. */
  advanceTo(elapsedMs: number): number[] {
    const impacts: number[] = [];
    while (this.elapsed + GRENADE.stepMs <= elapsedMs) {
      const impact = stepGrenade(this.body); if (impact) impacts.push(impact);
      this.elapsed += GRENADE.stepMs;
    }
    return impacts;
  }
  get position(): Vec3 { return { x: this.body.x, y: this.body.y, z: this.body.z }; }
}
export function grenadePosition(from: Vec3, velocity: Vec3, elapsedMs: number): Vec3 {
  const trajectory = new GrenadeTrajectory(from, velocity); trajectory.advanceTo(elapsedMs); return trajectory.position;
}
