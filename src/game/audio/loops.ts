import { createPlacement, FLAT_Q_DB, type Placement } from './mixer';
import type { Relative } from './spatial';
import type { Voice } from './voices';

/** Sounds that run for as long as something is true: the Attack Drone's rotors, the low-health
 * heartbeat and the wind. They live outside the voice cap (there is at most one of each) and every
 * node is disconnected when they stop. */

/** Stops sources after a fade and disconnects nodes when the last one ends, with a timer fallback in
 * case `ended` never arrives. */
function release(context: BaseAudioContext, gain: GainNode, sources: AudioScheduledSourceNode[], nodes: AudioNode[], fade: number) {
  const now = context.currentTime;
  try { gain.gain.cancelScheduledValues(now); gain.gain.setValueAtTime(gain.gain.value, now); gain.gain.linearRampToValueAtTime(0, now + fade); } catch { /* Keep stopping. */ }
  let live = sources.length, done = false;
  const finish = () => {
    if (done) return;
    done = true;
    for (const source of sources) source.onended = null;
    for (const node of nodes) { try { node.disconnect(); } catch { /* Already disconnected. */ } }
  };
  for (const source of sources) {
    source.onended = () => { if (--live <= 0) finish(); };
    try { source.stop(now + fade + 0.02); } catch { /* Already stopped. */ }
  }
  if (!sources.length) finish();
  const timer = setTimeout(finish, (fade + 1) * 1000) as unknown as { unref?: () => void };
  timer.unref?.();
  return finish;
}

/** Quadcopter rotors: two detuned saw waves beating against each other with a blade-rate flutter, plus
 * rotor wash, placed and muffled like any other world sound. */
export class DroneHum {
  private readonly level: GainNode;
  private readonly tone: BiquadFilterNode;
  private readonly placement: Placement | null;
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private stopped = false;
  constructor(private readonly context: AudioContext, output: AudioNode, noise: AudioBuffer | null, hrtf: boolean) {
    const now = context.currentTime, keep = <T extends AudioNode>(node: T) => { this.nodes.push(node); return node; };
    this.level = keep(context.createGain()); this.level.gain.value = 0;
    this.tone = keep(context.createBiquadFilter()); this.tone.type = 'lowpass'; this.tone.frequency.value = 6000; this.tone.Q.value = FLAT_Q_DB;
    const rotor = keep(context.createBiquadFilter()); rotor.type = 'lowpass'; rotor.frequency.value = 1400; rotor.Q.value = FLAT_Q_DB;
    const rotorGain = keep(context.createGain()); rotorGain.gain.value = 0.32;
    for (const frequency of [186, 193]) {
      const oscillator = keep(context.createOscillator()); oscillator.type = 'sawtooth'; oscillator.frequency.value = frequency;
      oscillator.connect(rotor); oscillator.start(now); this.sources.push(oscillator);
    }
    rotor.connect(rotorGain); rotorGain.connect(this.level);
    const flutter = keep(context.createOscillator()); flutter.frequency.value = 23;
    const depth = keep(context.createGain()); depth.gain.value = 0.12;
    flutter.connect(depth); depth.connect(rotorGain.gain); flutter.start(now); this.sources.push(flutter);
    if (noise) {
      const wash = keep(context.createBufferSource()); wash.buffer = noise; wash.loop = true;
      const band = keep(context.createBiquadFilter()); band.type = 'bandpass'; band.frequency.value = 750; band.Q.value = 0.7;
      const washGain = keep(context.createGain()); washGain.gain.value = 0.5;
      wash.connect(band); band.connect(washGain); washGain.connect(this.level); wash.start(now); this.sources.push(wash);
    }
    this.level.connect(this.tone);
    this.placement = createPlacement(context, hrtf);
    if (this.placement) { this.nodes.push(this.placement.node); this.tone.connect(this.placement.node); this.placement.node.connect(output); }
    else this.tone.connect(output);
  }
  /** Follows the drone: level and tone from distance and walls, direction from the listener. */
  update(gain: number, cutoff: number, rel: Relative) {
    if (this.stopped) return;
    const now = this.context.currentTime;
    this.level.gain.setTargetAtTime(gain, now, 0.08);
    this.tone.frequency.setTargetAtTime(cutoff, now, 0.08);
    this.placement?.place(rel, now, 0.05);
  }
  stop() { if (this.stopped) return; this.stopped = true; release(this.context, this.level, this.sources, this.nodes, 0.4); }
  dispose() { this.stopped = true; release(this.context, this.level, this.sources, this.nodes, 0)(); }
}

/** One heartbeat looped from the start of its buffer: a shorter loop is a faster heart at the same
 * pitch. Faster and louder as health drops. */
