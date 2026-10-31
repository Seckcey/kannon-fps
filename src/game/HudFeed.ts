import type { DroneState, GameEvent, GameMode, MortarState, PublicPlayerState, ReconState, Team, Vec3 } from '../../shared/protocol';
import { RULES } from '../../shared/protocol';
import { GrenadeTrajectory } from '../../shared/physics';
import { hasPerk, type WeaponSpec } from '../../shared/weapons';
import type { DamageArc, GrenadeWarning, HitMarker, HudFrame, HudStore, MinimapBlip } from './hud';

type ShotEvent = Extract<GameEvent, { type: 'shot' }>;
type GrenadeEvent = Extract<GameEvent, { type: 'grenade' }>;
/** Seconds of warning whistle before each mortar shell lands. */
export const WHISTLE_LEAD_MS = 1600;

/** Grenades in flight replay the shared deterministic trajectory from their throw event, so every
 * client sees the same bounces the server simulates. Positions are at a server time. */
export class GrenadeTracker {
  private readonly live = new Map<string, { trajectory: GrenadeTrajectory; at: number; explodeAt: number; position: Vec3 }>();
  /** Track a throw that will still be in the air at `serverNow`; malformed or finished throws are ignored. */
  add(event: GrenadeEvent, serverNow: number): boolean {
    const values = [event.from.x, event.from.y, event.from.z, event.velocity.x, event.velocity.y, event.velocity.z, event.at, event.explodeAt];
    if (!values.every(Number.isFinite) || event.explodeAt <= serverNow || this.live.has(event.id)) return false;
    this.live.set(event.id, { trajectory: new GrenadeTrajectory(event.from, event.velocity), at: event.at, explodeAt: event.explodeAt, position: { ...event.from } });
    return true;
  }
  remove(id: string): boolean { return this.live.delete(id); }
  /** Advance every grenade; returns hard bounces on the way and the grenades that are gone. */
  advance(serverNow: number): { bounces: Array<{ position: Vec3; impact: number }>; expired: string[] } {
    const bounces: Array<{ position: Vec3; impact: number }> = [], expired: string[] = [];
    for (const [id, grenade] of this.live) {
      if (serverNow >= grenade.explodeAt + 400) { this.live.delete(id); expired.push(id); continue; }
      const impacts = grenade.trajectory.advanceTo(Math.max(0, Math.min(serverNow, grenade.explodeAt) - grenade.at));
      grenade.position = grenade.trajectory.position;
      for (const impact of impacts) bounces.push({ position: grenade.position, impact });
    }
    return { bounces, expired };
  }
  get positions(): Array<{ id: string; x: number; y: number; z: number }> {
    return [...this.live].map(([id, grenade]) => ({ id, ...grenade.position }));
  }
  /** Forget everything; returns the ids that were drawn. */
  clear(): string[] { const ids = [...this.live.keys()]; this.live.clear(); return ids; }
}
/** Mortar shells whose warning whistle starts now: once each, WHISTLE_LEAD_MS before impact. */
export function dueWhistles(mortars: readonly MortarState[], serverNow: number, whistled: Set<string>): Vec3[] {
  const due: Vec3[] = [];
  for (const mortar of mortars) mortar.impacts.forEach((at, index) => {
    const key = `${mortar.id}:${index}`;
    if (whistled.has(key) || serverNow < at - WHISTLE_LEAD_MS || serverNow >= at) return;
    whistled.add(key);
    if (whistled.size > 64) whistled.delete(whistled.values().next().value!);
    due.push({ x: mortar.x, y: 0, z: mortar.z });
  });
  return due;
}
export interface ViewPose { x: number; z: number; yaw: number }
export const HUD_INTERVAL_MS = 1000 / 30;
export const MARKER_MS = 700, ARC_MS = 1600, PING_MS = 2000, GRENADE_WARNING_METERS = 10;

/** Radians from straight ahead to a point, positive to the right (yaw is clockwise toward +X). */
export function relativeAngle(view: ViewPose, target: { x: number; z: number }): number {
  const dx = target.x - view.x, dz = target.z - view.z;
  const forward = dx * Math.sin(view.yaw) - dz * Math.cos(view.yaw);
  const right = dx * Math.cos(view.yaw) + dz * Math.sin(view.yaw);
  return Math.atan2(right, forward);
}
/** Hit marker for the local player's own confirmed shot: any unprotected player or drone contact;
 * a head contact on any pellet wins. */
