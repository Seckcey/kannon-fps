import type { RenderTier } from '../RenderTiers';

export type EffectsQuality = 'phone' | 'desktop';

/** How much the effects may draw. `quality` sets particle budgets; the other two follow the render tier. */
export interface CombatEffectsOptions {
  quality: EffectsQuality;
  /** Short point-light flashes for muzzles and explosions. Defaults to on for desktop and off for phones. */
  muzzleLight?: boolean;
  /** Bullet holes kept at once before the oldest is reused. Defaults to 128 on desktop and 48 on phones. */
  decals?: number;
}

/** Fixed pool sizes. Every pool is allocated once; nothing grows per shot. */
export interface EffectBudget {
  quality: EffectsQuality;
  /** Multiplier for per-event particle counts: phones draw half. */
  scale: number;
  /** Additive particles: flashes, sparks, fire, glints, shimmer. */
  glowParticles: number;
  /** Short-lived alpha particles: dust, chips, splinters, shards, debris, dark puffs. */
  dustParticles: number;
  /** Muzzle smoke. Gunfire churns through this pool quickly, so nothing long-lived shares it. */
  smokeParticles: number;
  /** Long-lived alpha particles: explosion smoke and dust, and damaged-drone smoke. Their own pool, so a
   * firefight never recycles a grenade's smoke before it has faded. */
  plumeParticles: number;
  tracers: number;
  /** Glow quads redrawn every frame for drone beacons. */
  markers: number;
  shells: number;
  /** Pooled point lights; 0 when the tier has no muzzle light. */
  lights: number;
  decals: number;
  scorches: number;
  grenades: number;
  drones: number;
}

export const MAX_DECALS = 512;
/** Desktop pool sizes. Plumes: a three-shell mortar strike, two frags and a damaged drone at once (about
 * 200 particles living 2 to 6 s); phones emit half per event into half the pool. */
const DESKTOP = { glowParticles: 512, dustParticles: 384, smokeParticles: 128, plumeParticles: 256, tracers: 96, shells: 96, scorches: 12, lights: 3 } as const;

export function effectBudget(options?: Partial<CombatEffectsOptions> | null): EffectBudget {
  const quality: EffectsQuality = options?.quality === 'phone' ? 'phone' : 'desktop';
  const phone = quality === 'phone';
  const half = (count: number) => (phone ? Math.ceil(count / 2) : count);
  const wanted = options?.decals;
  const decals = typeof wanted === 'number' && Number.isFinite(wanted) ? Math.min(MAX_DECALS, Math.max(0, Math.floor(wanted))) : phone ? 48 : 128;
  const muzzleLight = typeof options?.muzzleLight === 'boolean' ? options.muzzleLight : !phone;
  return {
    quality, scale: phone ? 0.5 : 1,
    glowParticles: half(DESKTOP.glowParticles), dustParticles: half(DESKTOP.dustParticles),
    smokeParticles: half(DESKTOP.smokeParticles), plumeParticles: half(DESKTOP.plumeParticles),
    tracers: half(DESKTOP.tracers), markers: 16, shells: half(DESKTOP.shells),
    lights: muzzleLight ? DESKTOP.lights : 0, decals, scorches: half(DESKTOP.scorches),
    // Grenades and drones are gameplay information, so phones see every one of them.
    grenades: 16, drones: 8,
  };
}

/** Scales a recipe count to the budget; any non-zero count keeps at least one particle. */
export function scaledCount(count: number, scale: number): number {
  if (!(count > 0) || !(scale > 0) || !Number.isFinite(count * scale)) return 0;
  return Math.max(1, Math.round(count * scale));
}

/** Options for a render tier: `new CombatEffects(effectsOptionsFor(tier))` or `effects.configure(...)`. */
export function effectsOptionsFor(tier: Pick<RenderTier, 'effects' | 'muzzleLight' | 'decals'>): CombatEffectsOptions {
  return { quality: tier.effects, muzzleLight: tier.muzzleLight, decals: tier.decals };
}

export function sameBudget(a: EffectBudget, b: EffectBudget): boolean {
  for (const key of Object.keys(a) as Array<keyof EffectBudget>) if (a[key] !== b[key]) return false;
  return true;
}
