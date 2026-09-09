import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { InputController } from '../../src/game/InputController.js';
import { TouchGestures } from '../../src/game/TouchGestures.js';

function fixture(t: TestContext, hybrid = false) {
  class ElementStub extends EventTarget {
    dataset: { touch?: string };
    constructor(role?: string) { super(); this.dataset = { touch: role }; }
    closest() { return this; }
    contains() { return true; }
    getBoundingClientRect() { return { x: 0, y: 0, width: 130, height: 130 }; }
    setPointerCapture() { throw new Error('Simulated unavailable capture'); }
    hasPointerCapture() { return false; }
    releasePointerCapture() {}
  }
  const window = Object.assign(new EventTarget(), { ontouchstart: null, matchMedia: () => ({ matches: true }) });
  if (hybrid) Reflect.deleteProperty(window, 'ontouchstart');
  const document = Object.assign(new EventTarget(), { hidden: false, pointerLockElement: null, hasFocus: () => true, exitPointerLock() {} });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window, document, Element: ElementStub, HTMLElement: ElementStub })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const root = new ElementStub(), move = new ElementStub('move'), look = new ElementStub('look'), fire = new ElementStub('fire');
  const input = new InputController(); let stick = [0, 0];
  const controls = new TouchGestures(root as unknown as HTMLElement, input, (x, y) => { stick = [x, y]; });
  type Finger = { identifier: number; clientX: number; clientY: number };
  const finger = (identifier: number, clientX = 65, clientY = 21): Finger => ({ identifier, clientX, clientY });
  const touch = (type: string, target: ElementStub, changed: Finger[], live: Finger[]) => {
    const event = Object.assign(new Event(type, { cancelable: true }), { changedTouches: changed, touches: live });
    Object.defineProperty(event, 'target', { value: target });
    (type === 'touchstart' ? root : document).dispatchEvent(event);
  };
  const pointer = (type: string, target: ElementStub, pointerId: number, x = 65, y = 21, pointerType = 'mouse', buttons = 1) => {
    const event = Object.assign(new Event(type, { cancelable: true }), { pointerId, clientX: x, clientY: y, pointerType, button: 0, buttons });
    Object.defineProperty(event, 'target', { value: target });
    (type === 'pointerdown' ? root : document).dispatchEvent(event);
  };
  t.after(() => {
    controls.dispose(); input.dispose();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  });
  return { input, controls, window, document, root, move, look, fire, finger, touch, pointer, stick: () => stick };
}

test('iPhone touch release stops movement even if pointerup and lost capture never arrive', t => {
  const f = fixture(t), first = f.finger(11);
  f.pointer('pointerdown', f.move, 8, 65, 21, 'touch');
  f.touch('touchstart', f.move, [first], [first]);
  assert.equal(f.input.current().moveZ, 1);
  // Safari's native touch stream finishes, while its pointer stream is missing.
  f.touch('touchend', f.root, [first], []);
  assert.equal(f.input.current().moveZ, 0); assert.deepEqual(f.stick(), [0, 0]);
  f.pointer('pointermove', f.move, 8, 65, 0, 'touch');
  assert.equal(f.input.current().moveZ, 0);
});

test('releasing movement while the other thumb keeps aiming clears only that finger', t => {
  const f = fixture(t), left = f.finger(11), right = f.finger(22, 400, 170);
  f.touch('touchstart', f.move, [left], [left]); f.touch('touchstart', f.look, [right], [left, right]);
  f.touch('touchend', f.root, [left], [right]);
  assert.equal(f.input.current().moveZ, 0);
  f.touch('touchmove', f.root, [f.finger(22, 430, 180)], [f.finger(22, 430, 180)]);
  assert.ok(f.input.yaw > 0); assert.ok(f.input.pitch < 0);
});

