import * as THREE from 'three';
import type { RenderTier } from './RenderTiers';

/** Hysteresis keeps a brief hitch from changing resolution. The native HUD is
 * outside the canvas and stays sharp when the GPU needs fewer scene pixels. */
export class RenderQuality {
  scale = 1;
  private slow = 0;
  private fast = 0;

  reset() { this.scale = 1; this.resetTiming(); }
  resetTiming() { this.slow = 0; this.fast = 0; }

  observe(fps: number, seconds: number, quality: 'auto' | 'high' | 'low'): boolean {
    if (quality === 'low') return false;
    const threshold = quality === 'high' ? 32 : 42;
    this.slow = fps < threshold ? this.slow + seconds : 0;
    this.fast = fps >= 58 ? this.fast + seconds : 0;
    const previous = this.scale;
    if (this.slow >= 2.1) {
      this.scale = Math.max(quality === 'high' ? 0.65 : 0.55, this.scale - 0.1);
      this.resetTiming();
    } else if (this.fast >= 15) {
      this.scale = Math.min(1, this.scale + 0.05);
      this.resetTiming();
    }
    return Math.abs(previous - this.scale) > 0.001;
  }
}

export function scenePixelRatio(width: number, height: number, deviceRatio: number, touch: boolean, quality: 'auto' | 'high' | 'low', scale = 1): number {
  const budget = quality === 'high' ? 2560 * 1440 : quality === 'low' ? 1024 * 768 : touch ? 1280 * 720 : 1600 * 900;
  const ratioLimit = quality === 'high' ? 1.75 : quality === 'low' ? 1 : touch ? 1.25 : 1.5;
  return Math.min(Math.max(0.1, deviceRatio), ratioLimit, Math.sqrt(budget / Math.max(1, width * height))) * scale;
}

/** 0..1, with anything that is not a finite number treated as 0 (no effect). */
export const unitValue = (value: number) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/** Screen condition shared by both looks: `lowHealth` 0 (fine) .. 1 (nearly out), `flash` 0 .. 1 white-out. */
export function screenCondition(lowHealth: number, flash: number) {
  return { lowHealth: unitValue(lowHealth), flash: unitValue(flash) };
}

const LUMA = [0.2126, 0.7152, 0.0722] as const;

/** Remove the brightness from a colour offset so it changes hue only. */
export function neutralTint(r: number, g: number, b: number): [number, number, number] {
  const luma = r * LUMA[0] + g * LUMA[1] + b * LUMA[2];
  return [r - luma, g - luma, b - luma];
}

/** The colour of the film grade, shared by the desktop look pass and the direct path's tone mapping so the
 * two looks cannot drift apart. Display-space values (after tone mapping). */
export const FILM_GRADE = {
  /** Slightly drained colour. */
  saturation: 0.9,
  /** Strength of the S-curve around mid grey (0 = none). */
  curve: 0.3,
  /** Matte film lift of the blacks. */
  lift: 0.012,
  /** Split toning: cool, slightly teal shadows and warm highlights, with no brightness change. */
  shadowTint: neutralTint(-0.016, 0.004, 0.026),
  highlightTint: neutralTint(0.032, 0.011, -0.026),
} as const;

export interface PresentationOptions {
  bloom: boolean;
  /** Aim-down-sights blur of the first-person weapon. On unless false. */
  depthOfField?: boolean;
  /** Slight colour fringing at the screen edges. Off unless true (High). */
  chromaticAberration?: boolean;
  /** Edge smoothing: 'fxaa' (default, one pass) or 'smaa' (sharper, about three times the cost; High). */
  antialias?: 'smaa' | 'fxaa';
  /** Contact shading resolution as a share of the scene image, 0.25..1 (default: Automatic's). */
  contactScale?: number;
}

/** Contact shading resolution as a share of the scene image. The town's lighting is baked, so contact shading
 * adds little: at 0.35 it differs from 0.5 by 0.2 colour levels on average and saves about 2 ms a frame on this
 * PC's integrated AMD GPU at 1600x900, its most expensive pass. */
export const CONTACT_SCALE = { high: 0.6, automatic: 0.35 } as const;

/** What the desktop presentation turns on for a render tier. High is the full look; Automatic trades SMAA for
 * FXAA and computes contact shading on fewer pixels. In the real town on the integrated AMD GPU, with a 1080p
 * window (1600x900 scene pixels), that took the GPU time at the hip from 20-21.5 ms (previous stack) to about
 * 13-16 ms. It lives here, not in Presentation.ts, so GameView can import it without pulling the
 * post-processing code into the phone download. */
