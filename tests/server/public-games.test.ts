import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, startReady } from '../acceptance/helpers.js';
import { type AvailableGame, type RoomSnapshot, RULES } from '../../shared/protocol.js';
import { MatchEngine } from '../../server/engine.js';
import { PRACTICE_RIVALS } from '../../server/bots.js';

const botCount = (room: RoomSnapshot) => room.players.filter(player => player.bot).length;

test('the public directory exposes only joinable opted-in lobbies, without private invitations or identities', async t => {
  const f = await fixture(t);
  const getGames = async () => {
    const response = await f.request('/api/games');
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    return (await response.json() as { games: AvailableGame[] }).games;
  };
  assert.deepEqual(await getGames(), [], 'Browsing needs no player identity.');
  const identities = await Promise.all(['Private', 'Ranked', 'Solo', 'Public', 'Guest'].map(name => f.profile(name)));
  const peers = await Promise.all(identities.map(identity => f.connect(identity.token)));
  const privateRoom = await peers[0]!.command({ type: 'create', ranked: false }, 'room');
  assert.equal(privateRoom.room.visibility, 'private'); assert.equal(botCount(privateRoom.room), 0, 'Legacy creates preserve human-only private defaults.');
  const crewResponse = await f.request('/api/crews', { token: identities[1]!.token, body: { name: 'Private standings' } });
  const { crew } = await crewResponse.json() as { crew: { id: string } };
  const rankedRoom = await peers[1]!.command({ type: 'create', ranked: true, crewId: crew.id }, 'room');
  const soloRoom = await peers[2]!.command({ type: 'create', ranked: false, practice: true }, 'room');
  const publicRoom = await peers[3]!.command({ type: 'create', ranked: false, visibility: 'public', fillBots: true, botDifficulty: 'easy' }, 'room');
  assert.deepEqual(await getGames(), [{ id: publicRoom.room.id, hostName: 'Public', humanCount: 1, botCount: 3, maxPlayers: 8, fillBots: true, botDifficulty: 'easy' }]);
  for (const room of [privateRoom, rankedRoom, soloRoom]) {
    await peers[4]!.command({ type: 'join-public', roomId: room.room.id }, 'error', message => message.code === 'PUBLIC_GAME_UNAVAILABLE');
  }
  const guestRoom = await peers[4]!.command({ type: 'join-public', roomId: publicRoom.room.id }, 'room');
  assert.equal(guestRoom.room.players.filter(player => !player.bot).length, 2); assert.equal(botCount(guestRoom.room), 2);
  await peers[3]!.command({ type: 'start' }, 'room', message => message.room.phase === 'preparing');
  assert.deepEqual(await getGames(), [], 'Preparing and active matches cannot accept new players.');
  const outsider = await f.request('/api/games', { origin: 'https://untrusted.invalid' }); assert.equal(outsider.status, 403);
});

test('public capacity replaces bots with humans, returns bots after lobby departures, and rejects stale joins without losing another room', async t => {
  const f = await fixture(t);
  const hostIdentity = await f.profile('Capacity host'), host = await f.connect(hostIdentity.token);
  const created = await host.command({ type: 'create', ranked: false, visibility: 'public', fillBots: true }, 'room');
  const guests = [];
  for (let index = 0; index < 7; index++) {
    const identity = await f.profile(`Guest ${index}`), guest = await f.connect(identity.token); guests.push(guest);
    const joined = await guest.command({ type: 'join-public', roomId: created.room.id }, 'room');
    assert.equal(botCount(joined.room), Math.max(0, 4 - (index + 2)));
    assert.equal(joined.room.players.length, Math.max(4, index + 2));
  }
  assert.deepEqual(await (await f.request('/api/games')).json(), { games: [] });
  const lateIdentity = await f.profile('Late arrival'), late = await f.connect(lateIdentity.token);
  const own = await late.command({ type: 'create', ranked: false, fillBots: true }, 'room');
  await late.command({ type: 'join-public', roomId: created.room.id }, 'error', message => message.code === 'PUBLIC_GAME_UNAVAILABLE');
  const preserved = await late.command({ type: 'join', code: own.room.code }, 'room'); assert.equal(preserved.room.id, own.room.id);
  for (let index = guests.length - 1; index >= 0; index--) {
    const mark = host.mark(); guests[index]!.send({ type: 'leave' });
    const room = await host.wait('room', message => message.room.players.filter(p => !p.bot).length === index + 1, mark);
    assert.equal(botCount(room.room), Math.max(0, 4 - (index + 1)));
  }
  const listed = await (await f.request('/api/games')).json() as { games: AvailableGame[] };
  assert.equal(listed.games[0]!.humanCount, 1); assert.equal(listed.games[0]!.botCount, 3);
  await startReady(host, [host]);
  await late.command({ type: 'join-public', roomId: created.room.id }, 'error', message => message.code === 'PUBLIC_GAME_UNAVAILABLE');
  assert.equal((await late.command({ type: 'join', code: own.room.code }, 'room')).room.id, own.room.id);
});

