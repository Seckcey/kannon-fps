import * as THREE from 'three';
import { cellRect, DECAL_ATLAS, DECAL_CELLS, sharedDecalAtlas, type CellRect } from './decalAtlas';
import { createFaceBounds, faceAt } from './mapQuery';

const HOLE_OFFSET = 0.008, SCORCH_OFFSET = 0.012;

const vertexShader = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
// Modulate 2x: the framebuffer is multiplied by twice the texel, so 0.5 leaves it unchanged.
const fragmentShader = /* glsl */`
  uniform sampler2D atlas;
  varying vec2 vUv;
  void main() { gl_FragColor = vec4(texture2D(atlas, vUv).rgb, 1.0); }`;

const face = createFaceBounds(), rect: CellRect = { u0: 0, v0: 0, u1: 0, v1: 0 };
const point = new Float64Array(3);
const normal = new THREE.Vector3(), tangent = new THREE.Vector3(), bitangent = new THREE.Vector3(), turned = new THREE.Vector3(), helper = new THREE.Vector3();

/** Bullet holes and scorch marks: one mesh, one draw call, two ring buffers in one fixed geometry.
 * Scorches keep their own ring so a long firefight never erases the marks of a grenade. */
export class DecalLayer {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly texture: THREE.DataTexture;
  readonly holeCapacity: number;
  readonly scorchCapacity: number;
  private readonly positions: Float32Array;
  private readonly uvs: Float32Array;
  private readonly position: THREE.BufferAttribute;
  private readonly uv: THREE.BufferAttribute;
  private holeCursor = 0;
  private holeCount = 0;
  private scorchCursor = 0;
  private scorchCount = 0;
  private dirty = false;

  constructor(holes: number, scorches: number) {
    this.holeCapacity = Math.max(0, Math.floor(holes));
    this.scorchCapacity = Math.max(0, Math.floor(scorches));
    const slots = Math.max(1, this.holeCapacity + this.scorchCapacity);
    this.positions = new Float32Array(slots * 12);
    this.uvs = new Float32Array(slots * 8);
    const index = slots * 4 > 65535 ? new Uint32Array(slots * 6) : new Uint16Array(slots * 6);
    for (let slot = 0; slot < slots; slot++) index.set([slot * 4, slot * 4 + 1, slot * 4 + 2, slot * 4, slot * 4 + 2, slot * 4 + 3], slot * 6);
    const geometry = new THREE.BufferGeometry();
    this.position = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.uv = new THREE.BufferAttribute(this.uvs, 2).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.position);
    geometry.setAttribute('uv', this.uv);
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.setDrawRange(0, slots * 6);
    this.texture = new THREE.DataTexture(sharedDecalAtlas(), DECAL_ATLAS.width, DECAL_ATLAS.height, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.texture.name = 'combat-decal-atlas';
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
    const material = new THREE.ShaderMaterial({
      name: 'combat-decals', uniforms: { atlas: { value: this.texture } }, vertexShader, fragmentShader,
      transparent: true, depthTest: true, depthWrite: false, toneMapped: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor, blendDst: THREE.SrcColorFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'combat-decals';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = -1;
    this.mesh.visible = false;
  }

  get holes() { return this.holeCount; }
  get scorches() { return this.scorchCount; }

  /** A bullet hole; the oldest is reused once the ring is full. `direction` must be a unit normal. */
  addHole(x: number, y: number, z: number, direction: THREE.Vector3, cell: number, radius: number, rotation: number): boolean {
    if (!this.holeCapacity || !this.write(this.scorchCapacity + this.holeCursor, x, y, z, direction, cell, radius, rotation, HOLE_OFFSET)) return false;
    this.holeCursor = (this.holeCursor + 1) % this.holeCapacity;
    this.holeCount = Math.min(this.holeCapacity, this.holeCount + 1);
    return true;
  }

  addScorch(x: number, y: number, z: number, direction: THREE.Vector3, radius: number, rotation: number): boolean {
    if (!this.scorchCapacity || !this.write(this.scorchCursor, x, y, z, direction, DECAL_CELLS.scorch, radius, rotation, SCORCH_OFFSET)) return false;
    this.scorchCursor = (this.scorchCursor + 1) % this.scorchCapacity;
    this.scorchCount = Math.min(this.scorchCapacity, this.scorchCount + 1);
    return true;
  }

  /** Writes one slot. Marks on an obstacle face snap onto it and are kept inside its edges, so they
   * never hang into a doorway, a window opening or over a corner. */
  private write(slot: number, x: number, y: number, z: number, direction: THREE.Vector3, cell: number, radius: number, rotation: number, offset: number) {
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && Number.isFinite(radius) && Number.isFinite(rotation))) return false;
    normal.copy(direction);
    if (!(normal.lengthSq() > 1e-8) || !Number.isFinite(normal.lengthSq())) return false;
    normal.normalize();
    point[0] = x; point[1] = y; point[2] = z;
    if (faceAt(x, y, z, normal.x, normal.y, normal.z, face)) {
      normal.set(0, 0, 0).setComponent(face.axis, face.sign);
      point[face.axis] = face.plane;
      radius = Math.min(radius, (face.uMax - face.uMin) / 2, (face.vMax - face.vMin) / 2);
      point[face.u] = Math.min(face.uMax - radius, Math.max(face.uMin + radius, point[face.u]));
      point[face.v] = Math.min(face.vMax - radius, Math.max(face.vMin + radius, point[face.v]));
    }
    if (!(radius > 1e-4)) return false;
    helper.set(Math.abs(normal.y) < 0.9 ? 0 : 1, Math.abs(normal.y) < 0.9 ? 1 : 0, 0);
    tangent.crossVectors(helper, normal).normalize();
    bitangent.crossVectors(normal, tangent);
    turned.copy(tangent).multiplyScalar(Math.cos(rotation)).addScaledVector(bitangent, Math.sin(rotation));
    bitangent.crossVectors(normal, turned);
    const cx = point[0] + normal.x * offset, cy = point[1] + normal.y * offset, cz = point[2] + normal.z * offset;
    const base = slot * 12;
    for (let corner = 0; corner < 4; corner++) {
      const a = corner === 0 || corner === 3 ? -radius : radius, b = corner < 2 ? -radius : radius, at = base + corner * 3;
      this.positions[at] = cx + turned.x * a + bitangent.x * b;
      this.positions[at + 1] = cy + turned.y * a + bitangent.y * b;
      this.positions[at + 2] = cz + turned.z * a + bitangent.z * b;
    }
    cellRect(cell, rect);
    const uv = slot * 8;
    this.uvs[uv] = rect.u0; this.uvs[uv + 1] = rect.v0; this.uvs[uv + 2] = rect.u1; this.uvs[uv + 3] = rect.v0;
    this.uvs[uv + 4] = rect.u1; this.uvs[uv + 5] = rect.v1; this.uvs[uv + 6] = rect.u0; this.uvs[uv + 7] = rect.v1;
    this.dirty = true;
    return true;
  }

  /** Uploads changed marks once per frame. */
  update() {
    this.mesh.visible = this.holeCount + this.scorchCount > 0;
    if (!this.dirty) return;
    this.dirty = false;
    this.position.needsUpdate = true;
    this.uv.needsUpdate = true;
  }

  clear() {
    this.positions.fill(0); this.uvs.fill(0);
    this.holeCursor = this.holeCount = this.scorchCursor = this.scorchCount = 0;
    this.dirty = true;
    this.update();
  }

  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.texture.dispose(); this.mesh.removeFromParent(); }
}
