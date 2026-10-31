import test from 'node:test';
import assert from 'node:assert/strict';
import type { StreakId } from '../../shared/protocol.js';
import { InputController } from '../../src/game/InputController.js';
import { LATCHES, decodeButtonState, encodeButtonState, latchHandlers, latchMode, releaseLatches, tapHandlers, touchButtonSpecs, touchButtonState, type ButtonSpec, type TouchButtonInput, type TouchButtonState } from '../../src/components/hud/touchButtons.js';
import { touchLayout } from '../../src/components/hud/touchLayout.js';

/** Records what the buttons ask of the controller, in order. */
function fakeInput() {
  const latched: Record<'aim' | 'crouch' | 'sprint', boolean> = { aim: false, crouch: false, sprint: false };
  const input = {
    calls: [] as string[], acceptsInput: true as boolean,
    setAction(action: string, value: boolean) { input.calls.push(`${action}:${value ? 'down' : 'up'}`); },
    cancelAction(action: string) { input.calls.push(`${action}:cancel`); },
    toggle(action: 'aim' | 'crouch' | 'sprint') { latched[action] = !latched[action]; input.calls.push(`${action}:toggle`); return latched[action]; },
    swapWeapon() { input.calls.push('swap'); },
    useStreak(reward: StreakId) { input.calls.push(`use:${reward}`); },
  } satisfies TouchButtonInput & { calls: string[] };
  return input;
}
/** A finger touching a button; any finger, not just the first, since the stick and Fire may be held. */
function finger(pointerId = 1, button = 0) {
  const event = {
    button, pointerId, prevented: 0, captured: -1,
    preventDefault() { event.prevented++; },
    currentTarget: { setPointerCapture(id: number) { event.captured = id; } },
  };
  return event;
}
const keyboardClick = { detail: 0 }, delayedClick = { detail: 1 };
const IDLE: TouchButtonState = { aim: false, crouch: false, sprint: false, motion: '' };

test('toggle Aim and Crouch flip once per tap; the browser\'s late click and lifts change nothing', () => {
  for (const action of ['aim', 'crouch', 'sprint'] as const) {
    const input = fakeInput(); let redraws = 0;
    const button = latchHandlers(input, action, 'toggle', () => redraws++);
    const tap = finger(4);
    button.onPointerDown(tap); button.onPointerUp?.(); button.onLostPointerCapture?.(); button.onClick(delayedClick);
    assert.deepEqual(input.calls, [`${action}:toggle`], `${action}: one toggle per tap`);
    assert.equal(tap.prevented, 1); assert.equal(tap.captured, -1, 'a toggle does not hold on to the finger');
    assert.equal(redraws, 1, 'the button redraws at once');
    button.onPointerDown(finger(5)); button.onPointerCancel?.();
    assert.deepEqual(input.calls, [`${action}:toggle`, `${action}:toggle`], 'a cancelled touch after a toggle leaves it as it is');
    button.onClick(keyboardClick);
    assert.equal(input.calls.length, 3, 'keyboard and switch access still toggle');
    const right = finger(6, 2);
    button.onPointerDown(right);
    assert.equal(input.calls.length, 3, 'right click is ignored'); assert.equal(right.prevented, 0);
  }
});

test('hold mode presses on contact, releases on lift and cancels a cancelled touch', () => {
  for (const action of LATCHES) {
    const input = fakeInput();
    const button = latchHandlers(input, action, 'hold');
    const press = finger(9);
    button.onPointerDown(press);
    assert.deepEqual(input.calls, [`${action}:down`]); assert.equal(press.captured, 9, 'the finger is captured so the lift reaches the button');
    button.onPointerUp?.(); button.onLostPointerCapture?.();
    assert.deepEqual(input.calls.slice(0, 2), [`${action}:down`, `${action}:up`]);
    assert.ok(!input.calls.some(call => call.endsWith(':cancel')));
    input.calls.length = 0;
    button.onPointerDown(finger(10)); button.onPointerCancel?.();
    assert.deepEqual(input.calls, [`${action}:down`, `${action}:cancel`]);
    input.calls.length = 0;
    button.onClick(keyboardClick); button.onClick(delayedClick);
    assert.deepEqual(input.calls, [], 'a click cannot be held');
    const capture = { ...finger(11), currentTarget: { setPointerCapture() { throw new Error('gone'); } } };
    assert.doesNotThrow(() => button.onPointerDown(capture));
    assert.deepEqual(input.calls, [`${action}:down`], 'a failed capture still presses');
  }
  assert.equal(latchMode('aim', { aimMode: 'hold', crouchMode: 'toggle', sprintMode: 'auto' }), 'hold');
  assert.equal(latchMode('crouch', { aimMode: 'hold', crouchMode: 'toggle', sprintMode: 'auto' }), 'toggle');
  assert.equal(latchMode('sprint', { aimMode: 'hold', crouchMode: 'toggle', sprintMode: 'toggle' }), 'toggle');
  assert.equal(latchMode('sprint', { aimMode: 'hold', crouchMode: 'toggle', sprintMode: 'hold' }), 'hold');
});

