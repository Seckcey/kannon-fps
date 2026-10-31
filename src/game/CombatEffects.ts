import * as THREE from 'three';
import type { DroneState, GameEvent, ShotTrace, SurfaceKind, Vec3, WeaponId } from '../../shared/protocol';
import { effectBudget, sameBudget, type CombatEffectsOptions, type EffectBudget } from './effects/budget';
import { BreakableSet, type Breakable } from './effects/Breakables';
import { DECAL_CELLS, SURFACE_DECAL } from './effects/decalAtlas';
import { DecalLayer } from './effects/Decals';
import { DroneFleet, type DroneHooks, type DroneViewer } from './effects/Drones';
import { Emitter } from './effects/Emitter';
import { FlashLights } from './effects/FlashLights';
import { GrenadeMarkers } from './effects/Grenades';
import { groundBelow, rayDistance } from './effects/mapQuery';
import { advanceParticles, advanceTracers, FACING, ParticlePool, TracerPool, ViewBasis, type Particle } from './effects/particles';
import { EFFECT_KIND, QuadBatch } from './effects/QuadBatch';
import { EffectRandom } from './effects/random';
import {
  DAMAGED_DRONE_SMOKE, ELIMINATION, EXPLOSION_COLORS, GROUND_REACH, MUZZLE_COLORS, RESPAWN, SHATTER_COLORS,
  explosionRecipe, impactRecipe, isSurfaceKind, muzzleStyle, type MuzzleStyle, type PoolName,
} from './effects/recipes';
import { ShellCasings } from './effects/Shells';

export { effectsOptionsFor, type CombatEffectsOptions, type EffectBudget } from './effects/budget';
export type { DroneViewer } from './effects/Drones';

type Shot = Extract<GameEvent, { type: 'shot' }>;
const TAU = Math.PI * 2;
const isFinite3 = (value: Vec3 | null | undefined): value is Vec3 =>
  !!value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);

/** Live counts, for tests and debug overlays. */
export interface CombatEffectsStats {
  /** Live additive particles, and live dust plus smoke particles. */
  glow: number; dust: number; tracers: number;
  /** Bullet holes and scorch marks currently stored. */
  decals: number; scorches: number;
  shells: number; grenades: number; drones: number;
  /** Panes and pots broken this round. */
  broken: number;
}

/** Everything whose size depends on the budget; `configure` rebuilds it. */
interface Layers {
  glow: QuadBatch; dust: QuadBatch;
  pools: Record<PoolName, ParticlePool>;
  tracers: TracerPool; decals: DecalLayer; shells: ShellCasings; lights: FlashLights;
}

function resolveInto(authoritative: Vec3, visual: Vec3 | null | undefined, target: THREE.Vector3): THREE.Vector3 {
  target.set(authoritative.x, authoritative.y, authoritative.z);
  if (!isFinite3(visual)) return target;
  const dx = visual.x - authoritative.x, dy = visual.y - authoritative.y, dz = visual.z - authoritative.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (distance < 1e-6 || distance > 3) return target;
  const ux = dx / distance, uy = dy / distance, uz = dz / distance;
  const wall = rayDistance(authoritative.x, authoritative.y, authoritative.z, ux, uy, uz, distance);
  const reach = wall < distance ? Math.max(0, wall - 0.025) : distance;
  return target.set(authoritative.x + ux * reach, authoritative.y + uy * reach, authoritative.z + uz * reach);
}

/** A cosmetic barrel may protrude through cover; effects must stay on this side. */
export function resolveVisualMuzzle(authoritative: Vec3, visual: Vec3): THREE.Vector3 {
  return resolveInto(authoritative, visual, new THREE.Vector3());
}

/** World-space combat presentation: muzzle flashes and smoke, tracers, surface impacts, bullet holes,
 * shells, explosions, grenades in flight, attack drones and breakable glass and pots.
 *
 * Every pool is allocated once: shots, impacts and explosions only refill persistent buffers, so a
 * firefight never creates scene objects (drone models are pooled per drone, not per event). Phones get
 * half of every particle budget and no point lights. Hits on people are dark puffs, never blood. */
