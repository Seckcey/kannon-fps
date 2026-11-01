import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { activeLoadout, defaultSettings, isTouchDevice, readSettings, sanitizeSettings, saveSettings, SETTING_RANGES } from '../../src/lib/storage.js';
import { warmupTextureTier } from '../../src/lib/warmup.js';
import { requestGyroscope, GyroscopeInput } from '../../src/game/Gyroscope.js';
import { InputController } from '../../src/game/InputController.js';
import { DEFAULT_LOADOUT, LOADOUT_PRESETS } from '../../shared/weapons.js';

/** Replaces a global for one test. */
function withGlobal(t: TestContext, key: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key));
}
function withStorage(t: TestContext, initial: unknown) {
  const store = { saved: JSON.stringify(initial) };
  withGlobal(t, 'localStorage', { getItem: () => store.saved, setItem: (_key: string, value: string) => { store.saved = value; } });
  return store;
}
/** A browser whose media queries answer from `matches`. */
const withMedia = (t: TestContext, matches: (query: string) => boolean) => withGlobal(t, 'matchMedia', (query: string) => ({ matches: matches(query) }));

test('existing settings retain their values while mobile firing defaults to Simple and gyro stays off', t => {
  const store = withStorage(t, { sensitivity: 1.8, volume: .2, quality: 'low', invertY: true });
  assert.deepEqual(readSettings(false), { ...defaultSettings(false), sensitivity: 1.8, volume: .2, quality: 'low', invertY: true, firingMode: 'simple', gyroscope: false, gyroSensitivity: 1 });
  store.saved = JSON.stringify({ firingMode: 'advanced', gyroscope: true, gyroSensitivity: 500 });
  assert.equal(readSettings().firingMode, 'advanced'); assert.equal(readSettings().gyroSensitivity, 2.5);
  store.saved = JSON.stringify({ firingMode: 'unknown', gyroscope: 'true', gyroSensitivity: 'fast' });
  assert.equal(readSettings().firingMode, 'simple'); assert.equal(readSettings().gyroscope, false); assert.equal(readSettings().gyroSensitivity, 1);
});

test('first-person defaults differ for touch and desktop', () => {
  const desktop = defaultSettings(false), touch = defaultSettings(true);
  assert.equal(desktop.fov, 90); assert.equal(touch.fov, 80);
  assert.equal(desktop.aimMode, 'hold'); assert.equal(touch.aimMode, 'toggle');
  assert.equal(desktop.crouchMode, 'toggle'); assert.equal(touch.crouchMode, 'toggle');
  assert.equal(desktop.sprintMode, 'hold'); assert.equal(touch.sprintMode, 'auto');
  for (const value of [desktop, touch]) {
    assert.equal(value.adsSensitivity, 1); assert.equal(value.reduceMotion, false);
    assert.equal(value.loadoutPreset, 'assault'); assert.deepEqual(value.customLoadout, DEFAULT_LOADOUT);
    assert.notEqual(value.customLoadout, DEFAULT_LOADOUT, 'defaults never share the contract object');
  }
  // A saved desktop value is kept on a phone; only missing values follow the device.
  assert.equal(sanitizeSettings({ fov: 100 }, true).fov, 100);
  assert.equal(sanitizeSettings({}, true).sprintMode, 'auto');
  assert.deepEqual(sanitizeSettings(null, false), defaultSettings(false));
  assert.deepEqual(sanitizeSettings('nonsense', true), defaultSettings(true));
});

test('new settings are clamped to their ranges and unknown choices fall back', () => {
  const low = sanitizeSettings({ fov: 30, adsSensitivity: 0.01, sensitivity: -4, volume: -1 }, false);
  assert.equal(low.fov, SETTING_RANGES.fov[0]); assert.equal(low.adsSensitivity, 0.3); assert.equal(low.sensitivity, 0.2); assert.equal(low.volume, 0);
  const high = sanitizeSettings({ fov: 400, adsSensitivity: 9, volume: 4 }, false);
  assert.equal(high.fov, 110); assert.equal(high.adsSensitivity, 2); assert.equal(high.volume, 1);
  assert.equal(sanitizeSettings({ fov: 95.4 }, false).fov, 95);
  assert.equal(sanitizeSettings({ fov: '100', adsSensitivity: null }, false).fov, 90);
  assert.equal(sanitizeSettings({ adsSensitivity: Number.NaN }, false).adsSensitivity, 1);
  const odd = sanitizeSettings({ aimMode: 'tap', crouchMode: 1, sprintMode: 'always', reduceMotion: 'yes', quality: 'ultra' }, true);
  assert.equal(odd.aimMode, 'toggle'); assert.equal(odd.crouchMode, 'toggle'); assert.equal(odd.sprintMode, 'auto');
  assert.equal(odd.reduceMotion, false); assert.equal(odd.quality, 'auto');
  const chosen = sanitizeSettings({ aimMode: 'toggle', crouchMode: 'hold', sprintMode: 'toggle', reduceMotion: true }, false);
  assert.equal(chosen.aimMode, 'toggle'); assert.equal(chosen.crouchMode, 'hold'); assert.equal(chosen.sprintMode, 'toggle'); assert.equal(chosen.reduceMotion, true);
});