test('Swap and reward buttons act on contact while other fingers are down, once per tap', () => {
  const input = fakeInput();
  const swap = tapHandlers(input, () => input.swapWeapon());
  // A second finger taps Swap while the first holds the stick and another holds Fire.
  const tap = finger(3);
  swap.onPointerDown(tap); swap.onClick(delayedClick);
  assert.deepEqual(input.calls, ['swap'], 'the late click must not swap straight back');
  assert.equal(tap.prevented, 1);
  swap.onClick(keyboardClick);
  assert.deepEqual(input.calls, ['swap', 'swap']);
  swap.onPointerDown(finger(4, 2));
  assert.equal(input.calls.length, 2, 'right click is ignored');
  const reward = tapHandlers(input, () => input.useStreak('drone'));
  reward.onPointerDown(finger(5));
  assert.deepEqual(input.calls.at(-1), 'use:drone');
  input.acceptsInput = false;
  const blocked = finger(6);
  swap.onPointerDown(blocked); reward.onPointerDown(finger(7)); swap.onClick(keyboardClick);
  assert.equal(input.calls.length, 3, 'nothing happens while the game is not taking input');
  assert.equal(blocked.prevented, 1, 'the browser still does not treat it as a click');
});

test('every button gets its gesture role or its handler', () => {
  const layout = touchLayout({ width: 844, height: 390, safe: { left: 47, right: 47, bottom: 21 }, sprintButton: true, rewards: 2 });
  const input = fakeInput();
  const specs = touchButtonSpecs({ input, settings: { aimMode: 'toggle', crouchMode: 'hold', sprintMode: 'toggle', firingMode: 'simple' }, layout, rewards: ['recon', 'mortar'], state: IDLE });
  const byId = (id: string) => specs.find(spec => spec.id === id) as ButtonSpec;
  assert.deepEqual(specs.filter(spec => spec.touch).map(spec => [spec.id, spec.touch]),
    [['fire', 'fire'], ['fire-left', 'fire-left'], ['jump', 'jump'], ['reload', 'reload'], ['grenade', 'grenade'], ['knife', 'melee']]);
  for (const spec of specs) {
    assert.ok(spec.rect, `${spec.id} has a place`);
    assert.notEqual(!!spec.touch, !!spec.handlers, `${spec.id}: either TouchGestures or its own handlers, never both`);
  }
  byId('aim').handlers!.onPointerDown(finger());
  byId('crouch').handlers!.onPointerDown(finger()); byId('crouch').handlers!.onPointerUp!();
  byId('sprint').handlers!.onPointerDown(finger());
  byId('swap').handlers!.onPointerDown(finger());
  for (const spec of specs.filter(item => item.id === 'reward')) spec.handlers!.onPointerDown(finger());
  assert.deepEqual(input.calls, ['aim:toggle', 'crouch:down', 'crouch:up', 'sprint:toggle', 'swap', 'use:recon', 'use:mortar']);
  assert.deepEqual(specs.filter(spec => spec.id === 'reward').map(spec => [spec.label, spec.ariaLabel]), [['Recon', 'Use Recon Sweep'], ['Mortar', 'Use Mortar Strike']]);
  assert.equal(byId('fire').ariaLabel, 'Fire');

  const automatic = touchButtonSpecs({ input, settings: { aimMode: 'toggle', crouchMode: 'toggle', sprintMode: 'auto', firingMode: 'advanced' }, layout: touchLayout({ width: 844, height: 390 }), rewards: [], state: { ...IDLE, motion: 'sprint' } });
  assert.equal(automatic.some(spec => spec.id === 'sprint'), false, 'automatic sprint uses the stick, not a button');
  assert.equal(automatic.find(spec => spec.id === 'crouch')?.label, 'Slide', 'Crouch reads Slide while sprinting');
  assert.equal(automatic.find(spec => spec.id === 'fire')?.ariaLabel, 'Fire. Hold and drag to aim.');
  assert.equal(automatic.filter(spec => spec.id === 'reward').length, 0);
});

