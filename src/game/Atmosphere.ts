import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { LightProbeGenerator } from 'three/examples/jsm/lights/LightProbeGenerator.js';

export const SUN_DIRECTION = new THREE.Vector3(-38, 52, 28).normalize();
export const SKY_LIGHT_INTENSITY = 0.055;

/** Shared daylight gives stone, armor and water a coherent physical environment. */
export function createAtmosphere(renderer: THREE.WebGLRenderer) {
  const root = new THREE.Group();
  const supportsHdr = renderer.extensions.has('EXT_color_buffer_float');
  const sky = new Sky();
  sky.scale.setScalar(600);
  sky.material.uniforms.turbidity.value = 3.2;
  sky.material.uniforms.rayleigh.value = 2.2;
  sky.material.uniforms.mieCoefficient.value = 0.0035;
  sky.material.uniforms.mieDirectionalG.value = 0.8;
  sky.material.uniforms.sunPosition.value.copy(SUN_DIRECTION);
  sky.material.uniforms.showSunDisc.value = false;
  sky.material.uniforms.cloudCoverage.value = 0.55;
  sky.material.uniforms.cloudDensity.value = 0.85;
  sky.material.uniforms.cloudScale.value = 0.00055;
  sky.material.fragmentShader = sky.material.fragmentShader
    .replace('cloudNoise = cloudNoise * 0.5 + 0.5;', 'cloudNoise *= 0.6666667;')
    .replace('cloudColor *= vSunE * 0.00002;', 'cloudColor = mix(vec3(.8,.95,1.15),vec3(3.6,3.5,3.3),smoothstep(.35,.75,cloudNoise));');
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

  const time = { value: 0 };
  const waterMaterial = new THREE.MeshStandardMaterial({ color: '#168b96', roughness: 0.26, metalness: 0.24, envMapIntensity: 1.1 });
  waterMaterial.onBeforeCompile = shader => {
    shader.uniforms.uWaterTime = time;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float uWaterTime; varying vec3 vWaterWorld;');
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      transformed.z += sin(position.x*.071+uWaterTime*.55)*.12 + sin(position.y*.047-position.x*.022+uWaterTime*.39)*.09;`);
    shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWaterWorld=(modelMatrix*vec4(transformed,1.)).xyz;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uWaterTime; varying vec3 vWaterWorld;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      float wx=cos(vWaterWorld.x*.72+vWaterWorld.z*.31+uWaterTime*.95)*.13+cos(vWaterWorld.x*1.8-uWaterTime*.6)*.035;
      float wz=sin(vWaterWorld.z*.87-vWaterWorld.x*.2+uWaterTime*.64)*.11+cos(vWaterWorld.z*2.3+uWaterTime*.8)*.03;
      normal=normalize(normal+mat3(viewMatrix)*vec3(wx,0.,wz));`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      float shallows=1.-smoothstep(42.,95.,length(vWaterWorld.xz));
      diffuseColor.rgb=mix(diffuseColor.rgb*.64,diffuseColor.rgb*vec3(.9,1.4,1.2),shallows);
      float crest=pow(max(0.,sin(vWaterWorld.x*1.8+vWaterWorld.z*2.1+uWaterTime*.8)),22.);
      diffuseColor.rgb+=crest*.014;`);
  };
  waterMaterial.customProgramCacheKey = () => 'sunbreak-water-v2';
  const water = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400, 80, 80), waterMaterial);
  water.rotation.x = -Math.PI / 2; water.position.y = -9;
  // Draw opaque land first so depth testing skips expensive sea shading beneath
  // the courtyard, instead of calculating water that is immediately covered.
  water.renderOrder = 1;
  water.name = 'SunbreakSea'; root.add(water);
  return {
    root, environment: reflection?.texture ?? null, background: background.texture, diffuseSky,
    update(seconds: number) { time.value = seconds; },
    // Release the probe before the owning renderer clears its WebGL properties.
    // A pending readback may settle later; its guarded cleanup then does nothing.
    dispose() { disposeProbe(); reflection?.dispose(); background.dispose(); },
  };
}
