import { ARENA_LIMITS, OBSTACLES, groundSurfaceAt, surfaceOf, type MapObstacle } from './map.js';
import type { HitZone, InputFrame, Posture, SurfaceKind, Vec3, VaultState } from './protocol.js';

/** Shared, deterministic movement for the server and client prediction. Distances are metres,
 * `ctx.now` is the server clock in milliseconds and `ctx.dt` is seconds. On one JavaScript engine
 * the same state, inputs and context always give bit-identical results; across engines (Node vs a
 * phone browser) Math.sin/hypot may differ in the last bits, which snapshot correction absorbs. */
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
  /** A new dash needs this share of stamina. A dash that runs dry while dash is still held stays spent:
   * stamina waits to refill until dash (or sprint) is let go, so holding dash never restarts it in surges. */
  dashRestartStamina: 0.2,
  /** Sideways steering of a vault's crossing point (m), and how fast it moves there (m/s). */
  vaultSteer: 0.25, vaultSteerRate: 1.25,
  /** A crouch press before this share of a vault cancels it back to the start. */
  vaultCancelWindow: 0.4,
  /** Weapons may fire from this share of a vault on (see vaultFireProgress). */
  vaultFireAt: 0.7,
  /** Falling faster than this (m/s) is too fast to catch a ledge. */
  vaultMaxFallSpeed: 4,
  /** Longest integration step (s). */
  subStep: 1 / 90,
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
  /** Equipped weapon handling: the hip factor scales movement when not aiming; the aimed factor
   * replaces it while aiming (KR-5: 5.0 m/s × 0.52 = 2.6 m/s aimed walk). */
  moveFactor: number; adsFactor: number;
  /** False while server-only actions forbid sprinting (cooking a grenade, knifing). */
  canSprint: boolean;
}
export interface MoveEvents {
  jumped: boolean; landedSpeed: number; slideStarted: boolean; slideEnded: boolean; vaultStarted: boolean; vaultEnded: boolean;
  /** The vault was cancelled by a crouch press (vaultEnded is also set). Always present on results. */
  vaultCancelled?: boolean;
}
export const moveDefaults = (): Pick<MoveState, 'posture' | 'stamina' | 'slideUntil' | 'slideCooldownUntil' | 'vault' | 'sprinting' | 'dashing'> =>
  ({ posture: 'stand', stamina: 1, slideUntil: 0, slideCooldownUntil: 0, vault: null, sprinting: false, dashing: false });

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);
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

// ---------------------------------------------------------------------------------------------
// Static spatial grid. OBSTACLES is filled when shared/map.ts loads; the grid is built on the first
// query and rebuilt if the obstacle list changes length or its first or last box is replaced (tests add
// and remove temporary boxes at the end). Each obstacle is listed in every 2 m cell its footprint
// touches, so a query only tests nearby boxes. Results are exactly those of scanning every obstacle:
// ties are broken by obstacle index, as a scan would.

const GRID_CELL = 2;
const GRID_PAD = 1e-4;
interface ObstacleGrid {
  count: number; first: MapObstacle | undefined; last: MapObstacle | undefined;
  minX: number; minZ: number; cols: number; rows: number;
  /** Cell c lists items[start[c] .. start[c + 1]), ascending obstacle indices. */
  start: Int32Array; items: Int32Array;
  /** Per obstacle: minX, minY, minZ, maxX, maxY, maxZ. */
  bounds: Float64Array;
  /** Per obstacle: the last query that visited it, for de-duplication. */
  seen: Uint32Array;
}
let grid: ObstacleGrid | null = null;
let queryStamp = 0;
const NO_OBSTACLES = new Int32Array(0);

function obstacleGrid(): ObstacleGrid {
  const count = OBSTACLES.length, first = OBSTACLES[0], last = OBSTACLES[count - 1];
  if (grid && grid.count === count && grid.first === first && grid.last === last) return grid;
  const bounds = new Float64Array(count * 6);
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const box = OBSTACLES[i]!, o = i * 6;
    bounds[o] = box.x - box.w / 2; bounds[o + 1] = box.y - box.h / 2; bounds[o + 2] = box.z - box.d / 2;
    bounds[o + 3] = box.x + box.w / 2; bounds[o + 4] = box.y + box.h / 2; bounds[o + 5] = box.z + box.d / 2;
    minX = Math.min(minX, bounds[o]!); minZ = Math.min(minZ, bounds[o + 2]!);
    maxX = Math.max(maxX, bounds[o + 3]!); maxZ = Math.max(maxZ, bounds[o + 5]!);
  }
  if (!(minX <= maxX && minZ <= maxZ)) { minX = -1; maxX = 1; minZ = -1; maxZ = 1; }
  minX -= 1; minZ -= 1; maxX += 1; maxZ += 1;
  const cols = Math.max(1, Math.ceil((maxX - minX) / GRID_CELL)), rows = Math.max(1, Math.ceil((maxZ - minZ) / GRID_CELL));
  const cellRange = (o: number) => [
    clamp(Math.floor((bounds[o]! - GRID_PAD - minX) / GRID_CELL), 0, cols - 1), clamp(Math.floor((bounds[o + 3]! + GRID_PAD - minX) / GRID_CELL), 0, cols - 1),
    clamp(Math.floor((bounds[o + 2]! - GRID_PAD - minZ) / GRID_CELL), 0, rows - 1), clamp(Math.floor((bounds[o + 5]! + GRID_PAD - minZ) / GRID_CELL), 0, rows - 1),
  ] as const;
  const start = new Int32Array(cols * rows + 1);
  for (let i = 0; i < count; i++) {
    const [c0, c1, r0, r1] = cellRange(i * 6);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) start[r * cols + c + 1]!++;
  }
  for (let c = 0; c < cols * rows; c++) start[c + 1]! += start[c]!;
  const items = new Int32Array(start[cols * rows]!), cursor = start.slice(0, cols * rows);
  for (let i = 0; i < count; i++) {
    const [c0, c1, r0, r1] = cellRange(i * 6);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) items[cursor[r * cols + c]!++] = i;
  }
  grid = { count, first, last, minX, minZ, cols, rows, start, items, bounds, seen: new Uint32Array(count) };
  return grid;
}
function nextStamp(g: ObstacleGrid): number {
  queryStamp = (queryStamp + 1) >>> 0;
  if (queryStamp === 0) { g.seen.fill(0); queryStamp = 1; }
  return queryStamp;
}
/** Ascending indices of obstacles whose footprint may touch the XZ rectangle (a superset: callers test exactly). */
function obstaclesIn(minX: number, maxX: number, minZ: number, maxZ: number): ArrayLike<number> {
  const g = obstacleGrid();
  const c0 = Math.max(0, Math.floor((minX - g.minX) / GRID_CELL)), c1 = Math.min(g.cols - 1, Math.floor((maxX - g.minX) / GRID_CELL));
  const r0 = Math.max(0, Math.floor((minZ - g.minZ) / GRID_CELL)), r1 = Math.min(g.rows - 1, Math.floor((maxZ - g.minZ) / GRID_CELL));
  if (!(c0 <= c1 && r0 <= r1)) return NO_OBSTACLES;
  if (c0 === c1 && r0 === r1) { const cell = r0 * g.cols + c0; return g.items.subarray(g.start[cell]!, g.start[cell + 1]!); }
  const stamp = nextStamp(g), found: number[] = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const cell = r * g.cols + c;
    for (let k = g.start[cell]!; k < g.start[cell + 1]!; k++) {
      const i = g.items[k]!;
      if (g.seen[i] !== stamp) { g.seen[i] = stamp; found.push(i); }
    }
  }
  return found.sort((a, b) => a - b);
}
/** Ray entry distance into obstacle `i` within `limit`, else Infinity. Same arithmetic as rayBoxSpan. */
function entryDistance(b: Float64Array, i: number, origin: Vec3, direction: Vec3, limit: number): number {
  const o = i * 6;
  let near = 0, far = limit;
  if (Math.abs(direction.x) < 1e-8) { if (origin.x < b[o]! || origin.x > b[o + 3]!) return Infinity; }
  else {
    const a = (b[o]! - origin.x) / direction.x, c = (b[o + 3]! - origin.x) / direction.x;
    near = Math.max(near, Math.min(a, c)); far = Math.min(far, Math.max(a, c)); if (near > far) return Infinity;
  }
  if (Math.abs(direction.y) < 1e-8) { if (origin.y < b[o + 1]! || origin.y > b[o + 4]!) return Infinity; }
  else {
    const a = (b[o + 1]! - origin.y) / direction.y, c = (b[o + 4]! - origin.y) / direction.y;
    near = Math.max(near, Math.min(a, c)); far = Math.min(far, Math.max(a, c)); if (near > far) return Infinity;
  }
  if (Math.abs(direction.z) < 1e-8) { if (origin.z < b[o + 2]! || origin.z > b[o + 5]!) return Infinity; }
  else {
    const a = (b[o + 2]! - origin.z) / direction.z, c = (b[o + 5]! - origin.z) / direction.z;
    near = Math.max(near, Math.min(a, c)); far = Math.min(far, Math.max(a, c)); if (near > far) return Infinity;
  }
  return far >= 0 && near <= limit ? near : Infinity;
}
/** Nearest obstacle along a ray within `limit` (ties: lower index); index -1 when none. Walks the
 * grid cells under the ray in order and stops once no later cell can hold a nearer entry. */
