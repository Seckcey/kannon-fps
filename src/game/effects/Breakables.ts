import * as THREE from 'three';
import type { Vec3 } from '../../../shared/protocol';

export type BreakableKind = 'glass' | 'pot';
export interface Breakable {
  readonly mesh: THREE.Mesh;
  readonly kind: BreakableKind;
  /** World-space bounds, for a quick reject and for spreading the shards. */
  readonly bounds: THREE.Box3;
  /** The mesh's own bounding box (slightly padded) and world-to-mesh transform: an exact oriented test. */
  readonly local: THREE.Box3;
  readonly inverse: THREE.Matrix4;
  broken: boolean;
}

const start = new THREE.Vector3(), end = new THREE.Vector3(), crossing = new THREE.Vector3(), direction = new THREE.Vector3();
const finite = (v: Vec3) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/** Where a segment (0..1) first enters a box, or -1. */
function entry(a: THREE.Vector3, b: THREE.Vector3, box: THREE.Box3): number {
  let near = 0, far = 1;
  for (let axis = 0; axis < 3; axis++) {
    const origin = a.getComponent(axis), delta = b.getComponent(axis) - origin;
    const min = box.min.getComponent(axis), max = box.max.getComponent(axis);
    if (Math.abs(delta) < 1e-12) { if (origin < min || origin > max) return -1; continue; }
    const t1 = (min - origin) / delta, t2 = (max - origin) / delta;
    near = Math.max(near, Math.min(t1, t2)); far = Math.min(far, Math.max(t1, t2));
    if (near > far) return -1;
  }
  return near <= far && far >= 0 && near <= 1 ? near : -1;
}

/** Cosmetic window glass and pots (meshes named `Breakable*`). They are not in the collision map, so
 * server traces pass straight through; each one hides and shatters the first time a shot path crosses it. */
export class BreakableSet {
  private source: readonly THREE.Mesh[] = [];
  private synced = -1;
  private entries: Breakable[] = [];

  set(meshes: readonly THREE.Mesh[] | null | undefined) {
    this.restore();
    this.source = Array.isArray(meshes) ? meshes : [];
    this.entries = []; this.synced = -1;
  }

  get broken() { let count = 0; for (const item of this.entries) if (item.broken) count++; return count; }

  /** The world fills its list when the art loads, so the list is re-read whenever its length changes. */
  private sync() {
    if (this.synced === this.source.length) return;
    const previous = new Map(this.entries.map(item => [item.mesh, item] as const));
    this.entries = [];
    for (const mesh of this.source) {
      if (!(mesh instanceof THREE.Mesh) || !(mesh.geometry instanceof THREE.BufferGeometry)) continue;
      const known = previous.get(mesh);
      if (known) { this.entries.push(known); continue; }
      const geometry = mesh.geometry;
      if (!geometry.boundingBox && geometry.getAttribute('position')) geometry.computeBoundingBox();
      if (!geometry.boundingBox || geometry.boundingBox.isEmpty()) continue;
      mesh.updateWorldMatrix(true, false);
      if (Math.abs(mesh.matrixWorld.determinant()) < 1e-12) continue;
      const local = geometry.boundingBox.clone().expandByScalar(0.005);
      const bounds = local.clone().applyMatrix4(mesh.matrixWorld);
      if (!finite(bounds.min) || !finite(bounds.max)) continue;
      this.entries.push({ mesh, kind: /pot/i.test(mesh.name) ? 'pot' : 'glass', local, bounds, inverse: mesh.matrixWorld.clone().invert(), broken: false });
    }
    this.synced = this.source.length;
  }

  /** Breaks every intact breakable the segment from → to crosses. `onBreak` gets the entry, the world
   * point where the path entered it and the unit direction of travel (both reused; copy to keep). */
  cross(from: Vec3, to: Vec3, onBreak: (item: Breakable, point: THREE.Vector3, travel: THREE.Vector3) => void): number {
    if (!finite(from) || !finite(to)) return 0;
    this.sync();
    let count = 0;
    const minX = Math.min(from.x, to.x), minY = Math.min(from.y, to.y), minZ = Math.min(from.z, to.z);
    const maxX = Math.max(from.x, to.x), maxY = Math.max(from.y, to.y), maxZ = Math.max(from.z, to.z);
    const entries = this.entries;
    for (let index = 0; index < entries.length; index++) {
      const item = entries[index];
      if (item.broken) continue;
      const { min, max } = item.bounds;
      if (maxX < min.x || minX > max.x || maxY < min.y || minY > max.y || maxZ < min.z || minZ > max.z) continue;
      start.set(from.x, from.y, from.z).applyMatrix4(item.inverse); end.set(to.x, to.y, to.z).applyMatrix4(item.inverse);
      if (!finite(start) || !finite(end)) continue;
      const t = entry(start, end, item.local);
      if (t < 0) continue;
      item.broken = true; item.mesh.visible = false; count++;
      crossing.set(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, from.z + (to.z - from.z) * t);
      direction.set(to.x - from.x, to.y - from.y, to.z - from.z);
      if (direction.lengthSq() > 1e-12) direction.normalize(); else direction.set(0, -1, 0);
      onBreak(item, crossing, direction);
    }
    return count;
  }

  /** Puts every broken pane and pot back (a new round). */
  restore() { for (const item of this.entries) if (item.broken) { item.broken = false; item.mesh.visible = true; } }

  clear() { this.restore(); this.source = []; this.entries = []; this.synced = -1; }
}
