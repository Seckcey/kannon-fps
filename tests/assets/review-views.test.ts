import test from 'node:test';
import assert from 'node:assert/strict';
import { POSTURE_HEIGHT, directionFromAngles, spaceFree } from '../../shared/physics.js';
import { OBSTACLES } from '../../shared/map.js';
import { TOWN_VIEWS, VEHICLE_VIEWS } from '../../src/vehicle-test/views.js';

/** The graphics review's captures and measurements start from these views; a player standing
 *  inside cover would put the first-person camera inside it and start Walk around stuck. */
test('every review view stands clear of the collision map, cameras included', () => {
  for (const [name, view] of Object.entries({ ...VEHICLE_VIEWS, ...TOWN_VIEWS })) {
    const [x, y, z] = view.player;
    assert.ok(spaceFree({ x, y, z }, POSTURE_HEIGHT.stand), `${name}: the player at ${view.player.join(', ')} overlaps a collision box`);
    if (!view.camera) continue;
    const [cx, cy, cz] = view.camera;
    const inside = OBSTACLES.filter(o => Math.abs(cx - o.x) < o.w / 2 && Math.abs(cy - o.y) < o.h / 2 && Math.abs(cz - o.z) < o.d / 2).map(o => o.id);
    assert.deepEqual(inside, [], `${name}: the camera is inside ${inside.join(', ')}`);
  }
});

test('the bus player view looks over the west-lane sandbags at the bus', () => {
  const view = VEHICLE_VIEWS['bus-gameplay']!;
  const sandbags = OBSTACLES.find(o => o.id === 'west-lane-sandbags')!, hood = OBSTACLES.find(o => o.id === 'school-bus-hood')!;
  const forward = directionFromAngles(view.yaw, 0);
  const toward = (o: { x: number; z: number }) => { const dx = o.x - view.player[0], dz = o.z - view.player[2]; return (dx * forward.x + dz * forward.z) / Math.hypot(dx, dz); };
  assert.ok(toward(sandbags) > 0.8, 'the sandbags are in front of the player');
  assert.ok(toward(hood) > 0.8, 'the bus is ahead, beyond them');
  assert.ok(Math.hypot(sandbags.x - view.player[0], sandbags.z - view.player[2]) < 2, 'standing just behind the cover');
  assert.ok(1.62 > sandbags.y + sandbags.h / 2, 'standing eyes clear the top of the sandbags');
});
