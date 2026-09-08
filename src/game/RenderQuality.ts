/** Hysteresis keeps a brief hitch from changing resolution. The native HUD is
 * outside the canvas and stays sharp when the GPU needs fewer scene pixels. */
export class RenderQuality {
  scale = 1;
  private slow = 0;
  private fast = 0;

  reset() { this.scale = 1; this.resetTiming(); }
  resetTiming() { this.slow = 0; this.fast = 0; }

  observe(fps: number, seconds: number, quality: 'auto' | 'high' | 'low'): boolean {
    if (quality === 'low') return false;
    const threshold = quality === 'high' ? 32 : 42;
    this.slow = fps < threshold ? this.slow + seconds : 0;
    this.fast = fps >= 58 ? this.fast + seconds : 0;
    const previous = this.scale;
    if (this.slow >= 2.1) {
      this.scale = Math.max(quality === 'high' ? 0.65 : 0.55, this.scale - 0.1);
      this.resetTiming();
    } else if (this.fast >= 15) {
      this.scale = Math.min(1, this.scale + 0.05);
      this.resetTiming();
    }
    return Math.abs(previous - this.scale) > 0.001;
  }
}

export function scenePixelRatio(width: number, height: number, deviceRatio: number, touch: boolean, quality: 'auto' | 'high' | 'low', scale = 1): number {
  const budget = quality === 'high' ? 2560 * 1440 : quality === 'low' ? 1024 * 768 : touch ? 1280 * 720 : 1600 * 900;
  const ratioLimit = quality === 'high' ? 1.75 : quality === 'low' ? 1 : touch ? 1.25 : 1.5;
  return Math.min(Math.max(0.1, deviceRatio), ratioLimit, Math.sqrt(budget / Math.max(1, width * height))) * scale;
}
