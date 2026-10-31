/** Keeps the live audio graph bounded: at most `MAX_VOICES` sounds at once, and every node a sound
 * created is disconnected when it ends, is cut short, or is found overdue. */

export const MAX_VOICES = 32;
/** Fade applied to a stolen voice so the cut does not click. */
export const STEAL_FADE = 0.03;
/** A voice whose `ended` event never arrived is cleaned up this long after it should have ended. */
const OVERDUE = 0.5;

/** Higher numbers matter more. A new sound may only replace a voice of equal or lower priority. */
export const PRIORITY = { ambient: 0, detail: 1, combat: 2, critical: 3 } as const;

export interface Voice {
  readonly priority: number;
  /** Context time the voice was created; the pool also keeps creation order. */
  readonly createdAt: number;
  /** Context time its last source finishes. */
  endsAt: number;
  readonly gain: GainNode;
  readonly nodes: AudioNode[];
  readonly sources: AudioScheduledSourceNode[];
  live: number;
  done: boolean;
}

export class VoicePool {
  private readonly active: Voice[] = [];
  private readonly stopping = new Set<Voice>();
  constructor(readonly limit = MAX_VOICES) {}

  /** Sounds currently counted against the cap (stolen, fading voices are not). */
  get count() { return this.active.length; }

  /** Makes room for a sound of `priority`: steals the oldest voice of the lowest priority present that
   * is no more important than the newcomer. False when every voice matters more (drop the newcomer). */
  reserve(priority: number, now: number): boolean {
    this.sweep(now);
    while (this.active.length >= this.limit) {
      let victim: Voice | null = null;
      for (const voice of this.active) if (voice.priority <= priority && (!victim || voice.priority < victim.priority)) victim = voice;
      if (!victim) return false;
      this.steal(victim, now);
    }
    return true;
  }

  track(voice: Voice) {
    voice.live = voice.sources.length;
    for (const source of voice.sources) source.onended = () => { if (--voice.live <= 0) this.finish(voice); };
    this.active.push(voice);
  }

  /** Fades a voice out quickly and stops its sources; nodes are released when they end. */
  steal(voice: Voice, now: number) {
    if (voice.done) return;
    this.remove(voice);
    this.stopping.add(voice);
    try {
      const gain = voice.gain.gain;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(0, now + STEAL_FADE);
    } catch { /* A voice must always be stoppable. */ }
    for (const source of voice.sources) { try { source.stop(now + STEAL_FADE + 0.005); } catch { /* Already stopped. */ } }
    voice.endsAt = Math.min(voice.endsAt, now + STEAL_FADE + 0.005);
  }

  /** Disconnects every node of a voice exactly once. */
  finish(voice: Voice) {
    if (voice.done) return;
    voice.done = true;
    this.remove(voice);
    this.stopping.delete(voice);
    for (const source of voice.sources) source.onended = null;
    for (const node of voice.nodes) { try { node.disconnect(); } catch { /* Already disconnected. */ } }
  }

  /** Cleans up voices whose `ended` never fired (a browser that skipped it for a never-started
   * source, or a context that was suspended at the wrong moment). */
  sweep(now: number) {
    for (const voice of [...this.active, ...this.stopping]) if (now > voice.endsAt + OVERDUE) this.finish(voice);
  }

  /** Stops and releases everything (dispose). */
  clear() {
    for (const voice of [...this.active, ...this.stopping]) {
      for (const source of voice.sources) { try { source.stop(); } catch { /* Already stopped. */ } }
      this.finish(voice);
    }
  }

  private remove(voice: Voice) {
    const index = this.active.indexOf(voice);
    if (index >= 0) this.active.splice(index, 1);
  }
}
