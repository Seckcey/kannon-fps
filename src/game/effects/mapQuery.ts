import { OBSTACLES } from '../../../shared/map';

/** Allocation-free map queries for cosmetic effects. They repeat the arithmetic of the shared
 * `raycastMap` exactly (a test checks they agree), without creating objects per box or per ray. */

let bounds = new Float64Array(0);
let builtFor = -1;
/** Flat [minX, minY, minZ, maxX, maxY, maxZ] per obstacle; rebuilt only if the list changes length. */
function obstacleBounds(): Float64Array {
  if (builtFor === OBSTACLES.length) return bounds;
  bounds = new Float64Array(OBSTACLES.length * 6);
  for (let index = 0; index < OBSTACLES.length; index++) {
    const box = OBSTACLES[index], offset = index * 6;
    bounds[offset] = box.x - box.w / 2; bounds[offset + 1] = box.y - box.h / 2; bounds[offset + 2] = box.z - box.d / 2;
    bounds[offset + 3] = box.x + box.w / 2; bounds[offset + 4] = box.y + box.h / 2; bounds[offset + 5] = box.z + box.d / 2;
  }
  builtFor = OBSTACLES.length;
  return bounds;
}

let near = 0, far = 0;
function slab(origin: number, direction: number, min: number, max: number): boolean {
  if (Math.abs(direction) < 1e-8) return !(origin < min || origin > max);
  const a = (min - origin) / direction, b = (max - origin) / direction;
  near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
  return !(near > far);
}

/** Distance along a unit ray to the first obstacle face or the ground (y = 0), capped at `limit`. */
export function rayDistance(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, limit = 200): number {
  const boxes = obstacleBounds();
  let result = limit;
  for (let index = 0; index < boxes.length; index += 6) {
    near = 0; far = limit;
    if (!slab(ox, dx, boxes[index], boxes[index + 3]) || !slab(oy, dy, boxes[index + 1], boxes[index + 4]) || !slab(oz, dz, boxes[index + 2], boxes[index + 5])) continue;
    if (far >= 0 && near <= limit && near < result) result = near;
  }
  if (dy < -1e-6) { const floor = -oy / dy; if (floor >= 0 && floor < result) result = floor; }
  return result;
}

/** Height of the first surface at or below a point: an obstacle top or the ground. */
export function groundBelow(x: number, y: number, z: number, reach = 40): number {
  if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return 0;
  const start = y + 0.05, distance = rayDistance(x, start, z, 0, -1, 0, reach);
  return distance >= reach ? Math.max(0, start - reach) : start - distance;
}

/** A round mark on a level surface: its centre and radius in metres. */
export interface GroundMark { x: number; z: number; radius: number }
export const createGroundMark = (): GroundMark => ({ x: 0, z: 0, radius: 0 });

/** A mark may slide this far (times the radius it wants) from its blast. The slide is searched on rings
 * and directions, and each metre of sliding costs this much against a metre of radius. */
const MARK_DRIFT = 1.45, MARK_RINGS = 16, MARK_DIRECTIONS = 24, MARK_SLIDE_COST = 0.3;
/** Boxes rising through this height above the surface block a mark; a raised floor within this
 * tolerance of the surface is the one it lies on. */
const MARK_LIFT = 0.05, SUPPORT_TOLERANCE = 0.03;
let nearby = new Int32Array(64);

/** Ground distance from (x, z) to the footprint of the box at `offset`; 0 inside it. */
function footprintGap(boxes: Float64Array, offset: number, x: number, z: number): number {
  const dx = Math.max(boxes[offset] - x, 0, x - boxes[offset + 3]), dz = Math.max(boxes[offset + 2] - z, 0, z - boxes[offset + 5]);
  return Math.sqrt(dx * dx + dz * dz);
}

/** Whether the ground path from a to b touches the footprint of the box at `offset`. */
function crossesFootprint(boxes: Float64Array, offset: number, ax: number, az: number, bx: number, bz: number): boolean {
  let enter = 0, leave = 1;
  for (let axis = 0; axis < 2; axis++) {
    const start = axis ? az : ax, delta = (axis ? bz : bx) - start, min = boxes[offset + axis * 2], max = boxes[offset + 3 + axis * 2];
    if (Math.abs(delta) < 1e-12) { if (start < min || start > max) return false; continue; }
    const t1 = (min - start) / delta, t2 = (max - start) / delta;
    enter = Math.max(enter, Math.min(t1, t2)); leave = Math.min(leave, Math.max(t1, t2));
    if (enter > leave) return false;
  }
  return true;
}

/** Fits a round mark (a scorch) of up to `radius` metres on the level surface at height `ground` around
 * (x, z). Whatever stands on that surface (walls, fences, cover) hides the part of a mark under it, but a
 * mark that runs on under a wall shows again on the floor of the room behind it, and testing only the
 * four compass directions misses every corner. So the whole disc is kept clear of each footprint that
 * rises through the surface (closest point on each box), and on the top of the box it lies on when that
 * is a raised floor (a balcony, a truck bed). The mark slides away from obstacles first, never through
 * one, stays close to its blast, and shrinks only when boxed in. False when not even `minimum` fits. */
