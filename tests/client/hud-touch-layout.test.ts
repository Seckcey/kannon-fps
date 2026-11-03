import test from 'node:test';
import assert from 'node:assert/strict';
import type { GameEvent } from '../../shared/protocol.js';
import { WEAPONS } from '../../shared/weapons.js';
import { crosshairReach } from '../../src/components/hud/combat.js';
import { TOUCH_CALLOUT, killFeed, nameLookup } from '../../src/components/hud/match.js';
import { FEED_GAP, FEED_ROW, MIN_TARGET, feedStyle, hudEdges, minimapSpec, overlaps, touchHudLayout, touchLayout, type Insets, type Rect, type TouchLayout } from '../../src/components/hud/touchLayout.js';

const VIEWPORTS: Array<{ name: string; width: number; height: number; safe: Partial<Insets> }> = [
  { name: 'iPhone landscape 844x390', width: 844, height: 390, safe: { left: 47, right: 47, bottom: 21 } },
  { name: 'small phone landscape 667x375', width: 667, height: 375, safe: {} },
  { name: 'large phone landscape 932x430', width: 932, height: 430, safe: { left: 59, right: 59, bottom: 21 } },
  { name: 'Android landscape 800x360', width: 800, height: 360, safe: { left: 24 } },
  { name: 'tablet landscape 1180x820', width: 1180, height: 820, safe: { bottom: 20 } },
  { name: 'phone portrait 390x844', width: 390, height: 844, safe: { top: 47, bottom: 34 } },
  { name: 'touch laptop 1920x1080', width: 1920, height: 1080, safe: {} },
];
const REQUIRED = ['fire', 'fireLeft', 'aim', 'crouch', 'jump', 'reload', 'grenade', 'knife', 'swap'] as const;

function controls(layout: TouchLayout): Array<[string, Rect]> {
  return [['stick', layout.stick], ...Object.entries(layout.buttons) as Array<[string, Rect]>, ...layout.rewards.map((rect, index): [string, Rect] => [`reward${index}`, rect])];
}

test('every first-person touch control fits, is big enough and stays clear of the others', () => {
  for (const viewport of VIEWPORTS) for (const sprintButton of [false, true]) for (const rewards of [0, 1, 3]) {
    const layout = touchLayout({ ...viewport, sprintButton, rewards });
    const label = `${viewport.name} sprint=${sprintButton} rewards=${rewards}`;
    for (const id of REQUIRED) assert.ok(layout.buttons[id], `${label}: ${id}`);
    assert.equal(!!layout.buttons.sprint, sprintButton, `${label}: sprint button only when sprint is not automatic`);
    assert.equal(layout.rewards.length, rewards);
    const safe = { top: viewport.safe.top ?? 0, right: viewport.safe.right ?? 0, bottom: viewport.safe.bottom ?? 0, left: viewport.safe.left ?? 0 };
    const placed = controls(layout);
    for (const [id, rect] of placed) {
      assert.ok(rect.w >= MIN_TARGET && rect.h >= MIN_TARGET, `${label}: ${id} is ${rect.w}x${rect.h}`);
      assert.ok(rect.x >= safe.left && rect.y >= safe.top && rect.x + rect.w <= viewport.width - safe.right && rect.y + rect.h <= viewport.height - safe.bottom,
        `${label}: ${id} ${JSON.stringify(rect)} leaves the safe area`);
    }
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
      assert.equal(overlaps(placed[i]![1], placed[j]![1], 4), false, `${label}: ${placed[i]![0]} touches ${placed[j]![0]}`);
    }
    const { status } = layout;
    assert.ok(status.x >= safe.left && status.y >= safe.top && status.x + status.w <= viewport.width - safe.right && status.y + status.h <= viewport.height - safe.bottom, `${label}: status inside`);
    for (const [id, rect] of placed) assert.equal(overlaps(status, rect), false, `${label}: status covers ${id}`);
    assert.equal(overlaps(layout.look, layout.stick), false, `${label}: looking never starts on the stick`);
    const fire = layout.buttons.fire!, small = layout.buttons.reload!;
    assert.ok(fire.w > small.w, `${label}: Fire is the biggest button`);
  }
});

