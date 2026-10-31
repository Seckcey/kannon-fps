import * as THREE from 'three';
import type { SurfaceKind, WeaponId } from '../../../shared/protocol';
import { EFFECT_KIND } from './QuadBatch';
import { FACING } from './particles';

/** The three particle pools: additive light, short-lived alpha dust, and long-lived smoke. */
export type PoolName = 'glow' | 'dust' | 'smoke';

/** One group of particles in a burst. Directions start along the surface normal and stray by `spread`. */
export interface BurstSpec {
  pool: PoolName; kind: number; count: number;
  color: THREE.Color; endColor?: THREE.Color;
  /** Colour multiplier; above 1 lets additive light reach the bloom pass. */
  intensity?: number;
  /** Start size range in metres, and the size at death as a multiple of it. */
  size: readonly [number, number]; endScale: number;
  life: readonly [number, number]; speed: readonly [number, number];
  spread: number; lift?: number; gravity?: number; drag?: number; opacity: number;
  facing?: number; aspect?: number | readonly [number, number]; spin?: number; bounce?: number;
  /** Start this far out along the normal, give or take `jitter` on each axis. */
  offset?: number; jitter?: number;
}

const tone = (hex: string) => new THREE.Color(hex);
const has = <T extends object>(table: T, key: unknown): key is keyof T => typeof key === 'string' && Object.hasOwn(table, key);

export const SURFACE_KINDS: readonly SurfaceKind[] = ['asphalt', 'concrete', 'wood', 'grass', 'metal', 'fabric', 'glass', 'sandbag'];
export const isSurfaceKind = (value: unknown): value is SurfaceKind => SURFACE_KINDS.includes(value as SurfaceKind);

const dust = (color: string, count: number, opacity = 0.5): BurstSpec => ({
  pool: 'dust', kind: EFFECT_KIND.puff, count, color: tone(color), size: [0.1, 0.16], endScale: 3.2,
  life: [0.35, 0.6], speed: [0.4, 1], spread: 0.6, lift: 0.25, drag: 2.5, opacity,
});
const chips = (color: string, count: number): BurstSpec => ({
  pool: 'dust', kind: EFFECT_KIND.chip, count, color: tone(color), size: [0.03, 0.06], endScale: 0.6,
  life: [0.35, 0.6], speed: [1.4, 3], spread: 0.8, lift: 0.8, gravity: 9, drag: 0.4, opacity: 0.9, spin: 14, bounce: 0.3,
});
const slivers = (color: string, count: number, size: readonly [number, number], opacity = 0.9): BurstSpec => ({
  pool: 'dust', kind: EFFECT_KIND.shard, count, color: tone(color), size, endScale: 0.8,
  life: [0.35, 0.65], speed: [1.2, 3], spread: 0.7, lift: 0.5, gravity: 8, drag: 0.5, opacity, facing: FACING.velocity, aspect: [2.5, 3.5], bounce: 0.2,
});
const sparks = (count: number): BurstSpec => ({
  pool: 'glow', kind: EFFECT_KIND.streak, count, color: tone('#ffd9a0'), intensity: 1.6, size: [0.014, 0.02], endScale: 0.5,
  life: [0.12, 0.26], speed: [3, 7], spread: 0.9, lift: 0.6, gravity: 6, drag: 0.6, opacity: 1, facing: FACING.velocity, aspect: [4, 6], bounce: 0.4,
});

