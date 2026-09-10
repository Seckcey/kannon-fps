import type { Profile } from '../../shared/protocol';

export interface PlayerSession { token: string; profile: Profile }
export interface Settings { sensitivity: number; volume: number; quality: 'auto' | 'high' | 'low'; invertY: boolean; firingMode: 'simple' | 'advanced'; gyroscope: boolean; gyroSensitivity: number }
const PLAYER_KEY = 'kannon.player.v1';
const SETTINGS_KEY = 'kannon.settings.v1';
/** Coarse pointer or touch points: the device plays with on-screen controls. */
export const isTouchDevice = () => typeof matchMedia === 'function' && (matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0);
export const defaultSettings: Settings = { sensitivity: 1, volume: 0.45, quality: 'auto', invertY: false, firingMode: 'simple', gyroscope: false, gyroSensitivity: 1 };

export function readPlayer(): PlayerSession | null {
  try {
    const value = JSON.parse(localStorage.getItem(PLAYER_KEY) || 'null');
    return typeof value?.token === 'string' && typeof value?.profile?.id === 'string' && typeof value?.profile?.name === 'string' ? value : null;
  } catch { return null; }
}
export function savePlayer(value: PlayerSession) {
  localStorage.setItem(PLAYER_KEY, JSON.stringify(value));
}
export function readSettings(): Settings {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      sensitivity: typeof value.sensitivity === 'number' ? Math.max(0.2, Math.min(2.5, value.sensitivity)) : 1,
      volume: typeof value.volume === 'number' ? Math.max(0, Math.min(1, value.volume)) : 0.45,
      quality: ['auto', 'high', 'low'].includes(value.quality) ? value.quality : 'auto',
      invertY: value.invertY === true,
      firingMode: value.firingMode === 'advanced' ? 'advanced' : 'simple',
      gyroscope: value.gyroscope === true,
      gyroSensitivity: typeof value.gyroSensitivity === 'number' && Number.isFinite(value.gyroSensitivity) ? Math.max(0.2, Math.min(2.5, value.gyroSensitivity)) : 1,
    };
  } catch { return defaultSettings; }
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
