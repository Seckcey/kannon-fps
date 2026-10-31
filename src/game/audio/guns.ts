import type { SurfaceKind, WeaponId } from '../../../shared/protocol';
import { addClack, addModes, addNoise, addNWave, addTone, between, finish, mode, normalizeRms, samples, saturate, vary, type Mode, type Rng } from './dsp';

/** RMS of the blast's first 30 ms before the glue: loud enough to saturate, from the same level in
 * every variant. */
const BLAST_RMS = 0.42;

/** Gun voices: every weapon plus the Attack Drone's gun. */
export type GunVoice = WeaponId | 'drone';
export const GUN_VOICES: readonly GunVoice[] = ['kr5', 'hornet9', 'breaker12', 'longbow', 'sentry9', 'drone'];
export const isGunVoice = (value: unknown): value is GunVoice => typeof value === 'string' && (GUN_VOICES as readonly string[]).includes(value);

/** One gunshot is built from layers, the way game sound designers stack recordings:
 *
 * - crack: the first millisecond. An N-shaped pressure pulse plus a spit of high-passed noise. It
 *   gives the attack and the crispness; narrower pulses (pistol, SMG) are brighter, and the Heron 7's
 *   supersonic magnum crack is the loudest.
 * - body: the muzzle blast, 9–32 ms of band-limited noise with a slower "bloom" behind it. Its
 *   centre frequency is the main thing that tells guns apart (drone 2.9 kHz, pistol 2.4 kHz, SMG
 *   1.9 kHz, carbine 1.1 kHz, rifle 850 Hz, shotgun 620 Hz). A second "boom" boost at 260–750 Hz
 *   puts weight where phone speakers can still play it. Saturation thickens it.
 * - thump: a sine dropping from ~150–280 Hz to 52–140 Hz in 7–22 ms — the punch in the chest. It is
 *   saturated asymmetrically so its harmonics carry the weight on small speakers.
 * - punch: a short 160–340 Hz knock, again for small speakers.
 * - sub: a low noise swell (80–150 Hz) for pressure on headphones and desktop speakers. It is kept
 *   below the transient: a gunshot whose loudest moment is its bass sounds like a distant explosion,
 *   and on a phone it would be quiet, because peak level would be spent on frequencies it cannot play.
 * - ring: a quiet dry tail of the receiver and the air around the shooter, before the generated room
 *   or street reverb takes over at playback.
 * - mech: the action — bolt carrier, open bolt, slide or feed — as metal clicks 4–50 ms in.
 *
 * The blast (body and low end) is brought to a fixed level and "glued" through a soft clipper, which
 * makes it dense and loud the way real gunshot recordings saturate; the crack and the action are then
 * laid on top unclipped, so the first milliseconds stay the sharpest and loudest. Finally every
 * variant is set to the same loudness (`loudness`) with its peaks bent under `peak`, so no round of
 * the same gun is louder than another. Pump and bolt cycling and spent cases are separate sounds
 * (`renderCycle`, `renderCasing`) so the shooter hears them later and distant players do not. */
export interface GunDesign {
  /** Seconds of dry sound; the environment tail comes from the reverb at playback. */
  length: number;
  /** Peak after rendering, playback level, and the final soft-clip drive. */
  peak: number; level: number; glue: number;
  /** Blast level under the crack: higher for guns whose body should dominate (shotgun). */
  blast: number;
  /** Rendered loudness (see `loudnessOf`): every variant is exactly this loud; `level` then sets the mix. */
  loudness: number;
  crack: { width: number; gain: number; spit: number; spitDecay: number; spitCut: number };
  body: { gain: number; attack: number; decay: number; bloom: number; bloomDecay: number; low: number; high: number; centre: number; q: number; boost: number; bite: number; biteGain: number; boom: number; boomGain: number; drive: number };
  thump: { gain: number; from: number; to: number; sweep: number; decay: number; drive: number };
  punch: { gain: number; freq: number; decay: number };
  sub: { gain: number; cutoff: number; decay: number };
  ring: { gain: number; cutoff: number; decay: number; roll?: number };
  mech: ReadonlyArray<{ at: number; gain: number; band: number; modes: readonly Mode[] }>;
  whine?: { gain: number; from: number; to: number; decay: number };
  /** Distant version: no crack or action, a darker longer boom and a rolling low tail. */
  far: { length: number; decay: number; bloom: number; bloomDecay: number; cutoff: number; centre: number; thump: readonly [from: number, to: number, decay: number]; roll: { cutoff: number; decay: number; rate: number; depth: number; gain: number } };
}