test('invalid public and bot settings cannot publish practice, enable ranked bots, or discard the current room', async t => {
  const f = await fixture(t), identity = await f.profile('Settings host'), host = await f.connect(identity.token);
  const created = await host.command({ type: 'create', ranked: false, fillBots: true }, 'room');
  for (const settings of [
    { visibility: 'unlisted' }, { visibility: null }, { fillBots: 'yes' }, { botDifficulty: 'impossible' },
    { visibility: 'public', practice: true }, { visibility: 'public', ranked: true }, { ranked: true, fillBots: true },
  ]) {
    const mark = host.mark(); host.socket.send(JSON.stringify({ type: 'create', ranked: false, ...settings }));
    await host.wait('error', () => true, mark);
    assert.equal((await host.command({ type: 'join', code: created.room.code }, 'room')).room.id, created.room.id);
  }
  assert.deepEqual(await (await f.request('/api/games')).json(), { games: [] });
  const fresh = await f.connect();
  await fresh.command({ type: 'join-public', roomId: created.room.id }, 'error', message => /Sign in/.test(message.message));
});

test('public-directory polling has its own rate limit and cannot exhaust profile and crew requests', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 180; index++) assert.equal((await f.request('/api/games')).status, 200);
  assert.equal((await f.request('/api/games')).status, 429);
  const identity = await f.profile('Can still join');
  assert.equal((await f.request('/api/crews', { token: identity.token })).status, 200);
});

test('bot-filled public matches wait for every human, survive a friend leaving, recover, finish unranked, and rematch', async t => {
  const originalNow = Date.now; let offset = 0; Date.now = () => originalNow() + offset;
  t.after(() => { Date.now = originalNow; });
  const f = await fixture(t), hostIdentity = await f.profile('Bot host'), guestIdentity = await f.profile('Bot friend');
  const host = await f.connect(hostIdentity.token), guest = await f.connect(guestIdentity.token);
  const created = await host.command({ type: 'create', ranked: false, visibility: 'public', fillBots: true, botDifficulty: 'hard' }, 'room');
  await guest.command({ type: 'join-public', roomId: created.room.id }, 'room');
  const preparing = await host.command({ type: 'start' }, 'room', message => message.room.phase === 'preparing');
  host.send({ type: 'ready', preparationId: preparing.room.preparation!.id, ready: true });
  await host.wait('room', message => message.room.phase === 'preparing' && message.room.players.find(p => p.id === hostIdentity.profile.id)!.ready === true);
  const mark = host.mark();
  guest.send({ type: 'ready', preparationId: preparing.room.preparation!.id, ready: true });
  await host.wait('room', message => message.room.phase === 'countdown', mark);
  offset += RULES.countdownMs + 20;
  await host.wait('snapshot', message => message.snapshot.phase === 'playing');
  const leaveMark = host.mark(); guest.send({ type: 'leave' });
  const alone = await host.wait('room', message => !message.room.players.find(p => p.id === guestIdentity.profile.id)!.connected, leaveMark);
  assert.equal(alone.room.phase, 'playing'); assert.equal(botCount(alone.room), 2, 'Roster does not change under rendered players during a live match.');
  await host.wait('snapshot', message => message.snapshot.players.some(p => p.bot && Math.hypot(p.vx, p.vz) > 1));
  const closed = new Promise<void>(resolve => host.socket.once('close', () => resolve())); host.close(); await closed;
  const recovered = await f.connect(hostIdentity.token);
  const restored = await recovered.wait('room', message => message.room.id === created.room.id);
  assert.equal(restored.room.botDifficulty, 'hard'); assert.equal(restored.room.visibility, 'public');
  const endMark = recovered.mark(); offset += RULES.matchSeconds * 1000 + 20;
  const ended = await recovered.wait('event', message => message.event.type === 'match-end', endMark);
  assert.equal(ended.event.type, 'match-end'); if (ended.event.type !== 'match-end') return;
  assert.equal(ended.event.ranked, false);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM profiles').get()!.count, 2, 'AI rivals never create persistent player profiles.');
  for (const table of ['stats', 'matches', 'match_pairs']) assert.equal(f.store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count, 0, 'Casual bot results must not change stored history or ratings.');
  const rematch = await startReady(recovered, [recovered], 'rematch');
  assert.equal(rematch.room.botDifficulty, 'hard'); assert.equal(botCount(rematch.room), 3);
  assert.equal(rematch.room.players.length, 4);
});

