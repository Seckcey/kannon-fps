import type { StreakId, SurfaceKind, Vec3, WeaponId } from '../../shared/protocol';
import { surfaceAt } from '../../shared/map';
import { WEAPONS } from '../../shared/weapons';
import { SoundBank } from './audio/bank';
import { ALL_SOUNDS, type SoundKey } from './audio/catalog';
import { createRng, hashSeed } from './audio/dsp';
import { reloadSize, type ReloadStep } from './audio/foley';
import { casingKind, GUN_DESIGNS, GUN_VOICES, isGunVoice, type GunVoice } from './audio/guns';
import { DroneHum, Heartbeat, helicopterPass, WindBed } from './audio/loops';
import { buildMixer, createPan, createPlacement, FLAT_Q_DB, MASTER_SCALE, OPEN_CUTOFF, type Mixer } from './audio/mixer';
import { REVERB_SECONDS, roomImpulse, streetImpulse, type ImpulseResponse } from './audio/reverb';
import {
  airCutoff, behind, coveredAbove, falloffGain, finite, finitePoint, nearFarMix, occlusion, relative, SPEED_OF_SOUND, towardListener,
  wetDistance, type Falloff, type ListenerPose, type Relative,
} from './audio/spatial';
import { isSurface, surfaceClass } from './audio/surfaces';
import { PRIORITY, VoicePool, type Voice } from './audio/voices';

export type { ReloadStep } from './audio/foley';
export type AudioQuality = 'phone' | 'desktop';
export interface GameAudioOptions {
  /** Phones get equal-power panning, shorter reverbs and fewer variants. Detected from the pointer
   * (coarse = phone or tablet) when omitted; GameView may pass its render tier's `effects`. */
  quality?: AudioQuality;
  /** Render the common sounds in small steps after unlocking so the first shot never stutters (default on). */
  warmup?: boolean;
}

type BrowserAudioSession = { type: string };
const unlockEvents = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const RELOAD_STEPS: readonly ReloadStep[] = ['mag-out', 'mag-in', 'bolt', 'shell', 'pump'];
const STREAK_REWARDS: readonly StreakId[] = ['recon', 'mortar', 'drone'];
const DISTANT_WEAPONS: readonly WeaponId[] = ['kr5', 'kr5', 'hornet9', 'sentry9', 'longbow', 'breaker12'];
/** Rendered ahead of time after unlock, most urgent first, then everything else, so no sound has to be
 * rendered mid-match (an explosion takes ~10 ms to render on a desktop, longer on a phone). */
const URGENT: readonly SoundKey[] = [
  ...GUN_VOICES.map(voice => `gun:${voice}` as const), 'ui:hit', 'ui:head', 'ui:kill', 'flyby',
  'step:asphalt', 'step:wood', 'step:concrete', 'step:grass', 'impact:concrete', 'impact:asphalt', 'impact:wood', 'impact:flesh', 'impact:metal',
  ...GUN_VOICES.map(voice => `far:${voice}` as const), 'explosion:frag', 'cycle:pump', 'cycle:bolt', 'casing:brass-hard', 'casing:brass-wood',
  'reload:mag-out:rifle', 'reload:mag-in:rifle', 'reload:bolt:rifle', 'reload:mag-out:pistol', 'reload:mag-in:pistol', 'aim:in', 'aim:out', 'swap',
  'land', 'slide:hard', 'gear', 'ui:damage', 'ui:heartbeat', 'explosion:mortar', 'whistle', 'wind', 'noise', 'countdown:tick', 'countdown:final', 'respawn',
];
const WARM: readonly SoundKey[] = [...new Set([...URGENT, ...ALL_SOUNDS])];

interface Layer { key: SoundKey; gain?: number; delay?: number; rate?: number }
interface Sound {
  layers: Layer[];
  /** Source level before distance and walls. */
  gain: number;
  priority: number;
  /** 'ui' cues skip the world muffling and reverb. */
  bus?: 'world' | 'ui';
  /** World position; omitted for sounds at the listener (own gun, own steps, handling). */
  at?: Vec3;
  falloff?: Falloff;
  /** Reverb send relative to the source level. */
  wet?: number;
  /** Arrives distance ÷ speed of sound later. */
  delayed?: boolean;
  /** Muffled by walls between the source and the listener. */
  occlude?: boolean;
  /** Random speed (and pitch) spread, as a fraction. */
  jitter?: number;
  /** For far-off ambience without a position: fixed stereo pan and tone, street reverb. */
  pan?: number; cutoff?: number; distant?: boolean;
}

function detectQuality(): AudioQuality {
  try { return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 'phone' : 'desktop'; }
  catch { return 'desktop'; }
}

/** Procedural combat audio. Every sound is synthesised in code (see `src/game/audio/`), rendered once
 * into a buffer and played through a small spatial graph: distance low-pass and speed-of-sound delay,
 * wall occlusion, HRTF (desktop) or equal-power (phone) panning, and generated room or street
 * reverb. At most 32 sounds play at once. Audio is only created after an intentional gesture, every
 * method is safe before that and after `dispose`, and nothing here ever throws into the game loop. */
