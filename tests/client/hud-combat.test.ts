import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_LOADOUT, WEAPONS } from '../../shared/weapons.js';
import { HudStore, type HudFrame } from '../../src/game/hud.js';
import { CombatHud, ScopeLayer } from '../../src/components/hud/CombatHud.js';
import { ARC_MS, CLOCK_SKEW_MS, MARKER_MS, ammoLevel, arcOpacity, cookState, crosshairReach, crosshairRing, crosshairStyle, crosshairTicks, fadeOut, grenadeAlert, healthBarVisible, lowHealthLevel, staminaVisible, streakProgress } from '../../src/components/hud/combat.js';

const scopedFrame: HudFrame = {
  time: 1000, weapon: 'longbow', slot: 1, mag: 5, reserve: 20, frags: 1, reload: -1, ads: 1, scoped: true,
  sprinting: false, dashing: false, stamina: 1, posture: 'stand', health: 100, crosshair: 0, cook: -1, blocked: false,
  hitMarkers: [], damageArcs: [], grenades: [], view: { x: 0, z: 0, yaw: 0 }, blips: [], reconActive: false, rewards: [], mortarTargeting: false,
};

test('the scope is its own layer under the touch controls, not part of the HUD layer above them', () => {
  const hud = new HudStore();
  hud.publish(scopedFrame);
  // CombatHud renders inside the HUD layer, which sits above the touch controls on phones.
  const combat = renderToStaticMarkup(createElement(CombatHud, { hud, input: null, touch: true, live: true, status: true, autoTarget: false, streak: 0,
    loadout: DEFAULT_LOADOUT, minimap: { size: 96, range: 20 } }));
  assert.ok(combat.includes('ammo-panel'), 'the HUD itself still draws');
  assert.ok(!combat.includes('scope-overlay'), 'a scope inside the HUD layer would black out every button');
  assert.ok(renderToStaticMarkup(createElement(ScopeLayer, { hud, live: true })).includes('scope-overlay'), 'a fully aimed scope draws');
  assert.equal(renderToStaticMarkup(createElement(ScopeLayer, { hud, live: false })), '', 'not while dead or in a menu');
  hud.publish({ ...scopedFrame, scoped: false });
  assert.equal(renderToStaticMarkup(createElement(ScopeLayer, { hud, live: true })), '', 'not before the scope is up');
});

test('every weapon class has its own crosshair and a zero gap hides it', () => {
  assert.equal(crosshairStyle(WEAPONS.kr5.kind), 'cross');
  assert.equal(crosshairStyle(WEAPONS.hornet9.kind), 'tight');
  assert.equal(crosshairStyle(WEAPONS.breaker12.kind), 'ring');
  assert.equal(crosshairStyle(WEAPONS.longbow.kind), 'wide');
  assert.equal(crosshairStyle(WEAPONS.sentry9.kind), 'pistol');
  for (const style of ['cross', 'tight', 'ring', 'wide', 'pistol'] as const) {
    assert.deepEqual(crosshairTicks(style, 0), []);
    assert.deepEqual(crosshairTicks(style, Number.NaN), []);
    assert.equal(crosshairRing(style, 0), 0);
  }
  const cross = crosshairTicks('cross', 12);
  assert.equal(cross.length, 4);
  const [left, right, top, bottom] = cross as [typeof cross[0], typeof cross[0], typeof cross[0], typeof cross[0]];
  assert.equal(left.x + left.w, -12); assert.equal(right.x, 12); assert.equal(top.y + top.h, -12); assert.equal(bottom.y, 12);
  assert.equal(crosshairTicks('pistol', 10).length, 3, 'the pistol crosshair has no top line');
  assert.ok(crosshairTicks('pistol', 10).every(tick => tick.y > -10 || tick.h <= 2));
  assert.equal(crosshairRing('ring', 30), 30); assert.equal(crosshairRing('wide', 3), 8); assert.equal(crosshairRing('cross', 30), 0);
});

test('markers and damage arcs fade over their lifetimes', () => {
  assert.equal(fadeOut(1000, 1000, 200), 1);
  assert.equal(fadeOut(1100, 1000, 200), 0.5);
  assert.equal(fadeOut(1300, 1000, 200), 0);
  assert.equal(fadeOut(900, 1000, 200), 1, 'a marker from a slightly later clock still shows');
  assert.ok(MARKER_MS.kill > MARKER_MS.head && MARKER_MS.head > MARKER_MS.hit, 'eliminations linger longest');
  assert.ok(arcOpacity(0, 0, 60) > arcOpacity(0, 0, 8), 'bigger hits draw stronger arcs');
  assert.equal(arcOpacity(ARC_MS, 0, 60), 0);
  assert.ok(arcOpacity(0, 0, 1) >= 0.45);
});

