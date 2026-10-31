import { clamp, directionFromAngles, normalize, rightFromYaw } from '../../shared/physics';
import { RULES, type InputFrame, type Loadout, type PlayerState, type Slot, type Vec3, type WeaponId } from '../../shared/protocol';
import {
  DEEP_POCKETS_EXTRA_MAGS, DEFAULT_LOADOUT, EXPLOSIVES, fireIntervalMs, hasPerk, PELLET_PATTERN, QUICK_HANDS_FACTOR, STEADY_AIM_ADS_FACTOR, weaponFor,
  type WeaponSpec,
} from '../../shared/weapons';

/** The local player's weapon as the server will run it, predicted for instant presentation.
 * Times are predicted server milliseconds. The server's ammo, reload and timers win: every
 * snapshot replaces the acknowledged state and silently replays the inputs still in flight. */
export interface WeaponState {
  slot: Slot; mag: [number, number]; reserve: [number, number]; frags: number;
  reloadSlot: Slot | 0; reloadingUntil: number; reloadStartedAt: number; reloadEmpty: boolean;
  /** Shell-by-shell reloads: shells this reload loads in all, shells still to insert and when the next one goes in. */
  reloadShells: number; shellsLeft: number; nextShellAt: number;
  readyAt: number; meleeUntil: number; cookingSince: number;
  /** Each slot keeps its own cadence (a swap never skips a bolt or pump), shots in the current
   * trigger pull, and a semi-automatic press made too early, which fires once allowed while the
   * trigger stays down. */
  nextFireAt: [number, number]; burst: number; triggerPending: boolean;
  /** The last tick spent sprinting, and whether it was the faster dash (sprint-to-fire). */
  lastSprintAt: number; lastSprintDash: boolean;
  /** The tick aim went down, as the server records it for the shot's aim progress; null while not aiming. */
  aimSince: number | null;
}
export interface WeaponStepContext {
  /** Predicted server time of the tick that processes this input. */
  now: number;
  alive: boolean;
  /** Movement after this tick's move (sprint ends when firing starts). */
  sprinting: boolean; dashing: boolean;
  /** Vault progress 0..1 after this tick's move (1 when not vaulting); the held trigger waits for 0.7. */
  vaultProgress: number;
  /** The same on the body before this tick's move, where the server judges a new trigger press. */
  pressVaultProgress: number;
  /** A vault was under way before this tick's move; the server refuses the knife and a cook then. */
  vaultingBefore: boolean;
  /** Aim-down-sights blend when the shot leaves, for recoil. */
  ads: number;
}
export type WeaponEvent =
  /** `aim` is how far the sights were up as the server judges it (0..1), which sets its spread;
   * `at` is the predicted server time of the tick. */
  | { type: 'shot'; weapon: WeaponId; slot: Slot; burst: number; kick: { yaw: number; pitch: number }; aim: number; at: number }
  | { type: 'reload'; weapon: WeaponId; empty: boolean }
  | { type: 'shell'; weapon: WeaponId }
  | { type: 'reloaded'; weapon: WeaponId; empty: boolean }
  | { type: 'swap'; weapon: WeaponId }
  | { type: 'dry'; weapon: WeaponId }
  | { type: 'melee' }
  | { type: 'cook' }
  | { type: 'throw'; inHand: boolean };

export const VAULT_FIRE_PROGRESS = 0.7;
export const DASH_SPRINT_TO_FIRE = 1.4;
const HISTORY = 120;

/** Spare rounds at spawn: the weapon's spare magazines, plus two with Deep Pockets. */
export function spawnReserve(spec: WeaponSpec, loadout: Loadout): number {
  return spec.magazine * (spec.reserveMags + (hasPerk(loadout, 'deep-pockets') ? DEEP_POCKETS_EXTRA_MAGS : 0));
}
export function spawnFrags(loadout: Loadout): number { return RULES.fragsPerLife + (hasPerk(loadout, 'deep-pockets') ? 1 : 0); }
export const handlingFactor = (loadout: Loadout) => hasPerk(loadout, 'quick-hands') ? QUICK_HANDS_FACTOR : 1;
/** Magazine reload time; shell-by-shell weapons use `shellReloadMs`. */
export function reloadMs(spec: WeaponSpec, empty: boolean, loadout: Loadout): number {
  return (empty ? spec.emptyReloadMs : spec.reloadMs) * handlingFactor(loadout);
}
export function shellReloadMs(spec: WeaponSpec, shells: number, loadout: Loadout): number {
  return ((spec.shellStartMs ?? 0) + (spec.perShellMs ?? 0) * shells) * handlingFactor(loadout);
}
export function sprintToFireMs(spec: WeaponSpec, dashed: boolean): number { return spec.sprintToFireMs * (dashed ? DASH_SPRINT_TO_FIRE : 1); }

