import * as THREE from 'three';
import type { Vec3 } from '../../shared/protocol';
import { ARENA_HALF } from '../../shared/map';
import { SUN_DIRECTION } from './Atmosphere';

export interface SunVisibilityGrid { sample(x: number, z: number, y: number): number }
export interface SunVisibilityOptions { half?: number; cells?: number; heights?: [number, number]; sun?: Vec3 }

/** How much direct sun reaches a standing character, from the collision map the bake
 *  approximates. Two layers: ground level and the upper floor. Built once per world. */
export function buildSunVisibility(raycast: (origin: Vec3, direction: Vec3, limit: number) => number, options: SunVisibilityOptions = {}): SunVisibilityGrid {
  const half = options.half ?? ARENA_HALF, cells = options.cells ?? 64, heights = options.heights ?? [1.2, 4.6];
  const sun = options.sun ?? { x: SUN_DIRECTION.x, y: SUN_DIRECTION.y, z: SUN_DIRECTION.z };
  const limit = 200, step = (2 * half) / cells;
  const layers = heights.map(height => {
    const data = new Float32Array(cells * cells);
    for (let row = 0; row < cells; row++) for (let column = 0; column < cells; column++) {
      const origin = { x: -half + (column + 0.5) * step, y: height, z: -half + (row + 0.5) * step };
      data[row * cells + column] = raycast(origin, sun, limit) >= limit ? 1 : 0;
    }
    return data;
  });
  const read = (data: Float32Array, column: number, row: number) => data[THREE.MathUtils.clamp(row, 0, cells - 1) * cells + THREE.MathUtils.clamp(column, 0, cells - 1)]!;
  return {
    sample(x, z, y) {
      const data = layers[y >= 3.0 ? 1 : 0]!;
      const u = (x + half) / step - 0.5, v = (z + half) / step - 0.5;
      const c0 = Math.floor(u), r0 = Math.floor(v), fu = u - c0, fv = v - r0;
      const top = read(data, c0, r0) * (1 - fu) + read(data, c0 + 1, r0) * fu;
      const bottom = read(data, c0, r0 + 1) * (1 - fu) + read(data, c0 + 1, r0 + 1) * fu;
      return top * (1 - fv) + bottom * fv;
    },
  };
}

/** Characters keep the real-time sun, scaled by where they stand. */
export function patchSunVisibilityFragment(fragmentShader: string): string {
  if (fragmentShader.includes('uSunVisibility')) return fragmentShader;
  const begin = THREE.ShaderChunk.lights_fragment_begin
    .replace('getDirectionalLightInfo( directionalLight, directLight );', 'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= uSunVisibility;');
  return fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uSunVisibility;')
    .replace('#include <lights_fragment_begin>', begin);
}

export function applySunVisibility(material: THREE.Material, uniform: { value: number }): void {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.uSunVisibility = uniform;
    shader.fragmentShader = patchSunVisibilityFragment(shader.fragmentShader);
  };
  material.customProgramCacheKey = () => 'kannon-sun-visibility-v1';
}