test('the complete active touch list recovers a missing end event without stopping a stationary held finger', t => {
  const f = fixture(t), left = f.finger(11), right = f.finger(22, 400, 170);
  f.touch('touchstart', f.move, [left], [left]); f.touch('touchstart', f.look, [right], [left, right]);
  for (let i = 0; i < 300; i++) assert.equal(f.input.current().moveZ, 1);
  f.touch('touchmove', f.look, [f.finger(22, 450, 170)], [left, f.finger(22, 450, 170)]);
  assert.equal(f.input.current().moveZ, 1);
  // A later touch event says the left finger no longer exists.
  f.touch('touchmove', f.look, [f.finger(22, 470, 170)], [f.finger(22, 470, 170)]);
  assert.equal(f.input.current().moveZ, 0); assert.deepEqual(f.stick(), [0, 0]);
});

test('capture failure, cancellation, orientation and death reset held actions and queued taps', t => {
  const f = fixture(t);
  f.pointer('pointerdown', f.move, 1); assert.equal(f.input.current().moveZ, 1);
  f.pointer('pointerup', f.root, 1); assert.equal(f.input.current().moveZ, 0);
  f.touch('touchstart', f.fire, [f.finger(2)], [f.finger(2)]);
  f.touch('touchcancel', f.root, [f.finger(2)], []); assert.equal(f.input.current().fire, false);
  for (const event of ['orientationchange', 'pagehide']) {
    f.touch('touchstart', f.move, [f.finger(4)], [f.finger(4)]);
    f.window.dispatchEvent(new Event(event)); assert.equal(f.input.current().moveZ, 0);
  }
  f.touch('touchstart', f.move, [f.finger(4)], [f.finger(4)]);
  f.input.setGameplayBlocked(true); f.input.setGameplayBlocked(false);
  f.touch('touchmove', f.move, [f.finger(4, 65, 0)], [f.finger(4, 65, 0)]);
  assert.equal(f.input.current().moveZ, 0, 'Respawn requires a fresh touch.');
});

test('Advanced fire supports aiming drag and AR ADS while shotgun retains hip fire', t => {
  const f = fixture(t); f.input.setSettings({ firingMode: 'advanced' });
  f.touch('touchstart', f.fire, [f.finger(1)], [f.finger(1)]);
  f.touch('touchmove', f.root, [f.finger(1, 100, 40)], [f.finger(1, 100, 40)]);
  assert.ok(f.input.yaw > 0); assert.equal(f.input.current().fire, true); assert.equal(f.input.peek().aim, true);
  f.touch('touchend', f.root, [f.finger(1)], []);
  assert.equal(f.input.current().fire, false); assert.equal(f.input.peek().aim, false);
  f.input.setSlot(2); f.touch('touchstart', f.fire, [f.finger(2)], [f.finger(2)]);
  assert.equal(f.input.current().fire, true); assert.equal(f.input.peek().aim, false);
});

test('a hybrid browser transfers its first pointer contact to native touch and ignores the later pointer cancel', t => {
  const f = fixture(t, true), left = f.finger(11);
  f.pointer('pointerdown', f.move, 8, 65, 21, 'touch');
  f.touch('touchstart', f.move, [left], [left]);
  f.pointer('pointercancel', f.move, 8, 65, 21, 'touch');
  assert.equal(f.input.current().moveZ, 1);
  f.touch('touchend', f.root, [left], []); assert.equal(f.input.current().moveZ, 0);
});

test('a coalesced touch start preserves each finger target instead of assigning both to the first control', t => {
  const f = fixture(t), left = { ...f.finger(11), target: f.move }, right = { ...f.finger(22, 400, 170), target: f.look };
  f.touch('touchstart', f.move, [left, right], [left, right]);
  f.touch('touchmove', f.root, [f.finger(22, 440, 170)], [left, f.finger(22, 440, 170)]);
  assert.equal(f.input.current().moveZ, 1); assert.ok(f.input.yaw > 0);
  f.touch('touchend', f.root, [left, right], []); assert.equal(f.input.current().moveZ, 0);
});
