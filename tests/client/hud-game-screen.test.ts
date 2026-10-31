import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InputFrame } from '../../shared/protocol.js';
import { DEFAULT_LOADOUT } from '../../shared/weapons.js';
import { InputController } from '../../src/game/InputController.js';
import { LoadoutDialog } from '../../src/components/Loadout.js';
import { INPUT_HZ, InputPacer, MAX_FRAMES_PER_WAKE, RespawnWatch, holdTabForScores, sendInputFrames, type InputView } from '../../src/components/gameInput.js';

const FRAME_MS = 1000 / INPUT_HZ;
/** Frames on the 30 Hz grid from 0 up to `now`. */
const gridFrames = (now: number) => Math.floor(now / FRAME_MS + 1e-9) + 1;
/** Repeatable random numbers for timer lateness. */
function random(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }

test('a browser timer that runs every 33 ms still sends exactly 30 input frames a second', () => {
  // Browsers run setInterval(…, 1000 / 30) every 33 ms. One frame per call would be 30.3 a second, and the
  // server, which moves a player one 1/30 s step per frame, would keep pulling the predicted view back.
  const pacer = new InputPacer();
  let sent = 0, calls = 0, most = 0, last = 0;
  for (let now = 0; now <= 60_000; now += 33) { const due = pacer.take(now); sent += due; most = Math.max(most, due); calls++; last = now; }
  assert.equal(sent, gridFrames(last), 'every grid frame goes out once');
  assert.ok(Math.abs(sent - 60 * INPUT_HZ) <= 1, `${sent} frames in 60 s`);
  assert.ok(calls >= sent + 15, `the timer ran ${calls} times and the pacer skipped the spare wake-ups`);
  assert.equal(most, 1);
});

test('a late timer catches up at most two frames, and a stalled page skips what it missed', () => {
  const pacer = new InputPacer(), late = random(7);
  let now = 0, sent = 0, most = 0, last = 0;
  // A busy phone: the timer wakes up to 60 ms late, so sometimes two frames are due at once.
  for (let i = 0; i < 3000; i++) {
    const due = pacer.take(now); sent += due; most = Math.max(most, due); last = now;
    now += pacer.wait(now) + late() * 60;
  }
  assert.equal(most, MAX_FRAMES_PER_WAKE, 'late wake-ups catch up');
  assert.equal(sent, gridFrames(last), 'and no frame is lost or doubled, so the average stays 30 a second');
  // Half a second with no timer at all (a long frame, or a tab in the background): no burst afterwards.
  const stall = last + 500, missed = gridFrames(stall) - gridFrames(last), burst = pacer.take(stall);
  assert.ok(missed >= 14 && burst >= 1 && burst <= MAX_FRAMES_PER_WAKE, `${burst} of ${missed} missed frames go out`);
  const resume = stall + pacer.wait(stall);
  assert.equal(gridFrames(resume) - gridFrames(stall), 1, 'the grid keeps its place through the stall');
  assert.equal(pacer.take(resume), 1, 'then one frame per grid slot again');
});

test('an early wake-up sends nothing and says how long to wait', () => {
  const pacer = new InputPacer();
  assert.equal(pacer.wait(500), 0, 'a new pacer is due at once');
  assert.equal(pacer.take(1000), 1, 'the first call starts the grid with a frame');
  assert.equal(pacer.wait(1000), 34, 'rounded up, so the timer never wakes before the frame is due');
  assert.equal(pacer.take(1020), 0);
  assert.equal(pacer.wait(1020), 14);
  assert.equal(pacer.take(1034), 1);
});

class ViewDouble implements InputView {
  inputLive = true;
  prepared = 0;
  recorded: InputFrame[] = [];
  /** The touch trigger assist, on a target every other call. */
  prepareAutomaticFire() { this.prepared++; return this.prepared % 2 === 1; }
  recordInput(frame: InputFrame) { this.recorded.push(frame); }
}

test('each due frame is built once, sent once and recorded once for the prediction', () => {
  const view = new ViewDouble(), sent: InputFrame[] = [];
  let seq = 0;
  const next = () => ({ seq: ++seq }) as InputFrame;
  assert.equal(sendInputFrames(2, view, next, frame => sent.push(frame)), false, 'the assist state after the last frame');
  assert.deepEqual(sent.map(frame => frame.seq), [1, 2]);
  assert.deepEqual(view.recorded, sent, 'the prediction moves once per frame sent, in order');
  assert.equal(view.prepared, 2, 'the assist runs once per frame, so a semi-automatic pull alternates frame by frame');
  view.inputLive = false;
  sendInputFrames(1, view, next, frame => sent.push(frame));
  assert.equal(sent.length, 2, 'nothing goes out while the view is not live');
  assert.equal(seq, 2, 'and no frame is built');
  assert.equal(view.recorded.length, 2);
});

