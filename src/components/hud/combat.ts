import { STREAKS, STREAK_ORDER, type StreakSpec, type WeaponSpec } from '../../../shared/weapons';
import type { HitMarker } from '../../game/hud';

/** One crosshair shape per weapon class. */
export type CrosshairStyle = 'cross' | 'tight' | 'ring' | 'wide' | 'pistol';
export function crosshairStyle(kind: WeaponSpec['kind']): CrosshairStyle {
  return kind === 'smg' ? 'tight' : kind === 'shotgun' ? 'ring' : kind === 'sniper' ? 'wide' : kind === 'pistol' ? 'pistol' : 'cross';
}
/** A crosshair line in CSS pixels, relative to the screen centre (x right, y down). */
export interface Tick { x: number; y: number; w: number; h: number }
/** Lines for a crosshair whose inner gap is `gap` pixels; nothing when the gap is 0 (sprinting, aiming, vaulting). */
export function crosshairTicks(style: CrosshairStyle, gap: number): Tick[] {
  if (!(gap > 0)) return [];
  const length = style === 'tight' ? 6 : style === 'ring' || style === 'wide' ? 5 : style === 'pistol' ? 7 : 9;
  const thick = 2, g = Math.max(2, gap);
  const left: Tick = { x: -g - length, y: -thick / 2, w: length, h: thick };
  const right: Tick = { x: g, y: -thick / 2, w: length, h: thick };
  const top: Tick = { x: -thick / 2, y: -g - length, w: thick, h: length };
  const bottom: Tick = { x: -thick / 2, y: g, w: thick, h: length };
  return style === 'pistol' ? [left, right, bottom] : [left, right, top, bottom];
}
/** Ring radius for the shotgun and the bolt rifle's hip spread, or 0 for line crosshairs. */
export function crosshairRing(style: CrosshairStyle, gap: number): number {
  return (style === 'ring' || style === 'wide') && gap > 0 ? Math.max(8, gap) : 0;
}
/** Largest hip gap the game draws for a weapon with no cone (the SMG's), in CSS pixels. */
const BASE_GAP = 11;
/** Hit markers (scaled up when fresh) and the grenade cook ring reach this far from the centre. */
const MARKER_REACH = 30;
/**
 * How far the hip crosshair, hit markers and cook ring can reach from the screen centre, in CSS
 * pixels, so text can be laid out clear of them. The weapon's fixed hip cone is drawn to scale at
 * the player's field of view (horizontal degrees), like the game's own crosshair gap.
 */
export function crosshairReach(spec: Pick<WeaponSpec, 'kind' | 'hipSpread' | 'pelletSpread'>, fovDegrees: number, width: number, height: number): number {
  const spread = spec.pelletSpread?.hip ?? spec.hipSpread;
  const fov = Math.max(1, Math.min(179, Number.isFinite(fovDegrees) ? fovDegrees : 90)) * Math.PI / 180;
  const vertical = 2 * Math.atan(Math.tan(fov / 2) * height / Math.max(1, width));
  const cone = spread > 0 ? Math.tan(spread) / Math.tan(vertical / 2) * height / 2 : 0;
  const style = crosshairStyle(spec.kind), gap = Math.max(BASE_GAP, cone);
  const ticks = crosshairTicks(style, gap).reduce((far, tick) => Math.max(far, Math.abs(tick.y), Math.abs(tick.y + tick.h), Math.abs(tick.x), Math.abs(tick.x + tick.w)), 0);
  return Math.ceil(Math.max(MARKER_REACH, ticks + 2, crosshairRing(style, gap) + 2));
}

/** How long each marker stays on screen, in milliseconds. */
export const MARKER_MS: Record<HitMarker['kind'], number> = { hit: 260, head: 360, kill: 560 };
export const ARC_MS = 1600;
/** A marker stamped this far in the future comes from another clock (server time, say) and is dropped. */
export const CLOCK_SKEW_MS = 1000;
/** 1 when new, fading to 0 at `durationMs`. Times are performance.now() milliseconds; a slightly
 * newer stamp still shows, but one from a different clock expires instead of staying on screen. */
export function fadeOut(now: number, at: number, durationMs: number): number {
  const age = now - at;
  if (!Number.isFinite(age) || age < -CLOCK_SKEW_MS) return 0;
  if (age <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - age / durationMs));
}
/** Damage arcs are stronger for bigger hits and fade over ARC_MS. */
export function arcOpacity(now: number, at: number, amount: number): number {
  return fadeOut(now, at, ARC_MS) * Math.max(0.45, Math.min(1, 0.35 + amount / 40));
}
/** Low-health screen edge: 0 at 70 health and above, full at 15 and below, off once eliminated. */
export function lowHealthLevel(health: number): number {
  if (!(health > 0) || health >= 70) return 0;
  return Math.min(1, (70 - health) / 55);
}
export const healthBarVisible = (health: number) => health > 0 && health < 100;

export type AmmoLevel = 'ok' | 'low' | 'empty';
export function ammoLevel(mag: number, magazine: number): AmmoLevel {
  if (mag <= 0) return 'empty';
  return mag <= Math.max(1, Math.ceil(magazine * 0.25)) ? 'low' : 'ok';
}

export interface StreakProgress {
  streak: number; next: StreakSpec | null; remaining: number;
  marks: Array<{ id: StreakSpec['id']; kills: number; reached: boolean }>;
}
/** Eliminations in this life toward the next reward (3, 5 and 7 in a row). */
export function streakProgress(streak: number): StreakProgress {
  const count = Math.max(0, Math.floor(streak || 0));
  const marks = STREAK_ORDER.map(id => ({ id, kills: STREAKS[id].kills, reached: count >= STREAKS[id].kills }));
  const next = marks.find(mark => !mark.reached);
  return { streak: count, next: next ? STREAKS[next.id] : null, remaining: next ? next.kills - count : 0, marks };
}

/** Grenade cooking: `danger` once most of the fuse is gone. */
export function cookState(cook: number): { active: boolean; progress: number; danger: boolean } {
  if (!(cook >= 0)) return { active: false, progress: 0, danger: false };
  const progress = Math.min(1, cook);
  return { active: true, progress, danger: progress >= 0.7 };
}
/** A live grenade is easier to notice the closer it is. */
export function grenadeAlert(distance: number): number {
  return Math.max(0.4, Math.min(1, 1 - (distance - 2) / 10));
}
/** Stamina only shows while dashing or refilling. */
export const staminaVisible = (stamina: number, dashing: boolean) => dashing || stamina < 0.995;
