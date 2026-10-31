import type { HitZone, Loadout, LoadoutPreset, PerkId, PrimaryWeaponId, SecondaryWeaponId, Slot, StreakId, WeaponId } from './protocol.js';

/** One weapon table for the server, client prediction, bots, viewmodel and HUD. Angles are radians,
 * times are milliseconds, distances metres. Numbers are playtest starting points. */
export interface RecoilSpec {
  /** Upward view kick per shot: first shot, and fully into a burst (eased over `ramp` shots). */
  vertical: [first: number, sustained: number];
  ramp: number;
  /** Horizontal kick scale; each shot multiplies it by the next `pattern` entry (repeating, -1..1). */
  horizontal: number;
  pattern: readonly number[];
  /** Share of the accumulated kick the view gives back after the trigger is released (0..1). */
  recovery: number;
  /** Multiplier while aiming down sights. */
  adsFactor: number;
  /** Viewmodel-only kick strength, 0..1. */
  visual: number;
}
export interface WeaponSpec {
  id: WeaponId; name: string; kind: 'ar' | 'smg' | 'shotgun' | 'sniper' | 'pistol'; slot: Slot;
  /** Rounds per minute; `auto` weapons fire while held, others once per press. */
  rpm: number; auto: boolean;
  pellets: number;
  /** Linear falloff from `near` at `nearRange` to `far` at `farRange`; nothing beyond `maxRange`. */
  damage: { near: number; far: number; nearRange: number; farRange: number };
  headMultiplier: number; legMultiplier: number; maxRange: number;
  magazine: number; reserveMags: number;
  reloadMs: number; emptyReloadMs: number;
  /** Shotgun-style reloads insert one shell per `perShellMs` after `shellStartMs`. */
  perShellMs?: number; shellStartMs?: number;
  adsMs: number;
  /** Field-of-view divisor while fully aimed (1.3 = 30% zoom). */
  adsZoom: number;
  /** Fully aimed through a scope: the HUD draws the scope and the viewmodel hides. */
  scoped: boolean;
  /** Movement speed factors when hip firing and when aimed. */
  moveFactor: number; adsMoveFactor: number;
  /** Fixed random cone half-angles (no bloom). Shotgun pellets use `pelletSpread` instead. */
  hipSpread: number; adsSpread: number;
  pelletSpread?: { hip: number; ads: number };
  sprintToFireMs: number; raiseMs: number;
  recoil: RecoilSpec;
}

