import { BotNavigation } from './navigation.js';
import { ARENA_LIMITS } from '../shared/map.js';
import {
  clamp, EYE_HEIGHT, eyePosition, GRENADE, grenadeLaunch, GrenadeTrajectory, hitboxes, MOVE, moveDefaults, movePlayer, normalize, raycastMap, subtract,
  type MoveState,
} from '../shared/physics.js';
import { RULES, type GameMode, type InputFrame, type Loadout, type PlayerState, type Posture, type PracticeDifficulty, type Profile, type Slot, type StreakId, type Team, type Vec3 } from '../shared/protocol.js';
import { botLoadout, EXPLOSIVES, fireIntervalMs, hasPerk, STEADY_AIM_ADS_FACTOR, weaponFor, type WeaponSpec } from '../shared/weapons.js';

export { BotNavigation } from './navigation.js';

export const PRACTICE_RIVALS: ReadonlyArray<Profile> = [
  { id: 'bot-scout', name: 'Scout (AI)', color: '#4abbb3' },
  { id: 'bot-moxie', name: 'Moxie (AI)', color: '#ee985d' },
  { id: 'bot-rook', name: 'Rook (AI)', color: '#9295dc' },
];

export interface BotSettings {
  /** Delay before firing at a newly seen opponent, in ms (each acquisition varies by ±15%). */
  reaction: number;
  /** Aim error half-range in radians; pitch error is 60% of it. */
  error: number;
  /** Fastest view turn, radians per second. */
  turn: number;
  /** How far away an opponent can be noticed, in metres. */
  range: number;
  /** Preferred fighting distance with a rifle, in metres. */
  distance: number;
  /** Trigger hold and pause lengths, in ms. */
  burst: number; rest: number;
  /** Share of an opponent's seen velocity the aim leads by. */
  lead: number;
  /** Chance that an aim decision goes for the head instead of the torso. */
  headChance: number;
  /** Share of each recoil kick pulled straight back down. The rest climbs and recovers slowly. */
  recoilControl: number;
  /** Chance to throw a frag at each opportunity. */
  frag: number;
  /** Uses the stamina-limited dash on long, quiet routes. */
  dash: boolean;
  /** Chance to slide when a fight starts at a sprint. */
  slide: number;
}
/** Relaxed, Balanced and Challenging. Difficulty never changes health or damage. */
export const BOT_SETTINGS: Readonly<Record<PracticeDifficulty, Readonly<BotSettings>>> = {
  easy: { reaction: 1000, error: 0.10, turn: 2.5, range: 30, distance: 18, burst: 450, rest: 750, lead: 0, headChance: 0, recoilControl: 0.35, frag: 0, dash: false, slide: 0 },
  normal: { reaction: 600, error: 0.052, turn: 3.8, range: 38, distance: 14, burst: 800, rest: 450, lead: 0.6, headChance: 0, recoilControl: 0.55, frag: 0.15, dash: true, slide: 0 },
  hard: { reaction: 330, error: 0.024, turn: 5, range: 44, distance: 12, burst: 1100, rest: 300, lead: 1, headChance: 0.35, recoilControl: 0.72, frag: 0.3, dash: true, slide: 0.35 },
};
/** Below this health a rival backs off to cover and waits for health to refill. */
export const RETREAT_HEALTH = 45;
/** A recovering rival rejoins the fight at this health. */
export const RECOVERED_HEALTH = 90;
/** Rivals swap to the pistol when the primary is empty and an opponent is this close. */
export const SECONDARY_RANGE = 10;
/** Frags go only at opponents last seen this far away (metres), at most once per cooldown. */
export const FRAG_RANGE = { min: 8, max: 25 } as const;
export const FRAG_COOLDOWN_MS = 8000;
/** The shortest cook before a rival lets go of a frag. */
export const FRAG_COOK_MS = 700;
/** A rival lets go this long after its planned cook even if its aim is not lined up yet (well inside the fuse),
 * as long as the frag would still burst clear of itself. */
export const FRAG_RELEASE_GRACE_MS = 900;
/** A rival only lets go of a frag that will burst at least this far (metres) from where it stands. */
export const FRAG_SAFE_LANDING = 7;
/** A rival keeps at least this far (metres) from its own live frag until it bursts (blast radius plus a margin). */
export const FRAG_CLEARANCE = EXPLOSIVES.frag.radius + 0.5;
/** Grenade simulations one rival may run while making one frame. Planning a throw takes several frames, so a
 * plan never holds up the shared 30 Hz tick. */
export const FRAG_SIMULATIONS_PER_TICK = 5;
/** A rival stops before planning a throw, waiting at most this long (ms) to come to rest. */
const FRAG_SETTLE_MS = 600;
/** Whatever happens, a cooked frag leaves the hand this long (ms) before its fuse ends. */
const FRAG_LAST_RELEASE_MS = 450;
const SENSE_MS = 100;
const INVESTIGATE_MS = 2200;
const CALLOUT_MS = 2500;
const SIGHTING_MEMORY_MS = 8000;
const MORTAR_MIN_DISTANCE = 12;
/** Inside this distance a rival steps in for the knife instead of backing away. */
const KNIFE_CLOSE_IN = 2.5;
const MAX_PITCH = 1.3;
const MAX_AIM_PITCH = 1.25;
/** Planning deceleration, below the physics brake so corners never overshoot. */
const BRAKE = 22;
/** Stairs are walked down slowly enough to land on every tread. */
const DESCENT_SPEED = 3;
/** Walking pace for stepping out of a wall's padding when no route is planned. */
const ESCAPE_SPEED = 1.5;

const horizontalDistance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
const sameHeight = (a: Vec3, b: Vec3) => Math.abs(a.y - b.y) < 0.06;
const angleDelta = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
const bearing = (from: Vec3, to: Vec3) => Math.atan2(to.x - from.x, -(to.z - from.z));
const point = (p: Vec3): Vec3 => ({ x: p.x, y: p.y, z: p.z });
const teammates = (mode: GameMode, a: { team?: Team }, b: { team?: Team }) => mode === 'tdm' && !!a.team && a.team === b.team;

let navigation: BotNavigation | undefined;
const getNavigation = () => navigation ??= new BotNavigation();

/** Centre of a hit zone of a body standing in its posture. */
function zoneCentre(body: Vec3 & { posture: Posture }, zone: 'head' | 'torso'): Vec3 {
  const box = hitboxes(body).find(b => b.zone === zone)!;
  return { x: body.x, y: (box.min.y + box.max.y) / 2, z: body.z };
}
function clearLine(from: Vec3, to: Vec3): boolean {
  const delta = subtract(to, from), length = Math.hypot(delta.x, delta.y, delta.z);
  return length < 1e-6 || raycastMap(from, normalize(delta), length) >= length - 0.01;
}
/** True when neither the chest nor the eyes of someone standing at `spot` are visible from `eye`. */
function hiddenFrom(eye: Vec3, spot: Vec3): boolean {
  return !clearLine(eye, { x: spot.x, y: spot.y + 1.15, z: spot.z }) && !clearLine(eye, { x: spot.x, y: spot.y + EYE_HEIGHT.stand, z: spot.z });
}
/** True once `p` is beyond waypoint `a` on the way to `b` and close to that next segment. */
function passed(p: Vec3, a: Vec3, b: Vec3): boolean {
  const dx = b.x - a.x, dz = b.z - a.z, length2 = dx * dx + dz * dz;
  if (length2 < 1e-8) return true;
  const t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / length2;
  if (t < 0) return false;
  const k = Math.min(1, t);
  return Math.hypot(p.x - (a.x + dx * k), p.z - (a.z + dz * k)) < 0.35;
}
function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (const character of seed) state = Math.imul(state ^ character.charCodeAt(0), 16777619);
  return () => { state += 0x6D2B79F5; let value = Math.imul(state ^ state >>> 15, state | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4294967296; };
}
function preferredDistance(spec: WeaponSpec, settings: BotSettings): number {
  switch (spec.kind) {
    case 'smg': return settings.distance * 0.7;
    case 'shotgun': return 6;
    case 'sniper': return Math.max(22, settings.distance + 8);
    case 'pistol': return settings.distance * 0.75;
    default: return settings.distance;
  }
}
const handlingFactors = new Map<string, number>();
/** How the shared movement rules scale walking speed for a weapon, at the hip or aimed. Measured once from
 * `movePlayer` itself, so the stick maths stays exact however the physics combines a weapon's hip and aimed
 * factors. */
