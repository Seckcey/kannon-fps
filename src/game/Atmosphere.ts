import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { LightProbeGenerator } from 'three/examples/jsm/lights/LightProbeGenerator.js';

/** Kannon Town v3 light: golden hour. A low, warm sun in the west-south-west throws the houses'
 * shadows across the street; cool sky light fills the shade; a warm haze softens the hills.
 *
 * These values are the runtime half of the environment bake: scripts/blender/generate_town_v3.py
 * uses the same sun direction, colour and intensity and records what it baked in
 * art/source/town-v3/town-v3-lightmaps.json; tests/assets/town-v3-light.test.ts checks they agree.
 * GameView reads them; the environment art owns their values. */
export const SUN_DIRECTION = new THREE.Vector3(-0.8461, 0.3584, 0.3946).normalize();
export const SKY_LIGHT_INTENSITY = 0.055;
export const SUN_COLOR = '#ffc98f';
export const SUN_INTENSITY = 5.2;
/** Sky colour and ground bounce measured by the bake (calibration.skyUp, groundBounceDown); the
 * hemisphere carries about three quarters of the sky, the sky probe the rest. */
export const HEMISPHERE = { sky: '#9ec8ff', ground: '#746762', intensity: 1.4 } as const;
export const FOG = { color: '#c4b6a4', near: 40, far: 330 } as const;
export const EXPOSURE = 1.0;
/** Sky dome shading for the low sun: a little hazier than midday. The glow around the sun is
 * kept near v2's strength; any stronger and views toward the low sun bloom to white. */
export const SKY = { turbidity: 4.0, rayleigh: 1.8, mieCoefficient: 0.003, mieDirectionalG: 0.72, cloudCoverage: 0.45, cloudDensity: 0.75, cloudScale: 0.00055 } as const;

/** Clouds lit from below by the low sun: warm near it, grey-blue on their shaded undersides. */
export const GOLDEN_CLOUDS = `float kannonSunward = pow( max( dot( direction, vSunDirection ), 0.0 ), 6.0 );
				vec3 kannonLit = mix( vec3( 1.3, 1.2, 1.12 ), vec3( 3.2, 2.3, 1.45 ), kannonSunward );
				cloudColor = mix( vec3( .44, .46, .56 ), kannonLit, smoothstep( .35, .75, cloudNoise ) );`;

/** Shared daylight gives architecture and armor a coherent physical environment. */
export function createAtmosphere(renderer: THREE.WebGLRenderer) {
  const root = new THREE.Group();
  const supportsHdr = renderer.extensions.has('EXT_color_buffer_float');
  const sky = new Sky();
  sky.scale.setScalar(600);
  sky.material.uniforms.turbidity.value = SKY.turbidity;
  sky.material.uniforms.rayleigh.value = SKY.rayleigh;
  sky.material.uniforms.mieCoefficient.value = SKY.mieCoefficient;
  sky.material.uniforms.mieDirectionalG.value = SKY.mieDirectionalG;
  sky.material.uniforms.sunPosition.value.copy(SUN_DIRECTION);
  sky.material.uniforms.showSunDisc.value = false;
  sky.material.uniforms.cloudCoverage.value = SKY.cloudCoverage;
  sky.material.uniforms.cloudDensity.value = SKY.cloudDensity;
  sky.material.uniforms.cloudScale.value = SKY.cloudScale;
  sky.material.fragmentShader = sky.material.fragmentShader
    .replace('cloudNoise = cloudNoise * 0.5 + 0.5;', 'cloudNoise *= 0.6666667;')
    .replace('cloudColor *= vSunE * 0.00002;', GOLDEN_CLOUDS);
  if (!supportsHdr) sky.material.fragmentShader = sky.material.fragmentShader.replace('vec4( texColor, 1.0 )', 'vec4( texColor / (texColor + vec3(1.0)), 1.0 )');
  const skyScene = new THREE.Scene(); skyScene.add(sky);
  // Bake atmospheric scattering once. Running its cloud noise per screen pixel
  // each frame is needlessly expensive, especially on integrated phone GPUs.
  const background = new THREE.WebGLCubeRenderTarget(512, { type: supportsHdr ? THREE.HalfFloatType : THREE.UnsignedByteType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  new THREE.CubeCamera(0.1, 1000, background).update(renderer, skyScene);
  let reflection: THREE.WebGLRenderTarget | null = null;
  let probeTarget: THREE.WebGLCubeRenderTarget | null = null;
  const disposeProbe = () => {
    const target = probeTarget;
    probeTarget = null;
    target?.dispose();
  };
  let diffuseSky: Promise<THREE.Vector3[] | null> = Promise.resolve(null);
  if (supportsHdr) {
    const generator = new THREE.PMREMGenerator(renderer);
    reflection = generator.fromCubemap(background.texture);
    generator.dispose();
    // Rough limestone needs diffuse sky lighting, not repeated filtered cubemap
    // reads at every pixel. A tiny probe records the same sky in nine vectors.
    probeTarget = new THREE.WebGLCubeRenderTarget(16, { type: THREE.HalfFloatType });
    new THREE.CubeCamera(0.1, 1000, probeTarget).update(renderer, skyScene);
    diffuseSky = LightProbeGenerator.fromCubeRenderTarget(renderer, probeTarget)
      .then(probe => probe.sh.coefficients).catch(() => null).finally(disposeProbe);
  }
  sky.geometry.dispose(); sky.material.dispose();

  return {
    root, environment: reflection?.texture ?? null, background: background.texture, diffuseSky,
    update(_seconds: number) {},
    // Release the probe before the owning renderer clears its WebGL properties.
    // A pending readback may settle later; its guarded cleanup then does nothing.
    dispose() { disposeProbe(); reflection?.dispose(); background.dispose(); },
  };
}
