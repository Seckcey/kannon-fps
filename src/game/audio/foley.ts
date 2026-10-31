import type { WeaponId } from '../../../shared/protocol';
import { WEAPONS } from '../../../shared/weapons';
import { addClack, addGrains, addModes, addNoise, addSweep, addTone, finish, mode, samples, type Rng } from './dsp';

/** Weapon handling and body movement close to the player's ears. */

/** Reload step names (the GameAudio contract type). */
export type ReloadStep = 'mag-out' | 'mag-in' | 'bolt' | 'shell' | 'pump';
/** Size classes share recipes: smaller parts ring higher and weigh less. */
export type ReloadSize = 'pistol' | 'smg' | 'rifle' | 'sniper' | 'shotgun';
export const RELOAD_SIZES: readonly ReloadSize[] = ['pistol', 'smg', 'rifle', 'sniper', 'shotgun'];
export const reloadSize = (weapon: WeaponId): ReloadSize => {
  const kind = WEAPONS[weapon]?.kind;
  return kind === 'pistol' ? 'pistol' : kind === 'smg' ? 'smg' : kind === 'sniper' ? 'sniper' : kind === 'shotgun' ? 'shotgun' : 'rifle';
};
const SIZE: Record<ReloadSize, { pitch: number; weight: number }> = {
  pistol: { pitch: 1.18, weight: 0.6 }, smg: { pitch: 1.08, weight: 0.8 }, rifle: { pitch: 1, weight: 1 },
  sniper: { pitch: 0.92, weight: 1.1 }, shotgun: { pitch: 0.95, weight: 0.9 },
};

/** Magazine release and draw, magazine seat and latch, charging handle or slide, shotgun shell. */
export function renderReload(step: Exclude<ReloadStep, 'pump'>, size: ReloadSize, sampleRate: number, rng: Rng): Float32Array {
  const { pitch: s, weight: w } = SIZE[size];
  switch (step) {
    case 'mag-out': {
      const out = samples(0.26, sampleRate);
      addClack(out, sampleRate, rng, { gain: 0.5, band: 3600, scale: s, modes: [mode(3300, 1, 0.006), mode(5200, 0.5, 0.004)] });
      addNoise(out, sampleRate, rng, { at: 0.012, attack: 0.015, decay: 0.02, length: 0.07, gain: 0.45 * w, filters: [['bandpass', 2000 * s, 1.1]], flutter: { rate: 70, depth: 0.5 } });
      addTone(out, sampleRate, { at: 0.07, from: 260 * s, to: 200 * s, sweep: 0.01, decay: 0.02, gain: 0.25 * w });
      addClack(out, sampleRate, rng, { at: 0.07, gain: 0.3, band: 1500 * s, modes: [mode(1300, 1, 0.012)], scale: s });
      return finish(out, sampleRate, 0.6);
    }
    case 'mag-in': {
      const out = samples(0.3, sampleRate);
      addNoise(out, sampleRate, rng, { attack: 0.02, decay: 0.015, length: 0.05, gain: 0.4, filters: [['bandpass', 1800 * s, 1]], flutter: { rate: 70, depth: 0.5 } });
      addClack(out, sampleRate, rng, { at: 0.05, gain: 1 * w, band: 2100, scale: s, modes: [mode(1700, 1, 0.02), mode(2900, 0.7, 0.015), mode(4400, 0.4, 0.01)] });
      addTone(out, sampleRate, { at: 0.05, from: 300 * s, to: 180 * s, sweep: 0.008, decay: 0.015, gain: 0.45 * w, drive: 1.4 });
      addClack(out, sampleRate, rng, { at: 0.085, gain: 0.4, band: 3400, scale: s, modes: [mode(3000, 1, 0.008)] });
      return finish(out, sampleRate, 0.7);
    }
    case 'bolt': {
      const out = samples(0.36, sampleRate);
      addClack(out, sampleRate, rng, { gain: 0.45, band: 3000, scale: s, modes: [mode(2700, 1, 0.008)] });
      addNoise(out, sampleRate, rng, { at: 0.01, attack: 0.05, decay: 0.02, length: 0.09, gain: 0.35, filters: [['bandpass', 2400 * s, 1]], flutter: { rate: 80, depth: 0.5 } });
      addClack(out, sampleRate, rng, { at: 0.13, gain: 1 * w, band: 1700, scale: s, modes: [mode(1150, 1, 0.03), mode(2050, 0.75, 0.022), mode(3400, 0.45, 0.015), mode(5200, 0.25, 0.01)] });
      addTone(out, sampleRate, { at: 0.13, from: 220 * s, to: 150 * s, sweep: 0.01, decay: 0.02, gain: 0.5 * w, drive: 1.4 });
      return finish(out, sampleRate, 0.75);
    }
    case 'shell': {
      const out = samples(0.18, sampleRate);
      addNoise(out, sampleRate, rng, { attack: 0.012, decay: 0.008, length: 0.03, gain: 0.35, filters: [['bandpass', 1500, 1]] });
      addClack(out, sampleRate, rng, { at: 0.022, gain: 0.8, band: 2200, modes: [mode(2200, 1, 0.012), mode(3600, 0.5, 0.008)] });
      addModes(out, sampleRate, rng, { at: 0.022, gain: 0.4, modes: [mode(760, 1, 0.02)] });
      return finish(out, sampleRate, 0.6);
    }
  }
}