function handlingFactor(spec: WeaponSpec, aim: boolean): number {
  const key = `${spec.moveFactor}/${spec.adsMoveFactor}/${aim}`;
  let factor = handlingFactors.get(key);
  if (factor === undefined) {
    // An open stretch of the north street; the body is put back after every step, so it never meets cover.
    const at = { x: 0, y: 0, z: -20 };
    const body: MoveState = { ...at, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, ...moveDefaults() };
    const input: InputFrame = {
      seq: 0, moveX: 0, moveZ: 1, yaw: 0, pitch: 0, fire: false, aim, jump: false, sprint: false, reload: false, slot: 1,
      crouch: false, dash: false, melee: false, grenade: false, streak: null, viewTime: 0,
    };
    for (let i = 0; i < 30; i++) {
      movePlayer(body, input, { now: i * 1000 / 30, dt: 1 / 30, jumpPressed: false, crouchPressed: false, moveFactor: spec.moveFactor, adsFactor: spec.adsMoveFactor, canSprint: false });
      Object.assign(body, at);
    }
    factor = Math.hypot(body.vx, body.vz) / MOVE.walk;
    handlingFactors.set(key, factor);
  }
  return factor;
}

/** Where one throw would explode after each of `flightsMs` (ascending), from a single run of the same
 * deterministic `GrenadeTrajectory` the server and clients use. */
function fragPath(eye: Vec3, yaw: number, pitch: number, flightsMs: readonly number[], carrier: { vx: number; vz: number } = { vx: 0, vz: 0 }): Vec3[] {
  const { from, velocity } = grenadeLaunch(eye, yaw, pitch, carrier, EXPLOSIVES.frag.throwSpeed, EXPLOSIVES.frag.throwLift);
  const trajectory = new GrenadeTrajectory(from, velocity), points: Vec3[] = [];
  let at = 0, resting = false, last = trajectory.position;
  for (const flight of flightsMs) {
    // A grenade at rest stays at rest, so simulation can stop early. Rest means slow *and* not moving
    // over the whole interval, so the top of a bounce never counts.
    while (!resting && at < flight) {
      at = Math.min(flight, at + 100); trajectory.advanceTo(at);
      const body = trajectory.body, now = trajectory.position;
      resting = Math.abs(body.vx) + Math.abs(body.vy) + Math.abs(body.vz) < 0.03 && Math.hypot(now.x - last.x, now.y - last.y, now.z - last.z) < 1e-3;
      last = now;
    }
    points.push(trajectory.position);
  }
  return points;
}
/** Where a frag thrown now would explode `flightMs` after leaving the hand (thrown standing still unless a
 * carrier velocity is given, as the engine adds half of it). */
export function fragLanding(eye: Vec3, yaw: number, pitch: number, flightMs: number, carrier: { vx: number; vz: number } = { vx: 0, vz: 0 }): Vec3 {
  return fragPath(eye, yaw, pitch, [flightMs], carrier)[0]!;
}
/** Cook lengths a rival may choose; a longer cook bursts the frag before it rolls away. */
export const FRAG_COOKS_MS = [FRAG_COOK_MS, 1200, 1700] as const;
export interface FragArc { yaw: number; pitch: number; cookMs: number; landing: Vec3 }
interface ScoredArc extends FragArc { error: number; score: number }
const COARSE_PITCHES = [-0.3, -0.1, 0.1, 0.3, 0.5, 0.7, 0.9, 1.1] as const;
/** Sideways angles tried in turn when straight throws miss, to bank a frag around cover. */
const ARC_OFFSETS = [[0], [-0.08, 0.08], [-0.16, 0.16]] as const;
const REFINE_PITCH = [0.1, 0.05, 0.025] as const;
/** Searches for a throw that bursts on `target`: coarse pitch steps first, then finer steps around the best arc,
 * and small sideways angles only when straight throws miss. Each candidate is one run of the shared grenade
 * simulation covering all cook lengths. `step` runs a few at a time so a search can spread over frames; at most
 * 64 runs in all, and it stops as soon as an arc lands within half a metre. Arcs that would burst within
 * FRAG_SAFE_LANDING of the thrower are never chosen. */
export class FragPlanner {
  simulations = 0;
  private best: ScoredArc | null = null;
  private queue: Array<readonly [number, number]> = [];
  private round = 0; private pass = 0; private finished = false;
  private readonly base: number; private readonly flights: number[];
  constructor(private readonly eye: Vec3, private readonly target: Vec3, private readonly thrower: Vec3 = eye) {
    this.base = bearing(eye, target);
    this.flights = [...FRAG_COOKS_MS].reverse().map(cook => EXPLOSIVES.frag.fuseMs - cook);
    this.startRound();
  }
  get done(): boolean { return this.finished; }
  /** The chosen throw once done; null when nothing bursts within 3 m of the target and clear of the thrower. */
  get result(): FragArc | null {
    const best = this.best;
    return this.finished && best && best.error <= 3 ? { yaw: wrap(best.yaw), pitch: best.pitch, cookMs: best.cookMs, landing: best.landing } : null;
  }
  /** Runs up to `budget` more simulations; true once the search is over. */
  step(budget = Infinity): boolean {
    while (!this.finished && budget > 0) {
      const next = this.queue.shift();
      if (!next) { this.advance(); continue; }
      budget--; this.evaluate(next[0], next[1]);
      if (this.best && this.best.error < 0.5) this.finished = true;
    }
    return this.finished;
  }
  private startRound() {
    this.pass = 0;
    this.queue = ARC_OFFSETS[this.round]!.flatMap(offset => COARSE_PITCHES.map(pitch => [this.base + offset, pitch] as const));
  }
  private advance() {
    const best = this.best;
    if (best && this.pass < REFINE_PITCH.length) {
      const d = REFINE_PITCH[this.pass]!, pitch = (p: number) => clamp(p, -0.45, 1.2);
      this.queue = [[best.yaw, pitch(best.pitch - d)], [best.yaw, pitch(best.pitch + d)]];
      if (this.pass === REFINE_PITCH.length - 1) this.queue.push([best.yaw - 0.04, best.pitch], [best.yaw + 0.04, best.pitch]);
      this.pass++;
    } else if ((!best || best.error >= 1) && this.round + 1 < ARC_OFFSETS.length) {
      this.round++; this.startRound();
    } else this.finished = true;
  }
  private evaluate(yaw: number, pitch: number) {
    this.simulations++;
    const points = fragPath(this.eye, yaw, pitch, this.flights);
    for (let i = 0; i < points.length; i++) {
      const landing = points[i]!, cookMs = EXPLOSIVES.frag.fuseMs - this.flights[i]!;
      if (horizontalDistance(landing, this.thrower) < FRAG_SAFE_LANDING) continue;
      const error = horizontalDistance(landing, this.target) + 2 * Math.abs(landing.y - GRENADE.radius - this.target.y);
      // Prefer straight throws and short cooks when they land about as well.
      const score = error + 2 * Math.abs(angleDelta(yaw, this.base)) + 0.3 * cookMs / 1000;
      if (!this.best || score < this.best.score) this.best = { yaw, pitch, cookMs, landing, error, score };
    }
  }
}
/** A view and cook that lob a frag onto `target` from a thrower standing at `eye`, or null when no arc explodes
 * within 3 m of it (searched all at once; rivals spread the same search over frames). */
