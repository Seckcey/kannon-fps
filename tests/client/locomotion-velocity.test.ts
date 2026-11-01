import assert from 'node:assert/strict';
import test from 'node:test';
import { LocomotionVelocity, MAX_TRAVEL_SPEED } from '../../src/game/LocomotionVelocity';
import { moveDefaults, movePlayer as moveWithContext, PLAYER_RADIUS, type MoveState } from '../../shared/physics';
import { OBSTACLES } from '../../shared/map';
import type { InputFrame } from '../../shared/protocol';

const idleInput = (seq = 0): InputFrame => ({ seq, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, fire: false, aim: false, jump: false, sprint: false,
  reload: false, slot: 1, crouch: false, dash: false, melee: false, grenade: false, streak: null, viewTime: 0 });
let clock = 0;
/** One shared-physics step with an ordinary context (no edges, unarmed speed factors). */
const movePlayer = (state: MoveState, input: InputFrame, dt: number) => moveWithContext(state, input,
  { now: clock += dt * 1000, dt, jumpPressed: false, crouchPressed: false, moveFactor: 1, adsFactor: 1, canSprint: true });
const sample = (extra = {}) => ({ x: 0, y: 0, z: 24, vx: 0, vy: 0, vz: -6.5, yaw: 0, pitch: 0,
  health: 100, connected: true, protectedUntil: 0, ...moveDefaults(), ...extra });
const speed = (value: { vx: number; vz: number }) => Math.hypot(value.vx, value.vz);

test('actual collision stops the gait without changing the physics state', () => {
  const wall = OBSTACLES.find(item => item.id === 'teal-garage-south')!;
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
  const before = { ...actor };
  gait.update(actor, 1 / 60);
  assert.deepEqual(actor, before, 'presentation does not alter physics state');
  assert.ok(speed(result) < .001, 'a stationary wall push reaches idle');
});

test('sliding along a real wall animates only the resolved travel direction', () => {
  const wall = OBSTACLES.find(item => item.id === 'teal-garage-south')!;
  const actor = sample({ x: wall.x - 1, z: wall.z + wall.d / 2 + PLAYER_RADIUS + .001, vx: 9 / Math.SQRT2, vz: -9 / Math.SQRT2 });
  const gait = new LocomotionVelocity(), input = { ...idleInput(1), moveX: 1, moveZ: 1, sprint: true };
  gait.update(actor, 1 / 60);
  let result = { vx: 0, vz: 0 };
  for (let i = 0; i < 24; i++) { movePlayer(actor, input, 1 / 60); result = { ...gait.update(actor, 1 / 60) }; }
  // Sprinting diagonally: 6.9 m/s along the wish, of which only the wall-parallel part remains.
  assert.ok(result.vx > 4.6 && result.vx < 5, `gait vx ${result.vx}`);
  assert.ok(Math.abs(result.vz) < .01, 'blocked forward component is not used for gait direction');
  assert.ok(actor.z >= wall.z + wall.d / 2 + PLAYER_RADIUS - .01, 'the wall holds');
});

test('free travel follows ordinary, aimed, analog and reverse movement without inflating speed', () => {
  for (const [vx, vz] of [[0, -6.5], [0, -6.9], [0, -8.2], [4, 0], [0, .65], [-3, 4]]) {
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

test('aiming or an action speed limit immediately caps a previous dash animation', () => {
  const actor = sample({ vz: -8.2 }), gait = new LocomotionVelocity(); gait.update(actor, 1 / 60);
  for (let i = 0; i < 30; i++) { actor.z -= 8.2 / 60; gait.update(actor, 1 / 60); }
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

test('nothing animates faster than a slide entry, the fastest legitimate travel', () => {
  assert.equal(MAX_TRAVEL_SPEED, 8.8);
  const actor = sample({ vz: -20 }), gait = new LocomotionVelocity(); gait.update(actor, 1 / 60);
  let result = { vx: 0, vz: 0 };
  for (let i = 0; i < 30; i++) { actor.z -= 20 / 60; result = { ...gait.update(actor, 1 / 60) }; }
  assert.ok(speed(result) <= MAX_TRAVEL_SPEED + 1e-9);
  const remote = new LocomotionVelocity(); remote.update(actor, 1 / 60, 'remote');
  for (let i = 0; i < 30; i++) { actor.z -= 20 / 60; result = { ...remote.update(actor, 1 / 60, 'remote') }; }
  assert.ok(speed(result) <= MAX_TRAVEL_SPEED + 1e-9, 'Remote corrections share the cap');
});
