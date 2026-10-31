import { RULES, type GameEvent, type GameMode, type MedalId, type PlayerState, type Profile, type PublicPlayerState, type StreakId, type Team, type WorldSnapshot } from '../../../shared/protocol';
import { STREAKS, hasPerk } from '../../../shared/weapons';
import { MEDAL_NAMES, SCORE_LABELS, TEAM_NAMES, causeIcon, causeName, otherTeam } from '../labels';
import type { IconName } from '../Icon';

export function clock(seconds: number): string {
  const n = Math.max(0, Math.ceil(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(n / 60).toString().padStart(2, '0')}:${(n % 60).toString().padStart(2, '0')}`;
}

export type Relation = 'self' | 'friend' | 'enemy';
export interface Viewer { id: string; team?: Team }
/** Everyone else is an enemy in free-for-all; in teams, your own team are friends. */
export function relationOf(viewer: Viewer, mode: GameMode, player: { id: string; team?: Team }): Relation {
  if (player.id === viewer.id) return 'self';
  return mode === 'tdm' && !!viewer.team && player.team === viewer.team ? 'friend' : 'enemy';
}

type Person = Pick<Profile, 'id' | 'name'> & { team?: Team };
export function nameLookup(...lists: ReadonlyArray<ReadonlyArray<Person> | undefined>) {
  const people = new Map<string, Person>();
  for (const list of lists) for (const person of list ?? []) if (!people.has(person.id)) people.set(person.id, person);
  return (id: string): Person => people.get(id) ?? { id, name: 'Player' };
}

export interface FeedName { id: string; name: string; relation: Relation }
export type FeedEntry =
  | { kind: 'elimination'; key: string; at: number; attacker: FeedName | null; victim: FeedName; icon: IconName; headshot: boolean; weapon: string }
  | { kind: 'message'; key: string; at: number; text: string; tone: Relation | 'info'; icon?: IconName };
/** Recent eliminations, reward calls and notices, oldest first. */
export function killFeed(feed: readonly GameEvent[], lookup: (id: string) => Person, viewer: Viewer, mode: GameMode, now: number, windowMs = 6000, limit = 5): FeedEntry[] {
  const named = (id: string): FeedName => { const person = lookup(id); return { id, name: person.name, relation: relationOf(viewer, mode, person) }; };
  const entries: FeedEntry[] = [];
  for (const event of feed) {
    if (now - event.at > windowMs) continue;
    if (event.type === 'elimination') {
      const self = !event.attackerId || event.attackerId === event.playerId;
      entries.push({ kind: 'elimination', key: `e-${event.at}-${event.playerId}-${event.attackerId}`, at: event.at,
        attacker: self ? null : named(event.attackerId), victim: named(event.playerId), icon: causeIcon(event.cause, event.weapon),
        headshot: event.headshot, weapon: causeName(event.cause, event.weapon) });
    } else if (event.type === 'streak' && event.action === 'used') {
      const caller = named(event.playerId);
      entries.push({ kind: 'message', key: `s-${event.at}-${event.playerId}-${event.reward}`, at: event.at, tone: caller.relation,
        icon: rewardIcon(event.reward), text: `${caller.relation === 'self' ? 'You' : caller.name} called in ${STREAKS[event.reward].name}` });
    } else if (event.type === 'notice') {
      entries.push({ kind: 'message', key: `n-${event.at}-${event.message}`, at: event.at, tone: 'info', text: event.message });
    }
  }
  return entries.slice(-limit);
}
const rewardIcon = (reward: StreakId): IconName => ({ recon: 'radar', mortar: 'mortar', drone: 'drone' } as const)[reward];

export interface Popup { key: string; points: number; label: string }
/** "+100 Elimination" style score pop-ups for the viewer, oldest first. */
export function scorePopups(feed: readonly GameEvent[], playerId: string, now: number, windowMs = 2400, limit = 4): Popup[] {
  // Keys must not depend on the event's position in the feed: the feed is trimmed from the front,
  // and a changed key would restart a pop-up's animation.
  const popups: Popup[] = [], seen = new Map<string, number>();
  for (const event of feed) {
    if (event.type !== 'score' || event.playerId !== playerId || now - event.at > windowMs || now - event.at < -1000) continue;
    const base = `p-${event.at}-${event.reason}`, repeat = seen.get(base) ?? 0;
    seen.set(base, repeat + 1);
    popups.push({ key: repeat ? `${base}-${repeat}` : base, points: event.points, label: SCORE_LABELS[event.reason] });
  }
  return popups.slice(-limit);
}
export interface MedalCard { key: string; medal: MedalId; name: string }
export function recentMedals(feed: readonly GameEvent[], playerId: string, now: number, windowMs = 3200, limit = 2): MedalCard[] {
  const medals: MedalCard[] = [];
  for (const event of feed) {
    if (event.type !== 'medal' || event.playerId !== playerId || now - event.at > windowMs || now - event.at < -1000) continue;
    medals.push({ key: `m-${event.at}-${event.medal}`, medal: event.medal, name: MEDAL_NAMES[event.medal] });
  }
  return medals.slice(-limit);
}
/** The viewer's newly earned reward, for a short "ready" announcement. */
export function rewardReady(feed: readonly GameEvent[], playerId: string, now: number, windowMs = 3500): StreakId | null {
  for (let i = feed.length - 1; i >= 0; i--) {
    const event = feed[i]!;
    if (now - event.at > windowMs) break;
    if (event.type === 'streak' && event.playerId === playerId && event.action === 'earned') return event.reward;
  }
  return null;
}

/** Everything the callout stack may show at once. */
export interface Callouts { notices: string[]; medals: MedalCard[]; popups: Popup[]; reward: StreakId | null }
/** Fixed line heights of the compact touch callouts, in CSS pixels (applied inline). */
export const TOUCH_CALLOUT = { notice: 19, medal: 22, popup: 16, reward: 19, gap: 3 } as const;
/**
 * The callouts that fit in `budget` pixels of height, most important first: threat warnings, then
 * medals, score pop-ups and the "reward ready" line. Display order is unchanged; whatever does not fit
 * is left out (each item is short-lived), so the stack never grows into the crosshair.
 */
export function fitCallouts(set: Callouts, budget: number, sizes: typeof TOUCH_CALLOUT = TOUCH_CALLOUT): Callouts & { height: number } {
  let height = 0, count = 0;
  const fits = (size: number) => {
    const next = height + (count > 0 ? sizes.gap : 0) + size;
    if (next > budget) return false;
    height = next; count++;
    return true;
  };
  const notices = set.notices.filter(() => fits(sizes.notice));
  const medals = set.medals.filter(() => fits(sizes.medal));
  const popups = set.popups.filter(() => fits(sizes.popup));
  const reward = set.reward && fits(sizes.reward) ? set.reward : null;
  return { notices, medals, popups, reward, height };
}

export interface EliminatedBy { attacker: FeedName | null; weapon: string; icon: IconName; distance: number; headshot: boolean }
/** Who eliminated the viewer most recently. */
export function eliminatedBy(feed: readonly GameEvent[], lookup: (id: string) => Person, viewer: Viewer, mode: GameMode): EliminatedBy | null {
  for (let i = feed.length - 1; i >= 0; i--) {
    const event = feed[i]!;
    if (event.type !== 'elimination' || event.playerId !== viewer.id) continue;
    const self = !event.attackerId || event.attackerId === viewer.id;
    const person = self ? null : lookup(event.attackerId);
    return { attacker: person ? { id: person.id, name: person.name, relation: relationOf(viewer, mode, person) } : null,
      weapon: causeName(event.cause, event.weapon), icon: causeIcon(event.cause, event.weapon),
      distance: Math.max(0, Math.round(event.distance)), headshot: event.headshot };
  }
  return null;
}

export interface ScoreRow {
  id: string; name: string; color: string; team?: Team; relation: Relation;
  score: number; kills: number; deaths: number; assists: number; streak: number; connected: boolean; bot: boolean;
}
export interface ScoreGroup { key: string; team?: Team; title: string; relation: Relation | 'all'; total: number | null; rows: ScoreRow[] }
const byScore = (a: ScoreRow, b: ScoreRow) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name);
/** Scoreboard rows: one list in free-for-all, the viewer's team first in Team Deathmatch. */
export function scoreboard(players: readonly PublicPlayerState[], mode: GameMode, viewer: Viewer, teamScores?: Partial<Record<Team, number>>): ScoreGroup[] {
  const rows = players.map((p): ScoreRow => ({ id: p.id, name: p.name, color: p.color, team: p.team, relation: relationOf(viewer, mode, p),
    score: p.score ?? 0, kills: p.kills ?? 0, deaths: p.deaths ?? 0, assists: p.assists ?? 0, streak: p.streak ?? 0, connected: p.connected, bot: !!p.bot })).sort(byScore);
  if (mode !== 'tdm') return [{ key: 'all', title: 'Players', relation: 'all', total: null, rows }];
  const first: Team = viewer.team ?? 'teal';
  return [first, otherTeam(first)].map(team => {
    const members = rows.filter(row => row.team === team);
    return { key: team, team, title: `${TEAM_NAMES[team]} team`, relation: viewer.team ? (team === viewer.team ? 'friend' : 'enemy') : 'all',
      total: teamScores?.[team] ?? members.reduce((sum, row) => sum + row.kills, 0), rows: members };
  });
}
export function topScorer(players: readonly PublicPlayerState[]): PublicPlayerState | null {
  let best: PublicPlayerState | null = null;
  for (const p of players) {
    if (!best || p.score > best.score || (p.score === best.score && (p.kills > best.kills || (p.kills === best.kills && p.deaths < best.deaths)))) best = p;
  }
  return best && (best.score > 0 || best.kills > 0) ? best : null;
}

export interface MatchResult { outcome: 'win' | 'loss' | 'draw'; title: string }
export function matchResult(mode: GameMode, viewer: Viewer, winnerIds: readonly string[], winningTeam: Team | undefined, players: readonly Person[]): MatchResult {
  if (mode === 'tdm') {
    if (!winningTeam) return { outcome: 'draw', title: 'The teams are tied.' };
    if (viewer.team === winningTeam) return { outcome: 'win', title: 'Your team wins.' };
    return { outcome: viewer.team ? 'loss' : 'draw', title: `${TEAM_NAMES[winningTeam]} team wins.` };
  }
  if (winnerIds.length === 1 && winnerIds[0] === viewer.id) return { outcome: 'win', title: 'That round was yours.' };
  if (winnerIds.length === 1) return { outcome: 'loss', title: `${players.find(p => p.id === winnerIds[0])?.name ?? 'Your rival'} takes the round.` };
  if (winnerIds.length > 1) return { outcome: winnerIds.includes(viewer.id) ? 'draw' : 'loss', title: 'Honors shared.' };
  return { outcome: 'draw', title: 'Round ended.' };
}

export type ScoreSummary =
  | { mode: 'ffa'; mine: number; rival: { name: string; kills: number } | null; leading: boolean; limit: number }
  | { mode: 'tdm'; myTeam: Team; theirTeam: Team; friendly: number; enemy: number; limit: number };
/** The top-centre score: your eliminations against the best rival, or the two team totals. */
export function scoreSummary(snapshot: Pick<WorldSnapshot, 'mode' | 'scoreLimit' | 'teamScores' | 'players'> | null | undefined, viewer: Viewer, fallbackMode: GameMode = 'ffa'): ScoreSummary {
  const mode = snapshot?.mode ?? fallbackMode;
  const limit = snapshot?.scoreLimit || (mode === 'tdm' ? RULES.tdmScoreLimit : RULES.ffaScoreLimit);
  const players = snapshot?.players ?? [];
  if (mode === 'tdm') {
    const myTeam: Team = viewer.team ?? players.find(p => p.id === viewer.id)?.team ?? 'teal', theirTeam = otherTeam(myTeam);
    const total = (team: Team) => snapshot?.teamScores?.[team] ?? players.filter(p => p.team === team).reduce((sum, p) => sum + p.kills, 0);
    return { mode, myTeam, theirTeam, friendly: total(myTeam), enemy: total(theirTeam), limit };
  }
  const mine = players.find(p => p.id === viewer.id)?.kills ?? 0;
  const rivals = players.filter(p => p.id !== viewer.id).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  const rival = rivals[0] ? { name: rivals[0].name, kills: rivals[0].kills } : null;
  return { mode, mine, rival, leading: !rival || mine > rival.kills, limit };
}

/** Warnings about enemy rewards that affect the viewer right now. */
export function threatNotices(snapshot: Pick<WorldSnapshot, 'serverTime' | 'drones' | 'recon' | 'mortars'> | null | undefined, self: Pick<PlayerState, 'id' | 'team' | 'loadout'> | undefined, mode: GameMode): string[] {
  if (!snapshot || !self) return [];
  const viewer: Viewer = { id: self.id, team: self.team };
  const hostile = (owner: { ownerId: string; team?: Team }) => relationOf(viewer, mode, { id: owner.ownerId, team: owner.team }) === 'enemy';
  const notices: string[] = [];
  if (snapshot.mortars?.some(m => hostile(m) && m.impacts.some(at => at >= snapshot.serverTime))) notices.push('Mortar Volley incoming. Keep moving.');
  if (snapshot.drones?.some(d => hostile(d) && d.until > snapshot.serverTime && d.health > 0)) notices.push('Enemy Attack Drone overhead.');
  if (snapshot.recon?.some(r => hostile(r) && r.until > snapshot.serverTime) && !(self.loadout && hasPerk(self.loadout, 'low-profile'))) notices.push('Enemy Recon Sweep: you show on their map.');
  return notices;
}
