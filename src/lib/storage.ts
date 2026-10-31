import type { Loadout, LoadoutPreset, Profile } from '../../shared/protocol';
import { DEFAULT_LOADOUT, LOADOUT_PRESETS, sanitizeLoadout } from '../../shared/weapons';

export interface PlayerSession { token: string; profile: Profile }
export type HoldOrToggle = 'hold' | 'toggle';
export type SprintMode = 'hold' | 'toggle' | 'auto';
export interface Settings {
  sensitivity: number; volume: number; quality: 'auto' | 'high' | 'low'; invertY: boolean;
  firingMode: 'simple' | 'advanced'; gyroscope: boolean; gyroSensitivity: number;
  /** Look speed multiplier while aiming down sights. */
  adsSensitivity: number;
  /** Horizontal field of view in degrees. */
  fov: number;
  aimMode: HoldOrToggle; crouchMode: HoldOrToggle; sprintMode: SprintMode;
  /** Turns off head bob and softens camera roll and shake. */
  reduceMotion: boolean;
  /** The class used at the next spawn; `custom` uses `customLoadout`. */
  loadoutPreset: LoadoutPreset; customLoadout: Loadout;
}
/** Inclusive ranges for the numeric settings. */
export const SETTING_RANGES = {
  sensitivity: [0.2, 2.5], adsSensitivity: [0.3, 2], volume: [0, 1], gyroSensitivity: [0.2, 2.5], fov: [70, 110],
} as const satisfies Record<string, readonly [number, number]>;
const PLAYER_KEY = 'kannon.player.v1';
const SETTINGS_KEY = 'kannon.settings.v1';
const PRESETS: readonly LoadoutPreset[] = ['assault', 'close', 'marksman', 'custom'];
/** Coarse pointer or touch points: the device plays with on-screen controls. */
export const isTouchDevice = () => typeof matchMedia === 'function' && (matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0);
const copyLoadout = (loadout: Loadout): Loadout => ({ ...loadout, perks: [...loadout.perks] as Loadout['perks'] });

/** Touch play starts with a narrower view, tap-to-aim and stick sprinting; desktop holds to aim and sprint. */
export function defaultSettings(touch = isTouchDevice()): Settings {
  return {
    sensitivity: 1, volume: 0.45, quality: 'auto', invertY: false, firingMode: 'simple', gyroscope: false, gyroSensitivity: 1,
    adsSensitivity: 1, fov: touch ? 80 : 90, aimMode: touch ? 'toggle' : 'hold', crouchMode: 'toggle', sprintMode: touch ? 'auto' : 'hold',
    reduceMotion: false, loadoutPreset: 'assault', customLoadout: copyLoadout(DEFAULT_LOADOUT),
  };
}

const ranged = (value: unknown, [min, max]: readonly [number, number], fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  options.includes(value as T) ? value as T : fallback;

/** Saved values are kept when valid, clamped when out of range, and replaced by the device default otherwise. */
export function sanitizeSettings(value: unknown, touch = isTouchDevice()): Settings {
  const base = defaultSettings(touch);
  if (!value || typeof value !== 'object') return base;
  const v = value as Record<string, unknown>;
  return {
    sensitivity: ranged(v.sensitivity, SETTING_RANGES.sensitivity, base.sensitivity),
    volume: ranged(v.volume, SETTING_RANGES.volume, base.volume),
    quality: oneOf(v.quality, ['auto', 'high', 'low'] as const, base.quality),
    invertY: v.invertY === true,
    firingMode: v.firingMode === 'advanced' ? 'advanced' : 'simple',
    gyroscope: v.gyroscope === true,
    gyroSensitivity: ranged(v.gyroSensitivity, SETTING_RANGES.gyroSensitivity, base.gyroSensitivity),
    adsSensitivity: ranged(v.adsSensitivity, SETTING_RANGES.adsSensitivity, base.adsSensitivity),
    fov: Math.round(ranged(v.fov, SETTING_RANGES.fov, base.fov)),
    aimMode: oneOf(v.aimMode, ['hold', 'toggle'] as const, base.aimMode),
    crouchMode: oneOf(v.crouchMode, ['hold', 'toggle'] as const, base.crouchMode),
    sprintMode: oneOf(v.sprintMode, ['hold', 'toggle', 'auto'] as const, base.sprintMode),
    reduceMotion: v.reduceMotion === true,
    loadoutPreset: oneOf(v.loadoutPreset, PRESETS, base.loadoutPreset),
    customLoadout: sanitizeLoadout(v.customLoadout) ?? base.customLoadout,
  };
}

/** The loadout the player has chosen for their next spawn. */
export function activeLoadout(settings: Pick<Settings, 'loadoutPreset' | 'customLoadout'>): Loadout {
  if (settings.loadoutPreset === 'custom') return sanitizeLoadout(settings.customLoadout) ?? copyLoadout(DEFAULT_LOADOUT);
  return copyLoadout(LOADOUT_PRESETS[settings.loadoutPreset] ?? DEFAULT_LOADOUT);
}

export function readPlayer(): PlayerSession | null {
  try {
    const value = JSON.parse(localStorage.getItem(PLAYER_KEY) || 'null');
    return typeof value?.token === 'string' && typeof value?.profile?.id === 'string' && typeof value?.profile?.name === 'string' ? value : null;
  } catch { return null; }
}
export function savePlayer(value: PlayerSession) {
  localStorage.setItem(PLAYER_KEY, JSON.stringify(value));
}
export function readSettings(touch = isTouchDevice()): Settings {
  try { return sanitizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'), touch); }
  catch { return defaultSettings(touch); }
}
export function saveSettings(value: Settings) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(value)); }

export async function copyText(value: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(value); return true; } catch { return false; }
}
export function invitation(code: string, type: 'room' | 'crew' = 'room'): string {
  const url = new URL(location.origin);
  url.hash = `${type}=${encodeURIComponent(code)}`;
  return url.toString();
}
export function extractInvite(value: string, type: 'room' | 'crew' = 'room') {
  const trimmed = value.trim();
  try { const url = new URL(trimmed); return new URLSearchParams(url.hash.slice(1)).get(type) || trimmed; } catch { return trimmed; }
}

export const INVITE_POSTER = '/assets/invite-poster.jpg';
export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | false;
export interface ShareTarget { canShare?: (data: ShareData) => boolean; share?: (data: ShareData) => Promise<void> }
export function invitationMessage(code: string): string {
  return `Join my Kannon Arena match. Room code ${code}. ${invitation(code)}`;
}
/** Native share sheet with the invite poster, message and link; falls back to copying the invitation link. */
export async function shareInvitation(code: string, target: ShareTarget = navigator, loadPoster: () => Promise<File | null> = fetchInvitePoster): Promise<ShareOutcome> {
  const data: ShareData = { title: 'Kannon Arena', text: invitationMessage(code), url: invitation(code) };
  if (typeof target.share === 'function') {
    const poster = await loadPoster();
    const withPoster: ShareData = poster ? { ...data, files: [poster] } : data;
    const payload = poster && target.canShare?.(withPoster) ? withPoster : data;
    try { await target.share(payload); return 'shared'; } catch (error) { if ((error as { name?: string })?.name === 'AbortError') return 'cancelled'; }
  }
  return await copyText(data.url!) ? 'copied' : false;
}
async function fetchInvitePoster(): Promise<File | null> {
  try {
    const response = await fetch(INVITE_POSTER);
    if (!response.ok) return null;
    return new File([await response.blob()], 'kannon-arena-invite.jpg', { type: 'image/jpeg' });
  } catch { return null; }
}
