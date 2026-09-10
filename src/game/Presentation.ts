import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/** Reconstruct contact normals from the color pass depth instead of redrawing
 * the entire arena, every animated player, and their shadows a second time. */
class ContactPass extends GTAOPass {
  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, dt: number, mask: boolean) {
    this.setGBuffer(readBuffer.depthTexture ?? undefined);
    super.render(renderer, writeBuffer, readBuffer, dt, mask);
  }
}

/** Display-space grade: a touch more saturation and warmth, gentle contrast and a soft
 *  vignette. Runs after tone mapping, before anti-aliasing. */
export const GradeShader = {
  name: 'KannonGradeShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uSaturation: { value: 1.12 },
    uContrast: { value: 1.05 },
    uWarmth: { value: 0.03 },
    uVignette: { value: 0.28 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uSaturation, uContrast, uWarmth, uVignette;
    varying vec2 vUv;
    void main() {
      vec4 texel = texture2D( tDiffuse, vUv );
      vec3 color = texel.rgb;
      float luma = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
      color = mix( vec3( luma ), color, uSaturation );
      color = ( color - 0.5 ) * uContrast + 0.5;
      color += vec3( uWarmth, uWarmth * 0.35, -uWarmth ) * luma;
      vec2 centred = vUv - 0.5;
      float vignette = 1.0 - uVignette * smoothstep( 0.35, 0.95, dot( centred, centred ) * 2.2 );
      gl_FragColor = vec4( clamp( color * vignette, 0.0, 1.0 ), texel.a );
    }`,
};

export interface PresentationOptions { bloom: boolean }

/** Desktop presentation: contact shading, bloom on the brightest highlights, a colour grade
 *  and SMAA edges. Phones render directly and never download this module. */
export class ArenaPresentation {
  private readonly composer: EffectComposer;
  private readonly ambient: GTAOPass;
  private readonly bloom: UnrealBloomPass | null = null;
  private readonly output = new OutputPass();
  private readonly grade = new ShaderPass(GradeShader);
  private readonly antialias = new SMAAPass();
  enabled = true;

  constructor(private renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, options: PresentationOptions = { bloom: true }) {
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
    });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.ambient = new ContactPass(scene, camera, 1, 1);
    this.ambient.updateGtaoMaterial({ radius: 0.7, thickness: 0.45, distanceExponent: 1.5, distanceFallOff: 0.6, samples: 8 });
    this.ambient.updatePdMaterial({ radius: 5, rings: 2, samples: 8 });
    // Eight deterministic directions. Round trigonometric near-zero values so
    // ANGLE does not compile sub-precision constants into the denoiser.
    this.ambient.pdMaterial.defines.SAMPLE_VECTORS = `vec3[SAMPLES](${Array.from({ length: 8 }, (_, i) => {
      const angle = 2.399963229728653 * i;
      return `vec3(${Math.cos(angle).toFixed(6)},${Math.sin(angle).toFixed(6)},${((i / 7) ** 2).toFixed(6)})`;
    }).join(',')})`;
    this.ambient.blendIntensity = 0.55;
    this.composer.addPass(this.ambient);
    if (options.bloom) {
      // Only emissive and specular peaks pass the threshold; ordinary sunlit surfaces do not glow.
      // Linear HDR luminance: sunlit paint sits near 0.7 and the sky background near 1.5, so
      // only emissive lamps, muzzle flashes and specular peaks above 2.4 glow.
      this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.28, 0.35, 2.4);
      this.composer.addPass(this.bloom);
    }
    this.composer.addPass(this.output);
    this.composer.addPass(this.grade);
    this.composer.addPass(this.antialias);
  }

  resize(width: number, height: number) {
    const ratio = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(width, height);
    this.ambient.setSize(Math.max(1, Math.floor(width * ratio * 0.6)), Math.max(1, Math.floor(height * ratio * 0.6)));
    this.bloom?.setSize(Math.max(1, Math.floor(width * ratio * 0.5)), Math.max(1, Math.floor(height * ratio * 0.5)));
  }

  render(dt: number) { this.composer.render(dt); }
  dispose() {
    this.ambient.dispose();
    // Three r185's GTAOPass.dispose omits this owned shader material.
    this.ambient.gtaoMaterial.dispose();
    this.bloom?.dispose();
    this.output.dispose(); this.grade.dispose(); this.antialias.dispose(); this.composer.dispose();
  }
}
