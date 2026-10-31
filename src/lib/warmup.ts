import type { TextureTier } from '../game/assets';
import { coarsePointer, renderTier, type Quality } from '../game/RenderTiers';

/** The town build the match will draw, chosen by the same coarse-pointer test as the game view, so the
 * warm-up before entering downloads exactly that file. A touch-screen laptop driven by a mouse or
 * trackpad still gets touch controls, but it draws (and so warms up) the full town. */
export const warmupTextureTier = (quality: Quality): TextureTier => renderTier(quality, coarsePointer(), true).textureTier;