test('empty disconnected lobbies disappear, recover during grace, and expire without remaining in Available Games', async t => {
  const originalNow = Date.now; let offset = 0; Date.now = () => originalNow() + offset;
  t.after(() => { Date.now = originalNow; });
  const f = await fixture(t), identity = await f.profile('Returning host'), host = await f.connect(identity.token);
  const created = await host.command({ type: 'create', ranked: false, visibility: 'public', fillBots: true }, 'room');
  const closed = new Promise<void>(resolve => host.socket.once('close', () => resolve())); host.close(); await closed;
  const observerIdentity = await f.profile('Observer'), observer = await f.connect(observerIdentity.token);
  assert.deepEqual(await (await f.request('/api/games')).json(), { games: [] });
  const recovered = await f.connect(identity.token);
  await recovered.wait('room', message => message.room.id === created.room.id);
  assert.equal((await (await f.request('/api/games')).json() as { games: AvailableGame[] }).games.length, 1);
  offset += 2 * 60 * 60 * 1000 + 1;
  assert.deepEqual(await (await f.request('/api/games')).json(), { games: [] });
  await observer.command({ type: 'join-public', roomId: created.room.id }, 'error', message => message.code === 'PUBLIC_GAME_UNAVAILABLE');
});

test('casual AI uses the real simulation, can win, and cannot start without a human', () => {
  let shots = 0;
  const engine = new MatchEngine({ fillBots: true, botDifficulty: 'hard', practiceSeed: 'casual-bots', onEvent: event => { if (event.type === 'shot') shots++; } });
  const bots = PRACTICE_RIVALS.map(profile => engine.addPlayer(profile, 0, true));
  assert.throws(() => engine.start(0));
  const human = engine.addPlayer({ id: 'human', name: 'Human', color: '#fff' }, 0);
  engine.start(0);
  for (let tick = 0; tick < 1800 && engine.phase !== 'finished'; tick++) engine.step(3000 + tick * 1000 / 30, 1 / 30);
  assert.ok(shots > 0, 'Casual bots must move, acquire targets and actually fire.');
  if (engine.phase === 'finished') engine.start(64000);
  const maxKills = Math.max(human.kills, ...bots.map(bot => bot.kills)); bots[0]!.kills = maxKills + 1;
  engine.finish('Time is up.', 64000); assert.deepEqual(engine.winnerIds, [bots[0]!.id]);
  engine.start(65000); engine.setConnected(human.id, false);
  const resetPoses = bots.map(bot => [bot.x, bot.y, bot.z]);
  engine.step(69000, 1 / 30); assert.deepEqual(bots.map(bot => [bot.x, bot.y, bot.z]), resetPoses, 'Bots stop while all humans are disconnected.');
});
