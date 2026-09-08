import test from 'node:test';
import assert from 'node:assert/strict';
import type { PlayerState, WorldSnapshot } from '../../shared/protocol';
import { DeferredRespawns } from '../../src/game/DeferredRespawns';

const player = (id: string, overrides: Partial<PlayerState> = {}): PlayerState => ({
  id, name: id, color: '#ffffff', x: 17, y: 2, z: -11, yaw: .4, pitch: 0,
  vx: 0, vy: 0, vz: 0, health: 100, shield: 50, slot: 1,
  ammoAR: 30, ammoShotgun: 6, heals: 2, kills: 0, deaths: 1,
  connected: true, respawnAt: 0, protectedUntil: 12_000, healingUntil: 0,
  reloadingUntil: 0, lastInputSeq: 10, ...overrides,
});
const snapshot = (serverTime: number, players: PlayerState[], phase: WorldSnapshot['phase'] = 'playing'): WorldSnapshot => ({
  tick: 42, serverTime, phase, timeRemaining: 200, players, winnerIds: [],
});

test('respawn feedback waits for a fresh alive snapshot and uses its actual spawn exactly once', () => {
  const deferred = new DeferredRespawns(), delivered: PlayerState[] = [];
  deferred.enqueue('son', 10_000, 100);
  deferred.flush(snapshot(9_999, [player('son', { health: 0, x: -27 })]), 110, value => delivered.push(value));
  deferred.flush(snapshot(9_999, []), 120, value => delivered.push(value));
  assert.equal(delivered.length, 0, 'An event ahead of its snapshot cannot burst at a corpse or missing model');
  const fresh = player('son', { x: 24, y: 0, z: 8 });
  deferred.flush(snapshot(10_000, [fresh]), 130, value => delivered.push(value));
  assert.deepEqual(delivered, [fresh]);
  assert.equal(delivered[0], fresh, 'No cached render-player position is substituted');
  deferred.flush(snapshot(10_020, [fresh]), 140, value => delivered.push(value));
  deferred.enqueue('son', 10_000, 150);
  deferred.flush(snapshot(10_030, [fresh]), 160, value => delivered.push(value));
  assert.equal(delivered.length, 1, 'Repeated snapshots and duplicate event delivery cannot replay a respawn');
});

test('newer respawns replace older ones and duplicate events cannot extend the receive-clock deadline', () => {
  const deferred = new DeferredRespawns(), delivered: PlayerState[] = [];
  deferred.enqueue('son', 10_000, 100);
  deferred.enqueue('son', 11_000, 200);
  deferred.enqueue('son', 10_500, 300);
  deferred.flush(snapshot(10_999, [player('son')]), 400, value => delivered.push(value));
  assert.equal(delivered.length, 0, 'The older event cannot replace the new spawn');
  deferred.flush(snapshot(11_000, [player('son')]), 1_199, value => delivered.push(value));
  assert.equal(delivered.length, 1, 'A valid event just inside its 1,000 ms receive deadline remains deliverable');

  const expired = new DeferredRespawns();
  expired.enqueue('son', 12_000, 100);
  expired.enqueue('son', 12_000, 1_099);
  expired.flush(snapshot(12_000, [player('son')]), 1_100, () => assert.fail('A duplicate extended the deadline'));
  expired.flush(snapshot(12_500, [player('son')]), 1_101, () => assert.fail('Expired feedback reappeared'));
});

test('fresh missing, dead or disconnected states discard feedback instead of waiting for a later life', () => {
  for (const players of [[], [player('son', { health: 0 })], [player('son', { connected: false })]]) {
    const deferred = new DeferredRespawns();
    deferred.enqueue('son', 10_000, 0);
    deferred.flush(snapshot(10_000, players), 10, () => assert.fail('An unavailable player emitted feedback'));
    deferred.flush(snapshot(10_100, [player('son')]), 20, () => assert.fail('A consumed old respawn followed the player into a later life'));
  }
});

test('hidden-time backlog is bounded to eight newest player slots and clear/dispose prevent late effects', () => {
  const deferred = new DeferredRespawns(), players: PlayerState[] = [], delivered: string[] = [];
  for (let index = 0; index < 1_000; index++) {
    const id = `player-${index}`;
    deferred.enqueue(id, 10_000 + index, index / 10);
    players.push(player(id));
  }
  deferred.flush(snapshot(11_000, players), 150, value => delivered.push(value.id));
  assert.deepEqual(delivered, players.slice(-8).map(value => value.id));
  deferred.enqueue('late', 20_000, 200);
  deferred.flush(snapshot(20_000, [player('late')]), 5_000, () => assert.fail('A hidden interval replayed expired feedback'));
  deferred.enqueue('son', 21_000, 5_001); deferred.clear();
  deferred.flush(snapshot(21_000, [player('son')]), 5_002, () => assert.fail('Clear retained feedback'));
  deferred.enqueue('son', 22_000, 5_003); deferred.dispose(); deferred.dispose();
  deferred.enqueue('son', 23_000, 5_004);
  deferred.flush(snapshot(23_000, [player('son')]), 5_005, () => assert.fail('A disposed queue accepted work'));
});

test('round changes clear respawns and callbacks cannot recursively replay or resurrect cleared work', () => {
  for (const phase of ['waiting', 'countdown', 'finished'] as const) {
    const deferred = new DeferredRespawns();
    deferred.enqueue('son', 10_000, 100);
    deferred.flush(snapshot(9_999, [player('son')], phase), 101, () => assert.fail('Feedback emitted outside active play'));
    deferred.flush(snapshot(10_000, [player('son')]), 102, () => assert.fail('Prior-round feedback leaked into play'));
  }
  const deferred = new DeferredRespawns(), current = snapshot(10_000, [player('son'), player('dad')]);
  deferred.enqueue('son', 10_000, 100); deferred.enqueue('dad', 10_000, 100);
  let calls = 0;
  deferred.flush(current, 101, () => {
    calls++;
    deferred.clear();
    deferred.flush(current, 101, () => assert.fail('Cleared work reentered its callback'));
  });
  assert.equal(calls, 1, 'Clearing inside a callback also retires other snapshotted queue entries');
});

test('invalid receive clocks and snapshot clocks do not turn malformed events into visual feedback', () => {
  const deferred = new DeferredRespawns();
  for (const [id, at, now] of [['', 10_000, 0], ['a', NaN, 0], ['b', 10_000, Infinity]] as const) deferred.enqueue(id, at, now);
  deferred.flush(snapshot(10_000, [player(''), player('a'), player('b')]), 100, () => assert.fail('Malformed event was accepted'));
  deferred.enqueue('son', 10_000, 0);
  deferred.flush(snapshot(NaN, [player('son')]), 100, () => assert.fail('Non-finite snapshot time was treated as fresh'));
  deferred.flush(snapshot(10_000, [player('son')]), NaN, () => assert.fail('Non-finite receive time was treated as fresh'));
  let calls = 0;
  deferred.flush(snapshot(10_000, [player('son')]), 101, () => calls++);
  assert.equal(calls, 1);
});