export class CombatEffects {
  readonly root = new THREE.Group();
  /** Called once for each pane or pot a shot breaks (for a glass or pot sound). The point is reused. */
  onBreak: ((kind: 'glass' | 'pot', position: Vec3) => void) | null = null;
  private currentBudget: EffectBudget;
  private layers: Layers;
  private readonly random = new EffectRandom();
  private readonly emitter: Emitter;
  private readonly grenades: GrenadeMarkers;
  private readonly drones: DroneFleet;
  private readonly breakables = new BreakableSet();
  private readonly view = new ViewBasis();
  private readonly droneHooks: DroneHooks;
  private readonly breakHandler = (item: Breakable, point: THREE.Vector3, travel: THREE.Vector3) => this.shatter(item, point, travel);
  private time = 0;
  private smokeTick = 0;
  private disposed = false;
  private readonly muzzle = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly back = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly size = new THREE.Vector3();
  private readonly across = new THREE.Vector3();
  private readonly along = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(options: CombatEffectsOptions = { quality: 'desktop' }) {
    this.root.name = 'combat-effects';
    this.currentBudget = effectBudget(options);
    this.layers = this.build(this.currentBudget);
    this.emitter = new Emitter(this.layers.pools, this.random);
    this.emitter.scale = this.currentBudget.scale;
    this.grenades = new GrenadeMarkers(this.currentBudget.grenades, this.random);
    this.drones = new DroneFleet(this.currentBudget.drones, this.random);
    this.root.add(this.grenades.body, this.grenades.fittings, this.drones.root);
    this.droneHooks = {
      smoke: position => this.droneSmoke(position),
      beacon: (position, color, size, opacity) => this.marker(position, color, size, opacity),
    };
  }

  /** The pool sizes in use (a copy). */
  get budget(): EffectBudget { return { ...this.currentBudget }; }

  /** Compiles every effect shader ahead of time (behind the loading screen), so the first shot, hole,
   * shell, explosion or drone never stalls a frame. `scene` supplies the lights the shaders are built
   * for. Call again after `configure` changes the budget. */
  precompile(renderer: Pick<THREE.WebGLRenderer, 'compileAsync'>, scene: THREE.Scene, camera: THREE.Camera): Promise<unknown> {
    if (this.disposed) return Promise.resolve();
    this.drones.prepare();
    return renderer.compileAsync(this.root, camera, scene);
  }

  private build(budget: EffectBudget): Layers {
    const layers: Layers = {
      glow: new QuadBatch(budget.glowParticles + budget.tracers + budget.markers, true, 'combat-glow-batch', 5),
      dust: new QuadBatch(budget.dustParticles + budget.smokeParticles, false, 'combat-dust-batch', 4),
      pools: { glow: new ParticlePool(budget.glowParticles), dust: new ParticlePool(budget.dustParticles), smoke: new ParticlePool(budget.smokeParticles) },
      tracers: new TracerPool(budget.tracers),
      decals: new DecalLayer(budget.decals, budget.scorches),
      shells: new ShellCasings(budget.shells, budget.quality === 'phone' ? 1.6 : 2.4, this.random),
      lights: new FlashLights(budget.lights),
    };
    this.root.add(layers.dust.mesh, layers.glow.mesh, layers.decals.mesh, layers.shells.mesh, ...layers.lights.lights);
    return layers;
  }

  private disposeLayers() {
    const { glow, dust, decals, shells, lights } = this.layers;
    glow.dispose(); dust.dispose(); decals.dispose(); shells.dispose(); lights.dispose();
  }

  /** Follows a render-tier change (`effectsOptionsFor(tier)`). A different budget rebuilds the pools,
   * dropping live particles and marks; breakables, grenades and drones carry on. */
  configure(options: CombatEffectsOptions) {
    if (this.disposed) return;
    const next = effectBudget(options);
    if (sameBudget(next, this.currentBudget)) return;
    this.disposeLayers();
    this.currentBudget = next;
    this.layers = this.build(next);
    this.emitter.pools = this.layers.pools;
    this.emitter.scale = next.scale;
  }

  /** World presentation of one authoritative shot. `from` is the visual muzzle. Local shots skip the
   * muzzle flash (the viewmodel draws it); `tracer` false skips the streak but keeps impacts. */
  shot(event: Shot, visualMuzzle: Vec3, options: { local: boolean; tracer: boolean } = { local: false, tracer: true }) {
    if (this.disposed || !event || !Array.isArray(event.traces) || !isFinite3(event.from)) return;
    const style = muzzleStyle(event.weapon), traces = event.traces;
    const visual = event.weapon === 'drone' && this.drones.muzzleNear(event.from, this.target) ? this.target : visualMuzzle;
    const from = resolveInto(event.from, visual, this.muzzle);
    const local = options?.local === true, tracer = options?.tracer !== false;
    const count = Math.min(traces.length, style.pellets);
    if (!local) this.muzzleFlash(from, traces, count, style);
    for (let index = 0; index < count; index++) {
      const trace = traces[index];
      if (!trace || !isFinite3(trace.to)) continue;
      if (tracer) this.addTracer(from, trace.to, event.from, style);
      // Glass and pots are not in the collision map: the authoritative path decides what breaks.
      this.breakables.cross(event.from, trace.to, this.breakHandler);
      this.traceImpact(event.from, trace, style);
    }
  }

