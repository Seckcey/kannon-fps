import type { Posture, Slot, StreakId, WeaponId } from '../../shared/protocol';

/** Per-frame HUD feed from GameView to React. GameView publishes at most ~30 times a second;
 * low-frequency match data (scores, clock, kill feed, medals) still comes from the connection. */
export interface HitMarker { id: number; at: number; kind: 'hit' | 'head' | 'kill' }
/** `angle` is radians from straight ahead, positive to the right, at the time of drawing. */
export interface DamageArc { id: number; at: number; angle: number; amount: number }
export interface GrenadeWarning { id: string; angle: number; distance: number }
export interface MinimapBlip {
  x: number; z: number; yaw?: number;
  kind: 'friend' | 'enemy' | 'ping' | 'drone' | 'mortar' | 'grenade';
  /** 0..1 fade for pings and expiring markers. */
  fade: number;
}
export interface HudFrame {
  /** performance.now() of the rendered frame. */
  time: number;
  weapon: WeaponId; slot: Slot; mag: number; reserve: number; frags: number;
  /** Reload progress 0..1, or -1 when not reloading. */
  reload: number;
  /** Aim-down-sights blend 0..1. */
  ads: number;
  /** A scoped weapon is fully aimed: draw the scope overlay and hide the crosshair. */
  scoped: boolean;
  sprinting: boolean; dashing: boolean; stamina: number; posture: Posture;
  /** Displayed health (predicted regen between snapshots). */
  health: number;
  /** Hip crosshair gap in CSS pixels; 0 hides it (sprinting, aiming, vaulting). */
  crosshair: number;
  /** Grenade cook 0..1, or -1 when not cooking. */
  cook: number;
  /** Weapon is lowered near a wall or still raising; the crosshair dims. */
  blocked: boolean;
  hitMarkers: HitMarker[]; damageArcs: DamageArc[]; grenades: GrenadeWarning[];
  /** Local player's world position and view yaw for the minimap. */
  view: { x: number; z: number; yaw: number };
  blips: MinimapBlip[];
  reconActive: boolean;
  /** Earned, unused rewards, oldest first. */
  rewards: StreakId[];
  /** The player picked the mortar and must choose a spot on the map. */
  mortarTargeting: boolean;
}

/** Small external store so React can subscribe without re-rendering the 3D view. */
export class HudStore {
  private frame: HudFrame | null = null;
  private readonly listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.frame;
  publish(frame: HudFrame) { this.frame = frame; for (const listener of this.listeners) listener(); }
  clear() { this.frame = null; for (const listener of this.listeners) listener(); }
}
