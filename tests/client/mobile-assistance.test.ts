import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AutomaticFire, reticleTarget, type ReticleCandidate } from '../../src/game/AutomaticFire.js';
import { gyroDelta } from '../../src/game/Gyroscope.js';

const target = (extra: Partial<ReticleCandidate> = {}): ReticleCandidate => ({ id: 'rival', x: -27, y: 0, z: -4, posture: 'stand', health: 100, protectedUntil: 0, ...extra });
test('Simple fire requires a stable reticle target and loses fire immediately when it leaves', () => {
  const fire = new AutomaticFire();
  assert.equal(fire.update('rival', 0), false); assert.equal(fire.update('rival', 99), false);
  assert.equal(fire.update('rival', 100), true); assert.equal(fire.update(null, 101), false);
  assert.equal(fire.update('rival', 102), false); assert.equal(fire.update('other', 202), false);
});
test('Simple fire pulses the trigger for press-to-fire weapons so each pulse can shoot', () => {
  const fire = new AutomaticFire();
  fire.update('rival', 0, true);
  const pulses = [100, 133, 166, 200, 233].map(now => fire.update('rival', now, true));
  assert.deepEqual(pulses, [true, false, true, false, true]);
  assert.equal(fire.update(null, 300, true), false);
  fire.update('rival', 400, true); assert.equal(fire.update('rival', 500, true), true, 'A new target starts on a press');
});
test('reticle assistance excludes dead, protected and team players and requires a hitbox under the crosshair', () => {
  const eye = { x: -27, y: 1.45, z: 0 }, forward = { x: 0, y: 0, z: -1 };
  assert.equal(reticleTarget(eye, forward, eye, [target()], 'self', 100, 40), 'rival');
  for (const change of [{ health: 0 }, { protectedUntil: 101 }, { x: -25 }]) {
    assert.equal(reticleTarget(eye, forward, eye, [target(change)], 'self', 100, 40), null);
  }
  // A player whose connection dropped stays where they stood and can still be hit, so Simple fire takes them.
  const offline = { ...target(), connected: false };
  assert.equal(reticleTarget(eye, forward, eye, [offline], 'self', 100, 40), 'rival', 'A living body left by a dropped connection is a target');
  assert.equal(reticleTarget(eye, forward, eye, [target()], 'rival', 100, 40), null);
  assert.equal(reticleTarget(eye, forward, eye, [target()], 'self', 100, 2), null);
  assert.equal(reticleTarget(eye, forward, eye, [target({ posture: 'crouch' })], 'self', 100, 40), null, 'A crouched rival is below a standing eye line');
  assert.equal(reticleTarget({ ...eye, y: 1 }, forward, { ...eye, y: 1 }, [target({ posture: 'crouch' })], 'self', 100, 40), 'rival');
  const team = { mode: 'tdm' as const, team: 'teal' as const };
  assert.equal(reticleTarget(eye, forward, eye, [target({ team: 'teal' })], 'self', 100, 40, team), null, 'Teammates are never auto-fire targets');
  assert.equal(reticleTarget(eye, forward, eye, [target({ id: 'mate', team: 'teal', z: -2 }), target({ team: 'gold' })], 'self', 100, 40, team), 'rival', 'Shots pass teammates');
  assert.equal(reticleTarget(eye, forward, eye, [target({ team: 'teal' })], 'self', 100, 40, { mode: 'ffa', team: 'teal' }), 'rival', 'Teams only apply in team mode');
});
test('gyro remaps both landscape orientations and rejects invalid or stale readings', () => {
  const a = gyroDelta(30, 0, 20, 90), b = gyroDelta(30, 0, 20, 270);
  assert.ok(a.yaw < 0); assert.ok(b.yaw > 0); assert.ok(Math.abs(a.pitch) < 1e-10);
  for (const [beta, gamma, interval, angle] of [[null, 10, 20, 90], [NaN, 10, 20, 90], [30, 10, 500, 90], [30, 10, 0, 90]] as const) assert.deepEqual(gyroDelta(beta, gamma, interval, angle), { yaw: 0, pitch: 0 });
  assert.ok(gyroDelta(30, 0, 20, 0).pitch > 0);
});

test('a clear reticle cannot auto-fire through a house or through cover at the muzzle', () => {
  const direction = { x: 1, y: 0, z: 0 }, rival = target({ x: -8, z: -4 });
  assert.equal(reticleTarget({ x: -12, y: 1.45, z: -4 }, direction, { x: -12, y: 1.45, z: -4 }, [rival], 'self', 100, 40), null);
  assert.equal(reticleTarget({ x: -9, y: 1.45, z: -4 }, direction, { x: -12, y: 1.45, z: -4 }, [rival], 'self', 100, 40), null);
  const eye = { x: -27, y: 1.45, z: 0 }, forward = { x: 0, y: 0, z: -1 };
  assert.equal(reticleTarget(eye, forward, eye, [target({ id: 'protected', z: -2, protectedUntil: 101 }), target()], 'self', 100, 40), null);
});
