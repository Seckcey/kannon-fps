import * as THREE from 'three';
import { EFFECT_KIND, type QuadBatch } from './QuadBatch';

/** How a particle's quad is oriented. */
export const FACING = {
  /** Faces the camera, turned by `angle`; `aspect` stretches it along its turned up axis. */
  camera: 0,
  /** Stretched along its velocity (sparks, splinters, sand); faces the camera when nearly still. */
  velocity: 1,
  /** Stretched along the fixed `axis` (the side view of a muzzle flash). */
  axis: 2,
} as const;

export interface Particle {
  life: number; duration: number;
  readonly position: THREE.Vector3; readonly velocity: THREE.Vector3; readonly axis: THREE.Vector3;
  /** Colour at birth and at death (linear, may exceed 1 for bright additive light). */
  readonly color: THREE.Color; readonly endColor: THREE.Color;
  size: number; endSize: number; aspect: number; angle: number; spin: number;
  gravity: number; drag: number; opacity: number; kind: number; seed: number; facing: number;
  /** Height it cannot fall below (the ground under the burst); -Infinity for none. */
  floor: number; bounce: number;
}

function createParticle(): Particle {
  return {
    life: 0, duration: 1, position: new THREE.Vector3(), velocity: new THREE.Vector3(), axis: new THREE.Vector3(0, 0, 1),
    color: new THREE.Color(1, 1, 1), endColor: new THREE.Color(1, 1, 1),
    size: 0, endSize: 0, aspect: 1, angle: 0, spin: 0, gravity: 0, drag: 0, opacity: 1,
    kind: EFFECT_KIND.puff, seed: 0, facing: FACING.camera, floor: -Infinity, bounce: 0,
  };
}

/** Fixed ring of particles. When full, the oldest emission is reused, so a burst can never grow memory. */
export class ParticlePool {
  readonly items: Particle[];
  private cursor = 0;

  constructor(capacity: number) { this.items = Array.from({ length: Math.max(1, Math.floor(capacity)) }, createParticle); }

  get capacity() { return this.items.length; }

  /** The next slot, reset to a still, white particle. The caller sets its life last. */
  emit(): Particle {
    const particle = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.items.length;
    particle.position.set(0, 0, 0); particle.velocity.set(0, 0, 0); particle.axis.set(0, 0, 1);
    particle.color.setRGB(1, 1, 1); particle.endColor.setRGB(1, 1, 1);
    particle.size = particle.endSize = 0; particle.aspect = 1; particle.angle = particle.spin = 0;
    particle.gravity = particle.drag = 0; particle.opacity = 1; particle.kind = EFFECT_KIND.puff; particle.seed = 0;
    particle.facing = FACING.camera; particle.floor = -Infinity; particle.bounce = 0;
    particle.life = 0; particle.duration = 1;
    return particle;
  }

  get alive() { let count = 0; for (const particle of this.items) if (particle.life > 0) count++; return count; }

  clear() { for (const particle of this.items) particle.life = 0; this.cursor = 0; }
}

/** Camera axes for building quads, with safe fallbacks for a broken camera matrix. */
export class ViewBasis {
  readonly right = new THREE.Vector3(1, 0, 0);
  readonly up = new THREE.Vector3(0, 1, 0);
  readonly eye = new THREE.Vector3();
  /** Whether `eye` is a real camera position (a frame has been drawn with a sound camera). */
  known = false;

  set(camera: THREE.Camera) {
    camera.updateMatrixWorld();
    const matrix = camera.matrixWorld;
    this.right.setFromMatrixColumn(matrix, 0); this.up.setFromMatrixColumn(matrix, 1); this.eye.setFromMatrixPosition(matrix);
    if (!finite(this.right) || this.right.lengthSq() < 1e-12) this.right.set(1, 0, 0); else this.right.normalize();
    if (!finite(this.up) || this.up.lengthSq() < 1e-12) this.up.set(0, 1, 0); else this.up.normalize();
    this.known = finite(this.eye);
    if (!this.known) this.eye.set(0, 0, 0);
  }

  /** Whether a point lies within `radius` of the last camera position. */
  near(x: number, y: number, z: number, radius: number) {
    if (!this.known) return false;
    const dx = x - this.eye.x, dy = y - this.eye.y, dz = z - this.eye.z;
    return dx * dx + dy * dy + dz * dz < radius * radius;
  }
}
const finite = (vector: THREE.Vector3) => Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);

const across = new THREE.Vector3(), along = new THREE.Vector3(), toEye = new THREE.Vector3(), direction = new THREE.Vector3(), center = new THREE.Vector3();

