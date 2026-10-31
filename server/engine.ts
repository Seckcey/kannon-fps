import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { PracticeBots } from './bots.js';
import { ARENA_LIMITS, OBSTACLES, SPAWNS } from '../shared/map.js';
import {
  add, clamp, directionFromAngles, eyePosition, grenadeLaunch, GrenadeTrajectory, hitboxes, magnitude, moveDefaults, movePlayer, normalize,
  POSTURE_HEIGHT, rayBox, raycastMap, raycastMapDetailed, rayHitboxes, rightFromYaw, scale, subtract, weaponMuzzle,
} from '../shared/physics.js';
import {
  hasMatchOpponents, RULES, SCORE_POINTS, type DamageCause, type DroneState, type GameEvent, type GameMode, type HitZone, type InputFrame,
  type Loadout, type MedalId, type MortarState, type Phase, type PlayerState, type Posture, type PracticeDifficulty, type Profile,
  type PublicPlayerState, type ReconState, type ScoreReason, type ShotTrace, type Slot, type StreakId, type Team, type VaultState, type Vec3,
  type WeaponId, type WorldSnapshot,
} from '../shared/protocol.js';
import {
  botLoadout, damageAt, DEEP_POCKETS_EXTRA_MAGS, DEFAULT_LOADOUT, DRONE, EXPLOSIVES, explosionDamage, fireIntervalMs, hasPerk, PELLET_PATTERN,
  QUICK_HANDS_FACTOR, sanitizeLoadout, STEADY_AIM_ADS_FACTOR, STREAK_ORDER, STREAKS, weaponFor, WEAPONS, type WeaponSpec,
} from '../shared/weapons.js';

/** Highest and lowest view pitch the server accepts, in radians. */
export const MAX_PITCH = 1.5;
/** After this long without a new frame, a player with nothing queued stands down (brakes and falls), and a press
 * kept from a dropped frame stops counting. */
const INPUT_TIMEOUT_MS = 300;
/** Each client frame is one step of this length, exactly as the client predicts it. */
export const FRAME_MS = 1000 / 30;
const FRAME_SECONDS = 1 / 30;
/** Frames waiting to be simulated per player (200 ms), beyond the frames a streaming player's playout holds back. On
 * overflow the oldest frame's movement is dropped and its presses are kept for the next simulated frame. */
export const INPUT_QUEUE_LIMIT = 6;
/** The most of one player's frames a tick simulates, so a backlog drains at double speed at most. */
export const FRAMES_PER_TICK = 2;
/** Wall-clock time banked for catching up. Frames simulated over any window stay within the elapsed time divided by
 * FRAME_MS plus this allowance, so sending faster never moves anyone faster. Five frames (167 ms) is the least that
 * still simulates every frame of a 150 ms jitter spike; it is also the most a client that holds back its frames can
 * spend at double speed afterwards (about 1.1 m of sprint). */
export const FRAME_CREDIT_MS = 5 * FRAME_MS;
/** A player is streaming once this many frames arrived within STREAM_WINDOW_MS, spread over at least
 * STREAM_SPREAD_MS and with no gap over STREAM_GAP_MS between them (a client sending its 30 a second, not one burst
 * and not across a pause), until the connection goes quiet. */
const STREAM_FRAMES = 8, STREAM_WINDOW_MS = 10 * FRAME_MS, STREAM_SPREAD_MS = 4 * FRAME_MS, STREAM_GAP_MS = 2.5 * FRAME_MS;
/** A streaming player's frames wait up to this long behind their own clock after a late frame (see updatePlayer)... */
export const MAX_PLAYOUT_MS = 2 * FRAME_MS;
/** ...and one frame less after this long with every frame arriving a tick early. */
export const PLAYOUT_RELAX_MS = 5000;
/** Every CLOCK_CHECK_FRAMES frames a streaming clock is compared with when its frames arrive. If even the least
 * delayed of them came more than two ticks before its clock (a shorter route than when the clock was set), or more
 * than a tick after it (a longer route, frames the page skipped), the clock moves towards them by at most
 * CLOCK_SLEW_MS a frame: too little to change a timer the client predicted. Jitter only delays frames, so it never
 * moves the clock. */
const CLOCK_CHECK_FRAMES = 30, CLOCK_SLEW_MS = 1;
/** A clock this far behind the tick is put straight back on it. */
const CLOCK_RESET_MS = 250;
/** Tick times and frame clocks are compared to this tolerance: rounding only. The server's ticks carry exact
 * 1000/30 ms times (server/app.ts); on whole-millisecond ticks a frame due a fraction later waits a tick rather than
 * running on a bent clock. */
const CLOCK_TOLERANCE_MS = 1e-6;
/** Firing waits until a vault is this far through (0..1). */
export const VAULT_FIRE_PROGRESS = 0.7;
/** Sprint-to-fire takes this much longer after the faster dash. */
export const DASH_SPRINT_TO_FIRE = 1.4;
/** Knife reach is a cone this wide either side of the view, in radians. */
export const MELEE_HALF_ANGLE = 35 * Math.PI / 180;
/** Spawn visibility checks aim at this height above the spawn point (the chest). */
const SPAWN_CHEST = 1.2;
const MAX_STORED_REWARDS = 9;
const STREAK_IDS: readonly StreakId[] = ['recon', 'mortar', 'drone'];
const BOOLEAN_KEYS = ['fire', 'aim', 'jump', 'sprint', 'reload', 'crouch', 'dash', 'melee', 'grenade'] as const;
/** Rising edges latched between ticks so a quick tap is never lost. */
const PRESS_KEYS = ['fire', 'jump', 'reload', 'crouch', 'melee', 'grenade'] as const;
type PressAction = typeof PRESS_KEYS[number] | 'streak';
const STREAK_MEDALS: Readonly<Record<number, MedalId>> = { 3: 'streak-3', 5: 'streak-5', 7: 'streak-7', 10: 'streak-10' };

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const r3 = (value: number) => Math.round(value * 1000) / 1000;
const r4 = (value: number) => Math.round(value * 10000) / 10000;
/** The owning player's own pose: replaying inputs from a 1 mm rounding drifts at step corners and lintels. */
const r6 = (value: number) => Math.round(value * 1e6) / 1e6;
const r3v = (v: Vec3): Vec3 => ({ x: r3(v.x), y: r3(v.y), z: r3(v.z) });
const distance3 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const angleDelta = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const copyLoadout = (loadout: Loadout): Loadout => ({ ...loadout, perks: [...loadout.perks] as Loadout['perks'] });
/** Quick Hands makes reloads, swaps and raises 25% faster. */
const handling = (loadout: Loadout) => hasPerk(loadout, 'quick-hands') ? QUICK_HANDS_FACTOR : 1;
/** Spare rounds at spawn (and the most an elimination can top the reserve up to). */
export const reserveFor = (spec: WeaponSpec, loadout: Loadout) =>
  spec.magazine * (spec.reserveMags + (hasPerk(loadout, 'deep-pockets') ? DEEP_POCKETS_EXTRA_MAGS : 0));
export const insideArena = (x: number, z: number) => Math.abs(x) <= ARENA_LIMITS.x && Math.abs(z) <= ARENA_LIMITS.z;
/** 0..1 through the current vault, 1 when not vaulting (the same rule as shared `vaultFireProgress`). */
export function vaultProgress(state: { vault: VaultState | null }, now: number): number {
  const vault = state.vault;
  return vault ? clamp((now - vault.start) / Math.max(1, vault.end - vault.start), 0, 1) : 1;
}
/** Where most of a blast of bullet damage landed. The head counts only when it took strictly the largest share,
 * so a shotgun aimed at the chest is not a headshot because one pellet clipped the head. */
export function mainZone(byZone: Readonly<Record<HitZone, number>>): HitZone | undefined {
  const most = Math.max(byZone.head, byZone.torso, byZone.legs);
  if (!(most > 0)) return undefined;
  return byZone.torso === most ? 'torso' : byZone.legs === most ? 'legs' : 'head';
}
/** Middle of the torso hitbox, where explosions and the drone aim. */
export function torsoCenter(state: Vec3 & { posture: Posture }): Vec3 {
  const torso = hitboxes(state)[1]!;
  return { x: state.x, y: (torso.min.y + torso.max.y) / 2, z: state.z };
}
function lineClear(from: Vec3, to: Vec3): boolean {
  const delta = subtract(to, from), length = magnitude(delta);
  return length < 1e-6 || raycastMap(from, normalize(delta), length) >= length - 0.01;
}
/** Top of the highest obstacle under a point (roofs, platforms), or the ground. */
export function highestSurface(x: number, z: number): number {
  let top = 0;
  for (const box of OBSTACLES) if (Math.abs(x - box.x) <= box.w / 2 && Math.abs(z - box.z) <= box.d / 2) top = Math.max(top, box.y + box.h / 2);
  return top;
}

export function idleInput(seq = 0): InputFrame {
  return { seq, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, fire: false, aim: false, jump: false, sprint: false, reload: false, slot: 1, crouch: false, dash: false, melee: false, grenade: false, streak: null, viewTime: 0 };
}
/** Accepts one complete v3 input frame from the wire. Anything malformed or hostile is rejected whole. */
export function sanitizeInput(value: unknown): InputFrame | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const i = value as Record<string, unknown>;
  const { seq, moveX, moveZ, yaw, pitch, viewTime } = i;
  if (!finite(seq) || !finite(moveX) || !finite(moveZ) || !finite(yaw) || !finite(pitch) || !finite(viewTime)) return null;
  if (!Number.isInteger(seq) || seq < 0 || seq > 2147483647 || (i.slot !== 1 && i.slot !== 2)) return null;
  if (!BOOLEAN_KEYS.every(key => typeof i[key] === 'boolean')) return null;
  if (i.streak !== null && !STREAK_IDS.includes(i.streak as StreakId)) return null;
  let streakTarget: { x: number; z: number } | undefined;
  // A missing target is fine (only the mortar needs one); null is read as missing.
  if (i.streakTarget !== undefined && i.streakTarget !== null) {
    if (typeof i.streakTarget !== 'object' || Array.isArray(i.streakTarget)) return null;
    const { x, z } = i.streakTarget as Record<string, unknown>;
    if (!finite(x) || !finite(z) || !insideArena(x, z)) return null;
    streakTarget = { x, z };
  }
  const flags = Object.fromEntries(BOOLEAN_KEYS.map(key => [key, i[key]])) as Pick<InputFrame, typeof BOOLEAN_KEYS[number]>;
  return {
    seq, moveX: clamp(moveX, -1, 1), moveZ: clamp(moveZ, -1, 1), yaw: yaw % (Math.PI * 2), pitch: clamp(pitch, -MAX_PITCH, MAX_PITCH),
    ...flags, slot: i.slot as Slot, streak: i.streak as StreakId | null, ...(streakTarget ? { streakTarget } : {}), viewTime,
  };
}
/** Bot frames skip the wire. Fill in anything an older bot brain leaves out so a room never sees a partial frame. */
function normalizeFrame(frame: Partial<InputFrame> | undefined, seq: number, now: number): InputFrame {
  const f = (frame ?? {}) as Record<string, unknown>;
  const candidate: Record<string, unknown> = { ...idleInput(seq), viewTime: now };
  for (const key of ['seq', 'moveX', 'moveZ', 'yaw', 'pitch', 'viewTime'] as const) if (finite(f[key])) candidate[key] = f[key];
  for (const key of BOOLEAN_KEYS) if (typeof f[key] === 'boolean') candidate[key] = f[key];
  candidate.slot = f.slot === 2 ? 2 : 1;
  if (STREAK_IDS.includes(f.streak as StreakId)) candidate.streak = f.streak;
  const target = f.streakTarget as { x?: unknown; z?: unknown } | null | undefined;
  if (target && finite(target.x) && finite(target.z) && insideArena(target.x, target.z)) candidate.streakTarget = { x: target.x, z: target.z };
  return sanitizeInput(candidate) ?? { ...idleInput(seq), viewTime: now };
}

