import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { InputController } from '../../src/game/InputController.js';
import { Loadout } from '../../src/components/Loadout.js';

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

test('weapon icons accept a non-primary finger immediately while moving, firing, aiming, jumping and sprinting', () => {
  browserEnvironment(() => {
    const input = new InputController(undefined, { firingMode: 'advanced' });
    try {
      input.setTouchMove(0, 1);
      for (const action of ['fire', 'aim', 'jump', 'sprint', 'reload'] as const) input.setAction(action, true);
      const shotgun = Loadout({ onSelect: slot => input.setSlot(slot) }).props.children[1];
      let prevented = false;
      shotgun.props.onPointerDown({ button: 0, isPrimary: false, pointerType: 'touch', preventDefault() { prevented = true; } });
      const frame = input.current();
      assert.equal(prevented, true); assert.equal(frame.slot, 2); assert.equal(frame.moveZ, 1);
      for (const action of ['fire', 'aim', 'jump', 'sprint', 'reload'] as const) assert.equal(frame[action], true, action);
    } finally { input.dispose(); }
  });
});

test('a delayed compatibility click cannot undo a newer weapon press; keyboard activation still works', () => {
  const selected: number[] = [];
  const buttons = Loadout({ onSelect: slot => selected.push(slot) }).props.children;
  const press = { button: 0, preventDefault() {} };
  buttons[2].props.onPointerDown(press);
  buttons[1].props.onPointerDown(press);
  buttons[2].props.onClick({ detail: 1 });
  assert.deepEqual(selected, [3, 2]);
  buttons[0].props.onClick({ detail: 0 });
  buttons[1].props.onPointerDown({ button: 2, preventDefault() { assert.fail('Right click must be ignored'); } });
  assert.deepEqual(selected, [3, 2, 1]);
  assert.equal(Loadout({}).props.children[0].props.disabled, true);
});

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

function desktopEnvironment(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const window = Object.assign(new EventTarget(), { matchMedia: () => ({ matches: false }) });
  let requests = 0;
  const canvas = Object.assign(new EventTarget(), { requestPointerLock: () => { requests++; return Promise.resolve(); } });
  const document = Object.assign(new EventTarget(), {
    hidden: false, focused: true, pointerLockElement: null as EventTarget | null,
    hasFocus() { return this.focused; },
    exitPointerLock() { this.pointerLockElement = null; document.dispatchEvent(new Event('pointerlockchange')); },
  });
  const original = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window, document, HTMLElement: class HTMLElement {} })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const input = new InputController(canvas as unknown as HTMLCanvasElement);
  t.after(() => {
    input.dispose();
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { input, window, document, canvas, requests: () => requests,
    lock: () => { document.pointerLockElement = canvas; document.dispatchEvent(new Event('pointerlockchange')); },
    key: (code: string, repeat = false) => window.dispatchEvent(Object.assign(new Event('keydown'), { code, repeat })),
  };
}

test('mouse engagement waits for actual capture and remains available while round actions are blocked', async t => {
  const f = desktopEnvironment(t);
  f.input.setGameplayBlocked(true);
  let completed = false;
  const captured = f.input.requestPointerLock().then(value => { completed = true; return value; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.requests(), 1); assert.equal(completed, false, 'A fulfilled request promise is not a pointer lock event.');
  f.lock(); assert.equal(await captured, true);
  assert.equal(f.input.locked, true); assert.equal(f.input.acceptsInput, false);
  f.input.setAction('fire', true); f.input.setTouchMove(0, 1); f.key('KeyW'); f.key('Space');
  assert.equal(f.input.current().moveZ, 0); assert.equal(f.input.current().fire, false);
  f.input.setGameplayBlocked(false);
  assert.equal(f.input.locked, true);
  f.key('KeyW', true); f.key('Space', true);
  assert.equal(f.input.current().moveZ, 0); assert.equal(f.input.current().jump, false);
  f.key('KeyW'); assert.equal(f.input.current().moveZ, 1);
  f.input.setGameplayBlocked(true); f.input.setGameplayBlocked(false);
  assert.equal(f.input.current().moveZ, 0); assert.equal(f.input.locked, true);
});

test('hard pause, focus loss, browser rejection and timeout cancel pending capture safely', async t => {
  const f = desktopEnvironment(t);
  const paused = f.input.requestPointerLock(); f.input.setPaused(true);
  assert.equal(await paused, false); assert.equal(await f.input.requestPointerLock(), false);
  f.lock(); assert.equal(f.input.locked, false, 'A late browser capture must release while hard paused.');
  f.input.setPaused(false);
  const blurred = f.input.requestPointerLock(); f.document.focused = false; f.window.dispatchEvent(new Event('blur'));
  assert.equal(await blurred, false);
  f.document.focused = true; f.window.dispatchEvent(new Event('focus'));
  const rejected = f.input.requestPointerLock(); f.document.dispatchEvent(new Event('pointerlockerror'));
  assert.equal(await rejected, false);
  const timeout = f.input.requestPointerLock(); t.mock.timers.tick(2500);
  assert.equal(await timeout, false);
  const next = f.input.requestPointerLock(); f.lock(); assert.equal(await next, true);
  f.input.setPaused(true); assert.equal(f.input.locked, false);
});

test('disposal resolves a pending lock request and removes its event callbacks', async t => {
  const f = desktopEnvironment(t);
  let notifications = 0; f.input.onLockChange = () => { notifications++; };
  const pending = f.input.requestPointerLock(); f.input.dispose();
  assert.equal(await pending, false);
  f.lock(); f.document.dispatchEvent(new Event('pointerlockerror'));
  assert.equal(notifications, 0); assert.equal(f.input.canEngage, false);
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
