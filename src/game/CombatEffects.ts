import * as THREE from 'three';
import type { GameEvent, Vec3 } from '../../shared/protocol';
import { raycastMap } from '../../shared/physics';

type Shot = Extract<GameEvent, { type: 'shot' }>;
const GLOW_CAPACITY = 512, DUST_CAPACITY = 256, TRAIL_CAPACITY = 96;
const ivory = new THREE.Color('#fff0c5'), amber = new THREE.Color('#ffc579');
const shield = new THREE.Color('#82e7ff'), stone = new THREE.Color('#c9bba2');
const ceramic = new THREE.Color('#ffe4bc'), healing = new THREE.Color('#91ffd0');

/** A cosmetic barrel may protrude through cover; effects must stay on this side. */
export function resolveVisualMuzzle(authoritative: Vec3, visual: Vec3): THREE.Vector3 {
  const result = new THREE.Vector3(authoritative.x, authoritative.y, authoritative.z);
  if (![visual.x, visual.y, visual.z].every(Number.isFinite)) return result;
  const delta = new THREE.Vector3(visual.x - authoritative.x, visual.y - authoritative.y, visual.z - authoritative.z);
  const distance = delta.length();
  if (distance < 1e-6 || distance > 3) return result;
  delta.multiplyScalar(1 / distance);
  const wall = raycastMap(authoritative, delta, distance);
  return result.addScaledVector(delta, wall < distance ? Math.max(0, wall - 0.025) : distance);
}

/** Two persistent quad batches replace per-shot objects and square point sprites. */
class EffectBatch {
  readonly geometry = new THREE.BufferGeometry();
  readonly material: THREE.ShaderMaterial;
  readonly mesh: THREE.Mesh;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly opacity: Float32Array;
  private readonly kinds: Float32Array;
  private count = 0;

