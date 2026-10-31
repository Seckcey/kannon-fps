import * as THREE from 'three';
import { seededRandom } from './spring';

/** Physically based materials for the procedural weapon and arm stand-ins. Textures are tiny
 * generated data textures (no downloads, safe in Node tests): value noise for roughness and
 * grip texture, wood grain, and an original three-colour camouflage weave for the sleeves. */
export interface WeaponPalette {
  anodized: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial;
  polymer: THREE.MeshStandardMaterial;
  tan: THREE.MeshStandardMaterial;
  olive: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  glass: THREE.MeshBasicMaterial;
  lens: THREE.MeshStandardMaterial;
  reticle: THREE.MeshBasicMaterial;
  sightDot: THREE.MeshBasicMaterial;
  brass: THREE.MeshStandardMaterial;
  hull: THREE.MeshStandardMaterial;
  blade: THREE.MeshStandardMaterial;
  glove: THREE.MeshStandardMaterial;
  knuckle: THREE.MeshStandardMaterial;
  sleeve: THREE.MeshStandardMaterial;
  materials(): THREE.Material[];
  textures(): THREE.Texture[];
  dispose(): void;
}

function valueNoise(size: number, seed: number, octaves: number): Float32Array {
  const random = seededRandom(seed);
  const out = new Float32Array(size * size);
  let amplitude = 1, total = 0;
  for (let octave = 0; octave < octaves; octave++) {
    const cells = 4 << octave;
    const lattice = new Float32Array(cells * cells);
    for (let i = 0; i < lattice.length; i++) lattice[i] = random();
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const u = x / size * cells, v = y / size * cells;
      const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const at = (cx: number, cy: number) => lattice[((cy % cells + cells) % cells) * cells + ((cx % cells + cells) % cells)]!;
      const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
      const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      out[y * size + x]! += (top + (bottom - top) * sy) * amplitude;
    }
    total += amplitude; amplitude *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i]! /= total;
  return out;
}

function dataTexture(size: number, fill: (x: number, y: number, index: number) => [number, number, number], color: boolean): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const index = y * size + x, [r, g, b] = fill(x, y, index);
    data[index * 4] = Math.round(THREE.MathUtils.clamp(r, 0, 1) * 255);
    data[index * 4 + 1] = Math.round(THREE.MathUtils.clamp(g, 0, 1) * 255);
    data[index * 4 + 2] = Math.round(THREE.MathUtils.clamp(b, 0, 1) * 255);
    data[index * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export function createWeaponPalette(): WeaponPalette {
  const size = 128;
  const coarse = valueNoise(size, 11, 4), fine = valueNoise(size, 23, 5), grain = valueNoise(size, 37, 3);
  // Roughness lives in the green channel; keep variation subtle so metal still reads as metal.
  const roughness = dataTexture(size, (_x, _y, i) => { const v = 0.82 + 0.3 * (coarse[i]! - 0.5) + 0.18 * (fine[i]! - 0.5); return [v, v, v]; }, false);
  const stipple = dataTexture(size, (_x, _y, i) => { const v = fine[i]! > 0.52 ? 1 : 0.35 + fine[i]!; return [v, v, v]; }, false);
  const wood = dataTexture(size, (x, y, i) => {
    // Fine, low-contrast grain: thin rings bent by noise plus long streaks.
    const ring = 0.5 + 0.5 * Math.sin((y / size) * Math.PI * 2 * 16 + coarse[i]! * 9 + Math.sin(x / size * Math.PI * 4) * 0.8);
    const streak = 0.9 + 0.2 * (grain[i]! - 0.5) + 0.08 * (fine[i]! - 0.5);
    const shade = (0.84 + 0.16 * ring * ring) * streak;
    return [0.4 * shade, 0.225 * shade, 0.115 * shade];
  }, true);
  const camo = dataTexture(size, (x, y, i) => {
    const blot = coarse[i]!, weave = ((x + y) % 4 < 2 ? 0.96 : 1.04) * (0.94 + 0.12 * fine[i]!);
    const base = blot > 0.6 ? [0.2, 0.21, 0.15] : blot > 0.45 ? [0.36, 0.34, 0.24] : [0.47, 0.44, 0.33];
    return [base[0]! * weave, base[1]! * weave, base[2]! * weave];
  }, true);
  const fabric = dataTexture(size, (x, y, i) => { const v = ((x + y) % 4 < 2 ? 0.92 : 1) * (0.86 + 0.2 * fine[i]!); return [v, v, v]; }, false);
  const textures = [roughness, stipple, wood, camo, fabric];

  const standard = (name: string, parameters: THREE.MeshStandardMaterialParameters) => {
    const material = new THREE.MeshStandardMaterial(parameters); material.name = name; return material;
  };
  const palette = {
    anodized: standard('VM_Anodized', { color: '#232527', metalness: 0.75, roughness: 0.42, roughnessMap: roughness }),
    steel: standard('VM_Steel', { color: '#3a3c3e', metalness: 0.9, roughness: 0.32, roughnessMap: roughness }),
    polymer: standard('VM_Polymer', { color: '#1d1e1f', metalness: 0, roughness: 0.62, roughnessMap: roughness, bumpMap: stipple, bumpScale: 0.35 }),
    tan: standard('VM_TanPolymer', { color: '#8b7556', metalness: 0, roughness: 0.66, roughnessMap: roughness, bumpMap: stipple, bumpScale: 0.3 }),
    olive: standard('VM_OlivePolymer', { color: '#4b4f37', metalness: 0, roughness: 0.64, roughnessMap: roughness, bumpMap: stipple, bumpScale: 0.3 }),
    wood: standard('VM_Walnut', { color: '#ffffff', map: wood, metalness: 0, roughness: 0.5, roughnessMap: roughness }),
    rubber: standard('VM_Rubber', { color: '#151515', metalness: 0, roughness: 0.9 }),
    glass: new THREE.MeshBasicMaterial({ name: 'VM_SightGlass', color: '#bfe0ff', transparent: true, opacity: 0.07, depthWrite: false }),
    lens: standard('VM_Lens', { color: '#0d1a24', metalness: 0, roughness: 0.12 }),
    reticle: new THREE.MeshBasicMaterial({ color: '#ff3b2f', toneMapped: false }),
    sightDot: new THREE.MeshBasicMaterial({ color: '#e9f2e0' }),
    brass: standard('VM_Brass', { color: '#b8893e', metalness: 0.95, roughness: 0.3 }),
    hull: standard('VM_ShellHull', { color: '#8e1d18', metalness: 0, roughness: 0.55 }),
    blade: standard('VM_Blade', { color: '#b4b7ba', metalness: 0.8, roughness: 0.34, roughnessMap: roughness }),
    glove: standard('VM_Glove', { color: '#2f2d29', metalness: 0, roughness: 0.82, roughnessMap: fabric }),
    knuckle: standard('VM_GloveArmour', { color: '#5c5442', metalness: 0, roughness: 0.6, roughnessMap: roughness }),
    sleeve: standard('VM_Sleeve', { color: '#ffffff', map: camo, metalness: 0, roughness: 0.95, roughnessMap: fabric }),
  };
  palette.reticle.name = 'VM_Reticle'; palette.sightDot.name = 'VM_SightDot';
  const all = Object.values(palette) as THREE.Material[];
  return {
    ...palette,
    materials: () => all.slice(),
    textures: () => textures.slice(),
    dispose() { for (const material of all) material.dispose(); for (const texture of textures) texture.dispose(); },
  };
}