/** View kick for the `burst`-th shot of a trigger pull (0 = first): a repeatable climb eased over
 * `ramp` shots and a horizontal drift from the pattern, reduced while aiming. */
export function recoilKick(spec: WeaponSpec, burst: number, ads: number): { yaw: number; pitch: number } {
  const recoil = spec.recoil, shot = Math.max(0, Math.floor(burst));
  const t = recoil.ramp <= 1 ? 1 : Math.min(1, shot / recoil.ramp), eased = t * t * (3 - 2 * t);
  const scale = 1 + (recoil.adsFactor - 1) * clamp(Number.isFinite(ads) ? ads : 0, 0, 1);
  const vertical = recoil.vertical[0] + (recoil.vertical[1] - recoil.vertical[0]) * eased;
  const drift = recoil.pattern.length ? recoil.pattern[shot % recoil.pattern.length]! : 0;
  return { yaw: recoil.horizontal * drift * scale, pitch: vertical * scale };
}

/** How far the sights are up for a shot, as the server judges it: from the tick aim went down, over
 * the weapon's aim time (20% shorter with Cool Head); 0 when the shot's frame is not aiming. */
export function aimProgress(spec: WeaponSpec, loadout: Loadout, aimSince: number | null, aimed: boolean, now: number): number {
  if (!aimed || aimSince === null || !Number.isFinite(aimSince)) return 0;
  const time = spec.adsMs * (hasPerk(loadout, 'steady-aim') ? STEADY_AIM_ADS_FACTOR : 1);
  return clamp((now - aimSince) / Math.max(1, time), 0, 1);
}
const progress01 = (value: number) => clamp(Number.isFinite(value) ? value : 0, 0, 1);
/** Half-angle of the random cone the server rolls a single bullet inside, narrowing as the sights come
 * up (only the Heron 7 has one: wide from the hip, none fully scoped). Shotgun pellets keep their fixed
 * pattern instead, so this is 0 for them. */
export function shotCone(spec: WeaponSpec, aim: number): number {
  if (spec.pellets > 1) return 0;
  return spec.hipSpread + (spec.adsSpread - spec.hipSpread) * progress01(aim);
}

/** Directions a shot travels for presentation: the crosshair ray, or the shotgun's fixed pellet
 * pattern (centre first) spread around it, narrowing with the aim progress exactly as on the server. */
export function shotDirections(spec: WeaponSpec, yaw: number, pitch: number, aim: number): Vec3[] {
  const forward = directionFromAngles(yaw, pitch);
  if (spec.pellets <= 1) return [forward];
  const right = rightFromYaw(yaw);
  const up = { x: right.y * forward.z - right.z * forward.y, y: right.z * forward.x - right.x * forward.z, z: right.x * forward.y - right.y * forward.x };
  const hip = spec.pelletSpread?.hip ?? 0, spread = hip + ((spec.pelletSpread?.ads ?? 0) - hip) * progress01(aim);
  return PELLET_PATTERN.slice(0, spec.pellets).map(([px, py]) => normalize({
    x: forward.x + (right.x * px + up.x * py) * spread, y: forward.y + (right.y * px + up.y * py) * spread, z: forward.z + (right.z * px + up.z * py) * spread,
  }));
}

/** How far apart (ms) a predicted shot and the server's confirmation of it may be. */
const TRACER_MATCH_MS = 250;
/** The local player's shots that left inside a random cone: the client cannot know where they went,
 * so their tracer is drawn from the server's shot event instead of along the crosshair. Each confirmed
 * shot is matched to the expected one by weapon and tick time; shots the server never fired fall away. */
export class ServerTracers {
  private expected: Array<{ weapon: WeaponId; at: number }> = [];
  expect(weapon: WeaponId, at: number) {
    if (!Number.isFinite(at)) return;
    this.expected.push({ weapon, at });
    if (this.expected.length > 8) this.expected.shift();
  }
  /** True when this confirmed local shot is one whose tracer was left to the server. */
  take(weapon: WeaponId | 'drone', at: number): boolean {
    if (!Number.isFinite(at)) return false;
    while (this.expected.length && this.expected[0]!.at < at - TRACER_MATCH_MS) this.expected.shift();
    const next = this.expected[0];
    if (!next || next.weapon !== weapon || next.at > at + TRACER_MATCH_MS) return false;
    this.expected.shift();
    return true;
  }
  clear() { this.expected = []; }
}