  constructor(private capacity: number, additive: boolean) {
    this.positions = new Float32Array(capacity * 12);
    this.colors = new Float32Array(capacity * 12);
    this.opacity = new Float32Array(capacity * 4);
    this.kinds = new Float32Array(capacity * 4);
    const uv = new Float32Array(capacity * 8), index = new Uint16Array(capacity * 6);
    for (let i = 0; i < capacity; i++) {
      uv.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
      index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    for (const [name, array, size] of [
      ['position', this.positions, 3], ['color', this.colors, 3],
      ['effectOpacity', this.opacity, 1], ['effectKind', this.kinds, 1],
    ] as const) this.geometry.setAttribute(name, new THREE.BufferAttribute(array, size).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.geometry.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: false,
      vertexShader: `
        attribute vec3 color;
        attribute float effectOpacity;
        attribute float effectKind;
        varying vec2 vUv;
        varying vec3 vColor;
        varying float vOpacity;
        varying float vKind;
        void main() {
          vUv = uv; vColor = color; vOpacity = effectOpacity; vKind = effectKind;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec2 vUv;
        varying vec3 vColor;
        varying float vOpacity;
        varying float vKind;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          float alpha;
          if (vKind < 0.5) {
            float petals = 0.68 + 0.22 * cos(atan(p.y, p.x) * 5.0);
            alpha = pow(max(0.0, 1.0 - r / petals), 1.25);
          } else if (vKind < 1.5) {
            alpha = pow(max(0.0, 1.0 - abs(p.x)), 1.7) * (1.0 - smoothstep(0.58, 1.0, abs(p.y)));
          } else if (vKind < 2.5) {
            float grain = 0.77 + 0.13 * sin(p.x * 13.0 + sin(p.y * 9.0)) + 0.1 * cos(p.y * 17.0);
            alpha = pow(max(0.0, 1.0 - r), 1.7) * grain;
          } else if (vKind < 3.5) {
            alpha = (1.0 - smoothstep(0.57, 0.69, abs(p.x) + abs(p.y))) * (0.74 + p.y * 0.2);
          } else {
            alpha = (1.0 - smoothstep(0.04, 0.14, abs(r - 0.72))) * (0.75 + 0.25 * cos(atan(p.y, p.x) * 8.0));
          }
          alpha *= vOpacity;
          if (alpha < 0.004) discard;
          gl_FragColor = vec4(vColor, alpha);
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.name = additive ? 'combat-glow-batch' : 'combat-dust-batch';
    this.mesh.renderOrder = additive ? 5 : 4;
  }

  reset() { this.count = 0; }

  quad(center: THREE.Vector3, across: THREE.Vector3, along: THREE.Vector3, color: THREE.Color, opacity: number, kind: number) {
    if (this.count >= this.capacity) return;
    const start = this.count++ * 4;
    for (let corner = 0; corner < 4; corner++) {
      const x = corner === 0 || corner === 3 ? -1 : 1, y = corner < 2 ? -1 : 1;
      const vertex = start + corner, offset = vertex * 3;
      this.positions[offset] = center.x + across.x * x + along.x * y;
      this.positions[offset + 1] = center.y + across.y * x + along.y * y;
      this.positions[offset + 2] = center.z + across.z * x + along.z * y;
      this.colors[offset] = color.r; this.colors[offset + 1] = color.g; this.colors[offset + 2] = color.b;
      this.opacity[vertex] = opacity; this.kinds[vertex] = kind;
    }
  }

  finish() {
    this.geometry.setDrawRange(0, this.count * 6);
    this.mesh.visible = this.count > 0;
    if (!this.count) return;
    for (const name of ['position', 'color', 'effectOpacity', 'effectKind']) this.geometry.getAttribute(name).needsUpdate = true;
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); this.mesh.removeFromParent(); }
}

interface Particle {
  position: THREE.Vector3; velocity: THREE.Vector3; color: THREE.Color;
  life: number; duration: number; size: number; endSize: number;
  angle: number; spin: number; gravity: number; drag: number; opacity: number; kind: number; aspect: number;
}
interface Trail { from: THREE.Vector3; to: THREE.Vector3; life: number; duration: number; width: number; color: THREE.Color }
const particlePool = (count: number): Particle[] => Array.from({ length: count }, () => ({
  position: new THREE.Vector3(), velocity: new THREE.Vector3(), color: new THREE.Color(),
  life: 0, duration: 1, size: 0, endSize: 0, angle: 0, spin: 0, gravity: 0, drag: 0, opacity: 0, kind: 0, aspect: 1,
}));

export class CombatEffects {
  readonly root = new THREE.Group();
  private readonly glow = new EffectBatch(GLOW_CAPACITY + TRAIL_CAPACITY, true);
  private readonly dust = new EffectBatch(DUST_CAPACITY, false);
  private readonly glowParticles = particlePool(GLOW_CAPACITY);
  private readonly dustParticles = particlePool(DUST_CAPACITY);
  private readonly trails: Trail[] = Array.from({ length: TRAIL_CAPACITY }, () => ({ from: new THREE.Vector3(), to: new THREE.Vector3(), life: 0, duration: 0.09, width: 0.02, color: ivory }));
  private glowCursor = 0;
  private dustCursor = 0;
  private trailCursor = 0;
  private disposed = false;
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly across = new THREE.Vector3();
  private readonly along = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly viewDirection = new THREE.Vector3();
  private readonly cameraPosition = new THREE.Vector3();

  constructor() { this.root.name = 'combat-effects'; this.root.add(this.dust.mesh, this.glow.mesh); }

  private emit(additive: boolean, position: Vec3, color: THREE.Color, size: number, endSize: number, duration: number, kind: number, opacity = 1) {
    const pool = additive ? this.glowParticles : this.dustParticles;
    const index = additive ? this.glowCursor++ % pool.length : this.dustCursor++ % pool.length;
    const particle = pool[index];
    particle.position.set(position.x, position.y, position.z); particle.color.copy(color);
    particle.life = particle.duration = duration; particle.size = size; particle.endSize = endSize;
    particle.kind = kind; particle.opacity = opacity; particle.aspect = 1;
    particle.angle = Math.random() * Math.PI * 2; particle.spin = 0; particle.gravity = 0; particle.drag = 0;
    particle.velocity.set(0, 0, 0);
    return particle;
  }

  shot(event: Shot, visualMuzzle?: Vec3, showMuzzle = true) {
    if (this.disposed) return;
    const from = visualMuzzle ? resolveVisualMuzzle(event.from, visualMuzzle) : new THREE.Vector3(event.from.x, event.from.y, event.from.z);
    const shotgun = event.slot === 2;
    if (showMuzzle) {
      this.emit(true, from, ivory, shotgun ? 0.42 : 0.28, 0.08, shotgun ? 0.075 : 0.055, 0, 1);
      const flame = this.emit(true, from, amber, shotgun ? 0.64 : 0.39, 0.08, shotgun ? 0.08 : 0.06, 0, 0.7);
      flame.spin = 3;
    }
    const traces = event.traces?.slice(0, shotgun ? 9 : 1) ?? [{ to: event.to, kind: 'range' as const }];
    for (const trace of traces) {
      const to = trace.to;
      this.direction.set(to.x - from.x, to.y - from.y, to.z - from.z);
      const length = this.direction.length();
      if (!Number.isFinite(length)) continue;
      const forward = this.direction.x * (to.x - event.from.x) + this.direction.y * (to.y - event.from.y) + this.direction.z * (to.z - event.from.z);
      // At point-blank range the animated barrel can extend past the contact.
      // Keep the accepted impact, but never draw a tracer backwards into it.
      if (length >= 0.005 && forward > 0) {
        this.direction.multiplyScalar(1 / length);
        const wall = raycastMap(from, this.direction, length);
        const trail = this.trails[this.trailCursor++ % this.trails.length];
        trail.from.copy(from); trail.to.copy(from).addScaledVector(this.direction, Math.max(0, Math.min(length, wall)));
        trail.life = trail.duration = shotgun ? 0.075 : 0.09;
        trail.width = shotgun ? 0.016 : 0.024; trail.color = shotgun ? amber : ivory;
      }

      // The old 'hit' bit means ANY pellet hit. Only this pellet's actual
      // contact can place an impact; a range endpoint is empty air.
      if (trace.kind === 'range' || trace.protected) continue;
      this.direction.set(event.from.x - to.x, event.from.y - to.y, event.from.z - to.z).normalize();
      if (trace.kind === 'world') {
        for (let i = 0; i < (shotgun ? 2 : 4); i++) {
          const puff = this.emit(false, to, stone, 0.12, 0.38, 0.3 + Math.random() * 0.16, 2, 0.45);
          puff.position.addScaledVector(this.direction, 0.08);
          puff.velocity.copy(this.direction).multiplyScalar(0.4 + Math.random() * 0.6);
          puff.velocity.x += (Math.random() - 0.5) * 0.6; puff.velocity.y += 0.2 + Math.random() * 0.4; puff.velocity.z += (Math.random() - 0.5) * 0.6;
          puff.drag = 2;
        }
        for (let i = 0; i < (shotgun ? 2 : 4); i++) {
          const chip = this.emit(false, to, ceramic, 0.045 + Math.random() * 0.045, 0.02, 0.2 + Math.random() * 0.18, 3, 0.85);
          chip.position.addScaledVector(this.direction, 0.045);
          chip.velocity.copy(this.direction).multiplyScalar(1 + Math.random() * 1.6);
          chip.velocity.x += (Math.random() - 0.5) * 1.5; chip.velocity.y += Math.random() * 1.5; chip.velocity.z += (Math.random() - 0.5) * 1.5;
          chip.gravity = 8; chip.spin = (Math.random() - 0.5) * 14;
        }
      } else {
        for (let i = 0; i < (shotgun ? 2 : 6); i++) {
          const spark = this.emit(true, to, trace.shield ? shield : ceramic, 0.055, 0.01, 0.13 + Math.random() * 0.08, 1, 0.85);
          spark.velocity.copy(this.direction).multiplyScalar(0.8 + Math.random() * 1.5);
          spark.velocity.x += (Math.random() - 0.5) * 2; spark.velocity.y += (Math.random() - 0.2) * 2; spark.velocity.z += (Math.random() - 0.5) * 2;
          spark.aspect = 2.8; spark.gravity = 2;
        }
      }
    }
  }

  elimination(position: Vec3) {
    if (this.disposed) return;
    for (let i = 0; i < 30; i++) {
      const particle = this.emit(true, position, i % 3 ? shield : ivory, 0.08, 0.015, 0.36 + Math.random() * 0.25, 3, 0.8);
      particle.position.y += 0.35 + Math.random() * 1.25;
      particle.velocity.set((Math.random() - 0.5) * 2.5, 0.4 + Math.random() * 1.5, (Math.random() - 0.5) * 2.5);
      particle.drag = 2; particle.spin = 5;
    }
  }

  heal(position: Vec3) { if (!this.disposed) this.rise(position, healing, 14); }
  respawn(position: Vec3) { if (!this.disposed) this.rise(position, shield, 20); }

  private rise(position: Vec3, color: THREE.Color, count: number) {
    const halo = this.emit(true, position, color, 0.4, 1.4, 0.38, 4, 0.26);
    halo.position.y += 0.85;
    for (let i = 0; i < count; i++) {
      const particle = this.emit(true, position, color, 0.07, 0.025, 0.4 + Math.random() * 0.3, 3, 0.7);
      const angle = i / count * Math.PI * 2;
      particle.position.x += Math.cos(angle) * 0.4; particle.position.z += Math.sin(angle) * 0.4;
      particle.position.y += Math.random() * 1.2;
      particle.velocity.set(Math.cos(angle) * 0.15, 0.6 + Math.random() * 0.6, Math.sin(angle) * 0.15);
      particle.spin = 2;
    }
  }

  update(dt: number, camera: THREE.Camera) {
    if (this.disposed) return;
    dt = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    const step = Math.min(dt, 0.05);
    camera.updateMatrixWorld();
    this.right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    this.up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    this.glow.reset(); this.dust.reset();
    for (const [pool, batch] of [[this.glowParticles, this.glow], [this.dustParticles, this.dust]] as const) {
      for (const particle of pool) {
        if (particle.life <= 0) continue;
        particle.life -= dt;
        if (particle.life <= 0) continue;
        particle.position.addScaledVector(particle.velocity, step);
        particle.velocity.multiplyScalar(Math.exp(-particle.drag * step)); particle.velocity.y -= particle.gravity * step;
        particle.angle += particle.spin * step;
        const remaining = particle.life / particle.duration;
        const size = THREE.MathUtils.lerp(particle.endSize, particle.size, remaining) * 0.5;
        const cosine = Math.cos(particle.angle), sine = Math.sin(particle.angle);
        this.across.copy(this.right).multiplyScalar(cosine).addScaledVector(this.up, sine).multiplyScalar(size);
        this.along.copy(this.up).multiplyScalar(cosine).addScaledVector(this.right, -sine).multiplyScalar(size * particle.aspect);
        batch.quad(particle.position, this.across, this.along, particle.color, particle.opacity * Math.min(1, remaining * 2), particle.kind);
      }
    }
    for (const trail of this.trails) {
      if (trail.life <= 0) continue;
      trail.life -= dt;
      if (trail.life <= 0) continue;
      this.direction.subVectors(trail.to, trail.from);
      const length = this.direction.length();
      if (length < 0.005) continue;
      this.direction.multiplyScalar(1 / length);
      const progress = 1 - trail.life / trail.duration;
      const head = length * Math.min(1, 0.35 + progress * 0.85);
      const tail = Math.max(0, head - Math.min(7, length * 0.65));
      this.center.copy(trail.from).addScaledVector(this.direction, (head + tail) * 0.5);
      this.viewDirection.subVectors(this.cameraPosition, this.center).normalize();
      this.across.crossVectors(this.direction, this.viewDirection);
      if (this.across.lengthSq() < 1e-8) this.across.copy(this.right);
      this.across.normalize().multiplyScalar(trail.width * 0.5);
      this.along.copy(this.direction).multiplyScalar((head - tail) * 0.5);
      this.glow.quad(this.center, this.across, this.along, trail.color, (1 - progress) * 0.75, 1);
    }
    this.dust.finish(); this.glow.finish();
  }

  clear() {
    for (const particle of this.glowParticles) particle.life = 0;
    for (const particle of this.dustParticles) particle.life = 0;
    for (const trail of this.trails) trail.life = 0;
    this.glowCursor = this.dustCursor = this.trailCursor = 0;
    this.glow.reset(); this.dust.reset(); this.glow.finish(); this.dust.finish();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.clear(); this.glow.dispose(); this.dust.dispose(); this.root.removeFromParent();
  }
}
