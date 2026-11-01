import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { ktx2Loader } from './Ktx2';
import { environmentAssetUrl, getArenaAssetBuffer, type TextureTier } from './assets';
import { LightmapPlugin, applyLightmapShading, lightmapHasShadeAlpha } from './Lightmaps';
import { applyVertexSunVisibility } from './SunVisibility';
import { createAtmosphere, SKY_LIGHT_INTENSITY } from './Atmosphere';

export interface ArenaWorld {
  root: THREE.Group;
  environment: THREE.Texture | null;
  background: THREE.CubeTexture;
  /** Cosmetic meshes named `Breakable*` (window glass, pots) that shatter when a tracer crosses them; filled on load. */
  breakables: THREE.Mesh[];
  prepareReflections(scene: THREE.Scene): void;
  /** Grass cards are pure decoration: none on phones, half on desktop Auto, all on High. */
  setGrassDensity(density: 0 | 1 | 2): void;
  update(time: number): void;
  dispose(): void;
}

/** Local graphics experiment only; normal arena loading remains the default. */
export interface WorldArtwork { environmentUrl: string; environmentVisible?: boolean; vehicles?: Array<{ name: string; url: string; visible: boolean }> }

/** Kannon Town v3 decals (scorch, oil, tyre tracks, mud) are multiply decals: white leaves the
 *  ground untouched, so they can only darken it, and fog fades them back to white. */
export const DECAL_MATERIAL = /^V3_Decals/;
/** Distant smoke columns: unlit, soft-edged, swaying slowly with the wind. */
export const SMOKE_MATERIAL = /^V3_Smoke/;
/** Breakable window panes: thin, see-through and reflective. */
export const WINDOW_GLASS_MATERIAL = /^V3_WindowGlass/;
/** Concertina wire: strands thinner than a shadow-map texel, not lightmapped. Its colour
 *  attribute's alpha carries sun visibility measured in Blender (see applyVertexSunVisibility). */
export const WIRE_MATERIAL = /^V3_Wire/;
/** Unbaked surfaces lit by the real-time sun through per-vertex sun visibility: wire, grass cards. */
export const UNBAKED_SUN_MATERIAL = /^V3_Wire|GrassCard/i;
const GROUND_MATERIAL = /GroundGrass|GroundAsphalt|Cliff/i;
const HORIZON_NODE = /Horizon|Exterior/i;
/** Pots are baked without casting into the lightmaps, so their shadow must leave with them. */
const BREAKABLE_POT = /^Breakable_Pot_/;

/** Whether an environment mesh draws into the real-time sun shadow map. Decided per mesh, never
 *  per material, because meshes share materials (six panes share one glass, the truck shares its
 *  paint with the props). Lightmapped surfaces already carry their shadows in the bake, and the
 *  shade level lets a real-time shadow remove only baked sun, so the casters left are the pots,
 *  whose shadows are deliberately not baked, and unbaked decoration such as grass cards. Glass
 *  never hides what is behind it; wire, decals and smoke are too thin or not solid. */
export function castsRealtimeShadow(object: THREE.Object3D): boolean {
  if (!(object instanceof THREE.Mesh)) return false;
  const names: string[] = [];
  for (let current: THREE.Object3D | null = object; current; current = current.parent) names.push(current.name);
  if (names.some(name => HORIZON_NODE.test(name))) return false;
  const materials: THREE.Material[] = Array.isArray(object.material) ? object.material : [object.material];
  if (materials.some(material => [DECAL_MATERIAL, SMOKE_MATERIAL, WINDOW_GLASS_MATERIAL, WIRE_MATERIAL].some(pattern => pattern.test(material.name)))) return false;
  if (materials.every(material => GROUND_MATERIAL.test(material.name))) return false;
  if (names.some(name => BREAKABLE_POT.test(name))) return true;
  return !materials.some(material => !!(material as THREE.MeshStandardMaterial).lightMap);
}

/** Wind is computed in world metres. Meshopt stores positions as normalised integers scaled by
 *  the node (the smoke node is scaled 187 times), so the raw `position` attribute cannot drive it.
 *  The world offset goes back into the node's local space through its uniform scale. */