  /** The local player's predicted shot: the muzzle light and (if asked) the tracer, at once. The
   * viewmodel draws the flash; impacts wait for the server's shot event (pass `tracer: false` there). */
  localShot(muzzle: Vec3, contact: Vec3, weapon: WeaponId, tracer: boolean) {
    if (this.disposed || !isFinite3(muzzle)) return;
    const style = muzzleStyle(weapon);
    this.layers.lights.flash(muzzle.x, muzzle.y, muzzle.z, MUZZLE_COLORS.light, style.light, style.lightRange, style.lightLife, true);
    if (tracer === true && isFinite3(contact)) this.addTracer(this.muzzle.set(muzzle.x, muzzle.y, muzzle.z), contact, muzzle, style);
  }

  /** Contract surface: a surface impact on its own (shots already make their impacts). */
  impact(position: Vec3, normal: Vec3, surface: SurfaceKind | 'player', protectedTarget = false) {
    if (this.disposed || !isFinite3(position)) return;
    this.spray(position, this.unit(normal), surface, protectedTarget === true, 1);
  }

  /** Contract surface: a bullet hole on its own (world traces with a face already get one). */
  bulletHole(position: Vec3, normal: Vec3, surface: SurfaceKind) {
    if (this.disposed || !isFinite3(position) || !isFinite3(normal)) return;
    this.normal.set(normal.x, normal.y, normal.z);
    if (!(this.normal.lengthSq() > 1e-8)) return;
    this.hole(position, this.normal.normalize(), isSurfaceKind(surface) ? surface : 'concrete', 0.05);
  }

  /** An ejected case at a world position and velocity. */
  shell(position: THREE.Vector3, velocity: THREE.Vector3, weapon: WeaponId) {
    if (!this.disposed) this.layers.shells.spawn(position, velocity, weapon);
  }

