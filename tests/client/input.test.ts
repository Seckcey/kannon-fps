import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InputController } from '../../src/game/InputController.js';

function browserEnvironment(run: (environment: { window: EventTarget; document: EventTarget & { hidden: boolean; focused: boolean } }) => void) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const window = Object.assign(new EventTarget(), { matchMedia: () => ({ matches: true }) });
  const document = Object.assign(new EventTarget(), {
    hidden: false, focused: true, pointerLockElement: null,
    hasFocus() { return this.focused; }, exitPointerLock() {},
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  try { run({ window, document }); }
  finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
}

test('late touch movement during a pause cannot resume the player without a fresh gesture', () => {
  browserEnvironment(() => {
    const input = new InputController();
    try {
      input.setTouchMove(1, 0);
      input.setPaused(true);
      input.setTouchMove(0, 1);
      input.setPaused(false);
      assert.equal(input.current().moveZ, 0);
      input.setTouchMove(0, 1);
      assert.equal(input.current().moveZ, 1);
    } finally { input.dispose(); }
  });
});

test('background callbacks cannot move, turn, fire, or change slots, and focus requires fresh input', () => {
  browserEnvironment(({ window, document }) => {
    const input = new InputController();
    try {
      input.setTouchMove(1, 0); input.setAction('aim', true); input.setAction('fire', true);
      document.focused = false; window.dispatchEvent(new Event('blur'));
      input.setTouchMove(1, 1); input.setTouchLook(80, 40); input.setAction('fire', true); input.setSlot(2);
      assert.equal(input.current().moveX, 0); assert.equal(input.peek().fire, false);
      assert.equal(input.yaw, 0); assert.equal(input.slot, 1);
      document.hidden = true; document.dispatchEvent(new Event('visibilitychange'));
      document.focused = true; window.dispatchEvent(new Event('focus'));
      input.setTouchMove(1, 0); input.setAction('fire', true);
      assert.equal(input.current().moveX, 0); assert.equal(input.peek().fire, false);
      document.hidden = false; document.dispatchEvent(new Event('visibilitychange'));
      assert.equal(input.current().moveX, 0); assert.equal(input.peek().aim, false);
      input.setTouchMove(1, 0); input.setAction('fire', true);
      assert.equal(input.current().moveX, 1); assert.equal(input.peek().fire, true);
    } finally { input.dispose(); }
  });
});

test('short action taps survive release for one network frame and held fire continues', () => {
  browserEnvironment(() => {
    const input = new InputController();
    try {
      for (const action of ['fire', 'jump', 'reload'] as const) {
        input.setAction(action, true); input.setAction(action, false);
        assert.equal(input.peek()[action], true);
        assert.equal(input.current()[action], true);
        assert.equal(input.current()[action], false);
      }
      input.setAction('fire', true);
      assert.equal(input.current().fire, true); assert.equal(input.current().fire, true);
      input.setPaused(true); input.setPaused(false);
      assert.equal(input.current().fire, false);
    } finally { input.dispose(); }
  });
});

test('cancelled touch actions do not leave queued shots, jumps, or reloads', () => {
  browserEnvironment(() => {
    const input = new InputController();
    try {
      for (const action of ['fire', 'jump', 'reload'] as const) {
        input.setAction(action, true); input.cancelAction(action);
        assert.equal(input.current()[action], false);
      }
    } finally { input.dispose(); }
  });
});

test('reset subscribers clear their HUD state on blur and pause and detach cleanly', () => {
  browserEnvironment(({ window }) => {
    const input = new InputController(); let resets = 0;
    const unsubscribe = input.subscribeReset(() => { resets++; });
    input.setAction('aim', true); window.dispatchEvent(new Event('blur'));
    assert.equal(resets, 1); assert.equal(input.peek().aim, false);
    input.setPaused(true); assert.equal(resets, 2);
    unsubscribe(); window.dispatchEvent(new Event('focus'));
    assert.equal(resets, 2);
    input.subscribeReset(() => { throw new Error('A disposed HUD must not be notified.'); });
    input.dispose(); window.dispatchEvent(new Event('blur'));
    assert.equal(input.acceptsInput, false);
  });
});