export function planFrag(eye: Vec3, target: Vec3): FragArc | null {
  const planner = new FragPlanner(eye, target);
  planner.step();
  return planner.result;
}

interface Sighting extends Vec3 { id: string; vx: number; vz: number; posture: Posture; at: number }
const sighting = (p: PlayerState, at: number): Sighting => ({ id: p.id, x: p.x, y: p.y, z: p.z, vx: p.vx, vz: p.vz, posture: p.posture, at });
interface ThrowPlan {
  /** Where the opponent was last seen. */
  target: Vec3; since: number;
  /** Runs once the rival has stopped, a few simulations per frame. */
  planner: FragPlanner | null;
  arc: FragArc | null;
  /** When the grenade button went down (0 before), and when to let go at the latest if not lined up. */
  pressedAt: number; releaseBy: number;
  /** The planned throw turned out unsafe at the last check: getting rid of the frag far away instead. */
  bail: boolean;
}
/** Where our own thrown frag will burst, and when. */
interface Blast extends Vec3 { until: number }
const inBlast = (blast: Vec3, p: Vec3) => horizontalDistance(p, blast) < FRAG_CLEARANCE && Math.abs(p.y - blast.y) < 2.5;
/** A wished world-space direction (unit), the speed wanted along it, and how far the route runs straight ahead. */
interface Motion { x: number; z: number; speed: number; straight: number; remaining: number }
const STILL: Motion = { x: 0, z: 0, speed: 0, straight: 0, remaining: 0 };
type Task = 'throw' | 'evade' | 'fight' | 'retreat' | 'hold' | 'chase' | 'roam';
interface Brain {
  random: () => number; lastNow: number; lastPos: Vec3;
  // Perception: an opponent's coordinates are sampled only while seen.
  nextSense: number; targetId: string | null; visible: boolean; seen: Sighting | null; headVisible: boolean; torsoVisible: boolean;
  acquired: boolean; lostSight: boolean; reactAt: number; burstUntil: number; restUntil: number;
  // The bot's own aim, plus the share of recoil it has not pulled back down yet.
  aimYaw: number; aimPitch: number; sentYaw: number; sentPitch: number; kickYaw: number; kickPitch: number; burstShots: number;
  yawError: number; pitchError: number; headAim: boolean; nextError: number; aiming: boolean; aimSince: number;
  damaged: boolean; lastDamageAt: number; lookYaw: number; lookUntil: number;
  // Movement.
  strafe: number; nextStrafe: number; patrol: Vec3 | null; route: Vec3[]; routeGoal: Vec3 | null; nextRoute: number; routeFailed: boolean;
  retreat: Vec3 | null; nextCover: number; recovering: boolean; recoverSince: number; dashing: boolean;
  progressFrom: Vec3; progressAt: number; windowTicks: number; movingTicks: number;
  // Actions.
  lastMag: [number, number]; lastSlot: Slot; lastShotAt: number; firePulse: boolean; reloadPulse: boolean; meleePulse: boolean;
  slideHold: number; nextSlide: number; throwPlan: ThrowPlan | null; nextFragRoll: number; blast: Blast | null; refuge: Vec3 | null;
  streakPulse: boolean; nextStreak: number; reconSent: { at: number; count: number } | null; reconUntil: number; radar: Sighting | null; radarAt: number;
}
function createBrain(random: () => number, player: PlayerState, now: number): Brain {
  return {
    random, lastNow: now, lastPos: point(player),
    nextSense: 0, targetId: null, visible: false, seen: null, headVisible: false, torsoVisible: false, acquired: false, lostSight: false,
    reactAt: Infinity, burstUntil: 0, restUntil: 0,
    aimYaw: wrap(player.yaw), aimPitch: clamp(player.pitch, -MAX_AIM_PITCH, MAX_AIM_PITCH), sentYaw: player.yaw, sentPitch: player.pitch,
    kickYaw: 0, kickPitch: 0, burstShots: 0, yawError: 0, pitchError: 0, headAim: false, nextError: 0, aiming: false, aimSince: now,
    damaged: false, lastDamageAt: player.lastDamageAt, lookYaw: 0, lookUntil: 0,
    strafe: random() < 0.5 ? -1 : 1, nextStrafe: 0, patrol: null, route: [], routeGoal: null, nextRoute: 0, routeFailed: false,
    retreat: null, nextCover: 0, recovering: false, recoverSince: 0, dashing: false,
    progressFrom: point(player), progressAt: now + 2000, windowTicks: 0, movingTicks: 0,
    lastMag: [player.mag[0], player.mag[1]], lastSlot: player.slot, lastShotAt: -Infinity, firePulse: false, reloadPulse: false, meleePulse: false,
    slideHold: 0, nextSlide: 0, throwPlan: null, nextFragRoll: 0, blast: null, refuge: null,
    streakPulse: false, nextStreak: 0, reconSent: null, reconUntil: 0, radar: null, radarAt: 0,
  };
}

/** Server-side perception and ordinary input generation. Decisions never mutate players or
 * apply damage; MatchEngine owns every physical and combat outcome, exactly as for people. */
export class PracticeBots {
  private readonly brains = new Map<string, Brain>();
  private readonly lives = new Map<string, number>();
  constructor(readonly difficulty: PracticeDifficulty = 'normal', private seed = 'practice') {}
  reset(seed = this.seed) { this.seed = seed; this.brains.clear(); this.lives.clear(); }
  forget(id: string) { this.brains.delete(id); }
  /** The fixed loadout a rival plays with at this difficulty (same as `botLoadout`). */
  loadoutFor(id: string): Loadout { return botLoadout(id, this.difficulty); }

