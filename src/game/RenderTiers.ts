export type Quality = 'auto' | 'high' | 'low';
/** The one touch-screen test used to pick the render tier: a coarse primary pointer. A laptop with a
 * touch screen but a mouse or trackpad as its main pointer stays on the desktop tier. */
export const coarsePointer = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
export interface RenderTier {
  name: 'phone' | 'desktop' | 'desktop-high';
  textureTier: 'phone' | 'full';
  shadowMapSize: 1024 | 2048;
  /** Metres either side of the local player covered by the character shadow map. */
  shadowHalfExtent: number;
  postprocessing: boolean;
  bloom: boolean;
  /** Aim-down-sights depth of field (desktop post-processing only). */
  depthOfField: boolean;
  grassDensity: 0 | 1 | 2;
  /** Particle budgets and effect detail. */
  effects: 'phone' | 'desktop';
  /** Short point-light flashes for muzzles and explosions. */
  muzzleLight: boolean;
  /** Bullet-hole decals kept at once. */
  decals: number;
}

/** One place decides what each device renders. Environment lighting is always baked;
 *  the tiers differ in character shadows, screen effects, foliage and texture size. */
export function renderTier(quality: Quality, touch: boolean, floatTargets: boolean): RenderTier {
  if (quality === 'low' || (quality === 'auto' && touch)) {
    return { name: 'phone', textureTier: 'phone', shadowMapSize: 1024, shadowHalfExtent: 14, postprocessing: false, bloom: false, depthOfField: false, grassDensity: 0, effects: 'phone', muzzleLight: false, decals: 48 };
  }
  const high = quality === 'high';
  return { name: high ? 'desktop-high' : 'desktop', textureTier: 'full', shadowMapSize: 2048, shadowHalfExtent: 24, postprocessing: floatTargets, bloom: floatTargets, depthOfField: floatTargets, grassDensity: high ? 2 : 1, effects: 'desktop', muzzleLight: true, decals: high ? 192 : 128 };
}
