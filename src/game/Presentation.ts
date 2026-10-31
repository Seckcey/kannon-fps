import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { RenderTier } from './RenderTiers';
import { screenCondition, unitValue } from './RenderQuality';

/** Reconstruct contact normals from the color pass depth instead of redrawing
 * the entire arena, every animated player, and their shadows a second time.
 * The occlusion is multiplied into the image in place: the stock pass first copies the whole frame
 * to the other buffer, a full-resolution pass that integrated GPUs feel. */
class ContactPass extends GTAOPass {
  private readonly shade = new FullScreenQuad(this.blendMaterial);

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    super(scene, camera, 1, 1);
    this.output = GTAOPass.OUTPUT.Off;
    this.needsSwap = false;
  }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, dt: number, mask: boolean) {
    this.setGBuffer(readBuffer.depthTexture ?? undefined);
    super.render(renderer, writeBuffer, readBuffer, dt, mask);
    this.blendMaterial.uniforms.intensity.value = this.blendIntensity;
    this.blendMaterial.uniforms.tDiffuse.value = this.pdRenderTarget.texture;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    this.shade.render(renderer);
    renderer.autoClear = autoClear;
  }

  override dispose() {
    super.dispose();
    // Three r185's GTAOPass.dispose omits these two owned shader materials.
    this.gtaoMaterial.dispose(); this.blendMaterial.dispose();
  }
}

const LUMA = [0.2126, 0.7152, 0.0722] as const;

/** Remove the brightness from a colour offset so it changes hue only. */
export function neutralTint(r: number, g: number, b: number): [number, number, number] {
  const luma = r * LUMA[0] + g * LUMA[1] + b * LUMA[2];
  return [r - luma, g - luma, b - luma];
}

/** Every tuned number of the desktop look in one place. Grade values are display space (after tone
 * mapping); bloom values are linear HDR luminance. */
export const LOOK = {
  grade: {
    /** Slightly drained colour. */
    saturation: 0.9,
    /** Strength of the S-curve around mid grey (0 = none). */
    curve: 0.3,
    /** Matte film lift of the blacks. */
    lift: 0.012,
    /** Split toning: cool, slightly teal shadows and warm highlights, with no brightness change. */
    shadowTint: neutralTint(-0.016, 0.004, 0.026),
    highlightTint: neutralTint(0.032, 0.011, -0.026),
    vignette: 0.34,
    /** Peak grain in the midtones; it changes `grainRate` times a second, like film. */
    grain: 0.03,
    grainRate: 24,
    /** Colour fringing in pixels at the corners of a 1080-line image (High only). */
    aberration: 1.4,
  },
  condition: {
    /** Saturation when nearly out of health. */
    saturation: 0.32,
    /** Extra corner darkening when nearly out of health. */
    vignette: 0.3,
    /** Strength of the red edges when nearly out of health. */
    red: 0.62,
  },
  aim: {
    /** Extra corner darkening at full aim. */
    vignette: 0.08,
    /** Weapon blur radius in pixels of a 1080-line image at full aim, and its cap on large images. */
    blur: 5.5,
    maxBlur: 8,
    /** Screen-height units from the centre: inside `sharpRadius` nothing blurs; full blur from `fullRadius`. */
    sharpRadius: 0.12,
    fullRadius: 0.62,
    /** Rough distance of the weapon from the eye (metres), for how far out of focus it is. */
    weaponDistance: 0.4,
  },
  bloom: {
    /** Linear luminance where glow starts and the width of its soft knee. Sunlit paint is about 0.7 and
     * the sky about 1.5, so only flashes, explosions, lamps and hot speculars glow. */
    threshold: 2,
    knee: 1,
    strength: 0.3,
    radius: 0.45,
    /** Added to the strength during a flash. */
    flashBoost: 0.5,
  },
} as const;

export interface PresentationOptions {
  bloom: boolean;
  /** Aim-down-sights blur of the first-person weapon. On unless false. */
  depthOfField?: boolean;
  /** Slight colour fringing at the screen edges. Off unless true (High). */
  chromaticAberration?: boolean;
  /** Edge smoothing: 'smaa' (default, sharpest) or 'fxaa' (one pass, about a third of the cost). */
  antialias?: 'smaa' | 'fxaa';
  /** Contact shading resolution as a share of the scene image, 0.25..1 (default 0.6). */
  contactScale?: number;
}

