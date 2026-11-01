import test from 'node:test';
import assert from 'node:assert/strict';
import { ARENA_LIMITS, OBSTACLES } from '../../shared/map.js';
import { arenaToMap, clampToFrame, headingOnMinimap, mapToArena, minimapRects, minimapTransform, northOnMinimap, toMinimap } from '../../src/components/hud/mapGeometry.js';

const near = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} ≈ ${expected}`);

test('the minimap draws ground-level walls and cover, keeps doorways open and skips upper floors', () => {
  const rects = minimapRects();
  const byId = new Map(rects.map(rect => [rect.id, rect]));
  assert.equal(byId.get('teal-north-wall')?.kind, 'wall');
  assert.equal(byId.get('south-car')?.kind, 'cover');
  assert.equal(byId.get('west-lane-sandbags')?.kind, 'cover', 'v3 checkpoint cover is on the map');
  assert.equal(byId.get('teal-inside-step-1')?.kind, 'floor');
  assert.equal(byId.get('teal-ceiling')?.kind, 'roof');
  for (const id of ['teal-upstairs-main', 'teal-balcony', 'teal-balcony-back-rail', 'teal-front-upper-1-0']) assert.equal(byId.has(id), false, `${id} is above ground level`);
  // Ground floor walls only: the teal front door at x = -10 between z -3.4 and -1.1 stays open.
  const blocking = rects.filter(rect => rect.kind === 'wall' && -10 >= rect.x && -10 <= rect.x + rect.w && -2.25 >= rect.z && -2.25 <= rect.z + rect.d);
  assert.deepEqual(blocking, []);
  const order = { roof: 0, floor: 1, cover: 2, wall: 3 };
  for (let i = 1; i < rects.length; i++) assert.ok(order[rects[i - 1]!.kind] <= order[rects[i]!.kind], 'roofs and floors are drawn under walls');
  const car = OBSTACLES.find(o => o.id === 'south-car')!;
  assert.deepEqual(byId.get('south-car'), { id: 'south-car', x: car.x - car.w / 2, z: car.z - car.d / 2, w: car.w, d: car.d, kind: 'cover' });
});

test('the rotating minimap puts the view direction up and the right-hand side right', () => {
  const north = { x: 0, z: 0, yaw: 0 };
  assert.deepEqual(toMinimap(north, 0, -10), { u: 0, v: -10 });
  assert.deepEqual(toMinimap(north, 5, 0, 2), { u: 10, v: 0 });
  const east = { x: 0, z: 0, yaw: Math.PI / 2 };
  const ahead = toMinimap(east, 10, 0), right = toMinimap(east, 0, 10);
  near(ahead.u, 0); near(ahead.v, -10);
  near(right.u, 10); near(right.v, 0);
  const moved = toMinimap({ x: 4, z: -3, yaw: 0 }, 4, -8);
  near(moved.u, 0); near(moved.v, -5);
});

test('the SVG transform draws the map in the same frame as the blips', () => {
  const view = { x: -12.5, z: 6.25, yaw: 0.7 };
  const match = /^rotate\((-?[\d.]+)\) translate\((-?[\d.]+) (-?[\d.]+)\)$/.exec(minimapTransform(view));
  assert.ok(match, minimapTransform(view));
  const [degrees, tx, ty] = match.slice(1).map(Number) as [number, number, number];
  const angle = degrees * Math.PI / 180;
  for (const [x, z] of [[0, 0], [10, -4], [-25, 18]] as const) {
    const px = x + tx, pz = z + ty;
    const drawn = { u: px * Math.cos(angle) - pz * Math.sin(angle), v: px * Math.sin(angle) + pz * Math.cos(angle) };
    const blip = toMinimap(view, x, z);
    assert.ok(Math.abs(drawn.u - blip.u) < 1e-3 && Math.abs(drawn.v - blip.v) < 1e-3, `${x},${z}`);
  }
});

test('far blips are pulled to the frame edge in their own direction', () => {
  assert.deepEqual(clampToFrame({ u: 3, v: -4 }, 10), { u: 3, v: -4, clamped: false });
  const edge = clampToFrame({ u: 30, v: -15 }, 10);
  assert.equal(edge.clamped, true); near(edge.u, 10); near(edge.v, -5);
  near(headingOnMinimap(1, 1), 0);
  near(headingOnMinimap(0, Math.PI / 2), Math.PI / 2);
  near(headingOnMinimap(3, -3), 2 * Math.PI - 6);
  const facingEast = northOnMinimap(Math.PI / 2);
  near(facingEast.u, -1); near(facingEast.v, 0);
  near(northOnMinimap(0).v, -1);
});

test('mortar targeting maps a tap to a point the server accepts, even at the very edge', () => {
  const width = 640, height = 480;
  const centre = mapToArena(width / 2, height / 2, width, height);
  assert.deepEqual(centre, { x: 0, z: 0 });
  const spot = arenaToMap(12, -8, width, height);
  assert.deepEqual(mapToArena(spot.u, spot.v, width, height), { x: 12, z: -8 });
  for (const [u, v] of [[0, 0], [width, height], [-50, 900], [width * 2, -1]] as const) {
    const target = mapToArena(u, v, width, height);
    assert.ok(Math.abs(target.x) < ARENA_LIMITS.x && Math.abs(target.z) < ARENA_LIMITS.z, JSON.stringify(target));
  }
  assert.deepEqual(mapToArena(Number.NaN, Number.NaN, width, height), { x: 0, z: 0 });
  assert.deepEqual(mapToArena(10, 10, 0, 0), mapToArena(10, 10, 1, 1), 'a collapsed map never divides by zero');
});
