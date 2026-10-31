import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, startReady, type Peer } from './helpers.js';
import { RULES, type RoomSnapshot } from '../../shared/protocol.js';

/** Ann, Ben and Cal in a team match without bots: two on one side, one alone on the other. */
async function teamOfThree(t: TestContext) {
  const originalNow = Date.now; const clock = { offset: 0 }; Date.now = () => originalNow() + clock.offset;
  t.after(() => { Date.now = originalNow; });
  const f = await fixture(t);
  const identities = await Promise.all(['Ann', 'Ben', 'Cal'].map(name => f.profile(name)));
  const peers = await Promise.all(identities.map(identity => f.connect(identity.token)));
  const created = await peers[0]!.command({ type: 'create', ranked: false, mode: 'tdm' }, 'room');
  assert.equal(created.room.fillBots, false);
  for (const peer of peers.slice(1)) await peer.command({ type: 'join', code: created.room.code }, 'room');
  const split = (room: RoomSnapshot) => {
    const alone = (['teal', 'gold'] as const).map(side => room.players.filter(p => p.team === side)).find(side => side.length === 1)![0]!;
    const index = identities.findIndex(identity => identity.profile.id === alone.id);
    return { lone: peers[index]!, watcher: peers[(index + 1) % peers.length]!, others: peers.filter((_, i) => i !== index) };
  };
  return { f, peers, clock, split };
}
async function play(peers: Peer[], clock: { offset: number }) {
  const countdown = await startReady(peers[0]!, peers);
  clock.offset += RULES.countdownMs + 20;
  await peers[0]!.wait('snapshot', message => message.snapshot.phase === 'playing');
  return countdown.room;
}

test('a team match ends when the only player on one side leaves mid-round', async t => {
  const { peers, clock, split } = await teamOfThree(t);
  const { lone, watcher } = split(await play(peers, clock));
  const mark = watcher.mark(); lone.send({ type: 'leave' });
  const ended = await watcher.wait('event', message => message.event.type === 'match-end', mark);
  assert.equal(ended.event.type, 'match-end'); if (ended.event.type !== 'match-end') return;
  assert.match(ended.event.reason, /a player left/); assert.deepEqual(ended.event.winnerIds, []);
});

test('a team match ends when the only player on one side stays away past the reconnect grace', async t => {
  const { peers, clock, split } = await teamOfThree(t);
  const { lone, watcher } = split(await play(peers, clock));
  const dropMark = watcher.mark(); lone.close();
  await watcher.wait('room', message => message.room.players.some(player => !player.connected), dropMark);
  const mark = watcher.mark(); clock.offset += 30_000 + 100;
  const ended = await watcher.wait('event', message => message.event.type === 'match-end', mark);
  assert.equal(ended.event.type, 'match-end'); if (ended.event.type !== 'match-end') return;
  assert.match(ended.event.reason, /disconnected/);
});

test('team preparation is cancelled when one side empties, even with everyone else ready', async t => {
  const { peers, split } = await teamOfThree(t);
  const preparing = await peers[0]!.command({ type: 'start' }, 'room', message => message.room.phase === 'preparing');
  const { lone, watcher, others } = split(preparing.room), id = preparing.room.preparation!.id;
  const readyMark = watcher.mark();
  for (const peer of others) peer.send({ type: 'ready', preparationId: id, ready: true });
  await watcher.wait('room', message => message.room.players.filter(player => player.ready).length === others.length, readyMark);
  const mark = watcher.mark(); lone.send({ type: 'leave' });
  const cancelled = await watcher.wait('error', message => message.code === 'PREPARATION_CANCELLED', mark);
  assert.match(cancelled.message, /left before the match was ready/);
  const lobby = await watcher.wait('room', message => message.room.phase === 'waiting', mark);
  assert.equal(lobby.room.players.length, 2);
  assert.equal(watcher.messages.slice(mark).some(message => message.type === 'room' && message.room.phase === 'countdown'), false, 'The round never starts one-sided.');
});