export function fitGroundMark(x: number, ground: number, z: number, radius: number, out: GroundMark, minimum = 0.25): boolean {
  if (!(Number.isFinite(x) && Number.isFinite(ground) && Number.isFinite(z) && Number.isFinite(radius)) || !(radius >= minimum)) return false;
  const boxes = obstacleBounds(), plane = ground + MARK_LIFT, reach = radius * (1 + MARK_DRIFT) + 0.05;
  // Only what rises through the surface blocks the mark; a box overhead (a bus body, a balcony) does not.
  const blocks = (offset: number) => boxes[offset + 1] <= plane && boxes[offset + 4] >= plane;
  // A blast reported a hair inside a footprint steps out through its nearest side first.
  let px = x, pz = z;
  for (let pass = 0; pass < 2; pass++) for (let offset = 0; offset < boxes.length; offset += 6) {
    if (!blocks(offset) || !(px > boxes[offset] && px < boxes[offset + 3] && pz > boxes[offset + 2] && pz < boxes[offset + 5])) continue;
    const toWest = px - boxes[offset], toEast = boxes[offset + 3] - px, toNorth = pz - boxes[offset + 2], toSouth = boxes[offset + 5] - pz;
    const least = Math.min(toWest, toEast, toNorth, toSouth);
    if (least === toWest) px = boxes[offset] - 1e-3; else if (least === toEast) px = boxes[offset + 3] + 1e-3;
    else if (least === toNorth) pz = boxes[offset + 2] - 1e-3; else pz = boxes[offset + 5] + 1e-3;
  }
  if (nearby.length < boxes.length / 6) nearby = new Int32Array(boxes.length / 6);
  let count = 0, supportGap = Infinity, west = -Infinity, east = Infinity, north = -Infinity, south = Infinity;
  for (let offset = 0; offset < boxes.length; offset += 6) {
    if (ground > SUPPORT_TOLERANCE) {
      const gap = Math.abs(boxes[offset + 4] - ground);
      if (gap <= SUPPORT_TOLERANCE && gap < supportGap
        && x >= boxes[offset] - SUPPORT_TOLERANCE && x <= boxes[offset + 3] + SUPPORT_TOLERANCE
        && z >= boxes[offset + 2] - SUPPORT_TOLERANCE && z <= boxes[offset + 5] + SUPPORT_TOLERANCE) {
        supportGap = gap; west = boxes[offset]; east = boxes[offset + 3]; north = boxes[offset + 2]; south = boxes[offset + 5];
      }
    }
    if (blocks(offset) && footprintGap(boxes, offset, px, pz) <= reach) nearby[count++] = offset;
  }
  let best = -Infinity, bestX = px, bestZ = pz, bestRadius = 0;
  for (let ring = 0; ring <= MARK_RINGS; ring++) {
    const slide = radius * MARK_DRIFT * ring / MARK_RINGS;
    // Nothing further out can beat the best placement found so far.
    if (radius - MARK_SLIDE_COST * slide <= best) break;
    for (let step = 0, steps = ring ? MARK_DIRECTIONS : 1; step < steps; step++) {
      const angle = step / steps * Math.PI * 2, cx = px + Math.cos(angle) * slide, cz = pz + Math.sin(angle) * slide;
      let fit = Math.min(radius, cx - west, east - cx, cz - north, south - cz);
      for (let index = 0; index < count && fit - MARK_SLIDE_COST * slide > best; index++) fit = Math.min(fit, footprintGap(boxes, nearby[index], cx, cz));
      const score = fit - MARK_SLIDE_COST * slide;
      if (!(fit >= minimum) || slide > MARK_DRIFT * fit || score <= best) continue;
      let blocked = false;
      for (let index = 0; index < count && !blocked && slide > 0; index++) blocked = crossesFootprint(boxes, nearby[index], px, pz, cx, cz);
      if (blocked) continue;
      best = score; bestX = cx; bestZ = cz; bestRadius = fit;
    }
  }
  if (best === -Infinity) return false;
  out.x = bestX; out.z = bestZ; out.radius = bestRadius;
  return true;
}

/** An obstacle face holding a contact: the axis of its normal, the face plane and its rectangle. */
export interface FaceBounds {
  axis: 0 | 1 | 2; sign: 1 | -1; plane: number;
  /** In-plane axes and the face extent along them. */
  u: 0 | 1 | 2; v: 0 | 1 | 2; uMin: number; uMax: number; vMin: number; vMax: number;
}
export const createFaceBounds = (): FaceBounds => ({ axis: 0, sign: 1, plane: 0, u: 1, v: 2, uMin: 0, uMax: 0, vMin: 0, vMax: 0 });

const point = new Float64Array(3);
/** Finds the obstacle face a contact lies on (axis-aligned normals only). False for the open ground,
 * tilted normals, or a point that is on no face. */
export function faceAt(px: number, py: number, pz: number, nx: number, ny: number, nz: number, out: FaceBounds, tolerance = 0.03): boolean {
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  const axis: 0 | 1 | 2 = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
  const major = axis === 0 ? nx : axis === 1 ? ny : nz;
  if (Math.abs(major) < 0.98 * Math.hypot(nx, ny, nz)) return false;
  const sign: 1 | -1 = major > 0 ? 1 : -1;
  const u: 0 | 1 | 2 = axis === 0 ? 1 : 0, v: 0 | 1 | 2 = axis === 2 ? 1 : 2;
  point[0] = px; point[1] = py; point[2] = pz;
  const boxes = obstacleBounds();
  let best = Infinity;
  for (let index = 0; index < boxes.length; index += 6) {
    const plane = sign > 0 ? boxes[index + 3 + axis] : boxes[index + axis];
    const gap = Math.abs(point[axis] - plane);
    if (gap > tolerance || gap >= best) continue;
    const uMin = boxes[index + u], uMax = boxes[index + 3 + u], vMin = boxes[index + v], vMax = boxes[index + 3 + v];
    if (point[u] < uMin - tolerance || point[u] > uMax + tolerance || point[v] < vMin - tolerance || point[v] > vMax + tolerance) continue;
    best = gap;
    out.axis = axis; out.sign = sign; out.plane = plane; out.u = u; out.v = v;
    out.uMin = uMin; out.uMax = uMax; out.vMin = vMin; out.vMax = vMax;
  }
  return best < Infinity;
}
