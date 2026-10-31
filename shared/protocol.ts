/** Public wire contract. All game outcomes are computed by the server. */
export const WORLD_VERSION = 'kannon-town-v3';
/** 1 = primary weapon, 2 = secondary. Lethal, knife and streak rewards are separate actions. */
export type Slot = 1 | 2;
export type Phase = 'waiting' | 'preparing' | 'countdown' | 'playing' | 'finished';
export type PracticeDifficulty = 'easy' | 'normal' | 'hard';
export type RoomVisibility = 'private' | 'public';
/** Free-for-all or two-team deathmatch. Ranked crew matches are always free-for-all. */
export type GameMode = 'ffa' | 'tdm';
/** Teams are named for their home house: teal spawns west (x < 0), gold spawns east (x > 0). */
export type Team = 'teal' | 'gold';
export type Posture = 'stand' | 'crouch' | 'slide' | 'vault';
export type HitZone = 'head' | 'torso' | 'legs';
export type PrimaryWeaponId = 'kr5' | 'hornet9' | 'breaker12' | 'longbow';
export type SecondaryWeaponId = 'sentry9';
export type WeaponId = PrimaryWeaponId | SecondaryWeaponId;
export type LethalId = 'frag';
/** Perk slot 1: quick-hands | deep-pockets. Slot 2: quiet-step | low-profile. Slot 3: second-wind | steady-aim. */
export type PerkId = 'quick-hands' | 'deep-pockets' | 'quiet-step' | 'low-profile' | 'second-wind' | 'steady-aim';
export type StreakId = 'recon' | 'mortar' | 'drone';
export type DamageCause = 'bullet' | 'melee' | 'frag' | 'mortar' | 'drone';
export type SurfaceKind = 'asphalt' | 'concrete' | 'wood' | 'grass' | 'metal' | 'fabric' | 'glass' | 'sandbag';
export type MedalId = 'first-strike' | 'double' | 'triple' | 'headshot' | 'long-shot' | 'even-score' | 'blade' | 'grenadier'
  | 'drone-down' | 'streak-3' | 'streak-5' | 'streak-7' | 'streak-10';
export type ScoreReason = 'elimination' | 'headshot' | 'assist' | 'long-shot' | 'first-strike' | 'even-score' | 'multi'
  | 'streak-reward' | 'drone-down';
export type LoadoutPreset = 'assault' | 'close' | 'marksman' | 'custom';
export interface Loadout { primary: PrimaryWeaponId; secondary: SecondaryWeaponId; lethal: LethalId; perks: [PerkId, PerkId, PerkId] }

export interface Profile { id: string; name: string; color: string }
export interface Crew { id: string; name: string; invite: string; ownerId: string; memberCount: number }
export interface RoomPlayer extends Profile { connected: boolean; ready?: boolean; bot?: boolean; team?: Team }
export interface RoomSnapshot {
  id: string; code: string; hostId: string; ranked: boolean; practice: boolean; mode: GameMode;
  crewId?: string; practiceDifficulty?: PracticeDifficulty; phase: Phase; players: RoomPlayer[]; expiresAt: number;
  visibility?: RoomVisibility; fillBots?: boolean; botDifficulty?: PracticeDifficulty;
  /** Present only while preparing; readiness belongs to this attempt and connection. */
  preparation?: { id: string; expiresAt: number };
}
/** Only opted-in, joinable public lobbies expose this small directory entry. */
export interface AvailableGame {
  id: string; hostName: string; humanCount: number; botCount: number; maxPlayers: number; mode: GameMode;
  fillBots: boolean; botDifficulty?: PracticeDifficulty;
}
/** A round can go on: a connected person and someone connected to play against. In team deathmatch
 * (pass the mode) both teams also need someone connected, or nobody is left to fight. */