/** What the desktop presentation turns on for a render tier. High is the full look; Automatic trades
 * SMAA for FXAA and computes contact shading on fewer pixels, which cut the frame by about 30% on the
 * integrated AMD GPU at 1080p (20.3 to 14.5 ms in a light test scene). */
export function presentationOptions(tier: RenderTier): PresentationOptions {
  const high = tier.name === 'desktop-high';
  return { bloom: tier.bloom, depthOfField: tier.depthOfField, chromaticAberration: high, antialias: high ? 'smaa' : 'fxaa', contactScale: high ? 0.6 : 0.5 };
}

const smooth01 = (value: number) => value * value * (3 - 2 * value);
const positive = (value: number, fallback: number) => Number.isFinite(value) && value > 0 ? value : fallback;

export interface LookInput {
  lowHealth: number; flash: number;
  /** Aim-down-sights blend 0..1. */
  aim: number;
  /** Seconds since the presentation started. */
  time: number;
  /** Scene image height in pixels. */
  height: number;
  chromatic: boolean;
}
export interface LookValues { saturation: number; vignette: number; red: number; flash: number; grain: number; seed: number; aberration: number }

/** Per-frame grade values. Every output is finite and inside its documented range for any input. */
export function lookValues(input: LookInput): LookValues {
  const { lowHealth, flash } = screenCondition(input.lowHealth, input.flash);
  const aim = unitValue(input.aim);
  const time = positive(input.time, 0);
  return {
    saturation: LOOK.grade.saturation + (LOOK.condition.saturation - LOOK.grade.saturation) * lowHealth,
    vignette: Math.min(0.9, LOOK.grade.vignette + LOOK.aim.vignette * aim + LOOK.condition.vignette * lowHealth),
    red: LOOK.condition.red * lowHealth,
    flash,
    grain: LOOK.grade.grain * (1 - flash),
    seed: Math.floor(time * LOOK.grade.grainRate) % 256,
    aberration: input.chromatic ? LOOK.grade.aberration * (positive(input.height, 1080) / 1080) : 0,
  };
}

/** Weapon blur radius in scene pixels. Zero at the hip; it rises as the sight comes up. Focusing on the
 * target leaves the weapon out of focus by the difference in dioptres, so a target within reach blurs
 * the weapon less. */
export function aimBlur(blend: number, focusDistance: number, height: number): number {
  const aim = unitValue(blend);
  if (aim <= 0) return 0;
  const near = LOOK.aim.weaponDistance;
  const focus = Math.max(near, positive(focusDistance, Number.POSITIVE_INFINITY));
  const radius = Math.min(LOOK.aim.maxBlur, LOOK.aim.blur * (positive(height, 1080) / 1080));
  return radius * smooth01(aim) * (1 - near / focus);
}