export const GUN_DESIGNS: Record<GunVoice, GunDesign> = {
  // KR-5 carbine: the reference rifle. Mid-forward body at 1.1 kHz with a 3.3 kHz bite and a 340 Hz
  // boom, a 78 Hz thump and the bolt carrier's two quick clicks; tight enough that 750 rpm stays a
  // clean, heavy rattle rather than a smear.
  kr5: {
    length: 0.36, peak: 0.95, level: 0.9, glue: 1.5, blast: 0.68, loudness: 0.21,
    crack: { width: 0.00028, gain: 0.8, spit: 0.8, spitDecay: 0.0011, spitCut: 2600 },
    body: { gain: 1, attack: 0.0004, decay: 0.017, bloom: 0.25, bloomDecay: 0.045, low: 120, high: 7500, centre: 1100, q: 0.9, boost: 4, bite: 3300, biteGain: 3, boom: 340, boomGain: 7, drive: 2.2 },
    thump: { gain: 0.48, from: 180, to: 78, sweep: 0.012, decay: 0.026, drive: 2.6 },
    punch: { gain: 0.46, freq: 200, decay: 0.02 },
    sub: { gain: 0.15, cutoff: 110, decay: 0.035 },
    ring: { gain: 0.12, cutoff: 3300, decay: 0.08 },
    mech: [
      { at: 0.008, gain: 0.17, band: 3400, modes: [mode(2650, 1, 0.012), mode(4150, 0.7, 0.009), mode(6900, 0.4, 0.006)] },
      // Carrier closing, with the faint ring of the buffer spring.
      { at: 0.046, gain: 0.11, band: 2500, modes: [mode(2250, 1, 0.016), mode(3650, 0.6, 0.011), mode(1880, 0.25, 0.07)] },
    ],
    far: { length: 1.1, decay: 0.03, bloom: 0.6, bloomDecay: 0.16, cutoff: 1800, centre: 560, thump: [92, 55, 0.08], roll: { cutoff: 700, decay: 0.34, rate: 6, depth: 0.35, gain: 0.45 } },
  },
  // Hornet 9 SMG: lighter and quicker. Brighter body (1.9 kHz, 4.2 kHz bite), 9.5 ms decay, a small
  // 115 Hz thump and a loud open-bolt clack that gives 900 rpm its buzzing rattle.
  hornet9: {
    length: 0.24, peak: 0.88, level: 0.8, glue: 1.7, blast: 0.64, loudness: 0.2,
    crack: { width: 0.00022, gain: 0.75, spit: 0.8, spitDecay: 0.0009, spitCut: 3200 },
    body: { gain: 1, attack: 0.0003, decay: 0.0095, bloom: 0.28, bloomDecay: 0.034, low: 200, high: 9000, centre: 1900, q: 1, boost: 5, bite: 4200, biteGain: 3, boom: 560, boomGain: 5, drive: 2.6 },
    thump: { gain: 0.34, from: 230, to: 115, sweep: 0.009, decay: 0.022, drive: 2.4 },
    punch: { gain: 0.35, freq: 260, decay: 0.018 },
    sub: { gain: 0.06, cutoff: 130, decay: 0.028 },
    ring: { gain: 0.09, cutoff: 4300, decay: 0.05 },
    mech: [
      { at: 0.005, gain: 0.24, band: 2900, modes: [mode(2200, 1, 0.013), mode(3350, 0.8, 0.01), mode(5200, 0.5, 0.007)] },
      { at: 0.033, gain: 0.13, band: 1900, modes: [mode(1650, 1, 0.012), mode(2900, 0.5, 0.008)] },
    ],
    far: { length: 0.9, decay: 0.02, bloom: 0.5, bloomDecay: 0.12, cutoff: 2200, centre: 720, thump: [112, 70, 0.06], roll: { cutoff: 820, decay: 0.24, rate: 7, depth: 0.3, gain: 0.35 } },
  },
  // Breaker 12 pump: the widest, lowest blast. A slower 0.5 ms crack (big bore, lower velocity), a
  // 620 Hz body with a strong 260 Hz boom and a long bloom, a 58 Hz thump and heavy sub pressure.
  breaker12: {
    length: 0.62, peak: 1, level: 1, glue: 1.7, blast: 0.74, loudness: 0.25,
    crack: { width: 0.00055, gain: 0.95, spit: 0.8, spitDecay: 0.0018, spitCut: 1500 },
    body: { gain: 1, attack: 0.0007, decay: 0.032, bloom: 0.5, bloomDecay: 0.11, low: 70, high: 4500, centre: 620, q: 0.7, boost: 4, bite: 2200, biteGain: 1, boom: 260, boomGain: 7, drive: 2.8 },
    thump: { gain: 0.7, from: 150, to: 58, sweep: 0.022, decay: 0.07, drive: 2.8 },
    punch: { gain: 0.5, freq: 160, decay: 0.045 },
    sub: { gain: 0.35, cutoff: 90, decay: 0.12 },
    ring: { gain: 0.15, cutoff: 2300, decay: 0.15 },
    mech: [],
    far: { length: 1.4, decay: 0.05, bloom: 0.8, bloomDecay: 0.26, cutoff: 1300, centre: 380, thump: [80, 40, 0.15], roll: { cutoff: 560, decay: 0.5, rate: 5, depth: 0.4, gain: 0.55 } },
  },
  // Heron 7 bolt rifle: the loudest crack (a supersonic magnum) with a 3.4 kHz bite, an 850 Hz body,
  // the deepest sub and a long rolling dry tail, so every shot reads as a big event across the map.
  longbow: {
    length: 0.85, peak: 1, level: 1, glue: 1.8, blast: 0.78, loudness: 0.23,
    crack: { width: 0.0003, gain: 1.15, spit: 1.5, spitDecay: 0.0018, spitCut: 2000 },
    body: { gain: 1, attack: 0.0004, decay: 0.026, bloom: 0.55, bloomDecay: 0.1, low: 90, high: 8000, centre: 850, q: 0.8, boost: 4, bite: 3400, biteGain: 6, boom: 300, boomGain: 8, drive: 3 },
    thump: { gain: 0.7, from: 160, to: 52, sweep: 0.02, decay: 0.07, drive: 3 },
    punch: { gain: 0.45, freq: 175, decay: 0.04 },
    sub: { gain: 0.42, cutoff: 80, decay: 0.16 },
    ring: { gain: 0.2, cutoff: 2800, decay: 0.22, roll: 7 },
    mech: [],
    far: { length: 1.7, decay: 0.045, bloom: 0.9, bloomDecay: 0.3, cutoff: 1500, centre: 420, thump: [76, 38, 0.16], roll: { cutoff: 620, decay: 0.62, rate: 4, depth: 0.45, gain: 0.6 } },
  },
  // Sentry 9 pistol: a sharp, snappy pop. The brightest firearm body (2.4 kHz), 9 ms decay, a light 120 Hz thump
  // and the slide's back-and-forward clicks.
  sentry9: {
    length: 0.2, peak: 0.9, level: 0.74, glue: 1.7, blast: 0.6, loudness: 0.21,
    crack: { width: 0.00024, gain: 0.85, spit: 0.9, spitDecay: 0.0009, spitCut: 2900 },
    body: { gain: 1, attack: 0.0003, decay: 0.009, bloom: 0.24, bloomDecay: 0.03, low: 260, high: 9500, centre: 2400, q: 1.1, boost: 5, bite: 5200, biteGain: 3, boom: 650, boomGain: 3, drive: 2.4 },
    thump: { gain: 0.28, from: 240, to: 120, sweep: 0.008, decay: 0.02, drive: 2.2 },
    punch: { gain: 0.26, freq: 300, decay: 0.015 },
    sub: { gain: 0.03, cutoff: 140, decay: 0.025 },
    ring: { gain: 0.07, cutoff: 4600, decay: 0.045 },
    mech: [
      { at: 0.011, gain: 0.2, band: 3800, modes: [mode(3100, 1, 0.009), mode(4750, 0.6, 0.007), mode(7300, 0.3, 0.005)] },
      { at: 0.034, gain: 0.16, band: 3200, modes: [mode(2800, 1, 0.011), mode(4300, 0.5, 0.008)] },
    ],
    far: { length: 0.8, decay: 0.018, bloom: 0.45, bloomDecay: 0.1, cutoff: 2300, centre: 760, thump: [122, 80, 0.05], roll: { cutoff: 850, decay: 0.22, rate: 7, depth: 0.3, gain: 0.3 } },
  },
  // Attack Drone gun: small-calibre and mechanical. A narrow 2.9 kHz body, a ringing metal feed clank
  // and a short servo whine set it apart from any player weapon.
  drone: {
    length: 0.2, peak: 0.85, level: 0.7, glue: 1.5, blast: 0.6, loudness: 0.18,
    crack: { width: 0.0002, gain: 0.65, spit: 0.7, spitDecay: 0.0008, spitCut: 3600 },
    body: { gain: 1, attack: 0.0003, decay: 0.0085, bloom: 0.2, bloomDecay: 0.026, low: 450, high: 10000, centre: 2900, q: 1.4, boost: 7, bite: 6000, biteGain: 3, boom: 750, boomGain: 2, drive: 2 },
    thump: { gain: 0.19, from: 280, to: 140, sweep: 0.007, decay: 0.016, drive: 1.6 },
    punch: { gain: 0.15, freq: 340, decay: 0.012 },
    sub: { gain: 0.03, cutoff: 150, decay: 0.02 },
    ring: { gain: 0.06, cutoff: 5200, decay: 0.04 },
    mech: [{ at: 0.004, gain: 0.26, band: 4300, modes: [mode(3600, 1, 0.02), mode(5900, 0.7, 0.014), mode(8100, 0.4, 0.01)] }],
    whine: { gain: 0.06, from: 1300, to: 1080, decay: 0.05 },
    far: { length: 0.7, decay: 0.016, bloom: 0.4, bloomDecay: 0.09, cutoff: 2600, centre: 900, thump: [140, 90, 0.04], roll: { cutoff: 900, decay: 0.2, rate: 8, depth: 0.3, gain: 0.3 } },
  },
};