test('a marker stamped on another clock expires instead of staying on screen', () => {
  // HudFrame.time is performance.now(); a server-time stamp (epoch milliseconds) is far in its future.
  const frameTime = 52_000, serverStamp = 1_793_000_000_000;
  assert.equal(fadeOut(frameTime, serverStamp, MARKER_MS.hit), 0);
  assert.equal(arcOpacity(frameTime, serverStamp, 60), 0);
  assert.equal(fadeOut(frameTime, frameTime + CLOCK_SKEW_MS + 1, 200), 0);
  assert.equal(fadeOut(frameTime, frameTime + CLOCK_SKEW_MS - 1, 200), 1, 'a stamp a moment ahead still shows');
  assert.equal(fadeOut(frameTime, Number.NaN, 200), 0);
  assert.equal(fadeOut(Number.NaN, frameTime, 200), 0);
});

test('crosshair reach covers the drawn crosshair, its markers and the cook ring', () => {
  const [width, height] = [844, 390];
  for (const spec of Object.values(WEAPONS)) for (const fov of [70, 90, 110]) {
    const reach = crosshairReach(spec, fov, width, height);
    assert.ok(Number.isInteger(reach) && reach >= 30, `${spec.id} at ${fov}°: ${reach}`);
    // Whatever gap the game draws for this weapon at hip (its cone at this field of view, or the base gap).
    const vertical = 2 * Math.atan(Math.tan(fov * Math.PI / 360) * height / width);
    const spread = spec.pelletSpread?.hip ?? spec.hipSpread;
    const gap = Math.max(11, Math.tan(spread) / Math.tan(vertical / 2) * height / 2);
    const style = crosshairStyle(spec.kind);
    for (const tick of crosshairTicks(style, gap)) assert.ok(Math.max(Math.abs(tick.y), Math.abs(tick.y + tick.h)) < reach, `${spec.id}: tick inside`);
    assert.ok(crosshairRing(style, gap) < reach, `${spec.id}: ring inside`);
  }
  assert.equal(crosshairReach(WEAPONS.kr5, 80, width, height), 30, 'line crosshairs are covered by the marker and cook ring floor');
  assert.ok(crosshairReach(WEAPONS.longbow, 80, width, height) > crosshairReach(WEAPONS.breaker12, 80, width, height));
  assert.ok(crosshairReach(WEAPONS.longbow, 70, width, height) > crosshairReach(WEAPONS.longbow, 110, width, height), 'a narrow view magnifies the hip cone');
  assert.ok(crosshairReach(WEAPONS.longbow, Number.NaN, width, height) >= 30, 'a broken setting still gives a sane reach');
});

test('the low-health edge grows as health drops and the bar shows only when hurt', () => {
  assert.equal(lowHealthLevel(100), 0); assert.equal(lowHealthLevel(70), 0);
  assert.equal(lowHealthLevel(42.5), 0.5); assert.equal(lowHealthLevel(15), 1); assert.equal(lowHealthLevel(3), 1);
  assert.equal(lowHealthLevel(0), 0, 'the elimination card replaces the vignette');
  assert.ok(lowHealthLevel(30) > lowHealthLevel(50));
  assert.equal(healthBarVisible(100), false); assert.equal(healthBarVisible(99), true); assert.equal(healthBarVisible(0), false);
});

test('ammo warnings follow each magazine size', () => {
  assert.equal(ammoLevel(30, 30), 'ok'); assert.equal(ammoLevel(9, 30), 'ok'); assert.equal(ammoLevel(8, 30), 'low'); assert.equal(ammoLevel(0, 30), 'empty');
  assert.equal(ammoLevel(3, 5), 'ok'); assert.equal(ammoLevel(2, 5), 'low');
  assert.equal(ammoLevel(1, 6), 'low'); assert.equal(ammoLevel(-1, 12), 'empty');
});

test('streak progress points at the next reward', () => {
  const fresh = streakProgress(0);
  assert.equal(fresh.next?.id, 'recon'); assert.equal(fresh.remaining, 3);
  assert.deepEqual(fresh.marks.map(mark => mark.kills), [3, 5, 7]);
  const four = streakProgress(4);
  assert.equal(four.next?.id, 'mortar'); assert.equal(four.remaining, 1);
  assert.deepEqual(four.marks.map(mark => mark.reached), [true, false, false]);
  const done = streakProgress(9);
  assert.equal(done.next, null); assert.equal(done.remaining, 0); assert.ok(done.marks.every(mark => mark.reached));
  assert.equal(streakProgress(Number.NaN).streak, 0);
});

test('grenade cooking, grenade alerts and stamina', () => {
  assert.deepEqual(cookState(-1), { active: false, progress: 0, danger: false });
  assert.deepEqual(cookState(0.3), { active: true, progress: 0.3, danger: false });
  assert.equal(cookState(0.75).danger, true); assert.equal(cookState(4).progress, 1);
  assert.ok(grenadeAlert(1) > grenadeAlert(6) && grenadeAlert(6) > grenadeAlert(20) - 1e-9);
  assert.equal(grenadeAlert(2), 1); assert.equal(grenadeAlert(50), 0.4);
  assert.equal(staminaVisible(1, false), false); assert.equal(staminaVisible(1, true), true); assert.equal(staminaVisible(0.6, false), true);
});
