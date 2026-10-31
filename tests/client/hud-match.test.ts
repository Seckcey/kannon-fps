import test from 'node:test';
import assert from 'node:assert/strict';
import type { GameEvent, PublicPlayerState, Team } from '../../shared/protocol.js';
import { DEFAULT_LOADOUT, LOADOUT_PRESETS } from '../../shared/weapons.js';
import { clock, eliminatedBy, killFeed, matchResult, nameLookup, recentMedals, relationOf, rewardReady, scoreboard, scorePopups, scoreSummary, threatNotices, topScorer } from '../../src/components/hud/match.js';

function player(id: string, patch: Partial<PublicPlayerState> = {}): PublicPlayerState {
  return {
    id, name: id[0]!.toUpperCase() + id.slice(1), color: '#fff', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0,
    health: 100, slot: 1, weapon: 'kr5', loadout: DEFAULT_LOADOUT, kills: 0, deaths: 0, assists: 0, score: 0, streak: 0,
    connected: true, respawnAt: 0, protectedUntil: 0, reloadingUntil: 0, posture: 'stand', vault: null, slideUntil: 0, cookingSince: 0,
    lastInputSeq: 0, ...patch,
  };
}
const elimination = (playerId: string, attackerId: string, at: number, extra: Partial<Extract<GameEvent, { type: 'elimination' }>> = {}): GameEvent =>
  ({ type: 'elimination', playerId, attackerId, cause: 'bullet', weapon: 'kr5', headshot: false, distance: 12.4, assists: [], at, ...extra });

test('clock and player relations', () => {
  assert.equal(clock(300), '05:00'); assert.equal(clock(61.2), '01:02'); assert.equal(clock(-3), '00:00'); assert.equal(clock(Number.NaN), '00:00');
  const me = { id: 'me', team: 'teal' as Team };
  assert.equal(relationOf(me, 'ffa', { id: 'me' }), 'self');
  assert.equal(relationOf(me, 'ffa', { id: 'ana', team: 'teal' }), 'enemy', 'free-for-all has no friends');
  assert.equal(relationOf(me, 'tdm', { id: 'ana', team: 'teal' }), 'friend');
  assert.equal(relationOf(me, 'tdm', { id: 'bo', team: 'gold' }), 'enemy');
  assert.equal(relationOf({ id: 'me' }, 'tdm', { id: 'bo', team: 'gold' }), 'enemy');
});

test('the kill feed shows recent eliminations with weapon, headshot and team colour', () => {
  const lookup = nameLookup([player('me', { team: 'teal' }), player('ana', { team: 'teal' }), player('bo', { team: 'gold' })], [{ id: 'cy', name: 'Cy' }]);
  const feed: GameEvent[] = [
    elimination('bo', 'ana', 1000),
    elimination('ana', 'bo', 9000, { cause: 'frag', weapon: undefined }),
    elimination('me', 'cy', 9500, { headshot: true, weapon: 'longbow' }),
    elimination('bo', 'bo', 9800, { cause: 'frag', weapon: undefined }),
    { type: 'streak', playerId: 'bo', reward: 'mortar', action: 'used', target: { x: 1, z: 2 }, at: 9900 },
    { type: 'streak', playerId: 'me', reward: 'recon', action: 'earned', at: 9950 },
    { type: 'notice', message: 'Cy left the match.', at: 9990 },
  ];
  const entries = killFeed(feed, lookup, { id: 'me', team: 'teal' }, 'tdm', 10_000);
  assert.equal(entries.length, 5, 'old eliminations and earned rewards stay out');
  const [frag, sniped, own, mortar, notice] = entries;
  assert.ok(frag?.kind === 'elimination' && frag.icon === 'grenade' && frag.weapon === 'Frag grenade' && frag.attacker?.relation === 'enemy' && frag.victim.relation === 'friend');
  assert.ok(sniped?.kind === 'elimination' && sniped.headshot && sniped.icon === 'sniper' && sniped.weapon === 'Longbow' && sniped.attacker?.name === 'Cy' && sniped.victim.relation === 'self');
  assert.ok(own?.kind === 'elimination' && own.attacker === null, 'a self-elimination has no attacker');
  assert.ok(mortar?.kind === 'message' && mortar.text === 'Bo called in Mortar Strike' && mortar.tone === 'enemy');
  assert.ok(notice?.kind === 'message' && notice.tone === 'info');
  assert.equal(new Set(entries.map(entry => entry.key)).size, entries.length, 'stable unique keys');
  assert.equal(killFeed(feed, lookup, { id: 'me' }, 'ffa', 10_000, 6000, 2).length, 2);
  assert.equal(lookup('ghost').name, 'Player');
});