export function presentationOptions(tier: RenderTier): PresentationOptions {
  const high = tier.name === 'desktop-high';
  return { bloom: tier.bloom, depthOfField: tier.depthOfField, chromaticAberration: high, antialias: high ? 'smaa' : 'fxaa', contactScale: high ? CONTACT_SCALE.high : CONTACT_SCALE.automatic };
}

const glsl = (value: number) => value.toFixed(6);
const glslVec3 = (value: readonly number[]) => `vec3( ${value.map(glsl).join(', ')} )`;
const GRADE_MARKER = 'Kannon film grade';
/** three.js's pass-through custom tone mapping hook in `ShaderChunk.tonemapping_pars_fragment`. */
const TONE_MAPPING_HOOK = 'vec3 CustomToneMapping( vec3 color ) { return color; }';

/** The film grade's colour folded into tone mapping for the direct path (phones, and desktop whenever the
 * post-processing stack is off): ACES Filmic, then the desktop look's S-curve, split toning and saturation.
 * Every material already runs tone mapping, so this costs a few instructions per pixel and no extra pass that
 * reads the frame back. Square-root space stands in for display space: it is cheap and inverts exactly, so an
 * image without grading is unchanged. Constants only: no uniforms or textures. */
export const GRADED_TONE_MAPPING = /* glsl */`// ${GRADE_MARKER}: ACES Filmic, then the desktop look's colour steps.
vec3 CustomToneMapping( vec3 color ) {
	vec3 display = sqrt( ACESFilmicToneMapping( color ) );
	display = mix( display, display * display * ( 3.0 - 2.0 * display ), ${glsl(FILM_GRADE.curve)} );
	float luma = dot( display, ${glslVec3(LUMA)} );
	display += ${glslVec3(FILM_GRADE.shadowTint)} * ( 1.0 - smoothstep( 0.0, 0.5, luma ) ) + ${glslVec3(FILM_GRADE.highlightTint)} * smoothstep( 0.45, 1.0, luma );
	luma = dot( display, ${glslVec3(LUMA)} );
	display = clamp( mix( vec3( luma ), display, ${glsl(FILM_GRADE.saturation)} ), 0.0, 1.0 );
	return display * display;
}`;

interface ToneMapped { toneMapping: THREE.ToneMapping }

/** True when the renderer tone-maps with the graded direct-path curve from `applyGradedToneMapping`. */
export function hasGradedToneMapping(renderer: ToneMapped): boolean {
  return renderer.toneMapping === THREE.CustomToneMapping && THREE.ShaderChunk.tonemapping_pars_fragment.includes(GRADE_MARKER);
}

/** Direct path: tone mapping becomes ACES Filmic plus the film grade's colour (see `GRADED_TONE_MAPPING`). Call it
 * once at startup in place of setting ACES Filmic, before the first frame: changing tone mapping later rebuilds
 * every material. The desktop presentation always tone-maps with plain ACES Filmic and grades in its own pass, so
 * it is unaffected. Returns false, and leaves the renderer alone, if this three.js build has no custom hook. */
export function applyGradedToneMapping(renderer: ToneMapped): boolean {
  const chunk = THREE.ShaderChunk.tonemapping_pars_fragment;
  if (!chunk.includes(GRADE_MARKER)) {
    if (!chunk.includes(TONE_MAPPING_HOOK)) return false;
    THREE.ShaderChunk.tonemapping_pars_fragment = chunk.replace(TONE_MAPPING_HOOK, GRADED_TONE_MAPPING);
  }
  renderer.toneMapping = THREE.CustomToneMapping;
  return true;
}

/** Display-space numbers for the cheap pass used when the desktop presentation is not running. */
export const DIRECT_GRADE = {
  /** Corner darkening at rest. */
  vignette: 0.3,
  /** Extra corner darkening while aiming down the sights. */
  aimVignette: 0.06,
  /** Extra corner darkening when badly hurt. */
  lowHealthVignette: 0.38,
  /** Added everywhere with plain tone mapping: lifts the blacks a touch and cools them (a split tone in one add). */
  lift: [0.006, 0.01, 0.02] as const,
  /** With the graded tone mapping the split toning is already done: the desktop look's neutral matte lift. */
  gradedLift: [FILM_GRADE.lift, FILM_GRADE.lift, FILM_GRADE.lift] as const,
  /** Added at the screen edges when badly hurt. */
  red: [0.2, 0.012, 0.01] as const,
} as const;

