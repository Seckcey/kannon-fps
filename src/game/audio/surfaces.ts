import type { SurfaceKind } from '../../../shared/protocol';
import { addClack, addGrains, addModes, addNoise, addTone, between, finish, mode, samples, vary, type Mode, type Rng } from './dsp';

export const SURFACES: readonly SurfaceKind[] = ['asphalt', 'concrete', 'wood', 'grass', 'metal', 'fabric', 'glass', 'sandbag'];
export const isSurface = (value: unknown): value is SurfaceKind => typeof value === 'string' && (SURFACES as readonly string[]).includes(value);
/** Hard ground rings and clicks, wood booms, soft ground swallows. */
export type SurfaceClass = 'hard' | 'wood' | 'soft';
export const surfaceClass = (surface: SurfaceKind): SurfaceClass =>
  surface === 'wood' ? 'wood' : surface === 'grass' || surface === 'sandbag' || surface === 'fabric' ? 'soft' : 'hard';

/** A footstep is a heel strike (a low thud), the sole's click on hard ground, grit or crunch from the
 * surface, resonant modes for hollow floors and metal, and a quieter toe roll ~60 ms later. */
interface StepDesign {
  heel: number; heelCut: number; thump: readonly [from: number, to: number];
  click?: { gain: number; band: number; q: number };
  grit?: { gain: number; band: number };
  crunch?: { gain: number; band: readonly [number, number]; count: number; ring?: boolean };
  modes?: { gain: number; modes: readonly Mode[] };
  swish?: { gain: number; band: number };
  sand?: number;
  creak?: number;
}
const STEPS: Record<SurfaceKind, StepDesign> = {
  asphalt: { heel: 0.6, heelCut: 700, thump: [125, 70], click: { gain: 0.38, band: 2100, q: 1.1 }, grit: { gain: 0.32, band: 3600 }, crunch: { gain: 0.2, band: [2500, 7000], count: 6 } },
  concrete: { heel: 0.55, heelCut: 800, thump: [130, 75], click: { gain: 0.55, band: 2600, q: 1.4 }, grit: { gain: 0.16, band: 4200 }, crunch: { gain: 0.08, band: [3000, 8000], count: 3 }, modes: { gain: 0.12, modes: [mode(1950, 1, 0.012), mode(3300, 0.5, 0.008)] } },
  // Hollow house floors: the boards ring at 150–900 Hz, and some steps creak.
  wood: { heel: 0.75, heelCut: 600, thump: [115, 68], click: { gain: 0.32, band: 1500, q: 1 }, grit: { gain: 0.06, band: 2500 }, modes: { gain: 0.5, modes: [mode(152, 1, 0.055), mode(318, 0.65, 0.045), mode(530, 0.4, 0.035), mode(890, 0.22, 0.02)] }, creak: 0.07 },
  grass: { heel: 0.35, heelCut: 450, thump: [110, 65], grit: { gain: 0.14, band: 2600 }, crunch: { gain: 0.3, band: [2200, 6500], count: 18 }, swish: { gain: 0.15, band: 2500 } },
  // Bus and truck roofs: a dull clang.
  metal: { heel: 0.5, heelCut: 700, thump: [120, 70], click: { gain: 0.42, band: 2400, q: 1.2 }, grit: { gain: 0.08, band: 4000 }, modes: { gain: 0.35, modes: [mode(420, 1, 0.09), mode(1130, 0.7, 0.07), mode(1870, 0.5, 0.05), mode(2950, 0.3, 0.035)] } },
  fabric: { heel: 0.45, heelCut: 500, thump: [110, 65], swish: { gain: 0.2, band: 1800 } },
  glass: { heel: 0.4, heelCut: 700, thump: [120, 70], click: { gain: 0.3, band: 3000, q: 1.2 }, crunch: { gain: 0.3, band: [4500, 9500], count: 10, ring: true } },
  sandbag: { heel: 0.65, heelCut: 380, thump: [100, 60], sand: 0.26, crunch: { gain: 0.1, band: [1500, 4000], count: 8 } },
};