const FULLSCREEN_VERTEX = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`;

/** Display-space look, the last pass: S-curve, split toning, saturation, lift, vignette, low-health
 * red edges, film grain, a flash white-out and (with CHROMATIC) slight edge colour fringing. */
export const LookShader = {
  name: 'KannonLookShader',
  defines: {} as Record<string, string>,
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uSaturation: { value: LOOK.grade.saturation as number },
    uCurve: { value: LOOK.grade.curve as number },
    uLift: { value: LOOK.grade.lift as number },
    uShadowTint: { value: new THREE.Vector3(...LOOK.grade.shadowTint) },
    uHighlightTint: { value: new THREE.Vector3(...LOOK.grade.highlightTint) },
    uVignette: { value: LOOK.grade.vignette as number },
    uRed: { value: 0 },
    uGrain: { value: LOOK.grade.grain as number },
    uSeed: { value: 0 },
    uAberration: { value: 0 },
    uFlash: { value: 0 },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uSaturation, uCurve, uLift, uVignette, uRed, uGrain, uSeed, uAberration, uFlash;
    uniform vec3 uShadowTint, uHighlightTint;
    varying vec2 vUv;

    const vec3 LUMA = vec3( 0.2126, 0.7152, 0.0722 );

    float grainHash( vec2 p ) {
      vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
      p3 += dot( p3, p3.yzx + 33.33 );
      return fract( ( p3.x + p3.y ) * p3.z );
    }

    void main() {
      vec2 centred = vUv - 0.5;
      float radial = dot( centred, centred ) * 2.2;
      #ifdef CHROMATIC
        // Lateral fringing grows with the square of the distance from the centre: none at the aim point.
        vec2 pixels = centred * uResolution;
        vec2 fringe = centred * ( uAberration * length( pixels ) / ( 0.25 * dot( uResolution, uResolution ) ) );
        vec3 color = vec3( texture2D( tDiffuse, vUv + fringe ).r, texture2D( tDiffuse, vUv ).g, texture2D( tDiffuse, vUv - fringe ).b );
      #else
        vec3 color = texture2D( tDiffuse, vUv ).rgb;
      #endif
      color = clamp( color, 0.0, 1.0 );
      color = mix( color, color * color * ( 3.0 - 2.0 * color ), uCurve );
      float luma = dot( color, LUMA );
      color += uShadowTint * ( 1.0 - smoothstep( 0.0, 0.5, luma ) ) + uHighlightTint * smoothstep( 0.45, 1.0, luma );
      luma = dot( color, LUMA );
      color = mix( vec3( luma ), color, uSaturation );
      color = uLift + color * ( 1.0 - uLift );
      color *= 1.0 - uVignette * smoothstep( 0.25, 1.05, radial );
      float hurt = uRed * smoothstep( 0.1, 0.9, radial );
      color = mix( color, color * vec3( 0.9, 0.3, 0.28 ) + vec3( 0.06, 0.0, 0.0 ), hurt );
      vec2 cell = gl_FragCoord.xy + fract( uSeed * vec2( 0.7548777, 0.5698403 ) ) * 512.0;
      float noise = grainHash( cell ) + grainHash( cell + 19.19 ) - 1.0;
      luma = clamp( dot( color, LUMA ), 0.0, 1.0 );
      color += noise * uGrain * mix( 0.4, 1.0, 4.0 * luma * ( 1.0 - luma ) );
      color = mix( color, vec3( 1.0 ), uFlash );
      gl_FragColor = vec4( clamp( color, 0.0, 1.0 ), 1.0 );
    }`,
};

const AIM_TAP_COUNT = 16;
/** Unit-disk offsets for the weapon blur: a golden-angle spiral covers the disk evenly with few taps. */
export const AIM_TAPS: ReadonlyArray<readonly [number, number]> = Array.from({ length: AIM_TAP_COUNT }, (_, index) => {
  const radius = Math.sqrt((index + 0.5) / AIM_TAP_COUNT), angle = index * 2.399963229728653;
  return [radius * Math.cos(angle), radius * Math.sin(angle)] as const;
});
// Rounded so ANGLE never compiles sub-precision constants.
const tapList = AIM_TAPS.map(([x, y]) => `vec2(${x.toFixed(6)},${y.toFixed(6)})`).join(',');

/** Aim-down-sights depth of field on the first-person weapon, in linear HDR before bloom. The world is
 * never blurred, and nothing near the centre of the screen is, so the sight and the target stay sharp.
 * Weapon pixels are found from the viewmodel depth: the overlay pass cleared it to 1.0 everywhere else.
 * The blurred weapon is composited over the sharp world with its spread coverage, so its silhouette
 * softens on both sides. */