test('score pop-ups, medals and reward announcements belong to the viewer', () => {
  const feed: GameEvent[] = [
    { type: 'score', playerId: 'me', points: 100, reason: 'elimination', at: 9000 },
    { type: 'score', playerId: 'me', points: 50, reason: 'headshot', at: 9000 },
    { type: 'score', playerId: 'bo', points: 100, reason: 'elimination', at: 9100 },
    { type: 'score', playerId: 'me', points: 100, reason: 'elimination', at: 1000 },
    { type: 'medal', playerId: 'me', medal: 'headshot', at: 9000 },
    { type: 'medal', playerId: 'me', medal: 'streak-3', at: 9200 },
    { type: 'medal', playerId: 'bo', medal: 'double', at: 9200 },
    { type: 'streak', playerId: 'me', reward: 'recon', action: 'earned', at: 9300 },
  ];
  assert.deepEqual(scorePopups(feed, 'me', 10_000).map(p => `+${p.points} ${p.label}`), ['+100 Elimination', '+50 Headshot']);
  assert.deepEqual(recentMedals(feed, 'me', 10_000).map(m => m.name), ['Bullseye', 'Three Straight']);
  assert.equal(rewardReady(feed, 'me', 10_000), 'recon');
  assert.equal(rewardReady(feed, 'me', 20_000), null);
  assert.equal(rewardReady(feed, 'bo', 10_000), null);
  // The connection trims its feed from the front; keys must not change, or pop-up animations restart.
  const keys = scorePopups(feed, 'me', 10_000).map(p => p.key);
  assert.deepEqual(scorePopups(feed.slice(1), 'me', 10_000).map(p => p.key), keys.slice(1), 'dropping the oldest event keeps the other keys');
  assert.deepEqual(scorePopups([{ type: 'notice', message: 'hi', at: 9500 }, ...feed], 'me', 10_000).map(p => p.key), keys, 'shifted positions keep their keys');
  const twice = scorePopups([...feed.slice(0, 1), ...feed.slice(0, 1)], 'me', 10_000).map(p => p.key);
  assert.equal(new Set(twice).size, 2, 'repeated awards at the same moment get distinct keys');
});

test('the eliminated-by card names the latest attacker, weapon and distance', () => {
  const lookup = nameLookup([player('me'), player('bo')]);
  const feed = [elimination('me', 'bo', 1000, { weapon: 'breaker12', distance: 6.6 }), elimination('bo', 'me', 2000), elimination('me', 'bo', 3000, { headshot: true, distance: 31.4 })];
  assert.deepEqual(eliminatedBy(feed, lookup, { id: 'me' }, 'ffa'), { attacker: { id: 'bo', name: 'Bo', relation: 'enemy' }, weapon: 'KR-5 Carbine', icon: 'ar', distance: 31, headshot: true });
  const self = eliminatedBy([elimination('me', 'me', 1, { cause: 'frag', weapon: undefined })], lookup, { id: 'me' }, 'ffa');
  assert.equal(self?.attacker, null); assert.equal(self?.weapon, 'Frag grenade');
  assert.equal(eliminatedBy([], lookup, { id: 'me' }, 'ffa'), null);
});

test('scoreboards sort by score and split teams with the viewer first', () => {
  const players = [
    player('me', { team: 'gold', score: 300, kills: 3, deaths: 1, assists: 2 }),
    player('ana', { team: 'teal', score: 500, kills: 5, deaths: 2 }),
    player('bo', { team: 'teal', score: 300, kills: 4, deaths: 1 }),
    player('cy', { team: 'gold', score: 300, kills: 3, deaths: 0, bot: true }),
  ];
  const ffa = scoreboard(players, 'ffa', { id: 'me' });
  assert.equal(ffa.length, 1);
  assert.deepEqual(ffa[0]!.rows.map(row => row.id), ['ana', 'bo', 'cy', 'me']);
  assert.ok(ffa[0]!.rows.every(row => row.id === 'me' ? row.relation === 'self' : row.relation === 'enemy'));
  const tdm = scoreboard(players, 'tdm', { id: 'me', team: 'gold' }, { teal: 9, gold: 6 });
  assert.deepEqual(tdm.map(group => [group.title, group.total, group.relation]), [['Gold team', 6, 'friend'], ['Teal team', 9, 'enemy']]);
  assert.deepEqual(tdm[0]!.rows.map(row => row.id), ['cy', 'me']);
  assert.equal(tdm[0]!.rows[1]!.assists, 2);
  assert.deepEqual(scoreboard(players, 'tdm', { id: 'spectator' }).map(group => group.total), [9, 6], 'totals fall back to team eliminations');
  assert.equal(topScorer(players)?.id, 'ana');
  assert.equal(topScorer([player('a', { score: 100, kills: 1, deaths: 2 }), player('b', { score: 100, kills: 1, deaths: 0 })])?.id, 'b');
  assert.equal(topScorer([player('a'), player('b')]), null);
});

