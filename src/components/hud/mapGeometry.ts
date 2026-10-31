import { ARENA_LIMITS, OBSTACLES, type MapObstacle } from '../../../shared/map';

/** Top-down footprint of one collision box, top-left corner in world metres (x right, z down = south). */
export interface MapRect { id: string; x: number; z: number; w: number; d: number; kind: 'roof' | 'floor' | 'cover' | 'wall' }
const ORDER: Record<MapRect['kind'], number> = { roof: 0, floor: 1, cover: 2, wall: 3 };

/** What you can bump into at ground level: walls, fences and cover, plus stairs and building roofs drawn faintly.
 * Upper floors, rails and the parts of walls above doors are left out, so doorways read as gaps. */
export function minimapRects(obstacles: readonly MapObstacle[] = OBSTACLES): MapRect[] {
  const rects: MapRect[] = [];
  for (const o of obstacles) {
    const bottom = o.y - o.h / 2;
    const roof = /ceiling|roof/.test(o.id);
    if (!roof && bottom > 2) continue;
    const kind: MapRect['kind'] = roof ? 'roof' : o.kind === 'wall' ? 'wall' : o.kind === 'cover' ? 'cover' : 'floor';
    rects.push({ id: o.id, x: o.x - o.w / 2, z: o.z - o.d / 2, w: o.w, d: o.d, kind });
  }
  return rects.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
}

export interface MapView { x: number; z: number; yaw: number }
export interface MapPoint { u: number; v: number }
/** World point to the rotating minimap, relative to its centre, with the view direction pointing up.
 * Yaw 0 looks toward -z (north); positive yaw turns toward +x. */
export function toMinimap(view: MapView, x: number, z: number, scale = 1): MapPoint {
  const dx = x - view.x, dz = z - view.z, c = Math.cos(view.yaw), s = Math.sin(view.yaw);
  return { u: (dx * c + dz * s) * scale, v: (dz * c - dx * s) * scale };
}
/** SVG transform that draws world geometry in the same frame as `toMinimap` (centre at the origin). */
export function minimapTransform(view: MapView): string {
  const degrees = -view.yaw * 180 / Math.PI;
  return `rotate(${round(degrees, 3)}) translate(${round(-view.x, 3)} ${round(-view.z, 3)})`;
}
/** Keeps a point inside a square frame of half-size `half`, pulling outside points to its edge. */
export function clampToFrame(point: MapPoint, half: number): MapPoint & { clamped: boolean } {
  const reach = Math.max(Math.abs(point.u), Math.abs(point.v));
  if (reach <= half) return { ...point, clamped: false };
  const scale = half / reach;
  return { u: point.u * scale, v: point.v * scale, clamped: true };
}
/** Clockwise rotation (radians) for a marker facing `yaw` on a map that faces `viewYaw`. */
export function headingOnMinimap(viewYaw: number, yaw: number): number {
  return Math.atan2(Math.sin(yaw - viewYaw), Math.cos(yaw - viewYaw));
}
/** Where north sits on the rotating minimap, as a unit direction. */
export function northOnMinimap(viewYaw: number): MapPoint {
  return { u: -Math.sin(viewYaw), v: -Math.cos(viewYaw) };
}

/** The north-up arena map used to aim the mortar. */
export const ARENA_MAP = { x: 32, z: 24 } as const;
const TARGET_MARGIN = 0.5;
export function arenaToMap(x: number, z: number, width: number, height: number): MapPoint {
  return { u: (x + ARENA_MAP.x) / (2 * ARENA_MAP.x) * width, v: (z + ARENA_MAP.z) / (2 * ARENA_MAP.z) * height };
}
/** A tap on the arena map as a world target, always inside the arena so the server accepts it. */
export function mapToArena(u: number, v: number, width: number, height: number): { x: number; z: number } {
  const x = (u / Math.max(1, width)) * 2 * ARENA_MAP.x - ARENA_MAP.x;
  const z = (v / Math.max(1, height)) * 2 * ARENA_MAP.z - ARENA_MAP.z;
  const limitX = ARENA_LIMITS.x - TARGET_MARGIN, limitZ = ARENA_LIMITS.z - TARGET_MARGIN;
  return { x: round(clamp(Number.isFinite(x) ? x : 0, -limitX, limitX), 2), z: round(clamp(Number.isFinite(z) ? z : 0, -limitZ, limitZ), 2) };
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
function round(value: number, digits: number) { const f = 10 ** digits; return Math.round(value * f) / f + 0; }