/** The shot as heard by the shooter or anyone within ~12 m. Variants differ in noise and by a few
 * percent in body centre, decay and timing, so automatic fire never sounds like a loop. */
export function renderGunCore(voice: GunVoice, sampleRate: number, rng: Rng): Float32Array {
  const d = GUN_DESIGNS[voice], blast = samples(d.length, sampleRate);
  const { crack, body, thump, punch, sub, ring } = d;
  // The blast (body and low end) is glued on its own, so its loudness comes up without flattening
  // the crack, which is laid on top afterwards and stays the sharpest, loudest moment of the shot.
  addNoise(blast, sampleRate, rng, {
    attack: body.attack, decay: vary(rng, body.decay, 0.06), bloom: body.bloom, bloomDecay: vary(rng, body.bloomDecay, 0.08),
    gain: body.gain, drive: body.drive, bias: 0.08,
    filters: [
      ['highpass', body.low], ['lowpass', body.high], ['peaking', vary(rng, body.centre, 0.04), body.q, body.boost],
      ['peaking', vary(rng, body.bite, 0.05), 1.2, body.biteGain], ['peaking', body.boom, 0.8, body.boomGain],
    ],
  });
  addTone(blast, sampleRate, { from: vary(rng, thump.from, 0.03), to: thump.to, sweep: thump.sweep, attack: 0.0012, decay: thump.decay, gain: thump.gain, drive: thump.drive, bias: 0.18 });
  addTone(blast, sampleRate, { from: punch.freq * 1.25, to: punch.freq, sweep: 0.006, attack: 0.0008, decay: punch.decay, gain: punch.gain, drive: 1.5 });
  addNoise(blast, sampleRate, rng, { attack: 0.002, decay: sub.decay, gain: sub.gain, filters: [['lowpass', sub.cutoff], ['lowpass', sub.cutoff]] });
  addNoise(blast, sampleRate, rng, { attack: 0.003, decay: ring.decay, gain: ring.gain, filters: [['highpass', 180], ['lowpass', ring.cutoff]], flutter: ring.roll ? { rate: ring.roll, depth: 0.45 } : undefined });
  normalizeRms(blast, sampleRate, BLAST_RMS, 0.03);
  saturate(blast, d.glue);
  const out = blast;
  for (let i = 0; i < out.length; i++) out[i] *= d.blast;
  addNWave(out, sampleRate, { width: vary(rng, crack.width, 0.08), gain: crack.gain });
  addNoise(out, sampleRate, rng, { decay: crack.spitDecay, gain: crack.spit, filters: [['highpass', crack.spitCut], ['highpass', crack.spitCut], ['lowpass', 12000]] });
  for (const event of d.mech) addClack(out, sampleRate, rng, { at: event.at + between(rng, -0.0008, 0.0008), gain: event.gain, band: event.band, modes: event.modes, ring: 0.8 });
  if (d.whine) addTone(out, sampleRate, { from: d.whine.from, to: d.whine.to, sweep: 0.03, attack: 0.002, decay: d.whine.decay, gain: d.whine.gain });
  return finish(out, sampleRate, d.peak, { glue: 1.15, loudness: d.loudness });
}