function orient(particle: Particle, view: ViewBasis, half: number) {
  if (particle.facing !== FACING.camera) {
    direction.copy(particle.facing === FACING.velocity ? particle.velocity : particle.axis);
    const length = direction.length();
    if (length > (particle.facing === FACING.velocity ? 0.05 : 1e-6)) {
      direction.multiplyScalar(1 / length);
      across.crossVectors(direction, toEye.subVectors(view.eye, particle.position));
      const width = across.length();
      if (width > 1e-6) {
        across.multiplyScalar(half / width);
        along.copy(direction).multiplyScalar(half * particle.aspect);
        return;
      }
    }
  }
  const cosine = Math.cos(particle.angle), sine = Math.sin(particle.angle);
  across.copy(view.right).multiplyScalar(cosine).addScaledVector(view.up, sine).multiplyScalar(half);
  along.copy(view.up).multiplyScalar(cosine).addScaledVector(view.right, -sine).multiplyScalar(half * (particle.facing === FACING.camera ? particle.aspect : 1));
}

/** Moves every live particle one frame and writes its quad. `step` is the clamped physics step. */
export function advanceParticles(pool: ParticlePool, batch: QuadBatch, view: ViewBasis, dt: number, step: number) {
  const items = pool.items;
  for (let index = 0; index < items.length; index++) {
    const particle = items[index];
    if (particle.life <= 0) continue;
    particle.life -= dt;
    if (particle.life <= 0) continue;
    const { position, velocity } = particle;
    position.addScaledVector(velocity, step);
    velocity.multiplyScalar(Math.exp(-particle.drag * step)); velocity.y -= particle.gravity * step;
    if (position.y < particle.floor) {
      position.y = particle.floor;
      if (velocity.y < 0) {
        velocity.y = -velocity.y * particle.bounce;
        if (velocity.y < 0.4) velocity.y = 0;
        velocity.x *= 0.5; velocity.z *= 0.5; particle.spin *= 0.5;
      }
    }
    particle.angle += particle.spin * step;
    const remaining = particle.life / particle.duration;
    const half = (particle.endSize + (particle.size - particle.endSize) * remaining) * 0.5;
    const { color, endColor } = particle;
    orient(particle, view, half);
    batch.quad(position, across, along,
      endColor.r + (color.r - endColor.r) * remaining, endColor.g + (color.g - endColor.g) * remaining, endColor.b + (color.b - endColor.b) * remaining,
      particle.opacity * Math.min(1, remaining * 2), particle.kind, particle.seed);
  }
}

export interface Tracer {
  readonly from: THREE.Vector3; readonly to: THREE.Vector3; readonly color: THREE.Color;
  life: number; duration: number; width: number;
}

/** Fixed ring of tracer streaks. */
export class TracerPool {
  readonly items: Tracer[];
  private cursor = 0;

  constructor(capacity: number) {
    this.items = Array.from({ length: Math.max(1, Math.floor(capacity)) }, () => ({
      from: new THREE.Vector3(), to: new THREE.Vector3(), color: new THREE.Color(1, 1, 1), life: 0, duration: 0.09, width: 0.02,
    }));
  }

  add(from: THREE.Vector3, to: THREE.Vector3, width: number, duration: number, color: THREE.Color, intensity: number) {
    const tracer = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.items.length;
    tracer.from.copy(from); tracer.to.copy(to); tracer.color.copy(color).multiplyScalar(intensity);
    tracer.width = width; tracer.life = tracer.duration = duration;
  }

  get alive() { let count = 0; for (const tracer of this.items) if (tracer.life > 0) count++; return count; }

  clear() { for (const tracer of this.items) tracer.life = 0; this.cursor = 0; }
}

/** A tracer is a short bright streak that races from the muzzle to its end within its life. */
export function advanceTracers(pool: TracerPool, batch: QuadBatch, view: ViewBasis, dt: number) {
  const items = pool.items;
  for (let index = 0; index < items.length; index++) {
    const tracer = items[index];
    if (tracer.life <= 0) continue;
    tracer.life -= dt;
    if (tracer.life <= 0) continue;
    direction.subVectors(tracer.to, tracer.from);
    const length = direction.length();
    if (!(length >= 0.005)) continue;
    direction.multiplyScalar(1 / length);
    const progress = 1 - tracer.life / tracer.duration;
    const head = length * Math.min(1, 0.35 + progress * 0.85);
    const tail = Math.max(0, head - Math.min(7, length * 0.65));
    center.copy(tracer.from).addScaledVector(direction, (head + tail) * 0.5);
    toEye.subVectors(view.eye, center).normalize();
    across.crossVectors(direction, toEye);
    if (across.lengthSq() < 1e-8) across.copy(view.right);
    across.normalize().multiplyScalar(tracer.width * 0.5);
    along.copy(direction).multiplyScalar((head - tail) * 0.5);
    batch.quad(center, across, along, tracer.color.r, tracer.color.g, tracer.color.b, (1 - progress) * 0.75, EFFECT_KIND.tracer, 0);
  }
}
