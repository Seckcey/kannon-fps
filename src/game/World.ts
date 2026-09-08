import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ARENA_ASSETS, getArenaAssetBuffer } from './assets';
import { createAtmosphere, SKY_LIGHT_INTENSITY } from './Atmosphere';

export interface ArenaWorld {
  root: THREE.Group;
  environment: THREE.Texture | null;
  background: THREE.CubeTexture;
  update(time: number): void;
  dispose(): void;
}

/** Original Blender architecture shares coordinates with the authoritative map. */
export function createWorld(renderer: THREE.WebGLRenderer, onReady: () => void, onError: (message: string) => void): ArenaWorld {
  const root = new THREE.Group();
  const atmosphere = createAtmosphere(renderer); root.add(atmosphere.root);
  const textures = new Set<THREE.Texture>();
  const windTime = { value: 0 };
  let disposed = false;
  const isHorizon = (object: THREE.Object3D) => {
    for (let current: THREE.Object3D | null = object; current; current = current.parent) if (/Horizon|Exterior/i.test(current.name)) return true;
    return false;
  };
  getArenaAssetBuffer(ARENA_ASSETS.environment).then(buffer => new GLTFLoader().parseAsync(buffer, '/models/')).then(async gltf => {
    const diffuseSky = await atmosphere.diffuseSky;
    if (disposed) {
      gltf.scene.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
          material.dispose();
        }
      });
      return;
    }
    const configured = new Set<THREE.Material>();
    gltf.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      object.castShadow = !isHorizon(object) && !materials.every(material => /Ground|Cliff/i.test(material.name));
      object.receiveShadow = true;
      for (const material of materials) {
        if (configured.has(material)) continue;
        configured.add(material);
        for (const [key, value] of Object.entries(material)) if (value instanceof THREE.Texture) {
          value.anisotropy = Math.min(key === 'map' ? 4 : key === 'normalMap' ? 2 : 1, renderer.capabilities.getMaxAnisotropy()); textures.add(value);
        }
        if (!(material instanceof THREE.MeshStandardMaterial)) continue;
        material.envMapIntensity = /Petrol|Bronze/i.test(material.name) ? 1.05 : 0.75;
        if (/Leaves|Flower/i.test(material.name)) {
          material.side = THREE.DoubleSide;
          material.onBeforeCompile = shader => {
            shader.uniforms.uWindTime = windTime;
            shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float uWindTime;');
            shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
              transformed.x += sin(uWindTime*1.15+position.z*.35+position.y*.85)*.045*smoothstep(1.,7.,position.y);
              transformed.z += cos(uWindTime*.8+position.x*.3)*.025*smoothstep(1.,7.,position.y);`);
          };
          material.customProgramCacheKey = () => 'sunbreak-foliage-v2';
        }
        if (diffuseSky && /Ground|Limestone|Cliff|Bark|Leaves|Flower/i.test(material.name)) {
          const configureWind = material.onBeforeCompile;
          material.onBeforeCompile = (shader, activeRenderer) => {
            configureWind.call(material, shader, activeRenderer);
            shader.uniforms.uDiffuseSky = { value: diffuseSky };
            shader.uniforms.uDiffuseSkyIntensity = { value: SKY_LIGHT_INTENSITY * material.envMapIntensity };
            shader.fragmentShader = shader.fragmentShader
              .replace('#include <envmap_physical_pars_fragment>', '')
              .replace('#include <lights_pars_begin>', `#include <lights_pars_begin>
                uniform vec3 uDiffuseSky[9];
                uniform float uDiffuseSkyIntensity;
                vec3 getIBLIrradiance(const in vec3 normal) {
                  vec3 worldNormal=transformNormalByInverseViewMatrix(normal,viewMatrix);
                  return max(vec3(0.),shGetIrradianceAt(worldNormal,uDiffuseSky))*uDiffuseSkyIntensity;
                }
                vec3 getIBLRadiance(const in vec3 viewDir,const in vec3 normal,const in float roughness) {
                  return getIBLIrradiance(normal)/PI;
                }`);
          };
          material.customProgramCacheKey = () => /Leaves|Flower/i.test(material.name) ? 'sunbreak-leaf-diffuse-sky-v2' : 'sunbreak-stone-diffuse-sky-v2';
        }
      }
    });
    root.add(gltf.scene); onReady();
  }).catch(() => { if (!disposed) onError('The arena artwork could not load. Return to the lobby and try again.'); });
  return {
    root, environment: atmosphere.environment, background: atmosphere.background,
    update(time) { windTime.value = time; atmosphere.update(time); },
    dispose() { disposed = true; for (const texture of textures) texture.dispose(); atmosphere.dispose(); },
  };
}