/** What a bullet throws up from each surface. People get dark puffs (never blood); protected targets shimmer. */
export const IMPACT_RECIPES: Readonly<Record<SurfaceKind | 'player' | 'protected', readonly BurstSpec[]>> = {
  concrete: [dust('#bab3a4', 3), chips('#9b968b', 4), sparks(1)],
  asphalt: [dust('#77726a', 3), chips('#403d39', 4), sparks(1)],
  wood: [dust('#b39674', 2, 0.42), { ...slivers('#8b6a45', 5, [0.02, 0.035], 0.95), speed: [1.5, 3.2] }],
  metal: [
    sparks(7),
    { pool: 'glow', kind: EFFECT_KIND.glow, count: 1, color: tone('#fff0c8'), intensity: 1.5, size: [0.12, 0.16], endScale: 0.3, life: [0.04, 0.06], speed: [0, 0], spread: 0, opacity: 0.9 },
    { ...dust('#5d5a55', 1, 0.35), size: [0.07, 0.1], endScale: 3 },
  ],
  grass: [
    { ...chips('#4a3a28', 5), speed: [1.5, 3.5], spread: 0.5, lift: 1.2, bounce: 0.15 },
    { ...slivers('#5d6e3a', 2, [0.03, 0.05]), speed: [1, 2.2], gravity: 6, drag: 1, aspect: 2.5 },
    dust('#7c6a50', 2, 0.45),
  ],
  sandbag: [{ ...slivers('#c7ad7c', 6, [0.012, 0.02]), speed: [1.2, 2.6], spread: 0.6, lift: 0.4, gravity: 9, drag: 0.6, aspect: 2.5, bounce: 0.1 }, dust('#b8a074', 3, 0.45)],
  fabric: [dust('#a49c8c', 2, 0.4), { ...slivers('#6e675c', 2, [0.015, 0.025], 0.85), speed: [0.8, 1.6], lift: 0.3, gravity: 4, drag: 1.5, aspect: 3 }],
  glass: [
    { ...slivers('#d4e7ee', 6, [0.02, 0.045], 0.75), facing: FACING.camera, aspect: [1, 1.8], spin: 16, bounce: 0.25 },
    { pool: 'glow', kind: EFFECT_KIND.glow, count: 2, color: tone('#e8f6ff'), intensity: 1.4, size: [0.05, 0.07], endScale: 0.4, life: [0.08, 0.14], speed: [0.2, 0.6], spread: 1, opacity: 0.9 },
    dust('#e4ecee', 1, 0.25),
  ],
  player: [
    { pool: 'dust', kind: EFFECT_KIND.puff, count: 3, color: tone('#2e2a27'), endColor: tone('#4a4540'), size: [0.12, 0.18], endScale: 2.6, life: [0.3, 0.5], speed: [0.3, 0.9], spread: 0.7, lift: 0.15, drag: 3, opacity: 0.6 },
    { ...chips('#24211f', 2), size: [0.02, 0.03], endScale: 0.7, life: [0.25, 0.4], speed: [1, 2], lift: 0.4, gravity: 6, drag: 0.6, opacity: 0.8, spin: 10, bounce: 0.2 },
  ],
  protected: [
    { pool: 'glow', kind: EFFECT_KIND.ring, count: 1, color: tone('#82e7ff'), intensity: 1.2, size: [0.34, 0.4], endScale: 2.2, life: [0.25, 0.3], speed: [0, 0], spread: 0, opacity: 0.7 },
    { pool: 'glow', kind: EFFECT_KIND.glow, count: 4, color: tone('#b8f4ff'), size: [0.04, 0.06], endScale: 0.3, life: [0.2, 0.35], speed: [0.4, 1], spread: 1, lift: 0.3, opacity: 0.8 },
  ],
};
export const impactRecipe = (surface: unknown, protectedTarget: boolean): readonly BurstSpec[] =>
  protectedTarget ? IMPACT_RECIPES.protected : has(IMPACT_RECIPES, surface) && surface !== 'protected' ? IMPACT_RECIPES[surface] : IMPACT_RECIPES.concrete;

/** How each weapon looks when it fires and where its rounds land. */
export interface MuzzleStyle {
  /** Traces presented per shot: the shotgun's pellets, one for everything else. */
  pellets: number;
  /** Flash core and flame sizes, side-flash length and width (metres), flash life (seconds). */
  flash: number; flame: number; streak: number; streakWidth: number; flashLife: number;
  smoke: number;
  /** Peak point-light intensity, range (metres) and life (seconds). */
  light: number; lightRange: number; lightLife: number;
  tracerWidth: number; tracerLife: number; tracerColor: THREE.Color; tracerIntensity: number;
  /** Impact particles per contact, relative to a rifle round. */
  impactScale: number;
  /** Bullet-hole radius in metres. */
  holeSize: number;
}
const ivory = tone('#ffe7b3'), amber = tone('#ffc27a'), ember = tone('#ff8a5c');
export const MUZZLE_STYLES: Readonly<Record<WeaponId | 'drone', MuzzleStyle>> = {
  kr5: { pellets: 1, flash: 0.26, flame: 0.38, streak: 0.42, streakWidth: 0.08, flashLife: 0.05, smoke: 1, light: 14, lightRange: 7, lightLife: 0.06, tracerWidth: 0.024, tracerLife: 0.09, tracerColor: ivory, tracerIntensity: 1.3, impactScale: 1, holeSize: 0.055 },
  hornet9: { pellets: 1, flash: 0.2, flame: 0.3, streak: 0.3, streakWidth: 0.065, flashLife: 0.045, smoke: 1, light: 11, lightRange: 6, lightLife: 0.05, tracerWidth: 0.02, tracerLife: 0.08, tracerColor: ivory, tracerIntensity: 1.2, impactScale: 0.85, holeSize: 0.045 },
  breaker12: { pellets: 8, flash: 0.4, flame: 0.62, streak: 0.55, streakWidth: 0.12, flashLife: 0.07, smoke: 3, light: 20, lightRange: 8, lightLife: 0.08, tracerWidth: 0.014, tracerLife: 0.075, tracerColor: amber, tracerIntensity: 1.1, impactScale: 0.45, holeSize: 0.035 },
  longbow: { pellets: 1, flash: 0.44, flame: 0.66, streak: 0.8, streakWidth: 0.12, flashLife: 0.07, smoke: 3, light: 22, lightRange: 9, lightLife: 0.08, tracerWidth: 0.03, tracerLife: 0.12, tracerColor: ivory, tracerIntensity: 1.5, impactScale: 1.4, holeSize: 0.07 },
  sentry9: { pellets: 1, flash: 0.18, flame: 0.28, streak: 0.26, streakWidth: 0.06, flashLife: 0.045, smoke: 1, light: 10, lightRange: 6, lightLife: 0.05, tracerWidth: 0.02, tracerLife: 0.08, tracerColor: ivory, tracerIntensity: 1.2, impactScale: 0.85, holeSize: 0.045 },
  drone: { pellets: 1, flash: 0.22, flame: 0.3, streak: 0.34, streakWidth: 0.07, flashLife: 0.05, smoke: 0, light: 9, lightRange: 6, lightLife: 0.05, tracerWidth: 0.022, tracerLife: 0.1, tracerColor: ember, tracerIntensity: 1.4, impactScale: 0.9, holeSize: 0.05 },
};
export const muzzleStyle = (weapon: unknown): MuzzleStyle => (has(MUZZLE_STYLES, weapon) ? MUZZLE_STYLES[weapon] : MUZZLE_STYLES.kr5);
export const MUZZLE_COLORS = { core: tone('#fff3d6'), flame: tone('#ffb24d'), side: tone('#ffbe6a'), light: tone('#ffb36b'), smoke: tone('#8b8780'), smokeEnd: tone('#aaa69f') } as const;

