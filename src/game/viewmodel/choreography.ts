import type { ReloadStyle } from './handling';
import { clamp01, smoothstep } from './spring';

/** Keyframes flattened as [time, value, time, value, ...], times ascending. */
export type Track = readonly number[];

/** Shape-preserving cubic through the keys: smooth like a spline, never overshooting a key, flat at
 * both ends so every move starts and finishes at rest. */
export function sampleTrack(track: Track | undefined, t: number): number {
  if (!track || track.length < 2) return 0;
  const n = track.length >> 1;
  if (n === 1 || t <= track[0]!) return track[1]!;
  const last = (n - 1) * 2;
  if (t >= track[last]!) return track[last + 1]!;
  let i = 0;
  while (i < n - 2 && t > track[(i + 1) * 2]!) i++;
  const t0 = track[i * 2]!, v0 = track[i * 2 + 1]!, t1 = track[i * 2 + 2]!, v1 = track[i * 2 + 3]!;
  const h = t1 - t0;
  if (!(h > 0)) return v1;
  const m0 = tangent(track, i, n), m1 = tangent(track, i + 1, n);
  const s = (t - t0) / h, s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * v0 + (s3 - 2 * s2 + s) * h * m0 + (-2 * s3 + 3 * s2) * v1 + (s3 - s2) * h * m1;
}

function tangent(track: Track, i: number, n: number): number {
  if (i <= 0 || i >= n - 1) return 0;
  const tp = track[(i - 1) * 2]!, vp = track[(i - 1) * 2 + 1]!;
  const tc = track[i * 2]!, vc = track[i * 2 + 1]!;
  const tn = track[(i + 1) * 2]!, vn = track[(i + 1) * 2 + 1]!;
  const before = (vc - vp) / Math.max(1e-6, tc - tp), after = (vn - vc) / Math.max(1e-6, tn - tc);
  if (before * after <= 0) return 0;
  // Harmonic mean keeps the curve monotone between keys.
  return 2 * before * after / (before + after);
}

/** Where a hand is heading. `grip` is the weapon's own grip anchor for that hand. */
export type HandTarget = 'grip' | 'mag' | 'action' | 'pouch' | 'load';
export interface HandKey { readonly t: number; readonly target: HandTarget }
export type ChoreoEventKind = 'magOut' | 'magDrop' | 'magIn' | 'ready' | 'charge' | 'boltOpen' | 'boltClose' | 'shellIn';
export interface ChoreoEvent { readonly t: number; readonly kind: ChoreoEventKind }

export interface Choreography {
  /** Weapon offset in camera space: metres and radians (pitch, yaw, roll). */
  px?: Track; py?: Track; pz?: Track; rx?: Track; ry?: Track; rz?: Track;
  /** Magazine offset in weapon space (metres, radians about X) and the spans it is hidden (off screen or dropped). */
  magY?: Track; magZ?: Track; magRx?: Track; magHidden?: ReadonlyArray<readonly [number, number]>;
  /** Moving part travel 0..1 (charging handle, slide, pump, bolt pull) and bolt lift 0..1. */
  act?: Track; lift?: Track;
  left?: readonly HandKey[]; right?: readonly HandKey[];
  events?: readonly ChoreoEvent[];
}

export interface HandBlend { from: HandTarget; to: HandTarget; mix: number }
export interface ChoreoSample {
  px: number; py: number; pz: number; rx: number; ry: number; rz: number;
  magY: number; magZ: number; magRx: number; magVisible: boolean;
  act: number; lift: number;
  left: HandBlend; right: HandBlend;
}
export const emptySample = (): ChoreoSample => ({
  px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, magY: 0, magZ: 0, magRx: 0, magVisible: true, act: 0, lift: 0,
  left: { from: 'grip', to: 'grip', mix: 0 }, right: { from: 'grip', to: 'grip', mix: 0 },
});

