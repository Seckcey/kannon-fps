import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';

/** Reconstruct contact normals from the color pass depth instead of redrawing
 * the entire arena, every animated player, and their shadows a second time. */
class ContactPass extends GTAOPass {
  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, dt: number, mask: boolean) {
    this.setGBuffer(readBuffer.depthTexture ?? undefined);
    super.render(renderer, writeBuffer, readBuffer, dt, mask);
  }
}

/** Desktop contact shading; ordinary direct rendering remains available on phones. */
export class ArenaPresentation {
  private readonly composer: EffectComposer;
  private readonly ambient: GTAOPass;
  private readonly output = new OutputPass();
  private readonly antialias = new ShaderPass({
    ...FXAAShader,
    // A render target has only mip zero. Explicit LOD also makes samples valid
    // inside the edge search's divergent loop on Direct3D/ANGLE.
    fragmentShader: FXAAShader.fragmentShader
      .replace('return texture( tex2D, uv );', 'return textureLod( tex2D, uv, 0.0 );')
      .replace(/vec4 ApplyFXAA\([\s\S]*?\n\s*void main\(\)/, `vec4 ApplyFXAA(sampler2D tex2D, vec2 texSize, vec2 uv) {
        vec4 result = Sample(tex2D, uv);
        LuminanceData luminance = SampleLuminanceNeighborhood(tex2D, texSize, uv);
        if (!ShouldSkipPixel(luminance)) {
          float pixelBlend = DeterminePixelBlendFactor(luminance);
          EdgeData edge = DetermineEdge(texSize, luminance);
          float edgeBlend = DetermineEdgeBlendFactor(tex2D, texSize, luminance, edge, uv);
          float finalBlend = max(pixelBlend, edgeBlend);
          if (edge.isHorizontal) uv.y += edge.pixelStep * finalBlend;
          else uv.x += edge.pixelStep * finalBlend;
          result = Sample(tex2D, uv);
        }
        return result;
      }
      void main()`),
  });
  enabled = true;

  constructor(private renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
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
    this.ambient.blendIntensity = 0.62;
    this.composer.addPass(this.ambient);
    this.composer.addPass(this.output);
    this.composer.addPass(this.antialias);
  }

  resize(width: number, height: number) {
    const ratio = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(width, height);
    this.ambient.setSize(Math.max(1, Math.floor(width * ratio * 0.6)), Math.max(1, Math.floor(height * ratio * 0.6)));
    this.antialias.uniforms.resolution.value.set(1 / (width * ratio), 1 / (height * ratio));
  }

  render(dt: number) { this.composer.render(dt); }
  dispose() {
    this.ambient.dispose();
    // Three r185's GTAOPass.dispose omits this owned shader material.
    this.ambient.gtaoMaterial.dispose();
    this.output.dispose(); this.antialias.dispose(); this.composer.dispose();
  }
}
