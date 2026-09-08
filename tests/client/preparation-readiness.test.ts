import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PreparationReadiness, type PreparationContext, type ReadinessState } from '../../src/game/PreparationReadiness.js';

function fixture() {
  const context: PreparationContext = { roomId: 'room', phase: 'preparing', preparationId: 'round-one', connected: true, assetsReady: true, blocked: false };
  const sent: { preparationId: string; ready: boolean }[] = [];
  const resets = new Set<() => void>();
  let captures = 0;
  const pending: ((success: boolean) => void)[] = [];
  const changes: ReadinessState[] = [];
  const input = {
    canEngage: true, locked: false,
    requestPointerLock: () => { captures++; return new Promise<boolean>(resolve => pending.push(resolve)); },
    subscribeReset: (listener: () => void) => { resets.add(listener); return () => { resets.delete(listener); }; },
  };
  const readiness = new PreparationReadiness(input, () => context, (preparationId, ready) => sent.push({ preparationId, ready }), value => changes.push(value));
  return { context, sent, input, changes, readiness, captures: () => captures, reset: () => { for (const listener of resets) listener(); },
    capture: (success: boolean) => { input.locked = success; pending.shift()?.(success); }, subscriptions: () => resets.size };
}

test('download/parse completion cannot acknowledge readiness without a deliberate gesture', async () => {
  const f = fixture();
  f.context.assetsReady = false; f.readiness.sync();
  await f.readiness.engage(false);
  assert.equal(f.captures(), 0); assert.deepEqual(f.sent, []);
  f.context.assetsReady = true; f.readiness.sync();
  assert.deepEqual(f.sent, []);
  const engagement = f.readiness.engage(false);
  assert.equal(f.captures(), 1); assert.deepEqual(f.sent, []);
  f.capture(true); await engagement;
  assert.deepEqual(f.sent, [{ preparationId: 'round-one', ready: true }]);
  f.readiness.dispose();
});

test('desktop failed capture is retryable and duplicate clicks do not queue acknowledgements', async () => {
  const f = fixture();
  const first = f.readiness.engage(false); await f.readiness.engage(false);
  assert.equal(f.captures(), 1);
  f.capture(false); await first;
  assert.deepEqual(f.sent, []); assert.match(f.changes.at(-1)!.error, /Mouse capture/);
  const second = f.readiness.engage(false); f.capture(true); await second;
  await f.readiness.engage(false);
  assert.equal(f.captures(), 2); assert.equal(f.sent.length, 1);
  f.readiness.dispose();
});

test('touch readiness uses its deliberate button without mouse capture or synthetic gameplay actions', async () => {
  const f = fixture();
  await f.readiness.engage(true);
  assert.equal(f.captures(), 0);
  assert.deepEqual(f.sent, [{ preparationId: 'round-one', ready: true }]);
  // The input dependency has no movement/action setter: engagement cannot use one.
  f.input.canEngage = false; f.reset();
  assert.deepEqual(f.sent.at(-1), { preparationId: 'round-one', ready: false });
  f.input.canEngage = true; f.readiness.sync();
  assert.equal(f.sent.length, 2);
  await f.readiness.engage(true); assert.equal(f.sent.length, 3);
  f.readiness.dispose();
});

test('late capture from a prior preparation cannot acknowledge the rematch', async () => {
  const f = fixture();
  const first = f.readiness.engage(false);
  f.context.phase = 'waiting'; f.readiness.sync();
  f.context.phase = 'preparing'; f.context.preparationId = 'round-two'; f.readiness.sync();
  f.capture(true); await first;
  assert.deepEqual(f.sent, []);
  await f.readiness.engage(true);
  assert.deepEqual(f.sent, [{ preparationId: 'round-two', ready: true }]);
  f.readiness.dispose();
});

test('same-nonce reconnection cancels a pending capture and requires a fresh gesture', async () => {
  const f = fixture(); const pending = f.readiness.engage(false);
  f.context.connected = false; f.readiness.sync();
  f.context.connected = true; f.readiness.sync();
  f.capture(true); await pending;
  assert.deepEqual(f.sent, []);
  await f.readiness.engage(true); assert.equal(f.sent.length, 1);
  f.context.connected = false; f.readiness.sync();
  f.context.connected = true; f.readiness.sync();
  assert.equal(f.sent.length, 1, 'A disconnected transport cannot send a withdrawal or restore readiness by itself.');
  await f.readiness.engage(true); assert.equal(f.sent.length, 2);
  f.readiness.dispose();
});

test('pause/settings/graphics failure withdraw only the current preparation and clear pending capture', async () => {
  for (const reason of ['menu', 'graphics', 'focus'] as const) {
    const f = fixture(); await f.readiness.engage(true);
    if (reason === 'menu') f.context.blocked = true;
    if (reason === 'graphics') f.context.assetsReady = false;
    if (reason === 'focus') f.input.canEngage = false;
    f.readiness.sync(); f.reset(); f.readiness.sync();
    assert.deepEqual(f.sent, [{ preparationId: 'round-one', ready: true }, { preparationId: 'round-one', ready: false }]);
    await f.readiness.engage(true); assert.equal(f.sent.length, 2);
    f.readiness.dispose();
  }
});

test('countdown lock loss does not send stale ready messages or reset the match', async () => {
  const f = fixture(); await f.readiness.engage(true);
  f.context.phase = 'countdown'; f.context.preparationId = undefined; f.readiness.sync();
  f.input.locked = false; f.reset(); await f.readiness.engage(false);
  assert.equal(f.captures(), 0);
  assert.deepEqual(f.sent, [{ preparationId: 'round-one', ready: true }]);
  f.context.phase = 'finished'; f.readiness.sync();
  f.context.phase = 'preparing'; f.context.preparationId = 'round-two'; f.readiness.sync();
  assert.equal(f.sent.length, 1);
  await f.readiness.engage(true); assert.deepEqual(f.sent.at(-1), { preparationId: 'round-two', ready: true });
  f.readiness.dispose();
});

test('disposing readiness detaches resets and ignores late asynchronous capture results', async () => {
  const f = fixture(); const pending = f.readiness.engage(false);
  const changes = f.changes.length;
  f.readiness.dispose(); f.capture(true); f.reset(); await pending;
  assert.equal(f.subscriptions(), 0); assert.equal(f.changes.length, changes); assert.deepEqual(f.sent, []);
  await f.readiness.engage(true); assert.deepEqual(f.sent, []);
});