/** The same gun beyond ~15 m: the crack and the action are lost, a darker boom remains and the
 * buildings return a rolling low tail. Played alongside (and gradually instead of) the close shot. */
export function renderGunFar(voice: GunVoice, sampleRate: number, rng: Rng): Float32Array {
  const f = GUN_DESIGNS[voice].far, out = samples(f.length, sampleRate);
  addNoise(out, sampleRate, rng, {
    attack: 0.0015, decay: f.decay, bloom: f.bloom, bloomDecay: f.bloomDecay, gain: 1, drive: 1.6,
    filters: [['highpass', 70], ['lowpass', f.cutoff], ['lowpass', f.cutoff * 1.3], ['peaking', f.centre, 0.8, 4]],
  });
  addTone(out, sampleRate, { from: f.thump[0], to: f.thump[1], sweep: 0.03, attack: 0.003, decay: f.thump[2], gain: 0.65, drive: 2, bias: 0.15 });
  addNoise(out, sampleRate, rng, {
    at: 0.02, attack: 0.05, decay: f.roll.decay, gain: f.roll.gain,
    filters: [['highpass', 60], ['lowpass', f.roll.cutoff], ['lowpass', f.roll.cutoff]], flutter: { rate: f.roll.rate, depth: f.roll.depth },
  });
  return finish(out, sampleRate, 0.9, { glue: 1.4, fadeOut: 0.05 });
}

