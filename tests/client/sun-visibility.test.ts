import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { raycastMap } from '../../shared/physics.js';
import { applyVertexSunVisibility, buildSunVisibility, patchSunVisibilityFragment, patchVertexSunVisibilityFragment } from '../../src/game/SunVisibility.js';

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

test('golden hour: the low sun throws the teal house shadow across the street', () => {
  const grid = buildSunVisibility(raycastMap);
  // In front of the teal house the street is in its long shadow; both street ends stay sunlit.
  assert.equal(grid.sample(-6, 0, 0), 0);
  assert.equal(grid.sample(-6, -4, 0), 0);
  assert.equal(grid.sample(0, -19, 0), 1);
  assert.equal(grid.sample(0, 19, 0), 1);
  let cells = 0, shaded = 0;
  for (let x = -9; x <= 9; x++) for (let z = -6; z <= 6; z++) { cells++; if (grid.sample(x, z, 0) < 0.5) shaded++; }
  assert.ok(shaded / cells > 0.5 && shaded / cells < 0.9, `${(100 * shaded / cells).toFixed(0)}% of the central street is in shade`);
});

test('the default sun is the atmosphere sun', () => {
  // A wall to the west shades only when the sun comes from the west, as the golden-hour sun does.
  const westWall = (origin: { x: number; y: number; z: number }, direction: { x: number; y: number; z: number }, limit: number) =>
    direction.x < 0 && origin.x > -2 ? 1 : limit;
  const grid = buildSunVisibility(westWall, { half: 4, cells: 4, heights: [1.2, 4.6] });
  assert.equal(grid.sample(0, 0, 0), 0);
  assert.equal(buildSunVisibility(westWall, { half: 4, cells: 4, heights: [1.2, 4.6], sun: { x: 1, y: 1, z: 0 } }).sample(0, 0, 0), 1);
});

test('wire and grass patch reads sun visibility from the colour alpha and keeps RGB as the tint', () => {
  const patched = patchVertexSunVisibilityFragment(THREE.ShaderLib.standard.fragmentShader);
  // The colour's RGB still tints the surface, but its alpha is sun visibility, not opacity ...
  assert.ok(!patched.includes('#include <color_fragment>'));
  assert.ok(!patched.includes('diffuseColor *= vColor'));
  assert.ok(patched.includes('diffuseColor.rgb *= vColor.rgb;'));
  assert.ok(patched.includes('float kannonVertexSun = vColor.a;'));
  // ... and without vertex colours (or with RGB-only colours, which three.js gives alpha 1) the
  // sun is untouched.
  assert.ok(patched.includes('#else\n\tfloat kannonVertexSun = 1.0;'));
  assert.equal(THREE.ShaderChunk.color_vertex.includes('vColor = vec4( 1.0 );'), true, 'three.js gives RGB colours alpha 1');
  // ... it scales the real-time sun only: the directional loop, not point lights or the sky.
  const start = patched.indexOf('NUM_DIR_LIGHTS > 0');
  const directional = patched.slice(start, patched.indexOf('#pragma unroll_loop_end', start));
  assert.ok(directional.includes('directLight.color *= kannonVertexSun;'));
  assert.equal(patched.split('kannonVertexSun;').length - 1, 1);
  assert.equal(patchVertexSunVisibilityFragment(patched), patched, 'idempotent');
  const material = new THREE.MeshStandardMaterial();
  const before = material.customProgramCacheKey();
  applyVertexSunVisibility(material);
  assert.equal(material.vertexColors, true);
  assert.notEqual(material.customProgramCacheKey(), before);
  const shader = { fragmentShader: THREE.ShaderLib.standard.fragmentShader, vertexShader: THREE.ShaderLib.standard.vertexShader, uniforms: {} };
  material.onBeforeCompile(shader as never, undefined as never);
  assert.ok(shader.fragmentShader.includes('directLight.color *= kannonVertexSun;'));
});

test('character patch scales only the directional light', () => {
  const patched = patchSunVisibilityFragment(THREE.ShaderLib.standard.fragmentShader);
  assert.ok(patched.includes('uniform float uSunVisibility;'));
  assert.ok(patched.includes('getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= uSunVisibility;'));
  assert.ok(!patched.includes('#include <lights_fragment_begin>'));
  assert.equal(patchSunVisibilityFragment(patched), patched);
});