function worldSway(offset: string): string {
  return `#include <begin_vertex>
	vec3 kannonWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
	vec3 kannonOffset = ${offset};
	transformed += ( kannonOffset * mat3( modelMatrix ) ) / dot( modelMatrix[ 0 ].xyz, modelMatrix[ 0 ].xyz );`;
}
const glsl = (value: number) => value.toFixed(4);

/** Distant smoke: column bases sit at y = -8 and tops at 66 to 104 m; the tops drift metres. */
export const SMOKE_SWAY = { riseFrom: -8, riseTo: 100, amplitude: { x: 3, z: 2 }, speed: { x: 0.11, z: 0.08 } } as const;
/** Bushes, tree canopies and grass cards: a few centimetres, more the higher the leaf. */
export const FOLIAGE_SWAY = { riseFrom: 0.15, riseTo: 1.6, amplitude: { x: 0.045, z: 0.025 }, speed: { x: 1.15, z: 0.8 } } as const;
type Sway = typeof SMOKE_SWAY | typeof FOLIAGE_SWAY;

/** The offset the sway shaders add, in world metres, for a vertex at `world` at time `time`. */
export function swayOffset(sway: Sway, world: { x: number; y: number; z: number }, time: number): { x: number; z: number } {
  const t = Math.min(1, Math.max(0, (world.y - sway.riseFrom) / (sway.riseTo - sway.riseFrom)));
  const rise = t * t * (3 - 2 * t);
  const phase = sway === SMOKE_SWAY
    ? { x: world.y * 0.035 + world.z * 0.01, z: world.y * 0.03 + world.x * 0.01 }
    : { x: world.z * 0.35 + world.y * 0.85, z: world.x * 0.3 };
  return { x: Math.sin(time * sway.speed.x + phase.x) * sway.amplitude.x * rise, z: Math.cos(time * sway.speed.z + phase.z) * sway.amplitude.z * rise };
}

function swayGlsl(sway: Sway): string {
  const phase = sway === SMOKE_SWAY
    ? { x: 'kannonWorld.y * 0.035 + kannonWorld.z * 0.01', z: 'kannonWorld.y * 0.03 + kannonWorld.x * 0.01' }
    : { x: 'kannonWorld.z * 0.35 + kannonWorld.y * 0.85', z: 'kannonWorld.x * 0.3' };
  return `vec3( sin( uWindTime * ${glsl(sway.speed.x)} + ${phase.x} ) * ${glsl(sway.amplitude.x)}, 0.0, cos( uWindTime * ${glsl(sway.speed.z)} + ${phase.z} ) * ${glsl(sway.amplitude.z)} ) * smoothstep( ${glsl(sway.riseFrom)}, ${glsl(sway.riseTo)}, kannonWorld.y )`;
}

/** Vertex patch for any material swaying with the shared wind clock. */
export function patchSwayVertex(vertexShader: string, sway: Sway): string {
  if (vertexShader.includes('kannonWorld')) return vertexShader;
  return vertexShader
    .replace('#include <common>', '#include <common>\nuniform float uWindTime;')
    .replace('#include <begin_vertex>', worldSway(swayGlsl(sway)));
}

const FOG_TOWARD_WHITE = `#ifdef USE_FOG
  #ifdef FOG_EXP2
    float kannonFog = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float kannonFog = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( 1.0 ), kannonFog );
#endif`;

export function createDecalMaterial(map: THREE.Texture | null): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    map, transparent: true, blending: THREE.MultiplyBlending, premultipliedAlpha: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false, fog: true,
  });
  material.name = 'V3_Decals_multiply';
  material.onBeforeCompile = shader => { shader.fragmentShader = shader.fragmentShader.replace('#include <fog_fragment>', FOG_TOWARD_WHITE); };
  material.customProgramCacheKey = () => 'kannon-decal-multiply-v1';
  return material;
}