function sampleHand(keys: readonly HandKey[] | undefined, t: number, out: HandBlend): void {
  if (!keys || !keys.length) { out.from = 'grip'; out.to = 'grip'; out.mix = 0; return; }
  if (t <= keys[0]!.t) { out.from = out.to = keys[0]!.target; out.mix = 0; return; }
  const last = keys[keys.length - 1]!;
  if (t >= last.t) { out.from = out.to = last.target; out.mix = 0; return; }
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1]!.t) i++;
  const a = keys[i]!, b = keys[i + 1]!;
  out.from = a.target; out.to = b.target;
  out.mix = a.target === b.target ? 0 : smoothstep((t - a.t) / Math.max(1e-6, b.t - a.t));
}

/** Sample a choreography at normalized time `t` (0..1). */
export function sampleChoreography(choreo: Choreography, t: number, out: ChoreoSample): ChoreoSample {
  out.px = sampleTrack(choreo.px, t); out.py = sampleTrack(choreo.py, t); out.pz = sampleTrack(choreo.pz, t);
  out.rx = sampleTrack(choreo.rx, t); out.ry = sampleTrack(choreo.ry, t); out.rz = sampleTrack(choreo.rz, t);
  out.magY = sampleTrack(choreo.magY, t); out.magZ = sampleTrack(choreo.magZ, t); out.magRx = sampleTrack(choreo.magRx, t);
  out.magVisible = !choreo.magHidden?.some(([start, end]) => t >= start && t < end);
  out.act = clamp01(sampleTrack(choreo.act, t)); out.lift = clamp01(sampleTrack(choreo.lift, t));
  sampleHand(choreo.left, t, out.left); sampleHand(choreo.right, t, out.right);
  return out;
}

/** Events crossed while time moved from `previous` (exclusive) to `current` (inclusive). */
export function crossedEvents(choreo: Choreography, previous: number, current: number, visit: (kind: ChoreoEventKind) => void): void {
  if (!choreo.events || !(current > previous)) return;
  for (const event of choreo.events) if (event.t > previous && event.t <= current) visit(event.kind);
}

