import type { SurfaceKind } from '../../../shared/protocol';

/** A small procedural atlas of marks, generated in code (no downloads). Texels are "modulate 2x"
 * multipliers: 128 leaves the surface unchanged, lower darkens it, higher brightens it. That keeps
 * marks correct in sunlight and in shade without lighting the decals themselves. */
export const DECAL_ATLAS = { columns: 4, rows: 2, cell: 64, width: 256, height: 128 } as const;
export const DECAL_CELLS = { concrete: 0, wood: 1, metal: 2, glass: 3, soft: 4, dirt: 5, scorch: 6, asphalt: 7 } as const;
export type DecalCell = keyof typeof DECAL_CELLS;
export const SURFACE_DECAL: Readonly<Record<SurfaceKind, DecalCell>> = {
  asphalt: 'asphalt', concrete: 'concrete', wood: 'wood', grass: 'dirt', metal: 'metal', fabric: 'soft', glass: 'glass', sandbag: 'soft',
};
export const NEUTRAL = 128;

export interface CellRect { u0: number; v0: number; u1: number; v1: number }
/** UV rectangle of a cell, inset half a texel so filtering never reads a neighbour. */
export function cellRect(cell: number, out: CellRect): CellRect {
  const { columns, rows, width, height, cell: size } = DECAL_ATLAS;
  const index = Math.max(0, Math.floor(cell)) % (columns * rows), column = index % columns, row = Math.floor(index / columns);
  out.u0 = (column * size + 0.5) / width; out.u1 = ((column + 1) * size - 0.5) / width;
  out.v0 = (row * size + 0.5) / height; out.v1 = ((row + 1) * size - 0.5) / height;
  return out;
}

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed), c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
const fbm = (x: number, y: number, seed: number) =>
  noise(x, y, seed) * 0.57 + noise(x * 2.03, y * 2.03, seed + 17) * 0.29 + noise(x * 4.1, y * 4.1, seed + 31) * 0.14;