export function createSmokeMaterial(map: THREE.Texture | null, time: { value: number }): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false, color: new THREE.Color('#f2e2cf') });
  material.name = 'V3_Smoke_unlit';
  material.onBeforeCompile = shader => {
    shader.uniforms.uWindTime = time;
    shader.vertexShader = patchSwayVertex(shader.vertexShader, SMOKE_SWAY);
  };
  material.customProgramCacheKey = () => 'kannon-smoke-v2';
  return material;
}

/** Original Blender architecture shares coordinates with the authoritative map. */
export function createWorld(renderer: THREE.WebGLRenderer, textureTier: TextureTier, onReady: () => void, onError: (message: string) => void, artwork?: WorldArtwork): ArenaWorld {
  const root = new THREE.Group();
  const atmosphere = createAtmosphere(renderer); root.add(atmosphere.root);
  const textures = new Set<THREE.Texture>();
  const windTime = { value: 0 };
  let disposed = false;
  let reflection: THREE.WebGLRenderTarget | null = null;
  const reflectiveMaterials = new Set<THREE.MeshStandardMaterial>();
  const grassCards: THREE.Mesh[] = [];
  const breakables: THREE.Mesh[] = [];
  const ownedMaterials = new Set<THREE.Material>();
  let grassDensity: 0 | 1 | 2 = 2;
  const applyGrassDensity = () => {
    for (const mesh of grassCards) {
      mesh.visible = grassDensity > 0;
      const count = mesh.geometry.index?.count ?? mesh.geometry.attributes.position?.count ?? 0;
      mesh.geometry.setDrawRange(0, grassDensity === 1 ? Math.floor(count / 6) * 3 : count);
    }
  };
  // KTX2 textures stay GPU-compressed; the Basis transcoder is bundled from this origin.
  const ktx2 = ktx2Loader(renderer);
  const loader = () => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2).register(parser => new LightmapPlugin(parser));
  const load = async () => {
    if (!artwork) return loader().parseAsync(await getArenaAssetBuffer(environmentAssetUrl(textureTier)), '/models/');
    const assets = [{ name: 'VehicleTestTown', url: artwork.environmentUrl, visible: artwork.environmentVisible ?? true }, ...(artwork.vehicles ?? [])];
    const loaded = await Promise.all(assets.map(async asset => {
      const gltf = await loader().parseAsync(await getArenaAssetBuffer(asset.url), '/models/');
      gltf.scene.name = asset.name; gltf.scene.visible = asset.visible; return gltf.scene;
    }));
    const scene = new THREE.Group(); scene.add(...loaded); return { scene };
  };
  load().then(async gltf => {
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
    const replaced = new Map<THREE.Material, THREE.Material>();
    gltf.scene.traverse(object => {
      if (object.userData.kannonGuide) { object.visible = false; return; }
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      const special = materials.length === 1 && materials[0] instanceof THREE.MeshStandardMaterial ? materials[0] : null;
      if (special && (DECAL_MATERIAL.test(special.name) || SMOKE_MATERIAL.test(special.name))) {
        // Multiply decals and smoke are not lit surfaces: swap in their own unlit materials.
        let swap = replaced.get(special);
        if (!swap) {
          if (special.map) { special.map.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy()); textures.add(special.map); }
          swap = DECAL_MATERIAL.test(special.name) ? createDecalMaterial(special.map) : createSmokeMaterial(special.map, windTime);
          replaced.set(special, swap); ownedMaterials.add(swap); special.dispose();
        }
        object.material = swap; object.castShadow = false; object.receiveShadow = false;
        object.renderOrder = DECAL_MATERIAL.test(special.name) ? 1 : 2;
        return;
      }
      if (materials.some(material => /GrassCard/i.test(material.name))) grassCards.push(object);
      if (/^Breakable/i.test(object.name)) breakables.push(object);
      // Per mesh, outside the per-material setup below: several meshes share each material.
      object.castShadow = castsRealtimeShadow(object);
      object.receiveShadow = true;
      for (const material of materials) {
        if (configured.has(material)) continue;
        configured.add(material);
        for (const [key, value] of Object.entries(material)) if (value instanceof THREE.Texture) {
          value.anisotropy = Math.min(key === 'map' ? 4 : key === 'normalMap' ? 2 : 1, renderer.capabilities.getMaxAnisotropy()); textures.add(value);
        }
        if (!(material instanceof THREE.MeshStandardMaterial)) continue;
        // A transmissive material would make three.js redraw the whole scene into a
        // transmission buffer every frame. Render such glass as ordinary tinted transparency.
        if (material instanceof THREE.MeshPhysicalMaterial && material.transmission > 0) {
          material.transmission = 0; material.transparent = true; material.opacity = Math.min(material.opacity, 0.55);
        }
        if (/Vehicle_.*(?:Metallic|Enamel|Aluminium|Steel|Glass)|RefinedArchitecturalGlass|V2_Glass|V3_WindowGlass/.test(material.name)) reflectiveMaterials.add(material);
        material.envMapIntensity = /Petrol|Bronze/i.test(material.name) ? 1.05 : 0.75;
        // Breakable panes stay see-through from both sides and never hide what is behind them.
        if (WINDOW_GLASS_MATERIAL.test(material.name)) { material.transparent = true; material.depthWrite = false; }
        if (/Leaves|Flower|GrassCard/i.test(material.name)) {
          material.side = THREE.DoubleSide;
          material.onBeforeCompile = shader => {
            shader.uniforms.uWindTime = windTime;
            shader.vertexShader = patchSwayVertex(shader.vertexShader, FOLIAGE_SWAY);
          };
          material.customProgramCacheKey = () => 'sunbreak-foliage-v3';
        }
        if (diffuseSky && !material.lightMap && /Ground|Limestone|Cliff|Bark|Leaves|Flower/i.test(material.name)) {
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
          material.customProgramCacheKey = () => /Leaves|Flower/i.test(material.name) ? 'sunbreak-leaf-diffuse-sky-v3' : 'sunbreak-stone-diffuse-sky-v2';
        }
        // Wire and grass cards are not baked: their vertex alpha says where the low sun reaches.
        // Chained after the wind patch, which sets onBeforeCompile outright.
        if (UNBAKED_SUN_MATERIAL.test(material.name)) applyVertexSunVisibility(material);
        if (material.lightMap) {
          // Baked sun and sky: no real-time sun, reflections only on glass and metal. A shade level
          // in the lightmap's alpha (v3) limits real-time shadows to the baked sun they block.
          applyLightmapShading(material, { shadeAlpha: lightmapHasShadeAlpha(material) });
          material.envMapIntensity = /Glass|Metal|Vehicle_/i.test(material.name) ? 0.8 : 0.2;
        }
      }
    });
    applyGrassDensity();
    root.add(gltf.scene); onReady();
  }).catch(() => { if (!disposed) onError('The arena artwork could not load. Return to the lobby and try again.'); });
  return {
    root, environment: atmosphere.environment, background: atmosphere.background, breakables,
    prepareReflections(scene) {
      if (disposed || reflection || !reflectiveMaterials.size || !atmosphere.environment) return;
      // Bake the actual static street once. Cars and closed glazing reflect the
      // town rather than an empty sky; no six-camera redraw occurs during play.
      const target = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType });
      const generator = new THREE.PMREMGenerator(renderer);
      try {
        const probe = new THREE.CubeCamera(.1, 180, target); probe.position.set(0, 2.3, -3.5);
        probe.update(renderer, scene); reflection = generator.fromCubemap(target.texture);
        for (const material of reflectiveMaterials) {
          material.envMap = reflection.texture;
          material.envMapIntensity = /Glass/.test(material.name) ? .62 : /Aluminium|Steel/.test(material.name) ? .8 : .42;
          material.needsUpdate = true;
        }
        scene.userData.streetReflection = { size: 128, position: [0, 2.3, -3.5], static: true };
      } finally { generator.dispose(); target.dispose(); }
    },
    setGrassDensity(density) { grassDensity = density; applyGrassDensity(); },
    update(time) { windTime.value = time; atmosphere.update(time); },
    dispose() { disposed = true; for (const texture of textures) texture.dispose(); for (const material of ownedMaterials) material.dispose(); reflection?.dispose(); atmosphere.dispose(); },
  };
}
