/** Public wire contract. All game outcomes are computed by the server. */
export type Slot = 1 | 2 | 3;
export type Phase = 'waiting' | 'countdown' | 'playing' | 'finished';
export type PracticeDifficulty = 'easy' | 'normal' | 'hard';
export interface Profile { id: string; name: string; color: string }
export interface Crew { id: string; name: string; invite: string; ownerId: string; memberCount: number }
export interface RoomPlayer extends Profile { connected: boolean; ready?: boolean; bot?: boolean }
export interface RoomSnapshot {
  id: string; code: string; hostId: string; ranked: boolean; practice: boolean;
  crewId?: string; practiceDifficulty?: PracticeDifficulty; phase: Phase; players: RoomPlayer[]; expiresAt: number;
}
export interface InputFrame {
  seq: number; moveX: number; moveZ: number; yaw: number; pitch: number;
  fire: boolean; aim: boolean; jump: boolean; sprint: boolean; reload: boolean; slot: Slot;
}
export interface PlayerState extends Profile {
  x: number; y: number; z: number; yaw: number; pitch: number;
  vx: number; vy: number; vz: number; health: number; shield: number; slot: Slot;
  ammoAR: number; ammoShotgun: number; heals: number; kills: number; deaths: number;
  connected: boolean; respawnAt: number; protectedUntil: number; healingUntil: number;
  reloadingUntil: number; lastInputSeq: number; bot?: boolean; aiming?: boolean;
}
export interface Vec3 { x: number; y: number; z: number }
/** Presentation of an existing authoritative muzzle ray, in pellet order (center first). */
export interface ShotTrace {
  to: Vec3; kind: 'world' | 'player' | 'range'; targetId?: string;
  /** Player collision state before this tick's damage resolves; not hit awards. */
  shield?: boolean; protected?: boolean;
}
export type GameEvent =
  | { type: 'shot'; playerId: string; slot: 1 | 2; from: Vec3; to: Vec3; hit: boolean; at: number; traces?: ShotTrace[] }
  | { type: 'damage'; playerId: string; attackerId: string; amount: number; at: number; shieldDamage?: number; healthDamage?: number; shieldBroken?: boolean }
  | { type: 'elimination'; playerId: string; attackerId: string; at: number }
  | { type: 'respawn'; playerId: string; at: number }
  | { type: 'heal'; playerId: string; amount: number; at: number }
  | { type: 'notice'; message: string; at: number }
  | { type: 'match-end'; winnerIds: string[]; ranked: boolean; reason: string; at: number };
export interface WorldSnapshot {
  tick: number; serverTime: number; phase: Phase; timeRemaining: number;
  players: PlayerState[]; winnerIds: string[];
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
  | { type: 'hello'; token: string }
  | { type: 'create'; ranked: boolean; crewId?: string; practice?: boolean; practiceDifficulty?: PracticeDifficulty }
  | { type: 'join'; code: string }
  | { type: 'start' }
  | { type: 'rematch' }
  | { type: 'leave' }
  | { type: 'input'; input: InputFrame }
  | { type: 'ping'; t: number };
export type ServerMessage =
  | { type: 'welcome'; playerId: string }
  | { type: 'room'; room: RoomSnapshot }
  | { type: 'snapshot'; snapshot: WorldSnapshot }
  | { type: 'event'; event: GameEvent }
  | { type: 'error'; message: string; code?: string }
  | { type: 'pong'; t: number };
export const RULES = {
  maxPlayers: 8, matchSeconds: 300, scoreLimit: 15, respawnMs: 3000,
  protectionMs: 2000, countdownMs: 3000, health: 100, shield: 50,
  healCharges: 2, healAmount: 50, healMs: 3000, arMagazine: 30,
  shotgunMagazine: 6, arDamage: 24, arCadenceMs: 150, shotgunCadenceMs: 900,
  arReloadMs: 1800, shotgunReloadMs: 2400, minRankedSeconds: 60,
  placementMatches: 5, dailyOpponentLimit: 5,
} as const;