/** Gives back part of a burst's climb after the trigger is released, never below where it began
 * (a player who already pulled down is not pulled further). */
export class RecoilRecovery {
  private yaw = 0;
  private pitch = 0;
  private startPitch: number | null = null;
  private returnYaw = 0;
  private returnPitch = 0;
  kick(kick: { yaw: number; pitch: number }, currentPitch: number) {
    if (!this.yaw && !this.pitch) { this.startPitch = currentPitch; this.returnYaw = 0; this.returnPitch = 0; }
    this.yaw += kick.yaw; this.pitch += kick.pitch;
  }
  /** The trigger was released: `share` (0..1) of the burst's kick will return. */
  release(share: number) {
    if (!this.yaw && !this.pitch) return;
    const amount = clamp(Number.isFinite(share) ? share : 0, 0, 1);
    this.returnYaw = this.yaw * amount; this.returnPitch = this.pitch * amount;
    this.yaw = 0; this.pitch = 0;
  }
  get pending() { return Math.abs(this.returnPitch) + Math.abs(this.returnYaw); }
  /** The view change to apply this frame. */
  update(dt: number, currentPitch: number): { yaw: number; pitch: number } {
    if (!this.returnPitch && !this.returnYaw) return { yaw: 0, pitch: 0 };
    const k = 1 - Math.exp(-(Number.isFinite(dt) ? Math.max(0, dt) : 0) * 9);
    let pitch = this.returnPitch * k;
    const yaw = this.returnYaw * k;
    this.returnPitch -= pitch; this.returnYaw -= yaw;
    if (this.startPitch !== null && pitch > 0) pitch = Math.min(pitch, Math.max(0, currentPitch - this.startPitch));
    if (Math.abs(this.returnPitch) < 1e-5 && Math.abs(this.returnYaw) < 1e-5) { this.returnPitch = 0; this.returnYaw = 0; this.startPitch = null; }
    return { yaw: -yaw, pitch: -pitch };
  }
  reset() { this.yaw = this.pitch = this.returnYaw = this.returnPitch = 0; this.startPitch = null; }
}

const blankState = (loadout: Loadout): WeaponState => {
  const primary = weaponFor(loadout, 1), secondary = weaponFor(loadout, 2);
  return {
    slot: 1, mag: [primary.magazine, secondary.magazine], reserve: [spawnReserve(primary, loadout), spawnReserve(secondary, loadout)], frags: spawnFrags(loadout),
    reloadSlot: 0, reloadingUntil: 0, reloadStartedAt: 0, reloadEmpty: false, reloadShells: 0, shellsLeft: 0, nextShellAt: 0,
    readyAt: 0, meleeUntil: 0, cookingSince: 0, nextFireAt: [-Infinity, -Infinity], burst: 0, triggerPending: false,
    lastSprintAt: -Infinity, lastSprintDash: false, aimSince: null,
  };
};
const copy = (state: WeaponState): WeaponState => ({
  ...state, mag: [state.mag[0], state.mag[1]], reserve: [state.reserve[0], state.reserve[1]], nextFireAt: [state.nextFireAt[0], state.nextFireAt[1]],
});
type Edges = Pick<InputFrame, 'fire' | 'melee' | 'grenade'>;
interface Entry { seq: number; input: InputFrame; ctx: WeaponStepContext; before: WeaponState; previous: Edges | null }

export class LocalWeapon {
  state: WeaponState;
  loadout: Loadout;
  private previous: Edges | null = null;
  private history: Entry[] = [];

  constructor(loadout: Loadout = DEFAULT_LOADOUT) { this.loadout = loadout; this.state = blankState(loadout); }

  get spec(): WeaponSpec { return weaponFor(this.loadout, this.state.slot); }
  get weapon(): WeaponId { return this.spec.id; }
  get cooking() { return this.state.cookingSince > 0; }

