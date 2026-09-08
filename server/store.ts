import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { RULES, type Crew, type LeaderboardEntry, type MatchHistory, type Profile } from '../shared/protocol.js';

const COLORS = ['#ea7953', '#638df1', '#c78bef', '#5fbda6', '#edb846', '#ed7fa5', '#7baac2', '#a4b966'];
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const monthKey = (now: number) => new Date(now).toISOString().slice(0, 7);
export function cleanName(value: unknown, limit = 20): string {
  if (typeof value !== 'string') throw new Error('Please enter a name.');
  const name = value.normalize('NFKC').replace(/[\p{C}<>]/gu, '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > limit) throw new Error(`Use a name between 2 and ${limit} characters.`);
  return name;
}
type ProfileRow = Profile & { token_hash: string };
type CrewRow = { id: string; name: string; invite: string; owner_id: string; member_count: number };
type StatRow = { rating: number; wins: number; matches: number; kills: number; deaths: number };
export interface CompletedMatch {
  id: string; crewId: string; endedAt: number; duration: number; winnerIds: string[];
  players: Array<Profile & { kills: number; deaths: number }>;
}

export class GameStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY,name TEXT NOT NULL,color TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS crews(id TEXT PRIMARY KEY,name TEXT NOT NULL,invite TEXT UNIQUE NOT NULL,owner_id TEXT NOT NULL REFERENCES profiles(id),created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memberships(crew_id TEXT NOT NULL REFERENCES crews(id),profile_id TEXT NOT NULL REFERENCES profiles(id),joined_at INTEGER NOT NULL,PRIMARY KEY(crew_id,profile_id));
      CREATE TABLE IF NOT EXISTS stats(crew_id TEXT NOT NULL REFERENCES crews(id),profile_id TEXT NOT NULL REFERENCES profiles(id),period TEXT NOT NULL,rating INTEGER NOT NULL DEFAULT 1000,wins INTEGER NOT NULL DEFAULT 0,matches INTEGER NOT NULL DEFAULT 0,kills INTEGER NOT NULL DEFAULT 0,deaths INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(crew_id,profile_id,period));
      CREATE TABLE IF NOT EXISTS matches(id TEXT PRIMARY KEY,crew_id TEXT NOT NULL REFERENCES crews(id),ended_at INTEGER NOT NULL,duration INTEGER NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS match_pairs(match_id TEXT NOT NULL REFERENCES matches(id),crew_id TEXT NOT NULL,a TEXT NOT NULL,b TEXT NOT NULL,ended_at INTEGER NOT NULL,PRIMARY KEY(match_id,a,b));
      CREATE INDEX IF NOT EXISTS match_history ON matches(crew_id,ended_at DESC);
      CREATE INDEX IF NOT EXISTS pair_daily ON match_pairs(crew_id,a,b,ended_at);
      CREATE INDEX IF NOT EXISTS memberships_by_profile ON memberships(profile_id,crew_id);
      CREATE INDEX IF NOT EXISTS crews_by_owner ON crews(owner_id);`);
  }
  close() { this.db.close(); }
  authenticate(token: unknown): Profile | null {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const row = this.db.prepare('SELECT id,name,color FROM profiles WHERE token_hash=?').get(hash(token)) as ProfileRow | undefined;
    return row ? { id: row.id, name: row.name, color: row.color } : null;
  }
  saveProfile(nameValue: unknown, tokenValue?: unknown): { token: string; profile: Profile } {
    const name = cleanName(nameValue);
    if (tokenValue !== undefined) {
      const profile = this.authenticate(tokenValue);
      if (!profile) throw new Error('Your player key was not recognized. Restore a valid key or create a new profile.');
      this.db.prepare('UPDATE profiles SET name=? WHERE id=?').run(name, profile.id);
      return { token: tokenValue as string, profile: { ...profile, name } };
    }
    const token = randomBytes(32).toString('hex'); const id = randomUUID();
    const profile: Profile = { id, name, color: COLORS[randomBytes(1)[0]! % COLORS.length]! };
    this.db.prepare('INSERT INTO profiles(id,name,color,token_hash,created_at) VALUES(?,?,?,?,?)').run(id, name, profile.color, hash(token), Date.now());
    return { token, profile };
  }
  isMember(profileId: string, crewId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM memberships WHERE crew_id=? AND profile_id=?').get(crewId, profileId);
  }
  listCrews(profileId: string): Crew[] {
    const rows = this.db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM memberships m2 WHERE m2.crew_id=c.id) AS member_count FROM crews c JOIN memberships m ON m.crew_id=c.id WHERE m.profile_id=? ORDER BY c.created_at DESC`).all(profileId) as CrewRow[];
    return rows.map((row) => ({ id: row.id, name: row.name, invite: row.invite, ownerId: row.owner_id, memberCount: row.member_count }));
  }
  createCrew(profileId: string, nameValue: unknown): Crew {
    const name = cleanName(nameValue, 32);
    const owned = this.db.prepare('SELECT COUNT(*) AS n FROM crews WHERE owner_id=?').get(profileId) as { n: number };
    if (owned.n >= 10) throw new Error('You can create up to 10 friend groups.');
    const crew: Crew = { id: randomUUID(), name, invite: randomBytes(12).toString('base64url'), ownerId: profileId, memberCount: 1 };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO crews(id,name,invite,owner_id,created_at) VALUES(?,?,?,?,?)').run(crew.id, crew.name, crew.invite, profileId, Date.now());
      this.db.prepare('INSERT INTO memberships(crew_id,profile_id,joined_at) VALUES(?,?,?)').run(crew.id, profileId, Date.now());
      this.db.exec('COMMIT'); return crew;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  joinCrew(profileId: string, inviteValue: unknown): Crew {
    if (typeof inviteValue !== 'string' || inviteValue.length > 100) throw new Error('Enter a valid friend group invitation.');
    const row = this.db.prepare('SELECT * FROM crews WHERE invite=?').get(inviteValue.trim()) as CrewRow | undefined;
    if (!row) throw new Error('This friend group invitation was not found.');
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE crew_id=?').get(row.id) as { n: number };
    if (count.n >= 64 && !this.isMember(profileId, row.id)) throw new Error('This friend group is full.');
    const ownCount = this.db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE profile_id=?').get(profileId) as { n: number };
    if (ownCount.n >= 20 && !this.isMember(profileId, row.id)) throw new Error('You can join up to 20 friend groups.');
    this.db.prepare('INSERT OR IGNORE INTO memberships(crew_id,profile_id,joined_at) VALUES(?,?,?)').run(row.id, profileId, Date.now());
    return this.listCrews(profileId).find((crew) => crew.id === row.id)!;
  }
  leaderboard(profileId: string, crewId: string, period: 'all' | 'month', now = Date.now()): { entries: LeaderboardEntry[]; history: MatchHistory[] } {
    if (!this.isMember(profileId, crewId)) throw new Error('Join this friend group to view its leaderboard.');
    const key = period === 'month' ? monthKey(now) : 'all';
    const rows = this.db.prepare(`SELECT p.id,p.name,p.color,COALESCE(s.rating,1000) AS rating,COALESCE(s.wins,0) AS wins,COALESCE(s.matches,0) AS matches,COALESCE(s.kills,0) AS kills,COALESCE(s.deaths,0) AS deaths FROM memberships m JOIN profiles p ON p.id=m.profile_id LEFT JOIN stats s ON s.crew_id=m.crew_id AND s.profile_id=p.id AND s.period=? WHERE m.crew_id=? ORDER BY COALESCE(s.rating,1000) DESC,COALESCE(s.wins,0) DESC,p.name ASC`).all(key, crewId) as unknown as Array<Profile & StatRow>;
    let rank = 0;
    const entries = rows.map((row): LeaderboardEntry => ({ ...row, winRate: row.matches ? Math.round(row.wins / row.matches * 100) : 0, placed: row.matches >= RULES.placementMatches, rank: row.matches >= RULES.placementMatches ? ++rank : null }));
    entries.sort((a, b) => Number(b.placed) - Number(a.placed) || b.rating - a.rating || b.wins - a.wins || a.name.localeCompare(b.name));
    const since = period === 'month' ? Date.parse(`${monthKey(now)}-01T00:00:00Z`) : 0;
    const history = (this.db.prepare('SELECT result FROM matches WHERE crew_id=? AND ended_at>=? ORDER BY ended_at DESC LIMIT 30').all(crewId, since) as Array<{ result: string }>).map((row) => JSON.parse(row.result) as MatchHistory);
    return { entries, history };
  }
  /** Atomic, idempotent result + ratings. A daily pair cap limits score farming. */
  recordMatch(match: CompletedMatch): { recorded: boolean; reason: string } {
    if (match.players.length < 2 || match.duration < RULES.minRankedSeconds) return { recorded: false, reason: 'Ranked matches need at least two players and one minute of play.' };
    if (new Set(match.players.map((p) => p.id)).size !== match.players.length || match.players.some((p) => !this.isMember(p.id, match.crewId))) return { recorded: false, reason: 'Every ranked player must belong to the same friend group.' };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT 1 FROM matches WHERE id=?').get(match.id)) { this.db.exec('ROLLBACK'); return { recorded: false, reason: 'This match was already recorded.' }; }
      const sorted = [...match.players].sort((a, b) => a.id.localeCompare(b.id));
      const pairs: Array<[string, string]> = [];
      for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) pairs.push([sorted[i]!.id, sorted[j]!.id]);
      const dayStart = Math.floor(match.endedAt / 86400000) * 86400000;
      for (const [a, b] of pairs) {
        const count = this.db.prepare('SELECT COUNT(*) AS n FROM match_pairs WHERE crew_id=? AND a=? AND b=? AND ended_at>=?').get(match.crewId, a, b, dayStart) as { n: number };
        if (count.n >= RULES.dailyOpponentLimit) { this.db.exec('ROLLBACK'); return { recorded: false, reason: 'Daily ranked limit reached for these opponents. This result is a friendly match.' }; }
      }
      const changes = new Map<string, number>();
      for (const period of ['all', monthKey(match.endedAt)]) {
        const before = new Map<string, StatRow>();
        for (const player of sorted) {
          this.db.prepare('INSERT OR IGNORE INTO stats(crew_id,profile_id,period) VALUES(?,?,?)').run(match.crewId, player.id, period);
          before.set(player.id, this.db.prepare('SELECT rating,wins,matches,kills,deaths FROM stats WHERE crew_id=? AND profile_id=? AND period=?').get(match.crewId, player.id, period) as StatRow);
        }
        for (const player of sorted) {
          const rating = before.get(player.id)!.rating; let delta = 0;
          for (const opponent of sorted) {
            if (opponent.id === player.id) continue;
            const score = player.kills === opponent.kills ? 0.5 : player.kills > opponent.kills ? 1 : 0;
            const expected = 1 / (1 + Math.pow(10, (before.get(opponent.id)!.rating - rating) / 400));
            delta += 32 * (score - expected) / (sorted.length - 1);
          }
          const rounded = Math.round(delta); if (period === 'all') changes.set(player.id, rounded);
          this.db.prepare('UPDATE stats SET rating=rating+?,wins=wins+?,matches=matches+1,kills=kills+?,deaths=deaths+? WHERE crew_id=? AND profile_id=? AND period=?')
            .run(rounded, match.winnerIds.length === 1 && match.winnerIds[0] === player.id ? 1 : 0, player.kills, player.deaths, match.crewId, player.id, period);
        }
      }
      const history: MatchHistory = { id: match.id, endedAt: match.endedAt, duration: match.duration, winnerIds: match.winnerIds, players: match.players.map((p) => ({ ...p, ratingChange: changes.get(p.id)! })) };
      this.db.prepare('INSERT INTO matches(id,crew_id,ended_at,duration,result) VALUES(?,?,?,?,?)').run(match.id, match.crewId, match.endedAt, match.duration, JSON.stringify(history));
      for (const [a, b] of pairs) this.db.prepare('INSERT INTO match_pairs(match_id,crew_id,a,b,ended_at) VALUES(?,?,?,?,?)').run(match.id, match.crewId, a, b, match.endedAt);
      this.db.exec('COMMIT'); return { recorded: true, reason: 'Ranked result saved to your friend group leaderboard.' };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
