import test from 'node:test';
import assert from 'node:assert/strict';
import { enterFullscreen, exitFullscreen, fullscreenMode, type FullscreenDocument } from '../../src/lib/fullscreen.js';

const iPhone = { installed: false, iPhone: true }, android = { installed: false, iPhone: false };
const page = (document: Partial<FullscreenDocument> = {}, root: FullscreenDocument['documentElement'] = {}): FullscreenDocument => ({ ...document, documentElement: root });
const standard = () => page({ fullscreenEnabled: true }, { requestFullscreen: async () => {} });

test('a phone that lets a website go full screen uses that', () => {
  assert.equal(fullscreenMode(standard(), android), 'available');
  assert.equal(fullscreenMode(page({ webkitFullscreenEnabled: true }, { webkitRequestFullscreen: () => {} }), android), 'available', 'older iPads');
  assert.equal(fullscreenMode(standard(), iPhone), 'available', 'if a future iPhone allows it, it is used instead of the steps');
});

test('iPhone Safari cannot, so the player gets the steps; other browsers that cannot show nothing', () => {
  assert.equal(fullscreenMode(page(), iPhone), 'manual');
  assert.equal(fullscreenMode(page({ webkitFullscreenEnabled: false }), iPhone), 'manual');
  assert.equal(fullscreenMode(page(), android), 'none');
  assert.equal(fullscreenMode(page({ fullscreenEnabled: false }, { requestFullscreen: async () => {} }), android), 'none', 'turned off for this page');
});

test('nothing to offer when the game already fills the screen', () => {
  assert.equal(fullscreenMode(page(), { installed: true, iPhone: true }), 'active', 'opened from the Home Screen');
  assert.equal(fullscreenMode(page({ fullscreenEnabled: true, fullscreenElement: {} as Element }, { requestFullscreen: async () => {} }), android), 'active');
  assert.equal(fullscreenMode(page({ webkitFullscreenElement: {} as Element }), android), 'active');
});

test('asking for full screen hides the browser bars and always finishes', async () => {
  const options: unknown[] = [];
  await enterFullscreen(page({ fullscreenEnabled: true }, { requestFullscreen: async value => { options.push(value); } }));
  assert.deepEqual(options, [{ navigationUI: 'hide' }]);
  let older = 0;
  const started = Date.now();
  await enterFullscreen(page({ webkitFullscreenEnabled: true }, { webkitRequestFullscreen: () => { older++; } }));
  assert.equal(older, 1);
  assert.ok(Date.now() - started >= 250, 'the older call answers nothing, so the switch gets a moment');
  // Nothing here may stop Ready to play: a refusal, an error or no support at all just carries on.
  await enterFullscreen(page({ fullscreenEnabled: true }, { requestFullscreen: () => Promise.reject(new Error('denied')) }));
  await enterFullscreen(page({ fullscreenEnabled: true }, { requestFullscreen: () => { throw new Error('broken'); } }));
  await enterFullscreen(page());
});

test('a browser that never answers cannot hold up Ready to play', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finished = false;
  void enterFullscreen(page({ fullscreenEnabled: true }, { requestFullscreen: () => new Promise(() => {}) })).then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  t.mock.timers.tick(1500);
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  assert.equal(finished, true);
});

test('leaving full screen only happens when the page is in it', () => {
  let exits = 0;
  exitFullscreen(page({ exitFullscreen: async () => { exits++; } }));
  assert.equal(exits, 0);
  exitFullscreen(page({ fullscreenElement: {} as Element, exitFullscreen: async () => { exits++; } }));
  assert.equal(exits, 1);
  exitFullscreen(page({ webkitFullscreenElement: {} as Element, webkitExitFullscreen: () => { exits++; } }));
  assert.equal(exits, 2);
  exitFullscreen(page({ fullscreenElement: {} as Element, exitFullscreen: () => Promise.reject(new Error('already out')) }));
});