  input(player: PlayerState, others: readonly PlayerState[], now: number, dt: number, seq: number, mode: GameMode = 'ffa'): InputFrame {
    const frame: InputFrame = {
      seq, moveX: 0, moveZ: 0, yaw: player.yaw, pitch: clamp(player.pitch, -MAX_PITCH, MAX_PITCH), fire: false, aim: false, jump: false,
      sprint: false, reload: false, slot: player.slot, crouch: false, dash: false, melee: false, grenade: false, streak: null, viewTime: now,
    };
    if (player.health <= 0) { this.brains.delete(player.id); return frame; }
    if (!player.connected) return frame;
    const settings = BOT_SETTINGS[this.difficulty], nav = getNavigation(), step = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    const loadout = player.loadout ?? this.loadoutFor(player.id);
    const brain = this.brainFor(player, now);
    // Anything other than our own last frame moved the view (a respawn or a correction): aim from there.
    if (Math.abs(angleDelta(player.yaw, brain.sentYaw)) > 1e-3 || Math.abs(player.pitch - brain.sentPitch) > 1e-3) {
      brain.aimYaw = wrap(player.yaw); brain.aimPitch = clamp(player.pitch, -MAX_AIM_PITCH, MAX_AIM_PITCH); brain.kickYaw = 0; brain.kickPitch = 0;
    }
    this.observe(brain, player, loadout, now, settings);
    this.sense(brain, player, others, now, mode, settings);
    if (brain.blast && now >= brain.blast.until) { brain.blast = null; brain.refuge = null; }
    const hurt = brain.damaged;
    if (hurt) {
      brain.damaged = false;
      // Like a damage arc on screen: turn toward whoever could have hit us.
      const yaw = brain.visible ? null : this.attackerBearing(player, others, mode);
      if (yaw !== null) { brain.lookYaw = yaw; brain.lookUntil = now + 1200; }
    }

    const seen = brain.seen, visible = brain.visible && !!seen;
    const distance = seen ? horizontalDistance(player, seen) : Infinity;
    if (player.health < RETREAT_HEALTH) { if (!brain.recovering) { brain.recovering = true; brain.recoverSince = now; brain.retreat = null; } }
    else if (brain.recovering && (player.health >= RECOVERED_HEALTH || now - brain.recoverSince > 12_000)) { brain.recovering = false; brain.retreat = null; }

    const cooking = player.cookingSince > 0, reloading = player.reloadingUntil > now;
    if (brain.lostSight) { brain.lostSight = false; this.considerFrag(brain, player, settings, now, reloading || cooking); }
    // A frag not yet in hand is called off when an opponent shows up or someone hits us.
    if (brain.throwPlan && !brain.throwPlan.pressedAt && (visible || hurt)) brain.throwPlan = null;
    // Never swap weapons with a grenade in hand.
    const slot = brain.throwPlan || cooking ? player.slot : this.chooseSlot(player, visible, distance, now);
    frame.slot = slot;
    const spec = weaponFor(loadout, slot), index = slot - 1, mag = player.mag[index], reserve = player.reserve[index];
    const swapping = slot !== player.slot;

    let task: Task;
    const atRetreat = () => !!brain.retreat && horizontalDistance(player, brain.retreat) < 1 && sameHeight(player, brain.retreat);
    const blast = brain.blast;
    if (brain.throwPlan) task = 'throw';
    // Our own frag is about to burst nearby (it bounced back, or we were pushed toward it): get clear first.
    else if (blast && inBlast(blast, player)) task = 'evade';
    else if (visible && brain.recovering && distance > 7) {
      if (now >= brain.nextCover && (!brain.retreat || !hiddenFrom(eyePosition({ ...seen!, posture: 'stand' }), brain.retreat))) {
        brain.retreat = this.cover(player, seen!, nav); brain.nextCover = now + 600; brain.route = []; brain.routeGoal = null;
      }
      // Still seen at the cover spot (or no cover at all): fight back rather than stand still.
      task = brain.retreat && !atRetreat() ? 'retreat' : 'fight';
    } else if (visible) task = 'fight';
    else if (brain.recovering) task = brain.retreat && !atRetreat() ? 'retreat' : 'hold';
    else if (seen && now - seen.at < INVESTIGATE_MS && (distance > 1 || nav.requiresAscent(player, seen))) task = 'chase';
    else task = 'roam';

    const eye = eyePosition(player);
    let motion = STILL, look: { yaw: number; pitch: number } | null = null, wantSprint = false, wantDash = false, wantFire = false;
    if (task === 'throw') {
      // Face the throw while stopping and planning; then turn onto the planned arc.
      const plan = brain.throwPlan!;
      look = plan.arc ? { yaw: plan.arc.yaw, pitch: plan.arc.pitch } : { yaw: bearing(eye, plan.target), pitch: 0.35 };
    } else if (task === 'evade') {
      if (!brain.refuge || inBlast(blast!, brain.refuge)) {
        // A new way out is planned at once; the old route may lead into the blast.
        brain.refuge = this.refuge(player, blast!, nav); brain.route = []; brain.routeGoal = null; brain.nextRoute = now;
      }
      motion = brain.refuge ? this.follow(brain, player, brain.refuge, now, nav, false) : this.awayFrom(player, blast!);
      wantSprint = true;
    } else if (task === 'fight') {
      const target = seen!, preferred = preferredDistance(spec, settings);
      const approach = distance > preferred + 2 || nav.requiresAscent(player, target) || !nav.isWalkable(player);
      if (approach) motion = this.follow(brain, player, target, now, nav, false);
      // Close enough, or no way to close in from here: keep moving around the opponent.
      if (!approach || (motion === STILL && nav.isWalkable(player))) {
        brain.route = []; brain.routeGoal = null;
        motion = this.strafe(brain, player, target, distance, preferred, now, nav);
        // Boxed in on every side: push toward the opponent rather than stand still.
        if (motion === STILL && !approach) motion = this.follow(brain, player, target, now, nav, false);
      }
      if (now >= brain.nextError) {
        brain.yawError = (brain.random() * 2 - 1) * settings.error; brain.pitchError = (brain.random() * 2 - 1) * settings.error * 0.6;
        brain.headAim = brain.random() < settings.headChance; brain.nextError = now + 230 + brain.random() * 170;
      }
      const aimPoint = this.aimPoint(brain, target, now, settings);
      look = { yaw: bearing(eye, aimPoint) + brain.yawError, pitch: Math.atan2(aimPoint.y - eye.y, horizontalDistance(eye, aimPoint)) + brain.pitchError };
      frame.aim = true;
    } else if (task === 'retreat') {
      motion = this.follow(brain, player, brain.retreat!, now, nav, true); wantSprint = true;
    } else if (task === 'hold') {
      if (seen && now - seen.at < SIGHTING_MEMORY_MS) look = { yaw: bearing(player, seen), pitch: 0 };
    } else if (task === 'chase') {
      motion = this.follow(brain, player, seen!, now, nav, false);
      // Walk in ready to fight, watching where the opponent was unless the route turns away from it.
      const toSeen = bearing(player, seen!);
      if (motion.speed <= 0.5 || Math.abs(angleDelta(toSeen, Math.atan2(motion.x, -motion.z))) < 1.05) {
        const target = zoneCentre(seen!, 'torso');
        look = { yaw: toSeen, pitch: Math.atan2(target.y - eye.y, Math.max(0.5, horizontalDistance(eye, target))) };
      }
    } else {
      const goal = this.callout(player, others, mode, now) ?? this.radar(brain, player, others, mode, now) ?? this.patrol(brain, player, nav, mode);
      motion = this.follow(brain, player, goal, now, nav, false); wantSprint = true;
      wantDash = settings.dash && motion.straight >= 6 && motion.remaining >= 12 && player.stamina >= (brain.dashing ? 0.02 : 0.5);
    }
    // No route to the goal (unreachable spot, or mid-fall): drop it and choose again rather than stand still.
    if (brain.routeFailed) {
      brain.routeFailed = false;
      if (task === 'roam') brain.patrol = null;
      else if (task === 'retreat') brain.retreat = null;
      else if (task === 'chase') brain.seen = null;
      else if (task === 'evade') brain.refuge = null;
    }
    // Wait for our own frag to go off rather than walk into it.
    if (blast && task !== 'evade' && task !== 'throw') motion = this.keepClear(player, blast, motion);
    // Hit by someone unseen: look that way (but keep running if already retreating).
    if ((task === 'hold' || task === 'chase' || task === 'roam') && now < brain.lookUntil) look = { yaw: brain.lookYaw, pitch: 0 };
    if (!look) look = motion.speed > 0.5 ? { yaw: Math.atan2(motion.x, -motion.z), pitch: 0 } : { yaw: brain.aimYaw, pitch: 0 };
    this.unstick(brain, player, motion, now, task);

    // Turn the view at the difficulty's rate, then add the recoil not yet pulled down.
    const turn = settings.turn * step;
    brain.aimYaw = wrap(brain.aimYaw + clamp(angleDelta(look.yaw, brain.aimYaw), -turn, turn));
    brain.aimPitch = clamp(brain.aimPitch + clamp(look.pitch - brain.aimPitch, -turn, turn), -MAX_AIM_PITCH, MAX_AIM_PITCH);
    if (frame.aim && (!brain.aiming || swapping)) brain.aimSince = now;
    brain.aiming = frame.aim;

    if (task === 'fight') {
      const target = seen!, closeEnough = Math.abs(target.y - player.y) < 1 && distance <= RULES.meleeRange;
      if (closeEnough && now >= brain.reactAt && now >= player.meleeUntil && !cooking && Math.abs(angleDelta(bearing(player, target), brain.aimYaw)) < 0.45) {
        frame.melee = !brain.meleePulse;
      } else if (now >= brain.reactAt && distance <= Math.min(settings.range, spec.maxRange) && !cooking && !swapping && mag > 0
        && !(reloading && !spec.perShellMs) && now >= player.meleeUntil
        && now - brain.aimSince >= spec.adsMs * (hasPerk(loadout, 'steady-aim') ? STEADY_AIM_ADS_FACTOR : 1) - 1) {
        if (now >= brain.restUntil && now >= brain.burstUntil) { brain.burstUntil = now + settings.burst; brain.restUntil = brain.burstUntil + settings.rest; }
        const tolerance = clamp(Math.atan2(0.6, Math.max(1, distance)), 0.03, 0.15);
        wantFire = now < brain.burstUntil && Math.abs(angleDelta(look.yaw, brain.aimYaw)) < tolerance && Math.abs(look.pitch - brain.aimPitch) < tolerance;
      }
      if (brain.acquired) this.considerSlide(brain, player, settings, now, nav);
    }
    brain.acquired = false;
    brain.meleePulse = frame.melee;
    if (wantFire) frame.fire = spec.auto || (!brain.firePulse && now >= player.readyAt && now - brain.lastShotAt >= fireIntervalMs(spec) - 40);
    brain.firePulse = frame.fire;
    const settle = frame.fire ? Math.exp(-step * 2 * settings.recoilControl) : Math.exp(-step * 8);
    brain.kickYaw *= settle; brain.kickPitch *= settle;
    if (!frame.fire) brain.burstShots = 0;
    frame.yaw = wrap(brain.aimYaw + brain.kickYaw);
    frame.pitch = clamp(brain.aimPitch + brain.kickPitch, -MAX_PITCH, MAX_PITCH);
    brain.sentYaw = frame.yaw; brain.sentPitch = frame.pitch;
    // Grenade decisions come last: the release check uses this frame's final view.
    if (task === 'throw') this.throwFrag(brain, player, frame, now, cooking);

    frame.crouch = now < brain.slideHold;
    if (wantSprint && reloading) wantSprint = false;
    this.drive(frame, player, spec, motion, wantSprint, wantDash);
    brain.dashing = frame.dash;

    // Reload when empty, when out of sight with a low magazine (not mid-retreat, which would stop the sprint),
    // and top up while waiting in cover.
    const wantReload = mag < spec.magazine && reserve > 0 && !reloading && !swapping && !cooking && task !== 'throw'
      && (mag === 0 || (!visible && task !== 'retreat' && task !== 'evade' && mag < Math.ceil(spec.magazine * 0.6)) || task === 'hold');
    frame.reload = wantReload && !brain.reloadPulse;
    brain.reloadPulse = frame.reload;
    this.useReward(brain, player, others, frame, mode, now, task);
    brain.lastPos = point(player); brain.lastNow = now;
    return frame;
  }

