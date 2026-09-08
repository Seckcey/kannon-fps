import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderQuality, scenePixelRatio } from '../../src/game/RenderQuality';

test('render resolution responds to sustained GPU pressure, keeps a floor, and recovers slowly', () => {
  const quality = new RenderQuality();
  quality.observe(15, .7, 'auto'); quality.observe(59, .7, 'auto');
  assert.equal(quality.scale, 1, 'a single hitch does not lower detail');
  for (let i = 0; i < 40; i++) quality.observe(25, .75, 'auto');
  assert.equal(quality.scale, .55, 'sustained slow rendering stops at the readable floor');
  for (let i = 0; i < 19; i++) quality.observe(60, .75, 'auto');
  assert.equal(quality.scale, .55, 'recovery waits fifteen seconds');
  quality.observe(60, .75, 'auto'); assert.ok(Math.abs(quality.scale - .6) < 1e-6);
  quality.reset();
  for (let i = 0; i < 40; i++) quality.observe(20, .75, 'high');
  assert.equal(quality.scale, .65, 'High retains more scene detail');
  quality.reset(); quality.observe(5, 10, 'low'); assert.equal(quality.scale, 1);
});

test('visibility resets discard partial slowdown and pixel budgets bound high-DPI screens', () => {
  const quality = new RenderQuality(); quality.observe(10, 1.5, 'auto'); quality.resetTiming(); quality.observe(10, .8, 'auto');
  assert.equal(quality.scale, 1);
  for (const [width, height, device, touch, setting, budget] of [
    [3840, 2160, 2, false, 'auto', 1600 * 900],
    [844, 390, 3, true, 'auto', 1280 * 720],
    [3840, 2160, 2, false, 'high', 2560 * 1440],
    [1920, 1080, 1, false, 'low', 1024 * 768],
  ] as const) {
    const ratio = scenePixelRatio(width, height, device, touch, setting);
    assert.ok(width * height * ratio ** 2 <= budget + 1);
    assert.ok(ratio <= device);
  }
});