// Reload timelines. The game plays reload sounds at 25%, 60% and 85%, so the magazine leaves at
// 0.25, seats at 0.60 and the final action (bolt, charging handle, slide) lands at 0.85.
const tiltIn = 0.12, tiltOut = 0.84;
const RIFLE: Choreography = {
  px: [0, 0, tiltIn, -0.04, tiltOut, -0.04, 1, 0],
  py: [0, 0, tiltIn, 0.028, 0.585, 0.022, 0.61, 0.036, 0.66, 0.027, tiltOut, 0.028, 1, 0],
  pz: [0, 0, tiltIn, 0.035, tiltOut, 0.035, 1, 0],
  rx: [0, 0, tiltIn, 0.12, 0.3, 0.1, 0.585, 0.135, tiltOut, 0.12, 1, 0],
  ry: [0, 0, tiltIn, 0.12, tiltOut, 0.12, 1, 0],
  rz: [0, 0, tiltIn, -0.46, 0.34, -0.42, 0.6, -0.5, tiltOut, -0.44, 1, 0],
  magY: [0, 0, 0.25, 0, 0.33, -0.07, 0.43, -0.34, 0.52, -0.34, 0.585, -0.06, 0.6, 0, 1, 0],
  magZ: [0, 0, 0.25, 0, 0.33, 0.008, 0.43, 0.03, 0.52, 0.03, 0.585, 0.005, 0.6, 0, 1, 0],
  magRx: [0, 0, 0.25, 0, 0.4, 0.25, 0.52, 0.25, 0.585, 0.04, 0.6, 0, 1, 0],
  magHidden: [[0.44, 0.52]],
  left: [{ t: 0, target: 'grip' }, { t: 0.14, target: 'grip' }, { t: 0.24, target: 'mag' }, { t: 0.42, target: 'mag' }, { t: 0.47, target: 'pouch' },
    { t: 0.5, target: 'pouch' }, { t: 0.535, target: 'mag' }, { t: 0.66, target: 'mag' }, { t: 0.8, target: 'grip' }],
  events: [{ t: 0.25, kind: 'magOut' }, { t: 0.6, kind: 'magIn' }, { t: 0.85, kind: 'ready' }],
};
const RIFLE_EMPTY: Choreography = {
  px: [0, 0, 0.1, -0.04, 0.88, -0.035, 1, 0],
  py: [0, 0, 0.1, 0.028, 0.585, 0.022, 0.61, 0.036, 0.66, 0.027, 0.88, 0.028, 1, 0],
  pz: [0, 0, 0.1, 0.035, 0.88, 0.035, 1, 0],
  rx: [0, 0, 0.1, 0.12, 0.62, 0.13, 0.7, 0.06, 0.84, 0.06, 0.9, 0.1, 1, 0],
  ry: [0, 0, 0.1, 0.12, 0.62, 0.12, 0.7, 0.05, 0.84, 0.05, 0.9, 0.1, 1, 0],
  rz: [0, 0, 0.1, -0.46, 0.5, -0.48, 0.62, -0.44, 0.7, -0.14, 0.86, -0.14, 0.9, -0.3, 1, 0],
  magY: [0, 0, 0.25, 0, 0.255, -0.34, 0.42, -0.34, 0.56, -0.06, 0.6, 0, 1, 0],
  magZ: [0, 0, 0.25, 0, 0.255, 0.03, 0.42, 0.03, 0.56, 0.005, 0.6, 0, 1, 0],
  magRx: [0, 0, 0.25, 0, 0.255, 0.25, 0.42, 0.25, 0.56, 0.04, 0.6, 0, 1, 0],
  magHidden: [[0.25, 0.42]],
  act: [0, 0, 0.76, 0, 0.81, 1, 0.835, 1, 0.85, 0, 1, 0],
  left: [{ t: 0, target: 'grip' }, { t: 0.1, target: 'grip' }, { t: 0.3, target: 'pouch' }, { t: 0.38, target: 'pouch' }, { t: 0.43, target: 'mag' },
    { t: 0.64, target: 'mag' }, { t: 0.74, target: 'action' }, { t: 0.855, target: 'action' }, { t: 0.95, target: 'grip' }],
  events: [{ t: 0.25, kind: 'magDrop' }, { t: 0.6, kind: 'magIn' }, { t: 0.85, kind: 'charge' }],
};
/** SMG magazines are straight, so they come out without the rifle's forward rock. */
const SMG: Choreography = { ...RIFLE, magRx: [0, 0, 0.25, 0, 0.4, 0.08, 0.52, 0.08, 0.585, 0.01, 0.6, 0, 1, 0], magZ: undefined };
const SMG_EMPTY: Choreography = { ...RIFLE_EMPTY, magRx: [0, 0, 0.25, 0, 0.255, 0.08, 0.42, 0.08, 0.56, 0.01, 0.6, 0, 1, 0], magZ: undefined };

