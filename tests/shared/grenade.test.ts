import test from 'node:test';
import assert from 'node:assert/strict';
import { EYE_HEIGHT, GRENADE, grenadeLaunch, grenadePosition, GrenadeTrajectory, stepGrenade, type GrenadeBody } from '../../shared/physics.js';
import { OBSTACLES } from '../../shared/map.js';
import type { Vec3 } from '../../shared/protocol.js';
import { FACE } from './support.js';

const STEP = GRENADE.stepMs;
const inside = (p: Vec3) => p.y < GRENADE.radius - 1e-9 || OBSTACLES.some(box =>
  Math.abs(p.x - box.x) < box.w / 2 + GRENADE.radius && Math.abs(p.y - box.y) < box.h / 2 + GRENADE.radius && Math.abs(p.z - box.z) < box.d / 2 + GRENADE.radius);
const still = (body: GrenadeBody) => body.vx === 0 && body.vy === 0 && body.vz === 0;

test('fast grenades do not tunnel through 0.28 m walls', () => {
  // Teal house north wall: x -22.14..-9.86, z -6.14..-5.86, 6.3 m tall. Thrown from the north side.
  for (const speed of [20, 25, 30]) for (const angle of [0, 0.4, 0.8, 1.2]) for (const height of [0.6, 1.6, 2.8]) for (const offset of [0, 0.05, 0.11, 0.17]) {
    const trajectory = new GrenadeTrajectory({ x: -16, y: height, z: -6.6 + offset }, { x: Math.sin(angle) * speed, y: 0, z: Math.cos(angle) * speed });
    for (let step = 1; step <= 90; step++) {
      trajectory.advanceTo(step * STEP);
      const p = trajectory.body;
      if (p.x > -22.14 - GRENADE.radius && p.x < -9.86 + GRENADE.radius && p.y < 6.3) {
        assert.ok(p.z <= -6.14 - GRENADE.radius + 1e-9, `tunnelled at ${speed} m/s, angle ${angle}, height ${height}: z ${p.z}`);
      }
    }
  }
});

test('fast grenades do not tunnel through 0.12 m balcony rails', () => {
  // Yellow balcony back rail: x 26.04..26.16, y 3.2..4.28, z 2.9..6.0. Every phase of the step against the rail.
  for (let start = 25.3; start <= 25.75; start += 0.01) for (const speed of [20, 26]) {
    const trajectory = new GrenadeTrajectory({ x: start, y: 3.9, z: 4.4 }, { x: speed, y: 0, z: 0 });
    for (let step = 1; step <= 8; step++) {
      trajectory.advanceTo(step * STEP);
      assert.ok(trajectory.body.x <= 26.04 - GRENADE.radius + 1e-9, `through the rail from ${start.toFixed(2)} at ${speed} m/s`);
    }
  }
});

test('a single step never moves a grenade more than 8 cm without checking for walls', () => {
  // One long step at 30 m/s straight at a 0.12 m rail must still stop at the rail.
  const body: GrenadeBody = { x: 25.0, y: 3.9, z: 4.4, vx: 30, vy: 0, vz: 0 };
  stepGrenade(body, 0.1);
  assert.ok(body.x <= 26.04 - GRENADE.radius + 1e-9, `x ${body.x}`);
  assert.ok(body.vx < 0, 'bounced back');
});

test('grenades come to rest within 2 s of reaching flat ground', () => {
  // Along the open street lane at x = -9, thrown south from standing eye height: flat, level and lobbed.
  for (const pitch of [-0.35, 0, 0.25]) {
    const { from, velocity } = grenadeLaunch({ x: -9, y: EYE_HEIGHT.stand, z: -21 }, FACE.south, pitch, { vx: 0, vz: 0 });
    const trajectory = new GrenadeTrajectory(from, velocity);
    let groundAt = -1, restAt = -1;
    for (let step = 1; step <= 300; step++) {
      trajectory.advanceTo(step * STEP);
      if (groundAt < 0 && trajectory.body.y <= GRENADE.radius + 1e-9) groundAt = step * STEP;
      if (restAt < 0 && still(trajectory.body)) restAt = step * STEP;
      if (restAt >= 0) assert.ok(still(trajectory.body), 'stays at rest');
    }
    assert.ok(groundAt > 0 && restAt > 0, `pitch ${pitch}: landed and stopped`);
    assert.ok(restAt - groundAt <= 2000, `pitch ${pitch}: rest ${(restAt - groundAt).toFixed(0)} ms after landing`);
    assert.ok(restAt <= 3400, `pitch ${pitch}: at rest before a full fuse (${restAt.toFixed(0)} ms)`);
    assert.ok(Math.abs(trajectory.body.y - GRENADE.radius) < 1e-9, 'resting on the ground');
    assert.ok(Math.abs(trajectory.body.x - -9) < 1e-6, 'stayed in its lane');
  }
  // Rolling along the ground at 10 m/s.
  const rolling = new GrenadeTrajectory({ x: -9, y: GRENADE.radius, z: -20 }, { x: 0, y: 0, z: 10 });
  rolling.advanceTo(2000);
  assert.ok(still(rolling.body), 'a rolling grenade stops within 2 s');
  // A grenade dropped from the hand (cooking when its thrower is eliminated) settles quickly.
  const dropped = new GrenadeTrajectory({ x: -7, y: 1.4, z: 0 }, { x: 0, y: 0, z: 0 });
  dropped.advanceTo(1000);
  assert.ok(still(dropped.body));
  // A resting grenade never drifts.
  const before = dropped.position;
  dropped.advanceTo(6000);
  assert.deepEqual(dropped.position, before);
});