  /** Adopt the server's full state (spawn, respawn, first snapshot); nothing in flight survives. */
  reset(self: PlayerState, serverTime: number, previous: Edges | null = null) {
    this.loadout = self.loadout ?? DEFAULT_LOADOUT;
    this.state = blankState(this.loadout);
    this.adopt(this.state, self, serverTime);
    this.previous = previous ? { fire: previous.fire, melee: previous.melee, grenade: previous.grenade } : null;
    this.history = [];
  }

  /** Server state after input `ackSeq` replaces the prediction; later inputs replay silently. */
  reconcile(self: PlayerState, ackSeq: number, serverTime: number) {
    this.loadout = self.loadout ?? this.loadout;
    const pending = this.history.filter(entry => entry.seq > ackSeq);
    const base = pending.length ? copy(pending[0]!.before) : copy(this.state);
    this.adopt(base, self, serverTime);
    this.state = base;
    if (pending.length) this.previous = pending[0]!.previous;
    this.history = [];
    for (const entry of pending) this.advance(entry.input, entry.ctx, null);
  }

  /** One sent input. Returns what the player should see and hear now. */
  step(input: InputFrame, ctx: WeaponStepContext): WeaponEvent[] {
    const events: WeaponEvent[] = [];
    this.advance(input, ctx, events);
    return events;
  }

  /** True when a trigger pull now would fire (HUD dims the crosshair otherwise; Simple fire waits
   * for it). A shell-by-shell reload stops for a pull once a shell is in, so it does not block then. */
  fireReady(ctx: Pick<WeaponStepContext, 'now' | 'sprinting' | 'vaultProgress'>): boolean {
    const s = this.state, spec = this.spec;
    return (!s.reloadSlot || this.interruptible(ctx.now)) && !ctx.sprinting && ctx.now >= s.readyAt && ctx.now >= s.meleeUntil && !s.cookingSince
      && ctx.vaultProgress >= VAULT_FIRE_PROGRESS && ctx.now >= s.lastSprintAt + sprintToFireMs(spec, s.lastSprintDash);
  }
  /** A shell-by-shell reload of the weapon in hand with a shell already in, or one due by `now`
   * (the tick inserts it before the trigger is read). */
  private interruptible(now: number): boolean {
    const s = this.state, spec = this.spec, index = s.slot - 1;
    return !!spec.perShellMs && s.reloadSlot === s.slot
      && (s.mag[index] > 0 || (s.shellsLeft > 0 && s.reserve[index] > 0 && s.mag[index] < spec.magazine && now >= s.nextShellAt));
  }
  /** Reload progress 0..1, or -1 when not reloading. */
  reloadProgress(now: number): number {
    const s = this.state;
    if (!s.reloadSlot || s.reloadSlot !== s.slot) return -1;
    return clamp((now - s.reloadStartedAt) / Math.max(1, s.reloadingUntil - s.reloadStartedAt), 0, 1);
  }
  /** Weapon raise 0 (just swapped or spawned) .. 1 (ready). */
  raise(now: number): number {
    const remaining = this.state.readyAt - now;
    return remaining <= 0 ? 1 : clamp(1 - remaining / Math.max(1, this.spec.raiseMs * handlingFactor(this.loadout)), 0, 1);
  }
  /** Grenade cook 0..1, or -1. */
  cook(now: number): number {
    return this.state.cookingSince ? clamp((now - this.state.cookingSince) / EXPLOSIVES.frag.fuseMs, 0, 1) : -1;
  }

