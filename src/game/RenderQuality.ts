import * as THREE from 'three';

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

/** Display-space numbers for the cheap pass used when the desktop presentation is not running. */
export const DIRECT_GRADE = {
  /** Corner darkening at rest. */
  vignette: 0.3,
  /** Extra corner darkening while aiming down the sights. */
  aimVignette: 0.06,
  /** Extra corner darkening when badly hurt. */
  lowHealthVignette: 0.38,
  /** Added everywhere: lifts the blacks a touch and cools them (a split tone in one add). */
  lift: [0.006, 0.01, 0.02] as const,
  /** Added at the screen edges when badly hurt. */
  red: [0.2, 0.012, 0.01] as const,
} as const;

export interface DirectGradeValues {
  vignette: number;
  lift: [number, number, number];
  red: [number, number, number];
  flash: number;
}

export function directGradeValues(lowHealth: number, flash: number, aim: number): DirectGradeValues {
  const condition = screenCondition(lowHealth, flash);
  const keep = 1 - condition.flash;
  return {
    vignette: Math.min(0.9, DIRECT_GRADE.vignette + DIRECT_GRADE.aimVignette * unitValue(aim) + DIRECT_GRADE.lowHealthVignette * condition.lowHealth),
    lift: [DIRECT_GRADE.lift[0] * keep, DIRECT_GRADE.lift[1] * keep, DIRECT_GRADE.lift[2] * keep],
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
 * rendered straight to the canvas. Same `setAim` / `setCondition` meaning as the desktop look. */
export class DirectGrade {
  readonly material: THREE.ShaderMaterial;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly mesh: THREE.Mesh;
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private aim = 0;
  private lowHealth = 0;
  private flash = 0;
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
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.mesh, this.camera);
    renderer.autoClear = autoClear;
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }

  private apply() {
    const values = directGradeValues(this.lowHealth, this.flash, this.aim);
    const uniforms = this.material.uniforms;
    uniforms.uVignette.value = values.vignette;
    (uniforms.uLift.value as THREE.Vector3).set(...values.lift);
    (uniforms.uRed.value as THREE.Vector3).set(...values.red);
    uniforms.uFlash.value = values.flash;
  }
}