export class Heartbeat {
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private applied = -1;
  constructor(private readonly context: AudioContext, private readonly output: AudioNode, private readonly buffer: () => AudioBuffer | null) {}
  get playing() { return this.source !== null; }
  /** Severity 0..1: off at 0, 60 → 103 beats a minute and quiet → firm from 0 to 1. */
  set(severity: number) {
    const now = this.context.currentTime;
    if (severity <= 0.02) { this.stop(); this.applied = -1; return; }
    if (!this.source) {
      const buffer = this.buffer();
      if (!buffer) return;
      const gain = this.context.createGain(), source = this.context.createBufferSource();
      gain.gain.value = 0;
      source.buffer = buffer; source.loop = true; source.loopStart = 0; source.loopEnd = Math.min(buffer.duration, 1);
      source.connect(gain); gain.connect(this.output); source.start(now);
      this.source = source; this.gain = gain; this.applied = -1;
    }
    if (Math.abs(severity - this.applied) < 0.01) return;
    this.applied = severity;
    this.source.loopEnd = Math.min(this.source.buffer?.duration ?? 1, 1 - 0.42 * severity);
    this.gain!.gain.setTargetAtTime(0.25 + 0.65 * severity, now, 0.2);
  }
  stop() {
    if (!this.source || !this.gain) return;
    release(this.context, this.gain, [this.source], [this.source, this.gain], 0.35);
    this.source = null; this.gain = null;
  }
  dispose() {
    if (this.source && this.gain) release(this.context, this.gain, [this.source], [this.source, this.gain], 0)();
    this.source = null; this.gain = null;
  }
}

/** The wind bed: a seamless loop through a low-pass whose level and brightness drift between random
 * gust targets. Quieter and duller indoors. */
export class WindBed {
  private readonly source: AudioBufferSourceNode;
  private readonly filter: BiquadFilterNode;
  private readonly gain: GainNode;
  private readonly nodes: AudioNode[];
  private indoors = false;
  private gust = 0.5;
  private stopped = false;
  constructor(private readonly context: AudioContext, output: AudioNode, wind: AudioBuffer, indoors: boolean) {
    const now = context.currentTime;
    this.source = context.createBufferSource(); this.source.buffer = wind; this.source.loop = true;
    this.filter = context.createBiquadFilter(); this.filter.type = 'lowpass'; this.filter.Q.value = FLAT_Q_DB;
    this.gain = context.createGain(); this.gain.gain.value = 0;
    this.source.connect(this.filter); this.filter.connect(this.gain); this.gain.connect(output);
    this.nodes = [this.source, this.filter, this.gain];
    this.indoors = indoors;
    this.filter.frequency.value = this.cutoff();
    this.source.start(now, Math.random() * Math.max(0, wind.duration - 0.1));
    this.gain.gain.setTargetAtTime(this.level(), now, 1.2);
  }
  private level() { return (0.05 + 0.07 * this.gust) * (this.indoors ? 0.35 : 1); }
  private cutoff() { return (320 + 520 * this.gust) * (this.indoors ? 0.5 : 1); }
  setIndoors(indoors: boolean) {
    if (this.stopped || indoors === this.indoors) return;
    this.indoors = indoors;
    const now = this.context.currentTime;
    this.gain.gain.setTargetAtTime(this.level(), now, 0.4);
    this.filter.frequency.setTargetAtTime(this.cutoff(), now, 0.4);
  }
  /** Drifts toward a new gust strength over a couple of seconds. */
  drift(random: () => number) {
    if (this.stopped) return;
    this.gust = random();
    const now = this.context.currentTime;
    this.gain.gain.setTargetAtTime(this.level(), now, 1.4);
    this.filter.frequency.setTargetAtTime(this.cutoff(), now, 1.6);
  }
  stop() { if (this.stopped) return; this.stopped = true; release(this.context, this.gain, [this.source], this.nodes, 0.8); }
  dispose() { this.stopped = true; release(this.context, this.gain, [this.source], this.nodes, 0)(); }
}

/** A helicopter crossing far off: low-passed noise chopped by a ~12 Hz blade rate, a faint turbine
 * whine, panning across the sky as it swells and fades. Returned as a pooled low-priority voice. */
export function helicopterPass(context: AudioContext, output: AudioNode, noise: AudioBuffer, random: () => number, level: number, seconds = 16): Voice {
  const now = context.currentTime, nodes: AudioNode[] = [], keep = <T extends AudioNode>(node: T) => { nodes.push(node); return node; };
  const source = keep(context.createBufferSource()); source.buffer = noise; source.loop = true;
  const low = keep(context.createBiquadFilter()); low.type = 'lowpass'; low.frequency.value = 380; low.Q.value = 1;
  const chop = keep(context.createGain()); chop.gain.value = 0.55;
  const blades = keep(context.createOscillator()); blades.frequency.value = 10.5 + random() * 2.5;
  const depth = keep(context.createGain()); depth.gain.value = 0.45;
  const turbine = keep(context.createOscillator()); turbine.frequency.value = 1100 + random() * 150;
  const whine = keep(context.createGain()); whine.gain.value = 0.035;
  const envelope = keep(context.createGain());
  const from = random() < 0.5 ? -0.9 : 0.9;
  let tail: AudioNode = envelope;
  try {
    const pan = keep(context.createStereoPanner());
    pan.pan.setValueAtTime(from, now); pan.pan.linearRampToValueAtTime(-from, now + seconds);
    envelope.connect(pan); tail = pan;
  } catch { /* Unpanned is fine. */ }
  source.connect(low); low.connect(chop); blades.connect(depth); depth.connect(chop.gain); chop.connect(envelope);
  turbine.connect(whine); whine.connect(envelope); tail.connect(output);
  envelope.gain.setValueAtTime(0, now);
  envelope.gain.linearRampToValueAtTime(level, now + seconds * 0.45);
  envelope.gain.linearRampToValueAtTime(0, now + seconds);
  const sources = [source, blades, turbine];
  for (const s of sources) { s.start(now); s.stop(now + seconds); }
  return { priority: 0, createdAt: now, endsAt: now + seconds, gain: envelope, nodes, sources, live: sources.length, done: false };
}
