import * as THREE from 'three';
import type { GLTFLoaderPlugin, GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';

export const LIGHTMAP_EXTENSION = 'KANNON_lightmap';
export interface LightmapDefinition { texture: { index: number; texCoord: number }; intensity: number }

/** Validates materials[i].extensions.KANNON_lightmap from untrusted GLB JSON. */
export function readLightmapDefinition(materialDef: unknown): LightmapDefinition | null {
  if (!materialDef || typeof materialDef !== 'object') return null;
  const ext = (materialDef as { extensions?: Record<string, unknown> }).extensions?.[LIGHTMAP_EXTENSION] as { intensity?: unknown; texture?: { index?: unknown; texCoord?: unknown } } | undefined;
  if (!ext || typeof ext !== 'object' || !ext.texture || typeof ext.texture !== 'object') return null;
  const index = ext.texture.index, texCoord = ext.texture.texCoord ?? 1, intensity = ext.intensity ?? 1;
  if (!Number.isInteger(index) || (index as number) < 0) return null;
  if (!Number.isInteger(texCoord) || (texCoord as number) < 0 || (texCoord as number) > 1) return null;
  if (typeof intensity !== 'number' || !Number.isFinite(intensity) || intensity < 0) return null;
  return { texture: { index: index as number, texCoord: texCoord as number }, intensity };
}

/** GLTFLoader plugin: `loader.register(parser => new LightmapPlugin(parser))`. */
export class LightmapPlugin implements GLTFLoaderPlugin {
  readonly name = LIGHTMAP_EXTENSION;
  constructor(private readonly parser: GLTFParser) {}
  extendMaterialParams(materialIndex: number, materialParams: Record<string, unknown>): Promise<void> {
    const definition = readLightmapDefinition(this.parser.json.materials?.[materialIndex]);
    if (!definition) return Promise.resolve();
    materialParams.lightMapIntensity = definition.intensity;
    return this.parser.assignTexture(materialParams as never, 'lightMap', definition.texture, THREE.SRGBColorSpace).then(() => {});
  }
}

const DIRECTIONAL_RE_DIRECT = /(getDirectionalLightInfo\( directionalLight, directLight \);[\s\S]*?)RE_Direct\( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight \);/;

/** Lightmapped surfaces carry the sun in the bake. Drop the real-time sun's direct term,
 *  silence the hemisphere fill, and let the sun shadow map darken the lightmap so
 *  characters still ground on the baked world. */
export function patchLightmapFragment(fragmentShader: string): string {
  if (fragmentShader.includes('kannonSunShadow')) return fragmentShader;
  const begin = THREE.ShaderChunk.lights_fragment_begin
    .replace(DIRECTIONAL_RE_DIRECT, '$1kannonSunShadow = min( kannonSunShadow, directLight.color.g / max( directionalLight.color.g, 1e-4 ) );')
    .replace('getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal )', 'getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal ) * 0.0');
  const maps = THREE.ShaderChunk.lights_fragment_maps
    .replace('irradiance += lightMapIrradiance;', 'irradiance += lightMapIrradiance * mix( 1.0, kannonSunShadow, uSunShadowStrength );');
  return fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uSunShadowStrength;')
    .replace('#include <lights_fragment_begin>', `float kannonSunShadow = 1.0;\n${begin}`)
    .replace('#include <lights_fragment_maps>', maps);
}

/** Configure a lightmapped environment material. `shadowStrength` is how much a character's
 *  real-time shadow darkens the baked light beneath it. */
export function applyLightmapShading(material: THREE.MeshStandardMaterial, shadowStrength = 0.6): void {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.uSunShadowStrength = { value: shadowStrength };
    shader.fragmentShader = patchLightmapFragment(shader.fragmentShader);
  };
  material.customProgramCacheKey = () => 'kannon-lightmap-v1';
}
