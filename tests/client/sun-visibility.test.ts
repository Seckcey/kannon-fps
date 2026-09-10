import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { raycastMap } from '../../shared/physics.js';
import { buildSunVisibility, patchSunVisibilityFragment } from '../../src/game/SunVisibility.js';

test('grid reports 1 in the open, 0 in shade and blends between them', () => {
  // A wall at x = 0 blocks every ray starting at x < 0.
  const grid = buildSunVisibility((origin, _direction, limit) => origin.x < 0 ? 1 : limit, { half: 32, cells: 64, heights: [1.2, 4.6] });
  assert.equal(grid.sample(16, 0, 0), 1);
  assert.equal(grid.sample(-16, 0, 0), 0);
  const edge = grid.sample(0, 0, 0);
  assert.ok(edge > 0 && edge < 1, `expected a blend at the boundary, got ${edge}`);
  assert.equal(grid.sample(-16, 0, 4.5), 0);
  assert.equal(grid.sample(99, 99, 0), 1, 'outside the arena clamps to the edge cell');
  assert.equal(grid.sample(-99, -99, 0), 0);
});

test('the upper layer is sampled above the floor threshold', () => {
  const grid = buildSunVisibility((origin, _direction, limit) => origin.y > 3 ? limit : 1, { half: 8, cells: 8, heights: [1.2, 4.6] });
  assert.equal(grid.sample(0, 0, 0), 0);
  assert.equal(grid.sample(0, 0, 3.2), 1);
});

test('the real map produces both sunlit and shaded cells', () => {
  const grid = buildSunVisibility(raycastMap);
  let lit = 0, shaded = 0;
  for (let x = -30; x <= 30; x += 2) for (let z = -22; z <= 22; z += 2) {
    const value = grid.sample(x, z, 0);
    assert.ok(value >= 0 && value <= 1);
    if (value > 0.99) lit++; if (value < 0.01) shaded++;
  }
  assert.ok(lit > 50 && shaded > 20, `lit ${lit}, shaded ${shaded}`);
  // Inside the west house ground floor the ceiling blocks the sun; upstairs the roof does too.
  assert.equal(grid.sample(-16, 0, 0), 0);
  assert.equal(grid.sample(-14, 0, 3.2), 0);
});

test('character patch scales only the directional light', () => {
  const patched = patchSunVisibilityFragment(THREE.ShaderLib.standard.fragmentShader);
  assert.ok(patched.includes('uniform float uSunVisibility;'));
  assert.ok(patched.includes('getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= uSunVisibility;'));
  assert.ok(!patched.includes('#include <lights_fragment_begin>'));
  assert.equal(patchSunVisibilityFragment(patched), patched);
});