export const WEAPONS: Record<WeaponId, WeaponSpec> = {
  kr5: {
    id: 'kr5', name: 'KR-5 Carbine', kind: 'ar', slot: 1, rpm: 750, auto: true, pellets: 1,
    damage: { near: 28, far: 22, nearRange: 20, farRange: 40 }, headMultiplier: 1.4, legMultiplier: 0.85, maxRange: 120,
    magazine: 30, reserveMags: 4, reloadMs: 2100, emptyReloadMs: 2600, adsMs: 240, adsZoom: 1.3, scoped: false,
    moveFactor: 0.95, adsMoveFactor: 0.52, hipSpread: 0, adsSpread: 0, sprintToFireMs: 230, raiseMs: 450,
    recoil: { vertical: [0.0045, 0.0085], ramp: 8, horizontal: 0.0022, pattern: [0.2, -0.4, 0.6, -0.2, 0.5, -0.6, 0.3, 0.1], recovery: 0.6, adsFactor: 0.62, visual: 0.55 },
  },
  hornet9: {
    id: 'hornet9', name: 'Hornet 9', kind: 'smg', slot: 1, rpm: 900, auto: true, pellets: 1,
    damage: { near: 25, far: 17, nearRange: 10, farRange: 25 }, headMultiplier: 1.25, legMultiplier: 0.85, maxRange: 80,
    magazine: 32, reserveMags: 4, reloadMs: 1900, emptyReloadMs: 2300, adsMs: 190, adsZoom: 1.2, scoped: false,
    moveFactor: 1, adsMoveFactor: 0.62, hipSpread: 0, adsSpread: 0, sprintToFireMs: 160, raiseMs: 380,
    recoil: { vertical: [0.0035, 0.006], ramp: 10, horizontal: 0.0035, pattern: [-0.3, 0.5, -0.6, 0.4, -0.2, 0.7, -0.5, 0.2], recovery: 0.65, adsFactor: 0.7, visual: 0.45 },
  },
  breaker12: {
    id: 'breaker12', name: 'Breaker 12', kind: 'shotgun', slot: 1, rpm: 70, auto: false, pellets: 8,
    damage: { near: 14, far: 4, nearRange: 7, farRange: 20 }, headMultiplier: 1, legMultiplier: 1, maxRange: 35,
    magazine: 6, reserveMags: 3, reloadMs: 0, emptyReloadMs: 0, perShellMs: 450, shellStartMs: 350,
    adsMs: 260, adsZoom: 1.15, scoped: false, moveFactor: 0.95, adsMoveFactor: 0.55, hipSpread: 0, adsSpread: 0,
    pelletSpread: { hip: 0.06, ads: 0.045 }, sprintToFireMs: 250, raiseMs: 500,
    recoil: { vertical: [0.045, 0.045], ramp: 1, horizontal: 0.008, pattern: [0.5, -0.5], recovery: 0.85, adsFactor: 0.8, visual: 1 },
  },
  longbow: {
    id: 'longbow', name: 'Longbow', kind: 'sniper', slot: 1, rpm: 48, auto: false, pellets: 1,
    damage: { near: 120, far: 120, nearRange: 0, farRange: 1 }, headMultiplier: 1, legMultiplier: 0.67, maxRange: 200,
    magazine: 5, reserveMags: 4, reloadMs: 2800, emptyReloadMs: 3200, adsMs: 420, adsZoom: 4.2, scoped: true,
    moveFactor: 0.88, adsMoveFactor: 0.42, hipSpread: 0.12, adsSpread: 0, sprintToFireMs: 350, raiseMs: 600,
    recoil: { vertical: [0.06, 0.06], ramp: 1, horizontal: 0.004, pattern: [0.3, -0.3], recovery: 0.9, adsFactor: 0.7, visual: 1 },
  },
  sentry9: {
    id: 'sentry9', name: 'Sentry 9', kind: 'pistol', slot: 2, rpm: 400, auto: false, pellets: 1,
    damage: { near: 34, far: 22, nearRange: 12, farRange: 30 }, headMultiplier: 1.4, legMultiplier: 0.85, maxRange: 80,
    magazine: 12, reserveMags: 4, reloadMs: 1500, emptyReloadMs: 1800, adsMs: 150, adsZoom: 1.15, scoped: false,
    moveFactor: 1, adsMoveFactor: 0.65, hipSpread: 0, adsSpread: 0, sprintToFireMs: 120, raiseMs: 300,
    recoil: { vertical: [0.02, 0.02], ramp: 1, horizontal: 0.004, pattern: [0.4, -0.4, 0.2, -0.2], recovery: 0.85, adsFactor: 0.75, visual: 0.7 },
  },
};
export const PRIMARY_WEAPONS: readonly PrimaryWeaponId[] = ['kr5', 'hornet9', 'breaker12', 'longbow'];
export const SECONDARY_WEAPONS: readonly SecondaryWeaponId[] = ['sentry9'];
/** Fixed shotgun pattern on the unit disc, centre pellet first. */
export const PELLET_PATTERN: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [0.55, 0], [-0.55, 0], [0, 0.55], [0, -0.55], [0.85, 0.6], [-0.85, -0.6], [0.6, -0.85],
];
export const fireIntervalMs = (spec: WeaponSpec) => 60_000 / spec.rpm;

/** Damage of one pellet or bullet at a distance and zone, before rounding. */
export function damageAt(spec: WeaponSpec, distance: number, zone: HitZone): number {
  if (distance > spec.maxRange) return 0;
  const { near, far, nearRange, farRange } = spec.damage;
  const t = Math.min(1, Math.max(0, (distance - nearRange) / Math.max(1e-6, farRange - nearRange)));
  const base = near + (far - near) * t;
  return base * (zone === 'head' ? spec.headMultiplier : zone === 'legs' ? spec.legMultiplier : 1);
}