export const AimFocusShader = {
  name: 'KannonAimFocusShader',
  defines: { TAP_COUNT: AIM_TAP_COUNT, WEAPON_DEPTH: '0.99999' },
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uBlur: { value: 0 },
    uSharpRadius: { value: LOOK.aim.sharpRadius as number },
    uFullRadius: { value: LOOK.aim.fullRadius as number },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 uResolution;
    uniform float uBlur, uSharpRadius, uFullRadius;
    varying vec2 vUv;

    const vec2 TAPS[ TAP_COUNT ] = vec2[ TAP_COUNT ]( ${tapList} );

    // Explicit level of detail: these reads sit in loops after a per-pixel early return, where implicit
    // derivatives are undefined. The targets have no mipmaps, so the result is the same.
    float onWeapon( vec2 uv ) { return step( textureLod( tDepth, uv, 0.0 ).x, WEAPON_DEPTH ); }

    void main() {
      vec4 centre = texture2D( tDiffuse, vUv );
      gl_FragColor = centre;
      vec2 fromCentre = ( vUv - 0.5 ) * vec2( uResolution.x / uResolution.y, 1.0 ) * 2.0;
      float radius = uBlur * smoothstep( uSharpRadius, uFullRadius, length( fromCentre ) );
      if ( radius < 0.5 ) return;
      vec2 scale = radius / uResolution;
      float weapon[ TAP_COUNT ];
      float weaponTaps = 0.0;
      for ( int i = 0; i < TAP_COUNT; i ++ ) {
        weapon[ i ] = onWeapon( vUv + TAPS[ i ] * scale );
        weaponTaps += weapon[ i ];
      }
      float centreWeapon = onWeapon( vUv );
      // Only the world in reach: it stays sharp, for one colour and a few depth reads.
      if ( weaponTaps < 0.5 && centreWeapon < 0.5 ) return;
      vec3 weaponSum = vec3( 0.0 );
      vec3 worldSum = vec3( 0.0 );
      for ( int i = 0; i < TAP_COUNT; i ++ ) {
        vec3 tap = textureLod( tDiffuse, vUv + TAPS[ i ] * scale, 0.0 ).rgb;
        weaponSum += tap * weapon[ i ];
        worldSum += tap * ( 1.0 - weapon[ i ] );
      }
      float worldTaps = float( TAP_COUNT ) - weaponTaps;
      vec3 behind = centreWeapon > 0.5 && worldTaps > 0.5 ? worldSum / worldTaps : centre.rgb;
      vec3 blurred = weaponTaps > 0.5 ? weaponSum / weaponTaps : centre.rgb;
      gl_FragColor = vec4( mix( behind, blurred, weaponTaps / float( TAP_COUNT ) ), centre.a );
    }`,
};

/** Draws the first-person arms and weapon over the finished world image with cleared depth, so the
 * weapon never clips into walls and still receives the weapon blur, bloom, anti-aliasing and grade. */
class OverlayPass extends Pass {
  scene: THREE.Scene | null = null;
  camera: THREE.Camera | null = null;

  constructor() {
    super();
    this.needsSwap = false;
    this.enabled = false;
  }

  override render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    if (!this.scene || !this.camera) return;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = autoClear;
  }
}

/** Reads the viewmodel depth left in the image it blurs; writes a fresh image (never the one it reads). */
class AimFocusPass extends ShaderPass {
  blur = 0;

  constructor() {
    super(AimFocusShader);
    this.enabled = false;
    this.material.depthTest = false; this.material.depthWrite = false;
  }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, dt: number, mask: boolean) {
    this.uniforms.tDepth.value = readBuffer.depthTexture;
    // Without depth there is no way to tell the weapon from the world: copy the image through.
    this.uniforms.uBlur.value = readBuffer.depthTexture ? this.blur : 0;
    super.render(renderer, writeBuffer, readBuffer, dt, mask);
  }
}

/** Desktop presentation: contact shading, the first-person viewmodel, aim depth of field on the weapon,
 * bloom tuned for flashes and explosions, tone mapping, SMAA or FXAA edges and a gritty filmic grade
 * with low-health and flash conditions. Phones render directly and never download this module. */
export class ArenaPresentation {
  private readonly composer: EffectComposer;
  private readonly ambient: ContactPass;
  private readonly overlay = new OverlayPass();
  private readonly focus = new AimFocusPass();
  private readonly bloom: UnrealBloomPass | null = null;
  private readonly output = new OutputPass();
  private readonly antialias: SMAAPass | FXAAPass;
  private readonly look = new ShaderPass(LookShader);
  private readonly depthOfField: boolean;
  private readonly chromatic: boolean;
  private readonly contactScale: number;
  private aim = 0;
  private focusDistance = Number.POSITIVE_INFINITY;
  private lowHealth = 0;
  private flash = 0;
  private time = 0;
  enabled = true;
  /** The viewmodel set with `setOverlay` is drawn inside `render()`. */
  readonly drawsOverlay: boolean = true;

  constructor(private renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, options: PresentationOptions = { bloom: true }) {
    this.depthOfField = options.depthOfField !== false;
    this.chromatic = options.chromaticAberration === true;
    this.contactScale = Number.isFinite(options.contactScale) ? Math.min(1, Math.max(0.25, options.contactScale!)) : 0.6;
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
    });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.ambient = new ContactPass(scene, camera);
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
    // The viewmodel goes over the contact-shaded world (it must not pick up the world's ambient
    // occlusion) and before bloom, so its muzzle flash glows like every other flash.
    this.composer.addPass(this.overlay);
    this.composer.addPass(this.focus);
    if (options.bloom) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), LOOK.bloom.strength, LOOK.bloom.radius, LOOK.bloom.threshold);
      // A soft knee: brightness ramps into the glow instead of popping at the threshold.
      (this.bloom.highPassUniforms as Record<string, THREE.IUniform<number>>).smoothWidth.value = LOOK.bloom.knee;
      this.composer.addPass(this.bloom);
    }
    this.composer.addPass(this.output);
    // Edges are found on the tone-mapped image before grain and fringing are added.
    this.antialias = options.antialias === 'fxaa' ? new FXAAPass() : new SMAAPass();
    this.composer.addPass(this.antialias);
    if (this.chromatic) this.look.material.defines.CHROMATIC = '';
    this.look.material.depthTest = false; this.look.material.depthWrite = false;
    this.composer.addPass(this.look);
  }

  /** First-person viewmodel drawn over the world with cleared depth, before bloom and grading.
   * Pass null to stop drawing it. Cheap to call every frame. */
  setOverlay(scene: THREE.Scene | null, camera: THREE.Camera | null) {
    this.overlay.scene = scene; this.overlay.camera = camera;
    this.overlay.enabled = !!scene && !!camera;
  }

  /** Aim-down-sights blend 0..1 and the distance to the aimed point (metres), for depth of field. */
  setAim(blend: number, focusDistance: number) {
    this.aim = unitValue(blend);
    this.focusDistance = focusDistance;
  }

  /** Screen condition 0..1: low health (drain colour, dark red edges) and a flash (stun or explosion)
   * that whites out the screen and boosts the glow. */
  setCondition(lowHealth: number, flash: number) {
    const condition = screenCondition(lowHealth, flash);
    this.lowHealth = condition.lowHealth; this.flash = condition.flash;
  }

  resize(width: number, height: number) {
    const ratio = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(width, height);
    this.ambient.setSize(Math.max(1, Math.floor(width * ratio * this.contactScale)), Math.max(1, Math.floor(height * ratio * this.contactScale)));
    this.bloom?.setSize(Math.max(1, Math.floor(width * ratio * 0.5)), Math.max(1, Math.floor(height * ratio * 0.5)));
    const pixels = this.pixelSize();
    (this.focus.uniforms.uResolution.value as THREE.Vector2).set(pixels.width, pixels.height);
    (this.look.uniforms.uResolution.value as THREE.Vector2).set(pixels.width, pixels.height);
  }

  render(dt: number) {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    this.time = (this.time + step) % 3600;
    const { height } = this.pixelSize();
    this.focus.blur = this.depthOfField && this.overlay.enabled ? aimBlur(this.aim, this.focusDistance, height) : 0;
    this.focus.enabled = this.focus.blur >= 0.5;
    const values = lookValues({ lowHealth: this.lowHealth, flash: this.flash, aim: this.aim, time: this.time, height, chromatic: this.chromatic });
    const uniforms = this.look.uniforms;
    uniforms.uSaturation.value = values.saturation;
    uniforms.uVignette.value = values.vignette;
    uniforms.uRed.value = values.red;
    uniforms.uFlash.value = values.flash;
    uniforms.uGrain.value = values.grain;
    uniforms.uSeed.value = values.seed;
    uniforms.uAberration.value = values.aberration;
    if (this.bloom) this.bloom.strength = LOOK.bloom.strength + LOOK.bloom.flashBoost * this.flash;
    this.composer.render(step);
  }

  dispose() {
    this.overlay.scene = null; this.overlay.camera = null;
    this.ambient.dispose();
    // Three r185's UnrealBloomPass.dispose omits its owned high-pass material.
    if (this.bloom) { this.bloom.dispose(); (this.bloom as unknown as { materialHighPassFilter: THREE.Material }).materialHighPassFilter.dispose(); }
    this.focus.dispose(); this.output.dispose(); this.antialias.dispose(); this.look.dispose(); this.composer.dispose();
  }

  /** Size of the scene image in device pixels. */
  private pixelSize() {
    const target = this.composer.renderTarget1;
    return { width: Math.max(1, Math.floor(target.width)), height: Math.max(1, Math.floor(target.height)) };
  }
}