  explosion(position: Vec3, kind: 'frag' | 'mortar' | 'drone') {
    if (this.disposed || !isFinite3(position)) return;
    const recipe = explosionRecipe(kind), scale = recipe.scale, random = this.random, emitter = this.emitter, colors = EXPLOSION_COLORS;
    const { x, y, z } = position, ground = groundBelow(x, y + 0.1, z), grounded = y - ground <= GROUND_REACH * scale;
    for (let index = 0, count = emitter.count(recipe.flash); index < count; index++) {
      const flash = emitter.particle('glow');
      flash.position.set(x, y + 0.3 * scale, z);
      this.look(flash, EFFECT_KIND.glow, colors.flash, colors.flash, 3, 3.2 * scale, 4.2 * scale, 1, 0.1);
    }
    for (let index = 0, count = emitter.count(recipe.fire); index < count; index++) {
      const fire = emitter.particle('glow'), dir = this.randomDirection(this.direction, false);
      fire.position.set(x + dir.x * 0.3 * scale, y + 0.2 * scale + Math.abs(dir.y) * 0.3 * scale, z + dir.z * 0.3 * scale);
      fire.velocity.copy(dir).multiplyScalar(random.range(1.5, 4) * scale); fire.velocity.y += 1.2;
      fire.drag = 3.5; fire.gravity = -1.5; fire.spin = random.signed(2);
      const size = random.range(0.6, 1) * scale;
      this.look(fire, EFFECT_KIND.fire, colors.fireHot, colors.fireCool, 2.2, size, size * 2.2, 0.95, random.range(0.35, 0.6), 0.8);
    }
    for (let index = 0, count = emitter.count(recipe.sparks); index < count; index++) {
      const spark = emitter.particle('glow');
      spark.position.set(x, y + 0.15, z);
      spark.velocity.copy(this.randomDirection(this.direction, true)).multiplyScalar(random.range(6, 14) * scale);
      spark.gravity = 9.8; spark.drag = 0.6; spark.floor = ground; spark.bounce = 0.3; spark.facing = FACING.velocity; spark.aspect = 5;
      this.look(spark, EFFECT_KIND.streak, colors.spark, colors.spark, 2, 0.03, 0.015, 1, random.range(0.45, 0.95));
    }
    for (let index = 0, count = emitter.count(recipe.smoke); index < count; index++) {
      const smoke = emitter.particle('smoke'), dir = this.randomDirection(this.direction, false);
      smoke.position.set(x + dir.x * 0.5 * scale, y + 0.3 * scale + Math.abs(dir.y) * 0.4 * scale, z + dir.z * 0.5 * scale);
      smoke.velocity.copy(dir).multiplyScalar(random.range(0.6, 1.6) * scale); smoke.velocity.y += random.range(0.8, 1.6);
      smoke.drag = 1.1; smoke.gravity = -0.35; smoke.spin = random.signed(0.4);
      const size = random.range(0.9, 1.3) * scale;
      this.look(smoke, EFFECT_KIND.smoke, colors.smoke, colors.smokeEnd, 1, size, size * 3, 0.55, random.range(2.6, 4.2));
    }
    for (let index = 0, count = emitter.count(recipe.debris); index < count; index++) {
      const debris = emitter.particle('dust');
      debris.position.set(x, y + 0.1, z);
      debris.velocity.copy(this.randomDirection(this.direction, true)).multiplyScalar(random.range(4, 11) * scale);
      debris.gravity = 9.8; debris.drag = 0.3; debris.floor = ground; debris.bounce = 0.3; debris.spin = random.signed(16);
      const size = random.range(0.04, 0.12), tint = index % 2 ? colors.debris : colors.earth;
      this.look(debris, EFFECT_KIND.chip, tint, tint, 1, size, size * 0.8, 0.95, random.range(1.2, 2));
    }
    if (grounded) {
      for (let index = 0, count = emitter.count(recipe.ring); index < count; index++) {
        const angle = index / count * TAU + random.signed(0.2), cos = Math.cos(angle), sin = Math.sin(angle);
        const dust = emitter.particle('dust');
        dust.position.set(x + cos * 0.4 * scale, ground + 0.15, z + sin * 0.4 * scale);
        dust.velocity.set(cos, 0.05, sin).multiplyScalar(random.range(4, 6) * scale);
        dust.drag = 2.6; dust.spin = random.signed(0.5);
        const size = random.range(0.4, 0.6) * scale;
        this.look(dust, EFFECT_KIND.puff, colors.ring, colors.ringEnd, 1, size, size * 3.4, 0.42, random.range(1, 1.5));
      }
      for (let index = 0, count = emitter.count(recipe.column); index < count; index++) {
        const earth = emitter.particle('dust');
        earth.position.set(x + random.signed(0.4) * scale, ground + 0.2, z + random.signed(0.4) * scale);
        earth.velocity.set(random.signed(1.2), random.range(6, 10), random.signed(1.2));
        earth.gravity = 6; earth.drag = 1; earth.floor = ground; earth.spin = random.signed(0.6);
        this.look(earth, EFFECT_KIND.puff, colors.column, colors.columnEnd, 1, 0.5 * scale, 2 * scale, 0.6, random.range(1.2, 1.8));
      }
      if (recipe.scorch > 0) this.scorch(x, ground, z, recipe.scorch * random.range(0.9, 1.1));
    }
    this.layers.lights.flash(x, y + 0.5, z, colors.light, recipe.light.intensity, recipe.light.distance, recipe.light.duration, false);
  }

  /** Draw, move or (with null) remove an in-flight grenade. */
  grenade(id: string, position: Vec3 | null) { if (!this.disposed) this.grenades.set(id, position, this.time); }

  /** World meshes (glass panes, pots) that shatter when a tracer crosses them. */
  setBreakables(meshes: THREE.Mesh[]) { if (!this.disposed) this.breakables.set(meshes); }

  /** Attack drones from the latest snapshot, drawn and interpolated each frame. With a viewer, the
   * beacon shows friend (blue) or foe (red); without one every drone reads as a foe. */
  setDrones(drones: DroneState[], serverTime: number, viewer?: DroneViewer) { if (!this.disposed) this.drones.set(drones, serverTime, viewer); }

  /** A little settling dust where a player went down. */
  elimination(position: Vec3) {
    if (this.disposed || !isFinite3(position)) return;
    const emitter = this.emitter, random = this.random;
    for (let index = 0, count = emitter.count(ELIMINATION.low); index < count; index++) {
      const angle = index / count * TAU + random.signed(0.3), cos = Math.cos(angle), sin = Math.sin(angle);
      const dust = emitter.particle('dust');
      dust.position.set(position.x + cos * 0.25, position.y + 0.12, position.z + sin * 0.25);
      dust.velocity.set(cos * 0.6, 0.15, sin * 0.6); dust.drag = 1.8; dust.spin = random.signed(0.5);
      const size = random.range(0.26, 0.34);
      this.look(dust, EFFECT_KIND.puff, ELIMINATION.color, ELIMINATION.endColor, 1, size, size * 3.2, 0.32, random.range(0.9, 1.4));
    }
    for (let index = 0, count = emitter.count(ELIMINATION.torso); index < count; index++) {
      const dust = emitter.particle('dust');
      dust.position.set(position.x + random.signed(0.15), position.y + 0.9 + random.signed(0.2), position.z + random.signed(0.15));
      dust.velocity.set(random.signed(0.2), -0.2, random.signed(0.2)); dust.drag = 1.5; dust.spin = random.signed(0.5);
      const size = random.range(0.22, 0.28);
      this.look(dust, EFFECT_KIND.puff, ELIMINATION.color, ELIMINATION.endColor, 1, size, size * 2.6, 0.24, random.range(0.7, 1));
    }
  }