export class GameAudio {
  readonly quality: AudioQuality;
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private mixer: Mixer | null = null;
  private bank: SoundBank | null = null;
  private readonly pool = new VoicePool();
  private volume = 0.65;
  private disposed = false;
  private session: BrowserAudioSession | null = null;
  private previousSessionType = 'auto';
  private readonly listener: ListenerPose = { x: 0, y: 0, z: 0, yaw: 0, indoors: false };
  private readonly warmup: boolean;
  private readonly random = Math.random;
  private readonly recent = new Map<string, number>();
  /** Loops whose nodes this browser could not create; not retried every frame. */
  private readonly broken = new Set<'drone' | 'wind'>();
  private impactTimes: number[] = [];
  private localSurface: SurfaceKind = 'asphalt';
  private reverbReady = false;
  private warmupQueue: Array<() => void> = [];
  private warmupTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSweep = 0;
  private droneTarget: Vec3 | null = null;
  private droneHum: DroneHum | null = null;
  private droneUpdatedAt = -Infinity;
  private lowHealthLevel = 0;
  private appliedLowHealth = 0;
  private heartbeat: Heartbeat | null = null;
  private ambienceWanted = false;
  private wind: WindBed | null = null;
  private nextGust = 0; private nextVolley = 0; private nextBarrage = 0; private nextHelicopter = 0;
  private unlockListener = () => { void this.unlock(); };

  constructor(volume = 0.65, options: GameAudioOptions = {}) {
    this.quality = options.quality ?? detectQuality();
    this.warmup = options.warmup ?? true;
    this.setVolume(volume);
    // Touch activation is granted on release, unlike a mouse press. Capture
    // also reaches taps whose gameplay handler suppresses the browser click.
    for (const event of unlockEvents) window.addEventListener(event, this.unlockListener, { capture: true, passive: true });
  }

  async unlock() {
    if (this.disposed || document.hidden) return;
    try {
      if (!this.session && this.volume > 0) {
        // Safari otherwise routes Web Audio through the ringer/silent switch.
        const session = (navigator as Navigator & { audioSession?: BrowserAudioSession }).audioSession;
        if (session) {
          try { const previousType = session.type; session.type = 'playback'; this.previousSessionType = previousType; this.session = session; }
          catch { /* An optional routing API must never block regular audio. */ }
        }
      }
      if (!this.context) {
        this.context = new AudioContext();
        this.build(this.context);
      }
      // Safari can report interrupted after an app switch or phone call.
      if (this.context.state !== 'running' && this.context.state !== 'closed') await this.context.resume();
    } catch { /* Audio may be unavailable; gameplay still works. */ }
  }

  /** Pauses all sound while the page is hidden. Frames are what update and stop the loops, and frames
   * stop in a hidden page, so otherwise the heartbeat, wind and drone hum would play on unchanged, and
   * the distant gunfire, barrages and helicopters due meanwhile would all start together on return.
   * A suspended context also stops its clock. `resume()` undoes it. */
  suspend() {
    try { if (this.context?.state === 'running') void this.context.suspend().catch(() => {}); }
    catch { /* Pausing is best effort. */ }
  }

  /** The page is shown again: resumes the sound paused by `suspend()`. Only a context that already
   * exists is resumed; before the first tap or click there is none, and `unlock()` makes it then, as
   * browsers require. A phone that refuses to resume without a tap resumes on the next one. */
  resume() {
    if (this.disposed || document.hidden) return;
    try {
      const context = this.context;
      if (context && context.state !== 'running' && context.state !== 'closed') void context.resume().catch(() => {});
    } catch { /* The next tap resumes it. */ }
  }

  setVolume(volume: number) {
    if (!finite(volume)) return;
    this.volume = Math.max(0, Math.min(1, volume));
    try { if (this.master && this.context) this.master.gain.setTargetAtTime(this.volume * MASTER_SCALE, this.context.currentTime, 0.03); }
    catch { /* Volume applies to the next sound. */ }
  }

  /** Listener pose for spatial sound; GameView calls this every frame. It also drives the sound
   * housekeeping (overdue voices, ambience events, loops waiting for an unlocked context). */
  setListener(position: Vec3, yaw: number, _pitch: number, indoors: boolean) {
    this.guard(() => {
      if (finitePoint(position)) { this.listener.x = position.x; this.listener.y = position.y; this.listener.z = position.z; }
      if (finite(yaw)) this.listener.yaw = yaw;
      const inside = indoors === true;
      if (inside !== this.listener.indoors) { this.listener.indoors = inside; this.wind?.setIndoors(inside); }
      this.tick();
    });
  }

  /** Sounds currently playing (at most 32). */
  get voiceCount() { return this.pool.count; }

  /** A gunshot. Local shots play at the ears with the action cycling and cases landing; other shots
   * come from `position`, blend toward the distant boom with range and arrive at the speed of sound. */
  shot(weapon: WeaponId | 'drone', position: Vec3, local: boolean) {
    this.guard(() => {
      const voice: GunVoice = isGunVoice(weapon) ? weapon : 'kr5', design = GUN_DESIGNS[voice];
      const cycle = voice === 'breaker12' ? { key: 'cycle:pump' as const, delay: 0.3 } : voice === 'longbow' ? { key: 'cycle:bolt' as const, delay: 0.42 } : null;
      if (local) {
        this.play({ layers: [{ key: `gun:${voice}` }, ...(cycle ? [{ ...cycle, gain: 0.55 }] : [])], gain: design.level, priority: PRIORITY.critical, wet: 0.45, jitter: 0.02 });
        this.casing(voice);
        return;
      }
      if (!finitePoint(position)) return;
      const distance = relative(this.listener, position).distance, mix = nearFarMix(distance);
      const layers: Layer[] = [{ key: `gun:${voice}`, gain: mix.near }, { key: `far:${voice}`, gain: mix.far }];
      if (cycle && distance < 14) layers.push({ ...cycle, gain: 0.5 * (1 - distance / 14) });
      this.play({ layers, gain: design.level * 0.92, priority: PRIORITY.combat, at: position, falloff: 'gun', wet: 0.4, delayed: true, occlude: true, jitter: 0.03 });
    });
  }

