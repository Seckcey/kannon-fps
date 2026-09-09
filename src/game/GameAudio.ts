type BrowserAudioSession = { type: string };
const unlockEvents = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const;

/** Small, self-contained effects bank. Audio is only created after an intentional gesture. */
export class GameAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private volume = 0.65;
  private disposed = false;
  private session: BrowserAudioSession | null = null;
  private previousSessionType = 'auto';
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
        // Effects use media volume; unsupported browsers keep their own route.
        const session = (navigator as Navigator & { audioSession?: BrowserAudioSession }).audioSession;
        if (session) {
          try {
            const previousType = session.type;
            session.type = 'playback';
            this.previousSessionType = previousType;
            this.session = session;
          } catch { /* An optional routing API must never block regular audio. */ }
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
      // Retry on the next gesture even if an earlier resume is still pending.
      if (this.context.state !== 'running' && this.context.state !== 'closed') await this.context.resume();
    } catch { /* Audio may be unavailable; gameplay still works. */ }
  }

  setVolume(volume: number) {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.master && this.context) this.master.gain.setTargetAtTime(this.volume * 0.32, this.context.currentTime, 0.03);
  }

  private tone(frequency: number, duration: number, volume: number, type: OscillatorType = 'sine', endFrequency?: number, delay = 0) {
    const context = this.context;
    if (!context || !this.master || context.state !== 'running') return;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const time = context.currentTime + delay;
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, time);
    if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, time + duration);
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(volume, time + 0.003);
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    oscillator.connect(envelope);
    envelope.connect(this.master);
    oscillator.start(time);
    oscillator.stop(time + duration + 0.03);
    oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
  }

  private burst(duration: number, frequency: number, volume: number, pan = 0) {
    const context = this.context;
    if (!context || !this.master || !this.noise || context.state !== 'running') return;
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const envelope = context.createGain();
    const panner = context.createStereoPanner();
    const time = context.currentTime;
    source.buffer = this.noise;
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(frequency, time);
    filter.frequency.exponentialRampToValueAtTime(160, time + duration);
    envelope.gain.setValueAtTime(volume, time);
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    source.connect(filter); filter.connect(envelope); envelope.connect(panner); panner.connect(this.master);
    source.start(time, Math.random() * 0.7);
    source.stop(time + duration);
    source.onended = () => { source.disconnect(); filter.disconnect(); envelope.disconnect(); panner.disconnect(); };
  }

  shot(slot: number, distance = 0, pan = 0) {
    const gain = Math.max(0.04, 1 / (1 + distance * 0.12));
    this.burst(slot === 2 ? 0.26 : 0.115, slot === 2 ? 4700 : 3100, gain * (slot === 2 ? 1 : 0.65), pan);
    this.tone(slot === 2 ? 135 : 190, 0.095, gain * 0.38, 'triangle', 40);
  }
  hit(shield = false) { this.tone(shield ? 1180 : 840, 0.07, 0.23, 'triangle', shield ? 620 : 430); }
  shieldBreak() { this.burst(0.14, 5200, 0.2); this.tone(1480, 0.18, 0.18, 'sine', 330); }
  damage() { this.burst(0.12, 720, 0.45); this.tone(160, 0.2, 0.2, 'sine', 65); }
  elimination() {
    this.tone(659, 0.15, 0.3, 'triangle');
    this.tone(880, 0.22, 0.25, 'triangle', undefined, 0.08);
    this.tone(1318, 0.32, 0.2, 'sine', undefined, 0.17);
  }
  heal() { this.tone(440, 0.25, 0.16, 'sine', 880); this.tone(660, 0.5, 0.13, 'sine', 1320, 0.12); }
  respawn() { this.tone(220, 0.5, 0.15, 'sine', 880); this.tone(440, 0.4, 0.08, 'triangle', 660, 0.16); }
  reload() { this.burst(0.06, 2600, 0.11); this.tone(320, 0.06, 0.11, 'square', 180, 0.2); }
  switchWeapon() { this.burst(0.045, 1500, 0.12); }

  dispose() {
    this.disposed = true;
    for (const event of unlockEvents) window.removeEventListener(event, this.unlockListener, true);
    void this.context?.close().catch(() => {});
    if (this.session?.type === 'playback') {
      try { this.session.type = this.previousSessionType; } catch { /* Optional browser routing. */ }
    }
    this.session = null;
    this.context = null;
    this.master = null;
    this.noise = null;
  }
}
