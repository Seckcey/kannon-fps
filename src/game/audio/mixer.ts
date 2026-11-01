import type { Relative } from './spatial';

/** The fixed part of the audio graph, built once when the context is created:
 *
 *   voices ─► world ─► hurt (damage muffle) ─► health (low-health muffle) ─┐
 *   world sends ─► room / street convolvers ─► world                       ├─► limiter ─► master ─► speakers
 *   cues (hit markers, heartbeat, medals) ─► ui ──────────────────────────┘
 *
 * The world can be muffled when hurt while hit markers and the heartbeat stay crisp. The limiter keeps
 * stacked gunfire and explosions from clipping. `master` is the only node that follows the volume. */
export const MASTER_SCALE = 0.8;
export const OPEN_CUTOFF = 20000;
/** Web Audio reads a low-pass Q in dB; -3 dB is the flat Butterworth curve (no bump at the cutoff). */
export const FLAT_Q_DB = -3.01;

export interface Mixer {
  master: GainNode;
  limiter: DynamicsCompressorNode | null;
  ui: GainNode;
  world: GainNode;
  hurt: BiquadFilterNode;
  health: BiquadFilterNode;
  roomSend: GainNode; streetSend: GainNode;
  room: ConvolverNode | null; street: ConvolverNode | null;
  readonly nodes: AudioNode[];
}

export function buildMixer(context: AudioContext, masterGain: number): Mixer {
  const nodes: AudioNode[] = [];
  const keep = <T extends AudioNode>(node: T) => { nodes.push(node); return node; };
  const master = keep(context.createGain());
  master.gain.value = masterGain;
  master.connect(context.destination);
  let limiter: DynamicsCompressorNode | null = null;
  try {
    limiter = keep(context.createDynamicsCompressor());
    limiter.threshold.value = -10; limiter.knee.value = 6; limiter.ratio.value = 8;
    limiter.attack.value = 0.002; limiter.release.value = 0.16;
    limiter.connect(master);
  } catch { limiter = null; }
  const mix: AudioNode = limiter ?? master;
  const ui = keep(context.createGain()); ui.connect(mix);
  const world = keep(context.createGain());
  const hurt = keep(context.createBiquadFilter()), health = keep(context.createBiquadFilter());
  for (const filter of [hurt, health]) { filter.type = 'lowpass'; filter.frequency.value = OPEN_CUTOFF; filter.Q.value = FLAT_Q_DB; }
  world.connect(hurt); hurt.connect(health); health.connect(mix);
  const roomSend = keep(context.createGain()), streetSend = keep(context.createGain());
  const reverb = (send: GainNode) => {
    try {
      const convolver = keep(context.createConvolver());
      // Impulse responses are generated at unit energy; the send level sets the wetness.
      convolver.normalize = false;
      send.connect(convolver); convolver.connect(world);
      return convolver;
    } catch { return null; }
  };
  const room = reverb(roomSend), street = reverb(streetSend);
  return { master, limiter, ui, world, hurt, health, roomSend, streetSend, room, street, nodes };
}

/** Positions one sound: HRTF on desktop (front/back and height cues on headphones), equal-power stereo
 * on phones (far cheaper). Sources are placed relative to the listener, so the AudioListener itself
 * never moves. */
export interface Placement { readonly node: AudioNode; place(rel: Relative, at: number, smoothing?: number): void }
export function createPlacement(context: AudioContext, hrtf: boolean): Placement | null {
  if (hrtf) {
    try {
      const panner = context.createPanner();
      panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse';
      panner.refDistance = 1; panner.maxDistance = 10000; panner.rolloffFactor = 0;
      panner.coneInnerAngle = 360; panner.coneOuterAngle = 360; panner.coneOuterGain = 1;
      return {
        node: panner,
        place(rel, at, smoothing = 0) {
          const d = rel.distance;
          const [x, y, z] = d > 0.25 ? [rel.right / d, rel.up / d, -rel.ahead / d] : [0, 0, -1];
          if (panner.positionX) {
            for (const [param, value] of [[panner.positionX, x], [panner.positionY, y], [panner.positionZ, z]] as const) {
              if (smoothing > 0) param.setTargetAtTime(value, at, smoothing); else param.setValueAtTime(value, at);
            }
          } else panner.setPosition(x, y, z);
        },
      };
    } catch { /* Fall back to stereo. */ }
  }
  try {
    const panner = context.createStereoPanner();
    return {
      node: panner,
      place(rel, at, smoothing = 0) {
        const pan = Math.max(-1, Math.min(1, rel.right / Math.max(1, rel.distance))) * 0.85;
        if (smoothing > 0) panner.pan.setTargetAtTime(pan, at, smoothing); else panner.pan.setValueAtTime(pan, at);
      },
    };
  } catch { return null; }
}

/** A plain stereo pan for sounds without a world position (distant ambience). */
export function createPan(context: AudioContext, pan: number): StereoPannerNode | null {
  try { const node = context.createStereoPanner(); node.pan.value = Math.max(-1, Math.min(1, pan)); return node; } catch { return null; }
}