  private adopt(state: WeaponState, self: PlayerState, serverTime: number) {
    state.slot = self.slot === 2 ? 2 : 1;
    if (Array.isArray(self.mag)) state.mag = [self.mag[0] ?? state.mag[0], self.mag[1] ?? state.mag[1]];
    if (Array.isArray(self.reserve)) state.reserve = [self.reserve[0] ?? state.reserve[0], self.reserve[1] ?? state.reserve[1]];
    if (Number.isFinite(self.frags)) state.frags = self.frags;
    if (Number.isFinite(self.readyAt)) state.readyAt = self.readyAt;
    if (Number.isFinite(self.meleeUntil)) state.meleeUntil = self.meleeUntil;
    state.cookingSince = Number.isFinite(self.cookingSince) ? self.cookingSince : 0;
    const reloadSlot = self.reloadSlot === 1 || self.reloadSlot === 2 ? self.reloadSlot : 0;
    if (!reloadSlot || !(self.reloadingUntil > 0)) {
      state.reloadSlot = 0; state.reloadingUntil = 0; state.shellsLeft = 0; return;
    }
    // Keep the predicted timing when it agrees; otherwise derive it from the server's deadline.
    if (state.reloadSlot === reloadSlot && Math.abs(state.reloadingUntil - self.reloadingUntil) <= 2) return;
    const spec = weaponFor(this.loadout, reloadSlot), index = reloadSlot - 1;
    state.reloadSlot = reloadSlot; state.reloadingUntil = self.reloadingUntil;
    if (spec.perShellMs) {
      const per = spec.perShellMs * handlingFactor(this.loadout);
      state.shellsLeft = Math.max(1, Math.min(spec.magazine - state.mag[index], state.reserve[index], Math.ceil((self.reloadingUntil - serverTime) / per)));
      state.nextShellAt = self.reloadingUntil - (state.shellsLeft - 1) * per;
      state.reloadEmpty = state.mag[index] === 0;
      state.reloadShells = Math.max(state.shellsLeft, spec.magazine - state.mag[index]);
      state.reloadStartedAt = self.reloadingUntil - shellReloadMs(spec, state.reloadShells, this.loadout);
    } else {
      state.reloadEmpty = state.mag[index] === 0;
      state.reloadStartedAt = self.reloadingUntil - reloadMs(spec, state.reloadEmpty, this.loadout);
    }
  }

  private cancelReload(state: WeaponState) { state.reloadSlot = 0; state.reloadingUntil = 0; state.shellsLeft = 0; }

  private startReload(state: WeaponState, now: number, events: WeaponEvent[] | null) {
    const spec = weaponFor(this.loadout, state.slot), index = state.slot - 1;
    state.reloadSlot = state.slot; state.reloadStartedAt = now; state.reloadEmpty = state.mag[index] === 0; state.burst = 0;
    if (spec.perShellMs) {
      const shells = Math.min(spec.magazine - state.mag[index], state.reserve[index]);
      state.reloadShells = shells; state.shellsLeft = shells;
      state.nextShellAt = now + shellReloadMs(spec, 1, this.loadout);
      state.reloadingUntil = now + shellReloadMs(spec, shells, this.loadout);
    } else state.reloadingUntil = now + reloadMs(spec, state.reloadEmpty, this.loadout);
    events?.push({ type: 'reload', weapon: spec.id, empty: state.reloadEmpty });
  }

  private progressReload(state: WeaponState, now: number, events: WeaponEvent[] | null) {
    if (!state.reloadSlot) return;
    const spec = weaponFor(this.loadout, state.reloadSlot), index = state.reloadSlot - 1;
    if (spec.perShellMs) {
      const per = spec.perShellMs * handlingFactor(this.loadout);
      while (state.shellsLeft > 0 && now >= state.nextShellAt && state.reserve[index] > 0 && state.mag[index] < spec.magazine) {
        state.mag[index]++; state.reserve[index]--; state.shellsLeft--; state.nextShellAt += per;
        events?.push({ type: 'shell', weapon: spec.id });
      }
      if (state.shellsLeft <= 0 || state.reserve[index] <= 0 || state.mag[index] >= spec.magazine) {
        events?.push({ type: 'reloaded', weapon: spec.id, empty: state.reloadEmpty });
        this.cancelReload(state);
      }
    } else if (now >= state.reloadingUntil) {
      const load = Math.min(spec.magazine - state.mag[index], state.reserve[index]);
      state.mag[index] += load; state.reserve[index] -= load;
      events?.push({ type: 'reloaded', weapon: spec.id, empty: state.reloadEmpty });
      this.cancelReload(state);
    }
  }

