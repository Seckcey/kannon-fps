import * as THREE from 'three';
import type { GLTFLoaderPlugin, GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';

export const LIGHTMAP_EXTENSION = 'KANNON_lightmap';
/** material.userData flag: the lightmap's alpha channel holds its shade level (see below). */
export const SHADE_ALPHA_FLAG = 'kannonLightmapShadeAlpha';
export interface LightmapDefinition { texture: { index: number; texCoord: number }; intensity: number; shadeAlpha: boolean }

/** Validates materials[i].extensions.KANNON_lightmap from untrusted GLB JSON. When the extension's
 *  extras say `shadeAlpha: true`, the lightmap's alpha is its shade level: the share of each
 *  texel's baked light that is not direct sun, so what remains where the sun is blocked. */
export function readLightmapDefinition(materialDef: unknown): LightmapDefinition | null {
  if (!materialDef || typeof materialDef !== 'object') return null;
  const ext = (materialDef as { extensions?: Record<string, unknown> }).extensions?.[LIGHTMAP_EXTENSION] as { intensity?: unknown; extras?: unknown; texture?: { index?: unknown; texCoord?: unknown } } | undefined;
  if (!ext || typeof ext !== 'object' || !ext.texture || typeof ext.texture !== 'object') return null;
  const index = ext.texture.index, texCoord = ext.texture.texCoord ?? 1, intensity = ext.intensity ?? 1;
  if (!Number.isInteger(index) || (index as number) < 0) return null;
  if (!Number.isInteger(texCoord) || (texCoord as number) < 0 || (texCoord as number) > 1) return null;
  if (typeof intensity !== 'number' || !Number.isFinite(intensity) || intensity < 0) return null;
  const shadeAlpha = !!ext.extras && typeof ext.extras === 'object' && (ext.extras as { shadeAlpha?: unknown }).shadeAlpha === true;
  return { texture: { index: index as number, texCoord: texCoord as number }, intensity, shadeAlpha };
}

/** True when the material's lightmap alpha holds its shade level. */
export function lightmapHasShadeAlpha(material: THREE.Material): boolean {
  return material.userData[SHADE_ALPHA_FLAG] === true;
}

/** GLTFLoader plugin: `loader.register(parser => new LightmapPlugin(parser))`. */
export class LightmapPlugin implements GLTFLoaderPlugin {
  readonly name = LIGHTMAP_EXTENSION;
  constructor(private readonly parser: GLTFParser) {}
  extendMaterialParams(materialIndex: number, materialParams: Record<string, unknown>): Promise<void> {
    const definition = readLightmapDefinition(this.parser.json.materials?.[materialIndex]);
    if (!definition) return Promise.resolve();
    materialParams.lightMapIntensity = definition.intensity;
    if (definition.shadeAlpha) {
      const userData = materialParams.userData && typeof materialParams.userData === 'object' ? materialParams.userData : {};
      materialParams.userData = { ...userData, [SHADE_ALPHA_FLAG]: true };
    }
    return this.parser.assignTexture(materialParams as never, 'lightMap', definition.texture, THREE.SRGBColorSpace).then(() => {});
  }
}

const DIRECTIONAL_RE_DIRECT = /(getDirectionalLightInfo\( directionalLight, directLight \);[\s\S]*?)RE_Direct\( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight \);/;
/** Older lightmaps without a shade level: a real-time shadow darkens all of the baked light. */
const SHADOW_ON_ALL_LIGHT = 'irradiance += lightMapIrradiance * mix( 1.0, kannonSunShadow, uSunShadowStrength );';
/** Lightmaps with a shade level: a real-time shadow takes the baked light down to its shade level
 *  and no further. In baked shade or indoors the shade level is 1 and nothing changes, so a
 *  character there casts no phantom shadow; in the sun the shadow is exactly as dark as the
 *  baked shade beside it. A missing alpha reads as 1 and removes nothing. */
const SHADOW_TO_SHADE_LEVEL = 'irradiance += lightMapIrradiance * mix( 1.0, lightMapTexel.a, ( 1.0 - kannonSunShadow ) * uSunShadowStrength );';

/** Lightmapped surfaces carry the sun in the bake. Drop the real-time sun's direct term,
 *  silence the hemisphere fill, and let the sun shadow map darken the lightmap so
 *  characters still ground on the baked world. */
export function patchLightmapFragment(fragmentShader: string, shadeAlpha = false): string {
  if (fragmentShader.includes('kannonSunShadow')) return fragmentShader;
  const begin = THREE.ShaderChunk.lights_fragment_begin
    .replace(DIRECTIONAL_RE_DIRECT, '$1kannonSunShadow = min( kannonSunShadow, directLight.color.g / max( directionalLight.color.g, 1e-4 ) );')
    .replace('getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal )', 'getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal ) * 0.0');
  const maps = THREE.ShaderChunk.lights_fragment_maps.replace('irradiance += lightMapIrradiance;', shadeAlpha ? SHADOW_TO_SHADE_LEVEL : SHADOW_ON_ALL_LIGHT);
  return fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uSunShadowStrength;')
    .replace('#include <lights_fragment_begin>', `float kannonSunShadow = 1.0;\n${begin}`)
    .replace('#include <lights_fragment_maps>', maps);
}

export interface LightmapShading {
  /** The lightmap's alpha holds its shade level: real-time shadows remove only baked sun. */
  shadeAlpha?: boolean;
  /** How much of what a shadow may remove it removes: 1 with a shade level, 0.6 without. */
  shadowStrength?: number;
}

/** Configure a lightmapped environment material so characters' real-time shadows fall on it. */
export function applyLightmapShading(material: THREE.MeshStandardMaterial, shading: LightmapShading = {}): void {
  const shadeAlpha = shading.shadeAlpha ?? false;
  const strength = shading.shadowStrength ?? (shadeAlpha ? 1 : 0.6);
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.uSunShadowStrength = { value: strength };
    shader.fragmentShader = patchLightmapFragment(shader.fragmentShader, shadeAlpha);
  };
  // Combine with any earlier key so wind, sky and lightmap variants never share a program.
  const previousKey = material.customProgramCacheKey;
  material.customProgramCacheKey = () => `${previousKey.call(material)}|kannon-lightmap-${shadeAlpha ? 'shade-alpha-v1' : 'v1'}`;
}
