import * as THREE from 'three';
import { buildCasingGeometry } from './standins';
import type { ShellStyle } from './handling';

/** Viewmodel-space effects. The viewmodel scene is camera space, so anything that should hang in
 * the world (smoke, flying casings, a dropped magazine) is counter-rotated by the view's turn each
 * frame and drifts back by the player's own motion when that is known. */

const flashVertex = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/** Star flash: three crossed flame planes along the barrel plus a petal disc facing the eye.
 * Additive blending does not depend on draw order, so each material draws both faces in one pass. */
export class MuzzleFlash {
  readonly group = new THREE.Group();
  private readonly flame: THREE.ShaderMaterial;
  private readonly petals: THREE.ShaderMaterial;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private life = 0;
  private duration = 0.05;
  private seed = 0;

  constructor() {
    this.group.name = 'viewmodel-muzzle-flash';
    const uniforms = () => ({ uOpacity: { value: 0 }, uSeed: { value: 0 } });
    this.flame = new THREE.ShaderMaterial({
      uniforms: uniforms(), vertexShader: flashVertex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide, forceSinglePass: true, toneMapped: false,
      fragmentShader: /* glsl */`
        uniform float uOpacity; uniform float uSeed; varying vec2 vUv;
        void main() {
          float along = vUv.y, across = abs(vUv.x * 2.0 - 1.0);
          float width = (0.18 + 0.82 * pow(sin(3.14159 * pow(along, 0.55)), 1.2)) * (1.0 - along * 0.55);
          float flicker = 0.75 + 0.25 * sin(along * 23.0 + uSeed * 6.283) * sin(across * 9.0 + uSeed * 3.1);
          float alpha = smoothstep(width, width * 0.25, across) * (1.0 - smoothstep(0.7, 1.0, along)) * flicker * uOpacity;
          vec3 color = mix(vec3(1.0, 0.95, 0.78), vec3(1.0, 0.55, 0.18), smoothstep(0.0, 0.9, across + along * 0.6));
          if (alpha < 0.003) discard;
          gl_FragColor = vec4(color * alpha, alpha);
        }`,
    });
    this.petals = new THREE.ShaderMaterial({
      uniforms: uniforms(), vertexShader: flashVertex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide, forceSinglePass: true, toneMapped: false,
      fragmentShader: /* glsl */`
        uniform float uOpacity; uniform float uSeed; varying vec2 vUv;
        void main() {
          vec2 p = vUv * 2.0 - 1.0; float r = length(p); float a = atan(p.y, p.x) + uSeed * 6.283;
          float petals = 0.55 + 0.35 * pow(abs(cos(a * 2.5)), 3.0) + 0.1 * cos(a * 7.0);
          float alpha = pow(max(0.0, 1.0 - r / petals), 1.6) * uOpacity;
          vec3 color = mix(vec3(1.0, 0.97, 0.85), vec3(1.0, 0.6, 0.22), smoothstep(0.1, 0.8, r));
          if (alpha < 0.003) discard;
          gl_FragColor = vec4(color * alpha, alpha);
        }`,
    });
    for (let i = 0; i < 3; i++) {
      const geometry = new THREE.PlaneGeometry(0.15, 0.26);
      geometry.translate(0, 0.13, 0); geometry.rotateX(-Math.PI / 2); geometry.rotateZ(i * Math.PI / 3);
      this.geometries.push(geometry);
      const mesh = new THREE.Mesh(geometry, this.flame); mesh.name = 'flash-flame'; mesh.frustumCulled = false; mesh.renderOrder = 10;
      this.group.add(mesh);
    }
    const disc = new THREE.PlaneGeometry(0.2, 0.2);
    this.geometries.push(disc);
    const front = new THREE.Mesh(disc, this.petals); front.name = 'flash-petals'; front.frustumCulled = false; front.renderOrder = 10;
    front.position.z = -0.012;
    this.group.add(front);
    this.group.visible = false;
  }

  /** Strength scales the size; `random` gives a fresh shape each shot. */
  fire(strength: number, random: () => number): void {
    this.duration = 0.045 + 0.02 * Math.min(1.5, strength);
    this.life = this.duration;
    this.seed = random();
    const scale = strength * (0.85 + 0.3 * random());
    this.group.scale.set(scale, scale, scale * (0.9 + 0.35 * random()));
    this.group.rotation.z = random() * Math.PI * 2;
    this.group.visible = true;
  }
  get active(): boolean { return this.life > 0; }
  /** 0..1 brightness this frame (for the flash light): full for the first part of its life, then a quick fade. */
  get intensity(): number { const left = this.life / this.duration; return this.life > 0 ? left > 0.55 ? 1 : Math.pow(left / 0.55, 1.5) : 0; }
  update(dt: number): void {
    if (this.life <= 0) { this.group.visible = false; return; }
    this.life = Math.max(0, this.life - dt);
    const opacity = this.intensity;
    this.flame.uniforms.uOpacity!.value = opacity; this.petals.uniforms.uOpacity!.value = opacity;
    this.flame.uniforms.uSeed!.value = this.seed; this.petals.uniforms.uSeed!.value = this.seed;
    this.group.visible = opacity > 0.01;
  }
  clear(): void { this.life = 0; this.group.visible = false; }
  dispose(): void { for (const geometry of this.geometries) geometry.dispose(); this.flame.dispose(); this.petals.dispose(); this.group.removeFromParent(); }
}

