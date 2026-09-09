import test from 'node:test';
import assert from 'node:assert/strict';
import { readSettings } from '../../src/lib/storage.js';
import { requestGyroscope, GyroscopeInput } from '../../src/game/Gyroscope.js';
import { InputController } from '../../src/game/InputController.js';

test('existing settings retain their values while mobile firing defaults to Simple and gyro stays off', t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let saved = JSON.stringify({ sensitivity: 1.8, volume: .2, quality: 'low', invertY: true });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => saved } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'localStorage', previous) : Reflect.deleteProperty(globalThis, 'localStorage'));
  assert.deepEqual(readSettings(), { sensitivity: 1.8, volume: .2, quality: 'low', invertY: true, firingMode: 'simple', gyroscope: false, gyroSensitivity: 1 });
  saved = JSON.stringify({ firingMode: 'advanced', gyroscope: true, gyroSensitivity: 500 });
  assert.equal(readSettings().firingMode, 'advanced'); assert.equal(readSettings().gyroSensitivity, 2.5);
  saved = JSON.stringify({ firingMode: 'unknown', gyroscope: 'true', gyroSensitivity: 'fast' });
  assert.equal(readSettings().firingMode, 'simple'); assert.equal(readSettings().gyroscope, false); assert.equal(readSettings().gyroSensitivity, 1);
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
