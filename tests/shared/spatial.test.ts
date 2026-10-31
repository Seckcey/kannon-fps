import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  add, directionFromAngles, eyePosition, isPlayerGrounded, movePlayer, normalize, PLAYER_RADIUS, rayBox, rayBoxSpan, raycastMap,
  raycastMapDetailed, scale, spaceFree, supportHeight, type MapHit, type MoveState,
} from '../../shared/physics.js';
import { ARENA_LIMITS, groundSurfaceAt, OBSTACLES, surfaceOf, type MapObstacle } from '../../shared/map.js';
import type { InputFrame, Vec3 } from '../../shared/protocol.js';
import { context, frame, player, withObstacle } from './support.js';

// Reference scans over every obstacle, exactly as the physics worked before the grid existed.
const lo = (box: MapObstacle): Vec3 => ({ x: box.x - box.w / 2, y: box.y - box.h / 2, z: box.z - box.d / 2 });
const hi = (box: MapObstacle): Vec3 => ({ x: box.x + box.w / 2, y: box.y + box.h / 2, z: box.z + box.d / 2 });
function scanRaycast(origin: Vec3, direction: Vec3, limit = 200): number {
  let result = limit;
  for (const box of OBSTACLES) result = Math.min(result, rayBox(origin, direction, lo(box), hi(box), limit));
  if (direction.y < -1e-6) { const floor = -origin.y / direction.y; if (floor >= 0) result = Math.min(result, floor); }
  return result;
}
function scanDetailed(origin: Vec3, direction: Vec3, limit = 200): MapHit | null {
  let best: MapHit | null = null;
  for (const box of OBSTACLES) {
    const min = lo(box), max = hi(box);
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
const overlapsXZ = (p: Vec3, box: MapObstacle, r: number) =>
  p.x + r > box.x - box.w / 2 && p.x - r < box.x + box.w / 2 && p.z + r > box.z - box.d / 2 && p.z - r < box.z + box.d / 2;
function scanFree(p: Vec3, height: number, r = PLAYER_RADIUS): boolean {
  if (Math.abs(p.x) > ARENA_LIMITS.x - r + 1e-6 || Math.abs(p.z) > ARENA_LIMITS.z - r + 1e-6) return false;
  return !OBSTACLES.some(box => overlapsXZ(p, box, r) && p.y + height > box.y - box.h / 2 + 0.02 && p.y < box.y + box.h / 2 - 0.02);
}
function scanSupport(p: Vec3): number {
  let support = 0;
  for (const box of OBSTACLES) { const top = box.y + box.h / 2; if (overlapsXZ(p, box, PLAYER_RADIUS) && top <= p.y + 0.06) support = Math.max(support, top); }
  return support;
}
/** Small deterministic generator (mulberry32). */
function random(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test('grid ray casts give exactly the same answers as scanning every obstacle', () => {
  const rand = random(20261030);
  const rays: Array<[Vec3, Vec3, number]> = [];
  for (let i = 0; i < 6000; i++) {
    const origin = { x: (rand() * 2 - 1) * 36, y: rand() * 8 - 0.5, z: (rand() * 2 - 1) * 28 };
    rays.push([origin, normalize({ x: rand() * 2 - 1, y: rand() * 1.6 - 0.8, z: rand() * 2 - 1 }), [200, 60, 8, 0.6][i % 4]!]);
  }
  // Axis-aligned, vertical and grazing rays, rays on cell borders and from inside boxes.
  for (const box of OBSTACLES) {
    const centre = { x: box.x, y: box.y, z: box.z };
    for (const d of [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 }]) {
      rays.push([centre, d, 200]);
      rays.push([{ x: box.x - d.x * 3, y: box.y, z: box.z - d.z * 3 }, d, 200]);
      rays.push([{ x: box.x + box.w / 2, y: box.y + box.h / 2, z: box.z - 4 }, d, 50]);
    }
  }
  for (let x = -32; x <= 32; x += 2) rays.push([{ x, y: 1.2, z: -25 }, { x: 0, y: 0, z: 1 }, 200], [{ x: x + 1e-9, y: 0.4, z: 25 }, { x: 0, y: 0, z: -1 }, 200]);
  for (let z = -24; z <= 24; z += 2) rays.push([{ x: -33, y: 1.2, z }, { x: 1, y: 0, z: 0 }, 200], [{ x: 0, y: 2.5, z }, normalize({ x: 1, y: -0.01, z: 1 }), 200]);
  for (const [origin, direction, limit] of rays) {
    assert.equal(raycastMap(origin, direction, limit), scanRaycast(origin, direction, limit), JSON.stringify({ origin, direction, limit }));
    assert.deepEqual(raycastMapDetailed(origin, direction, limit), scanDetailed(origin, direction, limit), JSON.stringify({ origin, direction, limit }));
  }
});

test('grid overlap queries give exactly the same answers as scanning every obstacle', () => {
  const rand = random(7);
  for (let i = 0; i < 20000; i++) {
    const p = { x: (rand() * 2 - 1) * 32, y: [0, 0.32, 0.36, 1.1, 1.16, 1.45, 2.88, 3.0, 3.2, rand() * 6][i % 10]!, z: (rand() * 2 - 1) * 24 };
    const height = [1.8, 1.25, 1.0][i % 3]!, radius = i % 5 === 0 ? 0.3 : PLAYER_RADIUS;
    assert.equal(spaceFree(p, height, radius), scanFree(p, height, radius), JSON.stringify({ p, height, radius }));
    assert.equal(supportHeight(p), scanSupport(p), JSON.stringify(p));
    const vy = [0, -1, 0.05, 2][i % 4]!;
    assert.equal(isPlayerGrounded({ ...p, vy }), vy <= 0.1 && Math.abs(p.y - scanSupport(p)) < 0.06);
  }
});

test('obstacles added at run time are seen by every query', () => {
  const origin = { x: -7, y: 1, z: 3 }, east = { x: 1, y: 0, z: 0 };
  const before = raycastMap(origin, east, 2);
  withObstacle({ id: 'test-post', x: -6, y: 1, z: 3, w: 0.2, h: 2, d: 0.2, kind: 'wall', surface: 'trim' }, () => {
    assert.ok(Math.abs(raycastMap(origin, east, 2) - 0.9) < 1e-9);
    assert.equal(raycastMapDetailed(origin, east, 2)?.obstacle?.id, 'test-post');
    assert.equal(spaceFree({ x: -6, y: 0, z: 3 }, 1.8), false);
  });
  assert.equal(raycastMap(origin, east, 2), before);
  assert.equal(spaceFree({ x: -6, y: 0, z: 3 }, 1.8), true);
});

test('8 players × 30 ticks of movement plus 8 × 12 detailed rays stay well inside budget', (t) => {
  const starts: Array<[number, number]> = [[-9, -20], [-6.6, -6], [7, 10], [-19, -5.05], [24.35, -5.05], [2.65, 11.5], [-25, 8.6], [0, 20]];
  const run = () => {
    const players: MoveState[] = starts.map(([x, z]) => player(x, z));
    let now = 0, hits = 0;
    const previous: InputFrame[] = players.map(() => frame());
    const started = performance.now();
    for (let tick = 0; tick < 30; tick++) {
      now += 1000 / 30;
      for (let i = 0; i < players.length; i++) {
        const input = frame({ moveZ: 1, moveX: Math.sin(tick * 0.3 + i) * 0.5, yaw: i * 0.8 + tick * 0.05, sprint: i % 2 === 0, dash: i % 4 === 0, jump: tick % 12 === i % 12, crouch: tick % 15 === 7 });
        movePlayer(players[i]!, input, context(now, { jumpPressed: input.jump && !previous[i]!.jump, crouchPressed: input.crouch && !previous[i]!.crouch }));
        previous[i] = input;
      }
    }
    for (const state of players) for (let k = 0; k < 12; k++) {
      if (raycastMapDetailed(eyePosition(state), directionFromAngles(state.yaw + k * 0.52, -0.2 + k * 0.03), 120)) hits++;
    }
    return { ms: performance.now() - started, hits };
  };
  run(); run(); // warm up the JIT and build the grid
  const timings = [run(), run(), run()].map(result => result.ms);
  const best = Math.min(...timings);
  t.diagnostic(`movement + rays: best ${best.toFixed(2)} ms of ${timings.map(ms => ms.toFixed(2)).join(', ')} ms`);
  assert.ok(best < 60, `took ${best.toFixed(2)} ms`);
});
