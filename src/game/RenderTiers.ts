export type Quality = 'auto' | 'high' | 'low';
export interface RenderTier {
  name: 'phone' | 'desktop' | 'desktop-high';
  textureTier: 'phone' | 'full';
  shadowMapSize: 1024 | 2048;
  /** Metres either side of the local player covered by the character shadow map. */
  shadowHalfExtent: number;
  postprocessing: boolean;
  bloom: boolean;
  grassDensity: 0 | 1 | 2;
}

/** One place decides what each device renders. Environment lighting is always baked;
 *  the tiers differ in character shadows, screen effects, foliage and texture size. */
export function renderTier(quality: Quality, touch: boolean, floatTargets: boolean): RenderTier {
  if (quality === 'low' || (quality === 'auto' && touch)) {
    return { name: 'phone', textureTier: 'phone', shadowMapSize: 1024, shadowHalfExtent: 14, postprocessing: false, bloom: false, grassDensity: 0 };
  }
  const high = quality === 'high';
  return { name: high ? 'desktop-high' : 'desktop', textureTier: 'full', shadowMapSize: 2048, shadowHalfExtent: 24, postprocessing: floatTargets, bloom: floatTargets, grassDensity: high ? 2 : 1 };
}
