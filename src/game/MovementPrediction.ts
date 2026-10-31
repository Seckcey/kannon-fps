import { clamp, moveDefaults, movePlayer, type MoveContext, type MoveEvents, type MoveState } from '../../shared/physics';
import { RULES, type InputFrame, type Loadout, type PlayerState, type PublicPlayerState, type Vec3 } from '../../shared/protocol';
import { DEFAULT_LOADOUT, weaponFor } from '../../shared/weapons';

/** What a snapshot tells the predictor: the public pose plus, for the local player, `self`. */
export type PredictionSource = PublicPlayerState & Partial<Pick<PlayerState, 'stamina' | 'slideCooldownUntil' | 'meleeUntil' | 'frags'>>;
/** The previous accepted input's held buttons; rising edges are measured against it. */
export type InputEdges = Pick<InputFrame, 'jump' | 'crouch' | 'melee' | 'grenade'>;
const released: InputEdges = { jump: false, crouch: false, melee: false, grenade: false };
export const TICK_SECONDS = 1 / 30;
export const TICK_MS = 1000 / 30;

/** The server's per-tick movement context, shared by prediction and its replay-parity tests:
 * rising edges from the previous accepted input, the equipped weapon's movement factors, and
 * no sprint while cooking a grenade or knifing. */
export function serverMoveContext(input: InputFrame, previous: InputEdges, loadout: Loadout, now: number, dt: number,
  limits: { cooking: boolean; meleeUntil: number }): MoveContext {
  const weapon = weaponFor(loadout, input.slot);
  return {
    now, dt,
    jumpPressed: input.jump && !previous.jump, crouchPressed: input.crouch && !previous.crouch,
    moveFactor: weapon.moveFactor, adsFactor: weapon.adsMoveFactor,
    canSprint: !limits.cooking && now >= limits.meleeUntil,
  };
}

/** Replays `movePlayer` for the local player from the latest authoritative snapshot, one server
 * tick per sent input. Replay advances from that snapshot's server time, not the wall clock at
 * which old inputs are replayed. The server moves before it handles this tick's knife and grenade
 * edges, so a new cook or knife limits sprint from the following tick. One tick per input is what
 * the server does with a steady input stream; it can coalesce inputs that arrive in a burst. */
export class MovementPrediction {
  readonly state: MoveState = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, ...moveDefaults() };
  /** Predicted server time of the last step. */
  time = 0;
  private previous: InputEdges = { ...released };
  private loadout: Loadout = DEFAULT_LOADOUT;
  private cooking = false;
  private cookingSince = 0;
  private meleeUntil = 0;
  private frags: number = RULES.fragsPerLife;

  /** Adopt an authoritative pose. `acknowledged` is the last input the server processed (edge baseline). */
  reset(source: PredictionSource, serverTime: number, acknowledged: InputEdges | null = null): MoveState {
    const s = this.state;
    s.x = source.x; s.y = source.y; s.z = source.z; s.vx = source.vx; s.vy = source.vy; s.vz = source.vz;
    s.yaw = source.yaw; s.pitch = source.pitch;
    s.posture = source.posture ?? 'stand'; s.vault = source.vault ? { ...source.vault } : null;
    s.slideUntil = source.slideUntil ?? 0; s.slideCooldownUntil = source.slideCooldownUntil ?? 0;
    s.stamina = Number.isFinite(source.stamina) ? clamp(source.stamina!, 0, 1) : 1;
    s.sprinting = !!source.sprinting; s.dashing = !!source.dashing;
    this.time = serverTime;
    this.loadout = source.loadout ?? DEFAULT_LOADOUT;
    this.cookingSince = source.cookingSince ?? 0; this.cooking = this.cookingSince > 0;
    this.meleeUntil = source.meleeUntil ?? 0;
    this.frags = source.frags ?? RULES.fragsPerLife;
    this.previous = acknowledged ? { jump: acknowledged.jump, crouch: acknowledged.crouch, melee: acknowledged.melee, grenade: acknowledged.grenade } : { ...released };
    return s;
  }

  /** One server tick with this input. Always a whole tick: stepping by render frames would judge
   * presses against a body the server never had. */
  step(input: InputFrame): MoveEvents {
    this.time += TICK_MS;
    const ctx = serverMoveContext(input, this.previous, this.loadout, this.time, TICK_SECONDS, { cooking: this.cooking, meleeUntil: this.meleeUntil });
    const events = movePlayer(this.state, input, ctx);
    if (input.melee && !this.previous.melee && this.time >= this.meleeUntil && !this.cooking) this.meleeUntil = this.time + RULES.meleeMs;
    if (input.grenade && !this.previous.grenade && !this.cooking && this.frags > 0 && this.time >= this.meleeUntil) {
      this.cooking = true; this.cookingSince = this.time;
    } else if (this.cooking && (!input.grenade || this.time >= this.cookingSince + RULES.fragFuseMs)) {
      this.cooking = false; this.cookingSince = 0; this.frags = Math.max(0, this.frags - 1);
    }
    this.previous = { jump: input.jump, crouch: input.crouch, melee: input.melee, grenade: input.grenade };
    return events;
  }

  /** Progress of the current vault 0..1, or 1 when not vaulting (firing waits for 0.7). */
  vaultProgress(now = this.time): number { return vaultProgress(this.state.vault, now); }
}

/** Corrections larger than this are teleports or respawns: the view jumps instead of gliding. */
export const SNAP_DISTANCE = 3.5;
const MAX_PENDING = 120;
const copyPoint = (target: Vec3, source: Vec3) => { target.x = source.x; target.y = source.y; target.z = source.z; };