/** Pump-action rack (back, forward) and bolt cycle (lift, draw, case out, push, lock). Played after
 * each Breaker 12 or Heron 7 shot for the shooter and nearby players, and for reloads. */
export function renderCycle(kind: 'pump' | 'bolt', sampleRate: number, rng: Rng): Float32Array {
  if (kind === 'pump') {
    const out = samples(0.36, sampleRate);
    addNoise(out, sampleRate, rng, { attack: 0.03, decay: 0.012, length: 0.07, gain: 0.25, filters: [['bandpass', 1900, 0.9]], flutter: { rate: 60, depth: 0.5 } });
    addClack(out, sampleRate, rng, { at: 0.055, gain: 0.85, band: 2200, modes: [mode(1450, 1, 0.025), mode(2650, 0.7, 0.018), mode(4100, 0.4, 0.012)] });
    addNoise(out, sampleRate, rng, { at: 0.085, attack: 0.02, decay: 0.01, length: 0.05, gain: 0.2, filters: [['bandpass', 2300, 1]] });
    addClack(out, sampleRate, rng, { at: 0.13, gain: 1, band: 2000, modes: [mode(1250, 1, 0.03), mode(2350, 0.75, 0.022), mode(3900, 0.45, 0.014), mode(620, 0.3, 0.02)] });
    return finish(out, sampleRate, 0.8);
  }
  const out = samples(0.62, sampleRate);
  addClack(out, sampleRate, rng, { at: 0, gain: 0.5, band: 3200, modes: [mode(3200, 1, 0.008), mode(5100, 0.5, 0.006)] });
  addNoise(out, sampleRate, rng, { at: 0.06, attack: 0.08, decay: 0.012, length: 0.11, gain: 0.3, filters: [['bandpass', 2600, 1]], flutter: { rate: 70, depth: 0.5 } });
  addClack(out, sampleRate, rng, { at: 0.17, gain: 0.8, band: 1900, modes: [mode(1900, 1, 0.02), mode(3400, 0.6, 0.014)] });
  addModes(out, sampleRate, rng, { at: 0.19, gain: 0.12, modes: [mode(5200, 1, 0.05), mode(7900, 0.5, 0.03)] });
  addNoise(out, sampleRate, rng, { at: 0.32, attack: 0.08, decay: 0.012, length: 0.1, gain: 0.25, filters: [['bandpass', 2300, 1]], flutter: { rate: 70, depth: 0.5 } });
  addClack(out, sampleRate, rng, { at: 0.42, gain: 0.9, band: 1600, modes: [mode(1600, 1, 0.025), mode(2900, 0.7, 0.018), mode(4500, 0.3, 0.012)] });
  addClack(out, sampleRate, rng, { at: 0.5, gain: 0.6, band: 2800, modes: [mode(2800, 1, 0.01), mode(4600, 0.5, 0.008)] });
  return finish(out, sampleRate, 0.8);
}