test('on a landscape phone the status panel sits between the thumbs and Jump owns the corner', () => {
  const layout = touchLayout({ width: 844, height: 390, safe: { left: 47, right: 47, bottom: 21 } });
  assert.equal(layout.scale, 1);
  const { status, buttons, stick } = layout;
  assert.ok(status.x > stick.x + stick.w && status.x + status.w < buttons.reload!.x, 'between the stick and the right-hand buttons');
  assert.ok(status.y + status.h >= 390 - 21 - 20, 'along the bottom');
  const jump = buttons.jump!;
  for (const [id, rect] of Object.entries(buttons)) if (id !== 'jump') assert.ok(rect.x + rect.w <= jump.x + jump.w && rect.y + rect.h <= jump.y + jump.h, `${id} is above or left of Jump`);
  assert.ok(buttons.fireLeft!.y + buttons.fireLeft!.h <= stick.y, 'Fire left is above the stick');
  // The look area covers the right side of the screen, under the buttons.
  assert.ok(layout.look.x < buttons.reload!.x && layout.look.x + layout.look.w === 844 && layout.look.y + layout.look.h === 390);
});

test('in portrait the status panel moves above the controls', () => {
  const layout = touchLayout({ width: 390, height: 844, safe: { top: 47, bottom: 34 }, rewards: 2 });
  const top = Math.min(...controls(layout).map(([, rect]) => rect.y));
  assert.ok(layout.status.y + layout.status.h <= top);
});

const FOVS = [70, 80, 90, 110];
const inside = (rect: Rect, width: number, height: number, edges: Insets) =>
  rect.x >= edges.left && rect.y >= edges.top && rect.x + rect.w <= width - edges.right && rect.y + rect.h <= height - edges.bottom;

test('on touch screens the kill feed, messages and standings never cover the crosshair or a button', () => {
  for (const viewport of VIEWPORTS) for (const sprintButton of [false, true]) for (const rewards of [0, 1, 3]) for (const fov of FOVS) for (const spec of Object.values(WEAPONS)) {
    const label = `${viewport.name} sprint=${sprintButton} rewards=${rewards} fov=${fov} ${spec.id}`;
    const layout = touchLayout({ ...viewport, sprintButton, rewards });
    const reach = crosshairReach(spec, fov, viewport.width, viewport.height);
    const hud = touchHudLayout({ ...viewport, controls: layout, minimapSize: minimapSpec(viewport.width, viewport.height, true).size, reach });
    const { feed, callouts, standings, minimap, scoreBar, topActions, edges, hint } = hud;
    assert.deepEqual(edges, hudEdges(viewport.safe, true));
    // The crosshair, hit markers and cook ring live in a square of `reach` around the centre.
    const crosshair: Rect = { x: viewport.width / 2 - reach, y: viewport.height / 2 - reach, w: 2 * reach, h: 2 * reach };
    assert.ok(callouts.y + callouts.h <= viewport.height / 2 - reach, `${label}: messages end above the crosshair`);
    const portrait = viewport.height > viewport.width;
    assert.equal(!!hint, portrait, `${label}: the turn-sideways hint is placed only in portrait`);
    if (hint) assert.ok(hint.w >= 140, `${label}: hint wide enough (${hint.w})`);
    const text: Array<[string, Rect]> = [['feed', feed], ['messages', callouts], ...(hint ? [['hint', hint] as [string, Rect]] : [])];
    for (const [name, rect] of text) {
      assert.ok(inside(rect, viewport.width, viewport.height, edges), `${label}: ${name} ${JSON.stringify(rect)} stays on screen`);
      assert.equal(overlaps(rect, crosshair), false, `${label}: ${name} covers the crosshair`);
      for (const [id, control] of controls(layout)) assert.equal(overlaps(rect, control), false, `${label}: ${name} covers ${id}`);
      assert.equal(overlaps(rect, layout.status), false, `${label}: ${name} covers the health and ammo panel`);
      for (const [other, fixed] of [['minimap', minimap], ['score bar', scoreBar], ['top buttons', topActions]] as const) {
        assert.equal(overlaps(rect, fixed), false, `${label}: ${name} covers the ${other}`);
      }
    }
    for (let i = 0; i < text.length; i++) for (let j = i + 1; j < text.length; j++) {
      assert.equal(overlaps(text[i]![1], text[j]![1]), false, `${label}: ${text[i]![0]} and ${text[j]![0]} overlap`);
    }
    assert.equal(feed.h, feed.rows > 0 ? feed.rows * FEED_ROW + (feed.rows - 1) * FEED_GAP : 0);
    // The standings panel replaces the feed and messages while open, but never covers a control.
    assert.ok(inside(standings, viewport.width, viewport.height, edges), `${label}: standings on screen`);
    for (const [id, control] of controls(layout)) assert.equal(overlaps(standings, control), false, `${label}: standings cover ${id}`);
    assert.equal(overlaps(standings, layout.status), false, `${label}: standings cover the status panel`);
    assert.equal(overlaps(standings, topActions), false, `${label}: standings cover the pause button`);
    assert.ok(standings.w >= 240 && standings.h >= 150, `${label}: standings are big enough to read (${standings.w}x${standings.h})`);
    // Something always fits: at least one message line, and on phones at least two feed rows.
    assert.ok(callouts.h >= TOUCH_CALLOUT.notice, `${label}: room for a message (${callouts.h})`);
    assert.ok(feed.rows >= 2, `${label}: ${feed.rows} feed rows`);
    assert.ok(feed.w >= 170, `${label}: feed wide enough for two names (${feed.w})`);
  }
});

