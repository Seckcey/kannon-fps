/** Frame-rate independent motion helpers for the first-person viewmodel.
 *
 * Every spring uses the exact solution of a damped harmonic oscillator, so a 30 fps phone and a
 * 144 fps desktop see the same motion and a long frame never explodes. */

export interface SpringState { value: number; velocity: number }

/** Advance `state` toward `target` for `dt` seconds. `frequency` is the natural frequency in hertz,
 * `damping` the damping ratio (1 = critically damped, below 1 overshoots). */
export function stepSpring(state: SpringState, target: number, frequency: number, damping: number, dt: number): void {
  if (!(dt > 0) || !Number.isFinite(dt)) return;
  if (!Number.isFinite(state.value) || !Number.isFinite(state.velocity)) { state.value = target; state.velocity = 0; return; }
  const omega = 2 * Math.PI * Math.max(1e-3, frequency);
  const zeta = Math.max(0, damping);
  const y0 = state.value - target, v0 = state.velocity;
  if (zeta < 0.9999) {
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-zeta * omega * dt);
    const cosine = Math.cos(wd * dt), sine = Math.sin(wd * dt);
    const b = (v0 + zeta * omega * y0) / wd;
    const shape = y0 * cosine + b * sine;
    state.value = target + decay * shape;
    state.velocity = decay * (wd * (b * cosine - y0 * sine) - zeta * omega * shape);
  } else if (zeta <= 1.0001) {
    const decay = Math.exp(-omega * dt);
    const b = v0 + omega * y0;
    state.value = target + decay * (y0 + b * dt);
    state.velocity = decay * (v0 - omega * b * dt);
  } else {
    const root = Math.sqrt(zeta * zeta - 1);
    const r1 = -omega * (zeta - root), r2 = -omega * (zeta + root);
    const c2 = (v0 - r1 * y0) / (r2 - r1), c1 = y0 - c2;
    const e1 = Math.exp(r1 * dt), e2 = Math.exp(r2 * dt);
    state.value = target + c1 * e1 + c2 * e2;
    state.velocity = c1 * r1 * e1 + c2 * r2 * e2;
  }
  // Settle exactly instead of creeping forever in denormal range.
  if (Math.abs(state.value - target) < 1e-9 && Math.abs(state.velocity) < 1e-8) { state.value = target; state.velocity = 0; }
}

/** A scalar spring with its own tuning. */
export class Spring implements SpringState {
  value: number;
  velocity = 0;
  constructor(public frequency: number, public damping: number, initial = 0) { this.value = initial; }
  update(target: number, dt: number): number { stepSpring(this, target, this.frequency, this.damping, dt); return this.value; }
  /** Add velocity (units per second), the way a shot or a landing shoves the weapon. */
  impulse(velocity: number): void { if (Number.isFinite(velocity)) this.velocity += velocity; }
  reset(value = 0): void { this.value = value; this.velocity = 0; }
}

/** Six springs for a translation (metres) and a rotation (radians: pitch, yaw, roll). */
export class PoseSpring {
  readonly x: Spring; readonly y: Spring; readonly z: Spring;
  readonly pitch: Spring; readonly yaw: Spring; readonly roll: Spring;
  /** Translation channels first, then rotation; built once so per-frame loops never allocate. */
  private readonly channels: readonly Spring[];
  constructor(frequency: number, damping: number, rotationFrequency = frequency, rotationDamping = damping) {
    this.x = new Spring(frequency, damping); this.y = new Spring(frequency, damping); this.z = new Spring(frequency, damping);
    this.pitch = new Spring(rotationFrequency, rotationDamping); this.yaw = new Spring(rotationFrequency, rotationDamping); this.roll = new Spring(rotationFrequency, rotationDamping);
    this.channels = [this.x, this.y, this.z, this.pitch, this.yaw, this.roll];
  }
  tune(frequency: number, damping: number, rotationFrequency = frequency, rotationDamping = damping): void {
    for (let i = 0; i < 6; i++) {
      const spring = this.channels[i]!;
      spring.frequency = i < 3 ? frequency : rotationFrequency;
      spring.damping = i < 3 ? damping : rotationDamping;
    }
  }
  /** Relax every channel toward zero. */
  settle(dt: number): void { for (let i = 0; i < 6; i++) this.channels[i]!.update(0, dt); }
  reset(): void { for (let i = 0; i < 6; i++) this.channels[i]!.reset(); }
  /** Largest absolute offset across channels (metres and radians mixed; only for tests and idling). */
  magnitude(): number { let max = 0; for (let i = 0; i < 6; i++) max = Math.max(max, Math.abs(this.channels[i]!.value)); return max; }
}

export const clamp01 = (value: number) => value <= 0 ? 0 : value >= 1 ? 1 : value;
export const clamp = (value: number, min: number, max: number) => value <= min ? min : value >= max ? max : value;
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (t: number) => { const x = clamp01(t); return x * x * (3 - 2 * x); };
export const smootherstep = (t: number) => { const x = clamp01(t); return x * x * x * (x * (x * 6 - 15) + 10); };
export const easeInOutSine = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t));
export const easeOutCubic = (t: number) => { const x = 1 - clamp01(t); return 1 - x * x * x; };
export const easeInCubic = (t: number) => { const x = clamp01(t); return x * x * x; };
/** 0..1..0 bump over [start, end]. */
export const bump = (t: number, start: number, end: number) => t <= start || t >= end ? 0 : Math.sin(Math.PI * (t - start) / (end - start));
/** Fraction of the way through [start, end], clamped. */
export const window01 = (t: number, start: number, end: number) => clamp01((t - start) / Math.max(1e-6, end - start));
/** Exponential approach that is the same at every frame rate. */
export const approach = (current: number, target: number, rate: number, dt: number) => target + (current - target) * Math.exp(-Math.max(0, rate) * Math.max(0, dt));
export const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Small deterministic generator so tests and replays see the same shell spin and flash shape. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
