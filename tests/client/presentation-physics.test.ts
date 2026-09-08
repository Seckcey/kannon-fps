import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraPosition, isPlayerGrounded, supportHeight } from '../../shared/physics';

test('animation and contact shadows use the actual floor, stair and platform beneath a player', () => {
  for (const player of [{ x: 0, y: 0, z: 5, vy: 0 }, { x: 0, y: .4, z: 9.5, vy: 0 }, { x: 0, y: 2, z: 17, vy: 0 }]) {
    assert.equal(supportHeight(player), player.y);
    assert.equal(isPlayerGrounded(player), true);
    const apex = { ...player, y: player.y + .8, vy: 0 };
    assert.equal(isPlayerGrounded(apex), false, 'zero vertical speed at the jump apex is not a landing');
    assert.equal(supportHeight(apex), player.y, 'the contact shadow stays on the support surface');
  }
  assert.equal(isPlayerGrounded({ x: 0, y: 2, z: 17, vy: 6 }), false, 'jump takeoff starts the airborne pose immediately');
});

test('the shared shoulder camera keeps the same minimum ground height for rendering and accepted aim', () => {
  const player = { x: -28, y: 0, z: 0 };
  for (const [aim, pitch] of [[false, 0.6435011088], [true, 0.9914890996]] as const) {
    assert.equal(cameraPosition(player, 0, pitch, aim).y, .12);
    assert.ok(cameraPosition(player, 0, pitch - .1, aim).y > .12);
  }
  const clipped = cameraPosition({ x: -13.5, y: 0, z: 0 }, Math.PI / 2, 0, false);
  assert.ok(clipped.x > -15 && clipped.y >= .12, 'the same canonical camera still stops in front of a solid wall');
});