  respawn(position: Vec3) {
    if (this.disposed || !isFinite3(position)) return;
    const emitter = this.emitter, random = this.random;
    for (let index = 0, count = emitter.count(RESPAWN.ring); index < count; index++) {
      const ring = emitter.particle('glow');
      ring.position.set(position.x, position.y + 1, position.z);
      this.look(ring, EFFECT_KIND.ring, RESPAWN.ringColor, RESPAWN.ringColor, 1, 0.6, 1.8, 0.22, 0.45);
    }
    for (let index = 0, count = emitter.count(RESPAWN.motes); index < count; index++) {
      const angle = index / count * TAU, mote = emitter.particle('glow');
      mote.position.set(position.x + Math.cos(angle) * 0.4, position.y + random.range(0, 1.6), position.z + Math.sin(angle) * 0.4);
      mote.velocity.set(Math.cos(angle) * 0.15, random.range(0.6, 1.2), Math.sin(angle) * 0.15);
      this.look(mote, EFFECT_KIND.glow, RESPAWN.moteColor, RESPAWN.moteColor, 1, 0.05, 0.02, 0.5, random.range(0.4, 0.7));
    }
  }

  update(dt: number, camera: THREE.Camera) {
    if (this.disposed) return;
    dt = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    const step = Math.min(dt, 0.05), layers = this.layers, view = this.view;
    this.time += dt;
    if (camera) view.set(camera);
    layers.glow.reset(); layers.dust.reset();
    this.drones.update(dt, this.droneHooks);
    advanceParticles(layers.pools.smoke, layers.dust, view, dt, step);
    advanceParticles(layers.pools.dust, layers.dust, view, dt, step);
    advanceParticles(layers.pools.glow, layers.glow, view, dt, step);
    advanceTracers(layers.tracers, layers.glow, view, dt);
    layers.shells.update(dt, step);
    this.grenades.update(this.time);
    layers.lights.update(dt);
    layers.decals.update();
    layers.dust.finish(); layers.glow.finish();
  }

  stats(): CombatEffectsStats {
    const { pools, tracers, decals, shells } = this.layers;
    return {
      glow: pools.glow.alive, dust: pools.dust.alive + pools.smoke.alive, tracers: tracers.alive,
      decals: decals.holes, scorches: decals.scorches, shells: shells.active,
      grenades: this.grenades.active, drones: this.drones.active, broken: this.breakables.broken,
    };
  }

  /** Drops everything in flight (particles, tracers, shells, lights, grenade markers) but keeps bullet
   * holes, scorches, broken glass and drones: for resuming a hidden tab. */
  clearTransient() {
    if (this.disposed) return;
    const layers = this.layers;
    layers.pools.glow.clear(); layers.pools.dust.clear(); layers.pools.smoke.clear(); layers.tracers.clear();
    layers.shells.clear(); layers.lights.clear(); this.grenades.clear();
    layers.glow.reset(); layers.dust.reset(); layers.glow.finish(); layers.dust.finish();
  }

  /** A fresh round: everything above plus marks, drones, and every pane and pot restored. */
  clear() {
    if (this.disposed) return;
    this.clearTransient();
    this.layers.decals.clear();
    this.drones.clear();
    this.breakables.restore();
  }

  dispose() {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.disposeLayers(); this.grenades.dispose(); this.drones.dispose(); this.breakables.clear();
    this.onBreak = null;
    this.root.clear();
    this.root.removeFromParent();
  }