  impact(surface: SurfaceKind | 'flesh', position: Vec3) {
    this.guard(() => {
      const context = this.running();
      if (!context || !finitePoint(position)) return;
      // Shotgun pellets land together; three impacts per 40 ms already read as one burst.
      const now = context.currentTime;
      this.impactTimes = this.impactTimes.filter(time => time <= now && now - time < 0.04);
      if (this.impactTimes.length >= 3) return;
      this.impactTimes.push(now);
      const kind = surface === 'flesh' || isSurface(surface) ? surface : 'concrete';
      this.play({ layers: [{ key: `impact:${kind}` }], gain: kind === 'flesh' ? 0.6 : 0.75, priority: PRIORITY.detail, at: position, falloff: 'impact', wet: 0.3, delayed: true, occlude: true, jitter: 0.06 });
    });
  }

  /** A bullet passing close by: the supersonic crack. `position` is the closest point of its path. */
  flyby(position: Vec3) {
    this.guard(() => {
      if (!this.running() || !finitePoint(position) || !this.throttle('flyby', 0.05)) return;
      this.play({ layers: [{ key: 'flyby' }], gain: 0.8, priority: PRIORITY.combat, at: position, falloff: 'flyby', wet: 0.12, jitter: 0.08 });
    });
  }

  /** `loudness` 0..1 (speed, Quiet Step at 0.3); remote steps are louder than your own, as in the genre. */
  footstep(surface: SurfaceKind, position: Vec3, local: boolean, loudness: number) {
    this.guard(() => {
      const level = finite(loudness) ? clamp(loudness, 0, 1.5) : 0;
      if (level < 0.02) return;
      const kind = isSurface(surface) ? surface : 'concrete';
      const layers: Layer[] = [{ key: `step:${kind}` }];
      if (level >= 0.9 && this.random() < 0.35) layers.push({ key: 'gear', gain: 0.55 });
      if (local) { this.localSurface = kind; this.play({ layers, gain: 0.3 * level, priority: PRIORITY.detail, wet: 0.16, jitter: 0.06 }); }
      else if (finitePoint(position)) this.play({ layers, gain: 0.85 * level, priority: PRIORITY.detail, at: lift(position, 0.3), falloff: 'step', wet: 0.2, delayed: true, occlude: true, jitter: 0.06 });
    });
  }

  /** `intensity` 0..1 (a hard landing is 1). The surface comes from the map under `position`. */
  land(position: Vec3, local: boolean, intensity: number) {
    this.guard(() => {
      const strength = finite(intensity) ? clamp(intensity, 0, 1.5) : 0;
      if (strength < 0.05) return;
      const surface = this.surfaceUnder(position);
      const layers: Layer[] = [{ key: 'land', gain: 0.45 + 0.55 * Math.min(1, strength) }, { key: `step:${surface}`, gain: 0.8 }];
      const level = 0.6 + 0.4 * Math.min(1, strength);
      if (local) { this.localSurface = surface; this.play({ layers, gain: 0.5 * level, priority: PRIORITY.combat, wet: 0.15, jitter: 0.05 }); }
      else if (finitePoint(position)) this.play({ layers, gain: 0.85 * level, priority: PRIORITY.detail, at: lift(position, 0.3), falloff: 'step', wet: 0.2, delayed: true, occlude: true, jitter: 0.05 });
    });
  }

  slide(position: Vec3, local: boolean) {
    this.guard(() => {
      const kind = surfaceClass(this.surfaceUnder(position)) === 'soft' ? 'slide:soft' : 'slide:hard';
      if (local) this.play({ layers: [{ key: kind }], gain: 0.55, priority: PRIORITY.combat, wet: 0.12, jitter: 0.05 });
      else if (finitePoint(position)) this.play({ layers: [{ key: kind }], gain: 0.75, priority: PRIORITY.detail, at: lift(position, 0.3), falloff: 'foley', wet: 0.15, delayed: true, occlude: true, jitter: 0.05 });
    });
  }

  /** Vault foley. Remote vaults need `position` to be placed; without one they play faintly. */
  vault(local: boolean, position?: Vec3) {
    this.guard(() => {
      if (local) this.play({ layers: [{ key: 'vault' }], gain: 0.5, priority: PRIORITY.combat, wet: 0.12, jitter: 0.05 });
      else if (finitePoint(position)) this.play({ layers: [{ key: 'vault' }], gain: 0.7, priority: PRIORITY.detail, at: lift(position, 0.5), falloff: 'foley', wet: 0.15, delayed: true, occlude: true, jitter: 0.05 });
      else this.play({ layers: [{ key: 'vault' }], gain: 0.12, priority: PRIORITY.ambient, wet: 0.1, jitter: 0.05 });
    });
  }

