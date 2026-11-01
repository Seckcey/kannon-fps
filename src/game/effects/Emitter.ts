import * as THREE from 'three';
import { scaledCount } from './budget';
import { FACING, type Particle, type ParticlePool } from './particles';
import type { EffectRandom } from './random';
import type { BurstSpec, PoolName } from './recipes';

const direction = new THREE.Vector3();

/** Turns recipe rows into particles. Counts follow the budget scale (phones get half). */
export class Emitter {
  scale = 1;

  constructor(public pools: Record<PoolName, ParticlePool>, readonly random: EffectRandom) {}

  /** A raw particle for hand-shaped effects. Set its life last. */
  particle(pool: PoolName): Particle { return this.pools[pool].emit(); }

  /** Count after the budget: `count * countScale`, halved on phones, at least one when non-zero. */
  count(count: number, countScale = 1) { return scaledCount(count * countScale, this.scale); }

  /** Sprays one recipe row from a contact along a unit `normal`. Returns how many particles it made. */
  burst(spec: BurstSpec, x: number, y: number, z: number, normal: THREE.Vector3, countScale = 1, floor = -Infinity): number {
    const count = this.count(spec.count, countScale), pool = this.pools[spec.pool], random = this.random;
    const offset = spec.offset ?? 0.03, jitter = spec.jitter ?? 0.02, intensity = spec.intensity ?? 1;
    for (let index = 0; index < count; index++) {
      const particle = pool.emit();
      direction.set(random.signed(), random.signed(), random.signed()).multiplyScalar(spec.spread).add(normal);
      if (direction.lengthSq() < 1e-8) direction.copy(normal);
      direction.normalize();
      particle.velocity.copy(direction).multiplyScalar(random.range(spec.speed[0], spec.speed[1]));
      particle.velocity.y += spec.lift ?? 0;
      particle.position.set(
        x + normal.x * offset + random.signed(jitter), y + normal.y * offset + random.signed(jitter), z + normal.z * offset + random.signed(jitter),
      );
      const size = random.range(spec.size[0], spec.size[1]);
      particle.size = size; particle.endSize = size * spec.endScale;
      particle.color.copy(spec.color).multiplyScalar(intensity);
      particle.endColor.copy(spec.endColor ?? spec.color).multiplyScalar(intensity);
      particle.opacity = spec.opacity; particle.kind = spec.kind; particle.seed = random.next();
      particle.facing = spec.facing ?? FACING.camera;
      particle.aspect = typeof spec.aspect === 'number' ? spec.aspect : spec.aspect ? random.range(spec.aspect[0], spec.aspect[1]) : 1;
      particle.angle = random.range(0, Math.PI * 2); particle.spin = random.signed(spec.spin ?? 0);
      particle.gravity = spec.gravity ?? 0; particle.drag = spec.drag ?? 0; particle.bounce = spec.bounce ?? 0; particle.floor = floor;
      particle.life = particle.duration = random.range(spec.life[0], spec.life[1]);
    }
    return count;
  }
}
