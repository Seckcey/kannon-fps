import test from 'node:test';
import assert from 'node:assert/strict';
import { VIEWPORT_SETTLE_MS, lockedViewportContent, readVisibleArea, watchVisibleArea, type ViewportSource } from '../../src/components/hud/hooks.js';

type Fake = { innerWidth: number; innerHeight: number; visualViewport: (EventTarget & { width: number; height: number; offsetLeft: number; offsetTop: number }) | null };
function source(innerWidth: number, innerHeight: number, zoom = 1): EventTarget & Fake {
  const visualViewport = Object.assign(new EventTarget(), { width: innerWidth / zoom, height: innerHeight / zoom, offsetLeft: 0, offsetTop: 0 });
  return Object.assign(new EventTarget(), { innerWidth, innerHeight, visualViewport });
}

test('the visible area is what the player can see, not the size of the whole page', () => {
  assert.deepEqual(readVisibleArea(source(844, 390) as ViewportSource), { left: 0, top: 0, width: 844, height: 390 });
  // A page zoomed in after a turn: the phone shows only part of the page, so the game has to fit in that part.
  const zoomed = source(844, 390, 2.16);
  zoomed.visualViewport!.offsetLeft = 12.4; zoomed.visualViewport!.offsetTop = 30.6;
  assert.deepEqual(readVisibleArea(zoomed as ViewportSource), { left: 12, top: 31, width: 391, height: 181 });
});

test('a browser without a usable visual viewport falls back to the window size', () => {
  const none = Object.assign(source(667, 375), { visualViewport: null });
  assert.deepEqual(readVisibleArea(none as ViewportSource), { left: 0, top: 0, width: 667, height: 375 });
  const empty = source(667, 375);
  empty.visualViewport!.width = 0; empty.visualViewport!.height = 0;
  assert.deepEqual(readVisibleArea(empty as ViewportSource), { left: 0, top: 0, width: 667, height: 375 });
});

test('a turn is read again until the phone settles, because its sizes can lag behind the event', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const view = source(390, 844), seen: number[] = [];
  const stop = watchVisibleArea(view as ViewportSource, area => seen.push(area.width));
  view.dispatchEvent(new Event('orientationchange'));
  assert.deepEqual(seen, [390], 'the sizes have not changed yet');
  view.innerWidth = 844; view.innerHeight = 390; view.visualViewport!.width = 844; view.visualViewport!.height = 390;
  t.mock.timers.tick(VIEWPORT_SETTLE_MS.at(-1)!);
  assert.equal(seen.at(-1), 844, 'the late sizes are picked up with no further event');
  assert.equal(seen.length, 1 + VIEWPORT_SETTLE_MS.length);
  stop();
});

test('moving or resizing the visible part of the page is read straight away, and stopping cancels the rereads', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const view = source(844, 390); let reads = 0;
  const stop = watchVisibleArea(view as ViewportSource, () => { reads++; });
  view.visualViewport!.dispatchEvent(new Event('scroll'));
  assert.equal(reads, 1);
  view.visualViewport!.dispatchEvent(new Event('resize'));
  assert.equal(reads, 2);
  view.dispatchEvent(new Event('resize'));
  assert.equal(reads, 3);
  stop();
  t.mock.timers.tick(VIEWPORT_SETTLE_MS.at(-1)!);
  view.dispatchEvent(new Event('resize'));
  assert.equal(reads, 3);
});

test('during a match the page cannot be zoomed, and the original setting can be restored', () => {
  const original = 'width=device-width, initial-scale=1, viewport-fit=cover';
  const locked = lockedViewportContent(original);
  assert.equal(locked, `${original}, minimum-scale=1, maximum-scale=1`);
  assert.equal(lockedViewportContent(locked), locked, 'locking twice changes nothing');
});
