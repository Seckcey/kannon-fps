import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GameStore, cleanName, type CompletedMatch } from '../../server/store.js';

test('profile keys are hashed, restore persistent identity, and rename safely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kannon-store-')); const path = join(dir, 'db.sqlite');
  let store = new GameStore(path);
  try {
    const saved = store.saveProfile('  Dad  '); assert.equal(saved.profile.name, 'Dad'); assert.match(saved.token, /^[0-9a-f]{64}$/);
    const stored = store.db.prepare('SELECT token_hash FROM profiles').get() as { token_hash: string };
    assert.notEqual(stored.token_hash, saved.token); assert.equal(store.authenticate('bad'), null);
    store.close(); store = new GameStore(path); assert.equal(store.authenticate(saved.token)?.id, saved.profile.id);
    assert.equal(store.saveProfile('Dad Prime', saved.token).profile.id, saved.profile.id);
    assert.throws(() => store.saveProfile('Dad', 'invalid'));
    assert.equal(cleanName('Hi\u0000<there>'), 'Hithere');
  } finally { store.close(); assert.ok(resolve(dir).startsWith(resolve(join(tmpdir(), 'kannon-store-')))); rmSync(dir, { recursive: true, force: true }); }
});
test('private crew leaderboard rejects outsiders and rating writes are atomic/idempotent', () => {
  const store = new GameStore(':memory:');
  try {
    const a = store.saveProfile('Dad').profile, b = store.saveProfile('Kannon').profile, stranger = store.saveProfile('Stranger').profile;
    const crew = store.createCrew(a.id, 'Our friends'); assert.equal(store.listCrews(b.id).length, 0);
    assert.throws(() => store.leaderboard(stranger.id, crew.id, 'all'));
    store.joinCrew(b.id, crew.invite); assert.equal(store.listCrews(b.id)[0]?.memberCount, 2);
    const now = Date.parse('2026-09-08T10:00:00Z');
    const match: CompletedMatch = { id: 'm1', crewId: crew.id, endedAt: now, duration: 300, winnerIds: [a.id], players: [{ ...a, kills: 15, deaths: 5 }, { ...b, kills: 5, deaths: 15 }] };
    assert.equal(store.recordMatch({ ...match, duration: 10 }).recorded, false);
    assert.equal(store.recordMatch(match).recorded, true); assert.equal(store.recordMatch(match).recorded, false);
    const board = store.leaderboard(a.id, crew.id, 'all', now);
    assert.equal(board.entries.find((e) => e.id === a.id)?.rating, 1016); assert.equal(board.entries.find((e) => e.id === b.id)?.rating, 984);
    assert.equal(board.history.length, 1); assert.ok(board.entries.every((e) => e.matches === 1 && !e.placed && e.rank === null));
    assert.equal(store.leaderboard(a.id, crew.id, 'month', now).history.length, 1);
    assert.equal(store.leaderboard(a.id, crew.id, 'month', Date.parse('2026-10-01T00:00:00Z')).history.length, 0);
    for (let i = 2; i <= 5; i++) assert.equal(store.recordMatch({ ...match, id: `m${i}`, endedAt: now + i }).recorded, true);
    assert.equal(store.recordMatch({ ...match, id: 'm6', endedAt: now + 6 }).recorded, false);
    const placed = store.leaderboard(a.id, crew.id, 'all', now); assert.equal(placed.entries[0]?.rank, 1); assert.equal(placed.entries[0]?.matches, 5);
    assert.equal(store.recordMatch({ ...match, id: 'next-day', endedAt: now + 86400000 }).recorded, true);
    assert.equal(store.recordMatch({ ...match, id: 'outsider', players: [{ ...a, kills: 15, deaths: 5 }, { ...stranger, kills: 5, deaths: 15 }] }).recorded, false);
  } finally { store.close(); }
});
test('a storage error rolls ratings, monthly stats, match history, and opponent counters back together', () => {
  const store = new GameStore(':memory:');
  try {
    const a = store.saveProfile('Dad').profile, b = store.saveProfile('Kannon').profile;
    const crew = store.createCrew(a.id, 'Our friends'); store.joinCrew(b.id, crew.invite);
    const now = Date.parse('2026-09-08T10:00:00Z');
    const match: CompletedMatch = { id: 'atomic-proof', crewId: crew.id, endedAt: now, duration: 300, winnerIds: [a.id], players: [{ ...a, kills: 15, deaths: 5 }, { ...b, kills: 5, deaths: 15 }] };
    store.db.exec("CREATE TRIGGER fail_match BEFORE INSERT ON matches BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END;");
    assert.throws(() => store.recordMatch(match), /injected storage failure/);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM stats').get() as { n: number }).n, 0);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM match_pairs').get() as { n: number }).n, 0);
    for (const period of ['all', 'month'] as const) {
      const board = store.leaderboard(a.id, crew.id, period, now); assert.equal(board.history.length, 0); assert.ok(board.entries.every((e) => e.matches === 0 && e.rating === 1000));
    }
    store.db.exec('DROP TRIGGER fail_match'); assert.equal(store.recordMatch(match).recorded, true);
    assert.equal(store.leaderboard(a.id, crew.id, 'all', now).history.length, 1);
  } finally { store.close(); }
});
test('committed match results survive abrupt process replacement without applying the same result twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kannon-result-')); const path = join(dir, 'db.sqlite'); let store = new GameStore(path);
  try {
    const a = store.saveProfile('Dad').profile, b = store.saveProfile('Kannon').profile;
    const crew = store.createCrew(a.id, 'Our friends'); store.joinCrew(b.id, crew.invite);
    const now = Date.parse('2026-09-08T10:00:00Z');
    const match: CompletedMatch = { id: 'durable-proof', crewId: crew.id, endedAt: now, duration: 300, winnerIds: [a.id], players: [{ ...a, kills: 15, deaths: 5 }, { ...b, kills: 5, deaths: 15 }] };
    assert.equal(store.recordMatch(match).recorded, true);
    // Reopen a second independent connection while the original WAL is still live.
    const restarted = new GameStore(path); store.close(); store = restarted;
    assert.equal(store.recordMatch(match).recorded, false);
    for (const period of ['all', 'month'] as const) {
      const board = store.leaderboard(a.id, crew.id, period, now);
      assert.equal(board.history.length, 1); assert.equal(board.history[0]?.id, match.id);
      assert.equal(board.entries.find((e) => e.id === a.id)?.rating, 1016); assert.ok(board.entries.every((e) => e.matches === 1));
    }
  } finally { store.close(); assert.ok(resolve(dir).startsWith(resolve(join(tmpdir(), 'kannon-result-')))); rmSync(dir, { recursive: true, force: true }); }
});
test('tied leaders receive draw rating outcomes and match credit without each receiving a win', () => {
  const store = new GameStore(':memory:');
  try {
    const a = store.saveProfile('Dad').profile, b = store.saveProfile('Kannon').profile;
    const crew = store.createCrew(a.id, 'Our friends'); store.joinCrew(b.id, crew.invite);
    const now = Date.parse('2026-09-08T10:00:00Z');
    const match: CompletedMatch = { id: 'draw-proof', crewId: crew.id, endedAt: now, duration: 300, winnerIds: [a.id, b.id], players: [{ ...a, kills: 5, deaths: 5 }, { ...b, kills: 5, deaths: 5 }] };
    assert.equal(store.recordMatch(match).recorded, true);
    for (const period of ['all', 'month'] as const) {
      const board = store.leaderboard(a.id, crew.id, period, now);
      assert.ok(board.entries.every(e => e.rating === 1000 && e.wins === 0 && e.matches === 1 && e.winRate === 0));
      assert.deepEqual(new Set(board.history[0]?.winnerIds), new Set([a.id, b.id]));
      assert.ok(board.history[0]?.players.every(p => p.ratingChange === 0));
    }
  } finally { store.close(); }
});