test('results name the winning team or player', () => {
  const people = [{ id: 'me', name: 'Me' }, { id: 'bo', name: 'Bo' }];
  assert.deepEqual(matchResult('tdm', { id: 'me', team: 'gold' }, [], 'gold', people), { outcome: 'win', title: 'Your team wins.' });
  assert.deepEqual(matchResult('tdm', { id: 'me', team: 'gold' }, [], 'teal', people), { outcome: 'loss', title: 'Teal team wins.' });
  assert.equal(matchResult('tdm', { id: 'me', team: 'gold' }, [], undefined, people).outcome, 'draw');
  assert.equal(matchResult('ffa', { id: 'me' }, ['me'], undefined, people).title, 'That round was yours.');
  assert.equal(matchResult('ffa', { id: 'me' }, ['bo'], undefined, people).title, 'Bo takes the round.');
  assert.deepEqual(matchResult('ffa', { id: 'me' }, ['me', 'bo'], undefined, people), { outcome: 'draw', title: 'Honors shared.' });
  assert.equal(matchResult('ffa', { id: 'me' }, [], undefined, people).title, 'Round ended.');
});

test('the score bar compares you with your best rival, or team with team', () => {
  const players = [player('me', { kills: 7, team: 'teal' }), player('bo', { kills: 9, team: 'gold' }), player('cy', { kills: 4, team: 'teal' })];
  assert.deepEqual(scoreSummary({ mode: 'ffa', scoreLimit: 15, players }, { id: 'me' }), { mode: 'ffa', mine: 7, rival: { name: 'Bo', kills: 9 }, leading: false, limit: 15 });
  assert.equal((scoreSummary({ mode: 'ffa', scoreLimit: 15, players: [player('me', { kills: 2 })] }, { id: 'me' }) as { leading: boolean }).leading, true);
  assert.deepEqual(scoreSummary({ mode: 'tdm', scoreLimit: 30, teamScores: { teal: 12, gold: 9 }, players }, { id: 'me', team: 'teal' }),
    { mode: 'tdm', myTeam: 'teal', theirTeam: 'gold', friendly: 12, enemy: 9, limit: 30 });
  assert.deepEqual(scoreSummary({ mode: 'tdm', scoreLimit: 0, players }, { id: 'me' }), { mode: 'tdm', myTeam: 'teal', theirTeam: 'gold', friendly: 11, enemy: 9, limit: 30 });
  assert.equal(scoreSummary(null, { id: 'me' }, 'tdm').limit, 30);
});

test('enemy rewards warn the viewer; friendly ones do not', () => {
  const base = { serverTime: 5000, drones: [], recon: [], mortars: [] };
  const self = { id: 'me', team: 'teal' as Team, loadout: LOADOUT_PRESETS.close };
  assert.deepEqual(threatNotices({ ...base, mortars: [{ id: 'm', ownerId: 'bo', team: 'gold', x: 0, z: 0, impacts: [6000] }] }, self, 'tdm'), ['Mortar Strike incoming. Keep moving.']);
  assert.deepEqual(threatNotices({ ...base, mortars: [{ id: 'm', ownerId: 'ana', team: 'teal', x: 0, z: 0, impacts: [6000] }] }, self, 'tdm'), []);
  assert.deepEqual(threatNotices({ ...base, mortars: [{ id: 'm', ownerId: 'bo', team: 'gold', x: 0, z: 0, impacts: [4000] }] }, self, 'tdm'), [], 'landed shells are not a warning');
  assert.deepEqual(threatNotices({ ...base, drones: [{ id: 'd', ownerId: 'ana', team: 'teal', x: 0, y: 0, z: 0, yaw: 0, health: 200, until: 9000 }] }, self, 'ffa'), ['Enemy Attack Drone overhead.']);
  const recon = { ...base, recon: [{ ownerId: 'bo', team: 'gold' as Team, until: 9000 }] };
  assert.deepEqual(threatNotices(recon, self, 'tdm'), ['Enemy Recon Sweep: you show on their map.']);
  assert.deepEqual(threatNotices(recon, { ...self, loadout: LOADOUT_PRESETS.assault }, 'tdm'), [], 'Low Profile hides you from Recon Sweeps');
  assert.deepEqual(threatNotices(null, self, 'tdm'), []);
});