export interface DirectGradeValues {
  vignette: number;
  lift: [number, number, number];
  red: [number, number, number];
  flash: number;
}

/** `graded`: the renderer uses `applyGradedToneMapping`, which already cools the shadows. */
export function directGradeValues(lowHealth: number, flash: number, aim: number, graded = false): DirectGradeValues {
  const condition = screenCondition(lowHealth, flash);
  const keep = 1 - condition.flash;
  const lift = graded ? DIRECT_GRADE.gradedLift : DIRECT_GRADE.lift;
  return {
    vignette: Math.min(0.9, DIRECT_GRADE.vignette + DIRECT_GRADE.aimVignette * unitValue(aim) + DIRECT_GRADE.lowHealthVignette * condition.lowHealth),
    lift: [lift[0] * keep, lift[1] * keep, lift[2] * keep],
    red: [DIRECT_GRADE.red[0] * condition.lowHealth * keep, DIRECT_GRADE.red[1] * condition.lowHealth * keep, DIRECT_GRADE.red[2] * condition.lowHealth * keep],
    flash: condition.flash,
  };
}

/** One full-screen triangle blended over the finished frame: `result = add + frame × keep`.
 * It reads no textures, so it costs phones almost nothing. */
export const DirectGradeShader = {
  name: 'KannonDirectGradeShader',
  uniforms: {
    uVignette: { value: DIRECT_GRADE.vignette as number },
    uLift: { value: new THREE.Vector3(...DIRECT_GRADE.lift) },
    uRed: { value: new THREE.Vector3(0, 0, 0) },
    uFlash: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`,
  fragmentShader: /* glsl */`
    uniform float uVignette;
    uniform vec3 uLift;
    uniform vec3 uRed;
    uniform float uFlash;
    varying vec2 vUv;
    void main() {
      vec2 centred = vUv - 0.5;
      float edge = smoothstep( 0.25, 1.05, dot( centred, centred ) * 2.2 );
      float hurt = smoothstep( 0.1, 0.9, dot( centred, centred ) * 2.2 );
      float keep = ( 1.0 - uVignette * edge ) * ( 1.0 - uFlash );
      gl_FragColor = vec4( uLift + uRed * hurt + vec3( uFlash ), keep );
    }`,
};

/** The phone tier's single cheap grade-and-vignette pass, also used on desktop whenever the
 * post-processing stack is off. Draw it after the world and the first-person view have been
 * rendered straight to the canvas. Same `setAim` / `setCondition` meaning as the desktop look.
 * The grade's colour (saturation, S-curve, split toning) cannot be done by blending; it comes from
 * `applyGradedToneMapping`, called once at startup. This pass notices and switches to the neutral lift. */
export class DirectGrade {
  readonly material: THREE.ShaderMaterial;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly mesh: THREE.Mesh;
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private aim = 0;
  private lowHealth = 0;
  private flash = 0;
  private graded = false;
  enabled = true;

  constructor() {
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.material = new THREE.ShaderMaterial({
      name: DirectGradeShader.name,
      uniforms: THREE.UniformsUtils.clone(DirectGradeShader.uniforms),
      vertexShader: DirectGradeShader.vertexShader,
      fragmentShader: DirectGradeShader.fragmentShader,
      // result = shader colour + frame × shader alpha
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'kannon-direct-grade';
    this.apply();
  }

  /** Aim-down-sights blend 0..1 (the focus distance is only used by the desktop look). */
  setAim(blend: number, _focusDistance?: number) { this.aim = unitValue(blend); this.apply(); }

  /** Same meaning as `ArenaPresentation.setCondition`. */
  setCondition(lowHealth: number, flash: number) {
    const condition = screenCondition(lowHealth, flash);
    this.lowHealth = condition.lowHealth; this.flash = condition.flash;
    this.apply();
  }

  /** Blend over whatever was just drawn to the current target (normally the canvas). */
  render(renderer: THREE.WebGLRenderer) {
    if (!this.enabled) return;
    const graded = hasGradedToneMapping(renderer);
    if (graded !== this.graded) { this.graded = graded; this.apply(); }
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.mesh, this.camera);
    renderer.autoClear = autoClear;
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }

  private apply() {
    const values = directGradeValues(this.lowHealth, this.flash, this.aim, this.graded);
    const uniforms = this.material.uniforms;
    uniforms.uVignette.value = values.vignette;
    (uniforms.uLift.value as THREE.Vector3).set(...values.lift);
    (uniforms.uRed.value as THREE.Vector3).set(...values.red);
    uniforms.uFlash.value = values.flash;
  }
}
