import type { Extension, ExtensionProperty, Texture, TextureInfo } from '@gltf-transform/core';

export const LIGHTMAP_EXTENSION: 'KANNON_lightmap';
export declare class Lightmap extends ExtensionProperty {
  getIntensity(): number;
  setIntensity(value: number): this;
  getTexture(): Texture | null;
  setTexture(texture: Texture | null): this;
  getTextureInfo(): TextureInfo | null;
}
export declare class KannonLightmap extends Extension {
  createLightmap(): Lightmap;
}