/** Hermite step from edge0 to edge1 (either order). */
function smooth(edge0: number, edge1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
/** Noise that wraps cleanly around the mark, for ragged edges and radial streaks. */
const around = (theta: number, frequency: number, seed: number) => fbm(Math.cos(theta) * frequency + 40, Math.sin(theta) * frequency + 40, seed);

/** Thin jagged cracks radiating from the centre: 1 on a crack, 0 elsewhere. */
function cracks(r: number, theta: number, count: number, reach: number, width: number, seed: number) {
  let strongest = 0;
  for (let ray = 0; ray < count; ray++) {
    const angle = (ray + hash(ray, 3, seed) * 0.7) / count * Math.PI * 2 + 0.18 * Math.sin(r * 11 + ray * 1.7);
    const length = reach * (0.55 + 0.45 * hash(ray, 7, seed));
    if (r > length) continue;
    const delta = Math.abs(Math.atan2(Math.sin(theta - angle), Math.cos(theta - angle)));
    if (delta > Math.PI / 2) continue;
    const distance = r * Math.sin(delta), w = width * (1 - r / length) + 0.004;
    strongest = Math.max(strongest, (1 - smooth(w * 0.5, w, distance)) * smooth(0, 0.08, r));
  }
  return strongest;
}

/** Two short, straight splits along the wood grain (the u axis), a long one on one side of the hole and a
 * stub on the other: 1 on a split. */
function splits(u: number, v: number, hole: number, seed: number) {
  let strongest = 0;
  for (let side = -1; side <= 1; side += 2) {
    const along = u * side, key = side + 2;
    const length = side > 0 ? 0.3 + 0.12 * hash(key, 11, seed) : 0.14 + 0.06 * hash(key, 11, seed);
    const slope = (hash(key, 13, seed) - 0.5) * 0.24, offset = (hash(key, 17, seed) - 0.5) * 0.06;
    if (along < hole * 0.7 || along > length) continue;
    const across = Math.abs(v - offset - slope * along), width = 0.014 * (1 - along / length) + 0.005;
    strongest = Math.max(strongest, (1 - smooth(width * 0.5, width, across)) * smooth(hole * 0.7, hole, along));
  }
  return strongest;
}

const shade = [0, 0, 0];
/** Deviation from neutral (-0.5 black … +0.5 twice as bright) for one texel of one cell. */
function mark(cell: number, u: number, v: number, seed: number) {
  const r = Math.hypot(u, v), theta = Math.atan2(v, u);
  const rough = fbm(u * 3 + 11 + cell * 5, v * 3 + 5, seed), ragged = around(theta, 2, seed + cell * 13);
  let d = 0, warm = 0, cool = 0;
  switch (cell) {
    case DECAL_CELLS.concrete: case DECAL_CELLS.asphalt: {
      const hole = (cell === DECAL_CELLS.asphalt ? 0.11 : 0.13) + 0.05 * (ragged - 0.5), ring = 0.42 + 0.16 * (ragged - 0.5);
      d = -0.46 * (1 - smooth(hole * 0.55, hole, r));
      d += (cell === DECAL_CELLS.asphalt ? 0.09 : 0.12) * smooth(hole * 0.85, hole * 1.15, r) * (1 - smooth(ring * 0.75, ring, r)) * (0.55 + 0.45 * rough);
      d -= 0.05 * smooth(ring * 0.8, ring, r) * (1 - smooth(0.62, 0.85, r)) * rough;
      break;
    }
    case DECAL_CELLS.wood: {
      // Wood tears along its grain (the u axis): a black hole in an uneven, off-centre patch of chipped
      // paint and pale, streaky torn fibres, a shadowed torn rim, and two short straight splits. Long dark
      // cracks read as a spider; a smooth, even patch reads as an eye.
      const hole = 0.1 + 0.03 * (ragged - 0.5);
      const lean = 0.06 * (hash(1, 5, seed) - 0.5), lumps = fbm(u * 4.5 + 1, v * 4.5 + 9, seed + 21) - 0.5;
      const patch = Math.hypot((u - lean) * 0.6, v * 1.2) + 0.2 * lumps + 0.06 * (around(theta, 5, seed + 7) - 0.5);
      const streaks = smooth(0.4, 0.62, fbm(u * 2 + 7, v * 19 + 3, seed + 5));
      const torn = smooth(hole * 0.85, hole * 1.2, r) * (1 - smooth(0.15, 0.27, patch));
      d = -0.5 * (1 - smooth(hole * 0.6, hole, r));
      d += torn * (0.03 + 0.13 * streaks);
      d -= 0.08 * smooth(hole * 0.8, hole, r) * (1 - smooth(hole, hole * 1.5, r)) * (0.6 + 0.4 * rough);
      d -= 0.14 * splits(u, v, hole, seed + 1);
      warm = 0.8 * torn * (0.35 + 0.65 * streaks);
      break;
    }
    case DECAL_CELLS.metal: {
      d = -0.47 * (1 - smooth(0.06, 0.1, r));
      d += 0.2 * smooth(0.08, 0.11, r) * (1 - smooth(0.17, 0.22, r));
      d -= 0.08 * smooth(0.2, 0.24, r) * (1 - smooth(0.36, 0.5 + 0.1 * ragged, r)) * (0.5 + 0.5 * around(theta, 5, seed + 2));
      break;
    }
    case DECAL_CELLS.glass: {
      const ring = 0.3 + 0.06 * (ragged - 0.5);
      d = -0.3 * (1 - smooth(0.04, 0.07, r)) + 0.08 * (1 - smooth(0.12, 0.2, r)) * smooth(0.06, 0.08, r);
      const crack = cracks(r, theta, 9, 0.86, 0.022, seed + 4);
      d += 0.2 * crack + 0.16 * (1 - smooth(0.006, 0.016, Math.abs(r - ring))) * (ragged > 0.35 ? 1 : 0.3);
      cool = crack;
      break;
    }
    case DECAL_CELLS.soft: {
      d = -0.38 * (1 - smooth(0.06, 0.11, r));
      d -= 0.12 * (1 - smooth(0.16, 0.28 + 0.1 * ragged, r)) * (0.4 + 0.6 * rough) * smooth(0.05, 0.1, r);
      break;
    }
    case DECAL_CELLS.dirt: {
      const edge = 0.42 + 0.18 * (ragged - 0.5), clods = fbm(u * 9 + 3, v * 9 + 8, seed + 6);
      d = -0.18 * (1 - smooth(edge * 0.75, edge, r)) * (0.7 + 0.3 * rough) - 0.16 * (1 - smooth(0.06, 0.12, r));
      d -= 0.1 * (clods > 0.68 ? 1 : 0) * smooth(0.4, 0.5, r) * (1 - smooth(0.7, 0.8, r));
      warm = -0.25 * d;
      break;
    }
    default: {
      const edge = 0.78 + 0.16 * (ragged - 0.5), burn = 1 - smooth(edge * 0.35, edge, r);
      d = -0.34 * burn * (0.7 + 0.3 * rough) - 0.1 * burn * burn;
      d -= 0.08 * (1 - smooth(0.3, edge, r)) * smooth(0.3, 0.5, r) * around(theta, 6, seed + 9);
      warm = -0.08 * d;
      break;
    }
  }
  const envelope = 1 - smooth(0.8, 0.94, r);
  shade[0] = (d + 0.12 * warm) * envelope;
  shade[1] = (d + 0.08 * warm) * envelope;
  shade[2] = (d + 0.02 * warm + 0.03 * cool) * envelope;
  return shade;
}

/** Builds the RGBA atlas; the same seed always gives the same bytes. Every cell keeps a neutral border. */
export function buildDecalAtlas(seed = 7): Uint8Array {
  const { width, height, cell: size, columns, rows } = DECAL_ATLAS;
  const data = new Uint8Array(width * height * 4).fill(NEUTRAL);
  for (let index = 3; index < data.length; index += 4) data[index] = 255;
  for (let cell = 0; cell < columns * rows; cell++) {
    const x0 = (cell % columns) * size, y0 = Math.floor(cell / columns) * size;
    for (let y = 2; y < size - 2; y++) for (let x = 2; x < size - 2; x++) {
      const [dr, dg, db] = mark(cell, (x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1, seed);
      const offset = ((y0 + y) * width + x0 + x) * 4;
      data[offset] = Math.min(255, Math.max(0, Math.round(NEUTRAL + dr * 255)));
      data[offset + 1] = Math.min(255, Math.max(0, Math.round(NEUTRAL + dg * 255)));
      data[offset + 2] = Math.min(255, Math.max(0, Math.round(NEUTRAL + db * 255)));
    }
  }
  return data;
}

let shared: Uint8Array | null = null;
/** The default atlas, generated once per page and shared by every decal layer. Do not modify it. */
export function sharedDecalAtlas(): Uint8Array { return (shared ??= buildDecalAtlas()); }