interface PendingPress { input: InputFrame; receivedAt: number }
/** An accepted frame waiting for its turn, with the actions it pressed relative to the frame before it. */
interface QueuedFrame { input: InputFrame; receivedAt: number; presses: readonly PressAction[] }
interface HistorySample { t: number; x: number; y: number; z: number; posture: Posture }
type Pose = Vec3 & { posture: Posture };
interface Runtime {
  /** The newest accepted frame (sequence order and press edges) and when it arrived. */
  input: InputFrame; receivedAt: number;
  /** Accepted frames not yet simulated, oldest first; each is simulated once, in order. */
  queue: QueuedFrame[];
  /** Presses from frames dropped on overflow, used by the next simulated frame. */
  presses: Partial<Record<PressAction, PendingPress>>;
  /** Server time of the last simulated frame (published as `lastInputTime`), never later than the tick. While
   * streaming, each frame is one FRAME_MS step after the frame `clockSeq` (one step per sequence number), so slides,
   * vaults and weapon timers follow the client's predicted clock. `clockSeq` is null until a frame sets the clock
   * after a spawn, reconnect or silence. */
  clock: number; clockSeq: number | null;
  /** Arrival times of the latest STREAM_FRAMES frames, and whether the player is streaming (see updatePlayer). */
  arrivals: Array<{ at: number; seq: number }>; streaming: boolean;
  /** Clock check: frames measured since the last one, the most any of them arrived before its clock, and the
   * milliseconds the clock still has to move. `startAt` is the clock for the frame that starts a stream. */
  checked: number; earliest: number; slew: number; startAt: number;
  /** How far behind their own clock a streaming player's frames run, in ms (0 to MAX_PLAYOUT_MS); `late` marks a
   * hold for a late frame, and `earlySince` when frames last stopped arriving a tick early. */
  playout: number; late: boolean; earlySince: number;
  /** Wall-clock milliseconds available for simulating frames, refilled every tick up to FRAME_CREDIT_MS. */
  credit: number; creditAt: number;
  /** Held state at the end of the previous tick, for rising edges and continuous automatic fire. */
  fireDown: boolean; jumpDown: boolean; crouchDown: boolean; aimSince: number | null;
  /** A semi-automatic press came too early (raising, sprint-out, vault, between shots); it fires once allowed while held. */
  triggerPending: boolean;
  /** Earliest next shot per weapon slot: a swap waits only for the new weapon's raise, and swapping back
   * cannot skip the main gun's own bolt or pump cycle. */
  nextFireAt: [number, number]; lastSprintAt: number; lastSprintDash: boolean;
  /** Active reload; `shells` counts rounds already loaded by a shell-by-shell reload. */
  reload: { slot: Slot; start: number; shells: number } | null;
  pendingLoadout: Loadout | null;
  /** About one second of per-tick poses for lag compensation; reset at each spawn. */
  history: HistorySample[]; aliveSince: number; life: number;
  regenStart: number; regenBase: number;
  /** Damage taken this life by attacker, for assists. */
  damageBy: Map<string, number>; lastKilledBy: string | null; lastKillAt: number; chain: number;
  random: number; explicitTeam: boolean;
}
/** `origin` is where the frame that made the action left the player. */
interface QueuedShot { player: PlayerState; frame: InputFrame; spec: WeaponSpec; slot: Slot; ads: number; origin: Pose }
interface QueuedMelee { player: PlayerState; frame: InputFrame; origin: Pose }
interface TickActions { shots: QueuedShot[]; melees: QueuedMelee[] }
/** Actions one frame queues before its movement is known. */
interface FrameActions { shots: Array<Omit<QueuedShot, 'origin'>>; melees: Array<Omit<QueuedMelee, 'origin'>> }
interface PendingHit { attacker: PlayerState; target: PlayerState; amount: number; cause: DamageCause; weapon?: WeaponId; slot?: Slot; zone?: HitZone; from: Vec3; life: number }
/** One attacker's share of a target's damage in one resolution; `bullet` sums bullet damage by zone. */
interface Contribution { attacker: PlayerState; amount: number; top: PendingHit; bullet: Record<HitZone, number> }
interface DroneHit { attacker: PlayerState; drone: Drone; amount: number }
interface Grenade { id: string; ownerId: string; life: number; thrownAt: number; explodeAt: number; trajectory: GrenadeTrajectory }
interface Drone extends DroneState { startedAt: number; angle: number; nextFireAt: number; random: number }
interface Mortar extends MortarState { next: number; random: number }
interface Settlement {
  /** First Strike is open for this resolution; `firstStruck` holds who already took it, so a trade shares it but
   * one frag downing two rivals awards it once. */
  firstStrikeOpen: boolean; firstStruck: Set<string>;
  streaks: Array<{ player: PlayerState; life: number }>; chains: Array<{ player: PlayerState; life: number }>;
  evened: Runtime[]; killedBy: Array<[Runtime, string]>; anyKill: boolean;
}
/** A secret seed for rolls and rival brains that never goes on the wire (the round id does). */
const privateSeed = () => randomBytes(16).toString('hex');

export interface EngineOptions {
  practice?: boolean; practiceDifficulty?: PracticeDifficulty; now?: number;
  fillBots?: boolean; botDifficulty?: PracticeDifficulty;
  /** Free-for-all (default) or team deathmatch. */
  mode?: GameMode;
  /** Optional reproducible seed for bots and every random roll. Never accepted by the wire protocol. */
  practiceSeed?: string;
  onEvent?: (event: GameEvent) => void; onFinish?: (reason: string) => void;
}

export class MatchEngine {
  id = randomUUID(); phase: Phase = 'waiting'; tick = 0; startedAt = 0; countdownUntil = 0; endedAt = 0;
  winnerIds: string[] = []; winningTeam: Team | undefined;
  readonly mode: GameMode; readonly practice: boolean;
  readonly players = new Map<string, PlayerState>(); readonly runtime = new Map<string, Runtime>();
  teamScores: Record<Team, number> = { teal: 0, gold: 0 };
  /** Live grenades and rewards in play. Read-only outside the engine. */
  readonly grenades: Grenade[] = []; readonly drones: Drone[] = []; readonly recon: ReconState[] = []; readonly mortars: Mortar[] = [];
  private readonly onEvent: (event: GameEvent) => void; private readonly onFinish: (reason: string) => void;
  private readonly bots: PracticeBots | null; private readonly botDifficulty: PracticeDifficulty;
  private readonly practiceSeed: string | undefined;
  private resolving = false; private firstStrike = false; private entityCount = 0;
  /** Bookkeeping that settles after every target in one resolution, so a same-tick trade reads the same
   * whichever target happens to be processed first. */
  private settle: Settlement | null = null;

  constructor(options: EngineOptions = {}) {
    this.practice = options.practice ?? false; this.mode = options.mode === 'tdm' ? 'tdm' : 'ffa';
    this.practiceSeed = options.practiceSeed;
    this.botDifficulty = (this.practice ? options.practiceDifficulty : options.botDifficulty) ?? 'normal';
    this.bots = this.practice || options.fillBots ? new PracticeBots(this.botDifficulty, this.practiceSeed ?? privateSeed()) : null;
    this.onEvent = options.onEvent ?? (() => {}); this.onFinish = options.onFinish ?? (() => {});
  }
  get scoreLimit(): number { return this.mode === 'tdm' ? RULES.tdmScoreLimit : RULES.ffaScoreLimit; }