  private muzzleFlash(from: THREE.Vector3, traces: readonly ShotTrace[], count: number, style: MuzzleStyle) {
    const random = this.random, emitter = this.emitter;
    let aimed = false;
    for (let index = 0; index < count && !aimed; index++) {
      const to = traces[index]?.to;
      if (!isFinite3(to)) continue;
      this.axis.set(to.x - from.x, to.y - from.y, to.z - from.z);
      const length = this.axis.length();
      if (length > 0.01) { this.axis.multiplyScalar(1 / length); aimed = true; }
    }
    const core = emitter.particle('glow');
    core.position.copy(from);
    this.look(core, EFFECT_KIND.flash, MUZZLE_COLORS.core, MUZZLE_COLORS.core, 1.6, style.flash, style.flash * 0.3, 1, style.flashLife);
    const flame = emitter.particle('glow');
    flame.position.copy(from); flame.spin = 3;
    this.look(flame, EFFECT_KIND.flash, MUZZLE_COLORS.flame, MUZZLE_COLORS.flame, 1.3, style.flame, style.flame * 0.25, 0.7, style.flashLife * 1.15);
    if (aimed) {
      // The side view of the flash: a short streak out of the barrel.
      const side = emitter.particle('glow');
      side.position.copy(from).addScaledVector(this.axis, style.streak * 0.5);
      side.axis.copy(this.axis); side.facing = FACING.axis; side.aspect = style.streak / style.streakWidth;
      this.look(side, EFFECT_KIND.streak, MUZZLE_COLORS.side, MUZZLE_COLORS.side, 1.2, style.streakWidth, style.streakWidth, 0.55, style.flashLife);
    }
    for (let index = 0, smoke = emitter.count(style.smoke); index < smoke; index++) {
      const puff = emitter.particle('smoke');
      puff.position.copy(from);
      puff.velocity.set(random.signed(0.15), random.range(0.25, 0.4), random.signed(0.15));
      if (aimed) { puff.position.addScaledVector(this.axis, 0.05 + index * 0.04); puff.velocity.addScaledVector(this.axis, 0.5); }
      puff.drag = 1.5; puff.gravity = -0.2; puff.spin = random.signed(0.6);
      const size = random.range(0.1, 0.14);
      this.look(puff, EFFECT_KIND.smoke, MUZZLE_COLORS.smoke, MUZZLE_COLORS.smokeEnd, 1, size, size * 4.5, 0.2, random.range(0.9, 1.4));
    }
    this.layers.lights.flash(from.x, from.y, from.z, MUZZLE_COLORS.light, style.light, style.lightRange, style.lightLife, false);
  }

