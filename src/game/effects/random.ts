/** Small seeded generator (mulberry32). Effects use it instead of Math.random so every burst is
 * repeatable in tests, and so no closure or array is created per particle. */
export class EffectRandom {
  private state: number;

  constructor(seed = 0x2f6b9a1d) { this.state = seed >>> 0; }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number) { return min + (max - min) * this.next(); }

  /** Uniform in [-scale, scale). */
  signed(scale = 1) { return (this.next() * 2 - 1) * scale; }
}