const PISTOL: Choreography = {
  px: [0, 0, 0.14, -0.025, tiltOut, -0.025, 1, 0],
  py: [0, 0, 0.14, 0.025, 0.585, 0.02, 0.61, 0.034, 0.66, 0.025, tiltOut, 0.025, 1, 0],
  pz: [0, 0, 0.14, 0.06, tiltOut, 0.06, 1, 0],
  rx: [0, 0, 0.14, 0.24, 0.585, 0.24, 0.61, 0.2, tiltOut, 0.22, 1, 0],
  ry: [0, 0, 0.14, 0.18, tiltOut, 0.18, 1, 0],
  rz: [0, 0, 0.14, 0.3, tiltOut, 0.3, 1, 0],
  magY: [0, 0, 0.25, 0, 0.255, -0.3, 0.45, -0.3, 0.57, -0.05, 0.6, 0, 1, 0],
  magHidden: [[0.25, 0.45]],
  left: [{ t: 0, target: 'grip' }, { t: 0.12, target: 'grip' }, { t: 0.32, target: 'pouch' }, { t: 0.4, target: 'pouch' }, { t: 0.47, target: 'mag' },
    { t: 0.66, target: 'mag' }, { t: 0.8, target: 'grip' }],
  events: [{ t: 0.25, kind: 'magDrop' }, { t: 0.6, kind: 'magIn' }, { t: 0.85, kind: 'ready' }],
};
const PISTOL_EMPTY: Choreography = {
  ...PISTOL,
  act: [0, 1, 0.82, 1, 0.85, 0, 1, 0],
  rz: [0, 0, 0.14, 0.3, 0.66, 0.3, 0.74, 0.12, 0.88, 0.12, 1, 0],
  left: [{ t: 0, target: 'grip' }, { t: 0.12, target: 'grip' }, { t: 0.32, target: 'pouch' }, { t: 0.4, target: 'pouch' }, { t: 0.47, target: 'mag' },
    { t: 0.64, target: 'mag' }, { t: 0.76, target: 'action' }, { t: 0.855, target: 'action' }, { t: 0.95, target: 'grip' }],
  events: [{ t: 0.25, kind: 'magDrop' }, { t: 0.6, kind: 'magIn' }, { t: 0.85, kind: 'charge' }],
};

const BOLT: Choreography = {
  px: [0, 0, 0.1, -0.03, 0.88, -0.03, 1, 0],
  py: [0, 0, 0.1, 0.02, 0.585, 0.016, 0.61, 0.03, 0.66, 0.02, 0.88, 0.02, 1, 0],
  pz: [0, 0, 0.1, 0.03, 0.88, 0.03, 1, 0],
  rx: [0, 0, 0.1, 0.08, 0.88, 0.08, 1, 0],
  ry: [0, 0, 0.1, 0.06, 0.88, 0.06, 1, 0],
  rz: [0, 0, 0.1, -0.3, 0.3, -0.24, 0.6, -0.36, 0.76, -0.24, 0.88, -0.28, 1, 0],
  lift: [0, 0, 0.15, 0, 0.2, 1, 0.81, 1, 0.85, 0, 1, 0],
  act: [0, 0, 0.2, 0, 0.25, 1, 0.77, 1, 0.81, 0, 1, 0],
  magY: [0, 0, 0.34, 0, 0.4, -0.07, 0.46, -0.34, 0.52, -0.34, 0.585, -0.06, 0.6, 0, 1, 0],
  magHidden: [[0.465, 0.52]],
  right: [{ t: 0, target: 'grip' }, { t: 0.08, target: 'grip' }, { t: 0.15, target: 'action' }, { t: 0.27, target: 'action' }, { t: 0.37, target: 'grip' },
    { t: 0.68, target: 'grip' }, { t: 0.76, target: 'action' }, { t: 0.86, target: 'action' }, { t: 0.95, target: 'grip' }],
  left: [{ t: 0, target: 'grip' }, { t: 0.26, target: 'grip' }, { t: 0.34, target: 'mag' }, { t: 0.45, target: 'mag' }, { t: 0.49, target: 'pouch' },
    { t: 0.5, target: 'pouch' }, { t: 0.535, target: 'mag' }, { t: 0.63, target: 'mag' }, { t: 0.74, target: 'grip' }],
  events: [{ t: 0.25, kind: 'boltOpen' }, { t: 0.6, kind: 'magIn' }, { t: 0.85, kind: 'boltClose' }],
};

export function reloadChoreography(style: ReloadStyle, empty: boolean): Choreography {
  switch (style) {
    case 'rifle': return empty ? RIFLE_EMPTY : RIFLE;
    case 'smg': return empty ? SMG_EMPTY : SMG;
    case 'pistol': return empty ? PISTOL_EMPTY : PISTOL;
    case 'bolt': return BOLT;
    case 'shotgun': return SHOTGUN_ENTER;
  }
}

/** The shotgun loads one shell at a time: hold a tilted pose, and cycle the left hand between the
 * shell pouch and the loading port once per shell. */
