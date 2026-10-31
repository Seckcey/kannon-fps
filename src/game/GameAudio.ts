import type { StreakId, SurfaceKind, Vec3, WeaponId } from '../../shared/protocol';

type BrowserAudioSession = { type: string };
const unlockEvents = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const;
export type ReloadStep = 'mag-out' | 'mag-in' | 'bolt' | 'shell' | 'pump';

/** Procedural effects bank. Audio is only created after an intentional gesture.
 * Contract: the audio workstream replaces the synthesis; the public methods stay. */
export class GameAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private volume = 0.65;
  private disposed = false;
  private session: BrowserAudioSession | null = null;
  private previousSessionType = 'auto';
  private listener = { x: 0, y: 0, z: 0, yaw: 0, indoors: false };
  private unlockListener = () => { void this.unlock(); };

  constructor(volume = 0.65) {
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
        this.master = this.context.createGain();
        this.master.gain.value = this.volume * 0.32;
        this.master.connect(this.context.destination);
        this.noise = this.context.createBuffer(1, this.context.sampleRate, this.context.sampleRate);
        const samples = this.noise.getChannelData(0);
        for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
      }
      // Safari can report interrupted after an app switch or phone call.
      if (this.context.state !== 'running' && this.context.state !== 'closed') await this.context.resume();
    } catch { /* Audio may be unavailable; gameplay still works. */ }
  }

  setVolume(volume: number) {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.master && this.context) this.master.gain.setTargetAtTime(this.volume * 0.32, this.context.currentTime, 0.03);
  }
  /** Listener pose for spatial sound; GameView calls this every frame. */
  setListener(position: Vec3, yaw: number, _pitch: number, indoors: boolean) { Object.assign(this.listener, position, { yaw, indoors }); }

  private spatial(position: Vec3) {
    const dx = position.x - this.listener.x, dz = position.z - this.listener.z, distance = Math.hypot(dx, position.y - this.listener.y, dz);
    return { gain: Math.max(0.03, 1 / (1 + distance * 0.12)), pan: Math.max(-1, Math.min(1, (dx * Math.cos(this.listener.yaw) + dz * Math.sin(this.listener.yaw)) / Math.max(5, distance))) };
  }
  private tone(frequency: number, duration: number, volume: number, type: OscillatorType = 'sine', endFrequency?: number, delay = 0) {
    const context = this.context;
    if (!context || !this.master || context.state !== 'running') return;
    const oscillator = context.createOscillator(), envelope = context.createGain(), time = context.currentTime + delay;
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, time);
    if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, time + duration);
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(volume, time + 0.003);
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    oscillator.connect(envelope); envelope.connect(this.master);
    oscillator.start(time); oscillator.stop(time + duration + 0.03);
    oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
  }
  private burst(duration: number, frequency: number, volume: number, pan = 0) {
    const context = this.context;
    if (!context || !this.master || !this.noise || context.state !== 'running') return;
    const source = context.createBufferSource(), filter = context.createBiquadFilter(), envelope = context.createGain(), panner = context.createStereoPanner();
    const time = context.currentTime;
    source.buffer = this.noise; filter.type = 'lowpass';
    filter.frequency.setValueAtTime(frequency, time); filter.frequency.exponentialRampToValueAtTime(160, time + duration);
    envelope.gain.setValueAtTime(volume, time); envelope.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    source.connect(filter); filter.connect(envelope); envelope.connect(panner); panner.connect(this.master);
    source.start(time, Math.random() * 0.7); source.stop(time + duration);
    source.onended = () => { source.disconnect(); filter.disconnect(); envelope.disconnect(); panner.disconnect(); };
  }

  shot(weapon: WeaponId | 'drone', position: Vec3, local: boolean) {
    const { gain, pan } = local ? { gain: 1, pan: 0 } : this.spatial(position);
    const heavy = weapon === 'breaker12' || weapon === 'longbow';
    this.burst(heavy ? 0.26 : 0.115, heavy ? 4700 : 3100, gain * (heavy ? 1 : 0.65), pan);
    this.tone(heavy ? 135 : 190, 0.095, gain * 0.38, 'triangle', 40);
  }
  impact(_surface: SurfaceKind | 'flesh', position: Vec3) { const { gain, pan } = this.spatial(position); this.burst(0.05, 2200, gain * 0.2, pan); }
  flyby(position: Vec3) { const { pan } = this.spatial(position); this.burst(0.08, 6000, 0.12, pan); }
  footstep(_surface: SurfaceKind, position: Vec3, local: boolean, loudness: number) { const { gain, pan } = local ? { gain: 0.5, pan: 0 } : this.spatial(position); this.burst(0.05, 900, gain * 0.12 * loudness, pan); }
  land(position: Vec3, local: boolean, intensity: number) { this.footstep('asphalt', position, local, 1.5 * intensity); }
  slide(position: Vec3, local: boolean) { const { gain, pan } = local ? { gain: 1, pan: 0 } : this.spatial(position); this.burst(0.4, 1400, gain * 0.15, pan); }
  vault(_local: boolean) { this.burst(0.12, 900, 0.12); }
  reloadStep(_weapon: WeaponId, step: ReloadStep) { this.burst(0.05, step === 'bolt' || step === 'pump' ? 1800 : 2600, 0.11); }
  aim(entering: boolean) { this.burst(0.06, entering ? 1200 : 900, 0.05); }
  swap() { this.burst(0.045, 1500, 0.12); }
  dryFire() { this.tone(1800, 0.03, 0.08, 'square'); }
  melee(hit: boolean) { this.burst(0.12, hit ? 1200 : 2400, 0.2); }
  hitMarker(kind: 'hit' | 'head' | 'kill') { this.tone(kind === 'head' ? 1480 : kind === 'kill' ? 660 : 840, 0.07, 0.23, 'triangle', kind === 'kill' ? 330 : 430); }
  damage(_amount: number) { this.burst(0.12, 720, 0.45); this.tone(160, 0.2, 0.2, 'sine', 65); }
  lowHealth(_amount: number) {}
  grenadeBounce(position: Vec3, impact: number) { const { gain, pan } = this.spatial(position); this.tone(1100, 0.04, gain * Math.min(0.3, impact * 0.04), 'triangle', 700); void pan; }
  grenadePin() { this.tone(2400, 0.05, 0.1, 'square', 1800); }
  explosion(position: Vec3, kind: 'frag' | 'mortar' | 'drone') { const { gain, pan } = this.spatial(position); this.burst(kind === 'mortar' ? 1.1 : 0.8, 900, gain * 1.2, pan); this.tone(70, 0.6, gain * 0.6, 'sine', 30); }
  mortarWhistle(position: Vec3) { const { gain } = this.spatial(position); this.tone(1800, 1.6, gain * 0.12, 'sine', 500); }
  drone(_position: Vec3 | null) {}
  streak(kind: 'earned' | 'used', _reward: StreakId) { this.tone(kind === 'earned' ? 660 : 880, 0.18, 0.2, 'triangle', kind === 'earned' ? 990 : 660); }
  medal() { this.tone(880, 0.12, 0.15, 'triangle', 1320); }
  respawn() { this.tone(220, 0.5, 0.15, 'sine', 880); }
  countdown(final: boolean) { this.tone(final ? 880 : 440, 0.12, 0.18, 'square'); }
  ambience(_active: boolean) {}

  dispose() {
    this.disposed = true;
    for (const event of unlockEvents) window.removeEventListener(event, this.unlockListener, true);
    void this.context?.close().catch(() => {});
    if (this.session?.type === 'playback') { try { this.session.type = this.previousSessionType; } catch { /* Optional browser routing. */ } }
    this.session = null; this.context = null; this.master = null; this.noise = null;
  }
}
