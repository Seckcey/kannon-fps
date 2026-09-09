import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AutomaticFire, reticleTarget } from '../../src/game/AutomaticFire.js';
import { gyroDelta } from '../../src/game/Gyroscope.js';
import type { PlayerState } from '../../shared/protocol.js';

const target = (extra: Partial<PlayerState> = {}): PlayerState => ({ id: 'rival', x: -27, y: 0, z: -4, health: 100, connected: true, protectedUntil: 0, ...extra } as PlayerState);
test('Simple fire requires a stable reticle target and loses fire immediately when it leaves', () => {
  const fire = new AutomaticFire();
  assert.equal(fire.update('rival', 0), false); assert.equal(fire.update('rival', 99), false);
  assert.equal(fire.update('rival', 100), true); assert.equal(fire.update(null, 101), false);
  assert.equal(fire.update('rival', 102), false); assert.equal(fire.update('other', 202), false);
});
test('reticle assistance excludes dead/disconnected/protected players and requires exact crosshair intersection', () => {
  const eye = { x: -27, y: 1.45, z: 0 }, forward = { x: 0, y: 0, z: -1 };
  assert.equal(reticleTarget(eye, forward, eye, [target()], 'self', 100, 40), 'rival');
  for (const change of [{ health: 0 }, { connected: false }, { protectedUntil: 101 }, { x: -25 }]) {
    assert.equal(reticleTarget(eye, forward, eye, [target(change)], 'self', 100, 40), null);
  }
  assert.equal(reticleTarget(eye, forward, eye, [target()], 'rival', 100, 40), null);
  assert.equal(reticleTarget(eye, forward, eye, [target()], 'self', 100, 2), null);
});
test('gyro remaps both landscape orientations and rejects invalid or stale readings', () => {
  const a = gyroDelta(30, 0, 20, 90), b = gyroDelta(30, 0, 20, 270);
  assert.ok(a.yaw < 0); assert.ok(b.yaw > 0); assert.ok(Math.abs(a.pitch) < 1e-10);
  for (const [beta, gamma, interval, angle] of [[null, 10, 20, 90], [NaN, 10, 20, 90], [30, 10, 500, 90], [30, 10, 0, 90]] as const) assert.deepEqual(gyroDelta(beta, gamma, interval, angle), { yaw: 0, pitch: 0 });
  assert.ok(gyroDelta(30, 0, 20, 0).pitch > 0);
});

test('a clear camera reticle cannot auto-fire through a house or through cover at the muzzle', () => {
  const direction = { x: 1, y: 0, z: 0 }, rival = target({ x: -8, z: -4 });
  assert.equal(reticleTarget({ x: -12, y: 1.45, z: -4 }, direction, { x: -12, y: 1.45, z: -4 }, [rival], 'self', 100, 40), null);
  assert.equal(reticleTarget({ x: -9, y: 1.45, z: -4 }, direction, { x: -12, y: 1.45, z: -4 }, [rival], 'self', 100, 40), null);
  const eye = { x: -27, y: 1.45, z: 0 }, forward = { x: 0, y: 0, z: -1 };
  assert.equal(reticleTarget(eye, forward, eye, [target({ id: 'protected', z: -2, protectedUntil: 101 }), target()], 'self', 100, 40), null);
});
