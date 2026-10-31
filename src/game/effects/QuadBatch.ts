import * as THREE from 'three';

/** Sprite shapes drawn procedurally by the batch shader (no textures). */
export const EFFECT_KIND = {
  /** Five-petal muzzle flash. */
  flash: 0,
  /** Soft line: sparks, side flashes. */
  streak: 1,
  /** Grainy dust puff. */
  puff: 2,
  /** Diamond chip: concrete, dirt, debris. */
  chip: 3,
  /** Thin ring: protected-target and respawn shimmer. */
  ring: 4,
  /** Pointed sliver: glass shards, wood splinters, sand. */
  shard: 5,
  /** Ragged fireball with a hot core. */
  fire: 6,
  /** Round soft light: explosion flash, glints, beacons. */
  glow: 7,
  /** Soft billowing smoke. */
  smoke: 8,
  /** Bullet tracer (same shape as a streak, its own kind so callers can tell them apart). */
  tracer: 9,
} as const;

const vertexShader = /* glsl */`
  attribute vec3 color;
  attribute float effectOpacity;
  attribute float effectKind;
  attribute float effectSeed;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vOpacity;
  varying float vKind;
  varying float vSeed;
  void main() {
    vUv = uv; vColor = color; vOpacity = effectOpacity; vKind = effectKind; vSeed = effectSeed;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const fragmentShader = /* glsl */`
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vOpacity;
  varying float vKind;
  varying float vSeed;
  float wobble(vec2 p, float seed) {
    return 0.5 + 0.25 * sin(p.x * 9.0 + seed * 37.0 + sin(p.y * 7.0 + seed * 11.0))
      + 0.25 * cos(p.y * 11.0 - seed * 23.0 + cos(p.x * 5.0 + seed * 3.0));
  }
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float alpha;
    vec3 color = vColor;
    if (vKind < 0.5) {
      float petals = 0.68 + 0.22 * cos(atan(p.y, p.x) * 5.0 + vSeed * 6.2831);
      alpha = pow(max(0.0, 1.0 - r / petals), 1.25);
    } else if (vKind < 1.5 || vKind > 8.5) {
      alpha = pow(max(0.0, 1.0 - abs(p.x)), 1.7) * (1.0 - smoothstep(0.58, 1.0, abs(p.y)));
    } else if (vKind < 2.5) {
      alpha = pow(max(0.0, 1.0 - r), 1.7) * (0.6 + 0.4 * wobble(p, vSeed));
    } else if (vKind < 3.5) {
      alpha = (1.0 - smoothstep(0.57, 0.69, abs(p.x) + abs(p.y))) * (0.74 + p.y * 0.2);
    } else if (vKind < 4.5) {
      alpha = (1.0 - smoothstep(0.04, 0.14, abs(r - 0.72))) * (0.75 + 0.25 * cos(atan(p.y, p.x) * 8.0 + vSeed * 6.2831));
    } else if (vKind < 5.5) {
      float edge = abs(p.x) - (1.0 - p.y) * 0.25;
      alpha = (1.0 - smoothstep(-0.05, 0.03, edge)) * smoothstep(-1.0, -0.88, p.y);
      color *= 0.8 + 0.4 * smoothstep(-0.2, 0.0, edge);
    } else if (vKind < 6.5) {
      float n = wobble(p * 0.8, vSeed);
      alpha = pow(max(0.0, 1.0 - r * (0.85 + 0.3 * n)), 1.3);
      color *= 0.75 + 0.7 * max(0.0, 1.0 - r);
    } else if (vKind < 7.5) {
      alpha = exp(-r * r * 4.0) * (1.0 - smoothstep(0.85, 1.0, r));
    } else {
      float n = wobble(p * 0.7, vSeed);
      alpha = pow(max(0.0, 1.0 - r), 1.3) * (0.55 + 0.45 * n);
      color *= 0.85 + 0.25 * n;
    }
    alpha *= vOpacity;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(color, alpha);
    #include <colorspace_fragment>
  }`;

/** One persistent, camera-built quad batch: a fixed GPU buffer refilled every frame, one draw call,
 * and only the used part of each buffer is uploaded. */
export class QuadBatch {
  readonly geometry = new THREE.BufferGeometry();
  readonly material: THREE.ShaderMaterial;
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly capacity: number;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly opacity: Float32Array;
  private readonly kinds: Float32Array;
  private readonly seeds: Float32Array;
  private readonly dynamic: Array<[THREE.BufferAttribute, number]> = [];
  private count = 0;

  constructor(capacity: number, additive: boolean, name: string, renderOrder: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    const quads = this.capacity, vertices = quads * 4;
    this.positions = new Float32Array(vertices * 3);
    this.colors = new Float32Array(vertices * 3);
    this.opacity = new Float32Array(vertices);
    this.kinds = new Float32Array(vertices);
    this.seeds = new Float32Array(vertices);
    const uv = new Float32Array(vertices * 2);
    const index = vertices > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
    for (let quad = 0; quad < quads; quad++) {
      uv.set([0, 0, 1, 0, 1, 1, 0, 1], quad * 8);
      index.set([quad * 4, quad * 4 + 1, quad * 4 + 2, quad * 4, quad * 4 + 2, quad * 4 + 3], quad * 6);
    }
    for (const [attributeName, array, size] of [
      ['position', this.positions, 3], ['color', this.colors, 3],
      ['effectOpacity', this.opacity, 1], ['effectKind', this.kinds, 1], ['effectSeed', this.seeds, 1],
    ] as const) {
      const attribute = new THREE.BufferAttribute(array, size).setUsage(THREE.DynamicDrawUsage);
      this.geometry.setAttribute(attributeName, attribute);
      this.dynamic.push([attribute, size]);
    }
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.geometry.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      name, vertexShader, fragmentShader,
      transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, toneMapped: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = renderOrder;
  }

  get size() { return this.count; }

  reset() { this.count = 0; }

  /** Adds a quad spanning centre ± across ± along. Returns false when full or not finite. */
  quad(center: THREE.Vector3, across: THREE.Vector3, along: THREE.Vector3, r: number, g: number, b: number, opacity: number, kind: number, seed: number): boolean {
    if (this.count >= this.capacity) return false;
    const vertex = this.count * 4;
    let sum = r + g + b + opacity;
    for (let corner = 0; corner < 4; corner++) {
      const x = corner === 0 || corner === 3 ? -1 : 1, y = corner < 2 ? -1 : 1, offset = (vertex + corner) * 3;
      const px = center.x + across.x * x + along.x * y, py = center.y + across.y * x + along.y * y, pz = center.z + across.z * x + along.z * y;
      this.positions[offset] = px; this.positions[offset + 1] = py; this.positions[offset + 2] = pz;
      this.colors[offset] = r; this.colors[offset + 1] = g; this.colors[offset + 2] = b;
      this.opacity[vertex + corner] = opacity; this.kinds[vertex + corner] = kind; this.seeds[vertex + corner] = seed;
      sum += px + py + pz;
    }
    // A broken camera or particle must never leave NaN or infinite vertices in the buffer.
    if (!Number.isFinite(sum)) {
      this.positions.fill(0, vertex * 3, vertex * 3 + 12); this.colors.fill(0, vertex * 3, vertex * 3 + 12);
      this.opacity.fill(0, vertex, vertex + 4);
      return false;
    }
    this.count++;
    return true;
  }

  finish() {
    this.geometry.setDrawRange(0, this.count * 6);
    this.mesh.visible = this.count > 0;
    if (!this.count) return;
    for (const [attribute, size] of this.dynamic) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, this.count * 4 * size);
      attribute.needsUpdate = true;
    }
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); this.mesh.removeFromParent(); }
}