  private advance(input: InputFrame, ctx: WeaponStepContext, events: WeaponEvent[] | null) {
    const before = copy(this.state), previous = this.previous;
    this.history.push({ seq: input.seq, input, ctx, before, previous });
    if (this.history.length > HISTORY) this.history.splice(0, this.history.length - HISTORY);
    const s = this.state, now = ctx.now;
    this.previous = { fire: input.fire, melee: input.melee, grenade: input.grenade };
    if (!ctx.alive) { s.burst = 0; s.triggerPending = false; s.aimSince = null; return; }
    const pressed = (key: keyof Edges) => input[key] && !(previous?.[key] ?? false);
    const factor = handlingFactor(this.loadout), slot = input.slot === 1 || input.slot === 2 ? input.slot : s.slot;
    const firePressed = pressed('fire'), wasFiring = !!previous?.fire;
    // The server's order: due shells go in, the aim start is noted, a press made with the weapon in hand
    // fires before a swap, the knife and a cook start before moving, then the reload key, then the held
    // trigger. The press, the knife and the cook are judged on the body before this tick's move.
    this.progressReload(s, now, events);
    if (!input.aim) s.aimSince = null; else if (s.aimSince === null) s.aimSince = now;
    const early = firePressed && slot === s.slot;
    if (early) this.tryFire(s, { ...ctx, vaultProgress: ctx.pressVaultProgress }, events, firePressed, wasFiring, input.aim);
    if (slot !== s.slot) {
      s.slot = slot; this.cancelReload(s); s.burst = 0; s.triggerPending = false;
      s.readyAt = Math.max(s.readyAt, now + weaponFor(this.loadout, s.slot).raiseMs * factor);
      events?.push({ type: 'swap', weapon: weaponFor(this.loadout, s.slot).id });
    }
    if (pressed('melee') && now >= s.meleeUntil && !s.cookingSince && !ctx.vaultingBefore) {
      s.meleeUntil = now + RULES.meleeMs; s.readyAt = Math.max(s.readyAt, s.meleeUntil); this.cancelReload(s); s.burst = 0;
      events?.push({ type: 'melee' });
    }
    if (pressed('grenade') && !s.cookingSince && s.frags > 0 && now >= s.meleeUntil && !ctx.vaultingBefore) {
      // The frag leaves the belt when the cook starts, as on the server.
      s.cookingSince = now; s.frags--; this.cancelReload(s); s.burst = 0;
      events?.push({ type: 'cook' });
    } else if (s.cookingSince && (!input.grenade || now >= s.cookingSince + EXPLOSIVES.frag.fuseMs)) {
      events?.push({ type: 'throw', inHand: input.grenade });
      s.cookingSince = 0;
    }
    if (ctx.sprinting) { s.lastSprintAt = now; s.lastSprintDash = ctx.dashing; }
    const spec = weaponFor(this.loadout, s.slot), index = s.slot - 1;
    if (input.reload && !s.reloadSlot && s.mag[index] < spec.magazine && s.reserve[index] > 0 && !s.cookingSince && now >= s.meleeUntil) this.startReload(s, now, events);
    if (!early && (firePressed || ((spec.auto || s.triggerPending) && input.fire))) this.tryFire(s, ctx, events, firePressed, wasFiring, input.aim);
    if (!input.fire) { s.burst = 0; s.triggerPending = false; }
  }

  /** The server's trigger rules, step for step. */
  private tryFire(s: WeaponState, ctx: WeaponStepContext, events: WeaponEvent[] | null, firePressed: boolean, wasFiring: boolean, aimed: boolean) {
    const now = ctx.now, spec = weaponFor(this.loadout, s.slot), index = s.slot - 1;
    // Only a shell-by-shell reload with something loaded gives way to the trigger, and only once a shot goes off.
    if (s.reloadSlot && (!spec.perShellMs || s.mag[index] <= 0)) return;
    if (s.cookingSince) return;
    const early = now < s.meleeUntil || now < s.readyAt || ctx.vaultProgress < VAULT_FIRE_PROGRESS
      || now < s.lastSprintAt + sprintToFireMs(spec, s.lastSprintDash) || now < s.nextFireAt[index];
    if (early) { if (!spec.auto && s.mag[index] > 0) s.triggerPending = true; return; }
    if (s.mag[index] <= 0) {
      if (s.reserve[index] > 0) this.startReload(s, now, events);
      else if (firePressed) events?.push({ type: 'dry', weapon: spec.id });
      return;
    }
    if (s.reloadSlot) this.cancelReload(s);
    // Held automatic fire accumulates the interval so 30 Hz ticks keep the true rate; a new pull starts
    // fresh, so idle time never banks extra shots. Press-to-fire rounds are always a full interval apart.
    const interval = fireIntervalMs(spec), continuous = spec.auto && wasFiring && now - s.nextFireAt[index] < interval;
    s.nextFireAt[index] = (continuous ? s.nextFireAt[index] : now) + interval;
    s.mag[index]--; s.triggerPending = false;
    events?.push({
      type: 'shot', weapon: spec.id, slot: s.slot, burst: s.burst, kick: recoilKick(spec, s.burst, ctx.ads),
      aim: aimProgress(spec, this.loadout, s.aimSince, aimed, now), at: now,
    });
    s.burst++;
  }
}
