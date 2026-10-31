import { addGrains, addNoise, addNWave, addSweep, addTone, Biquad, finish, normalize, samples, saturate, type Rng } from './dsp';

export type ExplosionKind = 'frag' | 'mortar' | 'drone';
export const EXPLOSION_KINDS: readonly ExplosionKind[] = ['frag', 'mortar', 'drone'];

/** Explosions: a broadband crack, a low blast glued hard, a falling thump, sub rumble and debris
 * raining down for a second or two. Mortar shells are bigger and deeper; a downed drone is smaller,
 * with metal parts and electrical crackle. */
interface BlastDesign {
  length: number; crack: number; crackWidth: number;
  body: { decay: number; bloom: number; bloomDecay: number; cutoff: number; centre: number };
  thump: { from: number; to: number; decay: number; gain: number };
  sub: { gain: number; decay: number };
  debris: { count: number; span: number; decay: number; gain: number };
  chunks: number; glue: number; peak: number;
  metal?: number; crackle?: number;
}
const BLASTS: Record<ExplosionKind, BlastDesign> = {
  frag: {
    length: 1.9, crack: 0.7, crackWidth: 0.0006,
    body: { decay: 0.055, bloom: 0.55, bloomDecay: 0.24, cutoff: 2600, centre: 380 },
    thump: { from: 110, to: 36, decay: 0.24, gain: 1.1 }, sub: { gain: 0.8, decay: 0.45 },
    debris: { count: 46, span: 1.2, decay: 0.4, gain: 0.3 }, chunks: 10, glue: 2.2, peak: 1,
  },
  mortar: {
    length: 2.6, crack: 0.8, crackWidth: 0.0008,
    body: { decay: 0.085, bloom: 0.65, bloomDecay: 0.36, cutoff: 2000, centre: 300 },
    thump: { from: 95, to: 30, decay: 0.38, gain: 1.2 }, sub: { gain: 0.95, decay: 0.7 },
    debris: { count: 70, span: 1.9, decay: 0.6, gain: 0.32 }, chunks: 16, glue: 2.4, peak: 1,
  },
  drone: {
    length: 1.5, crack: 0.6, crackWidth: 0.0004,
    body: { decay: 0.04, bloom: 0.4, bloomDecay: 0.14, cutoff: 3800, centre: 600 },
    thump: { from: 150, to: 52, decay: 0.14, gain: 0.9 }, sub: { gain: 0.3, decay: 0.25 },
    debris: { count: 20, span: 0.9, decay: 0.3, gain: 0.2 }, chunks: 4, glue: 1.8, peak: 0.9, metal: 0.35, crackle: 0.3,
  },
};

export function renderExplosion(kind: ExplosionKind, sampleRate: number, rng: Rng): Float32Array {
  const d = BLASTS[kind], blast = samples(d.length, sampleRate);
  addNoise(blast, sampleRate, rng, {
    attack: 0.0008, decay: d.body.decay, bloom: d.body.bloom, bloomDecay: d.body.bloomDecay, gain: 1, drive: 3,
    filters: [['highpass', 50], ['lowpass', d.body.cutoff], ['peaking', d.body.centre, 0.7, 5]],
  });
  addTone(blast, sampleRate, { from: d.thump.from, to: d.thump.to, sweep: 0.05, attack: 0.002, decay: d.thump.decay, gain: d.thump.gain, drive: 3, bias: 0.2 });
  addNoise(blast, sampleRate, rng, { attack: 0.006, decay: d.sub.decay, gain: d.sub.gain, filters: [['lowpass', 75], ['lowpass', 75]] });
  normalize(blast, 1);
  saturate(blast, d.glue);
  const out = blast;
  for (let i = 0; i < out.length; i++) out[i] *= 0.75;
  addNWave(out, sampleRate, { width: d.crackWidth, gain: d.crack });
  addNoise(out, sampleRate, rng, { decay: 0.0025, gain: d.crack, filters: [['highpass', 1200], ['highpass', 1200]] });
  addGrains(out, sampleRate, rng, { at: 0.06, span: d.debris.span, count: d.debris.count, length: [0.002, 0.009], band: [1200, 6000], gain: d.debris.gain, decay: d.debris.decay, curve: 1.8 });
  addGrains(out, sampleRate, rng, { at: 0.1, span: d.debris.span * 0.75, count: d.chunks, length: [0.01, 0.03], band: [250, 900], gain: d.debris.gain * 0.9, decay: d.debris.decay * 1.2, curve: 1.5 });
  if (d.metal) addGrains(out, sampleRate, rng, { at: 0.05, span: 0.9, count: 14, length: [0.03, 0.12], band: [1000, 4500], gain: d.metal, decay: 0.4, curve: 1.6, ring: true });
  if (d.crackle) addGrains(out, sampleRate, rng, { at: 0.08, span: 0.7, count: 30, length: [0.0003, 0.0012], band: [3000, 9000], gain: d.crackle, decay: 0.35 });
  return finish(out, sampleRate, d.peak, { fadeOut: 0.08 });
}

/** An incoming shell: a whistle falling from ~1.9 kHz to ~650 Hz and swelling as it comes down,
 * with a breathy edge. Lasts `MORTAR_WHISTLE_SECONDS`. */
export const MORTAR_WHISTLE_SECONDS = 1.6;
export function renderWhistle(sampleRate: number, rng: Rng): Float32Array {
  const out = samples(MORTAR_WHISTLE_SECONDS, sampleRate), n = out.length;
  const breath = new Biquad('bandpass', sampleRate, 1900, 8);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const f = (650 + 1250 * Math.pow(1 - u, 1.4)) * (1 + 0.012 * Math.sin(2 * Math.PI * 5.5 * i / sampleRate));
    if ((i & 63) === 0) breath.tune(f, 8);
    phase += 2 * Math.PI * f / sampleRate;
    const level = (0.18 + 0.82 * Math.pow(u, 1.3)) * Math.min(1, (n - i) / (0.03 * sampleRate)) * Math.min(1, i / (0.08 * sampleRate));
    out[i] = (Math.sin(phase) + 0.9 * breath.process(rng() * 2 - 1)) * level;
  }
  return finish(out, sampleRate, 0.6, { lowCut: 200 });
}

/** A supersonic near miss: the bullet's own N-wave crack right by the ear and a short falling whizz. */
export function renderFlyby(sampleRate: number, rng: Rng): Float32Array {
  const out = samples(0.22, sampleRate);
  addNWave(out, sampleRate, { width: 0.00026, gain: 1 });
  addNoise(out, sampleRate, rng, { decay: 0.0005, gain: 0.6, filters: [['highpass', 3000]] });
  addSweep(out, sampleRate, rng, { at: 0.002, gain: 0.35, length: 0.14, points: [[0, 4800], [1, 2000]], q: 2.2, rise: 0.15 });
  return finish(out, sampleRate, 0.75, { glue: 1.3 });
}