function stepImpact(out: Float32Array, sampleRate: number, rng: Rng, d: StepDesign, at: number, level: number, variant: number) {
  addTone(out, sampleRate, { at, from: vary(rng, d.thump[0], 0.06), to: d.thump[1], sweep: 0.012, attack: 0.002, decay: 0.022, gain: d.heel * level, drive: 1.4 });
  addNoise(out, sampleRate, rng, { at, attack: 0.001, decay: 0.009, gain: d.heel * level * 0.8, filters: [['lowpass', d.heelCut]] });
  if (d.click) addNoise(out, sampleRate, rng, { at: at + 0.002, decay: 0.0008, gain: d.click.gain * level, filters: [['bandpass', vary(rng, d.click.band, 0.08), d.click.q]] });
  if (d.grit) addNoise(out, sampleRate, rng, { at: at + 0.004, attack: 0.003, decay: 0.02, gain: d.grit.gain * level, filters: [['bandpass', d.grit.band, 0.8]], flutter: { rate: 90, depth: 0.6 } });
  if (d.crunch) addGrains(out, sampleRate, rng, { at: at + 0.003, span: 0.09, count: Math.round(d.crunch.count * level), length: [0.0015, 0.004], band: d.crunch.band, gain: d.crunch.gain * level, ring: d.crunch.ring });
  if (d.modes) addModes(out, sampleRate, rng, { at: at + 0.001, gain: d.modes.gain * level, modes: d.modes.modes, detune: 0.04 });
  if (d.swish) addNoise(out, sampleRate, rng, { at, attack: 0.012, decay: 0.03, gain: d.swish.gain * level, filters: [['bandpass', d.swish.band, 0.6]], flutter: { rate: 40, depth: 0.5 } });
  if (d.sand) addNoise(out, sampleRate, rng, { at: at + 0.003, attack: 0.005, decay: 0.06, gain: d.sand * level, filters: [['lowpass', 3500], ['highpass', 400]] });
  if (d.creak && variant % 3 === 2) addTone(out, sampleRate, { at: at + 0.03, from: 440, to: 380, sweep: 0.08, attack: 0.03, decay: 0.05, gain: d.creak, vibrato: { rate: 31, depth: 0.04 } });
}

export function renderStep(surface: SurfaceKind, sampleRate: number, rng: Rng, variant: number): Float32Array {
  const d = STEPS[surface], out = samples(0.26, sampleRate);
  stepImpact(out, sampleRate, rng, d, 0, 1, variant);
  stepImpact(out, sampleRate, rng, d, between(rng, 0.05, 0.075), between(rng, 0.3, 0.42), variant + 1);
  return finish(out, sampleRate, 0.7);
}

/** Kit rattle for running and landing: buckles, mag pouches, sling hardware and cloth. */
export function renderGear(sampleRate: number, rng: Rng): Float32Array {
  const out = samples(0.32, sampleRate);
  addGrains(out, sampleRate, rng, { span: 0.16, count: 5, length: [0.01, 0.03], band: [2000, 5000], gain: 0.5, ring: true });
  addNoise(out, sampleRate, rng, { attack: 0.04, decay: 0.05, gain: 0.4, filters: [['bandpass', 1500, 0.8]], flutter: { rate: 14, depth: 0.7 } });
  return finish(out, sampleRate, 0.5);
}

/** A heavy body landing: a deep thud with the kit catching up a beat later. */
export function renderLand(sampleRate: number, rng: Rng): Float32Array {
  const out = samples(0.42, sampleRate);
  addTone(out, sampleRate, { from: 105, to: 48, sweep: 0.02, attack: 0.002, decay: 0.06, gain: 1, drive: 2, bias: 0.15 });
  addNoise(out, sampleRate, rng, { attack: 0.001, decay: 0.03, gain: 0.8, filters: [['lowpass', 900]] });
  addGrains(out, sampleRate, rng, { at: 0.012, span: 0.11, count: 6, length: [0.008, 0.025], band: [1800, 4500], gain: 0.3, ring: true });
  addNoise(out, sampleRate, rng, { at: 0.01, attack: 0.03, decay: 0.05, gain: 0.25, filters: [['bandpass', 1400, 0.7]], flutter: { rate: 16, depth: 0.6 } });
  return finish(out, sampleRate, 0.85);
}

