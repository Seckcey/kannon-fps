import test from 'node:test';
import assert from 'node:assert/strict';
import { EYE_HEIGHT, eyePosition, isPlayerGrounded, raycastMap, supportHeight, weaponMuzzle } from '../../shared/physics';

test('animation and contact shadows use the actual floor, stair and platform beneath a player', () => {
  for (const player of [{ x: 0, y: 0, z: 5, vy: 0 }, { x: -24.35, y: .32, z: -4.49, vy: 0 }, { x: -13, y: 3.2, z: 0, vy: 0 }]) {
    assert.equal(supportHeight(player), player.y);
    assert.equal(isPlayerGrounded(player), true);
    const apex = { ...player, y: player.y + .8, vy: 0 };
    assert.equal(isPlayerGrounded(apex), false, 'zero vertical speed at the jump apex is not a landing');
    assert.equal(supportHeight(apex), player.y, 'the contact shadow stays on the support surface');
  }
  assert.equal(isPlayerGrounded({ x: -13, y: 3.2, z: 0, vy: 6 }), false, 'jump takeoff starts the airborne pose immediately');
});

test('the first-person eye is the shared posture eye, so the camera and the server trace from the same point', () => {
  const feet = { x: -13, y: 3.2, z: 0 };
  for (const posture of ['stand', 'crouch', 'slide', 'vault'] as const) {
    const eye = eyePosition({ ...feet, posture });
    assert.deepEqual(eye, { x: feet.x, y: feet.y + EYE_HEIGHT[posture], z: feet.z });
  }
  assert.ok(EYE_HEIGHT.stand > EYE_HEIGHT.crouch && EYE_HEIGHT.crouch > EYE_HEIGHT.slide);
});

test('the cosmetic muzzle stays on the near side of a wall the player is pressed against', () => {
  // Facing the teal house front wall (x = -10) from just outside it.
  const eye = { x: -9.5, y: 1.62, z: 0 }, yaw = -Math.PI / 2;
  const muzzle = weaponMuzzle(eye, yaw, 0);
  assert.ok(muzzle.x > -10 + 0.14, 'The barrel never reaches into the wall');
  assert.ok(raycastMap(eye, { x: -1, y: 0, z: 0 }, 2) < 0.6, 'The wall is close enough to lower the weapon');
  const open = weaponMuzzle({ x: 0, y: 1.62, z: 0 }, yaw, 0);
  assert.ok(Math.abs(Math.hypot(open.x, open.y - 1.62, open.z) - Math.hypot(0.55, 0.13, 0.1)) < 1e-9, 'In the open the barrel sits at its full reach');
});
