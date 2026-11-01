/** Offline synthesis primitives for the procedural sound bank.
 *
 * Every sound in the game is rendered once into a Float32Array with these helpers, cached as an
 * AudioBuffer and then only played back. That keeps the live audio graph tiny (a buffer source, a
 * gain, a filter and a panner per sound), behaves the same in every browser, and lets the sound
 * design be checked in Node: frequency content, decay and loudness are plain numbers here.
 * Times are seconds, frequencies hertz, gains linear. */

export type Rng = () => number;

/** Small fast seeded generator (mulberry32): the same seed always renders the same sound. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash, so every sound name and variant has its own stable seed. */
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return hash >>> 0;
}

/** A value scattered by up to ±`spread` (a fraction), for natural variation between variants. */
export const vary = (rng: Rng, value: number, spread: number) => value * (1 + (rng() * 2 - 1) * spread);
export const between = (rng: Rng, low: number, high: number) => low + (high - low) * rng();

export type FilterType = 'lowpass' | 'highpass' | 'bandpass' | 'peaking' | 'lowshelf' | 'highshelf';
/** `[type, frequency, Q, gain dB]`; Q defaults to a Butterworth 0.707. */
export type FilterSpec = readonly [type: FilterType, frequency: number, q?: number, gainDb?: number];

