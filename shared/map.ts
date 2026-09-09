import type { Vec3 } from './protocol.js';
export const ARENA_HALF = 32;
// The inner fence faces also bound airborne movement from balconies and sheds.
export const ARENA_LIMITS = { x: 30.9, z: 22.9 } as const;
export const MAP_NAME = 'Kannon Town';
export interface MapObstacle {
  id: string; x: number; y: number; z: number; w: number; h: number; d: number;
  color: string; kind: 'wall' | 'cover' | 'platform' | 'step';
  surface?: 'teal' | 'yellow' | 'trim' | 'wood' | 'concrete' | 'bus' | 'truck' | 'fence' | 'roof';
}
export interface StairRoute { id: string; steps: string[]; landing: string; approach: Vec3; exit: Vec3 }
export const OBSTACLES: MapObstacle[] = [];
export const STAIR_ROUTES: StairRoute[] = [];
const colors = { teal: '#74a698', yellow: '#ddbf73', trim: '#e3ded0', wood: '#927355', concrete: '#bdb9ab', bus: '#d4a644', truck: '#c3cfbd', fence: '#dbd7c8', roof: '#716e64' };
function box(id: string, x: number, y: number, z: number, w: number, h: number, d: number, kind: MapObstacle['kind'] = 'wall', surface: NonNullable<MapObstacle['surface']> = 'trim') {
  OBSTACLES.push({ id, x, y, z, w, h, d, kind, surface, color: colors[surface] });
}
type Opening = { from: number; to: number; bottom: number; top: number };
/** Rectangular openings remain actual holes in collision and rendered walls. */
function wall(id: string, axis: 'x' | 'z', at: number, from: number, to: number, bottom: number, top: number, openings: Opening[], surface: NonNullable<MapObstacle['surface']>) {
  const cuts = [...new Set([from, to, ...openings.flatMap(o => [o.from, o.to])])].sort((a, b) => a - b);
  for (let i = 1; i < cuts.length; i++) {
    const a = cuts[i - 1]!, b = cuts[i]!, opening = openings.find(o => (a + b) / 2 > o.from && (a + b) / 2 < o.to);
    const spans = opening ? [[bottom, opening.bottom], [opening.top, top]] : [[bottom, top]];
    for (let j = 0; j < spans.length; j++) {
      const [lo, hi] = spans[j]!; if (hi! - lo! < 0.001) continue;
      box(`${id}-${i}-${j}`, axis === 'x' ? at : (a + b) / 2, (lo! + hi!) / 2, axis === 'z' ? at : (a + b) / 2,
        axis === 'x' ? 0.28 : b - a, hi! - lo!, axis === 'z' ? 0.28 : b - a, 'wall', surface);
    }
  }
}
for (const side of [-1, 1]) {
  const name = side < 0 ? 'teal' : 'yellow', surface = name as 'teal' | 'yellow';
  const x = (u: number) => side * u;
  const frontDoors = [{ from: -3.4, to: -1.1, bottom: 0, top: 2.65 }, { from: 1, to: 4.7, bottom: 0.95, top: 2.5 }];
  wall(`${name}-front-lower`, 'x', x(10), -6, 6, 0, 3.08, frontDoors, surface);
  wall(`${name}-front-upper`, 'x', x(10), -6, 6, 3.08, 6.3, [{ from: -3.4, to: 3.4, bottom: 4.15, top: 5.85 }], surface);
  wall(`${name}-back-lower`, 'x', x(22), -6, 6, 0, 3.08, [{ from: 2.8, to: 5.2, bottom: 0, top: 2.65 }], surface);
  wall(`${name}-back-upper`, 'x', x(22), -6, 6, 3.08, 6.3, [{ from: 3.1, to: 5.3, bottom: 3.2, top: 5.9 }], surface);
  box(`${name}-north-wall`, x(16), 3.15, -6, 12.28, 6.3, 0.28, 'wall', surface);
  const southFrom = Math.min(x(10), x(22)), southTo = Math.max(x(10), x(22));
  const doorFrom = Math.min(x(11.5), x(14)), doorTo = Math.max(x(11.5), x(14));
  wall(`${name}-south-lower`, 'z', 6, southFrom, southTo, 0, 3.08, [{ from: doorFrom, to: doorTo, bottom: 0, top: 2.65 }], surface);
  box(`${name}-south-upper`, x(16), 4.69, 6, 12.28, 3.22, 0.28, 'wall', surface);
  // Two connected rooms downstairs. The rear room contains a real stairwell.
  wall(`${name}-room-divider`, 'x', x(16), -5.86, 5.86, 0, 2.96, [{ from: -1.5, to: 1.5, bottom: 0, top: 2.7 }], 'trim');
  box(`${name}-upstairs-main`, x(13.82), 3.08, 0, 7.36, 0.24, 11.72, 'platform', 'wood');
  box(`${name}-upstairs-rear`, x(21.18), 3.08, 0, 1.36, 0.24, 11.72, 'platform', 'wood');
  box(`${name}-upstairs-south`, x(19), 3.08, 4.33, 3, 0.24, 3.06, 'platform', 'wood');
  box(`${name}-upstairs-north`, x(19), 3.08, -5.2, 3, 0.24, 1.32, 'platform', 'wood');
  box(`${name}-ceiling`, x(16), 6.31, 0, 12.28, 0.22, 12.28, 'wall', 'trim');
  box(`${name}-balcony`, x(24.08), 3.08, 4.38, 4.16, 0.24, 3.16, 'platform', 'wood');
  box(`${name}-balcony-back-rail`, x(26.1), 3.74, 4.45, 0.12, 1.08, 3.1, 'wall', 'fence');
  box(`${name}-balcony-south-rail`, x(24.1), 3.74, 5.94, 4, 1.08, 0.12, 'wall', 'fence');
  for (const route of ['inside', 'outside']) {
    const u = route === 'inside' ? 19 : 24.35;
    const steps: string[] = [];
    for (let i = 1; i <= 9; i++) {
      const id = `${name}-${route}-step-${i}`, h = i * 0.32;
      box(id, x(u), h / 2, -4 + (i - 1) * 0.8, 2.6, h, 0.82, 'step', route === 'inside' ? 'wood' : 'concrete'); steps.push(id);
    }
    STAIR_ROUTES.push({ id: `${name}-${route}`, steps, landing: `${name}-${route === 'inside' ? 'upstairs-south' : 'balcony'}`, approach: { x: x(u), y: 0, z: -5.05 }, exit: { x: x(u), y: 3.2, z: 3.45 } });
  }
  // Garage has independent street/rear entrances and connects to the kitchen.
  wall(`${name}-garage-front`, 'x', x(10), 6, 13.5, 0, 3.1, [{ from: 7.05, to: 12.55, bottom: 0, top: 2.65 }], surface);
  wall(`${name}-garage-back`, 'x', x(18), 6, 13.5, 0, 3.1, [{ from: 8.4, to: 11.3, bottom: 0, top: 2.65 }], surface);
  box(`${name}-garage-south`, x(14), 1.55, 13.5, 8.28, 3.1, 0.28, 'wall', surface);
  box(`${name}-garage-roof`, x(14), 3.15, 9.75, 8.5, 0.24, 7.75, 'wall', 'roof');
  box(`${name}-workbench`, x(17.38), 0.51, 12.25, 1, 1.02, 1.8, 'cover', 'wood');
  box(`${name}-shed`, x(28), 1.3, 16, 4.2, 2.6, 3.5, 'wall', surface);
  box(`${name}-yard-cover`, x(27), 0.6, -15, 3.5, 1.2, 1.3, 'cover', 'wood');
  box(`${name}-sofa`, x(12), 0.43, 3.8, 1.15, 0.86, 3, 'cover', 'wood');
  box(`${name}-kitchen-counter`, x(20.9), 0.48, -3.8, 1.15, 0.96, 2.2, 'cover', 'trim');
  box(`${name}-yard-fence`, x(31), 1.3, 0, 0.2, 2.6, 46, 'wall', 'fence');
  box(`${name}-side-fence`, x(24.5), 0.82, -10.5, 5.5, 1.64, 0.16, 'wall', 'fence');
}
box('north-boundary', 0, 1.3, -23, 62, 2.6, 0.2, 'wall', 'fence');
box('south-boundary', 0, 1.3, 23, 62, 2.6, 0.2, 'wall', 'fence');
box('school-bus-body', -2.4, 1.58, -4.4, 3, 2.84, 9.8, 'wall', 'bus');
box('school-bus-hood', -2.4, 0.9, -10.1, 2.8, 1.1, 1.6, 'cover', 'bus');
box('truck-cab', 2.65, 1.27, 1.2, 3.1, 2.54, 2.6, 'wall', 'truck');
box('truck-cargo-floor', 2.65, 0.18, 6.3, 3.5, 0.36, 7.6, 'platform', 'wood');
box('truck-cargo-left', 0.96, 1.7, 6.3, 0.12, 2.68, 7.6, 'wall', 'truck');
box('truck-cargo-right', 4.34, 1.7, 6.3, 0.12, 2.68, 7.6, 'wall', 'truck');
box('truck-cargo-front', 2.65, 1.7, 2.52, 3.5, 2.68, 0.12, 'wall', 'truck');
box('truck-cargo-roof', 2.65, 3.1, 6.3, 3.5, 0.12, 7.6, 'wall', 'truck');
box('cargo-crate-left', 1.7, .76, 3.3, .68, .8, .8, 'cover', 'wood');
box('cargo-crate-right', 3.4, .76, 3.7, .68, .8, .8, 'cover', 'wood');
STAIR_ROUTES.push({ id: 'truck-entry', steps: [], landing: 'truck-cargo-floor', approach: { x: 2.65, y: 0, z: 11 }, exit: { x: 2.65, y: 0.36, z: 9.3 } });
box('south-car', -3.9, 0.65, 16.2, 4.7, 1.3, 2.05, 'cover', 'teal');
box('north-car', 4, 0.65, -17.4, 4.7, 1.3, 2.05, 'cover', 'yellow');
box('south-car-cabin', -3.9, 1.38, 16.2, 2.55, .72, 1.8, 'cover', 'teal');
box('north-car-cabin', 4, 1.38, -17.4, 2.55, .72, 1.8, 'cover', 'yellow');
box('north-mail-crates', -4.8, 0.7, -17, 2.3, 1.4, 2.2, 'cover', 'wood');
box('south-planter', 6.5, 0.68, 16.5, 2.2, 1.36, 3.5, 'cover', 'concrete');

export const SPAWNS: Array<Vec3 & { yaw: number }> = [
  { x: -28, y: 0, z: -18.5, yaw: Math.PI / 2 }, { x: 28, y: 0, z: 20, yaw: -Math.PI / 2 },
  { x: -28, y: 0, z: 20, yaw: Math.PI / 2 }, { x: 28, y: 0, z: -18.5, yaw: -Math.PI / 2 },
  { x: -23.5, y: 0, z: -18, yaw: Math.PI / 2 }, { x: 23.5, y: 0, z: 18.5, yaw: -Math.PI / 2 },
  { x: -23.5, y: 0, z: 18.5, yaw: Math.PI / 2 }, { x: 23.5, y: 0, z: -18, yaw: -Math.PI / 2 },
];