test('taking the controls away releases aim, crouch and sprint', () => {
  const input = fakeInput();
  releaseLatches(input);
  assert.deepEqual(input.calls, ['aim:cancel', 'crouch:cancel', 'sprint:cancel']);
});

test('button highlights follow what the controller sends and what the game shows', () => {
  const stand = { posture: 'stand' as const, sprinting: false, dashing: false };
  assert.deepEqual(touchButtonState({ aim: true, crouch: false, sprint: false }, stand), { aim: true, crouch: false, sprint: false, motion: '' });
  assert.equal(touchButtonState({ aim: false, crouch: false, sprint: false }, stand).aim, false, 'aim dropped by the game goes dark');
  assert.equal(touchButtonState({ aim: false, crouch: false, sprint: false }, { ...stand, posture: 'slide' }).crouch, true, 'Crouch stays lit for the whole slide');
  assert.equal(touchButtonState({ aim: false, crouch: false, sprint: false }, { ...stand, posture: 'crouch' }).crouch, true, 'still crouched under a low roof');
  assert.equal(touchButtonState({ aim: false, crouch: true, sprint: false }, null).crouch, true);
  assert.deepEqual(touchButtonState(null, { ...stand, sprinting: true }), { aim: false, crouch: false, sprint: true, motion: 'sprint' });
  assert.equal(touchButtonState(null, { ...stand, sprinting: true, dashing: true }).motion, 'dash');
  assert.deepEqual(touchButtonState(null, null), IDLE);
  for (const aim of [false, true]) for (const crouch of [false, true]) for (const sprint of [false, true]) for (const motion of ['', 'sprint', 'dash'] as const) {
    const state = { aim, crouch, sprint, motion };
    assert.deepEqual(decodeButtonState(encodeButtonState(state)), state);
  }
});

// Runs once workstream C's InputController (toggle, swapWeapon, useStreak) is merged; skipped before.
const controllerV3 = typeof (InputController.prototype as { toggle?: unknown }).toggle === 'function';
test('with the real controller, tapped toggles light up and go dark when the game ends them', { skip: controllerV3 ? false : 'needs workstream C\'s InputController' }, () => {
  const saved = { window: Object.getOwnPropertyDescriptor(globalThis, 'window'), document: Object.getOwnPropertyDescriptor(globalThis, 'document') };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { matchMedia: () => ({ matches: true }) }) });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: Object.assign(new EventTarget(), { hidden: false, pointerLockElement: null, hasFocus: () => true, exitPointerLock() {} }) });
  // `as never`/`as unknown`: the pre-merge class in this worktree lacks the v3 settings and methods.
  const controller = new InputController(undefined, { aimMode: 'toggle', crouchMode: 'toggle', sprintMode: 'auto' } as never);
  const input = controller as unknown as TouchButtonInput;
  try {
    const aim = latchHandlers(input, 'aim', 'toggle'), crouch = latchHandlers(input, 'crouch', 'toggle');
    aim.onPointerDown(finger(1)); aim.onClick(delayedClick);
    assert.equal(touchButtonState(controller.peek(), null).aim, true, 'one tap aims, and the late click does not undo it');
    input.swapWeapon();
    assert.equal(touchButtonState(controller.peek(), null).aim, false, 'a weapon swap ends aiming, and the button goes dark');
    crouch.onPointerDown(finger(2));
    assert.equal(touchButtonState(controller.peek(), null).crouch, true);
    controller.setAction('jump', true);
    assert.equal(touchButtonState(controller.peek(), null).crouch, false, 'a jump stands up, and Crouch goes dark');
    controller.setAction('jump', false); controller.current();
    // Hold mode: lit while the finger is down, dark once the press has gone out after the lift.
    controller.setSettings({ crouchMode: 'hold' } as never);
    const held = latchHandlers(input, 'crouch', 'hold');
    held.onPointerDown(finger(4));
    assert.equal(touchButtonState(controller.peek(), null).crouch, true);
    held.onPointerUp?.(); controller.current();
    assert.equal(touchButtonState(controller.peek(), null).crouch, false);
  } finally {
    controller.dispose();
    for (const [key, previous] of Object.entries(saved)) if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key);
  }
});