export const SHOTGUN_ENTER: Choreography = {
  px: [0, -0.03], py: [0, 0.03], pz: [0, 0.035], rx: [0, 0.1], ry: [0, 0.08], rz: [0, -0.5],
};
export interface ShellCycleSample {
  /** Hand path: 0 = at the pouch (below the view), 1 = at the loading port. */
  reach: number;
  /** The shell is in the hand. */
  shellInHand: boolean;
  /** Shell travel into the port, 0..1. */
  insert: number;
}
/** One shell insert, `u` 0..1. The shell seats at 0.7. */
export function shellCycle(u: number, out: ShellCycleSample): ShellCycleSample {
  const t = clamp01(u);
  out.reach = t < 0.3 ? 0 : t < 0.62 ? smoothstep((t - 0.3) / 0.32) : t < 0.76 ? 1 : 1 - smoothstep((t - 0.76) / 0.24);
  out.shellInHand = t >= 0.04 && t < 0.72;
  out.insert = t < 0.6 ? 0 : clamp01((t - 0.6) / 0.12);
  return out;
}
export const SHELL_SEAT = 0.7;

/** Pump and bolt cycles after a shot, in seconds from the start of the cycle. */
export const PUMP_CYCLE = { back: 0.13, hold: 0.02, forward: 0.13, eject: 0.12 } as const;
export const BOLT_CYCLE = { reach: 0.08, lift: 0.08, pull: 0.12, push: 0.12, lower: 0.08, release: 0.1, eject: 0.26 } as const;
export function pumpTravel(seconds: number): number {
  const { back, hold, forward } = PUMP_CYCLE;
  if (seconds <= 0) return 0;
  if (seconds < back) return smoothstep(seconds / back);
  if (seconds < back + hold) return 1;
  if (seconds < back + hold + forward) return 1 - smoothstep((seconds - back - hold) / forward);
  return 0;
}
export const pumpDuration = () => PUMP_CYCLE.back + PUMP_CYCLE.hold + PUMP_CYCLE.forward;
export interface BoltCycleSample { act: number; lift: number; hand: number }
export function boltCycle(seconds: number, out: BoltCycleSample): BoltCycleSample {
  const { reach, lift, pull, push, lower, release } = BOLT_CYCLE;
  let t = seconds;
  out.act = 0; out.lift = 0; out.hand = 0;
  if (t <= 0) return out;
  if (t < reach) { out.hand = smoothstep(t / reach); return out; }
  out.hand = 1; t -= reach;
  if (t < lift) { out.lift = smoothstep(t / lift); return out; }
  out.lift = 1; t -= lift;
  if (t < pull) { out.act = smoothstep(t / pull); return out; }
  t -= pull;
  if (t < push) { out.act = 1 - smoothstep(t / push); return out; }
  t -= push;
  if (t < lower) { out.lift = 1 - smoothstep(t / lower); return out; }
  out.lift = 0; t -= lower;
  out.hand = 1 - smoothstep(t / release);
  return out;
}
export const boltDuration = () => BOLT_CYCLE.reach + BOLT_CYCLE.lift + BOLT_CYCLE.pull + BOLT_CYCLE.push + BOLT_CYCLE.lower + BOLT_CYCLE.release;

/** Timed moves that take the left hand off the weapon. Hand tracks are camera-space points (metres)
 * with a weight (0 = on the grip) and a camera-space hand rotation (radians). */
export interface HandMove extends Choreography {
  duration: number;
  hx: Track; hy: Track; hz: Track; hw: Track;
  hrx?: Track; hry?: Track; hrz?: Track;
}

