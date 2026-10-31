import type { WeaponId } from '../../../shared/protocol';

export type Vec3Tuple = readonly [number, number, number];

/** Where the weapon sits in camera space. The camera looks down -Z with +Y up. */
export interface PoseSpec {
  /** Camera-space position of the right palm grip point (metres). */
  grip: Vec3Tuple;
  /** Weapon rotation (radians): pitch (+ muzzle up), yaw (+ muzzle left), roll (+ top leans left). */
  rotation: Vec3Tuple;
}

export type ReloadStyle = 'rifle' | 'smg' | 'shotgun' | 'bolt' | 'pistol';
export type ActionStyle = 'charge' | 'pump' | 'bolt' | 'slide';
export type ShellStyle = 'rifle' | 'pistol' | 'hull';

export interface KickSpec {
  /** Impulses (metres or radians per second) given to the recoil springs per shot, before
   * `WEAPONS[id].recoil.visual`. `up` lifts the whole gun; `pitch` flips the muzzle. */
  back: number; up: number; pitch: number; roll: number; yaw: number;
  /** Recoil spring frequency (Hz) and damping ratio: lower and looser feels heavier. */
  hz: number; damping: number;
  /** Rotation share kept at full aim, so the sight picture stays readable. */
  adsRotation: number;
  /** Push-back share kept at full aim. */
  adsBack: number;
}

export interface HandlingSpec {
  hip: PoseSpec;
  /** Ordinary sprint: weapon canted across the body, muzzle low. */
  sprint: PoseSpec;
  /** Faster stamina sprint: weapon lifted high, muzzle up. */
  dash: PoseSpec;
  /** Distance from the eye to the sight anchor when fully aimed (eye relief). */
  adsEye: number;
  /** Look sway spring frequency (Hz) and amplitude; heavier guns answer slower and swing further. */
  swayHz: number; sway: number;
  /** Stride bob amplitude scale. */
  bob: number;
  kick: KickSpec;
  /** Pivot for sway and recoil rotation relative to the right grip, in weapon space (+Z is toward the stock). */
  pivot: Vec3Tuple;
  reload: ReloadStyle; action: ActionStyle; shell: ShellStyle;
  /** Travel of the moving part (metres along +Z): charging handle, pump, bolt or slide. */
  actionTravel: number;
  /** Muzzle flash size scale. */
  flash: number;
  /** Seconds after a shot before a pump or bolt cycle starts (0 = no manual cycle). */
  cycleDelay: number;
}

const rifleSprint: PoseSpec = { grip: [0.2, -0.245, -0.38], rotation: [-0.55, 0.55, -0.45] };
const rifleDash: PoseSpec = { grip: [0.21, -0.21, -0.32], rotation: [0.92, 0.3, 0.85] };

/** Handling for each weapon. Numbers are tuned by eye against the procedural stand-ins and only
 * depend on the anchors, so the exported models inherit them unchanged. */
export const HANDLING: Readonly<Record<WeaponId, HandlingSpec>> = {
  kr5: {
    hip: { grip: [0.155, -0.18, -0.41], rotation: [0.1, 0.04, 0.04] },
    sprint: rifleSprint, dash: rifleDash,
    adsEye: 0.2, swayHz: 3.0, sway: 1, bob: 1,
    kick: { back: 3.0, up: 0.35, pitch: 3.2, roll: 2.4, yaw: 0.8, hz: 7.5, damping: 0.42, adsRotation: 0.35, adsBack: 0.75 },
    pivot: [0, 0.02, 0.17], reload: 'rifle', action: 'charge', shell: 'rifle', actionTravel: 0.07, flash: 1, cycleDelay: 0,
  },
  hornet9: {
    hip: { grip: [0.145, -0.17, -0.38], rotation: [0.09, 0.045, 0.04] },
    sprint: { grip: [0.19, -0.235, -0.36], rotation: [-0.56, 0.52, -0.44] },
    dash: { grip: [0.2, -0.2, -0.3], rotation: [0.92, 0.3, 0.85] },
    adsEye: 0.2, swayHz: 3.4, sway: 0.9, bob: 0.95,
    kick: { back: 3.0, up: 0.3, pitch: 2.8, roll: 3.2, yaw: 1.1, hz: 9, damping: 0.45, adsRotation: 0.35, adsBack: 0.75 },
    pivot: [0, 0.02, 0.13], reload: 'smg', action: 'charge', shell: 'pistol', actionTravel: 0.06, flash: 0.8, cycleDelay: 0,
  },
  breaker12: {
    hip: { grip: [0.15, -0.18, -0.42], rotation: [0.1, 0.035, 0.04] },
    sprint: { grip: [0.2, -0.25, -0.39], rotation: [-0.55, 0.55, -0.45] },
    dash: { grip: [0.21, -0.21, -0.33], rotation: [0.92, 0.3, 0.85] },
    adsEye: 0.23, swayHz: 2.6, sway: 1.15, bob: 1.05,
    kick: { back: 3.0, up: 0.6, pitch: 4.5, roll: 2.0, yaw: 1.0, hz: 5, damping: 0.5, adsRotation: 0.45, adsBack: 0.8 },
    pivot: [0, 0.02, 0.2], reload: 'shotgun', action: 'pump', shell: 'hull', actionTravel: 0.085, flash: 1.45, cycleDelay: 0.12,
  },
  longbow: {
    hip: { grip: [0.155, -0.185, -0.43], rotation: [0.1, 0.035, 0.04] },
    sprint: { grip: [0.2, -0.255, -0.4], rotation: [-0.55, 0.55, -0.45] },
    dash: { grip: [0.21, -0.22, -0.34], rotation: [0.92, 0.3, 0.85] },
    adsEye: 0.075, swayHz: 2.4, sway: 1.25, bob: 1.1,
    kick: { back: 3.0, up: 0.5, pitch: 4.5, roll: 1.2, yaw: 0.6, hz: 4.5, damping: 0.55, adsRotation: 0.5, adsBack: 0.8 },
    pivot: [0, 0.02, 0.22], reload: 'bolt', action: 'bolt', shell: 'rifle', actionTravel: 0.09, flash: 1.25, cycleDelay: 0.28,
  },
  sentry9: {
    hip: { grip: [0.11, -0.14, -0.38], rotation: [0.04, 0.07, 0.02] },
    sprint: { grip: [0.1, -0.2, -0.3], rotation: [-0.68, 0.3, 0.2] },
    dash: { grip: [0.16, -0.14, -0.34], rotation: [1.05, 0.2, -0.3] },
    adsEye: 0.32, swayHz: 3.8, sway: 0.75, bob: 0.8,
    kick: { back: 2.6, up: 0.4, pitch: 6.0, roll: 1.2, yaw: 0.6, hz: 8, damping: 0.45, adsRotation: 0.4, adsBack: 0.75 },
    pivot: [0, -0.03, 0.05], reload: 'pistol', action: 'slide', shell: 'pistol', actionTravel: 0.028, flash: 0.75, cycleDelay: 0,
  },
};