  private brainFor(player: PlayerState, now: number): Brain {
    let brain = this.brains.get(player.id);
    // A jump no movement could make is a respawn: start a fresh life.
    if (brain && horizontalDistance(brain.lastPos, player) + Math.abs(brain.lastPos.y - player.y) > 3) brain = undefined;
    if (!brain) {
      const life = (this.lives.get(player.id) ?? 0) + 1; this.lives.set(player.id, life);
      brain = createBrain(seededRandom(`${this.seed}:${player.id}:${life}`), player, now); this.brains.set(player.id, brain);
    }
    return brain;
  }

  /** Reads the bot's own state: shots fired since the last frame (for recoil and cadence), rewards used, damage taken. */
  private observe(brain: Brain, player: PlayerState, loadout: Loadout, now: number, settings: BotSettings) {
    const index = player.slot - 1;
    if (player.slot === brain.lastSlot) {
      const fired = Math.min(3, Math.max(0, brain.lastMag[index] - player.mag[index]));
      const spec = weaponFor(loadout, player.slot), recoil = spec.recoil, residual = 1 - settings.recoilControl;
      for (let i = 0; i < fired; i++) {
        const shot = brain.burstShots++, ease = Math.min(1, shot / Math.max(1, recoil.ramp)), ads = brain.aiming ? recoil.adsFactor : 1;
        brain.kickPitch += (recoil.vertical[0] + (recoil.vertical[1] - recoil.vertical[0]) * ease) * ads * residual;
        brain.kickYaw += recoil.horizontal * (recoil.pattern[shot % recoil.pattern.length] ?? 0) * ads * residual;
      }
      if (fired > 0) brain.lastShotAt = brain.lastNow;
    }
    brain.lastMag = [player.mag[0], player.mag[1]]; brain.lastSlot = player.slot;
    if (brain.reconSent && now > brain.reconSent.at) {
      const count = player.rewards.filter(reward => reward === 'recon').length;
      if (count < brain.reconSent.count) brain.reconUntil = brain.reconSent.at + RULES.reconMs;
      if (count < brain.reconSent.count || now - brain.reconSent.at > 1000) brain.reconSent = null;
    }
    if (player.lastDamageAt > brain.lastDamageAt) brain.damaged = true;
    brain.lastDamageAt = player.lastDamageAt;
  }

  /** 10 Hz sight checks from the bot's eyes to opponents' heads and chests, with a wide field of view. */
  private sense(brain: Brain, player: PlayerState, others: readonly PlayerState[], now: number, mode: GameMode, settings: BotSettings) {
    if (brain.visible) {
      const current = others.find(other => other.id === brain.targetId);
      // Seeing an opponent go down is immediate; it ends the fight without a frag opportunity.
      if (!current || current.health <= 0 || !current.connected) { brain.visible = false; brain.seen = null; brain.targetId = null; }
    }
    if (now < brain.nextSense) return;
    brain.nextSense = now + SENSE_MS;
    const eye = eyePosition(player);
    let best: { other: PlayerState; score: number; head: boolean; torso: boolean } | null = null;
    for (const other of others) {
      if (other.id === player.id || !other.connected || other.health <= 0 || other.protectedUntil > now || teammates(mode, player, other)) continue;
      const distance = horizontalDistance(player, other);
      if (distance > settings.range || (distance >= 5 && Math.abs(angleDelta(bearing(player, other), player.yaw)) >= 1.9)) continue;
      const torso = clearLine(eye, zoneCentre(other, 'torso')), head = clearLine(eye, zoneCentre(other, 'head'));
      if (!torso && !head) continue;
      const score = distance * (other.id === brain.targetId ? 0.75 : 1);
      if (!best || score < best.score - 1e-9 || (Math.abs(score - best.score) <= 1e-9 && other.id < best.other.id)) best = { other, score, head, torso };
    }
    if (best) {
      if (!brain.visible || brain.targetId !== best.other.id) {
        brain.reactAt = now + settings.reaction * (0.85 + brain.random() * 0.3); brain.burstUntil = 0; brain.restUntil = brain.reactAt; brain.acquired = true;
      }
      brain.targetId = best.other.id; brain.seen = sighting(best.other, now); brain.headVisible = best.head; brain.torsoVisible = best.torso;
    } else if (brain.visible) brain.lostSight = true;
    brain.visible = !!best;
  }