test('with the usual weapons a phone shows a warning, a medal and a score pop-up together', () => {
  for (const viewport of VIEWPORTS.filter(item => item.height < 500)) {
    const layout = touchLayout({ ...viewport, rewards: 3 });
    const hud = touchHudLayout({ ...viewport, controls: layout, minimapSize: 96, reach: crosshairReach(WEAPONS.kr5, 80, viewport.width, viewport.height) });
    const needed = TOUCH_CALLOUT.notice + TOUCH_CALLOUT.medal + TOUCH_CALLOUT.popup + 2 * TOUCH_CALLOUT.gap;
    assert.ok(hud.callouts.h >= needed, `${viewport.name}: ${hud.callouts.h}px for messages`);
  }
  // The reviewer's case: 800x360 had the "reward ready" panel over the crosshair's top line.
  const phone = { width: 800, height: 360, safe: { left: 24 } };
  const hud = touchHudLayout({ ...phone, controls: touchLayout({ ...phone, sprintButton: true, rewards: 1 }), minimapSize: 96, reach: crosshairReach(WEAPONS.kr5, 80, 800, 360) });
  assert.ok(hud.callouts.y + hud.callouts.h <= 180 - 30, 'messages stop above the crosshair and its markers');
  assert.ok(hud.feed.y + hud.feed.h <= touchLayout({ ...phone, sprintButton: true, rewards: 1 }).buttons.fireLeft!.y, 'the feed stops above the left Fire button');
});

// Phones in landscape under a slim browser toolbar of about 50 px. See BARS_VIEWPORTS for all of Safari's bars.
const SHORT_VIEWPORTS: Array<{ name: string; width: number; height: number; safe: Partial<Insets> }> = [
  { name: 'iPhone 12-15 Safari 844x340', width: 844, height: 340, safe: { left: 47, right: 47, bottom: 21 } },
  { name: 'iPhone 14 Pro Safari 852x343', width: 852, height: 343, safe: { left: 59, right: 59, bottom: 21 } },
  { name: 'iPhone 13 mini Safari 812x325', width: 812, height: 325, safe: { left: 50, right: 50, bottom: 21 } },
  { name: 'iPhone SE Safari 667x325', width: 667, height: 325, safe: {} },
  { name: 'Android with toolbar 800x320', width: 800, height: 320, safe: {} },
];

test('the kill feed shows only the rows that fit, none at all on a short phone screen', () => {
  const lookup = nameLookup([{ id: 'me', name: 'Me' }, { id: 'ana', name: 'Ana' }]);
  const feed: GameEvent[] = Array.from({ length: 8 }, (_, index) => ({ type: 'elimination', playerId: index % 2 ? 'me' : 'ana', attackerId: index % 2 ? 'ana' : 'me',
    cause: 'bullet', weapon: 'kr5', headshot: false, distance: 10, assists: [], at: 9000 + index * 100 }));
  const place = (viewport: typeof SHORT_VIEWPORTS[number], sprintButton: boolean) => touchHudLayout({ ...viewport, controls: touchLayout({ ...viewport, sprintButton }),
    minimapSize: minimapSpec(viewport.width, viewport.height, true).size, reach: crosshairReach(WEAPONS.kr5, 80, viewport.width, viewport.height) });
  for (const viewport of [...SHORT_VIEWPORTS, ...VIEWPORTS]) for (const sprintButton of [false, true]) {
    const label = `${viewport.name} sprint=${sprintButton}`, { feed: box } = place(viewport, sprintButton);
    const entries = killFeed(feed, lookup, { id: 'me' }, 'ffa', 10_000, 6000, box.rows);
    assert.equal(entries.length, Math.min(feed.length, box.rows), `${label}: one entry per row that fits`);
    // The box itself is capped too, so nothing can ever spill over the left thumb's buttons.
    const style = feedStyle(box);
    assert.equal(style.maxHeight, box.h, label); assert.equal(style.overflow, 'hidden', label);
    assert.deepEqual([style.left, style.top, style.maxWidth], [box.x, box.y, box.w], label);
  }
  // Most iPhones in a Safari tab have no room for a single row above the left Fire button.
  for (const viewport of SHORT_VIEWPORTS) {
    const { feed: box } = place(viewport, false);
    assert.deepEqual([box.rows, box.h], [0, 0], viewport.name);
  }
});