function nearestObstacle(origin: Vec3, direction: Vec3, limit: number): { distance: number; index: number } {
  const g = obstacleGrid();
  let bestDistance = Infinity, bestIndex = -1;
  const width = g.cols * GRID_CELL, depth = g.rows * GRID_CELL, dx = direction.x, dz = direction.z;
  let t0 = 0, t1 = limit;
  if (!(t1 >= 0)) return { distance: bestDistance, index: bestIndex };
  if (Math.abs(dx) < 1e-12) { if (!(origin.x >= g.minX && origin.x <= g.minX + width)) return { distance: bestDistance, index: bestIndex }; }
  else { const a = (g.minX - origin.x) / dx, b = (g.minX + width - origin.x) / dx; t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b)); }
  if (Math.abs(dz) < 1e-12) { if (!(origin.z >= g.minZ && origin.z <= g.minZ + depth)) return { distance: bestDistance, index: bestIndex }; }
  else { const a = (g.minZ - origin.z) / dz, b = (g.minZ + depth - origin.z) / dz; t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b)); }
  if (!(t0 <= t1)) return { distance: bestDistance, index: bestIndex };
  let cx = clamp(Math.floor((origin.x + dx * t0 - g.minX) / GRID_CELL), 0, g.cols - 1);
  let cz = clamp(Math.floor((origin.z + dz * t0 - g.minZ) / GRID_CELL), 0, g.rows - 1);
  const stepX = Math.abs(dx) < 1e-12 ? 0 : dx > 0 ? 1 : -1, stepZ = Math.abs(dz) < 1e-12 ? 0 : dz > 0 ? 1 : -1;
  const deltaX = stepX ? GRID_CELL / Math.abs(dx) : Infinity, deltaZ = stepZ ? GRID_CELL / Math.abs(dz) : Infinity;
  let nextX = stepX ? (g.minX + (cx + (stepX > 0 ? 1 : 0)) * GRID_CELL - origin.x) / dx : Infinity;
  let nextZ = stepZ ? (g.minZ + (cz + (stepZ > 0 ? 1 : 0)) * GRID_CELL - origin.z) / dz : Infinity;
  let enter = t0;
  const stamp = nextStamp(g);
  for (;;) {
    if (bestDistance < enter) break;
    const cell = cz * g.cols + cx;
    for (let k = g.start[cell]!; k < g.start[cell + 1]!; k++) {
      const i = g.items[k]!;
      if (g.seen[i] === stamp) continue;
      g.seen[i] = stamp;
      const distance = entryDistance(g.bounds, i, origin, direction, limit);
      if (distance < bestDistance || (distance === bestDistance && distance !== Infinity && i < bestIndex)) { bestDistance = distance; bestIndex = i; }
    }
    if (nextX <= nextZ) {
      if (!(nextX <= t1)) break;
      enter = nextX; cx += stepX; nextX += deltaX;
      if (cx < 0 || cx >= g.cols) break;
    } else {
      if (!(nextZ <= t1)) break;
      enter = nextZ; cz += stepZ; nextZ += deltaZ;
      if (cz < 0 || cz >= g.rows) break;
    }
  }
  return { distance: bestDistance, index: bestIndex };
}
const overlapsXZAt = (b: Float64Array, i: number, x: number, z: number, radius: number) => {
  const o = i * 6;
  return x + radius > b[o]! && x - radius < b[o + 3]! && z + radius > b[o + 2]! && z - radius < b[o + 5]!;
};