export interface PerkSpec { id: PerkId; name: string; slot: 1 | 2 | 3; description: string }
export const PERKS: Record<PerkId, PerkSpec> = {
  'quick-hands': { id: 'quick-hands', name: 'Quick Hands', slot: 1, description: 'Reload and swap weapons 25% faster.' },
  'deep-pockets': { id: 'deep-pockets', name: 'Deep Pockets', slot: 1, description: 'Two extra spare magazines and one extra frag.' },
  'quiet-step': { id: 'quiet-step', name: 'Quiet Step', slot: 2, description: 'Your footsteps are much harder to hear.' },
  'low-profile': { id: 'low-profile', name: 'Low Profile', slot: 2, description: 'Hidden from Recon Sweeps; firing does not ping the minimap.' },
  'second-wind': { id: 'second-wind', name: 'Second Wind', slot: 3, description: 'Health starts refilling after 2.5 seconds instead of 4.' },
  'steady-aim': { id: 'steady-aim', name: 'Steady Aim', slot: 3, description: 'Aim down sights 20% faster and flinch 40% less when hit.' },
};
export const PERK_SLOTS: ReadonlyArray<readonly [PerkId, PerkId]> = [
  ['quick-hands', 'deep-pockets'], ['quiet-step', 'low-profile'], ['second-wind', 'steady-aim'],
];
export const hasPerk = (loadout: Loadout, perk: PerkId) => loadout.perks.includes(perk);
export const QUICK_HANDS_FACTOR = 0.75;
export const STEADY_AIM_ADS_FACTOR = 0.8;
export const STEADY_AIM_FLINCH_FACTOR = 0.6;
export const DEEP_POCKETS_EXTRA_MAGS = 2;

export interface StreakSpec { id: StreakId; name: string; kills: number; description: string }
export const STREAKS: Record<StreakId, StreakSpec> = {
  recon: { id: 'recon', name: 'Recon Sweep', kills: 3, description: 'Shows enemies on your minimap for 20 seconds.' },
  mortar: { id: 'mortar', name: 'Mortar Strike', kills: 5, description: 'Pick a spot on the map. Three shells land after a warning whistle.' },
  drone: { id: 'drone', name: 'Attack Drone', kills: 7, description: 'Circles the town for 25 seconds and fires at enemies it can see.' },
};
export const STREAK_ORDER: readonly StreakId[] = ['recon', 'mortar', 'drone'];

/** Explosion damage: full inside `lethal`, linear down to `edge` damage at `radius`, nothing beyond.
 * Every explosion also needs an unobstructed line from its centre to the target's torso. */
export const EXPLOSIVES = {
  frag: { lethal: 3, radius: 6, full: 110, edge: 20, throwSpeed: 16, throwLift: 3, fuseMs: 3400 },
  mortar: { lethal: 3.5, radius: 7, full: 150, edge: 25, delaysMs: [2000, 2700, 3400], scatter: 2.5 },
} as const;
export function explosionDamage(kind: keyof typeof EXPLOSIVES, distance: number): number {
  const spec = EXPLOSIVES[kind];
  if (distance > spec.radius) return 0;
  if (distance <= spec.lethal) return spec.full;
  return spec.full + (spec.edge - spec.full) * (distance - spec.lethal) / (spec.radius - spec.lethal);
}
/** The Attack Drone circles the street; it shoots whoever it can see. */
export const DRONE = {
  orbitRadius: 14, height: 11, speed: 7, fireIntervalMs: 450, damage: 18, range: 45,
  halfExtents: { x: 0.6, y: 0.25, z: 0.6 },
} as const;

export const LOADOUT_PRESETS: Record<Exclude<LoadoutPreset, 'custom'>, Loadout> = {
  assault: { primary: 'kr5', secondary: 'sentry9', lethal: 'frag', perks: ['deep-pockets', 'low-profile', 'second-wind'] },
  close: { primary: 'hornet9', secondary: 'sentry9', lethal: 'frag', perks: ['quick-hands', 'quiet-step', 'second-wind'] },
  marksman: { primary: 'longbow', secondary: 'sentry9', lethal: 'frag', perks: ['quick-hands', 'low-profile', 'steady-aim'] },
};
export const DEFAULT_LOADOUT: Loadout = LOADOUT_PRESETS.assault;

/** Accepts only a complete loadout with one perk from each perk slot. */
export function sanitizeLoadout(value: unknown): Loadout | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!PRIMARY_WEAPONS.includes(v.primary as PrimaryWeaponId) || !SECONDARY_WEAPONS.includes(v.secondary as SecondaryWeaponId) || v.lethal !== 'frag') return null;
  if (!Array.isArray(v.perks) || v.perks.length !== 3) return null;
  const perks = v.perks as unknown[];
  if (!PERK_SLOTS.every((choices, index) => choices.includes(perks[index] as PerkId))) return null;
  return { primary: v.primary as PrimaryWeaponId, secondary: v.secondary as SecondaryWeaponId, lethal: 'frag', perks: [perks[0], perks[1], perks[2]] as Loadout['perks'] };
}
export const weaponFor = (loadout: Loadout, slot: Slot): WeaponSpec => WEAPONS[slot === 1 ? loadout.primary : loadout.secondary];