test('identical throws give identical trajectories, however the time is advanced', () => {
  const launch = grenadeLaunch({ x: -6.6, y: EYE_HEIGHT.stand, z: 3 }, FACE.south, 0.1, { vx: 1.2, vz: 3.4 });
  const a = new GrenadeTrajectory(launch.from, launch.velocity), b = new GrenadeTrajectory(launch.from, launch.velocity);
  const c = new GrenadeTrajectory(launch.from, launch.velocity);
  const impactsA: number[] = [], impactsC: number[] = [];
  for (let ms = 0; ms <= 3400; ms += 50) {
    impactsA.push(...a.advanceTo(ms));
    b.advanceTo(ms);
    assert.deepEqual(a.body, b.body, `diverged at ${ms} ms`);
  }
  impactsC.push(...c.advanceTo(1234.5), ...c.advanceTo(3400));
  assert.deepEqual(c.body, a.body, 'chunked advance matches');
  assert.deepEqual(impactsC, impactsA);
  assert.deepEqual(grenadePosition(launch.from, launch.velocity, 3400), a.position);
  assert.ok(impactsA.length > 0 && impactsA.every(speed => speed > 1.2), 'hard bounces are reported');
});

test('advancing to exact multiples of the step takes exactly that many steps', () => {
  const a = new GrenadeTrajectory({ x: -7, y: 3, z: 0 }, { x: 0, y: 0, z: 0 });
  const b = new GrenadeTrajectory({ x: -7, y: 3, z: 0 }, { x: 0, y: 0, z: 0 });
  a.advanceTo(1000);
  for (let i = 0; i < 60; i++) stepGrenade(b.body);
  assert.deepEqual(a.body, b.body);
  assert.deepEqual(new GrenadeTrajectory({ x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 0 }).advanceTo(Number.NaN), []);
});

test('the throw starts in free space, even pressed against walls and under the truck roof', () => {
  const eyes: Array<{ eye: Vec3; yaws: number[] }> = [
    { eye: { x: -9.44, y: EYE_HEIGHT.stand, z: -4.5 }, yaws: [FACE.west, FACE.west + 0.6, FACE.west - 0.6, FACE.west + 1.2] },
    { eye: { x: 1.7, y: 1.16 + EYE_HEIGHT.stand, z: 3.3 }, yaws: [FACE.north, FACE.west, FACE.east, FACE.south, 0.7, -2.2] },
    { eye: { x: 2.65, y: 0.36 + EYE_HEIGHT.crouch, z: 9.8 }, yaws: [FACE.east, FACE.west, FACE.north] },
    { eye: { x: -19, y: 2.88 + EYE_HEIGHT.stand, z: 2.4 }, yaws: [FACE.east, FACE.west, FACE.south, FACE.north] },
  ];
  for (const { eye, yaws } of eyes) for (const yaw of yaws) for (let pitch = -1.4; pitch <= 1.41; pitch += 0.1) {
    const { from, velocity } = grenadeLaunch(eye, yaw, pitch, { vx: 0, vz: 0 });
    assert.ok(!inside(from), `launch inside geometry from ${JSON.stringify(eye)} yaw ${yaw} pitch ${pitch.toFixed(1)}`);
    assert.ok(Math.hypot(from.x - eye.x, from.y - eye.y, from.z - eye.z) <= 0.45 + 1e-9);
    for (const value of [velocity.x, velocity.y, velocity.z]) assert.ok(Number.isFinite(value));
  }
  const thrown = grenadeLaunch({ x: 0, y: 1.62, z: 11 }, FACE.south, 0, { vx: 2, vz: -4 });
  assert.ok(Math.abs(thrown.velocity.z - (16 - 2)) < 1e-9 && Math.abs(thrown.velocity.x - 1) < 1e-6, 'half the carrier velocity');
  assert.ok(Math.abs(thrown.velocity.y - 3) < 1e-9, 'lift');
  const safe = grenadeLaunch({ x: 0, y: 1.62, z: 11 }, FACE.south, 0, { vx: Number.NaN, vz: Number.POSITIVE_INFINITY });
  assert.ok(Number.isFinite(safe.velocity.x) && Number.isFinite(safe.velocity.z));
});

test('a grenade that starts inside geometry escapes instead of hanging in the air', () => {
  // A corrupt start just inside the barrier: it must fall and settle, not stick.
  const trajectory = new GrenadeTrajectory({ x: -6.6, y: 0.9, z: 9.5 }, { x: 0, y: 0, z: 0 });
  trajectory.advanceTo(2000);
  assert.ok(trajectory.body.y < 0.9, 'it moved');
});
