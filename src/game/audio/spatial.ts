import type { Vec3 } from '../../../shared/protocol';
import { OBSTACLES } from '../../../shared/map';

/** Where a sound is relative to the listener, and what the air and the town do to it on the way. */

export const SPEED_OF_SOUND = 343;
export interface ListenerPose { x: number; y: number; z: number; yaw: number; indoors: boolean }
/** Listener-space offset: metres to the right, up and ahead (the game's yaw: 0 faces -Z, right is +X). */
export interface Relative { right: number; up: number; ahead: number; distance: number }

export const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const finitePoint = (point: unknown): point is Vec3 =>
  !!point && typeof point === 'object' && finite((point as Vec3).x) && finite((point as Vec3).y) && finite((point as Vec3).z);

export function relative(listener: ListenerPose, point: Vec3): Relative {
  const dx = point.x - listener.x, dy = point.y - listener.y, dz = point.z - listener.z;
  const cos = Math.cos(listener.yaw), sin = Math.sin(listener.yaw);
  return { right: dx * cos + dz * sin, up: dy, ahead: dx * sin - dz * cos, distance: Math.hypot(dx, dy, dz) };
}

/** Equal-power stereo position (-1 left … 1 right). Never fully one-sided, which sounds unnatural. */
export function stereoPan(rel: Relative): number {
  return Math.max(-1, Math.min(1, rel.right / Math.max(1, rel.distance))) * 0.85;
}

/** 0 when the source is ahead or to the side, up to 1 directly behind. */
export const behind = (rel: Relative) => Math.max(0, -rel.ahead / Math.max(1, rel.distance));

/** Distance behaviour per kind of sound. Gunfire and blasts carry across the whole town; footsteps
 * fade within ~25 m so they reveal only nearby players. `air` sets how fast the highs roll off. */
export type Falloff = 'gun' | 'explosion' | 'step' | 'impact' | 'foley' | 'whistle' | 'flyby' | 'drone';
const FALLOFF: Record<Falloff, { reference: number; power: number; floor: number; reach: number; air: number }> = {
  gun: { reference: 9, power: 1, floor: 0.05, reach: 250, air: 45 },
  explosion: { reference: 14, power: 1, floor: 0.06, reach: 250, air: 60 },
  step: { reference: 4.5, power: 2, floor: 0, reach: 28, air: 25 },
  impact: { reference: 6, power: 1.6, floor: 0, reach: 45, air: 30 },
  foley: { reference: 4, power: 2, floor: 0, reach: 24, air: 25 },
  whistle: { reference: 18, power: 1, floor: 0.15, reach: 250, air: 80 },
  flyby: { reference: 3, power: 1, floor: 0.5, reach: 15, air: 100 },
  drone: { reference: 10, power: 1.3, floor: 0.04, reach: 140, air: 40 },
};
export function falloffGain(kind: Falloff, distance: number): number {
  const f = FALLOFF[kind], d = Math.max(0, distance);
  if (d >= f.reach) return 0;
  const gain = Math.max(f.floor, 1 / (1 + Math.pow(d / f.reference, f.power)));
  // Sounds with a hard reach fade out over the last 20% instead of stopping at a line.
  const edge = f.floor === 0 ? Math.min(1, (f.reach - d) / (f.reach * 0.2)) : 1;
  return gain * edge;
}
/** Air and distance take the highs away: ~20 kHz close, ~10 kHz at 30 m for gunfire, ~5 kHz at 60 m. */
export function airCutoff(kind: Falloff, distance: number): number {
  return Math.max(1800, Math.min(20000, 20000 * Math.exp(-Math.max(0, distance) / FALLOFF[kind].air)));
}
/** Reverb send relative to the source level: the reverberant field falls off far slower than the
 * direct sound, so distant sounds are wetter, which is how the ear judges distance. */
export const wetDistance = (distance: number) => 1 / (1 + Math.max(0, distance) / 35);

/** Close and far gun layers by distance: the close shot alone within 12 m, then the far boom takes
 * over while the close shot fades to a third. */