  /** Adds or reconnects a player. In team deathmatch an omitted team is chosen to keep the sides even. */
  addPlayer(profile: Profile, now = Date.now(), bot = false, team?: Team): PlayerState {
    if (bot && !this.bots) throw new Error('AI rivals are not enabled for this match.');
    const existing = this.players.get(profile.id);
    if (existing) {
      existing.connected = true; existing.name = profile.name; existing.lastInputSeq = 0; existing.aiming = false;
      const rt = this.runtime.get(profile.id)!;
      rt.input = { ...idleInput(), yaw: existing.yaw, pitch: existing.pitch, slot: existing.slot }; rt.receivedAt = 0; this.releaseControls(rt);
      this.resetClock(existing, rt, now);
      if (team && this.mode === 'tdm') { existing.team = team; rt.explicitTeam = true; }
      return existing;
    }
    const loadout = copyLoadout(bot ? botLoadout(profile.id, this.botDifficulty) : DEFAULT_LOADOUT);
    const state: PlayerState = {
      id: profile.id, name: profile.name, color: profile.color, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, ...moveDefaults(),
      health: RULES.health, slot: 1, weapon: loadout.primary, loadout, kills: 0, deaths: 0, assists: 0, score: 0, streak: 0,
      connected: true, respawnAt: 0, protectedUntil: 0, reloadingUntil: 0, cookingSince: 0, lastInputSeq: 0, aiming: false,
      mag: [0, 0], reserve: [0, 0], frags: 0, rewards: [], reloadSlot: 0, readyAt: 0, meleeUntil: 0, lastDamageAt: 0, lastInputTime: now,
      ...(bot ? { bot: true } : {}),
    };
    this.players.set(profile.id, state);
    this.runtime.set(profile.id, {
      input: idleInput(), receivedAt: 0, queue: [], presses: {}, clock: now, clockSeq: null, arrivals: [], streaming: false,
      checked: 0, earliest: -Infinity, slew: 0, startAt: now, playout: 0, late: false, earlySince: now, credit: FRAME_CREDIT_MS, creditAt: now,
      fireDown: false, jumpDown: false, crouchDown: false, aimSince: null, triggerPending: false,
      nextFireAt: [-Infinity, -Infinity], lastSprintAt: -Infinity, lastSprintDash: false, reload: null, pendingLoadout: null,
      history: [], aliveSince: now, life: 0, regenStart: NaN, regenBase: RULES.health,
      damageBy: new Map(), lastKilledBy: null, lastKillAt: -Infinity, chain: 0, random: 0, explicitTeam: false,
    });
    if (this.mode === 'tdm') { if (team) { state.team = team; this.runtime.get(profile.id)!.explicitTeam = true; } this.balanceTeams(); }
    this.respawn(state, now, false); return state;
  }
  removePlayer(id: string) {
    this.players.delete(id); this.runtime.delete(id); this.bots?.forget(id);
    const owned = <T extends { ownerId: string }>(list: T[]) => { for (let i = list.length - 1; i >= 0; i--) if (list[i]!.ownerId === id) list.splice(i, 1); };
    owned(this.grenades); owned(this.drones); owned(this.recon); owned(this.mortars);
    this.balanceTeams();
  }
  setConnected(id: string, connected: boolean) {
    const player = this.players.get(id);
    if (!player) return;
    player.connected = connected;
    if (!connected) this.freeze(player);
  }
  /** Chooses the loadout for the player's next spawn. Before the round is under way it applies at once. */
  setLoadout(id: string, value: Loadout): boolean {
    const player = this.players.get(id), rt = this.runtime.get(id), loadout = sanitizeLoadout(value);
    if (!player || !rt || !loadout) return false;
    if (this.phase === 'playing') { rt.pendingLoadout = loadout; return true; }
    rt.pendingLoadout = null; player.loadout = loadout; this.equip(player); return true;
  }
  /** Queues one frame. Frames are simulated once each, in sequence order, one 1/30 s step apiece (see updatePlayer).
   * A frame's presses are its rising edges against the frame before it, so a tap between two ticks is kept. */
  acceptInput(id: string, input: InputFrame, now = Date.now()): boolean {
    const runtime = this.runtime.get(id);
    // Pre-round input must not arm an action for the first live simulation tick.
    if (this.phase !== 'playing' || !this.players.get(id)?.connected || !runtime || input.seq <= runtime.input.seq) return false;
    const previous = runtime.input, presses: PressAction[] = PRESS_KEYS.filter(action => input[action] && !previous[action]);
    if (input.streak && input.streak !== previous.streak) presses.push('streak');
    runtime.queue.push({ input: { ...input }, receivedAt: now, presses });
    runtime.arrivals.push({ at: now, seq: input.seq }); if (runtime.arrivals.length > STREAM_FRAMES) runtime.arrivals.shift();
    // A long stall delivers its backlog at once. Bound the delay: drop the oldest movement (see dropFrame).
    while (runtime.queue.length > INPUT_QUEUE_LIMIT + Math.round(runtime.playout / FRAME_MS)) this.dropFrame(runtime);
    runtime.input = input; runtime.receivedAt = now; return true;
  }
  start(now = Date.now()): void { this.resetRound('countdown', now); }
  /** Reset the visible round before clients load their scenes, without starting a clock. */
  prepare(now = Date.now()): void { this.resetRound('preparing', now); }
  beginPreparedCountdown(now = Date.now()): void {
    if (this.phase !== 'preparing') throw new Error('This round is not preparing.');
    if (!hasMatchOpponents(this.players.values())) throw new Error('You need another player or an AI rival before starting.');
    this.phase = 'countdown'; this.countdownUntil = now + RULES.countdownMs;
    for (const player of this.players.values()) player.protectedUntil = this.countdownUntil + RULES.protectionMs;
  }
  cancelPreparation(): void {
    if (this.phase !== 'preparing') return;
    this.phase = 'waiting'; this.countdownUntil = 0;
    for (const player of this.players.values()) player.protectedUntil = 0;
  }
  finish(reason: string, now = Date.now(), abandoned = false): void {
    if (this.phase === 'finished') return;
    this.phase = 'finished'; this.endedAt = now;
    this.grenades.length = 0; this.drones.length = 0; this.recon.length = 0; this.mortars.length = 0;
    const eligible = [...this.players.values()].filter((p) => this.bots || !p.bot);
    this.winningTeam = undefined;
    if (abandoned) this.winnerIds = [];
    else if (this.mode === 'tdm') {
      const { teal, gold } = this.teamScores;
      this.winningTeam = teal === gold ? undefined : teal > gold ? 'teal' : 'gold';
      this.winnerIds = eligible.filter(p => !this.winningTeam || p.team === this.winningTeam).map(p => p.id);
    } else {
      const maxKills = Math.max(0, ...eligible.map((p) => p.kills));
      this.winnerIds = eligible.filter((p) => p.kills === maxKills).map((p) => p.id);
    }
    this.onFinish(reason);
  }
  step(now: number, dt: number): void {
    this.tick++;
    if (this.phase === 'countdown' && now >= this.countdownUntil) { this.phase = 'playing'; this.startedAt = now; }
    if (this.phase !== 'playing') return;
    if (now - this.startedAt >= RULES.matchSeconds * 1000) { this.finish('Time is up.', now); return; }
    const botsActive = !!this.bots && [...this.players.values()].some(p => !p.bot && p.connected);
    if (this.bots) {
      if (!botsActive) this.bots.reset();
      // Plan against one common state before any player moves, keeping the same simultaneous-shot
      // fairness as human versus human matches.
      const observed = [...this.players.values()];
      for (const player of observed) if (player.bot && player.connected && player.health > 0) {
        const seq = this.runtime.get(player.id)!.input.seq + 1;
        if (botsActive) this.acceptInput(player.id, normalizeFrame(this.bots.input(player, observed, now, dt, seq, this.mode), seq, now), now);
        else this.freeze(player);
      }
    }
    const actions: TickActions = { shots: [], melees: [] };
    for (const player of this.players.values()) {
      if (player.bot && !botsActive) continue;
      if (player.health <= 0) { if (now >= player.respawnAt && player.connected) this.respawn(player, now); continue; }
      // A dropped player stays a frozen body that can be hit, and heals only as an idle player would, so leaving
      // mid-fight neither dodges the kill nor brings anyone back fresh.
      if (!player.connected) { this.regenerate(player, this.runtime.get(player.id)!, now); continue; }
      this.updatePlayer(player, now, dt, actions);
    }
    for (const player of this.players.values()) if (player.health > 0) this.record(player, now);
    for (const drone of this.drones) Object.assign(drone, this.dronePose(drone, now));
    // Every player has moved and every valid action was accepted before any ray is traced. Damage applies
    // only after all of them, so join order cannot stop a rival's valid shot in the same tick.
    const hits: PendingHit[] = [], droneHits: DroneHit[] = [];
    for (const shot of actions.shots) this.traceShot(shot, now, hits, droneHits);
    for (const melee of actions.melees) this.traceMelee(melee, now, hits);
    this.advanceExplosives(now, hits);
    this.fireDrones(now, hits);
    this.resolve(hits, droneHits, now);
    this.expireRecon(now);
    this.checkScoreLimit(now);
  }
  /** Applies damage at once, outside a tick, with the same rules as tick resolution. */
  damage(target: PlayerState, attacker: PlayerState, amount: number, now: number, cause: DamageCause = 'bullet'): void {
    if (!this.runtime.has(attacker.id) || !this.runtime.has(target.id)) return;
    const life = this.runtime.get(attacker.id)!.life;
    const hit: PendingHit = { attacker, target, amount, cause, from: eyePosition(attacker), life, ...(cause === 'bullet' ? { weapon: attacker.weapon, slot: attacker.slot, zone: 'torso' as const } : {}) };
    this.resolve([hit], [], now);
    this.checkScoreLimit(now);
  }
  /** World state for one viewer: everyone's public state, plus the viewer's full state as `self`. */
  snapshot(now = Date.now(), viewerId?: string): WorldSnapshot {
    const viewer = viewerId ? this.players.get(viewerId) : undefined;
    return {
      roundId: this.id, tick: this.tick, serverTime: Math.round(now), phase: this.phase,
      timeRemaining: this.phase === 'countdown' ? Math.max(0, (this.countdownUntil - now) / 1000) : this.phase === 'playing' ? Math.max(0, RULES.matchSeconds - (now - this.startedAt) / 1000) : this.phase === 'waiting' || this.phase === 'preparing' ? RULES.matchSeconds : 0,
      mode: this.mode, scoreLimit: this.scoreLimit,
      ...(this.mode === 'tdm' ? { teamScores: { ...this.teamScores } } : {}),
      players: [...this.players.values()].map(publicState),
      ...(viewer ? { self: privateState(viewer) } : {}),
      winnerIds: [...this.winnerIds], ...(this.winningTeam ? { winningTeam: this.winningTeam } : {}),
      drones: this.drones.map(d => ({ id: d.id, ownerId: d.ownerId, ...(d.team ? { team: d.team } : {}), x: r3(d.x), y: r3(d.y), z: r3(d.z), yaw: r4(d.yaw), health: Math.max(0, Math.round(d.health)), until: Math.round(d.until) })),
      recon: this.recon.map(r => ({ ownerId: r.ownerId, ...(r.team ? { team: r.team } : {}), until: Math.round(r.until) })),
      mortars: this.mortars.map(m => ({ id: m.id, ownerId: m.ownerId, ...(m.team ? { team: m.team } : {}), x: r3(m.x), z: r3(m.z), impacts: m.impacts.map(Math.round) })),
    };
  }

