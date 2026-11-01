import * as THREE from 'three';
import type { WeaponId } from '../../../shared/protocol';
import { groundBelow } from './mapQuery';
import type { EffectRandom } from './random';

interface CasingSpec { radius: number; length: number; color: THREE.Color }
/** Spent cases by weapon: rifle and pistol brass, a red shotgun hull. */
export const CASINGS: Readonly<Record<WeaponId, CasingSpec>> = {
  kr5: { radius: 0.0048, length: 0.045, color: new THREE.Color('#c9a04a') },
  hornet9: { radius: 0.0049, length: 0.019, color: new THREE.Color('#caa24f') },
  sentry9: { radius: 0.0049, length: 0.019, color: new THREE.Color('#caa24f') },
  longbow: { radius: 0.006, length: 0.051, color: new THREE.Color('#bf9645') },
  breaker12: { radius: 0.0105, length: 0.065, color: new THREE.Color('#8e2b22') },
};
const GRAVITY = 9.8, MAX_SPEED = 12, FADE_SECONDS = 0.25, REST_SPEED = 0.6;

const matrix = new THREE.Matrix4(), hidden = new THREE.Matrix4().makeScale(0, 0, 0);
const position = new THREE.Vector3(), scale = new THREE.Vector3(), axis = new THREE.Vector3(), flat = new THREE.Vector3();
const turn = new THREE.Quaternion();
const finite = (x: number, y: number, z: number) => Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);

/** Ejected cases as one instanced mesh: they arc out, bounce, lie down on the ground and shrink away. */
export class ShellCasings {
  readonly mesh: THREE.InstancedMesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
  readonly capacity: number;
  private readonly life: Float32Array;
  private readonly body: Float32Array;
  private readonly rotations: THREE.Quaternion[];
  private readonly resting: Uint8Array;
  private cursor = 0;
  private colorsDirty = false;

  constructor(capacity: number, private readonly lifetime: number, private readonly random: EffectRandom) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.life = new Float32Array(this.capacity);
    // Per case: x, y, z, vx, vy, vz, floor, radius, length, spin, axis x, y, z.
    this.body = new Float32Array(this.capacity * 13);
    this.resting = new Uint8Array(this.capacity);
    this.rotations = Array.from({ length: this.capacity }, () => new THREE.Quaternion());
    const geometry = new THREE.CylinderGeometry(1, 1, 1, 6, 1);
    const material = new THREE.MeshStandardMaterial({ name: 'combat-shells', color: '#ffffff', metalness: 0.85, roughness: 0.34 });
    this.mesh = new THREE.InstancedMesh(geometry, material, this.capacity);
    this.mesh.name = 'combat-shells';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Colours exist from the start so the shader never switches program when the first case appears.
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3).fill(1), 3);
    for (let index = 0; index < this.capacity; index++) this.mesh.setMatrixAt(index, hidden);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  get active() { let count = 0; for (let index = 0; index < this.capacity; index++) if (this.life[index] > 0) count++; return count; }

  spawn(at: THREE.Vector3, velocity: THREE.Vector3, weapon: WeaponId) {
    if (!at || !velocity || !finite(at.x, at.y, at.z) || !finite(velocity.x, velocity.y, velocity.z)) return;
    const spec = Object.hasOwn(CASINGS, weapon) ? CASINGS[weapon] : CASINGS.kr5;
    const index = this.cursor, offset = index * 13, random = this.random;
    this.cursor = (this.cursor + 1) % this.capacity;
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z), limit = speed > MAX_SPEED ? MAX_SPEED / speed : 1;
    const body = this.body;
    body[offset] = at.x; body[offset + 1] = at.y; body[offset + 2] = at.z;
    body[offset + 3] = velocity.x * limit; body[offset + 4] = velocity.y * limit; body[offset + 5] = velocity.z * limit;
    body[offset + 6] = groundBelow(at.x, at.y, at.z);
    body[offset + 7] = spec.radius; body[offset + 8] = spec.length;
    body[offset + 9] = random.range(18, 34);
    axis.set(random.signed(), random.signed(), random.signed());
    if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0);
    axis.normalize();
    body[offset + 10] = axis.x; body[offset + 11] = axis.y; body[offset + 12] = axis.z;
    axis.set(random.signed(), random.signed(), random.signed());
    if (axis.lengthSq() < 1e-6) axis.set(0, 0, 1);
    this.rotations[index].setFromAxisAngle(axis.normalize(), random.range(0, Math.PI * 2));
    this.resting[index] = 0;
    this.life[index] = this.lifetime;
    this.mesh.setColorAt(index, spec.color);
    this.colorsDirty = true;
  }

  update(dt: number, step: number) {
    let highest = -1, changed = false;
    const body = this.body;
    for (let index = 0; index < this.capacity; index++) {
      if (this.life[index] <= 0) continue;
      this.life[index] -= dt;
      changed = true;
      if (this.life[index] <= 0) { this.mesh.setMatrixAt(index, hidden); continue; }
      const offset = index * 13, rotation = this.rotations[index];
      if (!this.resting[index]) {
        body[offset + 4] -= GRAVITY * step;
        body[offset] += body[offset + 3] * step; body[offset + 1] += body[offset + 4] * step; body[offset + 2] += body[offset + 5] * step;
        const rest = body[offset + 6] + body[offset + 7];
        if (body[offset + 1] < rest) {
          body[offset + 1] = rest;
          if (body[offset + 4] < 0) {
            body[offset + 4] *= -0.3; body[offset + 3] *= 0.6; body[offset + 5] *= 0.6; body[offset + 9] *= 0.6;
          }
          if (body[offset + 4] < REST_SPEED) {
            // Settle: stop bouncing and lie the case down on its side.
            body[offset + 4] = 0; body[offset + 9] = 0; this.resting[index] = 1;
            axis.set(0, 1, 0).applyQuaternion(rotation);
            flat.set(axis.x, 0, axis.z);
            if (flat.lengthSq() < 1e-6) flat.set(1, 0, 0);
            rotation.premultiply(turn.setFromUnitVectors(axis, flat.normalize()));
          }
        }
        if (body[offset + 9] > 0) {
          axis.set(body[offset + 10], body[offset + 11], body[offset + 12]);
          rotation.premultiply(turn.setFromAxisAngle(axis, body[offset + 9] * step));
        }
      } else {
        const friction = Math.exp(-6 * step);
        body[offset + 3] *= friction; body[offset + 5] *= friction;
        body[offset] += body[offset + 3] * step; body[offset + 2] += body[offset + 5] * step;
      }
      const fade = Math.min(1, this.life[index] / FADE_SECONDS);
      position.set(body[offset], body[offset + 1], body[offset + 2]);
      scale.set(body[offset + 7] * fade, body[offset + 8] * fade, body[offset + 7] * fade);
      this.mesh.setMatrixAt(index, matrix.compose(position, rotation, scale));
      highest = index;
    }
    this.mesh.count = highest + 1;
    this.mesh.visible = highest >= 0;
    if (changed) this.mesh.instanceMatrix.needsUpdate = true;
    if (this.colorsDirty && this.mesh.instanceColor) { this.mesh.instanceColor.needsUpdate = true; this.colorsDirty = false; }
  }

  clear() {
    this.life.fill(0); this.resting.fill(0); this.cursor = 0;
    for (let index = 0; index < this.capacity; index++) this.mesh.setMatrixAt(index, hidden);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.count = 0; this.mesh.visible = false;
  }

  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.mesh.dispose(); this.mesh.removeFromParent(); }
}
