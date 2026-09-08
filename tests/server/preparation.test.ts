import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine, idleInput } from '../../server/engine.js';
import { PRACTICE_RIVALS } from '../../server/bots.js';
import { RULES, type GameEvent } from '../../shared/protocol.js';
import { fixture } from '../acceptance/helpers.js';

function engineFixture(practice = false) {
  const events: GameEvent[] = [], finishes: string[] = [];
  const engine = new MatchEngine({ practice, practiceSeed: 'preparation', onEvent: event => events.push(event), onFinish: reason => finishes.push(reason) });
  const host = engine.addPlayer({ id: 'host', name: 'Host', color: '#fff' }, 0);
  if (practice) for (const rival of PRACTICE_RIVALS) engine.addPlayer(rival, 0, true);
  else engine.addPlayer({ id: 'friend', name: 'Friend', color: '#fff' }, 0);
  return { engine, host, events, finishes };
}

test('preparation resets the visible round and freezes full match time, human actions and all three bots', () => {
  for (const practice of [false, true]) {
    const { engine, host, events, finishes } = engineFixture(practice);
    Object.assign(host, { kills: 7, deaths: 4, health: 15, shield: 0, ammoAR: 2, ammoShotgun: 0, heals: 0, slot: 3, healingUntil: 99_000, reloadingUntil: 99_000, vx: 6, vy: 2 });
    engine.prepare(1000);
    const before = engine.snapshot(1000);
    assert.equal(before.roundId, engine.id);
    assert.equal(before.phase, 'preparing'); assert.equal(before.timeRemaining, RULES.matchSeconds);
    for (const p of before.players) {
      assert.equal(p.health, 100); assert.equal(p.shield, 50); assert.equal(p.ammoAR, 30); assert.equal(p.ammoShotgun, 6);
      assert.equal(p.heals, 2); assert.equal(p.slot, 1); assert.equal(p.kills, 0); assert.equal(p.deaths, 0);
      assert.equal(p.healingUntil, 0); assert.equal(p.reloadingUntil, 0); assert.equal(p.protectedUntil, 0);
    }
    for (let now = 1033; now < 46_000; now += 33) {
      assert.equal(engine.acceptInput(host.id, { ...idleInput(now), moveX: 1, jump: true, fire: true, reload: true, sprint: true, aim: true }, now), false);
      engine.step(now, 1 / 30);
    }
    const after = engine.snapshot(46_000);
    assert.deepEqual(after.players, before.players); assert.equal(after.timeRemaining, RULES.matchSeconds);
    assert.equal(engine.startedAt, 0); assert.equal(engine.countdownUntil, 0); assert.equal(engine.endedAt, 0);
    assert.deepEqual(events, []); assert.deepEqual(finishes, []);
  }
});

test('prepared countdown starts with a fresh full duration, preserved positions and protection; pre-round input cannot leak', () => {
  const { engine, host, events } = engineFixture(); engine.prepare(1000);
  const roundId = engine.snapshot().roundId;
  const positions = engine.snapshot().players.map(({ id, x, y, z }) => ({ id, x, y, z }));
  engine.step(20_000, 1 / 30); engine.beginPreparedCountdown(20_000);
  assert.equal(engine.snapshot(20_000).timeRemaining, 3);
  assert.equal(engine.countdownUntil, 23_000);
  assert.equal(engine.snapshot().roundId, roundId);
  assert.deepEqual(engine.snapshot().players.map(({ id, x, y, z }) => ({ id, x, y, z })), positions);
  assert.ok([...engine.players.values()].every(player => player.protectedUntil === 25_000));
  assert.equal(engine.acceptInput(host.id, { ...idleInput(1), fire: true, jump: true, moveZ: 1 }, 22_999), false);
  engine.step(22_999, 1 / 30); assert.equal(engine.phase, 'countdown'); assert.equal(engine.startedAt, 0);
  engine.step(23_000, 1 / 30); assert.equal(engine.phase, 'playing'); assert.equal(engine.startedAt, 23_000);
  assert.equal(engine.snapshot(23_000).timeRemaining, 300); assert.equal(host.ammoAR, 30); assert.equal(host.y, 0);
  assert.deepEqual(events, []);
  assert.equal(engine.acceptInput(host.id, { ...idleInput(1), fire: true }, 23_001), true);
  engine.step(23_001, 0); assert.equal(host.ammoAR, 29);
});