export function hasMatchOpponents(players: Iterable<{ connected: boolean; bot?: boolean; team?: Team }>, mode: GameMode = 'ffa'): boolean {
  let humans = 0, participants = 0;
  const sides = new Set<Team | undefined>();
  for (const player of players) if (player.connected) { participants++; if (!player.bot) humans++; sides.add(player.team); }
  return humans >= 1 && participants >= 2 && (mode !== 'tdm' || sides.size >= 2);
}
export interface InputFrame {
  seq: number; moveX: number; moveZ: number; yaw: number; pitch: number;
  fire: boolean; aim: boolean; jump: boolean; sprint: boolean; reload: boolean; slot: Slot;
  /** Held crouch (the client resolves toggle settings). Its rising edge while sprinting on the ground starts a slide. */
  crouch: boolean;
  /** Wants the faster, stamina-limited sprint. Only effective together with sprint. */
  dash: boolean;
  /** Knife on the rising edge. */
  melee: boolean;
  /** Held = cooking the lethal; it is thrown on release, or explodes in hand when the fuse runs out. */
  grenade: boolean;
  /** Rising edge uses this earned reward. The mortar also needs streakTarget. */
  streak: StreakId | null;
  streakTarget?: { x: number; z: number };
  /** Server time (ms) of the world this client was drawing when it sampled the frame; hit checks rewind to it. */
  viewTime: number;
}
/** The equipped vault, in world coordinates and server milliseconds. */
export interface VaultState {
  fromX: number; fromY: number; fromZ: number; toX: number; toY: number; toZ: number;
  start: number; end: number; exitSpeed: number; exitYaw: number;
}
/** What every client may know about every player. */
export interface PublicPlayerState extends Profile {
  x: number; y: number; z: number; yaw: number; pitch: number; vx: number; vy: number; vz: number;
  health: number; team?: Team; slot: Slot; weapon: WeaponId; loadout: Loadout;
  kills: number; deaths: number; assists: number; score: number; streak: number;
  connected: boolean; respawnAt: number; protectedUntil: number; reloadingUntil: number;
  posture: Posture; vault: VaultState | null; slideUntil: number; cookingSince: number;
  lastInputSeq: number; bot?: boolean; aiming?: boolean; sprinting?: boolean; dashing?: boolean;
}
/** Full state: the server's own record, and `WorldSnapshot.self` for the receiving player. */
export interface PlayerState extends PublicPlayerState {
  /** Rounds in the magazine and in reserve, indexed [primary, secondary]. */
  mag: [number, number]; reserve: [number, number];
  frags: number;
  /** Earned, unused streak rewards in the order earned. */
  rewards: StreakId[];
  reloadSlot: Slot | 0;
  /** Weapon raise after a spawn, swap or knife; firing waits until this server time. */
  readyAt: number;
  meleeUntil: number;
  /** Dash stamina, 0..1. */
  stamina: number;
  slideCooldownUntil: number;
  lastDamageAt: number;
}
export interface Vec3 { x: number; y: number; z: number }
/** Presentation of an authoritative ray, in pellet order (centre first). */
export interface ShotTrace {
  to: Vec3; kind: 'world' | 'player' | 'range' | 'drone'; targetId?: string; zone?: HitZone;
  /** Target state before this tick's damage resolves; not hit awards. */
  protected?: boolean;
  /** World contacts only: the face normal and surface material hit. */
  normal?: Vec3; surface?: SurfaceKind;
}
export interface DroneState { id: string; ownerId: string; team?: Team; x: number; y: number; z: number; yaw: number; health: number; until: number }
export interface ReconState { ownerId: string; team?: Team; until: number }
export interface MortarState { id: string; ownerId: string; team?: Team; x: number; z: number; impacts: number[] }
export type GameEvent =
  | { type: 'shot'; playerId: string; weapon: WeaponId | 'drone'; from: Vec3; traces: ShotTrace[]; hit: boolean; at: number }
  | { type: 'damage'; playerId: string; attackerId: string; amount: number; cause: DamageCause; zone?: HitZone; from: Vec3; at: number }
  | { type: 'elimination'; playerId: string; attackerId: string; cause: DamageCause; weapon?: WeaponId; headshot: boolean; distance: number; assists: string[]; at: number }
  | { type: 'respawn'; playerId: string; at: number }
  | { type: 'score'; playerId: string; points: number; reason: ScoreReason; at: number }
  | { type: 'medal'; playerId: string; medal: MedalId; at: number }
  | { type: 'melee'; playerId: string; targetId?: string; at: number }
  | { type: 'grenade'; id: string; playerId: string; from: Vec3; velocity: Vec3; explodeAt: number; at: number }
  | { type: 'explosion'; id: string; playerId: string; cause: 'frag' | 'mortar' | 'drone'; position: Vec3; at: number }
  | { type: 'streak'; playerId: string; reward: StreakId; action: 'earned' | 'used' | 'ended'; target?: { x: number; z: number }; at: number }
  | { type: 'notice'; message: string; at: number }
  | { type: 'match-end'; winnerIds: string[]; winningTeam?: Team; ranked: boolean; reason: string; at: number };
