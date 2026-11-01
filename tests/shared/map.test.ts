import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { groundSurfaceAt, OBSTACLES, SPAWNS, STAIR_ROUTES, surfaceAt, surfaceOf } from '../../shared/map.js';
import { supportHeight } from '../../shared/physics.js';

const find = (id: string) => { const box = OBSTACLES.find(o => o.id === id); assert.ok(box, id); return box; };

test('the eight checkpoint cover boxes sit at their contract positions', () => {
  const expected: Record<string, [number, number, number, number, number, number, 'sandbag' | 'barrier']> = {
    'west-lane-sandbags': [-7, 0.55, -13, 2.6, 1.1, 0.9, 'sandbag'],
    'east-lane-sandbags': [7, 0.55, 13, 2.6, 1.1, 0.9, 'sandbag'],
    'west-lane-barrier': [-6.6, 0.48, 9.5, 2.8, 0.96, 0.6, 'barrier'],
    'east-lane-barrier': [6.6, 0.48, -9.5, 2.8, 0.96, 0.6, 'barrier'],
    'north-centre-sandbags': [0.5, 0.55, -14.5, 2.4, 1.1, 0.9, 'sandbag'],
    'south-centre-sandbags': [0.6, 0.55, 14, 2.4, 1.1, 0.9, 'sandbag'],
    'teal-yard-sandbags': [-26.6, 0.55, 8.6, 0.9, 1.1, 2.6, 'sandbag'],
    'yellow-yard-sandbags': [26.6, 0.55, 8.6, 0.9, 1.1, 2.6, 'sandbag'],
  };
  for (const [id, [x, y, z, w, h, d, surface]] of Object.entries(expected)) {
    const box = find(id);
    assert.deepEqual([box.x, box.y, box.z, box.w, box.h, box.d, box.kind, box.surface], [x, y, z, w, h, d, 'cover', surface], id);
  }
});

test('collision data is frozen (positions, sizes, spawns and stair routes)', () => {
  // Art, bots and the server all line up with these boxes. Change this digest only on purpose.
  const data = JSON.stringify({ obstacles: OBSTACLES.map(b => [b.id, b.x, b.y, b.z, b.w, b.h, b.d, b.kind, b.surface ?? null]), spawns: SPAWNS, stairs: STAIR_ROUTES });
  assert.equal(OBSTACLES.length, 158);
  assert.equal(new Set(OBSTACLES.map(o => o.id)).size, OBSTACLES.length, 'ids are unique');
  assert.equal(createHash('sha256').update(data).digest('hex'), '49fee3c5554473683bbad94f9b44d454f66482c051910f376c002261f935ef58');
});

test('each obstacle material maps to an impact and footstep surface', () => {
  const cases: Array<[string, string]> = [
    ['west-lane-sandbags', 'sandbag'], ['west-lane-barrier', 'concrete'], ['school-bus-body', 'metal'], ['truck-cab', 'metal'],
    ['truck-cargo-floor', 'wood'], ['teal-north-wall', 'wood'], ['yellow-yard-fence', 'wood'], ['teal-room-divider-1-0', 'concrete'],
    ['teal-garage-roof', 'concrete'], ['south-planter', 'concrete'], ['teal-outside-step-3', 'concrete'], ['teal-inside-step-3', 'wood'],
  ];
  for (const [id, surface] of cases) assert.equal(surfaceOf(find(id)), surface, id);
  assert.equal(surfaceOf({ ...find('truck-cab'), surface: undefined }), 'concrete', 'unlabelled boxes are trim (concrete)');
});

test('ground zones: street asphalt, house floors, garage concrete, yards grass', () => {
  assert.equal(groundSurfaceAt(0, 0), 'asphalt');
  assert.equal(groundSurfaceAt(-9.5, 20), 'asphalt');
  assert.equal(groundSurfaceAt(-15, 0), 'wood');
  assert.equal(groundSurfaceAt(21, -5.9), 'wood');
  assert.equal(groundSurfaceAt(-14, 10), 'concrete');
  assert.equal(groundSurfaceAt(17, 13), 'concrete');
  assert.equal(groundSurfaceAt(-27, 0), 'grass');
  assert.equal(groundSurfaceAt(15, -10), 'grass');
  assert.equal(groundSurfaceAt(25, 18), 'grass');
});

test('the surface under a standing point is the highest top it stands on', () => {
  assert.equal(surfaceAt({ x: -7, y: 1.1, z: -13 }), 'sandbag');
  assert.equal(surfaceAt({ x: -2.4, y: 3, z: -4 }), 'metal');
  assert.equal(surfaceAt({ x: 2.65, y: 0.36, z: 6 }), 'wood');
  assert.equal(surfaceAt({ x: 24, y: 3.2, z: 4.4 }), 'wood');
  assert.equal(surfaceAt({ x: -19, y: 0.96, z: -2.4 }), 'wood');
  assert.equal(surfaceAt({ x: -24.35, y: 0.96, z: -2.4 }), 'concrete');
  assert.equal(surfaceAt({ x: 0, y: 0, z: 12 }), 'asphalt');
  assert.equal(surfaceAt({ x: -15, y: 0, z: 2 }), 'wood');
  assert.equal(surfaceAt({ x: -15, y: 3.2, z: 0 }), 'wood', 'upstairs floor');
});

test('standing on the edge of cover reports the cover, not the ground below', () => {
  // Centre 0.2 m past the sandbag edge: the body still stands on the sandbags.
  const edge = { x: -7, y: 1.1, z: -12.35 };
  assert.equal(supportHeight(edge), 1.1);
  assert.equal(surfaceAt(edge), 'sandbag');
  // On the bus roof edge, over the street.
  const roof = { x: -0.6, y: 3, z: -4 };
  assert.equal(supportHeight(roof), 3);
  assert.equal(surfaceAt(roof), 'metal');
  // Beside the cover on the ground is still the ground.
  assert.equal(surfaceAt({ x: -7, y: 0, z: -12.35 }), 'asphalt');
  // Far from any top at that height (in the air): the ground below.
  assert.equal(surfaceAt({ x: -7, y: 1.1, z: -11 }), 'asphalt');
});