// ---------------------------------------------------------------------------------------------
// Rays and overlap queries.

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
/** Distance to the nearest obstacle or the ground along a ray, at most `limit`. */
export function raycastMap(origin: Vec3, direction: Vec3, limit = 200): number {
  let result = limit;
  const hit = nearestObstacle(origin, direction, limit);
  if (hit.index >= 0) result = Math.min(result, hit.distance);
  if (direction.y < -1e-6) { const floor = -origin.y / direction.y; if (floor >= 0) result = Math.min(result, floor); }
  return result;
}
export interface MapHit { distance: number; point: Vec3; normal: Vec3; obstacle: MapObstacle | null; surface: SurfaceKind }
/** Nearest world contact with its face normal and material; null when nothing is hit within `limit`. */
export function raycastMapDetailed(origin: Vec3, direction: Vec3, limit = 200): MapHit | null {
  let best: MapHit | null = null;
  const hit = nearestObstacle(origin, direction, limit);
  if (hit.index >= 0) {
    const box = OBSTACLES[hit.index]!, min = boxMin(box), max = boxMax(box);
    const point = add(origin, scale(direction, hit.distance));
    let normal: Vec3 = scale(normalize(direction), -1), closest = Infinity;
    for (const axis of ['x', 'y', 'z'] as const) for (const [face, sign] of [[min[axis], -1], [max[axis], 1]] as const) {
      const gap = Math.abs(point[axis] - face);
      if (gap < closest && direction[axis] * sign < 0) { closest = gap; normal = { x: 0, y: 0, z: 0 }; normal[axis] = sign; }
    }
    best = { distance: hit.distance, point, normal, obstacle: box, surface: surfaceOf(box) };
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

function supportAt(state: Vec3): number {
  const g = obstacleGrid(), r = PLAYER_RADIUS;
  const near = obstaclesIn(state.x - r, state.x + r, state.z - r, state.z + r);
  return supportAmong(g, near, state);
}
function supportAmong(g: ObstacleGrid, near: ArrayLike<number>, state: Vec3): number {
  let support = 0;
  for (let k = 0; k < near.length; k++) {
    const i = near[k]!, top = g.bounds[i * 6 + 4]!;
    if (top <= state.y + 0.06 && overlapsXZAt(g.bounds, i, state.x, state.z, PLAYER_RADIUS)) support = Math.max(support, top);
  }
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
  const g = obstacleGrid();
  const near = obstaclesIn(position.x - radius, position.x + radius, position.z - radius, position.z + radius);
  for (let k = 0; k < near.length; k++) {
    const i = near[k]!, o = i * 6;
    if (!overlapsXZAt(g.bounds, i, position.x, position.z, radius)) continue;
    if (position.y + height > g.bounds[o + 1]! + 0.02 && position.y < g.bounds[o + 4]! - 0.02) return false;
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

// ---------------------------------------------------------------------------------------------
// Vaulting.

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
 * in front decides: its top must be 0.5–2.1 m above the floor under the player (a jump does not
 * stretch that), thin ones (≤ 0.6 m along the path) are vaulted over, thicker ones mantled onto. The
 * body's centre line must meet the obstacle within one body width of where the body first touches it,
 * so clipping cover with a shoulder while running along its side never carries the player along it.
 * The body must fit rising in place, along the path and at the landing. */
export function findVault(state: MoveState, input: InputFrame, now: number): VaultState | null {
  const yaw = input.yaw;
  if (!(input.moveZ >= 0.3) || state.posture === 'vault' || !Number.isFinite(yaw) || !Number.isFinite(now)) return null;
  if (!Number.isFinite(state.x) || !Number.isFinite(state.y) || !Number.isFinite(state.z)) return null;
  const g = obstacleGrid(), b = g.bounds;
  const fx = Math.sin(yaw), fz = -Math.cos(yaw);
  const origin = { x: state.x, y: 0, z: state.z }, direction = { x: fx, y: 0, z: fz };
  const bodyTop = state.y + (POSTURE_HEIGHT[state.posture] ?? PLAYER_HEIGHT);
  const reach = MOVE.vaultReach + 0.05, around = reach + PLAYER_RADIUS + 0.01;
  const near = obstaclesIn(state.x - around, state.x + around, state.z - around, state.z + around);
  let nearest = -1, nearestDistance = Infinity, nearestTop = -Infinity;
  for (let k = 0; k < near.length; k++) {
    const i = near[k]!, o = i * 6, bottom = b[o + 1]!, top = b[o + 4]!;
    // Only obstacles in front of the lower body matter; lintels above windows are checked as clearance.
    if (top <= state.y + 0.06 || bottom > state.y + 0.35 || bottom >= bodyTop) continue;
    const distance = rayBox(origin, direction, { x: b[o]! - PLAYER_RADIUS, y: -1, z: b[o + 2]! - PLAYER_RADIUS },
      { x: b[o + 3]! + PLAYER_RADIUS, y: 1, z: b[o + 5]! + PLAYER_RADIUS }, reach);
    if (distance === Infinity) continue;
    if (nearest < 0 || distance < nearestDistance - 1e-4 || (Math.abs(distance - nearestDistance) <= 1e-4 && top > nearestTop)) {
      nearest = i; nearestDistance = distance; nearestTop = top;
    }
  }
  if (nearest < 0) return null;
  const o = nearest * 6, top = b[o + 4]!;
  const rise = top - Math.min(supportAt(state), state.y);
  if (rise < MOVE.vaultMin || rise > MOVE.vaultMax) return null;
  const span = rayBoxSpan(origin, direction, { x: b[o]!, y: -1, z: b[o + 2]! }, { x: b[o + 3]!, y: 1, z: b[o + 5]! }, 10);
  if (!span || span[0] > nearestDistance + 2 * PLAYER_RADIUS) return null;
  // The body must be able to rise in place before crossing.
  if (!spaceFree({ x: state.x, y: top + 0.02, z: state.z }, POSTURE_HEIGHT.vault, 0.3)) return null;
  const horizontal = finite(Math.hypot(state.vx, state.vz), 0), climb = Math.max(0, top - state.y);
  const make = (to: Vec3): VaultState => ({
    fromX: state.x, fromY: state.y, fromZ: state.z, toX: to.x, toY: to.y, toZ: to.z,
    start: now, end: now + MOVE.vaultBaseMs + MOVE.vaultPerMeterMs * climb,
    exitSpeed: clamp(horizontal * 0.95, MOVE.vaultMinExitSpeed, MOVE.dash), exitYaw: yaw,
  });
  // The tolerance keeps cover exactly vaultThin deep (the 0.6 m lane barriers) thin despite rounding.
  if (span[1] - span[0] <= MOVE.vaultThin + 1e-6) {
    const reachOver = span[1] + PLAYER_RADIUS + 0.12;
    const over = { x: state.x + fx * reachOver, y: top + 0.02, z: state.z + fz * reachOver };
    if (spaceFree(over, POSTURE_HEIGHT.vault) && pathClear(state.x, state.z, over, POSTURE_HEIGHT.vault)) return make(over);
  }
  const reachOnto = span[0] + PLAYER_RADIUS + 0.12;
  const onto = { x: state.x + fx * reachOnto, y: top, z: state.z + fz * reachOnto };
  if (spaceFree(onto, POSTURE_HEIGHT.vault) && pathClear(state.x, state.z, onto, POSTURE_HEIGHT.vault)) return make(onto);
  return null;
}

/** How far through its vault a player is, 0..1; 1 when not vaulting. Firing waits for MOVE.vaultFireAt. */
export function vaultFireProgress(state: { vault: VaultState | null }, now: number): number {
  const vault = state.vault;
  if (!vault) return 1;
  if (!Number.isFinite(now)) return 0;
  const duration = vault.end - vault.start;
  if (!(duration > 0)) return 1;
  return clamp((now - vault.start) / duration, 0, 1);
}

/** Moves the crossing point toward moveX × vaultSteer sideways, only while the shifted path and landing are clear. */
function steerVault(state: MoveState, vault: VaultState, moveX: number, dt: number): VaultState {
  const rx = Math.cos(vault.exitYaw), rz = Math.sin(vault.exitYaw);
  const lateral = (vault.toX - vault.fromX) * rx + (vault.toZ - vault.fromZ) * rz;
  const step = clamp(clamp(moveX, -1, 1) * MOVE.vaultSteer - lateral, -MOVE.vaultSteerRate * dt, MOVE.vaultSteerRate * dt);
  if (!(Math.abs(step) >= 1e-9)) return vault;
  const to = { x: vault.toX + rx * step, y: vault.toY, z: vault.toZ + rz * step };
  if (!spaceFree(to, POSTURE_HEIGHT.vault) || !pathClear(vault.fromX, vault.fromZ, to, POSTURE_HEIGHT.vault)) return vault;
  const steered = { ...vault, toX: to.x, toZ: to.z };
  state.vault = steered;
  return steered;
}
function cancelVault(state: MoveState, input: InputFrame, events: MoveEvents) {
  const vault = state.vault!;
  state.x = vault.fromX; state.y = vault.fromY; state.z = vault.fromZ;
  state.vx = 0; state.vy = 0; state.vz = 0;
  state.vault = null;
  state.posture = input.crouch || !spaceFree(state, POSTURE_HEIGHT.stand) ? 'crouch' : 'stand';
  events.vaultEnded = true; events.vaultCancelled = true;
}
function advanceVault(state: MoveState, input: InputFrame, ctx: MoveContext, dt: number, events: MoveEvents, ongoing: boolean) {
  let vault = state.vault!;
  const duration = Math.max(1, vault.end - vault.start);
  const t = finite(clamp((ctx.now - vault.start) / duration, 0, 1), 0);
  if (ongoing && ctx.crouchPressed && t < MOVE.vaultCancelWindow) { cancelVault(state, input, events); return; }
  vault = steerVault(state, vault, input.moveX, dt);
  const rise = easeOut(clamp(t / 0.55, 0, 1)), cross = easeInOut(clamp((t - 0.25) / 0.75, 0, 1));
  state.x = vault.fromX + (vault.toX - vault.fromX) * cross;
  state.z = vault.fromZ + (vault.toZ - vault.fromZ) * cross;
  state.y = vault.fromY + (vault.toY - vault.fromY) * rise;
  // Presentation velocity for animation; position is scripted while vaulting.
  state.vx = (vault.toX - vault.fromX) / (duration / 1000); state.vz = (vault.toZ - vault.fromZ) / (duration / 1000); state.vy = 0;
  state.posture = 'vault';
  if (t < 1) return;
  state.vault = null; events.vaultEnded = true;
  state.posture = spaceFree(state, POSTURE_HEIGHT.stand) ? 'stand' : 'crouch';
  state.vx = Math.sin(vault.exitYaw) * vault.exitSpeed; state.vz = -Math.cos(vault.exitYaw) * vault.exitSpeed;
  // A held crouch chains a fast vault into a slide: at once when it ends on a top, or on landing after a
  // vault over thin cover, which ends in the air with the body tucked in a crouch (the vault body's size,
  // so it fits). A slow vault ends crouched.
  if (input.crouch) {
    if (isPlayerGrounded(state) && vault.exitSpeed >= MOVE.slideMinStartSpeed && ctx.now >= state.slideCooldownUntil) {
      startSlide(state, ctx.now); events.slideStarted = true;
    } else state.posture = 'crouch';
  }
}

// ---------------------------------------------------------------------------------------------
// Movement.

function endSlide(state: MoveState, now: number, crouchHeld: boolean, airborne: boolean) {
  state.posture = !airborne && crouchHeld ? 'crouch' : spaceFree(state, POSTURE_HEIGHT.stand) ? 'stand' : 'crouch';
  state.slideUntil = 0; state.slideCooldownUntil = now + MOVE.slideCooldownMs;
}
function startSlide(state: MoveState, now: number) {
  const horizontal = Math.hypot(state.vx, state.vz);
  const boost = Math.max(horizontal, MOVE.slideSpeed) / Math.max(horizontal, 1e-6);
  state.posture = 'slide'; state.slideUntil = now + MOVE.slideMs;
  state.vx *= boost; state.vz *= boost; state.sprinting = false; state.dashing = false;
}
function refillStamina(state: MoveState, dt: number) { state.stamina = Math.min(1, state.stamina + dt * 1000 / MOVE.dashRefillMs); }
const POSTURES: readonly Posture[] = ['stand', 'crouch', 'slide', 'vault'];
/** Non-finite numbers or an impossible posture (bad snapshot, bad caller) must not spread. */
function repairState(state: MoveState) {
  for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'yaw', 'pitch', 'slideUntil', 'slideCooldownUntil'] as const) {
    if (!Number.isFinite(state[key])) state[key] = 0;
  }
  state.stamina = clamp(finite(state.stamina, 1), 0, 1);
  const vault = state.vault;
  if (vault && ![vault.fromX, vault.fromY, vault.fromZ, vault.toX, vault.toY, vault.toZ, vault.start, vault.end, vault.exitSpeed, vault.exitYaw].every(Number.isFinite)) state.vault = null;
  if (!POSTURES.includes(state.posture) || (state.posture === 'vault' && !state.vault)) {
    state.posture = spaceFree(state, POSTURE_HEIGHT.stand) ? 'stand' : 'crouch';
  }
}
function accelerateGround(state: MoveState, targetX: number, targetZ: number, targetSpeed: number, dt: number) {
  const dx = targetX - state.vx, dz = targetZ - state.vz, difference = Math.hypot(dx, dz);
  if (difference <= 1e-6) return;
  const accelerating = targetSpeed >= Math.hypot(state.vx, state.vz) - 1e-6;
  const k = Math.min(1, (accelerating ? MOVE.accel : MOVE.brake) * dt / difference);
  state.vx += dx * k; state.vz += dz * k;
}
/** 20% of ground acceleration toward the wish; it can turn and speed up but never slows the player. */
function accelerateAir(state: MoveState, targetX: number, targetZ: number, dt: number) {
  const dx = targetX - state.vx, dz = targetZ - state.vz, difference = Math.hypot(dx, dz);
  if (difference <= 1e-6) return;
  const before = Math.hypot(state.vx, state.vz), k = Math.min(1, MOVE.accel * MOVE.airControl * dt / difference);
  let vx = state.vx + dx * k, vz = state.vz + dz * k;
  const after = Math.hypot(vx, vz);
  if (after < before) {
    if (after <= 1e-6) return;
    vx *= before / after; vz *= before / after;
  }
  state.vx = vx; state.vz = vz;
}
/** Deepest overlap (m) treated as resting contact rather than being stuck inside a box. Snapshots round
 * positions to 1 mm, which can leave a body that was flush against a wall a hair inside it. */
const CONTACT_SLOP = 0.001;
/** Eases a body that is at most CONTACT_SLOP inside a box back out to contact along the shallowest side,
 * so prediction from a rounded snapshot collides with the wall instead of walking through it (moveAxis
 * lets a body that starts inside a box walk out of it). Bodies that do not overlap are never moved. */
function settleContacts(state: MoveState, height: number) {
  const g = obstacleGrid(), b = g.bounds, r = PLAYER_RADIUS;
  const near = obstaclesIn(state.x - r, state.x + r, state.z - r, state.z + r);
  for (let k = 0; k < near.length; k++) {
    const i = near[k]!, o = i * 6;
    if (state.y + height <= b[o + 1]! + 0.02 || state.y >= b[o + 4]! - 0.01 || !overlapsXZAt(b, i, state.x, state.z, r)) continue;
    const west = state.x + r - b[o]!, east = b[o + 3]! - (state.x - r), north = state.z + r - b[o + 2]!, south = b[o + 5]! - (state.z - r);
    const depth = Math.min(west, east, north, south);
    if (depth > CONTACT_SLOP) continue;
    if (depth === west) state.x = b[o]! - r - 1e-9;
    else if (depth === east) state.x = b[o + 3]! + r + 1e-9;
    else if (depth === north) state.z = b[o + 2]! - r - 1e-9;
    else state.z = b[o + 5]! + r + 1e-9;
  }
}
/** One horizontal axis of one sub-step: steps up to MOVE.stepHeight into free space, else stops in
 * contact with the obstacle (or where it was, if contact would not be free). */
function moveAxis(g: ObstacleGrid, state: MoveState, axis: 'x' | 'z', delta: number, height: number, near: ArrayLike<number>) {
  if (delta === 0) return;
  const velocity = axis === 'x' ? 'vx' : 'vz', prior = state[axis], limit = ARENA_LIMITS[axis] - PLAYER_RADIUS;
  const target = prior + delta, next = clamp(target, -limit, limit), lowFace = axis === 'x' ? 0 : 2, highFace = axis === 'x' ? 3 : 5;
  state[axis] = next;
  const priorX = axis === 'x' ? prior : state.x, priorZ = axis === 'z' ? prior : state.z;
  let stepTo = state.y, blocked = false, contact = delta > 0 ? Infinity : -Infinity;
  for (let k = 0; k < near.length; k++) {
    const i = near[k]!, o = i * 6, bottom = g.bounds[o + 1]!, top = g.bounds[o + 4]!;
    if (state.y + height <= bottom + 0.02 || state.y >= top - 0.01 || !overlapsXZAt(g.bounds, i, state.x, state.z, PLAYER_RADIUS)) continue;
    // A box the body was already inside does not block, so a bad state can walk out instead of sticking.
    if (overlapsXZAt(g.bounds, i, priorX, priorZ, PLAYER_RADIUS)) continue;
    if (top - state.y <= MOVE.stepHeight && state.vy <= 0.1) { stepTo = Math.max(stepTo, top); continue; }
    blocked = true;
    contact = delta > 0 ? Math.min(contact, g.bounds[o + lowFace]! - PLAYER_RADIUS - 1e-9) : Math.max(contact, g.bounds[o + highFace]! + PLAYER_RADIUS + 1e-9);
  }
  if (!blocked && stepTo > state.y) {
    if (spaceFree({ x: state.x, y: stepTo, z: state.z }, height)) state.y = stepTo; else blocked = true;
  }
  if (blocked) {
    state[axis] = prior;
    if (delta > 0 ? contact > prior && contact < next : contact < prior && contact > next) {
      state[axis] = contact;
      if (!spaceFree(state, height)) state[axis] = prior;
    }
    state[velocity] = 0;
  } else if (next !== target) state[velocity] = 0;
}
/** Room a posture needs to move. A slide must always be able to rise into a crouch when it ends, so it
 * moves with a crouch's clearance (its eye and hit boxes stay at slide height). */
const moveHeight = (posture: Posture) => (posture === 'slide' ? POSTURE_HEIGHT.crouch : POSTURE_HEIGHT[posture]);
/** Horizontal moves, steps, gravity, landings and ceilings for one tick. Returns true when it ends on the ground. */
function integrate(state: MoveState, height: number, grounded: boolean, dt: number, events: MoveEvents): boolean {
  const g = obstacleGrid(), b = g.bounds, reach = PLAYER_RADIUS + 0.01;
  const steps = Math.max(1, Math.ceil(dt / MOVE.subStep - 1e-9)), h = dt / steps;
  let onGround = grounded;
  for (let s = 0; s < steps; s++) {
    const x0 = state.x, z0 = state.z, x1 = x0 + state.vx * h, z1 = z0 + state.vz * h;
    const near = obstaclesIn(Math.min(x0, x1) - reach, Math.max(x0, x1) + reach, Math.min(z0, z1) - reach, Math.max(z0, z1) + reach);
    moveAxis(g, state, 'x', state.vx * h, height, near);
    moveAxis(g, state, 'z', state.vz * h, height, near);
    // Walking off a step of up to MOVE.stepHeight follows the ground down instead of falling.
    if (onGround && state.vy <= 0) {
      const support = supportAmong(g, near, state);
      if (support < state.y && state.y - support <= MOVE.stepHeight) { state.y = support; state.vy = 0; }
    }
    // Exact for constant gravity: a 6 m/s jump peaks at 6² / (2 × 19) = 0.947 m.
    const y0 = state.y, vy0 = state.vy;
    state.vy = Math.max(-MOVE.maxFall, vy0 - MOVE.gravity * h);
    state.y = y0 + (vy0 + state.vy) * 0.5 * h;
    let landOn = -Infinity, ceiling = Infinity, pinned = false;
    for (let k = 0; k < near.length; k++) {
      const i = near[k]!, o = i * 6;
      if (!overlapsXZAt(b, i, state.x, state.z, PLAYER_RADIUS)) continue;
      const top = b[o + 4]!, bottom = b[o + 1]!;
      if (state.vy <= 0 && y0 >= top - 0.03 && state.y < top) landOn = Math.max(landOn, top);
      if (state.vy > 0 && state.y + height > bottom) {
        if (y0 + height <= bottom + 0.03) ceiling = Math.min(ceiling, bottom);
        // Already inside something overhead (a bad state): never rise further into it.
        else if (bottom > y0) pinned = true;
      }
    }
    let landed = false;
    const falling = -state.vy;
    if (landOn > -Infinity) { state.y = landOn; state.vy = 0; landed = true; }
    else if (ceiling < Infinity) { state.y = ceiling - height; state.vy = 0; }
    if (pinned) { state.y = Math.min(state.y, y0); state.vy = 0; }
    if (state.y < 0) { state.y = 0; state.vy = 0; landed = true; }
    if (landed && !onGround) events.landedSpeed = Math.max(events.landedSpeed, falling);
    onGround = landed;
  }
  if (events.landedSpeed < 2) events.landedSpeed = 0;
  return onGround;
}

/** Advance one player by one input. Mutates `state`; returns what happened for presentation.
 * Rules: ground acceleration 40 / braking 30 m/s², 20% air control that never brakes; walk 5.0,
 * back 4.0, strafe 4.5, crouch 2.6 (× weapon hip factor, or × the aimed factor while aiming);
 * sprint 6.9 forward-ish, never aiming or firing; dash 8.2 on stamina (3 s drain, 4 s refill once
 * dash is let go, fading to sprint below 20%); a held crouch keeps the player crouched unless they
 * sprint on the ground (standing needs headroom); jumps, slides and vaults as documented on MOVE and
 * findVault. A slide never moves where a crouch would not fit, so every posture always fits. */
export function movePlayer(state: MoveState, input: InputFrame, ctx: MoveContext): MoveEvents {
  const events: MoveEvents = { jumped: false, landedSpeed: 0, slideStarted: false, slideEnded: false, vaultStarted: false, vaultEnded: false, vaultCancelled: false };
  const dt = clamp(finite(ctx.dt, 0), 0, 0.1), now = ctx.now;
  repairState(state);
  if (Number.isFinite(input.yaw)) state.yaw = input.yaw;
  if (Number.isFinite(input.pitch)) state.pitch = input.pitch;
  const command: InputFrame = { ...input, moveX: finite(input.moveX, 0), moveZ: finite(input.moveZ, 0), yaw: state.yaw, pitch: state.pitch };
  const moveFactor = clamp(finite(ctx.moveFactor, 1), 0, 2), adsFactor = clamp(finite(ctx.adsFactor, 1), 0, 2);
  const jumpPressed = !!ctx.jumpPressed, crouchPressed = !!ctx.crouchPressed;

  if (state.vault) {
    advanceVault(state, command, ctx, dt, events, true);
    state.sprinting = false; state.dashing = false; refillStamina(state, dt);
    return events;
  }
  settleContacts(state, moveHeight(state.posture));
  const beginVault = (vault: VaultState): MoveEvents => {
    // A slide flows into the vault without starting the slide cooldown, so a held crouch can chain the
    // vault into a new slide (every vault is shorter than the cooldown).
    if (state.posture === 'slide') { state.slideUntil = 0; events.slideEnded = true; }
    state.vault = vault; state.posture = 'vault'; state.sprinting = false; state.dashing = false; state.vy = 0;
    events.vaultStarted = true;
    advanceVault(state, command, ctx, dt, events, false);
    refillStamina(state, dt);
    return events;
  };

  const grounded = isPlayerGrounded(state);
  const wasSprinting = !!state.sprinting, wasDashing = !!state.dashing;
  const wish = worldWish(command);
  const forwardish = command.moveZ > 0.3 && Math.abs(command.moveX) <= command.moveZ * 1.2;
  const wantsSprint = !!ctx.canSprint && !!command.sprint && forwardish && !command.aim && !command.fire;

  if (state.posture === 'slide') {
    if (jumpPressed && grounded) {
      const vault = findVault(state, command, now);
      if (vault) return beginVault(vault);
      endSlide(state, now, command.crouch, true); events.slideEnded = true;
      state.vx *= MOVE.slideJumpKeep; state.vz *= MOVE.slideJumpKeep; state.vy = MOVE.jumpSpeed; events.jumped = true;
    } else if (!grounded) {
      endSlide(state, now, command.crouch, true); events.slideEnded = true;
    } else if (now >= state.slideUntil || Math.hypot(state.vx, state.vz) <= MOVE.slideEndSpeed + 0.05) {
      endSlide(state, now, command.crouch, false); events.slideEnded = true;
    }
  } else {
    // Pressing jump on the ground, or in the air while falling slower than vaultMaxFallSpeed, catches a
    // ledge in reach; holding it does so only while still rising. A cancelled mantle leaves the player at
    // rest in the air, so grabbing the ledge again takes a fresh press.
    const airborneTry = !grounded && state.vy > -MOVE.vaultMaxFallSpeed && (jumpPressed || (command.jump && state.vy > 0));
    if ((jumpPressed && grounded) || airborneTry) {
      const vault = findVault(state, command, now);
      if (vault) return beginVault(vault);
      if (jumpPressed && grounded) {
        // Jump from a crouch stands up first (headroom permitting).
        if (state.posture === 'crouch') { if (spaceFree(state, POSTURE_HEIGHT.stand)) state.posture = 'stand'; }
        else { state.vy = MOVE.jumpSpeed; events.jumped = true; }
      }
    }
  }
  if (!events.jumped && state.posture === 'stand' && grounded && crouchPressed && wasSprinting
    && Math.hypot(state.vx, state.vz) >= MOVE.slideMinStartSpeed && now >= state.slideCooldownUntil) {
    startSlide(state, now); events.slideStarted = true;
  } else if (state.posture === 'stand' && command.crouch && grounded && !events.jumped && !wantsSprint) {
    state.posture = 'crouch';
  } else if (state.posture === 'crouch' && (!command.crouch || (grounded && wantsSprint)) && spaceFree(state, POSTURE_HEIGHT.stand)) {
    // Sprinting stands a crouched player up, as letting go of crouch does; in the air a held crouch stays tucked.
    state.posture = 'stand';
  }

  const sprinting = state.posture === 'stand' && wantsSprint && (grounded || wasSprinting);
  const dashing = sprinting && !!command.dash && (wasDashing ? state.stamina > 0 : state.stamina >= MOVE.dashRestartStamina);
  state.sprinting = sprinting; state.dashing = dashing;
  if (dashing) state.stamina = Math.max(0, state.stamina - dt * 1000 / MOVE.dashMs);
  else if (!(sprinting && command.dash)) refillStamina(state, dt);

  if (state.posture === 'slide') {
    const speed = Math.hypot(state.vx, state.vz);
    const next = Math.max(0, speed - (MOVE.slideSpeed - MOVE.slideEndSpeed) / (MOVE.slideMs / 1000) * dt);
    let heading = Math.atan2(state.vx, -state.vz);
    if (wish.magnitude > 0.1) {
      const desired = Math.atan2(wish.x, -wish.z), delta = Math.atan2(Math.sin(desired - heading), Math.cos(desired - heading));
      heading += clamp(delta, -MOVE.slideSteer * dt, MOVE.slideSteer * dt);
    }
    state.vx = Math.sin(heading) * next; state.vz = -Math.cos(heading) * next;
  } else {
    let speed = 0;
    if (wish.magnitude > 0.001) {
      const forwardness = command.moveZ / Math.max(1e-6, Math.hypot(command.moveX, command.moveZ));
      speed = forwardness >= 0 ? MOVE.strafe + (MOVE.walk - MOVE.strafe) * forwardness : MOVE.strafe + (MOVE.back - MOVE.strafe) * -forwardness;
      if (state.posture === 'crouch') speed = MOVE.crouch;
      if (sprinting) speed = dashing ? MOVE.sprint + (MOVE.dash - MOVE.sprint) * Math.min(1, state.stamina / MOVE.dashFadeStamina) : MOVE.sprint;
      speed *= (command.aim && !sprinting ? adsFactor : moveFactor) * wish.magnitude;
    }
    // The jump tick already counts as airborne: a jump keeps its take-off speed.
    if (grounded && !events.jumped) accelerateGround(state, wish.x * speed, wish.z * speed, speed, dt);
    else if (wish.magnitude > 0.001) accelerateAir(state, wish.x * speed, wish.z * speed, dt);
  }
  const landed = integrate(state, moveHeight(state.posture), grounded && !events.jumped, dt, events);
  // A body tucked in a crouch (crouch held through a vault over thin cover) that lands fast slides on.
  if (landed && !grounded && state.posture === 'crouch' && command.crouch && Math.hypot(state.vx, state.vz) >= MOVE.slideMinStartSpeed
    && now >= state.slideCooldownUntil) {
    startSlide(state, now); events.slideStarted = true;
  }
  return events;
}

// ---------------------------------------------------------------------------------------------
// Grenades.

/** Thrown grenades share one deterministic fixed-step simulation on the server and every client. */
export interface GrenadeBody extends Vec3 { vx: number; vy: number; vz: number }
export const GRENADE = {
  radius: 0.07, gravity: 14, restitution: 0.38, impactFriction: 0.7, rollFriction: 0.94, rest: 0.6, stepMs: 1000 / 60,
  /** Longest move between collision checks (m), well under the thinnest wall (0.28) or rail (0.12). */
  maxMove: 0.08,
  /** A grenade on the ground slower than this (m/s) stops. */
  sleepSpeed: 0.15,
} as const;
/** Trajectories are never replayed further than this many fixed steps (30 s). */
const MAX_GRENADE_STEPS = 1800;
const AXES = ['x', 'y', 'z'] as const;
const VELOCITY = { x: 'vx', y: 'vy', z: 'vz' } as const;
function grenadeOverlaps(b: Float64Array, i: number, x: number, y: number, z: number): boolean {
  const o = i * 6, r = GRENADE.radius;
  return x > b[o]! - r && x < b[o + 3]! + r && y > b[o + 1]! - r && y < b[o + 4]! + r && z > b[o + 2]! - r && z < b[o + 5]! + r;
}
function grenadeFree(p: Vec3): boolean {
  const r = GRENADE.radius;
  if (!(p.y >= r) || Math.abs(p.x) > ARENA_LIMITS.x - r || Math.abs(p.z) > ARENA_LIMITS.z - r) return false;
  const g = obstacleGrid(), near = obstaclesIn(p.x - r, p.x + r, p.z - r, p.z + r);
  for (let k = 0; k < near.length; k++) if (grenadeOverlaps(g.bounds, near[k]!, p.x, p.y, p.z)) return false;
  return true;
}
/** Where a move from `prior` to `body` along one axis first touches the ground, the arena edge or an
 * obstacle (the contact coordinate on that axis), or NaN when the move is free. Anything the grenade
 * was already inside does not block, so a bad start falls free instead of sticking. */
function grenadeContact(body: Vec3, prior: Vec3, axis: 'x' | 'y' | 'z'): number {
  const r = GRENADE.radius, rising = body[axis] > prior[axis];
  let contact = Number.NaN;
  const keep = (value: number) => { if (Number.isNaN(contact) || (rising ? value < contact : value > contact)) contact = value; };
  if (axis === 'y' && body.y < r && body.y <= prior.y) keep(r);
  if (axis !== 'y' && Math.abs(body[axis]) > ARENA_LIMITS[axis] - r && Math.abs(body[axis]) >= Math.abs(prior[axis])) keep(Math.sign(body[axis]) * (ARENA_LIMITS[axis] - r));
  const g = obstacleGrid(), near = obstaclesIn(body.x - r, body.x + r, body.z - r, body.z + r);
  const low = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  for (let k = 0; k < near.length; k++) {
    const i = near[k]!;
    if (grenadeOverlaps(g.bounds, i, body.x, body.y, body.z) && !grenadeOverlaps(g.bounds, i, prior.x, prior.y, prior.z)) {
      keep(rising ? g.bounds[i * 6 + low]! - r : g.bounds[i * 6 + low + 3]! + r);
    }
  }
  return contact;
}
/** One fixed step, sub-stepped so the grenade never moves more than GRENADE.maxMove between checks.
 * Returns the impact speed of a hard bounce (> 1.2 m/s), else 0. */
export function stepGrenade(body: GrenadeBody, dt = GRENADE.stepMs / 1000): number {
  if (!(dt > 0) || ![body.x, body.y, body.z, body.vx, body.vy, body.vz].every(Number.isFinite)) return 0;
  const reach = (Math.hypot(body.vx, body.vy, body.vz) + GRENADE.gravity * dt) * dt;
  const steps = Math.min(512, Math.max(1, Math.ceil(reach / GRENADE.maxMove))), h = dt / steps;
  const contact = { x: -1, y: -1, z: -1 }, prior = { x: 0, y: 0, z: 0 };
  let impact = 0, onGround = false;
  for (let s = 0; s < steps; s++) {
    body.vy -= GRENADE.gravity * h;
    for (const axis of AXES) {
      const velocity = VELOCITY[axis];
      prior.x = body.x; prior.y = body.y; prior.z = body.z;
      body[axis] += body[velocity] * h;
      const touch = grenadeContact(body, prior, axis);
      if (Number.isNaN(touch)) continue;
      // Rest against the surface it touched (between the old and new positions), else stay put.
      const lo = Math.min(prior[axis], body[axis]), hi = Math.max(prior[axis], body[axis]);
      body[axis] = touch >= lo && touch <= hi ? touch : prior[axis];
      const speed = Math.abs(body[velocity]);
      if (axis === 'y' && body.vy < 0) onGround = true;
      body[velocity] = -body[velocity] * GRENADE.restitution;
      if (axis === 'y' && Math.abs(body.vy) < GRENADE.rest) body.vy = 0;
      contact[axis] = Math.max(contact[axis], speed);
      if (speed > 1.2) impact = Math.max(impact, speed);
    }
  }
  // Contact friction once per fixed step, so the sub-step count never changes how far it rolls.
  for (const axis of AXES) {
    if (contact[axis] < 0) continue;
    const friction = contact[axis] > 1.2 ? GRENADE.impactFriction : GRENADE.rollFriction;
    for (const other of AXES) if (other !== axis) body[VELOCITY[other]] *= friction;
  }
  if (onGround && body.vy === 0 && Math.hypot(body.vx, body.vz) < GRENADE.sleepSpeed) { body.vx = 0; body.vz = 0; }
  return impact;
}
/** Launch point and velocity for a throw from the eye. The start is always in free space. */
export function grenadeLaunch(eye: Vec3, yaw: number, pitch: number, carrier: { vx: number; vz: number }, speed = 16, lift = 3): { from: Vec3; velocity: Vec3 } {
  const forward = directionFromAngles(finite(yaw, 0), finite(pitch, 0)), reach = 0.45, wall = raycastMap(eye, forward, reach);
  let distance = Math.max(0, Math.min(reach, wall - 0.12)), from = add(eye, scale(forward, distance));
  // Grazing walls or a low ceiling can leave the point inside geometry: pull it back toward the eye.
  for (let attempt = 0; attempt < 4 && distance > 0 && !grenadeFree(from); attempt++) {
    distance = attempt < 3 ? distance / 2 : 0;
    from = add(eye, scale(forward, distance));
  }
  const carrierX = finite(carrier.vx, 0), carrierZ = finite(carrier.vz, 0);
  return { from, velocity: { x: forward.x * speed + carrierX * 0.5, y: forward.y * speed + lift, z: forward.z * speed + carrierZ * 0.5 } };
}
/** Whole fixed steps in `elapsedMs` after a throw (capped at MAX_GRENADE_STEPS). */
const grenadeSteps = (elapsedMs: number) => Math.min(MAX_GRENADE_STEPS, Math.floor(elapsedMs / GRENADE.stepMs + 1e-9));
/** Replays a throw with fixed steps; callers keep one per grenade and advance it to an elapsed time. */
export class GrenadeTrajectory {
  readonly body: GrenadeBody;
  private steps = 0;
  constructor(from: Vec3, velocity: Vec3) { this.body = { x: from.x, y: from.y, z: from.z, vx: velocity.x, vy: velocity.y, vz: velocity.z }; }
  /** Advances to `elapsedMs` after the throw; returns impact speeds of hard bounces on the way. */
  advanceTo(elapsedMs: number): number[] {
    const impacts: number[] = [];
    if (!Number.isFinite(elapsedMs)) return impacts;
    const target = grenadeSteps(elapsedMs);
    while (this.steps < target) {
      const impact = stepGrenade(this.body); if (impact) impacts.push(impact);
      this.steps++;
    }
    return impacts;
  }
  /** Fixed steps simulated so far. */
  get stepCount(): number { return this.steps; }
  get position(): Vec3 { return { x: this.body.x, y: this.body.y, z: this.body.z }; }
}
/** The last few throws grenadePosition replayed, so a caller asking every frame advances one trajectory
 * instead of replaying from the throw each time. Answers are exactly those of a fresh replay. */
interface RecentThrow { from: Vec3; velocity: Vec3; grid: ObstacleGrid; trajectory: GrenadeTrajectory }
const recentThrows: RecentThrow[] = [];
const RECENT_THROWS = 8;
const sameVec = (a: Vec3, b: Vec3) => Object.is(a.x, b.x) && Object.is(a.y, b.y) && Object.is(a.z, b.z);
/** Where a throw is `elapsedMs` after it left the hand. Prefer one GrenadeTrajectory per grenade. */
export function grenadePosition(from: Vec3, velocity: Vec3, elapsedMs: number): Vec3 {
  const g = obstacleGrid(), target = grenadeSteps(elapsedMs);
  const index = recentThrows.findIndex(entry => entry.grid === g && entry.trajectory.stepCount <= target && sameVec(entry.from, from) && sameVec(entry.velocity, velocity));
  const entry = index >= 0 ? recentThrows.splice(index, 1)[0]! : {
    from: { x: from.x, y: from.y, z: from.z }, velocity: { x: velocity.x, y: velocity.y, z: velocity.z }, grid: g, trajectory: new GrenadeTrajectory(from, velocity),
  };
  entry.trajectory.advanceTo(elapsedMs);
  recentThrows.unshift(entry);
  if (recentThrows.length > RECENT_THROWS) recentThrows.length = RECENT_THROWS;
  return entry.trajectory.position;
}