test('minimap size follows the screen', () => {
  assert.deepEqual(minimapSpec(844, 390, true), { size: 96, range: 20 });
  assert.deepEqual(minimapSpec(1180, 820, true), { size: 128, range: 20 });
  assert.deepEqual(minimapSpec(1920, 1080, false), { size: 216, range: 30 });
  assert.equal(minimapSpec(1280, 600, false).size, 150);
  assert.equal(minimapSpec(3840, 2160, false).size, 240);
  assert.deepEqual(hudEdges({ left: 47, bottom: 21 }, true), { top: 8, right: 12, bottom: 21, left: 47 });
  assert.deepEqual(hudEdges({}, false), { top: 16, right: 18, bottom: 18, left: 18 });
});

// Phones in landscape with all of Safari's bars showing. On iOS 26 the address bar and the tab bar take
// about 135 px: a photo from an iPhone showed 258 px left for the game.
const BARS_VIEWPORTS: Array<{ name: string; width: number; height: number; safe: Partial<Insets> }> = [
  { name: 'iPhone 15 with Safari bars 852x258', width: 852, height: 258, safe: { left: 59, right: 59, bottom: 21 } },
  { name: 'iPhone 12-14 with Safari bars 844x255', width: 844, height: 255, safe: { left: 47, right: 47, bottom: 21 } },
  { name: 'iPhone 16 Pro with Safari bars 874x267', width: 874, height: 267, safe: { left: 62, right: 62, bottom: 21 } },
  { name: 'iPhone Pro Max with Safari bars 932x295', width: 932, height: 295, safe: { left: 59, right: 59, bottom: 21 } },
  { name: 'iPhone mini with Safari bars 812x240', width: 812, height: 240, safe: { left: 50, right: 50, bottom: 21 } },
  { name: 'iPhone SE with Safari bars 667x240', width: 667, height: 240, safe: {} },
  { name: 'the shortest screen we test 667x227', width: 667, height: 227, safe: {} },
  { name: 'iPhone 15 with the address bar only 852x315', width: 852, height: 315, safe: { left: 59, right: 59, bottom: 21 } },
  { name: 'Android with a toolbar 800x290', width: 800, height: 290, safe: { left: 24 } },
  { name: 'small Android with a toolbar and side buttons 592x280', width: 592, height: 280, safe: {} },
];
const barsHud = (viewport: typeof BARS_VIEWPORTS[number], sprintButton: boolean, rewards: number, reach: number) => {
  const layout = touchLayout({ ...viewport, sprintButton, rewards });
  return { layout, hud: touchHudLayout({ ...viewport, controls: layout, minimapSize: minimapSpec(viewport.width, viewport.height, true).size, reach }) };
};

test('with all of the Safari bars showing, every touch control fits, clear of the others and of the top of the screen', () => {
  for (const viewport of BARS_VIEWPORTS) for (const sprintButton of [false, true]) for (const rewards of [0, 1, 2, 3]) {
    const label = `${viewport.name} sprint=${sprintButton} rewards=${rewards}`;
    const { layout, hud } = barsHud(viewport, sprintButton, rewards, 40);
    assert.equal(layout.compact, true, `${label}: uses the short-screen layout`);
    for (const id of REQUIRED) assert.ok(layout.buttons[id], `${label}: ${id}`);
    assert.equal(layout.rewards.length, rewards);
    const safe = { top: viewport.safe.top ?? 0, right: viewport.safe.right ?? 0, bottom: viewport.safe.bottom ?? 0, left: viewport.safe.left ?? 0 };
    const placed = controls(layout);
    for (const [id, rect] of placed) {
      assert.ok(rect.w >= MIN_TARGET && rect.h >= MIN_TARGET, `${label}: ${id} is ${rect.w}x${rect.h}`);
      assert.ok(inside(rect, viewport.width, viewport.height, safe), `${label}: ${id} ${JSON.stringify(rect)} leaves the screen`);
      for (const [other, fixed] of [['minimap', hud.minimap], ['score bar', hud.scoreBar], ['top buttons', hud.topActions]] as const) {
        assert.equal(overlaps(rect, fixed), false, `${label}: ${id} ${JSON.stringify(rect)} is on the ${other} ${JSON.stringify(fixed)}`);
      }
      assert.equal(overlaps(layout.status, rect), false, `${label}: status covers ${id}`);
    }
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
      assert.equal(overlaps(placed[i]![1], placed[j]![1], 4), false, `${label}: ${placed[i]![0]} touches ${placed[j]![0]}`);
    }
    assert.ok(inside(layout.status, viewport.width, viewport.height, safe), `${label}: status ${JSON.stringify(layout.status)} on screen`);
    assert.ok(layout.status.w >= 150, `${label}: status wide enough (${layout.status.w})`);
    assert.equal(overlaps(layout.look, layout.stick), false, `${label}: looking never starts on the stick`);
    assert.ok(layout.buttons.fire!.w > layout.buttons.reload!.w, `${label}: Fire is the biggest button`);
  }
});