  // ---- Round and roster ----------------------------------------------------------------------
  private resetRound(phase: 'preparing' | 'countdown', now: number): void {
    if (this.phase !== 'waiting' && this.phase !== 'finished') throw new Error('This match has already started.');
    if (!hasMatchOpponents(this.players.values())) throw new Error('You need another player or an AI rival before starting.');
    this.id = randomUUID(); this.phase = phase; this.countdownUntil = phase === 'countdown' ? now + RULES.countdownMs : 0;
    this.startedAt = 0; this.endedAt = 0; this.winnerIds = []; this.winningTeam = undefined; this.tick = 0;
    this.teamScores = { teal: 0, gold: 0 }; this.firstStrike = false; this.entityCount = 0;
    this.grenades.length = 0; this.drones.length = 0; this.recon.length = 0; this.mortars.length = 0;
    this.bots?.reset(this.practiceSeed ?? privateSeed());
    this.balanceTeams(true);
    // Spawns only weigh players already placed for this round, not where they stood last round.
    const placed = new Set<string>();
    for (const player of this.players.values()) {
      const rt = this.runtime.get(player.id)!;
      Object.assign(player, { kills: 0, deaths: 0, assists: 0, score: 0, streak: 0, rewards: [] });
      rt.lastKilledBy = null;
      this.respawn(player, this.countdownUntil || now, false, placed); placed.add(player.id);
      player.lastInputSeq = rt.input.seq;
      if (phase === 'preparing') player.protectedUntil = 0;
    }
  }
  /** Team deathmatch keeps humans split evenly, then seats bots to even the sides. Once a round is set up, and
   * while its results are on screen, only newcomers are seated, so nobody changes sides under the other players
   * (a winner must not be shown the loss). Every start and rematch reseats everyone (resetRound). */
  private balanceTeams(reseat = this.phase === 'waiting') {
    if (this.mode !== 'tdm') return;
    const roster = [...this.players.values()].map(player => ({ player, rt: this.runtime.get(player.id)! }));
    const count = (team: Team, human?: boolean) => roster.filter(({ player }) => player.team === team && (human === undefined || !player.bot === human)).length;
    const pick = (human: boolean): Team => {
      const order: Array<(team: Team) => number> = human ? [team => count(team, true), team => count(team)] : [team => count(team), team => count(team, false)];
      for (const measure of order) { const teal = measure('teal'), gold = measure('gold'); if (teal !== gold) return teal < gold ? 'teal' : 'gold'; }
      return 'teal';
    };
    for (const { player } of roster) if (!player.bot && !player.team) player.team = pick(true);
    if (reseat) {
      // Departures can leave the humans lopsided; move the newest movable human across.
      for (let guard = 0; guard < RULES.maxPlayers; guard++) {
        const teal = count('teal', true), gold = count('gold', true);
        if (Math.abs(teal - gold) <= 1) break;
        const from: Team = teal > gold ? 'teal' : 'gold';
        const movable = roster.filter(({ player, rt }) => !player.bot && player.team === from && !rt.explicitTeam).at(-1);
        if (!movable) break;
        movable.player.team = from === 'teal' ? 'gold' : 'teal';
      }
      for (const { player, rt } of roster) if (player.bot && !rt.explicitTeam) player.team = undefined;
    }
    for (const { player } of roster) if (player.bot && !player.team) player.team = pick(false);
  }
  /** Forgets queued frames and held buttons (spawn, disconnect, reconnect): nothing from before can replay. */
  private releaseControls(rt: Runtime) {
    rt.queue = []; rt.presses = {}; rt.fireDown = false; rt.jumpDown = false; rt.crouchDown = false; rt.aimSince = null; rt.triggerPending = false;
  }
  /** A spawn or reconnect starts the player's clock afresh on the tick; the first frame sets it (see updatePlayer). */
  private resetClock(player: PlayerState, rt: Runtime, now: number) {
    rt.clock = now; this.endStream(rt); rt.earlySince = now;
    player.lastInputTime = now;
  }
  /** The connection went quiet, or the life ended: the next frames start a stream (and its clock) afresh. */
  private endStream(rt: Runtime) {
    rt.clockSeq = null; rt.arrivals = []; rt.streaming = false; rt.checked = 0; rt.earliest = -Infinity; rt.slew = 0; rt.playout = 0; rt.late = false;
  }
  /** Starts a stream once frames come at about 30 a second. Placed on a 30 Hz grid, the recent frames show when the
   * next one is due without delay (the earliest of them: a frame held back by a spike would set the clock late) and
   * how much they jitter. The next frame's clock is that due time, the frames after it follow one step each, and the
   * playout starts out covering the jitter seen. */
  private startStream(rt: Runtime, now: number) {
    const arrivals = rt.arrivals, head = rt.queue[0];
    if (!head || arrivals.length < STREAM_FRAMES || arrivals[0]!.at <= now - STREAM_WINDOW_MS || arrivals.at(-1)!.at - arrivals[0]!.at < STREAM_SPREAD_MS) return;
    if (arrivals.some((arrival, i) => i > 0 && arrival.at - arrivals[i - 1]!.at > STREAM_GAP_MS)) return;
    const due = arrivals.map(arrival => arrival.at + (head.input.seq - arrival.seq) * FRAME_MS), earliest = Math.min(...due), jitter = Math.max(...due) - earliest;
    rt.streaming = true; rt.clockSeq = null; rt.startAt = earliest; rt.checked = 0; rt.earliest = -Infinity; rt.slew = 0;
    rt.playout = jitter < FRAME_MS / 4 ? 0 : Math.min(MAX_PLAYOUT_MS, Math.ceil(jitter / FRAME_MS) * FRAME_MS); rt.late = false; rt.earlySince = now;
  }
  /** Drops the oldest queued frame's movement but keeps its presses (one per action) for the next simulated frame,
   * so no tap is lost. Its sequence number still counts one step of the player's clock. */
  private dropFrame(rt: Runtime) {
    const dropped = rt.queue.shift()!;
    for (const action of dropped.presses) rt.presses[action] ??= { input: dropped.input, receivedAt: dropped.receivedAt };
  }
  /** Disconnected players and idle bots stop where they are; a grenade being cooked goes back in the pouch. */
  private freeze(player: PlayerState) {
    const rt = this.runtime.get(player.id)!;
    rt.input = { ...idleInput(rt.input.seq), yaw: player.yaw, pitch: player.pitch, slot: player.slot }; rt.receivedAt = 0; this.releaseControls(rt);
    this.cancelReload(player, rt);
    if (player.cookingSince > 0) { player.cookingSince = 0; player.frags++; }
    player.vx = 0; player.vy = 0; player.vz = 0; player.aiming = false; player.sprinting = false; player.dashing = false;
  }
  private equip(player: PlayerState) {
    const primary = WEAPONS[player.loadout.primary], secondary = WEAPONS[player.loadout.secondary];
    player.slot = 1; player.weapon = primary.id;
    player.mag = [primary.magazine, secondary.magazine];
    player.reserve = [reserveFor(primary, player.loadout), reserveFor(secondary, player.loadout)];
    player.frags = RULES.fragsPerLife + (hasPerk(player.loadout, 'deep-pockets') ? 1 : 0);
    player.reloadingUntil = 0; player.reloadSlot = 0; player.cookingSince = 0;
    const rt = this.runtime.get(player.id); if (rt) rt.reload = null;
  }
  private respawn(player: PlayerState, now: number, announce = true, placed?: ReadonlySet<string>) {
    const rt = this.runtime.get(player.id)!;
    if (rt.pendingLoadout) { player.loadout = rt.pendingLoadout; rt.pendingLoadout = null; }
    const spawn = this.chooseSpawn(player, placed);
    Object.assign(player, {
      x: spawn.x, y: spawn.y, z: spawn.z, yaw: spawn.yaw, pitch: 0, vx: 0, vy: 0, vz: 0, ...moveDefaults(), health: RULES.health,
      respawnAt: 0, protectedUntil: now + RULES.protectionMs, meleeUntil: 0, lastDamageAt: 0, aiming: false,
    });
    this.equip(player);
    // A round start raises weapons during the countdown; a respawn raises the primary now.
    player.readyAt = placed ? now : now + WEAPONS[player.loadout.primary].raiseMs * handling(player.loadout);
    if (player.bot) this.bots?.forget(player.id);
    rt.reload = null; rt.nextFireAt = [-Infinity, -Infinity]; rt.lastSprintAt = -Infinity; rt.lastSprintDash = false; this.releaseControls(rt);
    // Multi-kills pair kills from one life only.
    rt.chain = 0; rt.lastKillAt = -Infinity;
    rt.input = { ...idleInput(rt.input.seq), yaw: player.yaw, pitch: 0 }; rt.receivedAt = 0; this.resetClock(player, rt, now);
    rt.history = [{ t: now, x: player.x, y: player.y, z: player.z, posture: player.posture }]; rt.aliveSince = now; rt.life++;
    rt.regenStart = NaN; rt.damageBy.clear();
    if (announce) this.onEvent({ type: 'respawn', playerId: player.id, at: now });
  }
  private hostile(a: { id: string; team?: Team }, b: { id: string; team?: Team }) {
    return a.id !== b.id && (this.mode !== 'tdm' || !a.team || !b.team || a.team !== b.team);
  }
  /** Spawns no living enemy can see come first (eye to chest), then unoccupied ones, then the farthest from enemies.
   * Team deathmatch prefers each team's own house side: a round always starts there, and a respawn crosses to the
   * far side only when enemies can see every home spawn and a far one is hidden. A round start spreads players over
   * free spawns before anything else (everyone is protected through the countdown), so teammates never stack. */
  private chooseSpawn(player: PlayerState, placed?: ReadonlySet<string>) {
    const others = [...this.players.values()].filter(p => p.id !== player.id && p.health > 0 && p.connected && (!placed || placed.has(p.id)));
    const enemies = others.filter(p => this.hostile(player, p)), eyes = enemies.map(eyePosition);
    const home = (spawn: Vec3) => this.mode !== 'tdm' || !player.team || (player.team === 'teal' ? spawn.x < 0 : spawn.x > 0);
    const candidates = placed ? SPAWNS.filter(home) : SPAWNS;
    const scored = candidates.map((spawn, index) => ({
      spawn, index, away: !home(spawn),
      seen: eyes.some(eye => lineClear(eye, { x: spawn.x, y: spawn.y + SPAWN_CHEST, z: spawn.z })),
      occupied: others.some(other => Math.hypot(other.x - spawn.x, other.z - spawn.z) < 1.5),
      distance: enemies.length ? Math.min(...enemies.map(enemy => Math.hypot(enemy.x - spawn.x, enemy.z - spawn.z))) : 0,
    }));
    const free = (a: typeof scored[number], b: typeof scored[number]) => Number(a.occupied) - Number(b.occupied);
    scored.sort((a, b) => (placed ? free(a, b) : 0) || Number(a.seen) - Number(b.seen) || Number(a.away) - Number(b.away) || free(a, b)
      || b.distance - a.distance || a.index - b.index);
    return scored[0]!.spawn;
  }
  private record(player: PlayerState, now: number) {
    const history = this.runtime.get(player.id)!.history, last = history[history.length - 1];
    const sample: HistorySample = { t: now, x: player.x, y: player.y, z: player.z, posture: player.posture };
    if (last && last.t >= now) history[history.length - 1] = sample; else history.push(sample);
    while (history.length > 2 && history[1]!.t <= now - RULES.positionHistoryMs) history.shift();
  }
  /** Where a player was at server time `t`, interpolated from the per-tick history (posture from the nearer tick). */
  private poseAt(player: PlayerState, t: number, now: number): Pose {
    const history = this.runtime.get(player.id)!.history;
    if (t >= now || !history.length) return { x: player.x, y: player.y, z: player.z, posture: player.posture };
    for (let i = history.length - 1; i > 0; i--) {
      const a = history[i - 1]!, b = history[i]!;
      if (t < a.t) continue;
      if (t >= b.t) return { x: b.x, y: b.y, z: b.z, posture: b.posture };
      const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
      return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), z: lerp(a.z, b.z, k), posture: k < 0.5 ? a.posture : b.posture };
    }
    const first = history[0]!;
    return { x: first.x, y: first.y, z: first.z, posture: first.posture };
  }
  /** Enemies a shooter could hit, rewound to what the shooter was drawing. Nobody is hittable before they spawned;
   * a disconnected player's frozen body still is. */
  private rewound(shooter: PlayerState, t: number, now: number): Array<{ player: PlayerState; pose: Pose }> {
    const targets: Array<{ player: PlayerState; pose: Pose }> = [];
    for (const player of this.players.values()) {
      if (player.health <= 0 || !this.hostile(shooter, player)) continue;
      if (t < this.runtime.get(player.id)!.aliveSince) continue;
      targets.push({ player, pose: this.poseAt(player, t, now) });
    }
    return targets;
  }
  /** A roll in [0, 1). Real rooms use a cryptographic source: a hash of anything a client can see (the round id is in
   * every snapshot) would let a modified page predict spread, drone misses and mortar scatter. Only an explicit
   * practice seed (tests) gives the repeatable hash. */
  private random(key: string, holder: { random: number }): number {
    if (this.practiceSeed === undefined) { holder.random++; return randomInt(0x100000000) / 0x100000000; }
    let hash = 2166136261;
    for (const character of `${this.practiceSeed}:${key}:${holder.random++}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b); hash ^= hash >>> 13; hash = Math.imul(hash, 0xc2b2ae35); hash ^= hash >>> 16;
    return (hash >>> 0) / 4294967296;
  }

  // ---- One player's tick ---------------------------------------------------------------------
  /** The client predicts exactly one 1/30 s step per frame it sends, so a person's frames are simulated the same
   * way: each once, in order, up to FRAMES_PER_TICK per tick while wall-clock credit allows (a backlog catches up,
   * a fast sender gains nothing). With no frame to run the body holds still, as the prediction does, until the
   * connection has been silent for INPUT_TIMEOUT_MS; then the player stands down as before.
   *
   * A streaming player (about 30 frames a second arriving) keeps a clock of their own: each frame is one FRAME_MS
   * step after the frame before it, by sequence number, exactly as the client predicts, and it runs on the first tick
   * that reaches its clock plus a playout. The playout grows a frame when a frame comes late, so the next late frame
   * finds one waiting and other players see a steady body instead of a stop and a double step; it shrinks after
   * PLAYOUT_RELAX_MS of frames arriving a tick early. A clock left CLOCK_RESET_MS behind the tick is put back on it.
   * Until a player streams (the first frames of a life, a sparse or stalled sender) frames run as they come, on the
   * tick's clock. A rival's brain hands over one frame per tick, simulated with the tick's own clock and dt. */
  private updatePlayer(player: PlayerState, now: number, dt: number, actions: TickActions) {
    const rt = this.runtime.get(player.id)!;
    this.regenerate(player, rt, now);
    if (player.bot) {
      const queued = rt.queue.shift(); rt.queue.length = 0;
      if (queued) this.simulate(player, rt, queued, now, now, dt, actions);
      return;
    }
    rt.credit = Math.min(FRAME_CREDIT_MS, rt.credit + Math.max(0, now - rt.creditAt)); rt.creditAt = now;
    if (!rt.streaming) this.startStream(rt, now);
    let simulated = 0;
    while (rt.queue.length && simulated < FRAMES_PER_TICK && rt.credit >= FRAME_MS - 1e-6) {
      const queued = rt.queue[0]!, behind = rt.queue.length - 1, own = rt.streaming && rt.clockSeq !== null;
      let clock: number;
      if (own) {
        const strict = rt.clock + (queued.input.seq - rt.clockSeq!) * FRAME_MS, onTick = now - behind * FRAME_MS - rt.playout;
        // Not due yet: wait. A full queue (a sender running ahead of real time) or a clock far ahead of the tick (a
        // jump in sequence numbers) cannot hold the player up, though: those run now, on the tick's clock.
        const forced = rt.queue.length >= INPUT_QUEUE_LIMIT + Math.round(rt.playout / FRAME_MS) || strict > now + CLOCK_RESET_MS;
        if (strict + rt.playout > now + CLOCK_TOLERANCE_MS && !forced) break;
        // The clock waits out a vault or slide before it moves, where even a millisecond shows.
        const step = player.vault || player.posture === 'slide' ? 0 : Math.max(-CLOCK_SLEW_MS, Math.min(CLOCK_SLEW_MS, rt.slew));
        rt.slew -= step;
        clock = Math.min(now, Math.max(rt.clock, strict < onTick - CLOCK_RESET_MS ? onTick : strict + step));
        // The clock check (see CLOCK_CHECK_FRAMES): how long before its clock the least delayed frame arrived.
        rt.earliest = Math.max(rt.earliest, clock - queued.receivedAt);
        if (++rt.checked >= CLOCK_CHECK_FRAMES) {
          rt.slew = rt.earliest > 2 * FRAME_MS ? FRAME_MS - rt.earliest : rt.earliest < -FRAME_MS ? -rt.earliest : 0;
          rt.checked = 0; rt.earliest = -Infinity;
        }
      } else if (rt.streaming) clock = Math.min(now, Math.max(rt.clock, rt.startAt)); // The frame that starts a stream.
      else clock = Math.min(now, Math.max(now - behind * FRAME_MS, rt.clock + FRAME_MS));
      rt.queue.shift(); rt.credit -= FRAME_MS; simulated++;
      // A frame that came less than a tick before it ran needed the playout.
      if (own && now - queued.receivedAt < FRAME_MS - CLOCK_TOLERANCE_MS) rt.earlySince = now;
      this.simulate(player, rt, queued, clock, now, FRAME_SECONDS, actions);
      rt.clockSeq = queued.input.seq;
    }
    if (rt.streaming && rt.clockSeq !== null) {
      if (simulated) rt.late = false;
      else if (!rt.queue.length && rt.clock + FRAME_MS + rt.playout <= now + CLOCK_TOLERANCE_MS) {
        // The next frame is late. From now on run a frame further behind, so the next late frame finds one waiting.
        if (!rt.late) rt.playout = Math.min(MAX_PLAYOUT_MS, rt.playout + FRAME_MS);
        rt.late = true; rt.earlySince = now;
      }
      if (rt.playout > 0 && now - rt.earlySince >= PLAYOUT_RELAX_MS) { rt.playout = Math.max(0, rt.playout - FRAME_MS); rt.earlySince = now; }
    }
    if (simulated) return;
    if (!rt.queue.length && now - rt.receivedAt > INPUT_TIMEOUT_MS) {
      // A silent connection brakes and falls, keeping its view, weapon and any cooked frag. Its clock starts afresh.
      const idle: QueuedFrame = { input: { ...idleInput(rt.input.seq), yaw: player.yaw, pitch: player.pitch, slot: player.slot, viewTime: now }, receivedAt: now, presses: [] };
      this.simulate(player, rt, idle, now, now, dt, actions, false);
      this.endStream(rt);
      return;
    }
    // Waiting for a frame: nothing moves. Off the stream a reload still finishes on the tick; a streaming player's
    // reload finishes on their own clock, with their next frame.
    if (!rt.streaming) this.advanceReload(player, rt, now);
  }
  /** One frame, completely and in order, at its own server time `now`: presses, swap, knife, cook, move, throw,
   * reward, reload and trigger. Shots and knife swings are traced once every player has moved, from where this
   * frame left the player. `real` is false for a silent connection's idle frame, which never releases a frag. */
  private simulate(player: PlayerState, rt: Runtime, queued: QueuedFrame, now: number, tickNow: number, dt: number, actions: TickActions, real = true) {
    const input = queued.input, frameActions: FrameActions = { shots: [], melees: [] };
    rt.clock = now; player.lastInputTime = now;
    const take = (action: PressAction): InputFrame | undefined => {
      const own = queued.presses.includes(action), kept = rt.presses[action]; delete rt.presses[action];
      if (kept && tickNow - kept.receivedAt <= INPUT_TIMEOUT_MS) {
        // A press from a dropped frame goes first; this frame's own press of the same action waits one frame.
        if (own) rt.presses[action] = { input, receivedAt: queued.receivedAt };
        return kept.input;
      }
      return own ? input : undefined;
    };
    const firePress = take('fire'), jumpPress = take('jump'), reloadPress = take('reload'), crouchPress = take('crouch');
    const meleePress = take('melee'), grenadePress = take('grenade'), streakPress = take('streak');
    player.lastInputSeq = input.seq;
    this.advanceReload(player, rt, now);
    // A press made with the weapon held at the start of the frame fires before a swap in the same frame;
    // a press made after the swap waits for the new weapon to come up.
    const earlyPress = firePress && firePress.slot === player.slot ? firePress : undefined;
    if (earlyPress) this.tryFire(player, rt, earlyPress, now, frameActions);
    if (input.slot !== player.slot) this.swap(player, rt, input.slot, now);
    // The knife and a cook start before moving, so they stop a sprint in the same frame.
    if (meleePress) this.tryMelee(player, rt, meleePress, now, frameActions);
    if (grenadePress) this.startCook(player, rt, now);
    const spec = weaponFor(player.loadout, player.slot);
    movePlayer(player, { ...input, fire: input.fire || !!firePress }, {
      now, dt, jumpPressed: !!jumpPress || (input.jump && !rt.jumpDown), crouchPressed: !!crouchPress || (input.crouch && !rt.crouchDown),
      moveFactor: spec.moveFactor, adsFactor: spec.adsMoveFactor, canSprint: player.cookingSince <= 0 && now >= player.meleeUntil,
    });
    if (player.sprinting) { rt.lastSprintAt = now; rt.lastSprintDash = !!player.dashing; }
    player.aiming = input.aim && !player.sprinting;
    // Only a real frame releases a cooked grenade. A stalled connection keeps it in hand while the fuse runs,
    // instead of throwing it wherever the player last looked.
    if (real && player.cookingSince > 0 && !input.grenade) this.throwGrenade(player, rt, input, now);
    if (streakPress) this.useReward(player, streakPress, now);
    if (input.reload || reloadPress?.slot === player.slot) this.startReload(player, rt, now);
    if (!earlyPress) {
      const frame = firePress && firePress.slot === player.slot ? firePress : (spec.auto || rt.triggerPending) && input.fire && input.slot === player.slot ? input : undefined;
      if (frame) this.tryFire(player, rt, frame, now, frameActions);
    }
    // Aim time is read after the trigger: a shot keeps the aim it was pressed with even when this frame lets go.
    if (!input.aim) rt.aimSince = null; else if (rt.aimSince === null) rt.aimSince = now;
    if (!input.fire) rt.triggerPending = false;
    rt.fireDown = input.fire; rt.jumpDown = input.jump; rt.crouchDown = input.crouch;
    const origin: Pose = { x: player.x, y: player.y, z: player.z, posture: player.posture };
    for (const shot of frameActions.shots) actions.shots.push({ ...shot, origin });
    for (const melee of frameActions.melees) actions.melees.push({ ...melee, origin });
  }
  /** Health refills after a pause out of combat (shorter with Second Wind). Integer health, a function of time only. */
  private regenerate(player: PlayerState, rt: Runtime, now: number) {
    if (player.health <= 0 || player.health >= RULES.health) return;
    const start = player.lastDamageAt + (hasPerk(player.loadout, 'second-wind') ? RULES.secondWindRegenDelayMs : RULES.regenDelayMs);
    if (now < start) return;
    if (rt.regenStart !== start) { rt.regenStart = start; rt.regenBase = player.health; }
    player.health = Math.max(player.health, Math.min(RULES.health, Math.floor(rt.regenBase + RULES.regenPerSecond * (now - start) / 1000)));
    if (player.health >= RULES.health) rt.damageBy.clear();
  }
  private swap(player: PlayerState, rt: Runtime, slot: Slot, now: number) {
    player.slot = slot; player.weapon = weaponFor(player.loadout, slot).id;
    this.cancelReload(player, rt); rt.triggerPending = false;
    player.readyAt = Math.max(player.readyAt, now + WEAPONS[player.weapon].raiseMs * handling(player.loadout));
  }
  private cancelReload(player: PlayerState, rt: Runtime) { rt.reload = null; player.reloadingUntil = 0; player.reloadSlot = 0; }
  private startReload(player: PlayerState, rt: Runtime, now: number) {
    if (player.reloadingUntil || player.cookingSince > 0 || now < player.meleeUntil) return;
    const slot = player.slot, index = slot - 1, spec = weaponFor(player.loadout, slot);
    const missing = spec.magazine - player.mag[index]!, spare = player.reserve[index]!;
    if (missing <= 0 || spare <= 0) return;
    const k = handling(player.loadout);
    rt.reload = { slot, start: now, shells: 0 }; player.reloadSlot = slot;
    player.reloadingUntil = now + (spec.perShellMs
      ? ((spec.shellStartMs ?? 0) + Math.min(missing, spare) * spec.perShellMs) * k
      : (player.mag[index] === 0 ? spec.emptyReloadMs : spec.reloadMs) * k);
  }
  private advanceReload(player: PlayerState, rt: Runtime, now: number) {
    const reload = rt.reload;
    if (!reload || !player.reloadingUntil) return;
    const index = reload.slot - 1, spec = weaponFor(player.loadout, reload.slot), k = handling(player.loadout);
    if (spec.perShellMs) {
      // Shell n goes in at start + (shellStartMs + n × perShellMs); a shot can stop the reload between shells.
      while (player.mag[index]! < spec.magazine && player.reserve[index]! > 0 && reload.start + ((spec.shellStartMs ?? 0) + (reload.shells + 1) * spec.perShellMs) * k <= now) {
        player.mag[index]!++; player.reserve[index]!--; reload.shells++;
      }
      if (player.mag[index]! >= spec.magazine || player.reserve[index]! <= 0) this.cancelReload(player, rt);
    } else if (now >= player.reloadingUntil) {
      const take = Math.min(spec.magazine - player.mag[index]!, player.reserve[index]!);
      player.mag[index]! += take; player.reserve[index]! -= take; this.cancelReload(player, rt);
    }
  }
  private adsProgress(player: PlayerState, rt: Runtime, frame: InputFrame, spec: WeaponSpec, now: number) {
    if (!frame.aim || rt.aimSince === null) return 0;
    const time = spec.adsMs * (hasPerk(player.loadout, 'steady-aim') ? STEADY_AIM_ADS_FACTOR : 1);
    return clamp((now - rt.aimSince) / Math.max(1, time), 0, 1);
  }
  private tryFire(player: PlayerState, rt: Runtime, frame: InputFrame, now: number, actions: FrameActions): boolean {
    const slot = player.slot, index = slot - 1, spec = weaponFor(player.loadout, slot);
    // Only a shell-by-shell reload with something loaded gives way to the trigger, and only once a shot goes off.
    if (player.reloadingUntil && (!spec.perShellMs || player.mag[index]! <= 0)) return false;
    if (player.cookingSince > 0) return false;
    // Too early: a semi-automatic press is kept while the trigger stays down, then fires once.
    const early = now < player.meleeUntil || now < player.readyAt || vaultProgress(player, now) < VAULT_FIRE_PROGRESS
      || now < rt.lastSprintAt + spec.sprintToFireMs * (rt.lastSprintDash ? DASH_SPRINT_TO_FIRE : 1) || now < rt.nextFireAt[index]!;
    if (early) { if (!spec.auto && player.mag[index]! > 0) rt.triggerPending = true; return false; }
    if (player.mag[index]! <= 0) { this.startReload(player, rt, now); return false; }
    if (player.reloadingUntil) this.cancelReload(player, rt);
    // Held automatic fire accumulates the interval so 30 Hz ticks keep the true rate; a new pull starts fresh,
    // so idle time never banks extra shots. Semi-automatic rounds are always a full interval apart.
    const interval = fireIntervalMs(spec), continuous = spec.auto && rt.fireDown && now - rt.nextFireAt[index]! < interval;
    rt.nextFireAt[index] = (continuous ? rt.nextFireAt[index]! : now) + interval;
    player.mag[index]!--; player.protectedUntil = 0; rt.triggerPending = false;
    actions.shots.push({ player, frame, spec, slot, ads: this.adsProgress(player, rt, frame, spec, now) });
    return true;
  }
  private tryMelee(player: PlayerState, rt: Runtime, frame: InputFrame, now: number, actions: FrameActions) {
    if (now < player.meleeUntil || player.cookingSince > 0 || player.vault) return;
    player.meleeUntil = now + RULES.meleeMs; player.readyAt = Math.max(player.readyAt, player.meleeUntil);
    this.cancelReload(player, rt); player.protectedUntil = 0;
    actions.melees.push({ player, frame });
  }
  private startCook(player: PlayerState, rt: Runtime, now: number) {
    if (player.cookingSince > 0 || player.frags <= 0 || now < player.meleeUntil || player.vault) return;
    player.cookingSince = now; player.frags--; this.cancelReload(player, rt);
  }
  private throwGrenade(player: PlayerState, rt: Runtime, input: InputFrame, now: number) {
    const throwFrom = grenadeLaunch(eyePosition(player), input.yaw, input.pitch, player, EXPLOSIVES.frag.throwSpeed, EXPLOSIVES.frag.throwLift);
    this.launchGrenade(player, rt, throwFrom.from, throwFrom.velocity, now); player.protectedUntil = 0;
  }
  /** The published launch is rounded first so every client replays exactly the server's trajectory. */
  private launchGrenade(player: PlayerState, rt: Runtime, from: Vec3, velocity: Vec3, now: number) {
    const id = `frag-${++this.entityCount}`, start = r3v(from), launch = r3v(velocity), explodeAt = Math.round(player.cookingSince + EXPLOSIVES.frag.fuseMs);
    player.cookingSince = 0;
    this.grenades.push({ id, ownerId: player.id, life: rt.life, thrownAt: now, explodeAt, trajectory: new GrenadeTrajectory(start, launch) });
    this.onEvent({ type: 'grenade', id, playerId: player.id, from: start, velocity: launch, explodeAt, at: now });
  }
  private useReward(player: PlayerState, frame: InputFrame, now: number) {
    const reward = frame.streak, index = reward ? player.rewards.indexOf(reward) : -1;
    if (!reward || index < 0) return;
    const team = player.team ? { team: player.team } : {};
    if (reward === 'mortar') {
      const target = frame.streakTarget;
      if (!target || !insideArena(target.x, target.z)) return;
      player.rewards.splice(index, 1);
      this.mortars.push({ id: `mortar-${++this.entityCount}`, ownerId: player.id, ...team, x: target.x, z: target.z, impacts: EXPLOSIVES.mortar.delaysMs.map(delay => now + delay), next: 0, random: 0 });
      this.onEvent({ type: 'streak', playerId: player.id, reward, action: 'used', target: { x: r3(target.x), z: r3(target.z) }, at: now });
      return;
    }
    player.rewards.splice(index, 1);
    if (reward === 'recon') {
      const active = this.recon.find(r => r.ownerId === player.id);
      if (active) active.until = Math.max(active.until, now + RULES.reconMs); else this.recon.push({ ownerId: player.id, ...team, until: now + RULES.reconMs });
    } else {
      const drone: Drone = { id: `drone-${++this.entityCount}`, ownerId: player.id, ...team, x: 0, y: DRONE.height, z: 0, yaw: 0, health: RULES.droneHealth, until: now + RULES.droneMs, startedAt: now, angle: Math.atan2(player.z, player.x), nextFireAt: now + DRONE.fireIntervalMs, random: 0 };
      Object.assign(drone, this.dronePose(drone, now)); this.drones.push(drone);
    }
    this.onEvent({ type: 'streak', playerId: player.id, reward, action: 'used', at: now });
  }

  // ---- Shots, knife, explosives and the drone -------------------------------------------------
  private dronePose(drone: { startedAt: number; angle: number }, t: number) {
    const angle = drone.angle + DRONE.speed / DRONE.orbitRadius * (t - drone.startedAt) / 1000;
    return { x: Math.cos(angle) * DRONE.orbitRadius, y: DRONE.height, z: Math.sin(angle) * DRONE.orbitRadius, yaw: Math.atan2(-Math.sin(angle), -Math.cos(angle)) };
  }
  private traceShot({ player, frame, spec, slot, ads, origin }: QueuedShot, now: number, hits: PendingHit[], droneHits: DroneHit[]) {
    const rt = this.runtime.get(player.id)!, eye = eyePosition(origin);
    const forward = directionFromAngles(frame.yaw, frame.pitch), right = rightFromYaw(frame.yaw), up = cross(right, forward);
    const offset = (sideways: number, upward: number) => normalize(add(forward, add(scale(right, sideways), scale(up, upward))));
    const directions: Vec3[] = [];
    if (spec.pellets > 1) {
      const cone = spec.pelletSpread ? lerp(spec.pelletSpread.hip, spec.pelletSpread.ads, ads) : 0;
      for (let pellet = 0; pellet < spec.pellets; pellet++) { const [px, py] = PELLET_PATTERN[pellet % PELLET_PATTERN.length]!; directions.push(offset(px * cone, py * cone)); }
    } else {
      // No bloom: a fixed cone per weapon, narrowing as the sights come up. Rolls are seeded per player.
      const cone = lerp(spec.hipSpread, spec.adsSpread, ads);
      if (cone > 0) {
        const radius = Math.tan(cone) * Math.sqrt(this.random(`spread:${player.id}`, rt)), theta = 2 * Math.PI * this.random(`spread:${player.id}`, rt);
        directions.push(offset(Math.cos(theta) * radius, Math.sin(theta) * radius));
      } else directions.push(forward);
    }
    // Opponents and drones are traced where this shooter saw them, at most RULES.lagCompensationMs back.
    const viewTime = clamp(frame.viewTime, now - RULES.lagCompensationMs, now);
    const targets = this.rewound(player, viewTime, now);
    const drones = this.drones.filter(drone => this.hostile(player, { id: drone.ownerId, ...(drone.team ? { team: drone.team } : {}) })).map(drone => ({ drone, pose: this.dronePose(drone, viewTime) }));
    const traces: ShotTrace[] = []; let hit = false;
    for (const direction of directions) {
      const world = raycastMapDetailed(eye, direction, spec.maxRange);
      let distance = world?.distance ?? spec.maxRange;
      let best: { player: PlayerState; zone: HitZone } | { drone: Drone } | null = null;
      for (const { player: target, pose } of targets) {
        const contact = rayHitboxes(eye, direction, pose, distance);
        if (contact && contact.distance < distance) { distance = contact.distance; best = { player: target, zone: contact.zone }; }
      }
      for (const { drone, pose } of drones) {
        const half = DRONE.halfExtents;
        const contact = rayBox(eye, direction, { x: pose.x - half.x, y: pose.y - half.y, z: pose.z - half.z }, { x: pose.x + half.x, y: pose.y + half.y, z: pose.z + half.z }, distance);
        if (contact < distance) { distance = contact; best = { drone }; }
      }
      const to = r3v(add(eye, scale(direction, distance)));
      if (best && 'player' in best) {
        const shielded = best.player.protectedUntil > now;
        traces.push({ to, kind: 'player', targetId: best.player.id, zone: best.zone, protected: shielded });
        if (!shielded) { hit = true; hits.push({ attacker: player, target: best.player, amount: damageAt(spec, distance, best.zone), cause: 'bullet', weapon: spec.id, slot, zone: best.zone, from: eye, life: rt.life }); }
      } else if (best) {
        hit = true; traces.push({ to, kind: 'drone', targetId: best.drone.id });
        droneHits.push({ attacker: player, drone: best.drone, amount: damageAt(spec, distance, 'torso') });
      } else if (world) traces.push({ to: r3v(world.point), kind: 'world', normal: world.normal, surface: world.surface });
      else traces.push({ to, kind: 'range' });
    }
    this.onEvent({ type: 'shot', playerId: player.id, weapon: spec.id, from: r3v(weaponMuzzle(eye, frame.yaw, frame.pitch)), traces, hit, at: now });
  }
  /** The knife finds the nearest enemy in reach and in front, with a clear eye-to-eye line, at rewound positions. */
  private traceMelee({ player, frame, origin }: QueuedMelee, now: number, hits: PendingHit[]) {
    const rt = this.runtime.get(player.id)!, eye = eyePosition(origin);
    let best: { target: PlayerState; distance: number } | null = null;
    for (const { player: target, pose } of this.rewound(player, clamp(frame.viewTime, now - RULES.lagCompensationMs, now), now)) {
      const dx = pose.x - origin.x, dz = pose.z - origin.z, horizontal = Math.hypot(dx, dz);
      if (horizontal > RULES.meleeLungeRange) continue;
      if (horizontal > 0.25 && Math.abs(angleDelta(Math.atan2(dx, -dz), frame.yaw)) > MELEE_HALF_ANGLE) continue;
      if (pose.y > eye.y + 0.6 || pose.y + POSTURE_HEIGHT[pose.posture] < eye.y - 1.7) continue;
      if (!lineClear(eye, eyePosition(pose))) continue;
      if (!best || horizontal < best.distance) best = { target, distance: horizontal };
    }
    this.onEvent({ type: 'melee', playerId: player.id, ...(best ? { targetId: best.target.id } : {}), at: now });
    if (best && best.target.protectedUntil <= now) hits.push({ attacker: player, target: best.target, amount: RULES.meleeDamage, cause: 'melee', zone: 'torso', from: eye, life: rt.life });
  }
  private advanceExplosives(now: number, hits: PendingHit[]) {
    // Holding a cooked grenade past its fuse ends badly.
    for (const player of this.players.values()) if (player.health > 0 && player.cookingSince > 0 && now >= player.cookingSince + EXPLOSIVES.frag.fuseMs) {
      player.cookingSince = 0; this.explode('frag', player, eyePosition(player), now, hits, this.runtime.get(player.id)!.life, `frag-${++this.entityCount}`);
    }
    for (let i = 0; i < this.grenades.length; i++) {
      const grenade = this.grenades[i]!;
      grenade.trajectory.advanceTo(Math.min(now, grenade.explodeAt) - grenade.thrownAt);
      if (now < grenade.explodeAt) continue;
      this.grenades.splice(i--, 1);
      const owner = this.players.get(grenade.ownerId);
      if (owner) this.explode('frag', owner, grenade.trajectory.position, now, hits, grenade.life, grenade.id);
    }
    for (let i = 0; i < this.mortars.length; i++) {
      const mortar = this.mortars[i]!, owner = this.players.get(mortar.ownerId);
      while (owner && mortar.next < mortar.impacts.length && now >= mortar.impacts[mortar.next]!) {
        const radius = EXPLOSIVES.mortar.scatter * Math.sqrt(this.random(`mortar:${mortar.id}`, mortar)), theta = 2 * Math.PI * this.random(`mortar:${mortar.id}`, mortar);
        const x = clamp(mortar.x + Math.cos(theta) * radius, -ARENA_LIMITS.x, ARENA_LIMITS.x), z = clamp(mortar.z + Math.sin(theta) * radius, -ARENA_LIMITS.z, ARENA_LIMITS.z);
        this.explode('mortar', owner, { x, y: highestSurface(x, z), z }, now, hits, -1, `${mortar.id}-${mortar.next + 1}`);
        mortar.next++;
      }
      if (owner && mortar.next < mortar.impacts.length) continue;
      this.mortars.splice(i--, 1);
      this.onEvent({ type: 'streak', playerId: mortar.ownerId, reward: 'mortar', action: 'ended', at: now });
    }
  }
  /** Full damage near the blast, fading to the edge; walls between the blast and the torso stop it.
   * Your own frag can hurt you; your own mortar cannot; teammates are never hurt. */
  private explode(kind: 'frag' | 'mortar', owner: PlayerState, position: Vec3, now: number, hits: PendingHit[], life: number, id: string) {
    this.onEvent({ type: 'explosion', id, playerId: owner.id, cause: kind, position: r3v(position), at: now });
    const origin = { x: position.x, y: position.y + 0.1, z: position.z };
    for (const target of this.players.values()) {
      if (target.health <= 0 || target.protectedUntil > now) continue;
      if (target.id === owner.id ? kind !== 'frag' : !this.hostile(owner, target)) continue;
      const torso = torsoCenter(target), distance = distance3(origin, torso);
      if (distance > EXPLOSIVES[kind].radius || !lineClear(origin, torso)) continue;
      hits.push({ attacker: owner, target, amount: explosionDamage(kind, distance), cause: kind, from: r3v(position), life });
    }
  }
  private fireDrones(now: number, hits: PendingHit[]) {
    for (let i = 0; i < this.drones.length; i++) {
      const drone = this.drones[i]!, owner = this.players.get(drone.ownerId);
      if (!owner || now >= drone.until) {
        this.drones.splice(i--, 1);
        this.onEvent({ type: 'streak', playerId: drone.ownerId, reward: 'drone', action: 'ended', at: now }); continue;
      }
      if (now < drone.nextFireAt) continue;
      drone.nextFireAt = (now - drone.nextFireAt < DRONE.fireIntervalMs ? drone.nextFireAt : now) + DRONE.fireIntervalMs;
      const from = { x: drone.x, y: drone.y, z: drone.z };
      let best: { target: PlayerState; torso: Vec3; distance: number } | null = null;
      for (const target of this.players.values()) {
        if (target.health <= 0 || target.protectedUntil > now || !this.hostile({ id: drone.ownerId, ...(drone.team ? { team: drone.team } : {}) }, target)) continue;
        const torso = torsoCenter(target), distance = distance3(from, torso);
        if (distance > DRONE.range || !lineClear(from, torso)) continue;
        if (!best || distance < best.distance) best = { target, torso, distance };
      }
      if (!best) continue;
      // Seeded hit chance falls off with range.
      const hitsTarget = this.random(`drone:${drone.id}`, drone) < clamp(1.1 - best.distance / DRONE.range, 0.3, 0.9);
      let trace: ShotTrace;
      if (hitsTarget) {
        trace = { to: r3v(best.torso), kind: 'player', targetId: best.target.id, zone: 'torso', protected: false };
        hits.push({ attacker: owner, target: best.target, amount: DRONE.damage, cause: 'drone', zone: 'torso', from: r3v(from), life: -1 });
      } else {
        const theta = 2 * Math.PI * this.random(`drone:${drone.id}`, drone), miss = 1 + this.random(`drone:${drone.id}`, drone);
        const aim = { x: best.torso.x + Math.cos(theta) * miss, y: best.torso.y - 0.4, z: best.torso.z + Math.sin(theta) * miss };
        const direction = normalize(subtract(aim, from)), world = raycastMapDetailed(from, direction, DRONE.range + 15);
        trace = world ? { to: r3v(world.point), kind: 'world', normal: world.normal, surface: world.surface } : { to: r3v(add(from, scale(direction, DRONE.range + 15))), kind: 'range' };
      }
      this.onEvent({ type: 'shot', playerId: owner.id, weapon: 'drone', from: r3v(from), traces: [trace], hit: hitsTarget, at: now });
    }
  }
  private expireRecon(now: number) {
    for (let i = this.recon.length - 1; i >= 0; i--) {
      const recon = this.recon[i]!;
      if (recon.until > now) continue;
      this.recon.splice(i, 1);
      this.onEvent({ type: 'streak', playerId: recon.ownerId, reward: 'recon', action: 'ended', at: now });
    }
  }

  // ---- Damage, eliminations and scoring ------------------------------------------------------
  private resolve(hits: PendingHit[], droneHits: DroneHit[], now: number) {
    this.resolving = true;
    const settle: Settlement = this.settle = { firstStrikeOpen: !this.firstStrike, firstStruck: new Set(), streaks: [], chains: [], evened: [], killedBy: [], anyKill: false };
    try {
      const targets = new Map<string, { target: PlayerState; byAttacker: Map<string, Contribution> }>();
      for (const hit of hits) {
        let entry = targets.get(hit.target.id);
        if (!entry) targets.set(hit.target.id, entry = { target: hit.target, byAttacker: new Map() });
        let contribution = entry.byAttacker.get(hit.attacker.id);
        if (!contribution) entry.byAttacker.set(hit.attacker.id, contribution = { attacker: hit.attacker, amount: 0, top: hit, bullet: { head: 0, torso: 0, legs: 0 } });
        contribution.amount += hit.amount;
        if (hit.amount > contribution.top.amount) contribution.top = hit;
        if (hit.cause === 'bullet' && hit.zone) contribution.bullet[hit.zone] += hit.amount;
      }
      for (const { target, byAttacker } of targets.values()) this.applyDamage(target, [...byAttacker.values()], now);
      const drones = new Map<Drone, Map<string, { attacker: PlayerState; amount: number }>>();
      for (const hit of droneHits) {
        let byAttacker = drones.get(hit.drone);
        if (!byAttacker) drones.set(hit.drone, byAttacker = new Map());
        const entry = byAttacker.get(hit.attacker.id) ?? { attacker: hit.attacker, amount: 0 };
        entry.amount += hit.amount; byAttacker.set(hit.attacker.id, entry);
      }
      for (const [drone, byAttacker] of drones) {
        const index = this.drones.indexOf(drone);
        if (index < 0) continue;
        const contributors = [...byAttacker.values()].map(c => ({ ...c, amount: Math.round(c.amount) }));
        contributors.sort((a, b) => b.amount - a.amount || this.tieBreak(drone.id, a.attacker.id) - this.tieBreak(drone.id, b.attacker.id) || a.attacker.id.localeCompare(b.attacker.id));
        drone.health -= contributors.reduce((total, c) => total + c.amount, 0);
        if (drone.health > 0) continue;
        this.drones.splice(index, 1);
        const destroyer = contributors[0]!.attacker;
        this.onEvent({ type: 'explosion', id: drone.id, playerId: drone.ownerId, cause: 'drone', position: r3v(drone), at: now });
        this.medal(destroyer, 'drone-down', now); this.award(destroyer, 'drone-down', now);
        this.onEvent({ type: 'streak', playerId: drone.ownerId, reward: 'drone', action: 'ended', at: now });
      }
      if (settle.anyKill) this.firstStrike = true;
      // Settle scores first, then remember who downed whom this tick.
      for (const rt of settle.evened) rt.lastKilledBy = null;
      for (const [rt, attackerId] of settle.killedBy) rt.lastKilledBy = attackerId;
      // Multi-kills and streaks only count kills whose maker is still standing once the tick settles, in the same
      // life, so a same-tick trade or a grenade landing after its thrower went down reads the same in any order.
      const standing = ({ player, life }: { player: PlayerState; life: number }) => player.health > 0 && this.runtime.get(player.id)?.life === life;
      for (const kill of settle.chains) if (standing(kill)) this.extendChain(kill.player, now);
      for (const kill of settle.streaks) if (standing(kill)) this.extendStreak(kill.player, now);
    } finally { this.resolving = false; this.settle = null; }
  }
  /** Equal simultaneous contributions use a per-tick hash rather than join order. */
  private tieBreak(targetId: string, attackerId: string) {
    let hash = 2166136261;
    for (const character of `${this.tick}:${targetId}:${attackerId}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    return hash >>> 0;
  }
  /** One damage event per attacker; the target loses the total; the largest contributor gets the elimination. */
  private applyDamage(target: PlayerState, contributions: Contribution[], now: number) {
    if (target.health <= 0 || target.protectedUntil > now) return;
    const rounded = contributions.map(c => ({ ...c, amount: clamp(Math.round(c.amount), 0, 1000) })).filter(c => c.amount > 0);
    if (!rounded.length) return;
    rounded.sort((a, b) => b.amount - a.amount || this.tieBreak(target.id, a.attacker.id) - this.tieBreak(target.id, b.attacker.id) || a.attacker.id.localeCompare(b.attacker.id));
    const rt = this.runtime.get(target.id)!;
    for (const c of rounded) {
      const zone = c.top.cause === 'bullet' ? mainZone(c.bullet) ?? c.top.zone : c.top.zone;
      this.onEvent({ type: 'damage', playerId: target.id, attackerId: c.attacker.id, amount: c.amount, cause: c.top.cause, ...(zone ? { zone } : {}), from: r3v(c.top.from), at: now });
      if (c.attacker.id !== target.id) rt.damageBy.set(c.attacker.id, (rt.damageBy.get(c.attacker.id) ?? 0) + c.amount);
    }
    target.health = Math.max(0, target.health - rounded.reduce((total, c) => total + c.amount, 0));
    target.lastDamageAt = now; rt.regenStart = NaN;
    if (target.health <= 0) this.eliminate(target, rounded[0]!, now);
  }
  private eliminate(target: PlayerState, killer: Contribution, now: number) {
    const settle = this.settle!, rt = this.runtime.get(target.id)!, attacker = killer.attacker, cause = killer.top.cause, suicide = attacker.id === target.id;
    target.deaths++; target.respawnAt = now + RULES.respawnMs; target.streak = 0;
    this.cancelReload(target, rt); target.vx = 0; target.vz = 0; target.aiming = false; target.sprinting = false; target.dashing = false;
    // A grenade being cooked falls live where the player went down.
    if (target.cookingSince > 0) this.launchGrenade(target, rt, eyePosition(target), { x: 0, y: 0, z: 0 }, now);
    const assists = [...rt.damageBy].filter(([id, amount]) => id !== attacker.id && amount >= RULES.assistMinDamage && this.players.has(id)).map(([id]) => id);
    rt.damageBy.clear();
    const headshot = cause === 'bullet' && mainZone(killer.bullet) === 'head', distance = Math.round(distance3(attacker, target) * 10) / 10;
    this.onEvent({ type: 'elimination', playerId: target.id, attackerId: attacker.id, cause, ...(killer.top.weapon ? { weapon: killer.top.weapon } : {}), headshot, distance, assists, at: now });
    if (!suicide) {
      const art = this.runtime.get(attacker.id)!;
      attacker.kills++;
      if (this.mode === 'tdm' && attacker.team) this.teamScores[attacker.team]++;
      this.award(attacker, 'elimination', now);
      if (headshot) { this.award(attacker, 'headshot', now); this.medal(attacker, 'headshot', now); }
      if (cause === 'bullet' && distance >= RULES.longShotMeters) { this.award(attacker, 'long-shot', now); this.medal(attacker, 'long-shot', now); }
      settle.anyKill = true;
      if (settle.firstStrikeOpen && !settle.firstStruck.has(attacker.id)) {
        settle.firstStruck.add(attacker.id); this.award(attacker, 'first-strike', now); this.medal(attacker, 'first-strike', now);
      }
      if (art.lastKilledBy === target.id) { settle.evened.push(art); this.award(attacker, 'even-score', now); this.medal(attacker, 'even-score', now); }
      settle.chains.push({ player: attacker, life: art.life });
      if (cause === 'melee') this.medal(attacker, 'blade', now);
      if (cause === 'frag') this.medal(attacker, 'grenadier', now);
      // Streaks count your own fighting in this life: not reward kills, nor kills after you went down.
      if (cause === 'bullet' || cause === 'melee' || cause === 'frag') settle.streaks.push({ player: attacker, life: killer.top.life });
      // Each elimination returns one magazine for the weapon that made it.
      const slot = killer.top.slot ?? attacker.slot, spec = weaponFor(attacker.loadout, slot);
      attacker.reserve[slot - 1] = Math.min(reserveFor(spec, attacker.loadout), attacker.reserve[slot - 1]! + spec.magazine);
      settle.killedBy.push([rt, attacker.id]);
    }
    for (const id of assists) { const helper = this.players.get(id)!; helper.assists++; this.award(helper, 'assist', now); }
    if (!this.resolving) this.checkScoreLimit(now);
  }
  /** Kills within the multi-kill window of each other, in one life, earn the double and triple medals. */
  private extendChain(player: PlayerState, now: number) {
    const rt = this.runtime.get(player.id)!;
    rt.chain = now - rt.lastKillAt <= RULES.multiKillWindowMs ? rt.chain + 1 : 1; rt.lastKillAt = now;
    if (rt.chain >= 2) { this.award(player, 'multi', now); this.medal(player, rt.chain === 2 ? 'double' : 'triple', now); }
  }
  private extendStreak(player: PlayerState, now: number) {
    player.streak++;
    const medal = STREAK_MEDALS[player.streak];
    if (medal) this.medal(player, medal, now);
    const reward = STREAK_ORDER.find(id => STREAKS[id].kills === player.streak);
    if (!reward) return;
    if (player.rewards.length < MAX_STORED_REWARDS) player.rewards.push(reward);
    this.onEvent({ type: 'streak', playerId: player.id, reward, action: 'earned', at: now });
    this.award(player, 'streak-reward', now);
  }
  private award(player: PlayerState, reason: ScoreReason, now: number) {
    player.score += SCORE_POINTS[reason];
    this.onEvent({ type: 'score', playerId: player.id, points: SCORE_POINTS[reason], reason, at: now });
  }
  private medal(player: PlayerState, medal: MedalId, now: number) { this.onEvent({ type: 'medal', playerId: player.id, medal, at: now }); }
  private checkScoreLimit(now: number) {
    if (this.phase !== 'playing') return;
    if (this.mode === 'tdm') { if (Math.max(this.teamScores.teal, this.teamScores.gold) >= this.scoreLimit) this.finish('A team reached the elimination limit.', now); }
    else if ([...this.players.values()].some(p => p.kills >= this.scoreLimit)) this.finish('Elimination limit reached.', now);
  }
}

