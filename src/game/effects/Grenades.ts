import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Vec3 } from '../../../shared/protocol';
import type { EffectRandom } from './random';

/** A marker nobody has moved for this long is dropped (its owner forgot to remove it). */
export const GRENADE_STALE_SECONDS = 4;
const RADIUS = 0.06, MAX_TURN = 0.6;

const matrix = new THREE.Matrix4(), hidden = new THREE.Matrix4().makeScale(0, 0, 0), unit = new THREE.Vector3(1, 1, 1);
const axis = new THREE.Vector3(), turn = new THREE.Quaternion();

/** Grenades in flight: a small olive frag body and its dark fuse, both instanced. The caller moves
 * each one along its shared trajectory; the marker tumbles as it travels. */
export class GrenadeMarkers {
  readonly body: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  readonly fittings: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  readonly capacity: number;
  private readonly ids: string[];
  private readonly lookup = new Map<string, number>();
  private readonly positions: THREE.Vector3[];
  private readonly rotations: THREE.Quaternion[];
  private readonly seen: Float64Array;
  private dirty = true;

  constructor(capacity: number, private readonly random: EffectRandom) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.ids = new Array<string>(this.capacity).fill('');
    this.positions = Array.from({ length: this.capacity }, () => new THREE.Vector3());
    this.rotations = Array.from({ length: this.capacity }, () => new THREE.Quaternion());
    this.seen = new Float64Array(this.capacity);
    const shell = new THREE.SphereGeometry(0.055, 12, 9).scale(1, 1.18, 1);
    const cap = new THREE.CylinderGeometry(0.018, 0.022, 0.03, 8).translate(0, 0.075, 0);
    const lever = new THREE.BoxGeometry(0.012, 0.07, 0.006).translate(0.036, 0.04, 0);
    const fittings = mergeGeometries([cap, lever]) ?? cap.clone();
    cap.dispose(); lever.dispose();
    this.body = this.instanced(shell, new THREE.MeshStandardMaterial({ name: 'combat-grenades', color: '#4b5320', roughness: 0.75, metalness: 0.1 }), 'combat-grenades');
    this.fittings = this.instanced(fittings, new THREE.MeshStandardMaterial({ name: 'combat-grenade-fittings', color: '#2a2b2c', roughness: 0.45, metalness: 0.7 }), 'combat-grenade-fittings');
  }

  private instanced(geometry: THREE.BufferGeometry, material: THREE.MeshStandardMaterial, name: string) {
    const mesh = new THREE.InstancedMesh(geometry, material, this.capacity);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let index = 0; index < this.capacity; index++) mesh.setMatrixAt(index, hidden);
    mesh.count = 0; mesh.frustumCulled = false; mesh.visible = false;
    return mesh;
  }

  get active() { return this.lookup.size; }

  /** Draws or moves grenade `id`; `null` removes it. Time is the effects clock in seconds. */
  set(id: string, position: Vec3 | null, time: number) {
    if (typeof id !== 'string') return;
    const existing = this.lookup.get(id);
    if (position === null) { if (existing !== undefined) this.release(existing); return; }
    if (!position || !(Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z))) return;
    let slot = existing;
    if (slot === undefined) {
      slot = this.ids.indexOf('');
      if (slot < 0) return;
      this.ids[slot] = id; this.lookup.set(id, slot);
      axis.set(this.random.signed(), this.random.signed(), this.random.signed());
      if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0);
      this.rotations[slot].setFromAxisAngle(axis.normalize(), this.random.range(0, Math.PI * 2));
    } else {
      // Roll end over end in the direction of travel, bounded so sparse updates do not spin wildly.
      const previous = this.positions[slot], dx = position.x - previous.x, dz = position.z - previous.z, ground = Math.hypot(dx, dz);
      if (ground > 1e-4) {
        const travelled = Math.hypot(dx, position.y - previous.y, dz);
        axis.set(dz / ground, 0, -dx / ground);
        this.rotations[slot].premultiply(turn.setFromAxisAngle(axis, Math.min(MAX_TURN, travelled / RADIUS)));
      }
    }
    this.positions[slot].set(position.x, position.y, position.z);
    this.seen[slot] = time;
    this.dirty = true;
  }

  private release(slot: number) {
    this.lookup.delete(this.ids[slot]);
    this.ids[slot] = '';
    this.dirty = true;
  }

  update(time: number) {
    for (let slot = 0; slot < this.capacity; slot++) if (this.ids[slot] && time - this.seen[slot] > GRENADE_STALE_SECONDS) this.release(slot);
    if (!this.dirty) return;
    this.dirty = false;
    let highest = -1;
    for (let slot = 0; slot < this.capacity; slot++) {
      if (!this.ids[slot]) { this.body.setMatrixAt(slot, hidden); this.fittings.setMatrixAt(slot, hidden); continue; }
      matrix.compose(this.positions[slot], this.rotations[slot], unit);
      this.body.setMatrixAt(slot, matrix); this.fittings.setMatrixAt(slot, matrix);
      highest = slot;
    }
    this.show(this.body, highest); this.show(this.fittings, highest);
  }

  private show(mesh: THREE.InstancedMesh, highest: number) {
    mesh.count = highest + 1; mesh.visible = highest >= 0; mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    this.ids.fill(''); this.lookup.clear(); this.dirty = true;
    this.update(0);
  }

  dispose() {
    for (const mesh of [this.body, this.fittings]) { mesh.geometry.dispose(); mesh.material.dispose(); mesh.dispose(); mesh.removeFromParent(); }
  }
}