  /** Torso, or head when chosen or when only the head shows, led by the opponent's seen velocity. */
  private aimPoint(brain: Brain, seen: Sighting, now: number, settings: BotSettings): Vec3 {
    const zone = brain.headVisible && (brain.headAim || !brain.torsoVisible) ? 'head' : 'torso';
    const centre = zoneCentre(seen, zone), lead = settings.lead * clamp((now - seen.at) / 1000, 0, 0.25);
    return { x: centre.x + seen.vx * lead, y: centre.y, z: centre.z + seen.vz * lead };
  }

  private chooseSlot(player: PlayerState, visible: boolean, distance: number, now: number): Slot {
    const [primaryMag, secondaryMag] = player.mag, [primaryReserve, secondaryReserve] = player.reserve;
    const close = visible && distance <= SECONDARY_RANGE;
    const primaryDry = primaryMag === 0 || (player.reloadingUntil > now && player.reloadSlot === 1);
    if (primaryMag === 0 && primaryReserve === 0 && secondaryMag + secondaryReserve > 0) return 2;
    if (close && primaryDry && secondaryMag > 0) return 2;
    // Keep the pistol for the rest of a close fight (and reload it there if the primary is also empty).
    if (player.slot === 2 && visible && distance <= SECONDARY_RANGE + 2 && (secondaryMag > 0 || primaryMag === 0)) return 2;
    return 1;
  }

  /** Each time a fight breaks line of sight is one opportunity: a single roll, then a cooldown. A successful roll
   * starts a throw: the rival stops, plans the arc from where it stands, then cooks and throws. */
  private considerFrag(brain: Brain, player: PlayerState, settings: BotSettings, now: number, busy: boolean) {
    const seen = brain.seen;
    if (!seen || settings.frag <= 0 || player.frags <= 0 || brain.throwPlan || brain.blast || busy || brain.recovering || now < brain.nextFragRoll || player.posture !== 'stand') return;
    const distance = horizontalDistance(player, seen);
    if (distance < FRAG_RANGE.min || distance > FRAG_RANGE.max) return;
    brain.nextFragRoll = now + FRAG_COOLDOWN_MS;
    if (brain.random() >= settings.frag) return;
    brain.throwPlan = { target: point(seen), since: now, planner: null, arc: null, pressedAt: 0, releaseBy: 0, bail: false };
  }

  /** Stop, plan from the eye the frag will really leave from (a few simulations per frame), hold the grenade while
   * turning onto the arc, and let go once cooked and lined up. Just before letting go, one more simulation from
   * the real eye, view and remaining fuse checks it bursts clear of the rival; if not, the rival turns to get rid
   * of it far away instead. Afterwards the rival remembers where and when it will burst. */
  private throwFrag(brain: Brain, player: PlayerState, frame: InputFrame, now: number, cooking: boolean) {
    const plan = brain.throwPlan!, fuse = EXPLOSIVES.frag.fuseMs;
    if (!plan.pressedAt) {
      if (!plan.planner) {
        if (Math.hypot(player.vx, player.vz) > 0.05 && now - plan.since < FRAG_SETTLE_MS) return;
        plan.planner = new FragPlanner(eyePosition(player), plan.target, point(player));
      }
      if (!plan.planner.step(FRAG_SIMULATIONS_PER_TICK)) return;
      const arc = plan.planner.result;
      if (!arc || cooking || player.frags <= 0 || player.posture !== 'stand') { brain.throwPlan = null; return; }
      plan.arc = arc; plan.pressedAt = now; plan.releaseBy = now + arc.cookMs + FRAG_RELEASE_GRACE_MS;
      frame.grenade = true;
      return;
    }
    if (!cooking) {
      // The server did not start cooking (no frag, or busy): give up instead of holding the button.
      if (now - plan.pressedAt > 200) brain.throwPlan = null; else frame.grenade = true;
      return;
    }
    const arc = plan.arc!, cooked = now - player.cookingSince, lastChance = player.cookingSince + fuse - FRAG_LAST_RELEASE_MS;
    const aligned = Math.abs(angleDelta(arc.yaw, frame.yaw)) < 0.03 && Math.abs(arc.pitch - frame.pitch) < 0.03;
    if (now < lastChance && now < plan.releaseBy && !(aligned && (plan.bail || cooked >= arc.cookMs))) { frame.grenade = true; return; }
    const eye = eyePosition(player), flight = player.cookingSince + fuse - now;
    const landing = fragLanding(eye, frame.yaw, frame.pitch, flight, player);
    if (horizontalDistance(landing, player) < FRAG_SAFE_LANDING && now < lastChance) {
      if (!plan.bail) { plan.bail = true; plan.arc = this.dumpArc(eye, frame.yaw, flight, player); plan.releaseBy = lastChance; }
      frame.grenade = true;
      return;
    }
    // Let go (the button is released this frame) and stay clear of where it will burst.
    brain.throwPlan = null;
    brain.blast = { x: landing.x, y: landing.y, z: landing.z, until: player.cookingSince + fuse + 150 };
  }
  /** The farthest of four lobs (ahead, both sides, behind) for a cooked frag whose planned throw turned unsafe. */
  private dumpArc(eye: Vec3, yaw: number, flight: number, player: PlayerState): FragArc {
    let best: (FragArc & { away: number }) | null = null;
    for (const turn of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
      const arc = { yaw: wrap(yaw + turn), pitch: 0.6, cookMs: 0 }, landing = fragLanding(eye, arc.yaw, arc.pitch, flight, player);
      const away = horizontalDistance(landing, player);
      if (!best || away > best.away) best = { ...arc, landing, away };
    }
    return best!;
  }

  /** Challenging rivals sometimes slide when a fight starts at a sprint, if the way ahead is clear. */
  private considerSlide(brain: Brain, player: PlayerState, settings: BotSettings, now: number, nav: BotNavigation) {
    const speed = Math.hypot(player.vx, player.vz);
    if (settings.slide <= 0 || !player.sprinting || player.posture !== 'stand' || speed < MOVE.slideMinStartSpeed + 0.2) return;
    if (now < player.slideCooldownUntil || now < brain.nextSlide) return;
    const ahead = { x: player.x + player.vx / speed * 4, y: player.y, z: player.z + player.vz / speed * 4 };
    if (!nav.clearSegment(player, ahead)) return;
    brain.nextSlide = now + 5000;
    if (brain.random() < settings.slide) brain.slideHold = now + MOVE.slideMs;
  }