/** Quick knife: the gun drops right while the left hand slashes across from the upper left. */
export const KNIFE_MOVE: HandMove = {
  duration: 0.6,
  px: [0, 0, 0.12, 0.07, 0.55, 0.07, 0.85, 0], py: [0, 0, 0.12, -0.11, 0.55, -0.11, 0.85, 0], pz: [0, 0, 0.12, 0.05, 0.55, 0.05, 0.85, 0],
  rx: [0, 0, 0.12, -0.45, 0.55, -0.45, 0.85, 0], ry: [0, 0, 0.12, -0.25, 0.55, -0.25, 0.85, 0], rz: [0, 0, 0.12, -0.45, 0.55, -0.45, 0.85, 0],
  hx: [0, -0.18, 0.15, -0.2, 0.28, -0.03, 0.4, 0.12, 0.6, 0.2, 0.8, 0.05],
  hy: [0, -0.36, 0.15, -0.01, 0.28, -0.07, 0.4, -0.16, 0.6, -0.36, 0.8, -0.6],
  hz: [0, -0.3, 0.15, -0.34, 0.28, -0.46, 0.4, -0.44, 0.6, -0.38, 0.8, -0.3],
  hw: [0, 0, 0.08, 1, 0.6, 1, 0.85, 0],
  hrx: [0, 0.6, 0.15, 1.1, 0.28, 0.7, 0.4, 0.2, 0.6, -0.3],
  hry: [0, -0.1, 0.15, -0.35, 0.28, -0.6, 0.4, -0.9, 0.6, -1.0],
  hrz: [0, 1.2, 0.15, 1.57, 0.28, 1.3, 0.4, 1.0, 0.6, 0.8],
};

/** Grenade throw from the cooking pose: wind back, throw forward and up, follow through. */
export const THROW_MOVE: HandMove = {
  duration: 0.5,
  px: [0, 0.05, 0.6, 0.05, 1, 0], py: [0, -0.12, 0.6, -0.12, 1, 0], pz: [0, 0.04, 0.6, 0.04, 1, 0],
  rx: [0, -0.35, 0.6, -0.35, 1, 0], ry: [0, -0.15, 0.6, -0.15, 1, 0], rz: [0, -0.35, 0.6, -0.35, 1, 0],
  hx: [0, -0.16, 0.2, -0.16, 0.42, -0.08, 0.65, 0.04, 0.9, 0.0],
  hy: [0, -0.1, 0.2, -0.03, 0.42, -0.02, 0.65, -0.38, 0.9, -0.6],
  hz: [0, -0.37, 0.2, -0.27, 0.42, -0.43, 0.65, -0.42, 0.9, -0.35],
  hw: [0, 1, 0.75, 1, 1, 0],
  hrx: [0, 0.25, 0.2, 0.7, 0.42, -0.3, 0.65, -0.9],
  hry: [0, 0.3, 0.42, 0.1],
  hrz: [0, 0.3, 0.42, -0.1],
};
/** Hand held up with the cooking grenade; the gun is lowered to the right. */
export const COOK_POSE = { px: 0.05, py: -0.12, pz: 0.04, rx: -0.35, ry: -0.15, rz: -0.35, hx: -0.16, hy: -0.1, hz: -0.37, hrx: 0.25, hry: 0.3, hrz: 0.3 } as const;
/** The grenade leaves the hand here (THROW_MOVE time). */
export const THROW_RELEASE = 0.4;

/** Vault: the left hand plants on the ledge while the weapon tucks in. */
export const VAULT_MOVE: HandMove = {
  duration: 0.5,
  px: [0, 0, 0.2, -0.01, 0.45, -0.01, 0.8, 0], py: [0, 0, 0.2, -0.04, 0.45, -0.04, 0.8, 0], pz: [0, 0, 0.2, 0.05, 0.45, 0.05, 0.8, 0],
  rx: [0, 0, 0.2, -0.15, 0.45, -0.15, 0.8, 0], ry: [0, 0, 0.2, 0.08, 0.45, 0.08, 0.8, 0], rz: [0, 0, 0.2, 0.32, 0.45, 0.32, 0.8, 0],
  hx: [0, -0.15, 0.2, -0.2, 0.6, -0.2], hy: [0, -0.3, 0.2, -0.55, 0.6, -0.55], hz: [0, -0.5, 0.2, -0.45, 0.6, -0.45],
  hw: [0, 0, 0.15, 1, 0.55, 1, 0.85, 0],
};
