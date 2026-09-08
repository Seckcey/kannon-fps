import assert from 'node:assert/strict';
import test from 'node:test';
import { LocomotionVelocity } from '../../src/game/LocomotionVelocity';
import { movePlayer, PLAYER_RADIUS } from '../../shared/physics';
import { OBSTACLES } from '../../shared/map';
import { idleInput } from '../../server/engine';

const sample = (extra = {}) => ({ x: 0, y: 0, z: 24, vx: 0, vy: 0, vz: -6.5, yaw: 0, pitch: 0,
  health: 100, connected: true, protectedUntil: 0, ...extra });
const speed = (value: { vx: number; vz: number }) => Math.hypot(value.vx, value.vz);

test('actual collision stops the gait while authoritative requested velocity remains intact', () => {
  const wall = OBSTACLES.find(item => item.id === 'west-block')!;
  const actor = sample({ x: wall.x, z: wall.z + wall.d / 2 + PLAYER_RADIUS + 1, vz: -9 });
  const gait = new LocomotionVelocity(), input = { ...idleInput(1), moveZ: 1, sprint: true };
  const initialZ = actor.z;
  gait.update(actor, 1 / 60);
  let result = { vx: 0, vz: 0 };
  for (let i = 0; i < 90; i++) {
    movePlayer(actor, input, 1 / 60);
    result = { ...gait.update(actor, 1 / 60) };
  }
  assert.ok(initialZ - actor.z > .7, 'the actor first travels toward the wall');
  assert.ok(actor.z >= wall.z + wall.d / 2 + PLAYER_RADIUS - .01, 'the real collider stops forward travel');
  assert.equal(actor.vz, -9, 'presentation does not alter physics velocity');
  assert.ok(speed(result) < .001, 'a stationary wall push reaches idle');
});

test('sliding along a real wall animates only the resolved travel direction', () => {
  const wall = OBSTACLES.find(item => item.id === 'west-block')!;
  const actor = sample({ x: wall.x - 1, z: wall.z + wall.d / 2 + PLAYER_RADIUS + .001, vx: 9 / Math.SQRT2, vz: -9 / Math.SQRT2 });
  const gait = new LocomotionVelocity(), input = { ...idleInput(1), moveX: 1, moveZ: 1, sprint: true };
  gait.update(actor, 1 / 60);
  let result = { vx: 0, vz: 0 };
  for (let i = 0; i < 24; i++) { movePlayer(actor, input, 1 / 60); result = { ...gait.update(actor, 1 / 60) }; }
  assert.ok(result.vx > 6 && result.vx < 6.4);
  assert.ok(Math.abs(result.vz) < .01, 'blocked forward component is not used for gait direction');
  assert.ok(actor.vz < -6, 'the original requested velocity remains unchanged');
});

test('free travel follows ordinary, aimed, analog and reverse movement without inflating speed', () => {
  for (const [vx, vz] of [[0, -6.5], [0, -9], [4, 0], [0, .65], [-3, 4]]) {
    const actor = sample({ vx, vz }), gait = new LocomotionVelocity();
    gait.update(actor, 1 / 60);
    for (let i = 0; i < 60; i++) { actor.x += vx! / 60; actor.z += vz! / 60; gait.update(actor, 1 / 60); }
    const before = { ...actor }, actual = gait.update({ ...actor, x: actor.x + vx! / 60, z: actor.z + vz! / 60 }, 1 / 60);
    assert.ok(Math.abs(actual.vx - vx!) < .001 && Math.abs(actual.vz - vz!) < .001);
    assert.deepEqual(actor, before);
  }
});

test('teleports, new lives, disconnects and background gaps do not become running strides', () => {
  const actor = sample(), gait = new LocomotionVelocity();
  const prime = () => { gait.reset(); gait.update(actor, 1 / 60); for (let i = 0; i < 30; i++) { actor.z -= 6.5 / 60; gait.update(actor, 1 / 60); } };
  prime(); assert.equal(speed(gait.update({ ...actor, x: actor.x + 10 }, 1 / 60)), 0);
  prime(); assert.equal(speed(gait.update({ ...actor, protectedUntil: 5_000 }, 1 / 60)), 0);
  prime(); assert.equal(speed(gait.update({ ...actor, health: 0 }, 1 / 60)), 0);
  assert.equal(speed(gait.update(actor, 1 / 60)), 0, 'first living sample cannot inherit the death position');
  prime(); assert.equal(speed(gait.update({ ...actor, connected: false }, 1 / 60)), 0);
  prime(); assert.equal(speed(gait.update({ ...actor, z: actor.z - 2 }, 1)), 0);
  prime(); gait.reset(); assert.equal(speed(gait.update(actor, 1 / 60)), 0);
});

test('small corrections cannot exceed requested speed and a released movement input returns to idle', () => {
  const actor = sample(), gait = new LocomotionVelocity(); gait.update(actor, 1 / 60);
  for (let i = 0; i < 20; i++) { actor.z -= .2; assert.ok(speed(gait.update(actor, 1 / 60)) <= 6.5 + 1e-9); }
  assert.equal(speed(gait.update({ ...actor, vx: 0, vz: 0, z: actor.z - .05 }, 1 / 60)), 0);
});

test('aiming or an action speed limit immediately caps a previous sprint animation', () => {
  const actor = sample({ vz: -9 }), gait = new LocomotionVelocity(); gait.update(actor, 1 / 60);
  for (let i = 0; i < 30; i++) { actor.z -= 9 / 60; gait.update(actor, 1 / 60); }
  actor.vz = -6.5; actor.z -= 6.5 / 60;
  assert.ok(speed(gait.update(actor, 1 / 60)) <= 6.5 + 1e-9);
  actor.vz = -4; actor.z -= 4 / 60;
  assert.ok(speed(gait.update(actor, 1 / 60)) <= 4 + 1e-9);
});

test('invalid samples reset safely and the next finite sample starts a fresh history', () => {
  const actor = sample(), gait = new LocomotionVelocity(); gait.update(actor, 1 / 60);
  for (const [position, elapsed] of [[{ ...actor, x: NaN }, 1 / 60], [actor, 0], [actor, NaN]] as const) {
    assert.deepEqual(gait.update(position, elapsed), { vx: 0, vz: 0 });
    assert.deepEqual(gait.update(actor, 1 / 60), { vx: 0, vz: 0 });
  }
});