  /** Reload choreography for the local weapon. Pump and Heron 7 bolt reuse the shot cycle sounds. */
  reloadStep(weapon: WeaponId, step: ReloadStep) {
    this.guard(() => {
      if (!RELOAD_STEPS.includes(step)) return;
      const size = WEAPONS[weapon] ? reloadSize(weapon) : 'rifle';
      const key: SoundKey = step === 'pump' ? 'cycle:pump' : step === 'bolt' && size === 'sniper' ? 'cycle:bolt' : `reload:${step}:${size}`;
      this.play({ layers: [{ key }], gain: 0.55, priority: PRIORITY.combat, wet: 0.08, jitter: 0.03 });
    });
  }

  aim(entering: boolean) {
    this.guard(() => {
      if (!this.running() || !this.throttle('aim', 0.08)) return;
      this.play({ layers: [{ key: entering ? 'aim:in' : 'aim:out' }], gain: entering ? 0.4 : 0.32, priority: PRIORITY.detail, wet: 0.05, jitter: 0.04 });
    });
  }

  swap() { this.guard(() => { this.play({ layers: [{ key: 'swap' }], gain: 0.5, priority: PRIORITY.combat, wet: 0.06, jitter: 0.04 }); }); }

  dryFire() {
    this.guard(() => {
      if (!this.running() || !this.throttle('dry', 0.09)) return;
      this.play({ layers: [{ key: 'dry' }], gain: 0.55, priority: PRIORITY.combat, wet: 0.04, jitter: 0.03 });
    });
  }

  /** Knife swing, with a dull hit on contact. Pass `position` for someone else's swing. */
  melee(hit: boolean, position?: Vec3) {
    this.guard(() => {
      const layers: Layer[] = [{ key: 'melee:swing' }, ...(hit ? [{ key: 'melee:hit' as const, delay: 0.085 }] : [])];
      if (finitePoint(position)) this.play({ layers, gain: 0.7, priority: PRIORITY.detail, at: lift(position, 1.2), falloff: 'foley', wet: 0.15, delayed: true, occlude: true, jitter: 0.06 });
      else this.play({ layers, gain: 0.65, priority: PRIORITY.combat, wet: 0.08, jitter: 0.06 });
    });
  }

  hitMarker(kind: 'hit' | 'head' | 'kill') {
    this.guard(() => {
      const marker = kind === 'head' || kind === 'kill' ? kind : 'hit';
      if (!this.running() || (marker === 'hit' && !this.throttle('hit', 0.035))) return;
      this.play({ layers: [{ key: `ui:${marker}` }], gain: marker === 'kill' ? 0.8 : 0.65, priority: PRIORITY.critical, bus: 'ui' });
    });
  }

  /** Taking damage (`amount` in health points): a body thud and a moment of muffled hearing. */
  damage(amount: number) {
    this.guard(() => {
      if (!this.running()) return;
      const strength = finite(amount) ? clamp(amount / 70, 0.2, 1) : 0.4;
      this.play({ layers: [{ key: 'ui:damage' }], gain: 0.35 + 0.45 * strength, priority: PRIORITY.critical, bus: 'ui', jitter: 0.05 });
      this.muffle(strength, 0.25);
    });
  }

  /** Low-health severity 0..1 (the same value as `Presentation.setCondition`'s `lowHealth`; 0 when
   * healthy or eliminated). Muffles and quietens the world and brings in a heartbeat. Cheap to call
   * every frame. */
  lowHealth(amount: number) {
    this.guard(() => {
      this.lowHealthLevel = finite(amount) ? clamp(amount, 0, 1) : 0;
      this.applyLowHealth();
    });
  }

  /** `impact` is the bounce speed in m/s (from `stepGrenade`). */
  grenadeBounce(position: Vec3, impact: number) {
    this.guard(() => {
      if (!finitePoint(position) || !finite(impact) || impact < 0.5) return;
      const strength = clamp((impact - 1) / 12, 0.12, 1);
      const kind = surfaceClass(this.surfaceUnder(position)) === 'soft' ? 'bounce:soft' : 'bounce:hard';
      this.play({ layers: [{ key: kind }], gain: 0.75 * strength, priority: PRIORITY.detail, at: position, falloff: 'impact', wet: 0.2, delayed: true, occlude: true, jitter: 0.08 });
    });
  }

  grenadePin() { this.guard(() => { this.play({ layers: [{ key: 'pin' }], gain: 0.5, priority: PRIORITY.combat, wet: 0.05, jitter: 0.03 }); }); }