const roundVault = (vault: VaultState | null, r = r3): VaultState | null => vault && {
  fromX: r(vault.fromX), fromY: r(vault.fromY), fromZ: r(vault.fromZ), toX: r(vault.toX), toY: r(vault.toY), toZ: r(vault.toZ),
  start: Math.round(vault.start), end: Math.round(vault.end), exitSpeed: r(vault.exitSpeed), exitYaw: r4(vault.exitYaw),
};
/** What every client may know about a player: no ammunition, grenades, rewards or timers that reveal intent. */
export function publicState(p: PlayerState): PublicPlayerState {
  return {
    id: p.id, name: p.name, color: p.color, x: r3(p.x), y: r3(p.y), z: r3(p.z), yaw: r4(p.yaw), pitch: r4(p.pitch), vx: r3(p.vx), vy: r3(p.vy), vz: r3(p.vz),
    health: Math.round(p.health), ...(p.team ? { team: p.team } : {}), slot: p.slot, weapon: p.weapon, loadout: copyLoadout(p.loadout),
    kills: p.kills, deaths: p.deaths, assists: p.assists, score: p.score, streak: p.streak, connected: p.connected,
    respawnAt: Math.round(p.respawnAt), protectedUntil: Math.round(p.protectedUntil), reloadingUntil: Math.round(p.reloadingUntil),
    posture: p.posture, vault: roundVault(p.vault), slideUntil: Math.round(p.slideUntil), cookingSince: Math.round(p.cookingSince),
    lastInputSeq: p.lastInputSeq, ...(p.bot ? { bot: true } : {}), aiming: !!p.aiming, sprinting: !!p.sprinting, dashing: !!p.dashing,
  };
}
/** The receiving player's own full state. */
export function privateState(p: PlayerState): PlayerState {
  return {
    ...publicState(p), x: r6(p.x), y: r6(p.y), z: r6(p.z), vx: r6(p.vx), vy: r6(p.vy), vz: r6(p.vz), vault: roundVault(p.vault, r6),
    mag: [p.mag[0], p.mag[1]], reserve: [p.reserve[0], p.reserve[1]], frags: p.frags, rewards: [...p.rewards],
    reloadSlot: p.reloadSlot, readyAt: Math.round(p.readyAt), meleeUntil: Math.round(p.meleeUntil), stamina: r6(p.stamina),
    slideCooldownUntil: Math.round(p.slideCooldownUntil), lastDamageAt: Math.round(p.lastDamageAt),
    ...(p.lastInputTime !== undefined ? { lastInputTime: r3(p.lastInputTime) } : {}),
  };
}
