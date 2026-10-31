import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { DOUBLE_TAP_MS, InputController, PITCH_LIMIT, type InputSettings } from '../../src/game/InputController.js';
import { coarsePointer, renderTier } from '../../src/game/RenderTiers.js';

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
/** Touch-style controller with a controllable clock. */
function touchInput(settings: Partial<InputSettings> = {}) {
  const clock = { now: 1_000 };
  const input = new InputController(undefined, settings, { clock: () => clock.now });
  return { input, clock };
}

test('a non-primary finger switches weapons immediately while moving, firing, aiming, jumping and sprinting', () => {
  browserEnvironment(() => {
    const input = new InputController(undefined, { firingMode: 'advanced', sprintMode: 'hold' });
    try {
      input.setTouchMove(0, 1);
      for (const action of ['fire', 'aim', 'jump', 'sprint', 'reload'] as const) input.setAction(action, true);
      input.setSlot(2);
      const frame = input.current();
      assert.equal(frame.slot, 2); assert.equal(frame.moveZ, 1);
      for (const action of ['fire', 'aim', 'jump', 'sprint', 'reload'] as const) assert.equal(frame[action], true, action);
      input.swapWeapon(); assert.equal(input.current().slot, 1);
      input.swapWeapon(); assert.equal(input.current().slot, 2);
      input.setSlot(3 as never); assert.equal(input.current().slot, 2, 'Only the primary and secondary slots exist');
    } finally { input.dispose(); }
  });
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

function desktopEnvironment(t: TestContext, settings: Partial<InputSettings> = {}) {
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
  const clock = { now: 5_000 };
  const input = new InputController(canvas as unknown as HTMLCanvasElement, settings, { clock: () => clock.now });
  t.after(() => {
    input.dispose();
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { input, window, document, canvas, clock, requests: () => requests,
    lock: () => { document.pointerLockElement = canvas; document.dispatchEvent(new Event('pointerlockchange')); },
    key: (code: string, repeat = false) => window.dispatchEvent(Object.assign(new Event('keydown'), { code, repeat })),
    release: (code: string) => window.dispatchEvent(Object.assign(new Event('keyup'), { code })),
    mouse: (type: 'mousedown' | 'mouseup', button: number) => (type === 'mousedown' ? canvas : window).dispatchEvent(Object.assign(new Event(type), { button })),
    wheel: (deltaY: number) => { const event = Object.assign(new Event('wheel', { cancelable: true }), { deltaY }); canvas.dispatchEvent(event); return event.defaultPrevented; },
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
      input.setTouchMove(1, 1); input.setTouchLook(80, 40); input.setAction('fire', true); input.setSlot(2); input.swapWeapon();
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
    const input = new InputController(undefined, { crouchMode: 'hold' });
    try {
      for (const action of ['fire', 'jump', 'reload', 'melee', 'grenade', 'crouch'] as const) {
        input.setAction(action, true); input.setAction(action, false);
        assert.equal(input.peek()[action], true, action);
        assert.equal(input.current()[action], true, action);
        assert.equal(input.current()[action], false, action);
      }
      input.setAction('fire', true);
      assert.equal(input.current().fire, true); assert.equal(input.current().fire, true);
      input.setPaused(true); input.setPaused(false);
      assert.equal(input.current().fire, false);
    } finally { input.dispose(); }
  });
});

test('cancelled touch actions do not leave queued shots, jumps, reloads, knives or grenades', () => {
  browserEnvironment(() => {
    const input = new InputController();
    try {
      for (const action of ['fire', 'jump', 'reload', 'melee', 'grenade'] as const) {
        input.setAction(action, true); input.cancelAction(action);
        assert.equal(input.current()[action], false, action);
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

test('aim and crouch follow their hold and toggle settings; toggle() latches either way', () => {
  browserEnvironment(() => {
    const { input } = touchInput({ aimMode: 'hold', crouchMode: 'hold' });
    try {
      input.setAction('aim', true); assert.equal(input.current().aim, true);
      input.setAction('aim', false); assert.equal(input.current().aim, false);
      input.setAction('crouch', true); assert.equal(input.current().crouch, true);
      input.setAction('crouch', false); input.current(); assert.equal(input.current().crouch, false);
      assert.equal(input.toggle('aim'), true, 'An explicit toggle latches even in hold mode');
      assert.equal(input.current().aim, true); assert.equal(input.toggle('aim'), false);
      input.setSettings({ aimMode: 'toggle', crouchMode: 'toggle' });
      input.setAction('aim', true); input.setAction('aim', false);
      assert.equal(input.current().aim, true, 'A toggle press stays aimed after release');
      input.setAction('aim', true); input.setAction('aim', false);
      assert.equal(input.current().aim, false);
      input.setAction('crouch', true); input.setAction('crouch', false);
      assert.equal(input.current().crouch, true); assert.equal(input.current().crouch, true);
      input.setAction('crouch', true);
      assert.equal(input.current().crouch, false, 'Standing up from a toggled crouch needs no pulse');
      assert.equal(input.toggle('crouch'), true); assert.equal(input.toggled.crouch, true);
      input.setAction('jump', true);
      const jump = input.current();
      assert.equal(jump.jump, true); assert.equal(jump.crouch, false, 'Jumping from a crouch stands up');
    } finally { input.dispose(); }
  });
});

test('double-tapping sprint within 300 ms dashes while held, and a slow second press does not', () => {
  browserEnvironment(() => {
    const { input, clock } = touchInput({ sprintMode: 'hold' });
    try {
      input.setTouchMove(0, 1);
      input.setAction('sprint', true);
      let frame = input.current(); assert.equal(frame.sprint, true); assert.equal(frame.dash, false);
      input.setAction('sprint', false); clock.now += DOUBLE_TAP_MS - 50;
      input.setAction('sprint', true);
      frame = input.current(); assert.equal(frame.sprint, true); assert.equal(frame.dash, true);
      assert.equal(input.current().dash, true, 'The dash lasts while sprint is held');
      input.setAction('sprint', false); assert.equal(input.current().dash, false);
      clock.now += DOUBLE_TAP_MS + 1; input.setAction('sprint', true);
      assert.equal(input.current().dash, false);
      input.setTouchMove(0, 0); input.setAction('sprint', false); input.setAction('sprint', true);
      assert.equal(input.peek().dash, true, 'The sprint request itself is independent of movement');
    } finally { input.dispose(); }
  });
});

test('toggled sprint dashes on a quick second toggle, stops on a slow one and ends when forward movement stops', () => {
  browserEnvironment(() => {
    const { input, clock } = touchInput({ sprintMode: 'toggle' });
    try {
      input.setTouchMove(0, 1);
      assert.equal(input.toggle('sprint'), true);
      assert.equal(input.current().sprint, true); assert.equal(input.current().dash, false);
      clock.now += 200; input.toggle('sprint');
      let frame = input.current(); assert.equal(frame.sprint, true); assert.equal(frame.dash, true);
      clock.now += 1_000; assert.equal(input.toggle('sprint'), false);
      frame = input.current(); assert.equal(frame.sprint, false); assert.equal(frame.dash, false);
      input.toggle('sprint'); assert.equal(input.current().sprint, true);
      input.setTouchMove(0, 0); assert.equal(input.current().sprint, false, 'Stopping ends a toggled sprint');
      input.setTouchMove(0, 1); assert.equal(input.current().sprint, false);
      input.toggle('sprint'); input.setAction('fire', true);
      assert.equal(input.current().sprint, false, 'Firing ends a toggled sprint');
      input.setAction('fire', false); input.toggle('sprint'); input.setAction('crouch', true);
      frame = input.current(); assert.equal(frame.sprint, false); assert.equal(frame.crouch, true, 'Crouching from a toggled sprint slides');
    } finally { input.dispose(); }
  });
});

test('auto sprint: the stick at the top edge sprints, a second push within 300 ms dashes', () => {
  browserEnvironment(() => {
    const { input, clock } = touchInput({ sprintMode: 'auto' });
    try {
      input.setTouchMove(0, 0.9); assert.equal(input.current().sprint, false, 'Below 95% the stick walks');
      input.setTouchMove(0, 0.97);
      let frame = input.current(); assert.equal(frame.sprint, true); assert.equal(frame.dash, false);
      input.setTouchMove(0.3, 0.8); assert.equal(input.current().sprint, true, 'Sprint holds above 75% once engaged');
      input.setTouchMove(0, 0.5); assert.equal(input.current().sprint, false);
      clock.now += 200; input.setTouchMove(0, 1);
      frame = input.current(); assert.equal(frame.sprint, true); assert.equal(frame.dash, true);
      input.setTouchMove(0, 0.5); clock.now += 400; input.setTouchMove(0, 1);
      assert.equal(input.current().dash, false, 'A push later than 300 ms only sprints');
      input.toggle('aim'); assert.equal(input.current().sprint, false, 'Aiming keeps the player aimed instead of sprinting');
      input.toggle('aim');
      input.setSettings({ sprintMode: 'hold' }); assert.equal(input.current().sprint, false, 'Hold mode needs the sprint control');
    } finally { input.dispose(); }
  });
});

test('a toggled crouch releases when sprinting resumes, but only after the press itself was sent', () => {
  browserEnvironment(() => {
    const { input } = touchInput({ sprintMode: 'auto', crouchMode: 'toggle' });
    try {
      input.setTouchMove(0, 1);
      assert.equal(input.current().sprint, true);
      input.setAction('crouch', true);
      let frame = input.current(); assert.equal(frame.crouch, true, 'The slide press reaches the server');
      frame = input.current(); assert.equal(frame.crouch, true);
      frame = input.current(); assert.equal(frame.crouch, false, 'Running on releases the crouch toggle');
      input.setTouchMove(0, 0.2); input.setAction('crouch', false); input.setAction('crouch', true);
      assert.equal(input.current().crouch, true); assert.equal(input.current().crouch, true, 'Walking keeps the crouch');
    } finally { input.dispose(); }
  });
});

test('the wheel and Q swap weapons, 1 and 2 select them, and a swap ends a toggled aim', t => {
  const f = desktopEnvironment(t, { aimMode: 'toggle' });
  f.lock();
  f.mouse('mousedown', 2); f.mouse('mouseup', 2);
  assert.equal(f.input.current().aim, true);
  assert.equal(f.wheel(120), true, 'The page does not scroll while playing');
  let frame = f.input.current(); assert.equal(frame.slot, 2); assert.equal(frame.aim, false);
  f.clock.now += 20; f.wheel(40); assert.equal(f.input.current().slot, 2, 'One trackpad gesture swaps once');
  f.clock.now += 400; f.wheel(-120); assert.equal(f.input.current().slot, 1);
  f.key('KeyQ'); assert.equal(f.input.current().slot, 2); f.release('KeyQ');
  f.key('Digit1'); assert.equal(f.input.current().slot, 1);
  f.key('Digit2'); assert.equal(f.input.current().slot, 2);
  f.key('Digit3'); assert.equal(f.input.current().slot, 2);
});

test('V knifes, G cooks until release, C toggles crouch and Shift double-tap dashes on the keyboard', t => {
  const f = desktopEnvironment(t, { crouchMode: 'toggle', sprintMode: 'hold' });
  f.lock();
  f.key('KeyV'); f.release('KeyV');
  assert.equal(f.input.current().melee, true); assert.equal(f.input.current().melee, false);
  f.key('KeyG');
  assert.equal(f.input.current().grenade, true); assert.equal(f.input.current().grenade, true, 'Holding G keeps cooking');
  f.release('KeyG'); assert.equal(f.input.current().grenade, false, 'Releasing G throws');
  f.key('KeyG'); f.release('KeyG');
  assert.equal(f.input.current().grenade, true, 'A quick tap still cooks for one frame'); assert.equal(f.input.current().grenade, false);
  f.key('KeyC'); f.release('KeyC'); assert.equal(f.input.current().crouch, true); assert.equal(f.input.current().crouch, true);
  f.key('KeyC'); f.release('KeyC'); assert.equal(f.input.current().crouch, false);
  f.key('KeyW');
  f.key('ShiftLeft'); assert.equal(f.input.current().dash, false); f.release('ShiftLeft');
  f.clock.now += 120; f.key('ShiftLeft');
  const frame = f.input.current(); assert.equal(frame.sprint, true); assert.equal(frame.dash, true);
  f.release('ShiftLeft'); assert.equal(f.input.current().sprint, false);
});

test('4 uses the oldest reward; the mortar frees the cursor for the map, Escape cancels and a pick is sent once', t => {
  const f = desktopEnvironment(t);
  f.lock();
  f.input.setRewards(['recon', 'mortar']);
  f.key('Digit4');
  let frame = f.input.current(); assert.equal(frame.streak, 'recon'); assert.equal(frame.streakTarget, undefined);
  assert.equal(f.input.current().streak, null, 'A reward is a single rising edge');
  f.input.setRewards(['mortar']); f.release('Digit4'); f.key('Digit4');
  assert.equal(f.input.mortarTargeting, true); assert.equal(f.input.locked, false, 'The HUD map needs a free cursor');
  assert.equal(f.input.current().streak, null, 'Nothing is used until a spot is picked');
  f.key('Escape'); assert.equal(f.input.mortarTargeting, false);
  f.input.useStreak('mortar'); assert.equal(f.input.mortarTargeting, true);
  f.input.setStreakTarget({ x: NaN, z: 2 }); assert.equal(f.input.mortarTargeting, false, 'An invalid pick cancels');
  f.input.useStreak('mortar'); f.input.setStreakTarget({ x: 4, z: -7.5 });
  assert.equal(f.input.mortarTargeting, false);
  frame = f.input.current(); assert.equal(frame.streak, 'mortar'); assert.deepEqual(frame.streakTarget, { x: 4, z: -7.5 });
  frame = f.input.current(); assert.equal(frame.streak, null); assert.equal(frame.streakTarget, undefined);
  f.input.useStreak('mortar'); f.lock(); assert.equal(f.input.mortarTargeting, false, 'Returning to the game cancels the pick');
  f.input.useStreak('mortar'); f.input.setRewards([]); assert.equal(f.input.mortarTargeting, false, 'A used or lost reward cancels targeting');
});

test('view kicks move the view within the pitch limits; view time and blocked fire reach the frame', () => {
  browserEnvironment(() => {
    const input = new InputController();
    try {
      input.setView(0.5, 1.2);
      input.addViewKick(0.01, 0.5);
      assert.equal(input.pitch, PITCH_LIMIT); assert.ok(Math.abs(input.yaw - 0.51) < 1e-12);
      input.addViewKick(0, -10); assert.equal(input.pitch, -PITCH_LIMIT);
      input.addViewKick(NaN, 1); input.addViewKick(1, Infinity);
      assert.equal(input.pitch, -PITCH_LIMIT); assert.ok(Math.abs(input.yaw - 0.51) < 1e-12);
      input.setViewTime(123_456.7); assert.equal(input.current().viewTime, 123_457);
      input.setViewTime(NaN); assert.equal(input.current().viewTime, 123_457);
      input.setAction('fire', true); input.setFireBlocked(true);
      assert.equal(input.current().fire, false, 'A weapon lowered against a wall cannot fire');
      input.setFireBlocked(false); assert.equal(input.current().fire, true);
    } finally { input.dispose(); }
  });
});

test('touch is the shared coarse-pointer test, so a touch laptop driven by its trackpad keeps the desktop town', t => {
  // A touch screen with a fine main pointer: touch points, but `(pointer: coarse)` does not match.
  let coarse = false;
  const globals = {
    window: new EventTarget(), document: Object.assign(new EventTarget(), { hidden: false, pointerLockElement: null, hasFocus: () => true, exitPointerLock() {} }),
    matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' && coarse }), navigator: { maxTouchPoints: 10 },
  };
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value }); }
  const input = new InputController();
  t.after(() => {
    input.dispose();
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  });
  assert.equal(input.isTouch, false, 'The same answer as the render tier and the art warm-up');
  assert.equal(renderTier('auto', input.isTouch, true).textureTier, renderTier('auto', coarsePointer(), true).textureTier);
  coarse = true;
  assert.equal(input.isTouch, true, 'A phone or tablet');
  assert.equal(renderTier('auto', input.isTouch, true).textureTier, 'phone');
  coarse = false; input.setTouchMove(0, 1);
  assert.equal(input.isTouch, true, 'Using the on-screen controls counts as touch');
});

test('aiming applies the aim sensitivity and compensates the zoom', () => {
  browserEnvironment(() => {
    const input = new InputController(undefined, { adsSensitivity: 0.5 });
    try {
      input.setTouchLook(100, 0); const hip = input.yaw;
      input.setView(0, 0); input.setAimZoom(2, true); input.setTouchLook(100, 0);
      assert.ok(Math.abs(input.yaw - hip * 0.25) < 1e-12);
      input.setView(0, 0); input.setAimZoom(Number.NaN, false); input.setTouchLook(100, 0);
      assert.ok(Math.abs(input.yaw - hip) < 1e-12);
    } finally { input.dispose(); }
  });
});