/** The local player's prediction between snapshots. The predicted path advances only with inputs
 * actually sent, one server tick each, so every press is judged against the same body the server
 * judges it against: a jump pressed on the frame the view lands cannot become a vault the server
 * never does. The body is drawn between the last two predicted ticks. A correction offset glides
 * it onto the authoritative path after each snapshot (and over send-timer jitter), and the
 * predicted clock leads the snapshot clock by about one round trip. */
export class LocalPrediction {
  readonly movement = new MovementPrediction();
  /** Drawn minus predicted position; it decays so corrections never jump the camera. */
  readonly correction = { x: 0, y: 0, z: 0 };
  pending: InputFrame[] = [];
  /** Predicted server time minus the snapshot time; smoothed and kept across lives. */
  clockLead = 0;
  /** A snapshot has supplied the local player. */
  active = false;
  private acknowledged: InputFrame | null = null;
  private leadMeasured = false;
  /** Feet at the predicted tick before the latest one; the body is drawn between the two. */
  private readonly prior: Vec3 = { x: 0, y: 0, z: 0 };
  /** Wall-clock time (ms) the latest tick was predicted, and the smoothed time between sent inputs. */
  private steppedAt = -Infinity;
  private interval = TICK_MS;

  /** One input actually sent to the server, at wall-clock `now` (ms). While `live` (the server will
   * simulate it), the prediction also advances one tick, and that tick's events are returned. */
  record(frame: InputFrame, now: number, live: boolean): MoveEvents | null {
    this.pending.push({ ...frame });
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
    if (!live || !this.active) return null;
    const drawn = this.feet(now);
    copyPoint(this.prior, this.movement.state);
    const events = this.movement.step(frame);
    const elapsed = now - this.steppedAt;
    if (elapsed > 0 && elapsed < 4 * TICK_MS) this.interval += (clamp(elapsed, TICK_MS / 2, TICK_MS * 2) - this.interval) * 0.1;
    this.steppedAt = now;
    // A send timer that fires a little early or late must not jump the drawn body.
    this.hold(drawn, now);
    return events;
  }

  /** Adopt the server's pose after input `ack` and replay the inputs still in flight. Outside live
   * play the server ignores inputs, so none survive; a new life also starts with none.
   * Returns true when the view should jump (spawn, first snapshot or a teleport). */
  receive(source: PredictionSource, serverTime: number, ack: number, live: { playing: boolean; alive: boolean; spawned: boolean }, now: number): boolean {
    const acknowledged = this.pending.filter(frame => frame.seq <= ack).at(-1);
    if (acknowledged) this.acknowledged = acknowledged;
    this.pending = live.playing && !live.spawned ? this.pending.filter(frame => frame.seq > ack) : [];
    if (live.spawned) this.acknowledged = null;
    const drawn = this.active && !live.spawned ? this.feet(now) : null;
    const state = this.movement.reset(source, serverTime, this.acknowledged);
    copyPoint(this.prior, state);
    if (live.playing && live.alive) {
      this.pending.forEach((frame, index) => {
        if (index === this.pending.length - 1) copyPoint(this.prior, state);
        this.movement.step(frame);
      });
      if (!live.spawned) {
        const lead = this.movement.time - serverTime;
        this.clockLead = this.leadMeasured ? this.clockLead * 0.8 + lead * 0.2 : lead;
        this.leadMeasured = true;
      }
    }
    this.active = true;
    if (drawn) this.hold(drawn, now);
    if (!drawn || Math.hypot(this.correction.x, this.correction.y, this.correction.z) > SNAP_DISTANCE) {
      this.correction.x = this.correction.y = this.correction.z = 0;
      copyPoint(this.prior, state);
      return true;
    }
    return false;
  }

  /** Let the correction glide away over a render frame. */
  settle(dt: number) {
    const k = Math.exp(-(Number.isFinite(dt) ? Math.max(0, dt) : 0) * 10);
    this.correction.x *= k; this.correction.y *= k; this.correction.z *= k;
  }

  /** Where the local body is drawn at wall-clock `now` (ms): between the last two predicted ticks,
   * plus the gliding correction. */
  feet(now: number): Vec3 {
    const state = this.movement.state, prior = this.prior, t = this.blend(now);
    return {
      x: prior.x + (state.x - prior.x) * t + this.correction.x,
      y: prior.y + (state.y - prior.y) * t + this.correction.y,
      z: prior.z + (state.z - prior.z) * t + this.correction.z,
    };
  }

  /** 0 just after a tick is predicted, rising to 1 as the next sent input falls due. */
  private blend(now: number): number {
    return Number.isFinite(now) && Number.isFinite(this.steppedAt) ? clamp((now - this.steppedAt) / this.interval, 0, 1) : 1;
  }

  /** Keep the body drawn at `drawn` now, whatever the predicted ticks just did; it glides from there. */
  private hold(drawn: Vec3, now: number) {
    this.correction.x = this.correction.y = this.correction.z = 0;
    const base = this.feet(now);
    this.correction.x = drawn.x - base.x; this.correction.y = drawn.y - base.y; this.correction.z = drawn.z - base.z;
  }
}

/** Mirrors the shared rule that a vault blocks firing until 70% of the way through. */
export function vaultProgress(vault: MoveState['vault'], now: number): number {
  if (!vault) return 1;
  return clamp((now - vault.start) / Math.max(1, vault.end - vault.start), 0, 1);
}
