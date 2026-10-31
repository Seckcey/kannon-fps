import { Biquad } from './dsp';

/** Measurements used by the tests (and handy when tuning) to check the sound design by numbers:
 * where the energy sits, how long a sound rings and how alike two sounds are. Not used at runtime. */

export function energyOf(buffer: Float32Array, from = 0, to = buffer.length): number {
  let sum = 0;
  for (let i = Math.max(0, from); i < Math.min(buffer.length, to); i++) sum += buffer[i] * buffer[i];
  return sum;
}

/** Energy between `low` and `high` Hz (4th-order band edges). */
export function bandEnergy(buffer: Float32Array, sampleRate: number, low: number, high: number): number {
  const copy = buffer.slice();
  if (low > 0) for (let i = 0; i < 2; i++) new Biquad('highpass', sampleRate, low).run(copy);
  if (high < sampleRate / 2) for (let i = 0; i < 2; i++) new Biquad('lowpass', sampleRate, high).run(copy);
  return energyOf(copy);
}

export const OCTAVE_CENTRES = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
export function octaveProfile(buffer: Float32Array, sampleRate: number): number[] {
  return OCTAVE_CENTRES.map(centre => bandEnergy(buffer, sampleRate, centre / Math.SQRT2, centre * Math.SQRT2));
}

/** Energy-weighted geometric mean frequency: lower means darker and heavier. */
export function logCentroid(buffer: Float32Array, sampleRate: number): number {
  const profile = octaveProfile(buffer, sampleRate), total = profile.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;
  return Math.exp(profile.reduce((sum, value, i) => sum + value * Math.log(OCTAVE_CENTRES[i]), 0) / total);
}

/** Share of the energy below `cutoff` Hz. */
export function lowShare(buffer: Float32Array, sampleRate: number, cutoff = 200): number {
  const total = energyOf(buffer);
  return total > 0 ? bandEnergy(buffer, sampleRate, 0, cutoff) / total : 0;
}

/** RMS of consecutive windows. */
export function envelopeOf(buffer: Float32Array, sampleRate: number, window = 0.005): Float32Array {
  const size = Math.max(1, Math.round(window * sampleRate)), out = new Float32Array(Math.ceil(buffer.length / size));
  for (let w = 0; w < out.length; w++) out[w] = Math.sqrt(energyOf(buffer, w * size, (w + 1) * size) / size);
  return out;
}

/** Seconds until the sound last sits above `dropDb` below its loudest moment. */
export function decayTime(buffer: Float32Array, sampleRate: number, dropDb = 40, window = 0.005): number {
  const envelope = envelopeOf(buffer, sampleRate, window);
  let loudest = 0;
  for (const value of envelope) loudest = Math.max(loudest, value);
  const floor = loudest * Math.pow(10, -dropDb / 20);
  let last = 0;
  for (let i = 0; i < envelope.length; i++) if (envelope[i] >= floor) last = i;
  return (last + 1) * window;
}

/** Seconds from the start to the loudest sample. */
export function timeToPeak(buffer: Float32Array, sampleRate: number): number {
  let index = 0, peak = 0;
  for (let i = 0; i < buffer.length; i++) { const v = Math.abs(buffer[i]); if (v > peak) { peak = v; index = i; } }
  return index / sampleRate;
}

/** Pearson correlation over the shared length. */
export function correlation(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}
