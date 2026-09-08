import { ARENA_HALF, OBSTACLES } from './map.js';
import type { InputFrame, Vec3 } from './protocol.js';
export const PLAYER_RADIUS = 0.42;
export const PLAYER_HEIGHT = 1.8;
export const WALK_SPEED = 6.5;
export const SPRINT_SPEED = 9;
export const GRAVITY = 22;
export interface KinematicState extends Vec3 { vx: number; vy: number; vz: number; yaw: number; pitch: number }
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export function directionFromAngles(yaw: number, pitch: number): Vec3 {
  return { x: Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
}
export function muzzlePosition(player: Vec3): Vec3 { return { x: player.x, y: player.y + 1.45, z: player.z }; }
/** Camera and authoritative aim share a shoulder offset. Client clips camera against walls. */
export function cameraPosition(player: Vec3, yaw: number, pitch: number, aim = false): Vec3 {
  const forward = directionFromAngles(yaw, pitch);
  const distance = aim ? 2.2 : 3.5;
  const shoulder = aim ? 0.65 : 0.82;
  const pivot = muzzlePosition(player);
  const desired = { x: pivot.x - forward.x * distance + Math.cos(yaw) * shoulder,
    y: pivot.y - forward.y * distance + (aim ? 0.25 : 0.45),
    z: pivot.z - forward.z * distance + Math.sin(yaw) * shoulder };
  const delta = subtract(desired, pivot);
  const length = magnitude(delta);
  const wall = raycastMap(pivot, normalize(delta), length);
  return wall < length ? add(pivot, scale(normalize(delta), Math.max(0.1, wall - 0.2))) : desired;
}
export const subtract = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const scale = (v: Vec3, k: number): Vec3 => ({ x: v.x * k, y: v.y * k, z: v.z * k });
export const magnitude = (v: Vec3) => Math.hypot(v.x, v.y, v.z);
export function normalize(v: Vec3): Vec3 { const len = magnitude(v); return len > 0 ? scale(v, 1 / len) : { x: 0, y: 0, z: -1 }; }
export function rayBox(origin: Vec3, direction: Vec3, min: Vec3, max: Vec3, limit = 200): number {
  let near = 0; let far = limit;
  for (const axis of ['x', 'y', 'z'] as const) {
    if (Math.abs(direction[axis]) < 1e-8) { if (origin[axis] < min[axis] || origin[axis] > max[axis]) return Infinity; }
    else {
      const a = (min[axis] - origin[axis]) / direction[axis]; const b = (max[axis] - origin[axis]) / direction[axis];
      near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
      if (near > far) return Infinity;
    }
  }
  return far >= 0 && near <= limit ? near : Infinity;
}
export function raycastMap(origin: Vec3, direction: Vec3, limit = 200): number {
  let result = limit;
  for (const box of OBSTACLES) result = Math.min(result, rayBox(origin, direction,
    { x: box.x - box.w / 2, y: box.y - box.h / 2, z: box.z - box.d / 2 },
    { x: box.x + box.w / 2, y: box.y + box.h / 2, z: box.z + box.d / 2 }, limit));
  if (direction.y < -1e-6) { const floor = -origin.y / direction.y; if (floor >= 0) result = Math.min(result, floor); }
  return result;
}
function overlapsXZ(state: Vec3, box: typeof OBSTACLES[number]) {
  return state.x + PLAYER_RADIUS > box.x - box.w / 2 && state.x - PLAYER_RADIUS < box.x + box.w / 2 &&
    state.z + PLAYER_RADIUS > box.z - box.d / 2 && state.z - PLAYER_RADIUS < box.z + box.d / 2;
}
function supportAt(state: Vec3): number {
  let support = 0;
  for (const box of OBSTACLES) { const top = box.y + box.h / 2; if (overlapsXZ(state, box) && top <= state.y + 0.06) support = Math.max(support, top); }
  return support;
}
export function movePlayer(state: KinematicState, input: InputFrame, dt: number, canJump = true): void {
  dt = clamp(dt, 0, 0.1);
  state.yaw = input.yaw; state.pitch = input.pitch;
  let mx = input.moveX; let mz = input.moveZ; const length = Math.hypot(mx, mz);
  if (length > 1) { mx /= length; mz /= length; }
  const speed = input.aim ? 4 : input.sprint ? SPRINT_SPEED : WALK_SPEED;
  state.vx = (mx * Math.cos(input.yaw) + mz * Math.sin(input.yaw)) * speed;
  state.vz = (mx * Math.sin(input.yaw) - mz * Math.cos(input.yaw)) * speed;
  if (input.jump && canJump && Math.abs(state.y - supportAt(state)) < 0.06 && state.vy <= 0) state.vy = 8;
  const steps = Math.max(1, Math.ceil(dt / (1 / 90))); const step = dt / steps;
  for (let index = 0; index < steps; index++) {
    for (const axis of ['x', 'z'] as const) {
      const prior = state[axis]; state[axis] += state[axis === 'x' ? 'vx' : 'vz'] * step;
      state[axis] = clamp(state[axis], -ARENA_HALF + PLAYER_RADIUS, ARENA_HALF - PLAYER_RADIUS);
      for (const box of OBSTACLES) {
        if (!overlapsXZ(state, box) || state.y + PLAYER_HEIGHT <= box.y - box.h / 2 + 0.02 || state.y >= box.y + box.h / 2 - 0.01) continue;
        const rise = box.y + box.h / 2 - state.y;
        if (rise <= 0.45 && state.vy <= 0.1) state.y = box.y + box.h / 2;
        else { state[axis] = prior; break; }
      }
    }
    const previousY = state.y; state.vy -= GRAVITY * step; state.y += state.vy * step;
    for (const box of OBSTACLES) {
      if (!overlapsXZ(state, box)) continue;
      const top = box.y + box.h / 2; const bottom = box.y - box.h / 2;
      if (state.vy <= 0 && previousY >= top - 0.03 && state.y < top) { state.y = top; state.vy = 0; }
      if (state.vy > 0 && previousY + PLAYER_HEIGHT <= bottom + 0.03 && state.y + PLAYER_HEIGHT > bottom) { state.y = bottom - PLAYER_HEIGHT; state.vy = 0; }
    }
    if (state.y < 0) { state.y = 0; state.vy = 0; }
  }
}
