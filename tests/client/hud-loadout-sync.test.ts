import test from 'node:test';
import assert from 'node:assert/strict';
import type { Loadout } from '../../shared/protocol.js';
import { LOADOUT_PRESETS } from '../../shared/weapons.js';
import { LoadoutSync } from '../../src/components/loadoutSync.js';

const { assault, close, marksman } = LOADOUT_PRESETS;
const custom: Loadout = { ...close, perks: ['deep-pockets', 'low-profile', 'second-wind'] };
const name = (loadout: Loadout) => loadout === assault ? 'assault' : loadout === close ? 'close' : loadout === marksman ? 'marksman' : loadout === custom ? 'custom' : JSON.stringify(loadout);

/** A LoadoutSync on a fake clock; `advance` runs due timers in order. */
function harness() {
  let now = 1_000, nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const sent: Array<{ at: number; loadout: string }> = [];
  const sync = new LoadoutSync(loadout => sent.push({ at: now, loadout: name(loadout) }), {
    now: () => now,
    setTimer: (run, ms) => { const id = nextId++; timers.set(id, { at: now + ms, run }); return id; },
    clearTimer: id => { timers.delete(id as number); },
  });
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].at; due[1].run();
    }
    now = end;
  };
  return { sync, sent, advance, timers, names: () => sent.map(item => item.loadout) };
}

test('flicking through classes sends only the one the player settles on', () => {
  const { sync, advance, names } = harness();
  sync.sendNow(assault);
  for (const loadout of [close, marksman, custom, close]) { sync.change(loadout); advance(120); }
  assert.deepEqual(names(), ['assault'], 'nothing goes out while the player is still choosing');
  advance(400);
  assert.deepEqual(names(), ['assault', 'close']);
  sync.change(marksman); sync.change(close); advance(1000);
  assert.deepEqual(names(), ['assault', 'close'], 'changing back to what the server has sends nothing');
});

test('busy pickers stay inside the server allowance and the last choice always arrives', () => {
  const { sync, sent, advance, names } = harness();
  sync.sendNow(assault);
  const choices = [close, marksman, custom, assault];
  // A change every 350 ms for 20 seconds: just slower than the debounce, so each one settles.
  for (let i = 0; i < 57; i++) { sync.change(choices[i % choices.length]!); advance(350); }
  advance(2000);
  for (const first of sent) {
    const inWindow = sent.filter(item => item.at >= first.at && item.at < first.at + 10_000).length;
    assert.ok(inWindow <= 17, `${inWindow} loadout messages in 10 s (the server allows 20)`);
  }
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i]!.at - sent[i - 1]!.at >= 600, 'settled sends are spaced out');
  assert.equal(names().at(-1), name(choices[56 % choices.length]!), 'the final choice is what the server keeps');
});

test('closing the picker sends a waiting change at once, and only once', () => {
  const { sync, advance, names, timers } = harness();
  sync.sendNow(assault);
  sync.change(marksman);
  sync.flush();
  assert.deepEqual(names(), ['assault', 'marksman']);
  assert.equal(timers.size, 0);
  sync.flush(); advance(2000);
  assert.deepEqual(names(), ['assault', 'marksman'], 'nothing waiting, nothing sent');
  sync.change(marksman); sync.flush();
  assert.deepEqual(names(), ['assault', 'marksman'], 'an unchanged choice is not sent again');
});

test('joining or reconnecting always sends the current choice; a dropped connection forgets the wait', () => {
  const { sync, advance, names, timers } = harness();
  sync.sendNow(close); sync.sendNow(close);
  assert.deepEqual(names(), ['close', 'close'], 'a new room or a restarted server needs the choice again');
  sync.change(custom); sync.cancel(); advance(5000);
  assert.deepEqual(names(), ['close', 'close']);
  sync.change(custom); sync.sendNow(custom); advance(5000);
  assert.deepEqual(names(), ['close', 'close', 'custom'], 'sending now replaces the waiting change');
  sync.change(marksman); sync.dispose();
  assert.equal(timers.size, 0); advance(5000);
  assert.equal(names().length, 3);
});

test('the real timers send after the player settles', async () => {
  const sent: Loadout[] = [];
  const sync = new LoadoutSync(loadout => sent.push(loadout), { delayMs: 20, spacingMs: 0 });
  sync.change(close); sync.change(marksman);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(sent, [marksman]);
  sync.dispose();
});
