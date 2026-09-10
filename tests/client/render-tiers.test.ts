import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTier } from '../../src/game/RenderTiers.js';

test('touch devices get the phone tier unless High is forced', () => {
  assert.deepEqual(renderTier('auto', true, true), { name: 'phone', textureTier: 'phone', shadowMapSize: 1024, shadowHalfExtent: 14, postprocessing: false, bloom: false, grassDensity: 0 });
  assert.equal(renderTier('low', true, true).name, 'phone');
  assert.equal(renderTier('high', true, true).name, 'desktop-high');
});

test('desktop auto adds post-processing only with float targets', () => {
  assert.deepEqual(renderTier('auto', false, true), { name: 'desktop', textureTier: 'full', shadowMapSize: 2048, shadowHalfExtent: 24, postprocessing: true, bloom: true, grassDensity: 1 });
  assert.equal(renderTier('auto', false, false).postprocessing, false);
  assert.equal(renderTier('low', false, true).name, 'phone');
});

test('high is the full desktop stack', () => {
  assert.deepEqual(renderTier('high', false, true), { name: 'desktop-high', textureTier: 'full', shadowMapSize: 2048, shadowHalfExtent: 24, postprocessing: true, bloom: true, grassDensity: 2 });
  assert.equal(renderTier('high', false, false).postprocessing, false);
});