/** `opacity` is the puff's base strength; `alpha` is what the last update drew (fade and aim clearance applied). */
interface Puff { position: THREE.Vector3; velocity: THREE.Vector3; life: number; duration: number; size: number; grow: number; opacity: number; alpha: number; spin: number; angle: number }
const QUAD_CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1] as const;

/** Soft grey puffs from the muzzle. While aiming they are pushed out of, and faded inside, a small
 * cone around the view axis so they never hide the target. */
export class MuzzleSmoke {
  readonly mesh: THREE.Mesh;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly puffs: Puff[];
  private readonly positions: Float32Array;
  private readonly alpha: Float32Array;
  private cursor = 0;
  /** Tangent of the half-angle kept clear at full aim (about 4.6 degrees). */
  static readonly CLEAR = 0.08;

  constructor(readonly capacity: number) {
    this.puffs = Array.from({ length: capacity }, () => ({ position: new THREE.Vector3(), velocity: new THREE.Vector3(), life: 0, duration: 1, size: 0, grow: 0, opacity: 0, alpha: 0, spin: 0, angle: 0 }));
    this.positions = new Float32Array(capacity * 12);
    this.alpha = new Float32Array(capacity * 4);
    const uv = new Float32Array(capacity * 8), index = new Uint16Array(capacity * 6);
    for (let i = 0; i < capacity; i++) {
      uv.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
      index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('smokeAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.geometry.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: true,
      vertexShader: /* glsl */`
        attribute float smokeAlpha; varying vec2 vUv; varying float vAlpha;
        void main() { vUv = uv; vAlpha = smokeAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        varying vec2 vUv; varying float vAlpha;
        void main() {
          vec2 p = vUv * 2.0 - 1.0; float r = length(p);
          float billow = 0.8 + 0.2 * sin(p.x * 7.0 + sin(p.y * 5.0) * 2.0) * cos(p.y * 6.0 - p.x * 2.0);
          float alpha = pow(max(0.0, 1.0 - r), 1.8) * billow * vAlpha;
          if (alpha < 0.003) discard;
          gl_FragColor = vec4(vec3(0.62, 0.61, 0.58), alpha);
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'viewmodel-smoke'; this.mesh.frustumCulled = false; this.mesh.renderOrder = 9; this.mesh.visible = false;
  }

  emit(position: THREE.Vector3, forward: THREE.Vector3, up: THREE.Vector3, count: number, strength: number, random: () => number): void {
    for (let i = 0; i < count; i++) {
      const puff = this.puffs[this.cursor++ % this.capacity]!;
      puff.position.copy(position).addScaledVector(forward, 0.02 + random() * 0.05);
      puff.velocity.copy(forward).multiplyScalar(0.18 + random() * 0.3).addScaledVector(up, 0.08 + random() * 0.08);
      puff.velocity.x += (random() - 0.5) * 0.08; puff.velocity.y += (random() - 0.5) * 0.05;
      puff.duration = puff.life = 0.7 + random() * 0.5;
      puff.size = 0.03 + random() * 0.02; puff.grow = 0.12 + random() * 0.08;
      puff.opacity = (0.1 + random() * 0.06) * strength; puff.alpha = 0;
      puff.spin = (random() - 0.5) * 1.5; puff.angle = random() * Math.PI * 2;
    }
  }

  /** Effective opacity of a puff after the aim clearance (exposed for tests). */
  static clearance(position: THREE.Vector3, ads: number): number {
    if (ads <= 0) return 1;
    const depth = Math.max(1e-3, -position.z);
    const radial = Math.hypot(position.x, position.y) / depth;
    const keep = THREE.MathUtils.smoothstep(radial, MuzzleSmoke.CLEAR * 0.55, MuzzleSmoke.CLEAR * 1.15);
    return 1 - ads * (1 - keep);
  }

  update(dt: number, ads: number, drift: (point: THREE.Vector3, velocity: THREE.Vector3) => void): void {
    let count = 0;
    for (let p = 0; p < this.puffs.length; p++) {
      const puff = this.puffs[p]!;
      if (puff.life <= 0) continue;
      puff.life -= dt;
      if (puff.life <= 0) { puff.alpha = 0; continue; }
      drift(puff.position, puff.velocity);
      // Push puffs away from the view axis while aiming.
      if (ads > 0) {
        const depth = Math.max(0.05, -puff.position.z), radial = Math.hypot(puff.position.x, puff.position.y) / depth;
        if (radial < MuzzleSmoke.CLEAR * 1.3) {
          const length = Math.hypot(puff.position.x, puff.position.y) || 1e-4;
          const push = ads * 0.9 * dt * (1.3 - radial / MuzzleSmoke.CLEAR);
          puff.position.x += (length > 1e-4 ? puff.position.x / length : 1) * push * depth * 0.4;
          puff.position.y += (length > 1e-4 ? puff.position.y / length : -1) * push * depth * 0.4;
        }
      }
      puff.position.addScaledVector(puff.velocity, dt);
      puff.velocity.multiplyScalar(Math.exp(-1.6 * dt));
      puff.angle += puff.spin * dt;
      const age = 1 - puff.life / puff.duration;
      const size = puff.size + puff.grow * Math.sqrt(age);
      const fade = Math.min(1, age * 6) * (1 - age) * puff.opacity * MuzzleSmoke.clearance(puff.position, ads);
      puff.alpha = fade;
      const cosine = Math.cos(puff.angle) * size, sine = Math.sin(puff.angle) * size;
      const base = count * 12;
      for (let c = 0; c < 4; c++) {
        const cx = QUAD_CORNERS[c * 2]!, cy = QUAD_CORNERS[c * 2 + 1]!;
        this.positions[base + c * 3] = puff.position.x + cx * cosine - cy * sine;
        this.positions[base + c * 3 + 1] = puff.position.y + cx * sine + cy * cosine;
        this.positions[base + c * 3 + 2] = puff.position.z;
        this.alpha[count * 4 + c] = fade;
      }
      count++;
    }
    this.geometry.setDrawRange(0, count * 6);
    this.mesh.visible = count > 0;
    if (count) { this.geometry.getAttribute('position').needsUpdate = true; this.geometry.getAttribute('smokeAlpha').needsUpdate = true; }
  }
  /** Live puffs for tests and tuning: position and the opacity the last update drew (fade and aim
   * clearance applied, exactly the value written to the `smokeAlpha` attribute). */
  live(): Array<{ position: THREE.Vector3; opacity: number }> {
    return this.puffs.filter(puff => puff.life > 0).map(puff => ({ position: puff.position.clone(), opacity: puff.alpha }));
  }
  clear(): void { for (const puff of this.puffs) { puff.life = 0; puff.alpha = 0; } this.geometry.setDrawRange(0, 0); this.mesh.visible = false; }
  dispose(): void { this.geometry.dispose(); this.material.dispose(); this.mesh.removeFromParent(); }
}

interface Casing { position: THREE.Vector3; velocity: THREE.Vector3; rotation: THREE.Quaternion; spin: THREE.Vector3; life: number; bounced: boolean }
const SHELL_KINDS: readonly ShellStyle[] = ['rifle', 'pistol', 'hull'];

/** Spent casings: pooled instanced meshes per casing type. */
export class CasingEjector {
  readonly group = new THREE.Group();
  private readonly meshes: Record<ShellStyle, THREE.InstancedMesh>;
  private readonly pools: Record<ShellStyle, Casing[]>;
  private readonly cursors: Record<ShellStyle, number> = { rifle: 0, pistol: 0, hull: 0 };
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly spinQuaternion = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();
  private readonly unit = new THREE.Vector3(1, 1, 1);
  static readonly LIFE = 0.75;

  constructor(readonly capacity: number, brass: THREE.Material, hull: THREE.Material) {
    this.group.name = 'viewmodel-casings';
    const make = (kind: ShellStyle, material: THREE.Material) => {
      const geometry = buildCasingGeometry(kind); this.geometries.push(geometry);
      const mesh = new THREE.InstancedMesh(geometry, material, capacity);
      mesh.name = `casings-${kind}`; mesh.frustumCulled = false; mesh.count = 0;
      this.group.add(mesh); return mesh;
    };
    this.meshes = { rifle: make('rifle', brass), pistol: make('pistol', brass), hull: make('hull', hull) };
    const pool = () => Array.from({ length: capacity }, () => ({ position: new THREE.Vector3(), velocity: new THREE.Vector3(), rotation: new THREE.Quaternion(), spin: new THREE.Vector3(), life: 0, bounced: false }));
    this.pools = { rifle: pool(), pistol: pool(), hull: pool() };
  }

  /** `position`, `velocity` and `orientation` are camera space. */
  eject(kind: ShellStyle, position: THREE.Vector3, velocity: THREE.Vector3, orientation: THREE.Quaternion, random: () => number): void {
    const pool = this.pools[kind];
    const casing = pool[this.cursors[kind]++ % pool.length]!;
    casing.position.copy(position); casing.velocity.copy(velocity);
    casing.rotation.copy(orientation);
    casing.spin.set((random() - 0.5) * 8, 14 + random() * 10, (random() - 0.5) * 30);
    casing.life = CasingEjector.LIFE * (0.85 + random() * 0.3); casing.bounced = false;
  }
  get liveCount(): number {
    let count = 0;
    for (let k = 0; k < SHELL_KINDS.length; k++) for (const casing of this.pools[SHELL_KINDS[k]!]) if (casing.life > 0) count++;
    return count;
  }
  update(dt: number, gravity: THREE.Vector3, drift: (point: THREE.Vector3, velocity: THREE.Vector3) => void): void {
    for (let k = 0; k < SHELL_KINDS.length; k++) {
      const kind = SHELL_KINDS[k]!, mesh = this.meshes[kind], pool = this.pools[kind];
      let count = 0;
      for (let i = 0; i < pool.length; i++) {
        const casing = pool[i]!;
        if (casing.life <= 0) continue;
        casing.life -= dt;
        if (casing.life <= 0) continue;
        drift(casing.position, casing.velocity);
        casing.velocity.addScaledVector(gravity, dt);
        casing.position.addScaledVector(casing.velocity, dt);
        const angle = casing.spin.length() * dt;
        if (angle > 0) { this.axis.copy(casing.spin).normalize(); casing.rotation.multiply(this.spinQuaternion.setFromAxisAngle(this.axis, angle)); }
        const shrink = Math.min(1, casing.life / 0.12);
        this.matrix.compose(casing.position, casing.rotation, this.unit.setScalar(shrink));
        mesh.setMatrixAt(count++, this.matrix);
      }
      mesh.count = count;
      if (count) mesh.instanceMatrix.needsUpdate = true;
    }
  }
  clear(): void { for (const kind of SHELL_KINDS) { for (const casing of this.pools[kind]) casing.life = 0; this.meshes[kind].count = 0; } }
  dispose(): void { for (const geometry of this.geometries) geometry.dispose(); for (const kind of SHELL_KINDS) this.meshes[kind].dispose(); this.group.removeFromParent(); }
}

interface Drop { object: THREE.Object3D; velocity: THREE.Vector3; spin: number; life: number }
/** A magazine dropped during an empty reload: a shared-geometry copy that tumbles out of view. */
export class DroppedMagazines {
  readonly group = new THREE.Group();
  private readonly drops: Drop[] = [];
  private readonly scratch = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3(1, 0, 0);
  static readonly LIFE = 0.7;
  constructor() { this.group.name = 'viewmodel-dropped-magazines'; }
  drop(source: THREE.Object3D, velocity: THREE.Vector3, spin: number, slots = 2): void {
    source.updateWorldMatrix(true, false);
    let drop = this.drops.find(entry => entry.life <= 0 && entry.object.userData.source === source);
    if (!drop) {
      if (this.drops.filter(entry => entry.object.userData.source === source).length >= slots) drop = this.drops.find(entry => entry.object.userData.source === source)!;
      else {
        const object = source.clone(true); object.userData.source = source; object.name = 'dropped-mag';
        drop = { object, velocity: new THREE.Vector3(), spin: 0, life: 0 };
        this.drops.push(drop); this.group.add(object);
      }
    }
    source.matrixWorld.decompose(drop.object.position, drop.object.quaternion, drop.object.scale);
    drop.velocity.copy(velocity); drop.spin = spin; drop.life = DroppedMagazines.LIFE; drop.object.visible = true;
  }
  get liveCount(): number { return this.drops.filter(drop => drop.life > 0).length; }
  update(dt: number, gravity: THREE.Vector3, drift: (point: THREE.Vector3, velocity: THREE.Vector3) => void): void {
    for (const drop of this.drops) {
      if (drop.life <= 0) { drop.object.visible = false; continue; }
      drop.life -= dt;
      drift(drop.object.position, drop.velocity);
      drop.velocity.addScaledVector(gravity, dt);
      drop.object.position.addScaledVector(drop.velocity, dt);
      drop.object.quaternion.multiply(this.scratch.setFromAxisAngle(this.axis, drop.spin * dt));
      drop.object.visible = drop.life > 0;
    }
  }
  /** Forget copies of models that are no longer used (weapon library disposed). */
  clear(): void { for (const drop of this.drops) drop.object.removeFromParent(); this.drops.length = 0; }
  dispose(): void { this.clear(); this.group.removeFromParent(); }
}
