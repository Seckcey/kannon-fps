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