export function shotMarker(event: ShotEvent, localId: string): 'hit' | 'head' | null {
  if (event.playerId !== localId || event.weapon === 'drone') return null;
  let kind: 'hit' | null = null;
  for (const trace of event.traces) {
    if (trace.protected) continue;
    if (trace.kind === 'player') { if (trace.zone === 'head') return 'head'; kind = 'hit'; }
    else if (trace.kind === 'drone') kind = 'hit';
  }
  return kind;
}
/** Where someone else's shot passed the listener within `radius` metres, or null (a hit on the
 * listener is reported by its damage event instead). */
export function nearMiss(event: ShotEvent, eye: Vec3, localId: string, radius = 1.5): Vec3 | null {
  const trace = event.traces[0];
  if (!trace || event.playerId === localId || event.traces.some(item => item.targetId === localId)) return null;
  const a = event.from, b = trace.to, abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z, length2 = abx * abx + aby * aby + abz * abz;
  if (!(length2 > 1e-6)) return null;
  const t = Math.max(0, Math.min(1, ((eye.x - a.x) * abx + (eye.y - a.y) * aby + (eye.z - a.z) * abz) / length2));
  const point = { x: a.x + abx * t, y: a.y + aby * t, z: a.z + abz * t };
  return t > 0.05 && Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z) < radius ? point : null;
}
export const isTeammate = (player: { team?: Team }, localTeam: Team | undefined, mode: GameMode) =>
  mode === 'tdm' && !!localTeam && player.team === localTeam;
/** A Recon Sweep owned by me or (team mode) my team is running. */
export function reconActive(recon: readonly ReconState[], localId: string, localTeam: Team | undefined, mode: GameMode, now: number): boolean {
  return recon.some(entry => entry.until > now && (entry.ownerId === localId || isTeammate(entry, localTeam, mode)));
}
/** Hip crosshair gap in CSS pixels: the weapon's fixed cone on screen, hidden while aiming, sprinting or vaulting. */
export function crosshairGap(spec: WeaponSpec, ads: number, verticalFovDegrees: number, viewportHeight: number, hidden: boolean): number {
  if (hidden || ads >= 0.5) return 0;
  const spread = spec.pelletSpread?.hip ?? spec.hipSpread;
  const pixels = Math.tan(spread) / Math.tan(verticalFovDegrees * Math.PI / 360) * viewportHeight / 2;
  const base = spec.kind === 'smg' ? 11 : spec.kind === 'pistol' ? 8 : 9;
  return Math.round(Math.max(base, pixels) * (1 - ads));
}
/** Health with the regeneration the server will have applied since the snapshot. */
export function displayedHealth(health: number, lastDamageAt: number, snapshotTime: number, now: number, secondWind: boolean): number {
  if (!(health > 0) || health >= RULES.health) return Math.max(0, Math.min(RULES.health, health || 0));
  const delay = secondWind ? RULES.secondWindRegenDelayMs : RULES.regenDelayMs;
  const start = Math.max(snapshotTime, lastDamageAt + delay);
  return now <= start ? health : Math.min(RULES.health, health + (now - start) * RULES.regenPerSecond / 1000);
}

export interface BlipContext {
  localId: string; localTeam?: Team; mode: GameMode;
  /** Server time of the drawn world. */
  now: number;
  players: ReadonlyArray<Pick<PublicPlayerState, 'id' | 'x' | 'z' | 'yaw' | 'team' | 'health' | 'connected' | 'loadout'>>;
  recon: readonly ReconState[]; drones: readonly DroneState[]; mortars: readonly MortarState[];
  grenades: ReadonlyArray<{ x: number; z: number }>;
  /** Recent unsuppressed fire by enemies, by shooter id. */
  pings: ReadonlyMap<string, { x: number; z: number; at: number }>;
}
/** Teammates always; enemies during my team's Recon Sweep unless they run Low Profile; firing
 * pings for two seconds; drones; mortar targets; live grenades. */