/** RBJ cookbook biquad in transposed direct form II. Band-pass has 0 dB peak gain. */
export class Biquad {
  private b0 = 1; private b1 = 0; private b2 = 0; private a1 = 0; private a2 = 0;
  private z1 = 0; private z2 = 0;
  constructor(readonly type: FilterType, private readonly sampleRate: number, frequency: number, q = Math.SQRT1_2, gainDb = 0) {
    this.tune(frequency, q, gainDb);
  }
  /** Retunes without clearing state, so swept filters stay smooth. */
  tune(frequency: number, q = Math.SQRT1_2, gainDb = 0) {
    const f = Math.min(Math.max(frequency, 5), this.sampleRate * 0.47);
    const w = 2 * Math.PI * f / this.sampleRate, cos = Math.cos(w), sin = Math.sin(w);
    const alpha = sin / (2 * Math.max(q, 1e-3)), a = Math.pow(10, gainDb / 40);
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    switch (this.type) {
      case 'lowpass': b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
      case 'highpass': b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
      case 'bandpass': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
      case 'peaking': b0 = 1 + alpha * a; b1 = -2 * cos; b2 = 1 - alpha * a; a0 = 1 + alpha / a; a1 = -2 * cos; a2 = 1 - alpha / a; break;
      case 'lowshelf': {
        const s = 2 * Math.sqrt(a) * alpha;
        b0 = a * ((a + 1) - (a - 1) * cos + s); b1 = 2 * a * ((a - 1) - (a + 1) * cos); b2 = a * ((a + 1) - (a - 1) * cos - s);
        a0 = (a + 1) + (a - 1) * cos + s; a1 = -2 * ((a - 1) + (a + 1) * cos); a2 = (a + 1) + (a - 1) * cos - s;
        break;
      }
      case 'highshelf': {
        const s = 2 * Math.sqrt(a) * alpha;
        b0 = a * ((a + 1) + (a - 1) * cos + s); b1 = -2 * a * ((a - 1) + (a + 1) * cos); b2 = a * ((a + 1) + (a - 1) * cos - s);
        a0 = (a + 1) - (a - 1) * cos + s; a1 = 2 * ((a - 1) - (a + 1) * cos); a2 = (a + 1) - (a - 1) * cos - s;
        break;
      }
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  /** Filters `buffer[from..to)` in place. */
  run(buffer: Float32Array, from = 0, to = buffer.length) {
    const { b0, b1, b2, a1, a2 } = this;
    let z1 = this.z1, z2 = this.z2;
    for (let i = from; i < to; i++) {
      const x = buffer[i], y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2; z2 = b2 * x - a2 * y;
      buffer[i] = y;
    }
    this.z1 = z1; this.z2 = z2;
  }
}

export function filterChain(buffer: Float32Array, sampleRate: number, specs: readonly FilterSpec[] = [], from = 0, to = buffer.length) {
  for (const [type, frequency, q, gain] of specs) new Biquad(type, sampleRate, frequency, q ?? Math.SQRT1_2, gain ?? 0).run(buffer, from, to);
}

export function peakOf(buffer: Float32Array, from = 0, to = buffer.length): number {
  let peak = 0;
  for (let i = from; i < to; i++) { const v = Math.abs(buffer[i]); if (v > peak) peak = v; }
  return peak;
}

/** Scales to an exact peak; silent buffers stay silent. */
export function normalize(buffer: Float32Array, peak: number): Float32Array {
  const current = peakOf(buffer);
  if (current > 1e-9) { const k = peak / current; for (let i = 0; i < buffer.length; i++) buffer[i] *= k; }
  return buffer;
}

/** Scales so the RMS of `buffer[0..seconds)` is `rms`: a level that does not depend on one lucky peak. */
export function normalizeRms(buffer: Float32Array, sampleRate: number, rms: number, seconds: number): Float32Array {
  const n = Math.min(buffer.length, Math.max(1, Math.round(seconds * sampleRate)));
  let energy = 0;
  for (let i = 0; i < n; i++) energy += buffer[i] * buffer[i];
  const current = Math.sqrt(energy / n);
  if (current > 1e-9) { const k = rms / current; for (let i = 0; i < buffer.length; i++) buffer[i] *= k; }
  return buffer;
}

/** Saturation with optional asymmetry. `bias` adds even harmonics (a fuller, warmer distortion);
 * the curve is normalised so a full-scale input still peaks at 1. Drive 0 leaves the signal alone. */
export function saturate(buffer: Float32Array, drive: number, bias = 0, from = 0, to = buffer.length) {
  if (!(drive > 0)) return;
  const offset = Math.tanh(drive * bias);
  const scale = 1 / Math.max(Math.tanh(drive * (1 + bias)) - offset, Math.abs(Math.tanh(drive * (bias - 1)) - offset), 1e-6);
  for (let i = from; i < to; i++) buffer[i] = (Math.tanh(drive * (buffer[i] + bias)) - offset) * scale;
}

/** Envelope shared by the layer helpers: a linear attack, an optional hold, then a fast exponential
 * decay plus an optional slower "bloom" decay. Peak level is 1. */
export interface Envelope { attack?: number; hold?: number; decay: number; bloom?: number; bloomDecay?: number }

/** Seconds until the envelope falls ~60 dB. */
export function envelopeLength(envelope: Envelope): number {
  const slow = Math.max(envelope.decay, envelope.bloom ? envelope.bloomDecay ?? envelope.decay * 3 : 0);
  return (envelope.attack ?? 0) + (envelope.hold ?? 0) + slow * 6.9;
}

function fillEnvelope(target: Float32Array, sampleRate: number, envelope: Envelope) {
  const attack = Math.max(0, Math.round((envelope.attack ?? 0) * sampleRate));
  const hold = Math.max(0, Math.round((envelope.hold ?? 0) * sampleRate));
  const bloom = envelope.bloom ?? 0;
  const fast = Math.exp(-1 / Math.max(1, envelope.decay * sampleRate));
  const slow = Math.exp(-1 / Math.max(1, (envelope.bloomDecay ?? envelope.decay * 3) * sampleRate));
  const norm = 1 / (1 + bloom);
  let a = 1, b = bloom;
  for (let i = 0; i < target.length; i++) {
    if (i < attack) target[i] = (i + 1) / attack;
    else if (i < attack + hold) target[i] = 1;
    else { target[i] = (a + b) * norm; a *= fast; b *= slow; }
  }
}

/** Slow random amplitude movement: grit for scrapes, irregular rustle for cloth, rolling for tails.
 * Returns factors around 1 with roughly `depth` spread. */
function flutterCurve(length: number, sampleRate: number, rng: Rng, rate: number, depth: number): Float32Array {
  const curve = new Float32Array(length);
  const c = Math.exp(-2 * Math.PI * rate / sampleRate);
  // White uniform noise has std 1/sqrt(3); a one-pole low-pass scales it by sqrt((1-c)/(1+c)).
  const unit = Math.sqrt(3) / Math.max(1e-6, Math.sqrt((1 - c) / (1 + c)));
  let m = 0;
  for (let i = 0; i < 64; i++) m = c * m + (1 - c) * (rng() * 2 - 1);
  for (let i = 0; i < length; i++) {
    m = c * m + (1 - c) * (rng() * 2 - 1);
    curve[i] = Math.max(0, 1 + depth * m * unit * 0.6);
  }
  return curve;
}

function addInto(out: Float32Array, layer: Float32Array, start: number, gain: number) {
  const n = Math.min(layer.length, out.length - start);
  for (let i = Math.max(0, -start); i < n; i++) out[start + i] += layer[i] * gain;
}

function span(out: Float32Array, sampleRate: number, at: number, seconds: number): [start: number, length: number] {
  const start = Math.round(at * sampleRate);
  return [start, Math.max(0, Math.min(out.length - start, Math.ceil(seconds * sampleRate)))];
}

/** Shaped noise: white noise through the envelope, then filters, then (optionally) saturation.
 *
 * Levels must not depend on luck. Short ticks (under ~4 ms) are normalised to peak 1. Longer layers
 * are normalised by the RMS of their carrier instead, to the level whose typical peak is 1 (RMS 1/3):
 * a random spike in one variant would otherwise make that whole variant quieter and change its
 * balance against the tonal layers. `gain` is therefore a relative peak either way. */
export interface NoiseLayer extends Envelope {
  at?: number; gain: number; filters?: readonly FilterSpec[]; drive?: number; bias?: number;
  /** Explicit length; otherwise until the envelope reaches about -60 dB. */
  length?: number;
  flutter?: { rate: number; depth: number };
}
const NOISE_RMS = 1 / 3;
export function addNoise(out: Float32Array, sampleRate: number, rng: Rng, layer: NoiseLayer) {
  if (!(layer.gain > 0)) return;
  const [start, n] = span(out, sampleRate, layer.at ?? 0, layer.length ?? envelopeLength(layer));
  if (n <= 0) return;
  const tmp = new Float32Array(n);
  fillEnvelope(tmp, sampleRate, layer);
  let envelopeEnergy = 0;
  for (let i = 0; i < n; i++) envelopeEnergy += tmp[i] * tmp[i];
  const flutter = layer.flutter ? flutterCurve(n, sampleRate, rng, layer.flutter.rate, layer.flutter.depth) : null;
  for (let i = 0; i < n; i++) tmp[i] *= (rng() * 2 - 1) * (flutter ? flutter[i] : 1);
  filterChain(tmp, sampleRate, layer.filters);
  if (layer.decay < 0.004 && !layer.hold) normalize(tmp, 1);
  else {
    let energy = 0;
    for (let i = 0; i < n; i++) energy += tmp[i] * tmp[i];
    const carrier = Math.sqrt(energy / Math.max(1e-12, envelopeEnergy));
    if (carrier > 1e-9) { const k = NOISE_RMS / carrier; for (let i = 0; i < n; i++) tmp[i] *= k; }
  }
  saturate(tmp, layer.drive ?? 0, layer.bias ?? 0);
  addInto(out, tmp, start, layer.gain);
}

/** A sine whose pitch falls exponentially from `from` to `to`, e.g. the chest thump of a gunshot.
 * Saturation turns a 50–80 Hz thump into harmonics that small phone speakers can reproduce. */
export interface ToneLayer extends Envelope {
  at?: number; gain: number; from: number; to?: number; sweep?: number; drive?: number; bias?: number;
  length?: number; vibrato?: { rate: number; depth: number }; phase?: number;
}
export function addTone(out: Float32Array, sampleRate: number, layer: ToneLayer) {
  if (!(layer.gain > 0)) return;
  const [start, n] = span(out, sampleRate, layer.at ?? 0, layer.length ?? envelopeLength(layer));
  if (n <= 0) return;
  const tmp = new Float32Array(n);
  fillEnvelope(tmp, sampleRate, { attack: 0.0012, ...layer });
  const to = layer.to ?? layer.from, delta = layer.from - to;
  const sweep = Math.exp(-1 / Math.max(1, (layer.sweep ?? 0.02) * sampleRate));
  const vibratoStep = layer.vibrato ? 2 * Math.PI * layer.vibrato.rate / sampleRate : 0;
  let phase = layer.phase ?? 0, glide = 1;
  for (let i = 0; i < n; i++) {
    const vibrato = layer.vibrato ? 1 + layer.vibrato.depth * Math.sin(vibratoStep * i) : 1;
    phase += 2 * Math.PI * (to + delta * glide) * vibrato / sampleRate;
    glide *= sweep;
    tmp[i] *= Math.sin(phase);
  }
  saturate(tmp, layer.drive ?? 0, layer.bias ?? 0);
  addInto(out, tmp, start, layer.gain);
}

/** Damped sinusoids: the resonant modes of metal parts, wood boards, brass cases or bells. */
export interface Mode { f: number; gain: number; decay: number }
export const mode = (f: number, gain: number, decay: number): Mode => ({ f, gain, decay });
export interface ModesLayer { at?: number; gain: number; modes: readonly Mode[]; attack?: number; detune?: number; scale?: number }
export function addModes(out: Float32Array, sampleRate: number, rng: Rng, layer: ModesLayer) {
  if (!(layer.gain > 0)) return;
  const attack = Math.max(1, Math.round((layer.attack ?? 0.0002) * sampleRate)), scale = layer.scale ?? 1;
  for (const m of layer.modes) {
    const f = m.f * scale * (1 + (rng() * 2 - 1) * (layer.detune ?? 0.012));
    if (f >= sampleRate * 0.47) continue;
    const [start, n] = span(out, sampleRate, layer.at ?? 0, m.decay * 6.9);
    const k = Math.exp(-1 / Math.max(1, m.decay * sampleRate)), w = 2 * Math.PI * f / sampleRate, phase = rng() * Math.PI * 2;
    let env = layer.gain * m.gain;
    for (let i = 0; i < n; i++) {
      if (start + i >= 0) out[start + i] += Math.sin(phase + w * i) * env * (i < attack ? i / attack : 1);
      env *= k;
    }
  }
}

/** A mechanical click: a sub-millisecond noise tick through a band-pass, plus the part's ringing modes. */
export interface ClackLayer { at?: number; gain: number; band: number; q?: number; decay?: number; modes?: readonly Mode[]; ring?: number; scale?: number }
export function addClack(out: Float32Array, sampleRate: number, rng: Rng, layer: ClackLayer) {
  const scale = layer.scale ?? 1;
  addNoise(out, sampleRate, rng, { at: layer.at, decay: layer.decay ?? 0.0007, gain: layer.gain, filters: [['bandpass', layer.band * scale, layer.q ?? 1.2]] });
  if (layer.modes) addModes(out, sampleRate, rng, { at: layer.at, gain: layer.gain * (layer.ring ?? 0.6), modes: layer.modes, scale });
}

/** Scattered short grains: gravel crunch, debris, dirt, glass tinkle (`ring`), electrical crackle. */
export interface GrainsLayer {
  at?: number; span: number; count: number; gain: number;
  /** Grain length range (seconds) and centre-frequency range (log-uniform). */
  length: readonly [number, number]; band: readonly [number, number]; q?: number;
  /** Amplitude decay (seconds) across the span; grains also thin out when `curve` > 1. */
  decay?: number; curve?: number;
  /** Ring grains as damped sinusoids (tinkles, chips) instead of noise ticks. */
  ring?: boolean;
}
export function addGrains(out: Float32Array, sampleRate: number, rng: Rng, layer: GrainsLayer) {
  if (!(layer.gain > 0) || layer.count <= 0) return;
  const [low, high] = layer.band;
  for (let g = 0; g < layer.count; g++) {
    const offset = layer.span * Math.pow(rng(), layer.curve ?? 1);
    const amplitude = layer.gain * (0.35 + 0.65 * rng()) * (layer.decay ? Math.exp(-offset / layer.decay) : 1);
    const frequency = low * Math.pow(high / low, rng()), length = between(rng, layer.length[0], layer.length[1]);
    const at = (layer.at ?? 0) + offset;
    if (layer.ring) addModes(out, sampleRate, rng, { at, gain: amplitude, modes: [mode(frequency, 1, length), mode(frequency * between(rng, 1.9, 2.6), 0.45, length * 0.6)] });
    else {
      const [start, n] = span(out, sampleRate, at, length);
      if (n <= 0) continue;
      const tmp = new Float32Array(n);
      for (let i = 0; i < n; i++) tmp[i] = (rng() * 2 - 1) * Math.exp(-4 * i / n);
      new Biquad('bandpass', sampleRate, frequency, layer.q ?? 1.4).run(tmp);
      normalize(tmp, 1);
      addInto(out, tmp, start, amplitude);
    }
  }
}

/** An N-shaped pressure pulse: the sharp crack of a muzzle blast or a supersonic bullet passing.
 * A narrower pulse sounds brighter; its edges give the crack a broadband, pitchless snap. */
export function addNWave(out: Float32Array, sampleRate: number, layer: { at?: number; width: number; gain: number }) {
  const start = Math.round((layer.at ?? 0) * sampleRate), n = Math.max(2, Math.round(layer.width * sampleRate));
  for (let i = 0; i < n && start + i < out.length; i++) out[start + i] += layer.gain * (1 - 2 * i / (n - 1));
}

/** Band-passed noise whose centre glides through `points` ([0..1 of length, Hz]): whooshes and whizzes. */
export interface SweepLayer { at?: number; gain: number; length: number; points: ReadonlyArray<readonly [number, number]>; q: number; rise: number }
export function addSweep(out: Float32Array, sampleRate: number, rng: Rng, layer: SweepLayer) {
  const [start, n] = span(out, sampleRate, layer.at ?? 0, layer.length);
  if (n <= 0 || !(layer.gain > 0)) return;
  const tmp = new Float32Array(n), filter = new Biquad('bandpass', sampleRate, layer.points[0][1], layer.q);
  const centreAt = (u: number) => {
    let i = 1;
    while (i < layer.points.length - 1 && layer.points[i][0] < u) i++;
    const [u0, f0] = layer.points[i - 1], [u1, f1] = layer.points[i];
    const t = Math.min(1, Math.max(0, (u - u0) / Math.max(1e-6, u1 - u0)));
    return f0 * Math.pow(f1 / f0, t);
  };
  for (let i = 0; i < n; i++) {
    const u = i / n;
    if ((i & 31) === 0) filter.tune(centreAt(u), layer.q);
    const envelope = u < layer.rise ? Math.sin(0.5 * Math.PI * u / layer.rise) : Math.cos(0.5 * Math.PI * (u - layer.rise) / (1 - layer.rise));
    tmp[i] = filter.process((rng() * 2 - 1) * envelope * envelope);
  }
  normalize(tmp, 1);
  addInto(out, tmp, start, layer.gain);
}

/** Perceived-loudness stand-in: RMS of the 200 Hz–10 kHz band over the first `seconds` (where the ear
 * is most sensitive, and roughly what an impulsive sound's loudness integrates over). */
export function loudnessOf(buffer: Float32Array, sampleRate: number, seconds = 0.06): number {
  const head = buffer.slice(0, Math.min(buffer.length, Math.max(1, Math.round(seconds * sampleRate))));
  filterChain(head, sampleRate, [['highpass', 200], ['highpass', 200], ['lowpass', 10000], ['lowpass', 10000]]);
  let energy = 0;
  for (let i = 0; i < head.length; i++) energy += head[i] * head[i];
  return Math.sqrt(energy / head.length);
}

/** Leaves samples below `knee × ceiling` alone and bends louder ones smoothly under `ceiling`. */
export function softLimit(buffer: Float32Array, ceiling: number, knee = 0.75) {
  const k = ceiling * knee, room = ceiling - k;
  for (let i = 0; i < buffer.length; i++) {
    const v = buffer[i], a = Math.abs(v);
    if (a > k) buffer[i] = Math.sign(v) * (k + room * Math.tanh((a - k) / room));
  }
}

/** Final pass for every rendered sound: optional glue saturation (rounds the transient so the body
 * can be loud), DC removal and a click-free tail. Then either an exact peak, or — when `loudness` is
 * given — that loudness with peaks bent under `peak`, so every variant of a sound is equally loud. */
export function finish(out: Float32Array, sampleRate: number, peak: number, options: { glue?: number; lowCut?: number; fadeOut?: number; loudness?: number } = {}): Float32Array {
  if (options.glue) { normalize(out, 1); saturate(out, options.glue); }
  filterChain(out, sampleRate, [['highpass', options.lowCut ?? 24, 0.6]]);
  const fade = Math.min(out.length, Math.round((options.fadeOut ?? 0.008) * sampleRate));
  for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / fade);
  if (options.loudness === undefined) return normalize(out, peak);
  const current = loudnessOf(out, sampleRate);
  if (current > 1e-9) { const k = options.loudness / current; for (let i = 0; i < out.length; i++) out[i] *= k; }
  softLimit(out, peak);
  return out;
}

export const samples = (seconds: number, sampleRate: number) => new Float32Array(Math.max(1, Math.ceil(seconds * sampleRate)));