export interface ExplosionRecipe {
  /** Size and speed multiplier. */
  scale: number;
  /** Particle counts before the phone budget halves them. */
  flash: number; fire: number; sparks: number; smoke: number; debris: number;
  /** Ground dust ring and (mortar) thrown-up earth, only when the blast is near the ground. */
  ring: number; column: number;
  /** Scorch-mark radius in metres (0 for none). */
  scorch: number;
  light: { intensity: number; distance: number; duration: number };
}
export const EXPLOSION_RECIPES: Readonly<Record<'frag' | 'mortar' | 'drone', ExplosionRecipe>> = {
  frag: { scale: 1, flash: 1, fire: 10, sparks: 14, smoke: 12, debris: 16, ring: 12, column: 0, scorch: 1.35, light: { intensity: 220, distance: 16, duration: 0.35 } },
  mortar: { scale: 1.35, flash: 1, fire: 14, sparks: 18, smoke: 16, debris: 22, ring: 16, column: 8, scorch: 2.1, light: { intensity: 320, distance: 20, duration: 0.45 } },
  drone: { scale: 0.9, flash: 1, fire: 8, sparks: 20, smoke: 10, debris: 14, ring: 10, column: 0, scorch: 1, light: { intensity: 160, distance: 14, duration: 0.3 } },
};
export const explosionRecipe = (kind: unknown): ExplosionRecipe => (has(EXPLOSION_RECIPES, kind) ? EXPLOSION_RECIPES[kind] : EXPLOSION_RECIPES.frag);
/** A blast this far (times its scale) above the surface below still marks and dusts the ground. */
export const GROUND_REACH = 2.2;
export const EXPLOSION_COLORS = {
  flash: tone('#ffe2b0'), fireHot: tone('#ffd7a0'), fireCool: tone('#a8380e'), spark: tone('#ffc070'),
  smoke: tone('#3d3a37'), smokeEnd: tone('#7a766f'), debris: tone('#2f2b27'), earth: tone('#5a4a3a'),
  ring: tone('#8f8370'), ringEnd: tone('#a99e8a'), column: tone('#4b3f33'), columnEnd: tone('#7a6c5c'), light: tone('#ff9d52'),
} as const;

/** Breakables: glass panes and pots. */
export const SHATTER_COLORS = {
  glass: tone('#d6e6ea'), glint: tone('#eef8ff'), glassDust: tone('#e8eef0'),
  pot: tone('#9c5a3c'), potDark: tone('#7d4a33'), soil: tone('#3d3025'), potDust: tone('#7a6650'),
} as const;

/** Eliminations: a little settling dust. Respawns: a soft cool shimmer. */
export const ELIMINATION = { low: 6, torso: 3, color: tone('#8a7f6f'), endColor: tone('#a49a8a') } as const;
export const RESPAWN = { ring: 1, motes: 10, ringColor: tone('#8fd8ff'), moteColor: tone('#b8ecff') } as const;
export const DAMAGED_DRONE_SMOKE = { color: tone('#3b3936'), endColor: tone('#6f6b65') } as const;