export function minimapBlips(context: BlipContext): MinimapBlip[] {
  const blips: MinimapBlip[] = [], swept = reconActive(context.recon, context.localId, context.localTeam, context.mode, context.now);
  const shown = new Set<string>();
  for (const player of context.players) {
    if (player.id === context.localId || !player.connected || player.health <= 0) continue;
    if (isTeammate(player, context.localTeam, context.mode)) { blips.push({ x: player.x, z: player.z, yaw: player.yaw, kind: 'friend', fade: 1 }); continue; }
    if (swept && !(player.loadout && hasPerk(player.loadout, 'low-profile'))) { blips.push({ x: player.x, z: player.z, yaw: player.yaw, kind: 'enemy', fade: 1 }); shown.add(player.id); }
  }
  for (const [id, ping] of context.pings) {
    const age = context.now - ping.at;
    if (shown.has(id) || age < 0 || age >= PING_MS) continue;
    blips.push({ x: ping.x, z: ping.z, kind: 'ping', fade: 1 - age / PING_MS });
  }
  for (const drone of context.drones) if (drone.until > context.now && drone.health > 0) blips.push({ x: drone.x, z: drone.z, yaw: drone.yaw, kind: 'drone', fade: 1 });
  for (const mortar of context.mortars) {
    const last = Math.max(...mortar.impacts, 0);
    if (last + 500 <= context.now) continue;
    const first = Math.min(...mortar.impacts);
    blips.push({ x: mortar.x, z: mortar.z, kind: 'mortar', fade: context.now < first ? 1 : Math.max(0, (last + 500 - context.now) / Math.max(500, last + 500 - first)) });
  }
  for (const grenade of context.grenades) blips.push({ x: grenade.x, z: grenade.z, kind: 'grenade', fade: 1 });
  return blips;
}

export type HudBase = Omit<HudFrame, 'hitMarkers' | 'damageArcs' | 'grenades' | 'blips' | 'reconActive'>;

/** Collects combat feedback and publishes HudFrames to React at most ~30 times a second. */
export class HudFeed {
  private markers: HitMarker[] = [];
  private arcs: Array<{ id: number; at: number; amount: number; from: Vec3 }> = [];
  private readonly pings = new Map<string, { x: number; z: number; at: number }>();
  private nextId = 1;
  private lastPublish = -Infinity;
  constructor(private readonly hud: HudStore | null) {}

  /** A confirmed hit or elimination by the local player; `at` is performance.now(). */
  marker(kind: HitMarker['kind'], at: number) { this.markers.push({ id: this.nextId++, at, kind }); if (this.markers.length > 12) this.markers.shift(); }
  /** Damage taken from a source position; the arc follows the view while it fades. */
  damage(from: Vec3, amount: number, at: number) {
    if (![from.x, from.z, amount].every(Number.isFinite)) return;
    this.arcs.push({ id: this.nextId++, at, amount, from: { ...from } });
    if (this.arcs.length > 8) this.arcs.shift();
  }
  /** An enemy fired without Low Profile; `at` is server time. */
  ping(playerId: string, position: { x: number; z: number }, at: number) { this.pings.set(playerId, { x: position.x, z: position.z, at }); }
  get pingMap(): ReadonlyMap<string, { x: number; z: number; at: number }> { return this.pings; }

  /** Builds the frame (throttled to ~30 Hz). Returns the published frame, or null when throttled. */
  publish(base: HudBase, blips: Omit<BlipContext, 'pings' | 'grenades'>, grenades: ReadonlyArray<{ id: string; x: number; z: number }>, force = false): HudFrame | null {
    if (!force && base.time - this.lastPublish < HUD_INTERVAL_MS - 1) return null;
    this.lastPublish = base.time;
    this.markers = this.markers.filter(marker => base.time - marker.at < MARKER_MS);
    this.arcs = this.arcs.filter(arc => base.time - arc.at < ARC_MS);
    for (const [id, ping] of this.pings) if (blips.now - ping.at >= PING_MS || blips.now < ping.at - 5_000) this.pings.delete(id);
    const damageArcs: DamageArc[] = this.arcs.map(arc => ({ id: arc.id, at: arc.at, amount: arc.amount, angle: relativeAngle(base.view, arc.from) }));
    const warnings: GrenadeWarning[] = [];
    for (const grenade of grenades) {
      const distance = Math.hypot(grenade.x - base.view.x, grenade.z - base.view.z);
      if (distance <= GRENADE_WARNING_METERS) warnings.push({ id: grenade.id, angle: relativeAngle(base.view, grenade), distance });
    }
    const frame: HudFrame = {
      ...base, hitMarkers: [...this.markers], damageArcs, grenades: warnings,
      blips: minimapBlips({ ...blips, grenades, pings: this.pings }),
      reconActive: reconActive(blips.recon, blips.localId, blips.localTeam, blips.mode, blips.now),
    };
    this.hud?.publish(frame);
    return frame;
  }

  /** Forget feedback (round reset, respawn). */
  reset() { this.markers = []; this.arcs = []; this.pings.clear(); }
  dispose() { this.reset(); this.hud?.clear(); }
}