/** Sliding on hard ground (gritty scrape) or soft ground (a duller swish). */
export function renderSlide(kind: 'hard' | 'soft', sampleRate: number, rng: Rng): Float32Array {
  const out = samples(0.78, sampleRate), hard = kind === 'hard';
  addTone(out, sampleRate, { from: 110, to: 60, sweep: 0.02, attack: 0.002, decay: 0.04, gain: hard ? 0.5 : 0.45, drive: 1.5 });
  addNoise(out, sampleRate, rng, {
    at: 0.01, attack: 0.05, hold: 0.25, decay: 0.16, gain: hard ? 0.8 : 0.7,
    filters: hard ? [['bandpass', 1300, 0.6], ['highshelf', 3000, 0.7, 3]] : [['bandpass', 800, 0.5]],
    flutter: { rate: hard ? 45 : 25, depth: 0.55 },
  });
  addGrains(out, sampleRate, rng, { at: 0.03, span: 0.5, count: hard ? 40 : 30, length: [0.001, 0.004], band: hard ? [3000, 8000] : [2000, 5000], gain: hard ? 0.3 : 0.25, decay: 0.35 });
  addNoise(out, sampleRate, rng, { at: 0.02, attack: 0.08, hold: 0.15, decay: 0.12, gain: 0.25, filters: [['bandpass', 2200, 0.8]], flutter: { rate: 18, depth: 0.7 } });
  return finish(out, sampleRate, 0.7, { fadeOut: 0.06 });
}

