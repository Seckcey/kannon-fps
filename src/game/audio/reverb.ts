import { between, Biquad, filterChain, type Rng } from './dsp';

/** Generated impulse responses for the two acoustic spaces of Kannon Town.
 *
 * Room: the wooden houses. Dense early reflections from walls 1.5–4 m away (3–28 ms), then a diffuse
 * tail whose highs die first (frequency-dependent decay) with a little low-mid warmth from the boards.
 *
 * Street: open air between two rows of houses about 20 m apart. Almost nothing for the first 40 ms,
 * then discrete slapback echoes — the near house front (~48 ms), the far side (~105–120 ms), the far
 * houses and yards (175–540 ms) — each later one quieter and darker, alternating sides for width, over
 * a low rolling tail. Shots outdoors get their "crack…crack-crack" from this.
 *
 * Both are stereo with independent noise per side, and normalised to unit energy per channel so the
 * send level alone sets how wet a sound is. Lengths are short on phones to keep convolution cheap. */
export interface ImpulseResponse { left: Float32Array; right: Float32Array }
export const REVERB_SECONDS = { phone: { room: 0.4, street: 0.75 }, desktop: { room: 0.75, street: 1.6 } } as const;

function unitEnergy(ir: Float32Array): Float32Array {
  let energy = 0;
  for (let i = 0; i < ir.length; i++) energy += ir[i] * ir[i];
  if (energy > 0) { const k = 1 / Math.sqrt(energy); for (let i = 0; i < ir.length; i++) ir[i] *= k; }
  return ir;
}

/** Exponentially decaying noise whose one-pole low-pass closes from `brightHz` to `darkHz` over the
 * tail, starting at `onset` and faded in until `full`. */
function diffuseTail(ir: Float32Array, sampleRate: number, rng: Rng, options: { onset: number; full: number; rt60: number; brightHz: number; darkHz: number; gain: number; roll?: { rate: number; depth: number } }) {
  const n = ir.length, start = Math.round(options.onset * sampleRate), full = Math.max(start + 1, Math.round(options.full * sampleRate));
  const decay = Math.exp(-6.91 / Math.max(1, options.rt60 * sampleRate));
  let envelope = options.gain, lp = 0, roll = 0;
  const rollC = options.roll ? Math.exp(-2 * Math.PI * options.roll.rate / sampleRate) : 0;
  const rollUnit = options.roll ? Math.sqrt(3) / Math.sqrt((1 - rollC) / (1 + rollC)) : 0;
  let coefficient = 0;
  for (let i = start; i < n; i++) {
    if (((i - start) & 63) === 0) {
      const u = (i - start) / Math.max(1, n - start);
      const cutoff = options.brightHz * Math.pow(options.darkHz / options.brightHz, u);
      coefficient = Math.exp(-2 * Math.PI * cutoff / sampleRate);
    }
    lp = coefficient * lp + (1 - coefficient) * (rng() * 2 - 1);
    let gain = envelope * Math.min(1, (i - start) / (full - start));
    if (options.roll) { roll = rollC * roll + (1 - rollC) * (rng() * 2 - 1); gain *= Math.max(0, 1 + options.roll.depth * roll * rollUnit * 0.6); }
    ir[i] += lp * gain;
    envelope *= decay;
  }
}

/** A short smeared reflection (a burst of a few milliseconds), filtered darker for later echoes. */
function reflection(ir: Float32Array, sampleRate: number, rng: Rng, at: number, gain: number, length: number, cutoff: number) {
  const start = Math.round(at * sampleRate), n = Math.min(ir.length - start, Math.max(2, Math.round(length * sampleRate)));
  if (n <= 0) return;
  const burst = new Float32Array(n), tau = Math.max(1, n / 4);
  for (let i = 0; i < n; i++) burst[i] = (rng() * 2 - 1) * Math.exp(-i / tau);
  new Biquad('lowpass', sampleRate, cutoff, 0.7).run(burst);
  new Biquad('highpass', sampleRate, 150, 0.7).run(burst);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(burst[i]));
  const k = peak > 0 ? gain / peak : 0;
  for (let i = 0; i < n; i++) ir[start + i] += burst[i] * k;
}

export function roomImpulse(sampleRate: number, seconds: number, rng: Rng): ImpulseResponse {
  const make = () => {
    const ir = new Float32Array(Math.max(1, Math.ceil(seconds * sampleRate)));
    for (let k = 0; k < 12; k++) {
      const at = 0.0025 + 0.0255 * Math.pow(k / 11, 1.3) * between(rng, 0.85, 1.15);
      const sign = rng() < 0.5 ? -1 : 1;
      reflection(ir, sampleRate, rng, at, sign * 0.55 * Math.pow(0.82, k) * between(rng, 0.6, 1), 0.0006, 5200 - k * 250);
    }
    diffuseTail(ir, sampleRate, rng, { onset: 0.008, full: 0.025, rt60: seconds * 0.85, brightHz: 4800, darkHz: 1300, gain: 0.32 });
    filterChain(ir, sampleRate, [['highpass', 90], ['peaking', 250, 0.9, 3]]);
    return unitEnergy(ir);
  };
  return { left: make(), right: make() };
}

/** Echo times (seconds) and per-side levels: [time, left, right, cutoff Hz]. */
const SLAPS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.048, 0.9, 0.55, 6500], [0.061, 0.5, 0.85, 6000], [0.104, 0.6, 0.75, 4200], [0.118, 0.45, 0.4, 4000],
  [0.176, 0.42, 0.5, 3000], [0.262, 0.3, 0.26, 2200], [0.39, 0.2, 0.22, 1600], [0.54, 0.12, 0.1, 1200],
];
export function streetImpulse(sampleRate: number, seconds: number, rng: Rng): ImpulseResponse {
  const make = (side: 1 | 2) => {
    const ir = new Float32Array(Math.max(1, Math.ceil(seconds * sampleRate)));
    SLAPS.forEach(([at, left, right, cutoff], index) => {
      if (at >= seconds) return;
      const time = at * between(rng, 0.94, 1.06);
      reflection(ir, sampleRate, rng, time, (side === 1 ? left : right) * (rng() < 0.5 ? -1 : 1), 0.004 + 0.002 * index, cutoff);
    });
    diffuseTail(ir, sampleRate, rng, { onset: 0.03, full: 0.09, rt60: seconds * 0.9, brightHz: 3500, darkHz: 450, gain: 0.45, roll: { rate: 3.5, depth: 0.3 } });
    filterChain(ir, sampleRate, [['highpass', 70]]);
    return unitEnergy(ir);
  };
  return { left: make(1), right: make(2) };
}