  /** Never draws a tracer backwards into a barrel that pokes past the contact, and stops it at any
   * wall between the cosmetic barrel and the accepted end point. */
  private addTracer(from: THREE.Vector3, to: Vec3, origin: Vec3, style: MuzzleStyle) {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(length >= 0.005) || !Number.isFinite(length)) return;
    if (!(dx * (to.x - origin.x) + dy * (to.y - origin.y) + dz * (to.z - origin.z) > 0)) return;
    const ux = dx / length, uy = dy / length, uz = dz / length;
    const reach = Math.max(0, Math.min(length, rayDistance(from.x, from.y, from.z, ux, uy, uz, length)));
    this.target.set(from.x + ux * reach, from.y + uy * reach, from.z + uz * reach);
    this.layers.tracers.add(from, this.target, style.tracerWidth, style.tracerLife, style.tracerColor, style.tracerIntensity);
  }

  /** Only real contacts make impacts: a range end is empty air. World contacts with a face also get
   * a hole; without the face (an older server) no hole is guessed. */
  private traceImpact(origin: Vec3, trace: ShotTrace, style: MuzzleStyle) {
    if (trace.kind !== 'world' && trace.kind !== 'player' && trace.kind !== 'drone') return;
    const to = trace.to;
    this.back.set(origin.x - to.x, origin.y - to.y, origin.z - to.z);
    if (this.back.lengthSq() > 1e-10) this.back.normalize(); else this.back.set(0, 1, 0);
    if (trace.kind === 'player') { this.spray(to, this.back, 'player', trace.protected === true, style.impactScale); return; }
    if (trace.kind === 'drone') { this.spray(to, this.back, 'metal', false, style.impactScale); return; }
    const normal = trace.normal, faced = isFinite3(normal) && this.normal.set(normal.x, normal.y, normal.z).lengthSq() > 1e-8;
    if (faced) this.normal.normalize();
    const surface = isSurfaceKind(trace.surface) ? trace.surface : null;
    this.spray(to, faced ? this.normal : this.back, surface ?? 'concrete', false, style.impactScale);
    if (faced && surface) this.hole(to, this.normal, surface, style.holeSize);
  }

  private spray(at: Vec3, normal: THREE.Vector3, surface: SurfaceKind | 'player', protectedTarget: boolean, countScale: number) {
    const recipe = impactRecipe(surface, protectedTarget);
    let floor = -Infinity;
    for (let index = 0; index < recipe.length; index++) {
      if (!recipe[index].gravity) continue;
      floor = groundBelow(at.x + normal.x * 0.05, at.y + normal.y * 0.05, at.z + normal.z * 0.05);
      break;
    }
    for (let index = 0; index < recipe.length; index++) this.emitter.burst(recipe[index], at.x, at.y, at.z, normal, countScale, floor);
  }

  /** A scorch mark on the surface under a blast. Walls stand on the ground, so a mark next to a house
   * would carry on under the wall and show on the floor inside: it is moved clear of nearby walls,
   * and shrunk when it is boxed in. */
  private scorch(x: number, ground: number, z: number, radius: number) {
    const height = ground + 0.05;
    let cx = x, cz = z, r = radius;
    for (let axis = 0; axis < 2; axis++) {
      const dx = axis === 0 ? 1 : 0, dz = axis === 0 ? 0 : 1;
      const ahead = rayDistance(cx, height, cz, dx, 0, dz, 2 * r), behind = rayDistance(cx, height, cz, -dx, 0, -dz, 2 * r);
      if (ahead + behind < 2 * r) r = (ahead + behind) / 2;
      const offset = Math.min(ahead - r, Math.max(r - behind, 0));
      if (axis === 0) cx += offset; else cz += offset;
    }
    if (r > 0.25) this.layers.decals.addScorch(cx, ground, cz, this.up, r, this.random.range(0, TAU));
  }

  private hole(at: Vec3, normal: THREE.Vector3, surface: SurfaceKind, size: number) {
    this.layers.decals.addHole(at.x, at.y, at.z, normal, DECAL_CELLS[SURFACE_DECAL[surface]], size * this.random.range(0.85, 1.15), this.random.range(0, TAU));
  }

  private shatter(item: Breakable, point: THREE.Vector3, travel: THREE.Vector3) {
    const random = this.random, emitter = this.emitter, { min, max } = item.bounds;
    if (item.kind === 'glass') {
      const size = item.bounds.getSize(this.size), area = Math.max(size.x * size.y, size.y * size.z, size.x * size.z);
      const floor = groundBelow(point.x + travel.x * 0.6, point.y, point.z + travel.z * 0.6);
      for (let index = 0, count = emitter.count(Math.min(22, Math.max(8, Math.round(area * 16)))); index < count; index++) {
        const shard = emitter.particle('dust');
        shard.position.set(
          random.range(min.x, max.x) * 0.65 + point.x * 0.35, random.range(min.y, max.y) * 0.65 + point.y * 0.35, random.range(min.z, max.z) * 0.65 + point.z * 0.35,
        );
        shard.velocity.copy(travel).multiplyScalar(random.range(0.8, 2.6));
        shard.velocity.x += random.signed(0.9); shard.velocity.y += random.range(-0.3, 0.5); shard.velocity.z += random.signed(0.9);
        shard.gravity = 9.8; shard.drag = 0.35; shard.floor = floor; shard.bounce = 0.2; shard.spin = random.signed(14); shard.aspect = random.range(1, 2);
        const scale = random.range(0.04, 0.11);
        this.look(shard, EFFECT_KIND.shard, SHATTER_COLORS.glass, SHATTER_COLORS.glass, 1, scale, scale * 0.8, 0.75, random.range(1.3, 2.1));
      }
      for (let index = 0, count = emitter.count(4); index < count; index++) {
        const glint = emitter.particle('glow');
        glint.position.set(random.range(min.x, max.x), random.range(min.y, max.y), random.range(min.z, max.z));
        this.look(glint, EFFECT_KIND.glow, SHATTER_COLORS.glint, SHATTER_COLORS.glint, 1.5, 0.08, 0.02, 0.9, random.range(0.12, 0.2));
      }
      for (let index = 0, count = emitter.count(2); index < count; index++) {
        const dust = emitter.particle('dust');
        dust.position.copy(point); dust.velocity.copy(travel).multiplyScalar(0.3); dust.drag = 2;
        this.look(dust, EFFECT_KIND.puff, SHATTER_COLORS.glassDust, SHATTER_COLORS.glassDust, 1, 0.2, 0.6, 0.18, random.range(0.6, 0.9));
      }
    } else {
      const center = item.bounds.getCenter(this.center), floor = groundBelow(center.x, min.y + 0.05, center.z);
      for (let index = 0, count = emitter.count(10); index < count; index++) {
        const chunk = emitter.particle('dust');
        chunk.position.set(center.x + random.signed(0.1), center.y + random.signed(0.1), center.z + random.signed(0.1));
        chunk.velocity.copy(this.randomDirection(this.direction, true)).multiplyScalar(random.range(1.5, 3.5)).addScaledVector(travel, 1.5);
        chunk.gravity = 9.8; chunk.drag = 0.3; chunk.floor = floor; chunk.bounce = 0.3; chunk.spin = random.signed(12);
        const scale = random.range(0.05, 0.12), tint = index % 2 ? SHATTER_COLORS.pot : SHATTER_COLORS.potDark;
        this.look(chunk, EFFECT_KIND.chip, tint, tint, 1, scale, scale * 0.85, 0.95, random.range(1.2, 1.8));
      }
      for (let index = 0, count = emitter.count(6); index < count; index++) {
        const soil = emitter.particle('dust');
        soil.position.copy(center);
        soil.velocity.copy(this.randomDirection(this.direction, true)).multiplyScalar(random.range(0.8, 2));
        soil.gravity = 9.8; soil.drag = 0.5; soil.floor = floor; soil.spin = random.signed(8);
        const scale = random.range(0.02, 0.05);
        this.look(soil, EFFECT_KIND.chip, SHATTER_COLORS.soil, SHATTER_COLORS.soil, 1, scale, scale, 0.95, random.range(0.8, 1.3));
      }
      for (let index = 0, count = emitter.count(3); index < count; index++) {
        const dust = emitter.particle('dust');
        dust.position.copy(center); dust.velocity.set(random.signed(0.4), random.range(0.2, 0.5), random.signed(0.4)); dust.drag = 2;
        this.look(dust, EFFECT_KIND.puff, SHATTER_COLORS.potDust, SHATTER_COLORS.potDust, 1, 0.25, 0.75, 0.35, random.range(0.6, 1));
      }
    }
    this.onBreak?.(item.kind, point);
  }

  private droneSmoke(position: THREE.Vector3) {
    // Phones draw every other puff, like every other budget.
    if (this.currentBudget.scale < 1 && (this.smokeTick++ & 1)) return;
    const random = this.random, puff = this.emitter.particle('smoke');
    puff.position.set(position.x + random.signed(0.15), position.y + random.signed(0.08), position.z + random.signed(0.15));
    puff.velocity.set(random.signed(0.3), random.range(0.3, 0.6), random.signed(0.3));
    puff.drag = 0.8; puff.gravity = -0.2; puff.spin = random.signed(0.6);
    const size = random.range(0.25, 0.4);
    this.look(puff, EFFECT_KIND.smoke, DAMAGED_DRONE_SMOKE.color, DAMAGED_DRONE_SMOKE.endColor, 1, size, size * 3, 0.5, random.range(1.4, 2.2));
  }

  /** A camera-facing glow drawn for this frame only (drone beacons). */
  private marker(position: THREE.Vector3, color: THREE.Color, size: number, opacity: number) {
    const half = size * 0.5;
    this.across.copy(this.view.right).multiplyScalar(half); this.along.copy(this.view.up).multiplyScalar(half);
    this.layers.glow.quad(position, this.across, this.along, color.r * 2, color.g * 2, color.b * 2, opacity, EFFECT_KIND.glow, 0);
  }

  /** Sets a hand-built particle's look and starts its life. Intensities above 1 feed the bloom pass. */
  private look(particle: Particle, kind: number, color: THREE.Color, endColor: THREE.Color, intensity: number, size: number, endSize: number, opacity: number, life: number, endIntensity = intensity) {
    particle.kind = kind; particle.size = size; particle.endSize = endSize; particle.opacity = opacity;
    particle.color.copy(color).multiplyScalar(intensity); particle.endColor.copy(endColor).multiplyScalar(endIntensity);
    particle.angle = this.random.range(0, TAU); particle.seed = this.random.next();
    particle.life = particle.duration = life;
  }

  /** A random unit direction; `upward` keeps it in the upper hemisphere. */
  private randomDirection(target: THREE.Vector3, upward: boolean) {
    const random = this.random;
    target.set(random.signed(), random.signed(), random.signed());
    if (target.lengthSq() < 1e-6) target.set(0, 1, 0);
    target.normalize();
    if (upward) { target.y = Math.abs(target.y) + 0.25; target.normalize(); }
    return target;
  }

  private unit(direction: Vec3 | null | undefined): THREE.Vector3 {
    if (isFinite3(direction)) {
      const length = this.normal.set(direction.x, direction.y, direction.z).length();
      if (length > 1e-6) return this.normal.multiplyScalar(1 / length);
    }
    return this.normal.set(0, 1, 0);
  }
}