/** A focused, visible page for InputController. */
function withBrowser(t: TestContext) {
  const window = Object.assign(new EventTarget(), { matchMedia: () => ({ matches: false }) });
  const document = Object.assign(new EventTarget(), { hidden: false, hasFocus: () => true, pointerLockElement: null });
  for (const [key, value] of Object.entries({ window, document })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key));
  }
}

test('no frames go out while dead, so the new life starts facing the spawn direction with the primary', t => {
  withBrowser(t);
  const input = new InputController();
  t.after(() => input.dispose());
  const view = new ViewDouble(), sent: InputFrame[] = [];
  const tick = () => sendInputFrames(1, view, () => input.current(), frame => sent.push(frame));
  input.setView(2.5, 0.2); input.setSlot(2); tick();
  assert.deepEqual([sent[0]!.yaw, sent[0]!.slot], [2.5, 2]);
  // Eliminated: gameplay is blocked and the view is no longer live. Every frame would still carry the
  // death-time view and pistol, and the server would apply the first one that lands after the respawn.
  input.setGameplayBlocked(true); view.inputLive = false;
  for (let i = 0; i < 90; i++) tick();
  assert.equal(sent.length, 1, 'nothing is sent while waiting to respawn');
  // The first snapshot of the new life resets the view (GameView), and only then is input live again.
  input.setGameplayBlocked(false); input.resetSpawnView(Math.PI / 2); view.inputLive = true; tick();
  assert.deepEqual([sent[1]!.yaw, sent[1]!.pitch, sent[1]!.slot], [Math.PI / 2, 0, 1]);
  assert.equal(sent[1]!.seq, sent[0]!.seq + 1, 'the sequence carries on');
});

const key = (type: 'keydown' | 'keyup', code: string) => Object.assign(new Event(type, { cancelable: true }), { code });

test('Tab shows the standings while held, and focus leaving mid-press closes them', () => {
  const win = new EventTarget(), doc = new EventTarget();
  let open = false;
  const stop = holdTabForScores(win, doc, () => false, value => { open = value; });
  const press = key('keydown', 'Tab'); win.dispatchEvent(press);
  assert.equal(open, true); assert.equal(press.defaultPrevented, true, 'the browser does not move focus during play');
  win.dispatchEvent(key('keyup', 'Tab')); assert.equal(open, false);
  // Once another window has focus (a screenshot tool, a pop-up), the key-up never arrives.
  win.dispatchEvent(key('keydown', 'Tab')); win.dispatchEvent(new Event('blur'));
  assert.equal(open, false, 'leaving the window closes them');
  win.dispatchEvent(key('keydown', 'Tab')); doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(open, false, 'switching apps closes them');
  const other = key('keydown', 'KeyW'); win.dispatchEvent(other);
  assert.equal(other.defaultPrevented, false); assert.equal(open, false);
  stop(); win.dispatchEvent(key('keydown', 'Tab'));
  assert.equal(open, false, 'stopping removes the listeners');
});

test('with a menu open, Tab moves between its controls instead of opening the standings', () => {
  const win = new EventTarget(), doc = new EventTarget();
  let open = false, menu = true;
  holdTabForScores(win, doc, () => menu, value => { open = value; });
  const press = key('keydown', 'Tab'); win.dispatchEvent(press);
  assert.equal(press.defaultPrevented, false, 'the browser moves focus to the next control');
  assert.equal(open, false);
  menu = false;
  win.dispatchEvent(key('keydown', 'Tab'));
  assert.equal(open, true, 'back in play, Tab shows the standings again');
});

test('the screen notices the moment the player is back from a respawn, once', () => {
  const watch = new RespawnWatch();
  assert.equal(watch.respawned(100), false, 'alive at the start is not a respawn');
  assert.equal(watch.respawned(40), false);
  assert.equal(watch.respawned(0), false, 'eliminated');
  assert.equal(watch.respawned(undefined), false, 'no snapshot is not a respawn');
  assert.equal(watch.respawned(0), false);
  assert.equal(watch.respawned(100), true, 'back in');
  assert.equal(watch.respawned(100), false, 'only once');
});

test('a loadout picker opened while waiting to respawn shows the countdown', () => {
  const props = { value: { loadoutPreset: 'assault' as const, customLoadout: DEFAULT_LOADOUT }, onChange: () => {}, onClose: () => {}, inGame: true };
  const waiting = renderToStaticMarkup(createElement(LoadoutDialog, { ...props, respawn: { seconds: 2, closes: true } }));
  assert.match(waiting, /Back in <strong>2<\/strong>/);
  assert.match(waiting, /This closes when you spawn\./);
  const paused = renderToStaticMarkup(createElement(LoadoutDialog, { ...props, respawn: { seconds: 3, closes: false } }));
  assert.match(paused, /Back in <strong>3<\/strong>/);
  assert.doesNotMatch(paused, /closes when/, 'opened from the pause menu, it stays open with it');
  assert.doesNotMatch(renderToStaticMarkup(createElement(LoadoutDialog, props)), /Back in/, 'no timer while alive or in the lobby');
});