test('cancel and retry create a fresh score-neutral round without finish callbacks, and direct start retains its API', () => {
  const { engine, finishes } = engineFixture(); engine.prepare(1000); const oldId = engine.id;
  engine.cancelPreparation(); assert.equal(engine.phase, 'waiting'); assert.equal(engine.snapshot().timeRemaining, 300);
  assert.equal(engine.endedAt, 0); assert.deepEqual(engine.winnerIds, []); assert.deepEqual(finishes, []);
  assert.throws(() => engine.beginPreparedCountdown(2000));
  engine.prepare(3000); assert.notEqual(engine.id, oldId);
  engine.cancelPreparation(); engine.start(5000); assert.equal(engine.phase, 'countdown'); assert.equal(engine.countdownUntil, 8000);
  engine.cancelPreparation(); assert.equal(engine.phase, 'countdown', 'A stale cancel cannot stop an accepted countdown.');
});

test('45-second preparation timeout returns to lobby without rankings, rejects old acknowledgment and permits retry', async t => {
  const originalNow = Date.now; let offset = 0; Date.now = () => originalNow() + offset;
  t.after(() => { Date.now = originalNow; });
  const f = await fixture(t); const a = await f.profile('Patient host'), b = await f.profile('Slow loader');
  const crew = (await (await f.request('/api/crews', { token: a.token, body: { name: 'Preparation privacy' } })).json()).crew;
  await f.request('/api/crews/join', { token: b.token, body: { invite: crew.invite } });
  const host = await f.connect(a.token), guest = await f.connect(b.token);
  const created = await host.command({ type: 'create', ranked: true, crewId: crew.id }, 'room');
  await guest.command({ type: 'join', code: created.room.code }, 'room');
  const preparing = await host.command({ type: 'start' }, 'room', message => message.room.phase === 'preparing');
  const old = preparing.room.preparation!;
  await host.command({ type: 'ready', preparationId: old.id, ready: true }, 'room', message => message.room.players.some(player => player.id === a.profile.id && player.ready));
  const mark = host.mark(); offset += 45_001;
  const timeout = await host.wait('error', message => message.code === 'PREPARATION_TIMEOUT', mark);
  const lobby = await host.wait('room', message => message.room.phase === 'waiting', mark);
  assert.equal(lobby.room.preparation, undefined); assert.ok(lobby.room.players.every(player => player.ready === undefined));
  const returned = await host.wait('snapshot', message => message.snapshot.phase === 'waiting', mark);
  await host.wait('snapshot', message => message.snapshot.tick >= returned.snapshot.tick + 2, mark);
  assert.ok(host.messages.lastIndexOf(timeout) > host.messages.findLastIndex(message => message.type === 'room'), 'The timeout reason must follow the final lobby update, including the next tick, because clients clear old errors on room transitions.');
  assert.equal(host.messages.some(message => message.type === 'event' && message.event.type === 'match-end'), false);
  const stale = await guest.command({ type: 'ready', preparationId: old.id, ready: true }, 'error', message => message.code === 'PREPARATION_STALE'); assert.equal(stale.code, 'PREPARATION_STALE');
  const retry = await host.command({ type: 'start' }, 'room', message => message.room.phase === 'preparing');
  assert.notEqual(retry.room.preparation!.id, old.id); assert.ok(retry.room.preparation!.expiresAt > old.expiresAt);
  const round = retry.room.preparation!.id;
  const freshWorld = await host.wait('snapshot', message => message.snapshot.phase === 'preparing' && message.snapshot.roundId === round);
  assert.notEqual(freshWorld.snapshot.roundId, old.id);
  const premature = await host.command({ type: 'ready', preparationId: old.id, ready: true }, 'error'); assert.equal(premature.code, 'PREPARATION_STALE');
  await host.command({ type: 'ready', preparationId: round, ready: true }, 'room', message => message.room.players.some(player => player.id === a.profile.id && player.ready));
  await guest.command({ type: 'ready', preparationId: round, ready: true }, 'room', message => message.room.phase === 'countdown');
  const countdown = await host.wait('snapshot', message => message.snapshot.phase === 'countdown', mark);
  assert.equal(countdown.snapshot.roundId, round);
  assert.ok(countdown.snapshot.timeRemaining > 2.8);
  const board = await (await f.request(`/api/leaderboard?crewId=${crew.id}&period=all`, { token: a.token })).json();
  assert.deepEqual(board.history, []); assert.ok(board.entries.every((entry: { matches: number }) => entry.matches === 0));
});