/** Raising to the sights: a cloth rustle and a light touch of the stock. Lowering is softer. */
export function renderAim(entering: boolean, sampleRate: number, rng: Rng): Float32Array {
  const out = samples(entering ? 0.25 : 0.2, sampleRate);
  addNoise(out, sampleRate, rng, { attack: 0.03, hold: 0.03, decay: entering ? 0.035 : 0.04, gain: entering ? 0.7 : 0.6, filters: [['bandpass', entering ? 1600 : 1200, 0.8]], flutter: { rate: 22, depth: 0.7 } });
  if (entering) addClack(out, sampleRate, rng, { at: 0.045, gain: 0.25, band: 2600, modes: [mode(2400, 1, 0.007)] });
  return finish(out, sampleRate, entering ? 0.45 : 0.35);
}

export function renderSwap(sampleRate: number, rng: Rng): Float32Array {
  const out = samples(0.4, sampleRate);
  addNoise(out, sampleRate, rng, { attack: 0.05, hold: 0.05, decay: 0.06, gain: 0.6, filters: [['bandpass', 1400, 0.8]], flutter: { rate: 16, depth: 0.7 } });
  addGrains(out, sampleRate, rng, { at: 0.03, span: 0.2, count: 4, length: [0.01, 0.025], band: [2200, 5000], gain: 0.35, ring: true });
  addClack(out, sampleRate, rng, { at: 0.17, gain: 0.5, band: 2000, modes: [mode(1600, 1, 0.015), mode(2700, 0.5, 0.01)] });
  return finish(out, sampleRate, 0.5);
}

/** Pulling the trigger on an empty chamber: the trigger and the hammer falling on nothing. */
export function renderDry(sampleRate: number, rng: Rng): Float32Array {
  const out = samples(0.08, sampleRate);
  addClack(out, sampleRate, rng, { gain: 0.8, band: 2800, modes: [mode(2600, 1, 0.006), mode(4200, 0.6, 0.004)] });
  addClack(out, sampleRate, rng, { at: 0.012, gain: 0.5, band: 3400, modes: [mode(3100, 1, 0.005)] });
  return finish(out, sampleRate, 0.4);
}

