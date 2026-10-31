import type { StreakId } from '../../../shared/protocol';
import { addModes, addNoise, addTone, filterChain, finish, mode, samples, type Rng } from './dsp';

/** Feedback cues. They play straight to the ears (not through the world's muffling), sit above the
 * gunfire band (2–6 kHz ticks) or below it (thumps), and are short so they never mask footsteps. */

export type MarkerKind = 'hit' | 'head' | 'kill';
/** Hit: a crisp tick. Head: a bright metallic ping that rings. Kill: a heavy thump under the tick. */
export function renderMarker(kind: MarkerKind, sampleRate: number, rng: Rng): Float32Array {
  const out = samples(kind === 'hit' ? 0.07 : kind === 'head' ? 0.32 : 0.36, sampleRate);
  addNoise(out, sampleRate, rng, { decay: 0.0006, gain: 0.5, filters: [['highpass', 4000]] });
  if (kind === 'hit') {
    addModes(out, sampleRate, rng, { gain: 1, modes: [mode(2900, 1, 0.012), mode(5600, 0.35, 0.008)], detune: 0 });
    addTone(out, sampleRate, { from: 700, decay: 0.01, gain: 0.3, attack: 0.0005 });
  } else if (kind === 'head') {
    addModes(out, sampleRate, rng, { gain: 1, modes: [mode(2350, 1, 0.11), mode(4980, 0.55, 0.08), mode(7400, 0.25, 0.05)], detune: 0 });
    addModes(out, sampleRate, rng, { gain: 0.5, modes: [mode(2900, 1, 0.012)], detune: 0 });
  } else {
    addTone(out, sampleRate, { from: 140, to: 52, sweep: 0.03, attack: 0.002, decay: 0.08, gain: 1, drive: 2.2, bias: 0.15 });
    addNoise(out, sampleRate, rng, { attack: 0.001, decay: 0.03, gain: 0.6, filters: [['lowpass', 700]] });
    addModes(out, sampleRate, rng, { gain: 0.45, modes: [mode(460, 1, 0.04), mode(940, 0.4, 0.025)], detune: 0 });
    addModes(out, sampleRate, rng, { gain: 0.5, modes: [mode(2200, 1, 0.014), mode(4400, 0.3, 0.008)], detune: 0 });
  }
  return finish(out, sampleRate, kind === 'hit' ? 0.34 : kind === 'head' ? 0.36 : 0.45);
}

/** Being hit: a dull body impact felt more than heard. */
export function renderDamage(sampleRate: number, rng: Rng): Float32Array {
  const out = samples(0.28, sampleRate);
  addTone(out, sampleRate, { from: 120, to: 60, sweep: 0.015, attack: 0.002, decay: 0.05, gain: 1, drive: 1.8, bias: 0.15 });
  addNoise(out, sampleRate, rng, { attack: 0.001, decay: 0.025, gain: 0.7, filters: [['lowpass', 500]] });
  addNoise(out, sampleRate, rng, { at: 0.005, attack: 0.01, decay: 0.03, gain: 0.2, filters: [['bandpass', 1700, 0.8]], flutter: { rate: 30, depth: 0.6 } });
  return finish(out, sampleRate, 0.6);
}

/** One heartbeat ("lub" then "dub") at the start of a longer buffer. Looping the start of the buffer
 * with a shorter or longer loop end changes the tempo without changing the pitch. */
export const HEARTBEAT_SECONDS = 1.1;
export function renderHeartbeat(sampleRate: number, _rng: Rng): Float32Array {
  const out = samples(HEARTBEAT_SECONDS, sampleRate);
  addTone(out, sampleRate, { from: 62, to: 50, sweep: 0.03, attack: 0.006, decay: 0.07, gain: 1, drive: 2.5, bias: 0.2 });
  addTone(out, sampleRate, { at: 0.24, from: 54, to: 44, sweep: 0.03, attack: 0.008, decay: 0.09, gain: 0.75, drive: 2.5, bias: 0.2 });
  return finish(out, sampleRate, 0.7, { lowCut: 20, fadeOut: 0.02 });
}

/** A blast close by leaves the ears ringing for a moment: two close high tones that beat slowly. */
export function renderRing(sampleRate: number, _rng: Rng): Float32Array {
  const out = samples(2.2, sampleRate);
  addTone(out, sampleRate, { from: 3650, attack: 0.02, decay: 0.7, gain: 1 });
  addTone(out, sampleRate, { from: 3790, attack: 0.02, decay: 0.6, gain: 0.6, phase: 1.3 });
  return finish(out, sampleRate, 0.25, { fadeOut: 0.1 });
}

/** Rewards sound like a short radio call: a squelch, a few notes through a radio band, a squelch.
 * Each reward has its own motif (rising when earned, falling when called in). */
const MOTIFS: Record<StreakId, readonly number[]> = { recon: [880, 1175], mortar: [587, 784, 988], drone: [740, 988, 1319] };
export function renderStreak(kind: 'earned' | 'used', reward: StreakId, sampleRate: number, rng: Rng): Float32Array {
  const notes = kind === 'earned' ? MOTIFS[reward] : [...MOTIFS[reward]].reverse();
  const step = kind === 'earned' ? 0.13 : 0.09, out = samples(0.2 + notes.length * step + 0.25, sampleRate);
  addNoise(out, sampleRate, rng, { decay: 0.02, length: 0.05, gain: 0.5, filters: [['bandpass', 2500, 1.5], ['highpass', 800]] });
  notes.forEach((f, i) => {
    const at = 0.06 + i * step;
    addTone(out, sampleRate, { at, from: f, attack: 0.006, hold: step * 0.55, decay: 0.03, gain: 0.8 });
    addTone(out, sampleRate, { at, from: f * 3, attack: 0.006, hold: step * 0.55, decay: 0.03, gain: 0.22 });
  });
  addNoise(out, sampleRate, rng, { at: 0.08 + notes.length * step, decay: 0.015, length: 0.04, gain: 0.3, filters: [['bandpass', 2800, 1.5]] });
  filterChain(out, sampleRate, [['highpass', 500], ['lowpass', 3400], ['peaking', 1600, 1, 3]]);
  return finish(out, sampleRate, 0.5);
}

/** A short two-strike chime for medals. */
export function renderMedal(sampleRate: number, rng: Rng): Float32Array {
  const out = samples(0.55, sampleRate);
  addModes(out, sampleRate, rng, { gain: 0.7, modes: [mode(1320, 1, 0.22), mode(1980, 0.5, 0.18), mode(2640, 0.25, 0.12)], detune: 0 });
  addModes(out, sampleRate, rng, { at: 0.09, gain: 0.8, modes: [mode(1760, 1, 0.25), mode(2640, 0.4, 0.18)], detune: 0 });
  return finish(out, sampleRate, 0.4);
}

/** Match countdown: short timer ticks, and a longer two-tone mark on "go". */
export function renderCountdown(final: boolean, sampleRate: number, _rng: Rng): Float32Array {
  const out = samples(final ? 0.5 : 0.14, sampleRate);
  if (final) {
    addTone(out, sampleRate, { from: 1320, attack: 0.003, hold: 0.12, decay: 0.08, gain: 0.8 });
    addTone(out, sampleRate, { from: 660, attack: 0.003, hold: 0.12, decay: 0.08, gain: 0.5 });
  } else {
    addTone(out, sampleRate, { from: 880, attack: 0.002, decay: 0.025, gain: 0.8 });
    addTone(out, sampleRate, { from: 2640, attack: 0.002, decay: 0.012, gain: 0.15 });
  }
  return finish(out, sampleRate, 0.45);
}