  /** An explosion. Close and in the open, it also leaves the ears ringing and dulls the world. */
  explosion(position: Vec3, kind: 'frag' | 'mortar' | 'drone') {
    this.guard(() => {
      if (!this.running() || !finitePoint(position)) return;
      const blast = kind === 'mortar' || kind === 'drone' ? kind : 'frag';
      const at = lift(position, 0.3);
      this.play({ layers: [{ key: `explosion:${blast}` }], gain: blast === 'mortar' ? 1 : blast === 'drone' ? 0.8 : 0.95, priority: PRIORITY.critical, at, falloff: 'explosion', wet: 0.6, delayed: true, occlude: true, jitter: 0.04 });
      const distance = relative(this.listener, at).distance;
      if (distance < 7 && occlusion(this.listener, towardListener(this.listener, at, 0.25)) < 0.5) {
        const closeness = 1 - distance / 7;
        this.play({ layers: [{ key: 'ui:ring', delay: distance / SPEED_OF_SOUND }], gain: 0.15 + 0.45 * closeness, priority: PRIORITY.critical, bus: 'ui' });
        this.muffle(0.6 + 0.4 * closeness, 0.6 + 0.8 * closeness);
      }
    });
  }

  /** An incoming mortar shell over `position` (its target). The whistle lasts 1.6 s, so play it that
   * long before the impact. */
  mortarWhistle(position: Vec3) {
    this.guard(() => {
      if (!finitePoint(position)) return;
      this.play({ layers: [{ key: 'whistle' }], gain: 0.75, priority: PRIORITY.critical, at: lift(position, 6), falloff: 'whistle', wet: 0.25, jitter: 0.03 });
    });
  }

  /** The nearest Attack Drone's position each frame, or null when there is none. */
  drone(position: Vec3 | null) {
    this.guard(() => {
      this.droneTarget = finitePoint(position) ? { x: position.x, y: position.y, z: position.z } : null;
      this.updateDrone();
    });
  }

  streak(kind: 'earned' | 'used', reward: StreakId) {
    this.guard(() => {
      if (!STREAK_REWARDS.includes(reward)) return;
      this.play({ layers: [{ key: `streak:${kind === 'used' ? 'used' : 'earned'}:${reward}` }], gain: 0.55, priority: PRIORITY.critical, bus: 'ui' });
    });
  }

  medal() {
    this.guard(() => {
      if (!this.running() || !this.throttle('medal', 0.25)) return;
      this.play({ layers: [{ key: 'medal' }], gain: 0.42, priority: PRIORITY.critical, bus: 'ui' });
    });
  }

  respawn() { this.guard(() => { this.play({ layers: [{ key: 'respawn' }], gain: 0.5, priority: PRIORITY.critical, bus: 'ui' }); }); }

  countdown(final: boolean) {
    this.guard(() => { this.play({ layers: [{ key: final ? 'countdown:final' : 'countdown:tick' }], gain: 0.5, priority: PRIORITY.critical, bus: 'ui' }); });
  }

  /** The background bed during a match: wind, far-off gunfire and artillery, now and then a helicopter. */
  ambience(active: boolean) {
    this.guard(() => {
      this.ambienceWanted = active === true;
      if (this.ambienceWanted) this.startAmbience();
      else { this.wind?.stop(); this.wind = null; }
    });
  }

