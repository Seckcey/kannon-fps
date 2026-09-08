import type { Profile } from '../../shared/protocol';

export interface PlayerSession { token: string; profile: Profile }
export interface Settings { sensitivity: number; volume: number; quality: 'auto' | 'high' | 'low'; invertY: boolean }
const PLAYER_KEY = 'kannon.player.v1';
const SETTINGS_KEY = 'kannon.settings.v1';
export const defaultSettings: Settings = { sensitivity: 1, volume: 0.45, quality: 'auto', invertY: false };

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
