import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTier } from '../../src/game/RenderTiers.js';
import { presentationOptions } from '../../src/game/Presentation.js';
import { presentationOptions as tierPresentation } from '../../src/game/RenderQuality.js';

const phone = { name: 'phone', textureTier: 'phone', shadowMapSize: 1024, shadowHalfExtent: 14, postprocessing: false, bloom: false, depthOfField: false, grassDensity: 0, effects: 'phone', muzzleLight: false, decals: 48 };

test('touch devices get the phone tier unless High is forced', () => {
  assert.deepEqual(renderTier('auto', true, true), phone);
  assert.deepEqual(renderTier('low', true, true), phone);
  assert.deepEqual(renderTier('low', false, true), phone, 'Low is the phone tier on any device');
  assert.equal(renderTier('high', true, true).name, 'desktop-high');
});

test('desktop auto adds post-processing and aim depth of field only with float targets', () => {
  assert.deepEqual(renderTier('auto', false, true), { name: 'desktop', textureTier: 'full', shadowMapSize: 2048, shadowHalfExtent: 24, postprocessing: true, bloom: true, depthOfField: true, grassDensity: 1, effects: 'desktop', muzzleLight: true, decals: 128 });
  const noFloat = renderTier('auto', false, false);
  assert.deepEqual([noFloat.postprocessing, noFloat.bloom, noFloat.depthOfField], [false, false, false]);
  assert.deepEqual([noFloat.effects, noFloat.muzzleLight, noFloat.decals], ['desktop', true, 128], 'effects do not need the composer');
});

test('high is the full desktop stack', () => {
  assert.deepEqual(renderTier('high', false, true), { name: 'desktop-high', textureTier: 'full', shadowMapSize: 2048, shadowHalfExtent: 24, postprocessing: true, bloom: true, depthOfField: true, grassDensity: 2, effects: 'desktop', muzzleLight: true, decals: 192 });
  assert.equal(renderTier('high', false, false).postprocessing, false);
  assert.equal(renderTier('high', false, false).depthOfField, false);
});

test('phones never get screen effects that need the desktop composer', () => {
  for (const quality of ['auto', 'low'] as const) for (const floatTargets of [true, false]) {
    const tier = renderTier(quality, true, floatTargets);
    assert.deepEqual([tier.postprocessing, tier.bloom, tier.depthOfField, tier.muzzleLight], [false, false, false, false]);
    assert.ok(tier.decals < renderTier('auto', false, true).decals, 'phones keep fewer bullet holes');
  }
});

test('the desktop presentation follows the tier: High is the full look, Automatic is lighter', () => {
  const high = { bloom: true, depthOfField: true, chromaticAberration: true, antialias: 'smaa', contactScale: 0.6 };
  assert.deepEqual(presentationOptions(renderTier('high', false, true)), high);
  assert.deepEqual(presentationOptions(renderTier('high', true, true)), high, 'High forced on a tablet');
  assert.deepEqual(presentationOptions(renderTier('auto', false, true)), { bloom: true, depthOfField: true, chromaticAberration: false, antialias: 'fxaa', contactScale: 0.35 });
  assert.deepEqual(presentationOptions(renderTier('auto', true, true)), { bloom: false, depthOfField: false, chromaticAberration: false, antialias: 'fxaa', contactScale: 0.35 });
  assert.equal(presentationOptions, tierPresentation, 'one helper, importable without the post-processing code');
});