export interface WorldSnapshot {
  /** Identifies the prepared round whose poses and loadout this snapshot contains. */
  roundId?: string;
  tick: number; serverTime: number; phase: Phase; timeRemaining: number;
  mode: GameMode; scoreLimit: number;
  teamScores?: Record<Team, number>;
  players: PublicPlayerState[];
  /** The receiving player's full state; absent for spectating sockets and in shared broadcasts. */
  self?: PlayerState;
  winnerIds: string[]; winningTeam?: Team;
  drones: DroneState[]; recon: ReconState[]; mortars: MortarState[];
}
export interface LeaderboardEntry extends Profile {
  rating: number; wins: number; matches: number; kills: number; deaths: number;
  winRate: number; placed: boolean; rank: number | null;
}
export interface MatchHistory {
  id: string; endedAt: number; duration: number; winnerIds: string[];
  players: Array<Profile & { kills: number; deaths: number; ratingChange: number }>;
}
export type ClientMessage =
  | { type: 'hello'; token: string; readyProtocol?: 1; worldVersion?: string }
  | { type: 'create'; ranked: boolean; crewId?: string; practice?: boolean; practiceDifficulty?: PracticeDifficulty; visibility?: RoomVisibility; fillBots?: boolean; botDifficulty?: PracticeDifficulty; mode?: GameMode }
  | { type: 'join'; code: string }
  | { type: 'join-public'; roomId: string }
  | { type: 'start' }
  | { type: 'rematch' }
  | { type: 'ready'; preparationId: string; ready: boolean }
  | { type: 'leave' }
  | { type: 'input'; input: InputFrame }
  /** Applies at the sender's next spawn. Accepted in the lobby and during play. */
  | { type: 'loadout'; loadout: Loadout }
  | { type: 'ping'; t: number };
export type ServerMessage =
  | { type: 'welcome'; playerId: string }
  | { type: 'room'; room: RoomSnapshot }
  | { type: 'snapshot'; snapshot: WorldSnapshot }
  | { type: 'event'; event: GameEvent }
  | { type: 'error'; message: string; code?: string }
  | { type: 'pong'; t: number };
export const RULES = {
  maxPlayers: 8, matchSeconds: 300, ffaScoreLimit: 15, tdmScoreLimit: 30,
  respawnMs: 3000, protectionMs: 1500, countdownMs: 3000,
  health: 100, regenDelayMs: 4000, secondWindRegenDelayMs: 2500, regenPerSecond: 50,
  /** Hit checks rewind opponents at most this far, and the server keeps this much history. The rewind a shot needs
   * is the round trip plus the client's 100 ms draw delay plus up to about 70 ms of send, tick and queue waits, so
   * 400 ms covers 100 ms each way even on a phone's 30 Hz frames. */
  lagCompensationMs: 400, positionHistoryMs: 1000,
  fragsPerLife: 1, fragFuseMs: 3400,
  meleeRange: 1.6, meleeLungeRange: 2.6, meleeDamage: 135, meleeMs: 600,
  assistMinDamage: 20, longShotMeters: 30, multiKillWindowMs: 4000,
  reconMs: 20_000, droneMs: 25_000, droneHealth: 200,
  minRankedSeconds: 60, placementMatches: 5, dailyOpponentLimit: 5,
} as const;
export const SCORE_POINTS: Record<ScoreReason, number> = {
  elimination: 100, headshot: 50, assist: 50, 'long-shot': 50, 'first-strike': 100, 'even-score': 50, multi: 50,
  'streak-reward': 50, 'drone-down': 100,
};
