import { recipeFor, renderSound, type SoundKey } from './catalog';

/** Lazily rendered AudioBuffers. A sound is rendered the first time it is needed (or ahead of time by
 * the warm-up queue), then reused. Phones keep fewer variants and render at up to 32 kHz, which is
 * plenty for small speakers and earbuds and saves a third of the work and memory. */
export class SoundBank {
  private readonly cache = new Map<SoundKey, Array<AudioBuffer | null>>();
  private readonly last = new Map<SoundKey, number>();
  constructor(private readonly context: BaseAudioContext, private readonly phone: boolean, private readonly random: () => number = Math.random) {}

  variants(key: SoundKey): number {
    const recipe = recipeFor(key);
    return Math.max(1, this.phone ? recipe.phoneVariants : recipe.variants);
  }

  /** Render rate: the device rate (at most 32 kHz on phones), halved for sounds without highs. Never
   * below 22.05 kHz, which older Safari versions require for buffers. */
  rate(half: boolean): number {
    const device = this.context.sampleRate, base = this.phone ? Math.min(device, 32000) : device;
    return Math.min(device, Math.max(22050, Math.round(half ? base / 2 : base)));
  }

  ready(key: SoundKey, variant = 0): boolean { return this.cache.get(key)?.[variant] !== undefined; }

  /** One variant, rendering it now if needed. Null when the buffer could not be made. */
  get(key: SoundKey, variant = 0): AudioBuffer | null {
    let list = this.cache.get(key);
    if (!list) { list = []; this.cache.set(key, list); }
    const cached = list[variant];
    if (cached !== undefined) return cached;
    let buffer: AudioBuffer | null = null;
    try {
      const rate = this.rate(recipeFor(key).half);
      const data = renderSound(key, rate, variant);
      buffer = this.context.createBuffer(1, data.length, rate);
      buffer.getChannelData(0).set(data);
    } catch { buffer = null; }
    list[variant] = buffer;
    return buffer;
  }

  /** A random variant, never the same one twice in a row. */
  pick(key: SoundKey): AudioBuffer | null {
    const count = this.variants(key);
    let variant = Math.min(count - 1, Math.floor(this.random() * count));
    if (count > 1 && variant === this.last.get(key)) variant = (variant + 1) % count;
    this.last.set(key, variant);
    return this.get(key, variant);
  }

  clear() { this.cache.clear(); this.last.clear(); }
}