/** Knife: a fast whoosh, and on contact a dull padded hit (no gore). */
export function renderMelee(kind: 'swing' | 'hit', sampleRate: number, rng: Rng): Float32Array {
  if (kind === 'swing') {
    const out = samples(0.3, sampleRate);
    addSweep(out, sampleRate, rng, { gain: 1, length: 0.24, points: [[0, 650], [0.45, 2600], [1, 900]], q: 1.3, rise: 0.45 });
    addSweep(out, sampleRate, rng, { gain: 0.35, length: 0.22, points: [[0, 300], [0.45, 900], [1, 400]], q: 0.8, rise: 0.45 });
    return finish(out, sampleRate, 0.55);
  }
  const out = samples(0.25, sampleRate);
  addNoise(out, sampleRate, rng, { attack: 0.001, decay: 0.025, gain: 1, drive: 1.5, filters: [['lowpass', 800]] });
  addTone(out, sampleRate, { from: 150, to: 85, sweep: 0.012, decay: 0.03, gain: 0.6, drive: 1.5 });
  addNoise(out, sampleRate, rng, { at: 0.004, attack: 0.01, decay: 0.03, gain: 0.25, filters: [['bandpass', 2000, 0.8]], flutter: { rate: 30, depth: 0.6 } });
  return finish(out, sampleRate, 0.6);
}

/** Vaulting: both hands slap the ledge, the kit rattles, the body clears and lands. */
export function renderVault(sampleRate: number, rng: Rng): Float32Array {
  const out = samples(0.5, sampleRate);
  addNoise(out, sampleRate, rng, { decay: 0.012, gain: 0.8, filters: [['bandpass', 1100, 0.7]] });
  addNoise(out, sampleRate, rng, { at: 0.05, decay: 0.012, gain: 0.6, filters: [['bandpass', 1000, 0.7]] });
  addGrains(out, sampleRate, rng, { at: 0.04, span: 0.25, count: 5, length: [0.01, 0.025], band: [2000, 4800], gain: 0.3, ring: true });
  addNoise(out, sampleRate, rng, { at: 0.02, attack: 0.08, hold: 0.06, decay: 0.08, gain: 0.45, filters: [['bandpass', 1500, 0.7]], flutter: { rate: 15, depth: 0.7 } });
  addTone(out, sampleRate, { at: 0.2, from: 120, to: 70, sweep: 0.01, decay: 0.03, gain: 0.4, drive: 1.4 });
  return finish(out, sampleRate, 0.55);
}

/** Frag pin pulled (a metallic scrape and ring), then the spoon flicking free. */
export function renderPin(sampleRate: number, rng: Rng): Float32Array {
  const out = samples(0.5, sampleRate);
  addNoise(out, sampleRate, rng, { attack: 0.01, decay: 0.01, length: 0.03, gain: 0.3, filters: [['bandpass', 3500, 1.5]] });
  addModes(out, sampleRate, rng, { at: 0.02, gain: 0.5, modes: [mode(3900, 1, 0.08), mode(6100, 0.6, 0.06), mode(8800, 0.3, 0.04)] });
  addClack(out, sampleRate, rng, { at: 0.19, gain: 0.6, band: 2600, modes: [mode(2700, 1, 0.15), mode(4400, 0.5, 0.1)] });
  return finish(out, sampleRate, 0.45);
}

/** Back in the fight: a rising whoosh, the kit settling and a soft footfall. */
export function renderRespawn(sampleRate: number, rng: Rng): Float32Array {
  const out = samples(0.8, sampleRate);
  addSweep(out, sampleRate, rng, { gain: 0.6, length: 0.5, points: [[0, 400], [1, 1800]], q: 0.8, rise: 0.7 });
  addGrains(out, sampleRate, rng, { at: 0.25, span: 0.3, count: 6, length: [0.01, 0.025], band: [2000, 4500], gain: 0.3, ring: true });
  addTone(out, sampleRate, { at: 0.45, from: 120, to: 65, sweep: 0.01, decay: 0.04, gain: 0.5, drive: 1.4 });
  return finish(out, sampleRate, 0.45);
}