test('with all of the Safari bars showing, messages and standings stay clear of the crosshair and every button', () => {
  for (const viewport of BARS_VIEWPORTS) for (const sprintButton of [false, true]) for (const rewards of [0, 1, 3]) for (const spec of Object.values(WEAPONS)) {
    const label = `${viewport.name} sprint=${sprintButton} rewards=${rewards} ${spec.id}`;
    const reach = crosshairReach(spec, 80, viewport.width, viewport.height);
    const { layout, hud } = barsHud(viewport, sprintButton, rewards, reach);
    const { callouts, standings, feed, minimap, scoreBar, topActions } = hud;
    const crosshair: Rect = { x: viewport.width / 2 - reach, y: viewport.height / 2 - reach, w: 2 * reach, h: 2 * reach };
    if (callouts.h) assert.ok(callouts.y + callouts.h <= viewport.height / 2 - reach, `${label}: messages end above the crosshair`);
    for (const [name, rect] of [['messages', callouts], ['feed', feed]] as Array<[string, Rect]>) {
      if (!rect.h) continue;
      assert.equal(overlaps(rect, crosshair), false, `${label}: ${name} covers the crosshair`);
      for (const [id, control] of controls(layout)) assert.equal(overlaps(rect, control), false, `${label}: ${name} covers ${id}`);
      assert.equal(overlaps(rect, layout.status), false, `${label}: ${name} covers the status panel`);
      for (const fixed of [minimap, scoreBar, topActions]) assert.equal(overlaps(rect, fixed), false, `${label}: ${name} covers ${JSON.stringify(fixed)}`);
    }
    for (const [id, control] of controls(layout)) assert.equal(overlaps(standings, control), false, `${label}: standings cover ${id}`);
    assert.equal(overlaps(standings, layout.status), false, `${label}: standings cover the status panel`);
    assert.equal(overlaps(standings, topActions), false, `${label}: standings cover the pause button`);
    // Very tight only on the narrowest phone holding all three rewards; it never covers a button to get wider.
    assert.ok(standings.w >= (viewport.width < 640 ? 100 : 170) && standings.h >= 60, `${label}: standings big enough to read (${standings.w}x${standings.h})`);
  }
  // With the usual gun there is always room for a message.
  for (const viewport of BARS_VIEWPORTS) {
    const { hud } = barsHud(viewport, false, 3, crosshairReach(WEAPONS.kr5, 80, viewport.width, viewport.height));
    assert.ok(hud.callouts.h >= TOUCH_CALLOUT.notice, `${viewport.name}: ${hud.callouts.h}px for messages`);
  }
});

test('earning a reward never moves a button under the thumbs of the player', () => {
  for (const viewport of [...BARS_VIEWPORTS, ...VIEWPORTS]) {
    const none = touchLayout({ ...viewport }), three = touchLayout({ ...viewport, rewards: 3 });
    assert.deepEqual(three.buttons, none.buttons, viewport.name);
    assert.deepEqual(three.stick, none.stick, viewport.name);
    // In portrait the status panel sits above whatever controls there are, so only there can it move.
    if (viewport.width > viewport.height) assert.deepEqual(three.status, none.status, viewport.name);
  }
});

test('screens with room keep the usual layout', () => {
  for (const viewport of [...VIEWPORTS, ...SHORT_VIEWPORTS]) assert.equal(touchLayout(viewport).compact, false, viewport.name);
  // Too narrow for two rows of buttons: the short layout needs the width.
  assert.equal(touchLayout({ width: 568, height: 200 }).compact, false);
});

test('a short screen gets a smaller minimap, clear of the movement stick', () => {
  assert.equal(minimapSpec(852, 258, true).size, 80);
  assert.equal(minimapSpec(852, 315, true).size, 96);
  assert.equal(minimapSpec(1920, 280, false).size, 150, 'desktop windows keep their own size');
});