/** Spent cases landing near the shooter: brass ticks on hard ground, a dull tock on wood, a plastic
 * shotgun hull, or almost nothing on grass and sandbags. */
export type CasingKind = 'brass-hard' | 'brass-wood' | 'hull-hard' | 'hull-wood' | 'soft';
export const CASING_KINDS: readonly CasingKind[] = ['brass-hard', 'brass-wood', 'hull-hard', 'hull-wood', 'soft'];
export function casingKind(voice: GunVoice, surface: SurfaceKind): CasingKind {
  if (surface === 'grass' || surface === 'sandbag' || surface === 'fabric') return 'soft';
  const shell = voice === 'breaker12' ? 'hull' : 'brass';
  return surface === 'wood' ? `${shell}-wood` : `${shell}-hard`;
}
export function renderCasing(kind: CasingKind, sampleRate: number, rng: Rng): Float32Array {
  const out = samples(0.4, sampleRate);
  const bounces = kind === 'soft' ? 1 : kind.endsWith('wood') ? 2 : 4;
  let at = 0, level = 1;
  for (let b = 0; b < bounces; b++) {
    if (kind === 'soft') addNoise(out, sampleRate, rng, { at, decay: 0.006, gain: 0.3, filters: [['lowpass', 800]] });
    else if (kind === 'brass-hard') {
      addModes(out, sampleRate, rng, { at, gain: level, modes: [mode(4100, 1, 0.035), mode(6650, 0.7, 0.025), mode(9300, 0.4, 0.018)], detune: 0.03 });
      addNoise(out, sampleRate, rng, { at, decay: 0.0003, gain: level * 0.4, filters: [['bandpass', 6000, 1]] });
    } else if (kind === 'brass-wood') {
      addModes(out, sampleRate, rng, { at, gain: level, modes: [mode(2600, 1, 0.012), mode(4300, 0.5, 0.008)] });
      addNoise(out, sampleRate, rng, { at, decay: 0.004, gain: level * 0.5, filters: [['lowpass', 1200]] });
    } else {
      addModes(out, sampleRate, rng, { at, gain: level, modes: [mode(kind === 'hull-wood' ? 540 : 620, 1, 0.025), mode(1350, 0.6, 0.015), mode(2900, 0.3, 0.01)] });
      addNoise(out, sampleRate, rng, { at, decay: 0.0006, gain: level * 0.5, filters: [['bandpass', 2400, 1]] });
    }
    at += between(rng, 0.07, 0.12) * Math.pow(0.62, b);
    level *= between(rng, 0.45, 0.6);
  }
  return finish(out, sampleRate, kind === 'soft' ? 0.3 : 0.7);
}
