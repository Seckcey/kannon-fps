import type { Loadout, LoadoutPreset, PerkId, PrimaryWeaponId } from '../../shared/protocol';
import { DEFAULT_LOADOUT, LOADOUT_PRESET_NAMES, LOADOUT_PRESETS, PERK_SLOTS, damageAt, sanitizeLoadout, type WeaponSpec } from '../../shared/weapons';

export const PRESET_ORDER: readonly LoadoutPreset[] = ['assault', 'close', 'marksman', 'custom'];
export const PRESET_INFO: Record<LoadoutPreset, { name: string; summary: string }> = {
  assault: { name: LOADOUT_PRESET_NAMES.assault, summary: 'A steady carbine for any range.' },
  close: { name: LOADOUT_PRESET_NAMES.close, summary: 'A fast SMG for rooms and corners.' },
  marksman: { name: LOADOUT_PRESET_NAMES.marksman, summary: 'A scoped bolt rifle for long lanes.' },
  custom: { name: LOADOUT_PRESET_NAMES.custom, summary: 'Pick your own primary and perks.' },
};
export const WEAPON_KIND_NAMES: Record<WeaponSpec['kind'], string> = {
  ar: 'Carbine', smg: 'Submachine gun', shotgun: 'Pump shotgun', sniper: 'Bolt rifle', pistol: 'Pistol',
};

/** Picker bars, each 0..1. They compare primaries; they are not exact numbers. */
export interface WeaponStats { damage: number; fireRate: number; range: number; mobility: number; handling: number }
export const STAT_LABELS: Record<keyof WeaponStats, string> = {
  damage: 'Damage', fireRate: 'Fire rate', range: 'Range', mobility: 'Mobility', handling: 'Aim speed',
};
const unit = (value: number) => Math.max(0.05, Math.min(1, value));
/** The distance where one shot still does at least 90% of its close-range damage. */
export function effectiveRange(spec: WeaponSpec): number {
  const { near, far, nearRange, farRange } = spec.damage;
  if (far >= near * 0.9) return spec.maxRange;
  return nearRange + (farRange - nearRange) * (near * 0.1) / (near - far);
}
export function weaponStats(spec: WeaponSpec): WeaponStats {
  const perShot = damageAt(spec, 0, 'torso') * spec.pellets;
  return {
    damage: unit(Math.sqrt(perShot / 120)),
    fireRate: unit(spec.rpm / 900),
    range: unit(effectiveRange(spec) / 60),
    mobility: unit(((spec.moveFactor - 0.8) / 0.2 + (1 - (spec.sprintToFireMs - 100) / 300)) / 2),
    handling: unit(1 - (spec.adsMs - 150) / 300),
  };
}

/** The class a preset stands for; custom classes are validated and fall back to the default. */
export function loadoutFor(preset: LoadoutPreset, custom: Loadout): Loadout {
  if (preset === 'custom') return sanitizeLoadout(custom) ?? DEFAULT_LOADOUT;
  return LOADOUT_PRESETS[preset];
}
export function withPrimary(loadout: Loadout, primary: PrimaryWeaponId): Loadout {
  return { ...loadout, perks: [...loadout.perks] as Loadout['perks'], primary };
}
/** Replaces the perk in one slot (0..2); a perk from another slot is ignored. */
export function withPerk(loadout: Loadout, slot: 0 | 1 | 2, perk: PerkId): Loadout {
  if (!PERK_SLOTS[slot]?.includes(perk)) return loadout;
  const perks = [...loadout.perks] as Loadout['perks'];
  perks[slot] = perk;
  return { ...loadout, perks };
}
export const sameLoadout = (a: Loadout, b: Loadout) =>
  a.primary === b.primary && a.secondary === b.secondary && a.lethal === b.lethal && a.perks.every((perk, index) => perk === b.perks[index]);