test('camera motion starts calm when the device asks for reduced motion, and a saved choice still wins', t => {
  let reduce = true;
  withMedia(t, query => reduce && query === '(prefers-reduced-motion: reduce)');
  const store = withStorage(t, {});
  assert.equal(defaultSettings(false).reduceMotion, true);
  assert.equal(readSettings(true).reduceMotion, true, 'a first visit follows the device');
  store.saved = JSON.stringify({ reduceMotion: false });
  assert.equal(readSettings(true).reduceMotion, false, 'the player turned it off');
  store.saved = JSON.stringify({ reduceMotion: 'yes' });
  assert.equal(readSettings(false).reduceMotion, true, 'a broken value falls back to the device');
  reduce = false;
  store.saved = '{}';
  assert.equal(readSettings(false).reduceMotion, false);
  store.saved = JSON.stringify({ reduceMotion: true });
  assert.equal(readSettings(false).reduceMotion, true, 'the player turned it on');
});

test('a touch-screen laptop warms up the same full town it plays, not the phone build', t => {
  // A touch screen with a mouse or trackpad as the main pointer: touch controls, desktop rendering.
  let coarse = false;
  withMedia(t, query => coarse && query === '(pointer: coarse)');
  withGlobal(t, 'navigator', { maxTouchPoints: 10 });
  assert.equal(isTouchDevice(), true, 'it still gets the touch controls');
  assert.equal(warmupTextureTier('auto'), 'full', 'the match draws the full town, so the warm-up fetches that file');
  assert.equal(warmupTextureTier('high'), 'full');
  assert.equal(warmupTextureTier('low'), 'phone');
  coarse = true;
  assert.equal(warmupTextureTier('auto'), 'phone', 'phones warm the phone build');
  assert.equal(warmupTextureTier('high'), 'full');
});

test('loadout choices persist and invalid saved classes are replaced', t => {
  const custom = { primary: 'breaker12', secondary: 'sentry9', lethal: 'frag', perks: ['quick-hands', 'low-profile', 'steady-aim'] };
  const store = withStorage(t, { loadoutPreset: 'custom', customLoadout: custom });
  const read = readSettings(false);
  assert.equal(read.loadoutPreset, 'custom');
  assert.deepEqual(read.customLoadout, custom);
  assert.deepEqual(activeLoadout(read), custom);
  saveSettings({ ...read, loadoutPreset: 'marksman' });
  assert.equal(readSettings(false).loadoutPreset, 'marksman');
  assert.deepEqual(activeLoadout(readSettings(false)), LOADOUT_PRESETS.marksman);
  assert.deepEqual(readSettings(false).customLoadout, custom, 'the custom class survives picking a preset');
  // Two slot-1 perks, an unknown weapon or an unknown preset never reach the server.
  store.saved = JSON.stringify({ loadoutPreset: 'sniper', customLoadout: { ...custom, perks: ['quick-hands', 'deep-pockets', 'steady-aim'] } });
  assert.equal(readSettings(false).loadoutPreset, 'assault');
  assert.deepEqual(readSettings(false).customLoadout, DEFAULT_LOADOUT);
  store.saved = JSON.stringify({ loadoutPreset: 'custom', customLoadout: { ...custom, primary: 'railgun' } });
  assert.deepEqual(activeLoadout(readSettings(false)), DEFAULT_LOADOUT);
  for (const preset of ['assault', 'close', 'marksman'] as const) assert.deepEqual(activeLoadout({ loadoutPreset: preset, customLoadout: DEFAULT_LOADOUT }), LOADOUT_PRESETS[preset]);
  store.saved = '{not json';
  assert.deepEqual(readSettings(true), defaultSettings(true));
});

test('gyro permission is explicitly requested and sensor input obeys enabled, pause and death gates', async t => {
  const originals = new Map<string, PropertyDescriptor | undefined>(); let prompts = 0, permission = 'denied';
  const window = Object.assign(new EventTarget(), { isSecureContext: true, matchMedia: () => ({ matches: true }), DeviceMotionEvent: { requestPermission: async () => { prompts++; return permission; } } });
  const document = Object.assign(new EventTarget(), { hidden: false, hasFocus: () => true, pointerLockElement: null });
  for (const [key, value] of Object.entries({ window, document, screen: { orientation: { angle: 90 } } })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis,key)); Object.defineProperty(globalThis,key,{configurable:true,value});
  }
  const input = new InputController(), sensor = new GyroscopeInput(input);
  t.after(() => { sensor.dispose(); input.dispose(); for (const [key,previous] of originals) previous ? Object.defineProperty(globalThis,key,previous) : Reflect.deleteProperty(globalThis,key); });
  assert.equal(prompts,0); assert.equal(await requestGyroscope(),false); permission='granted'; assert.equal(await requestGyroscope(),true); assert.equal(prompts,2);
  const motion = () => window.dispatchEvent(Object.assign(new Event('devicemotion'), { interval:20, rotationRate:{beta:30,gamma:0} }));
  motion(); assert.equal(input.yaw,0); input.setSettings({gyroscope:true}); motion(); assert.ok(input.yaw<0);
  for (const gate of ['pause','death']) {
    if (gate==='pause') input.setPaused(true); else input.setGameplayBlocked(true);
    const before: number=input.yaw; motion(); assert.equal(input.yaw,before);
    input.setPaused(false); input.setGameplayBlocked(false);
  }
  input.setSettings({gyroscope:false}); const before=input.yaw; motion(); assert.equal(input.yaw,before);
  window.isSecureContext=false; assert.equal(await requestGyroscope(),false); assert.equal(prompts,2);
});