  dispose() {
    this.disposed = true;
    for (const event of unlockEvents) window.removeEventListener(event, this.unlockListener, true);
    if (this.warmupTimer !== null) { clearTimeout(this.warmupTimer); this.warmupTimer = null; }
    this.warmupQueue = [];
    for (const stop of [() => this.pool.clear(), () => this.droneHum?.dispose(), () => this.heartbeat?.dispose(), () => this.wind?.dispose()]) {
      try { stop(); } catch { /* Keep releasing the rest. */ }
    }
    for (const node of this.mixer?.nodes ?? []) { try { node.disconnect(); } catch { /* Already disconnected. */ } }
    try { void this.context?.close().catch(() => {}); } catch { /* Closing is best effort. */ }
    if (this.session?.type === 'playback') { try { this.session.type = this.previousSessionType; } catch { /* Optional browser routing. */ } }
    this.bank?.clear();
    this.session = null; this.context = null; this.master = null; this.mixer = null; this.bank = null;
    this.droneHum = null; this.heartbeat = null; this.wind = null; this.droneTarget = null;
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────

  private build(context: AudioContext) {
    this.mixer = buildMixer(context, this.volume * MASTER_SCALE);
    this.master = this.mixer.master;
    this.bank = new SoundBank(context, this.quality === 'phone', this.random);
    // Chrome loads its HRTF data on first use and plays HRTF voices silent until then: start it now.
    if (this.quality === 'desktop') { try { const panner = context.createPanner(); panner.panningModel = 'HRTF'; this.mixer.nodes.push(panner); } catch { /* Stereo fallback. */ } }
    if (this.warmup) this.queueWarmup();
  }

  /** The context when sound can play now (unlocked, running, not muted), otherwise null. */
  private running(): AudioContext | null {
    const context = this.context;
    return !this.disposed && context && this.mixer && this.bank && context.state === 'running' && this.volume > 0 ? context : null;
  }

  /** Audio must never break the game loop: failures are dropped sounds, not exceptions. */
  private guard(action: () => void) {
    if (this.disposed) return;
    try { action(); } catch { /* A sound that cannot play is skipped. */ }
  }

  /** False when `name` played less than `seconds` ago (context time). */
  private throttle(name: string, seconds: number): boolean {
    const now = this.context?.currentTime ?? 0, last = this.recent.get(name);
    if (last !== undefined && now >= last && now - last < seconds) return false;
    this.recent.set(name, now);
    return true;
  }

  private surfaceUnder(position: Vec3): SurfaceKind {
    if (!finitePoint(position)) return this.localSurface;
    try { const surface = surfaceAt(position); return isSurface(surface) ? surface : 'asphalt'; } catch { return 'asphalt'; }
  }

  /** How much of each reverb a sound gets: rooms for sounds made indoors, the street outside. */
  private space(at: Vec3 | undefined, distant: boolean): { room: number; street: number } {
    const inside = this.listener.indoors;
    if (distant) return { room: inside ? 0.2 : 0, street: 1 };
    if (!at) return inside ? { room: 1.4, street: 0.15 } : { room: 0, street: 1 };
    const sourceInside = coveredAbove(at);
    if (sourceInside && inside) return { room: 1.2, street: 0.1 };
    if (sourceInside) return { room: 0.7, street: 0.6 };
    if (inside) return { room: 0.35, street: 0.5 };
    return { room: 0, street: 1 };
  }

  /** Plays one sound (several buffers sharing one voice) through the spatial chain:
   * sources → voice gain → distance/occlusion low-pass → panner → world, with reverb sends taken
   * after the low-pass and scaled back up by the dry attenuation, so far sounds are wetter. */
  private play(sound: Sound): Voice | null {
    const context = this.running();
    if (!context || !this.mixer || !this.bank) return null;
    const mixer = this.mixer, now = context.currentTime, world = sound.bus !== 'ui';
    let dry = 1, cutoff = sound.cutoff ?? OPEN_CUTOFF, delay = 0, wet = world ? sound.wet ?? 0 : 0, rel: Relative | null = null;
    if (sound.at) {
      rel = relative(this.listener, sound.at);
      const falloff = sound.falloff ?? 'foley';
      dry = falloffGain(falloff, rel.distance);
      if (dry <= 0) return null;
      cutoff = Math.min(cutoff, airCutoff(falloff, rel.distance));
      if (sound.occlude) {
        const blocked = occlusion(this.listener, towardListener(this.listener, sound.at, 0.25));
        dry *= 1 - 0.5 * blocked; cutoff *= 1 - 0.75 * blocked; wet *= 1 + 0.6 * blocked;
      }
      // Stereo cannot place sounds behind you; a duller tone does, cheaply (HRTF does it on desktop).
      if (this.quality === 'phone') cutoff *= 1 - 0.3 * behind(rel);
      if (sound.delayed) delay = rel.distance / SPEED_OF_SOUND;
      wet *= wetDistance(rel.distance);
    }
    const level = sound.gain;
    if (!(level > 0) || Math.max(level * dry, level * wet) < 0.002) return null;
    const spread = sound.jitter ? 1 + (this.random() * 2 - 1) * sound.jitter : 1;
    const picks: Array<{ layer: Layer; buffer: AudioBuffer; rate: number }> = [];
    for (const layer of sound.layers) {
      if (!((layer.gain ?? 1) > 0.01)) continue;
      const buffer = this.bank.pick(layer.key);
      if (buffer) picks.push({ layer, buffer, rate: clamp(spread * (layer.rate ?? 1), 0.25, 4) });
    }
    if (!picks.length || !this.pool.reserve(sound.priority, now)) return null;

    const nodes: AudioNode[] = [], sources: AudioBufferSourceNode[] = [];
    try { return this.assemble(context, mixer, sound, picks, nodes, sources, { now, dry, cutoff, delay, wet, rel, world, level }); }
    catch (error) {
      // Never leave half a voice behind: release whatever was made, then let guard() drop the sound.
      for (const source of sources) { source.onended = null; try { source.stop(); } catch { /* Not started. */ } }
      for (const node of nodes) { try { node.disconnect(); } catch { /* Not connected. */ } }
      throw error;
    }
  }

  private assemble(
    context: AudioContext, mixer: Mixer, sound: Sound, picks: Array<{ layer: Layer; buffer: AudioBuffer; rate: number }>,
    nodes: AudioNode[], sources: AudioBufferSourceNode[],
    { now, dry, cutoff, delay, wet, rel, world, level }: { now: number; dry: number; cutoff: number; delay: number; wet: number; rel: Relative | null; world: boolean; level: number },
  ): Voice {
    const gain = context.createGain();
    nodes.push(gain);
    gain.gain.value = clamp(level * dry, 0, 4);
    let endsAt = now;
    for (const { layer, buffer, rate } of picks) {
      const source = context.createBufferSource();
      source.buffer = buffer; source.playbackRate.value = rate;
      nodes.push(source); sources.push(source);
      const trim = layer.gain ?? 1;
      if (Math.abs(trim - 1) > 0.01) { const node = context.createGain(); nodes.push(node); node.gain.value = trim; source.connect(node); node.connect(gain); }
      else source.connect(gain);
      const start = now + delay + Math.max(0, layer.delay ?? 0);
      source.start(start);
      endsAt = Math.max(endsAt, start + buffer.duration / rate);
    }
    if (!world) gain.connect(mixer.ui);
    else {
      let output: AudioNode = gain;
      if (cutoff < 16000) {
        const tone = context.createBiquadFilter();
        nodes.push(tone);
        tone.type = 'lowpass'; tone.frequency.value = clamp(cutoff, 200, OPEN_CUTOFF); tone.Q.value = FLAT_Q_DB;
        gain.connect(tone); output = tone;
      }
      if (wet > 0.004) {
        this.prepareReverb();
        const space = this.space(sound.at, sound.distant === true);
        const send = (amount: number, bus: GainNode, convolver: ConvolverNode | null) => {
          if (amount < 0.004 || !convolver) return;
          const node = context.createGain();
          nodes.push(node);
          node.gain.value = clamp(amount / Math.max(dry, 0.02), 0, 30);
          output.connect(node); node.connect(bus);
        };
        send(wet * space.room, mixer.roomSend, mixer.room);
        send(wet * space.street, mixer.streetSend, mixer.street);
      }
      let pan: AudioNode | null = null;
      if (rel) { const placement = createPlacement(context, this.quality === 'desktop'); if (placement) { pan = placement.node; nodes.push(pan); placement.place(rel, now); } }
      else if (sound.pan !== undefined) { pan = createPan(context, sound.pan); if (pan) nodes.push(pan); }
      if (pan) { output.connect(pan); pan.connect(mixer.world); }
      else output.connect(mixer.world);
    }
    const voice: Voice = { priority: sound.priority, createdAt: now, endsAt, gain, nodes, sources, live: sources.length, done: false };
    this.pool.track(voice);
    return voice;
  }

  /** Spent cases landing at the shooter's feet, by the ground they stand on. */
  private casing(voice: GunVoice) {
    if (voice === 'drone' || !this.running() || !this.throttle('casing', 0.11)) return;
    const kind = casingKind(voice, this.localSurface);
    const delay = voice === 'breaker12' ? 0.62 : voice === 'longbow' ? 0.82 : 0.36 + this.random() * 0.16;
    const rate = voice === 'sentry9' ? 1.12 : voice === 'hornet9' ? 1.05 : voice === 'longbow' ? 0.88 : 1;
    this.play({ layers: [{ key: `casing:${kind}`, delay, rate }], gain: kind === 'soft' ? 0.12 : 0.2, priority: PRIORITY.ambient, wet: 0.1, jitter: 0.05 });
  }

  /** Briefly closes the world low-pass: a hit or a nearby blast dulls the hearing, then it recovers. */
  private muffle(strength: number, recovery: number) {
    const context = this.running();
    if (!context || !this.mixer) return;
    const now = context.currentTime, frequency = this.mixer.hurt.frequency;
    frequency.cancelScheduledValues(now);
    frequency.setTargetAtTime(Math.max(500, 2600 * (1 - 0.6 * strength)), now, 0.012);
    frequency.setTargetAtTime(OPEN_CUTOFF, now + 0.08 + 0.2 * strength, recovery);
  }

  private applyLowHealth() {
    const severity = this.lowHealthLevel;
    if (severity <= 0.02) this.heartbeat?.set(0);
    const context = this.running();
    if (!context || !this.mixer) return;
    if (Math.abs(severity - this.appliedLowHealth) >= 0.01 || (severity === 0) !== (this.appliedLowHealth === 0)) {
      this.appliedLowHealth = severity;
      const now = context.currentTime;
      // 20 kHz when healthy, ~4 kHz at half severity, ~900 Hz near elimination.
      this.mixer.health.frequency.setTargetAtTime(OPEN_CUTOFF * Math.pow(0.045, severity), now, 0.25);
      this.mixer.world.gain.setTargetAtTime(1 - 0.3 * severity, now, 0.3);
    }
    if (severity > 0.02) {
      this.heartbeat ??= new Heartbeat(context, this.mixer.ui, () => this.bank?.get('ui:heartbeat') ?? null);
      this.heartbeat.set(severity);
    }
  }

  private updateDrone(force = false) {
    if (!this.droneTarget) { this.droneHum?.stop(); this.droneHum = null; return; }
    const context = this.running();
    if (!context || !this.mixer) return;
    const now = context.currentTime;
    if (!this.droneHum) {
      if (this.broken.has('drone')) return;
      try { this.droneHum = new DroneHum(context, this.mixer.world, this.bank?.get('noise') ?? null, this.quality === 'desktop'); }
      catch { this.broken.add('drone'); return; }
      force = true;
    }
    // 20 updates a second are plenty for smoothed parameters, and keep the automation queues short.
    if (!force && now - this.droneUpdatedAt < 0.045) return;
    this.droneUpdatedAt = now;
    const rel = relative(this.listener, this.droneTarget);
    const blocked = occlusion(this.listener, towardListener(this.listener, this.droneTarget, 0.3));
    this.droneHum.update(0.5 * falloffGain('drone', rel.distance) * (1 - 0.5 * blocked), airCutoff('drone', rel.distance) * (1 - 0.7 * blocked), rel);
  }

  private startAmbience() {
    const context = this.running();
    if (!context || !this.mixer || this.wind || !this.ambienceWanted) return;
    const wind = this.bank?.get('wind');
    if (!wind || this.broken.has('wind')) return;
    try { this.wind = new WindBed(context, this.mixer.world, wind, this.listener.indoors); }
    catch { this.broken.add('wind'); return; }
    const now = context.currentTime;
    this.nextGust = now + 2; this.nextVolley = now + 4 + 8 * this.random();
    this.nextBarrage = now + 10 + 15 * this.random(); this.nextHelicopter = now + 30 + 40 * this.random();
  }

  private ambientEvents(now: number) {
    if (!this.wind) return;
    if (now >= this.nextGust) { this.wind.drift(this.random); this.nextGust = now + 2 + 3 * this.random(); }
    if (now >= this.nextVolley) { this.distantVolley(); this.nextVolley = now + 7 + 16 * this.random(); }
    if (now >= this.nextBarrage) { this.distantBarrage(); this.nextBarrage = now + 18 + 30 * this.random(); }
    if (now >= this.nextHelicopter) { this.distantHelicopter(); this.nextHelicopter = now + 70 + 60 * this.random(); }
  }

  /** A burst of gunfire somewhere beyond the town: the far layer of a random weapon at its own rate. */
  private distantVolley() {
    const weapon = DISTANT_WEAPONS[Math.floor(this.random() * DISTANT_WEAPONS.length)], spec = WEAPONS[weapon];
    const count = spec.auto ? 3 + Math.floor(this.random() * 6) : 1 + Math.floor(this.random() * 3);
    const interval = spec.auto ? 60 / spec.rpm : 0.35 + 0.45 * this.random(), inside = this.listener.indoors;
    const layers: Layer[] = [];
    for (let i = 0; i < count; i++) layers.push({ key: `far:${weapon}`, delay: i * interval * (0.95 + 0.1 * this.random()), gain: 0.8 + 0.2 * this.random() });
    this.play({ layers, gain: (0.05 + 0.06 * this.random()) * (inside ? 0.5 : 1), priority: PRIORITY.ambient, pan: this.random() * 1.7 - 0.85, cutoff: (1000 + 600 * this.random()) * (inside ? 0.6 : 1), wet: 0.6, distant: true });
  }

  /** One to three far artillery booms, deep and wet. */
  private distantBarrage() {
    const count = 1 + Math.floor(this.random() * 3), layers: Layer[] = [], inside = this.listener.indoors;
    let at = 0;
    for (let i = 0; i < count; i++) { layers.push({ key: 'explosion:mortar', delay: at, rate: 0.82 + 0.12 * this.random(), gain: 0.7 + 0.3 * this.random() }); at += 1.5 + 1.5 * this.random(); }
    this.play({ layers, gain: (0.1 + 0.07 * this.random()) * (inside ? 0.6 : 1), priority: PRIORITY.ambient, pan: this.random() * 1.6 - 0.8, cutoff: 380, wet: 0.8, distant: true });
  }

  private distantHelicopter() {
    const context = this.running(), noise = this.bank?.get('noise');
    if (!context || !this.mixer || !noise || !this.pool.reserve(PRIORITY.ambient, context.currentTime)) return;
    this.pool.track(helicopterPass(context, this.mixer.world, noise, this.random, this.listener.indoors ? 0.05 : 0.1));
  }

  /** Housekeeping, run from `setListener` each frame. */
  private tick() {
    const context = this.running();
    if (!context) return;
    const now = context.currentTime;
    if (now - this.lastSweep >= 0.25 || now < this.lastSweep) { this.lastSweep = now; this.pool.sweep(now); }
    // Loops asked for before sound could play start now.
    if (this.ambienceWanted && !this.wind) this.startAmbience();
    if (Math.abs(this.lowHealthLevel - this.appliedLowHealth) >= 0.01 || (this.lowHealthLevel > 0.02 && !this.heartbeat?.playing)) this.applyLowHealth();
    if (this.droneTarget) this.updateDrone();
    this.ambientEvents(now);
  }

  private prepareReverb() {
    if (this.reverbReady || !this.context || !this.mixer) return;
    this.reverbReady = true;
    const context = this.context, seconds = REVERB_SECONDS[this.quality];
    const load = (convolver: ConvolverNode | null, impulse: () => ImpulseResponse) => {
      if (!convolver) return;
      try {
        const { left, right } = impulse(), buffer = context.createBuffer(2, left.length, context.sampleRate);
        buffer.getChannelData(0).set(left); buffer.getChannelData(1).set(right);
        convolver.buffer = buffer;
      } catch { /* A dry mix is better than no sound. */ }
    };
    load(this.mixer.room, () => roomImpulse(context.sampleRate, seconds.room, createRng(hashSeed('room'))));
    load(this.mixer.street, () => streetImpulse(context.sampleRate, seconds.street, createRng(hashSeed('street'))));
  }

  /** Renders the common sounds one at a time between frames after unlocking. */
  private queueWarmup() {
    const bank = this.bank;
    if (!bank) return;
    const jobs: Array<() => void> = [() => this.prepareReverb()];
    for (const key of WARM) for (let variant = 0; variant < bank.variants(key); variant++) jobs.push(() => { bank.get(key, variant); });
    this.warmupQueue = jobs;
    this.nextWarmup();
  }

  private nextWarmup() {
    if (this.disposed || this.warmupTimer !== null || !this.warmupQueue.length) return;
    const handle = setTimeout(() => {
      this.warmupTimer = null;
      const job = this.warmupQueue.shift();
      try { job?.(); } catch { /* That sound renders on first use instead. */ }
      this.nextWarmup();
    }, this.quality === 'phone' ? 40 : 12);
    (handle as unknown as { unref?: () => void }).unref?.();
    this.warmupTimer = handle;
  }
}

const lift = (point: Vec3, metres: number): Vec3 => ({ x: point.x, y: point.y + metres, z: point.z });