  /** Spends earned rewards: Recon Sweep and Attack Drone at once, Mortar Volley on a recently seen opponent. */
  private useReward(brain: Brain, player: PlayerState, others: readonly PlayerState[], frame: InputFrame, mode: GameMode, now: number, task: Task) {
    if (brain.streakPulse) { brain.streakPulse = false; return; }
    if (!player.rewards.length || now < brain.nextStreak || task === 'throw') return;
    const target = player.rewards.includes('mortar') ? this.mortarTarget(brain, player, others, mode, now) : null;
    const reward: StreakId | undefined = player.rewards.find(r => r !== 'mortar') ?? (target ? 'mortar' : undefined);
    if (!reward) return;
    frame.streak = reward;
    if (reward === 'mortar') frame.streakTarget = target!;
    if (reward === 'recon') brain.reconSent = { at: now, count: player.rewards.filter(r => r === 'recon').length };
    brain.streakPulse = true; brain.nextStreak = now + 1000;
  }
  private mortarTarget(brain: Brain, player: PlayerState, others: readonly PlayerState[], mode: GameMode, now: number): { x: number; z: number } | null {
    let best: Sighting | null = null;
    for (const candidate of [brain.seen, this.callout(player, others, mode, now), brain.radar]) {
      if (candidate && now - candidate.at < SIGHTING_MEMORY_MS && horizontalDistance(player, candidate) >= MORTAR_MIN_DISTANCE && (!best || candidate.at > best.at)) best = candidate;
    }
    return best ? { x: clamp(best.x, -ARENA_LIMITS.x + 1, ARENA_LIMITS.x - 1), z: clamp(best.z, -ARENA_LIMITS.z + 1, ARENA_LIMITS.z - 1) } : null;
  }

  /** Team play: a teammate rival's fresh sighting is a place worth checking. */
  private callout(player: PlayerState, others: readonly PlayerState[], mode: GameMode, now: number): Sighting | null {
    if (mode !== 'tdm' || !player.team) return null;
    let best: Sighting | null = null;
    for (const other of others) {
      if (other.id === player.id || !other.bot || other.team !== player.team || other.health <= 0) continue;
      const seen = this.brains.get(other.id)?.seen;
      if (seen && now - seen.at < CALLOUT_MS && (!best || seen.at > best.at)) best = seen;
    }
    return best;
  }
  /** While our Recon Sweep runs, the minimap shows opponents (except Low Profile): head for the nearest. */
  private radar(brain: Brain, player: PlayerState, others: readonly PlayerState[], mode: GameMode, now: number): Sighting | null {
    const active = brain.reconUntil > now || (mode === 'tdm' && !!player.team &&
      others.some(other => other.id !== player.id && other.bot && other.team === player.team && (this.brains.get(other.id)?.reconUntil ?? 0) > now));
    if (!active) { brain.radar = null; return null; }
    if (now >= brain.radarAt) {
      brain.radarAt = now + 1000;
      let best: { other: PlayerState; distance: number } | null = null;
      for (const other of others) {
        if (other.id === player.id || !other.connected || other.health <= 0 || teammates(mode, player, other) || hasPerk(other.loadout, 'low-profile')) continue;
        const distance = horizontalDistance(player, other);
        if (!best || distance < best.distance) best = { other, distance };
      }
      brain.radar = best ? sighting(best.other, now) : null;
    }
    return brain.radar;
  }
  private patrol(brain: Brain, player: PlayerState, nav: BotNavigation, mode: GameMode): Vec3 {
    if (!brain.patrol || (horizontalDistance(player, brain.patrol) < 1.2 && sameHeight(player, brain.patrol))) {
      const choices = nav.patrolPoints.filter(p => horizontalDistance(player, p) > 8);
      const pick = () => choices[Math.floor(brain.random() * choices.length)];
      let choice = pick() ?? nav.patrolPoints[0] ?? point(player);
      // Team rivals lean toward the street between the houses, where the teams meet.
      if (mode === 'tdm' && choices.length) { const other = pick()!; if (Math.abs(other.x) < Math.abs(choice.x)) choice = other; }
      brain.patrol = point(choice);
    }
    return brain.patrol;
  }
  /** The nearest reachable spot out of the threat's sight that does not lead toward it. */
  private cover(player: PlayerState, threat: Sighting, nav: BotNavigation): Vec3 | null {
    const eye = { x: threat.x, y: threat.y + EYE_HEIGHT.stand, z: threat.z }, away = horizontalDistance(player, threat);
    let best: { spot: Vec3; score: number } | null = null;
    for (const spot of nav.patrolPoints) {
      const distance = horizontalDistance(player, spot);
      if (distance < 2.5 || distance > 16) continue;
      const fromThreat = horizontalDistance(threat, spot);
      if (fromThreat < away - 1) continue;
      const score = distance - 0.3 * fromThreat + (sameHeight(spot, player) ? 0 : 4);
      if (best && score >= best.score) continue;
      if (hiddenFrom(eye, spot)) best = { spot, score };
    }
    return best ? point(best.spot) : null;
  }
  /** A nearby spot well outside the blast of our own frag, favouring ones farther from it. */
  private refuge(player: PlayerState, blast: Vec3, nav: BotNavigation): Vec3 | null {
    let best: { spot: Vec3; score: number } | null = null;
    for (const spot of nav.patrolPoints) {
      const away = horizontalDistance(spot, blast);
      if (away < FRAG_CLEARANCE + 1.5 && Math.abs(spot.y - blast.y) < 2.5) continue;
      const distance = horizontalDistance(player, spot);
      if (distance > 15) continue;
      const score = distance - 0.5 * Math.min(away, 12) + (sameHeight(spot, player) ? 0 : 4);
      if (!best || score < best.score) best = { spot, score };
    }
    return best ? point(best.spot) : null;
  }
  /** Straight away from a blast point at full pace (no refuge in reach). */
  private awayFrom(player: PlayerState, blast: Vec3): Motion {
    const dx = player.x - blast.x, dz = player.z - blast.z, length = Math.hypot(dx, dz);
    return length > 1e-3 ? { x: dx / length, z: dz / length, speed: Infinity, straight: 0, remaining: 0 } : { x: 0, z: 1, speed: Infinity, straight: 0, remaining: 0 };
  }
  /** Stops a move that would carry the rival into the blast of its own live frag. */
  private keepClear(player: PlayerState, blast: Blast, motion: Motion): Motion {
    if (motion.speed <= 0.01) return motion;
    const ahead = { x: player.x + motion.x * 1.5, y: player.y, z: player.z + motion.z * 1.5 };
    return inBlast(blast, ahead) && horizontalDistance(ahead, blast) < horizontalDistance(player, blast) ? STILL : motion;
  }
  private attackerBearing(player: PlayerState, others: readonly PlayerState[], mode: GameMode): number | null {
    const chest = zoneCentre(player, 'torso');
    let best: { other: PlayerState; distance: number } | null = null;
    for (const other of others) {
      if (other.id === player.id || !other.connected || other.health <= 0 || teammates(mode, player, other)) continue;
      const distance = horizontalDistance(player, other);
      if ((!best || distance < best.distance) && clearLine(eyePosition(other), chest)) best = { other, distance };
    }
    return best ? bearing(player, best.other) : null;
  }