/** Bullet impacts by material. Bodies get a muffled, padded thump: no gore. */
export type ImpactKind = SurfaceKind | 'flesh';
export function renderImpact(kind: ImpactKind, sampleRate: number, rng: Rng, variant: number): Float32Array {
  const out = samples(kind === 'glass' ? 0.6 : kind === 'metal' ? 0.45 : 0.32, sampleRate);
  const crack = (gain: number, cut: number) => addNoise(out, sampleRate, rng, { decay: 0.0008, gain, filters: [['highpass', cut], ['lowpass', 12000]] });
  switch (kind) {
    case 'concrete': case 'asphalt': {
      const dark = kind === 'asphalt';
      crack(1, dark ? 1200 : 1500);
      addNoise(out, sampleRate, rng, { attack: 0.0005, decay: 0.008, gain: 0.7, filters: [['bandpass', dark ? 1200 : 1800, 0.8]] });
      addGrains(out, sampleRate, rng, { at: 0.004, span: 0.18, count: 14, length: [0.001, 0.004], band: dark ? [1000, 4000] : [1500, 6000], gain: 0.35, decay: 0.08, curve: 1.6 });
      if (!dark) addModes(out, sampleRate, rng, { gain: 0.15, modes: [mode(2400, 1, 0.01), mode(3900, 0.5, 0.007)] });
      break;
    }
    case 'wood':
      crack(0.8, 1800);
      addModes(out, sampleRate, rng, { gain: 0.7, modes: [mode(vary(rng, 260, 0.1), 1, 0.025), mode(520, 0.5, 0.018), mode(1040, 0.25, 0.01)] });
      addGrains(out, sampleRate, rng, { at: 0.002, span: 0.08, count: 8, length: [0.001, 0.003], band: [2000, 7000], gain: 0.3, decay: 0.05 });
      break;
    case 'metal':
      crack(0.9, 2000);
      addModes(out, sampleRate, rng, { gain: 0.6, modes: [mode(vary(rng, 1450, 0.08), 1, 0.12), mode(2380, 0.8, 0.09), mode(3720, 0.55, 0.07), mode(5600, 0.35, 0.05)], detune: 0.05 });
      // One in three metal hits ricochets with a short falling whine.
      if (variant % 3 === 1) addTone(out, sampleRate, { at: 0.01, from: 3300, to: 2300, sweep: 0.12, attack: 0.01, decay: 0.07, gain: 0.12, vibrato: { rate: 23, depth: 0.02 } });
      break;
    case 'grass':
      addNoise(out, sampleRate, rng, { attack: 0.0008, decay: 0.012, gain: 0.8, filters: [['lowpass', 900]] });
      addTone(out, sampleRate, { from: 140, to: 80, sweep: 0.01, decay: 0.02, gain: 0.4 });
      addGrains(out, sampleRate, rng, { at: 0.01, span: 0.15, count: 10, length: [0.001, 0.003], band: [1500, 4000], gain: 0.2, decay: 0.1 });
      break;
    case 'sandbag':
      addNoise(out, sampleRate, rng, { attack: 0.001, decay: 0.018, gain: 0.9, filters: [['lowpass', 600]] });
      addTone(out, sampleRate, { from: 110, to: 70, sweep: 0.012, decay: 0.03, gain: 0.5, drive: 1.4 });
      addNoise(out, sampleRate, rng, { at: 0.003, attack: 0.005, decay: 0.07, gain: 0.22, filters: [['lowpass', 4000], ['highpass', 500]] });
      break;
    case 'fabric':
      addNoise(out, sampleRate, rng, { attack: 0.001, decay: 0.01, gain: 0.8, filters: [['bandpass', 900, 0.7]] });
      addTone(out, sampleRate, { from: 130, to: 80, sweep: 0.01, decay: 0.02, gain: 0.3 });
      addNoise(out, sampleRate, rng, { at: 0.004, attack: 0.01, decay: 0.03, gain: 0.2, filters: [['bandpass', 1500, 0.8]], flutter: { rate: 30, depth: 0.6 } });
      break;
    case 'glass':
      crack(1, 3000);
      addNoise(out, sampleRate, rng, { attack: 0.0005, decay: 0.03, gain: 0.4, filters: [['highpass', 3000]] });
      addGrains(out, sampleRate, rng, { at: 0.004, span: 0.35, count: 22, length: [0.008, 0.025], band: [3000, 9000], gain: 0.5, decay: 0.2, curve: 1.5, ring: true });
      break;
    case 'flesh':
      addNoise(out, sampleRate, rng, { attack: 0.0008, decay: 0.009, gain: 0.9, drive: 1.4, filters: [['lowpass', 1100], ['peaking', 300, 1, 4]] });
      addTone(out, sampleRate, { from: 160, to: 90, sweep: 0.01, decay: 0.025, gain: 0.6, drive: 1.6 });
      addNoise(out, sampleRate, rng, { at: 0.003, attack: 0.008, decay: 0.03, gain: 0.15, filters: [['bandpass', 2000, 0.8]], flutter: { rate: 35, depth: 0.6 } });
      break;
  }
  return finish(out, sampleRate, 0.75);
}

/** A grenade hitting the ground: a metal body clunk on hard ground, a dull thud on soft ground. */
export function renderBounce(kind: 'hard' | 'soft', sampleRate: number, rng: Rng): Float32Array {
  const out = samples(0.2, sampleRate);
  if (kind === 'hard') {
    addClack(out, sampleRate, rng, { gain: 0.8, band: 1800, modes: [mode(vary(rng, 950, 0.06), 1, 0.04), mode(2300, 0.5, 0.025), mode(3700, 0.3, 0.015)] });
    addTone(out, sampleRate, { from: 180, to: 110, sweep: 0.008, decay: 0.015, gain: 0.4 });
  } else {
    addNoise(out, sampleRate, rng, { attack: 0.0008, decay: 0.012, gain: 0.8, filters: [['lowpass', 700]] });
    addTone(out, sampleRate, { from: 140, to: 90, sweep: 0.008, decay: 0.018, gain: 0.5 });
    addGrains(out, sampleRate, rng, { at: 0.004, span: 0.05, count: 4, length: [0.001, 0.003], band: [1500, 3500], gain: 0.2 });
  }
  return finish(out, sampleRate, 0.7);
}