export function nearFarMix(distance: number): { near: number; far: number } {
  const d = Math.max(0, distance);
  const near = d <= 12 ? 1 : Math.max(0.35, 1 - 0.65 * (d - 12) / 43);
  const t = Math.min(1, Math.max(0, (d - 10) / 35));
  return { near, far: 0.9 * t * t * (3 - 2 * t) };
}

/** Packed obstacle bounds for allocation-free segment tests. Walls and floors block sound almost
 * completely; low cover (cars, sandbags, crates) and stairs only partly, since sound bends over them. */
let bounds: Float32Array | null = null;
let weights: Float32Array | null = null;
function packed() {
  if (!bounds || !weights) {
    bounds = new Float32Array(OBSTACLES.length * 6); weights = new Float32Array(OBSTACLES.length);
    OBSTACLES.forEach((box, i) => {
      bounds![i * 6] = box.x - box.w / 2; bounds![i * 6 + 1] = box.y - box.h / 2; bounds![i * 6 + 2] = box.z - box.d / 2;
      bounds![i * 6 + 3] = box.x + box.w / 2; bounds![i * 6 + 4] = box.y + box.h / 2; bounds![i * 6 + 5] = box.z + box.d / 2;
      weights![i] = box.kind === 'cover' ? 0.45 : box.kind === 'step' ? 0.3 : 1;
    });
  }
  return { bounds, weights };
}

/** 0 (clear line) … 1 (behind several walls) between two points. Each wall crossed removes ~70%. */
export function occlusion(from: Vec3, to: Vec3): number {
  const { bounds: b, weights: w } = packed();
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  let open = 1;
  for (let i = 0; i < w.length; i++) {
    let near = 0, far = 1, o = i * 6;
    // Slab test on the segment parameter t in [0, 1].
    if (Math.abs(dx) < 1e-9) { if (from.x < b[o] || from.x > b[o + 3]) continue; }
    else { const a = (b[o] - from.x) / dx, c = (b[o + 3] - from.x) / dx; near = Math.max(near, Math.min(a, c)); far = Math.min(far, Math.max(a, c)); if (near > far) continue; }
    if (Math.abs(dy) < 1e-9) { if (from.y < b[o + 1] || from.y > b[o + 4]) continue; }
    else { const a = (b[o + 1] - from.y) / dy, c = (b[o + 4] - from.y) / dy; near = Math.max(near, Math.min(a, c)); far = Math.min(far, Math.max(a, c)); if (near > far) continue; }
    if (Math.abs(dz) < 1e-9) { if (from.z < b[o + 2] || from.z > b[o + 5]) continue; }
    else { const a = (b[o + 2] - from.z) / dz, c = (b[o + 5] - from.z) / dz; near = Math.max(near, Math.min(a, c)); far = Math.min(far, Math.max(a, c)); if (near > far) continue; }
    // A box the segment starts or ends inside (a listener against a wall) does not count.
    if (near <= 0.001 || near >= 0.999) continue;
    open *= 1 - 0.7 * w[i];
    if (open < 0.05) break;
  }
  return 1 - open;
}

/** True when a solid floor, ceiling or roof is within 9 m above the point: the source is indoors
 * (a house, a garage, the truck's cargo box) and should ring with the room reverb. */
export function coveredAbove(point: Vec3): boolean {
  const { bounds: b, weights: w } = packed();
  for (let i = 0; i < w.length; i++) {
    const o = i * 6;
    if (w[i] < 1 || point.x < b[o] || point.x > b[o + 3] || point.z < b[o + 2] || point.z > b[o + 5]) continue;
    if (b[o + 1] > point.y + 0.05 && b[o + 1] < point.y + 9 && b[o + 3] - b[o] > 1.2 && b[o + 5] - b[o + 2] > 1.2) return true;
  }
  return false;
}

/** Moves a point a little toward the listener, so a sound on a wall face or the ground is not
 * hidden by the very surface it came from. */
export function towardListener(listener: Vec3, point: Vec3, metres: number, lift = 0): Vec3 {
  const dx = listener.x - point.x, dy = listener.y - point.y, dz = listener.z - point.z, d = Math.hypot(dx, dy, dz);
  const k = d > 1e-6 ? Math.min(metres, d * 0.5) / d : 0;
  return { x: point.x + dx * k, y: point.y + lift + dy * k, z: point.z + dz * k };
}