  /** Follow a navigation route, braking for corners and stairs so the shared physics never overshoots. */
  private follow(brain: Brain, player: PlayerState, goal: Vec3, now: number, nav: BotNavigation, arrive: boolean): Motion {
    if (now >= brain.nextRoute && (!brain.routeGoal || horizontalDistance(goal, brain.routeGoal) > 2 || !sameHeight(goal, brain.routeGoal) || !brain.route.length)) {
      brain.route = nav.findPath(player, goal); brain.routeGoal = point(goal); brain.nextRoute = now + 600; brain.routeFailed = !brain.route.length;
    }
    const walkable = nav.isWalkable(player);
    while (brain.route.length) {
      const next = brain.route[0]!, after = brain.route[1], close = horizontalDistance(player, next);
      let done: boolean;
      if (!after) done = close < 0.3 && sameHeight(player, next) && (walkable || close < 0.06);
      else if (!sameHeight(next, after) || !sameHeight(player, next)) {
        // Stair treads and the truck ramp are passed rather than hit exactly.
        done = walkable && ((close < 0.3 && Math.abs(player.y - next.y) < 0.4) || (Math.abs(player.y - next.y) < 0.7 && passed(player, next, after)));
      } else {
        // On one floor a corner is reached, or skipped once the next leg is in clear view. Cutting it short
        // would scrape the wall and can leave the body pressed against it.
        done = close < 0.06 || (walkable && nav.clearSegment(player, after));
      }
      if (!done) break;
      brain.route.shift();
    }
    const next = brain.route[0];
    // Pressed into a wall's padding with no route (yet): step straight back out toward open floor.
    if (!next) return walkable ? STILL : this.escape(player, nav);
    const dx = next.x - player.x, dz = next.z - player.z, d = Math.hypot(dx, dz);
    if (d < 1e-5) return STILL;
    let speed = Infinity, remaining = d;
    for (let i = 1; i < brain.route.length; i++) remaining += horizontalDistance(brain.route[i - 1]!, brain.route[i]!);
    if (next.y < player.y - 0.1) speed = DESCENT_SPEED;
    const after = brain.route[1];
    if (after) {
      const bx = after.x - next.x, bz = after.z - next.z, length = Math.hypot(bx, bz);
      const cos = length > 1e-5 ? (dx * bx + dz * bz) / (d * length) : 1;
      if (cos < 0.95) speed = Math.min(speed, Math.sqrt((1.5 + 5 * Math.max(0, cos)) ** 2 + 2 * BRAKE * Math.max(0, d - 0.3)));
      if (after.y < next.y - 0.1 && Math.abs(player.y - next.y) < 0.06) speed = Math.min(speed, Math.sqrt(DESCENT_SPEED ** 2 + 2 * BRAKE * Math.max(0, d - 0.3)));
    } else if (arrive) speed = Math.min(speed, Math.sqrt(2 * BRAKE * Math.max(0, d - 0.05)));
    return { x: dx / d, z: dz / d, speed, straight: d, remaining };
  }
  /** Walks straight out of a wall's padding (or toward the nearest waypoint when off the floor graph). */
  private escape(player: PlayerState, nav: BotNavigation): Motion {
    const way = nav.escapeDirection(player);
    return way ? { x: way.x, z: way.z, speed: ESCAPE_SPEED, straight: 0, remaining: 0 } : STILL;
  }
  /** Side-steps around a close opponent, backing off when too close (or stepping in to knife at arm's length),
   * never off the current floor. With both side steps blocked (a doorway, a window) it backs off at an angle or
   * straight, and only then steps in; STILL only when every way is blocked. */
  private strafe(brain: Brain, player: PlayerState, target: Vec3, distance: number, preferred: number, now: number, nav: BotNavigation): Motion {
    if (now >= brain.nextStrafe) { brain.strafe *= -1; brain.nextStrafe = now + 1300 + brain.random() * 1500; }
    const dx = (target.x - player.x) / Math.max(0.01, distance), dz = (target.z - player.z) / Math.max(0.01, distance);
    const advance = distance < KNIFE_CLOSE_IN ? 0.8 : distance < preferred * 0.45 ? -0.65 : 0, side = brain.strafe * 0.8;
    const back = Math.min(advance, -0.5), ahead = Math.max(advance, 0.5);
    // [toward the opponent, sideways, flips the strafe side]
    const options: ReadonlyArray<readonly [number, number, boolean]> = [
      [advance, side, false], [advance, -side, true], [back, side * 0.7, false], [back, -side * 0.7, true], [-0.8, 0, false],
      [ahead, side * 0.7, false], [ahead, -side * 0.7, true], [0.8, 0, false],
    ];
    for (const [forward, sideways, flips] of options) {
      const w = { x: dx * forward - dz * sideways, z: dz * forward + dx * sideways };
      if (!nav.clearSegment(player, { x: player.x + w.x, y: player.y, z: player.z + w.z })) continue;
      if (flips) brain.strafe *= -1;
      const length = Math.hypot(w.x, w.z);
      return { x: w.x / length, z: w.z / length, speed: 3 * length, straight: 0, remaining: 0 };
    }
    return STILL;
  }
  /** Replans when the bot has wanted to move for two seconds without getting anywhere. */
  private unstick(brain: Brain, player: PlayerState, motion: Motion, now: number, task: Task) {
    brain.windowTicks++; if (motion.speed > 1) brain.movingTicks++;
    if (now < brain.progressAt) return;
    const moved = horizontalDistance(player, brain.progressFrom) + Math.abs(player.y - brain.progressFrom.y);
    if (brain.windowTicks > 10 && brain.movingTicks >= brain.windowTicks * 0.8 && moved < 0.5) {
      brain.route = []; brain.routeGoal = null; brain.nextRoute = now; brain.patrol = null; brain.retreat = null; brain.refuge = null;
      if (task === 'chase') brain.seen = null;
    }
    brain.progressFrom = point(player); brain.progressAt = now + 2000; brain.windowTicks = 0; brain.movingTicks = 0;
  }
  /** Converts a world-space wish into this frame's stick, choosing walk, sprint or dash so the shared physics moves
   * at the wanted speed. Stick values never leave [-1, 1]. */
  private drive(frame: InputFrame, player: PlayerState, spec: WeaponSpec, motion: Motion, wantSprint: boolean, wantDash: boolean) {
    if (motion.speed <= 0.01) return;
    const cos = Math.cos(frame.yaw), sin = Math.sin(frame.yaw);
    const lx = motion.x * cos + motion.z * sin, lz = motion.x * sin - motion.z * cos;
    const crouched = frame.crouch || player.posture === 'crouch';
    let walk = crouched ? MOVE.crouch : lz >= 0 ? MOVE.strafe + (MOVE.walk - MOVE.strafe) * lz : MOVE.strafe + (MOVE.back - MOVE.strafe) * -lz;
    walk *= handlingFactor(spec, frame.aim);
    if (wantSprint && !frame.aim && !frame.fire && !crouched && player.posture === 'stand' && lz > 0.35 && Math.abs(lx) <= lz * 1.2) {
      const sprint = MOVE.sprint * spec.moveFactor;
      if (motion.speed >= sprint * 0.98) {
        const dash = (MOVE.sprint + (MOVE.dash - MOVE.sprint) * Math.min(1, player.stamina / MOVE.dashFadeStamina)) * spec.moveFactor;
        frame.sprint = true; frame.dash = wantDash && player.stamina > 0 && motion.speed >= dash * 0.98;
        frame.moveX = clamp(lx, -1, 1); frame.moveZ = clamp(lz, -1, 1);
        return;
      }
    }
    const amount = clamp(motion.speed / Math.max(0.1, walk), 0, 1);
    frame.moveX = clamp(lx * amount, -1, 1); frame.moveZ = clamp(lz * amount, -1, 1);
  }
}
