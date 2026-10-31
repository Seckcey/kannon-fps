import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { WeaponId } from '../../../shared/protocol';
import type { WeaponPalette } from './materials';

/** Procedural stand-ins that follow the weapons GLB contract exactly: a root per model, anchor
 * empties `grip_r`, `grip_l`, `muzzle`, `sight`, `eject`, moving parts `mag` and `action`, metres,
 * forward -Z and up +Y. Arms have their origin on the palm grip point with the forearm toward +Z.
 * Original designs; they stand in until the Blender models arrive and fill any node they omit. */
export type Detail = 'view' | 'world';
type V3 = readonly [number, number, number];
type V2 = readonly [number, number];
interface PartOptions { rotation?: V3; radius?: number; segments?: number }

const EXTRUDE_BASIS = new THREE.Matrix4().set(0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1);

/** Collects primitives per material and merges them into one mesh per material. */
export class Parts {
  private readonly batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private readonly matrix = new THREE.Matrix4();
  private readonly rotation = new THREE.Matrix4();
  private readonly euler = new THREE.Euler();
  constructor(readonly detail: Detail) {}

  private push(material: THREE.Material, geometry: THREE.BufferGeometry, position: V3, rotation?: V3): this {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    if (flat !== geometry) geometry.dispose();
    this.matrix.identity();
    if (rotation) this.matrix.makeRotationFromEuler(this.euler.set(rotation[0], rotation[1], rotation[2], 'YXZ'));
    this.matrix.setPosition(position[0], position[1], position[2]);
    flat.applyMatrix4(this.matrix);
    for (const name of Object.keys(flat.attributes)) if (!['position', 'normal', 'uv'].includes(name)) flat.deleteAttribute(name);
    const list = this.batches.get(material) ?? [];
    list.push(flat); this.batches.set(material, list);
    return this;
  }
  private bevel(radius: number, segments?: number): number {
    if (segments !== undefined) return segments;
    if (this.detail === 'world') return radius >= 0.006 ? 1 : 0;
    return radius >= 0.0035 ? 2 : radius > 0 ? 1 : 0;
  }
  private radial(base = 20) { return this.detail === 'world' ? Math.max(6, Math.round(base / 2)) : base; }

  box(material: THREE.Material, size: V3, position: V3, options: PartOptions = {}): this {
    const radius = options.radius ?? 0;
    const segments = this.bevel(radius, options.segments);
    const geometry = segments > 0 && radius > 0 ? new RoundedBoxGeometry(size[0], size[1], size[2], segments, radius) : new THREE.BoxGeometry(size[0], size[1], size[2]);
    return this.push(material, geometry, position, options.rotation);
  }
  /** Cylinder along an axis; `front` is the radius at -Z (axis 'z'), +X ('x') or +Y ('y'). */
  cylinder(material: THREE.Material, front: number, back: number, length: number, position: V3, axis: 'x' | 'y' | 'z', options: PartOptions & { radialSegments?: number; open?: boolean } = {}): this {
    const geometry = new THREE.CylinderGeometry(front, back, length, options.radialSegments ?? this.radial(), 1, options.open ?? false);
    if (axis === 'z') geometry.rotateX(-Math.PI / 2); else if (axis === 'x') geometry.rotateZ(-Math.PI / 2);
    return this.push(material, geometry, position, options.rotation);
  }
  sphere(material: THREE.Material, radius: number, position: V3, options: PartOptions & { scale?: V3 } = {}): this {
    const geometry = new THREE.SphereGeometry(radius, this.radial(16), Math.max(4, this.radial(12)));
    if (options.scale) geometry.scale(options.scale[0], options.scale[1], options.scale[2]);
    return this.push(material, geometry, position, options.rotation);
  }
  /** Rounded rod between two points. */
  capsule(material: THREE.Material, radius: number, from: V3, to: V3): this {
    const start = new THREE.Vector3(...from), end = new THREE.Vector3(...to);
    const axis = end.clone().sub(start), length = axis.length();
    const geometry = new THREE.CapsuleGeometry(radius, Math.max(1e-4, length), this.detail === 'world' ? 2 : 4, this.radial(12));
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize()));
    const middle = start.add(end).multiplyScalar(0.5);
    return this.push(material, geometry, [middle.x, middle.y, middle.z]);
  }
  torus(material: THREE.Material, radius: number, tube: number, position: V3, axis: 'x' | 'y' | 'z', options: PartOptions = {}): this {
    const geometry = new THREE.TorusGeometry(radius, tube, this.detail === 'world' ? 4 : 8, this.radial(24));
    if (axis === 'x') geometry.rotateY(Math.PI / 2); else if (axis === 'y') geometry.rotateX(Math.PI / 2);
    return this.push(material, geometry, position, options.rotation);
  }
  /** Surface of revolution about +Y from [radius, height] points. */
  lathe(material: THREE.Material, points: readonly V2[], position: V3, options: PartOptions = {}): this {
    const geometry = new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), this.radial(20));
    return this.push(material, geometry, position, options.rotation);
  }
  /** Flat disc facing +Z (or -Z), for lenses, bores and sight dots. */
  disc(material: THREE.Material, radius: number, position: V3, facing: '+z' | '-z' = '+z'): this {
    const geometry = new THREE.CircleGeometry(radius, this.radial(16));
    if (facing === '-z') geometry.rotateY(Math.PI);
    return this.push(material, geometry, position);
  }
  /** Side profile given as [z, y] points (rounded by `corner`), extruded `thickness` across X. */
  extrude(material: THREE.Material, outline: readonly V2[], thickness: number, position: V3, options: PartOptions & { corner?: number; bevel?: number } = {}): this {
    const bevel = Math.min(options.bevel ?? 0.002, thickness * 0.3);
    const shape = roundedShape(outline, options.corner ?? 0.004, this.detail === 'world' ? 1 : 4);
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: Math.max(1e-4, thickness - 2 * bevel), bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.8,
      bevelSegments: this.detail === 'world' ? 1 : 2, curveSegments: this.detail === 'world' ? 2 : 5,
    });
    geometry.translate(0, 0, -(thickness - 2 * bevel) / 2);
    geometry.applyMatrix4(EXTRUDE_BASIS);
    return this.push(material, geometry, position, options.rotation);
  }

  /** Merge everything into one mesh per material under `parent`. */
  build(parent: THREE.Object3D, name: string, uvDensity = 12): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    for (const [material, list] of this.batches) {
      const merged = list.length === 1 ? list[0]! : mergeGeometries(list, false);
      if (!merged) continue;
      if (merged !== list[0]) for (const geometry of list) geometry.dispose();
      boxProjectUvs(merged, uvDensity);
      merged.computeBoundingSphere(); merged.computeBoundingBox();
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = `${name}_${material.name || 'part'}`;
      parent.add(mesh); meshes.push(mesh);
    }
    this.batches.clear();
    return meshes;
  }
}

function roundedShape(points: readonly V2[], radius: number, segments: number): THREE.Shape {
  const shape = new THREE.Shape();
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [px, py] = points[(i + n - 1) % n]!, [cx, cy] = points[i]!, [nx, ny] = points[(i + 1) % n]!;
    const inLength = Math.hypot(cx - px, cy - py), outLength = Math.hypot(nx - cx, ny - cy);
    const r = Math.min(radius, inLength * 0.45, outLength * 0.45);
    const ax = cx + (px - cx) / inLength * r, ay = cy + (py - cy) / inLength * r;
    const bx = cx + (nx - cx) / outLength * r, by = cy + (ny - cy) / outLength * r;
    if (i === 0) shape.moveTo(ax, ay); else shape.lineTo(ax, ay);
    if (r > 0 && segments > 0) shape.quadraticCurveTo(cx, cy, bx, by); else shape.lineTo(bx, by);
  }
  shape.closePath();
  return shape;
}

/** Even texel density on every part: project UVs from the dominant normal axis. */
function boxProjectUvs(geometry: THREE.BufferGeometry, density: number): void {
  const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal');
  if (!position || !normal) return;
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    const ax = Math.abs(normal.getX(i)), ay = Math.abs(normal.getY(i)), az = Math.abs(normal.getZ(i));
    const [u, v] = ax >= ay && ax >= az ? [z, y] : ay >= az ? [x, z] : [x, y];
    uv[i * 2] = u * density; uv[i * 2 + 1] = v * density;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

function anchor(parent: THREE.Object3D, name: string, position: V3): THREE.Object3D {
  const node = new THREE.Object3D(); node.name = name; node.position.set(position[0], position[1], position[2]); parent.add(node); return node;
}
function group(parent: THREE.Object3D, name: string, position: V3, rotation?: V3): THREE.Group {
  const node = new THREE.Group(); node.name = name; node.position.set(position[0], position[1], position[2]);
  if (rotation) node.rotation.set(rotation[0], rotation[1], rotation[2]);
  parent.add(node); return node;
}

/** A pistol grip profile centred on the palm point, leaning back about 18 degrees. */
const GRIP: readonly V2[] = [[-0.024, 0.046], [0.012, 0.046], [0.03, 0.03], [0.039, -0.04], [0.04, -0.07], [0.012, -0.079], [0.0, -0.072], [-0.022, 0.004]];
function pistolGrip(parts: Parts, material: THREE.Material, top = 0.046, thickness = 0.027): void {
  parts.extrude(material, GRIP.map(([z, y]) => [z, y === 0.046 ? top : y] as const), thickness, [0, 0, 0], { corner: 0.008, bevel: 0.003 });
}
function triggerGroup(parts: Parts, p: WeaponPalette, y: number, front: number, back = -0.004): void {
  const length = back - front;
  parts.box(p.anodized, [0.01, 0.005, length], [0, y, front + length / 2], { radius: 0.002 });
  parts.box(p.anodized, [0.01, 0.026, 0.006], [0, y + 0.012, front], { radius: 0.002 });
  parts.box(p.steel, [0.005, 0.02, 0.006], [0, y + 0.016, front + length * 0.45], { rotation: [0.32, 0, 0], radius: 0.002 });
}
function rail(parts: Parts, material: THREE.Material, y: number, from: number, to: number, width = 0.021): void {
  const length = to - from;
  parts.box(material, [width, 0.008, length], [0, y, from + length / 2], { radius: 0.0015 });
  if (parts.detail === 'world') return;
  for (let z = from + 0.004; z < to - 0.003; z += 0.0105) parts.box(material, [width + 0.003, 0.004, 0.0045], [0, y + 0.005, z], { radius: 0.001, segments: 0 });
}

function carbine(p: WeaponPalette, detail: Detail): THREE.Group {
  const root = new THREE.Group(); root.name = 'weapon_kr5';
  const parts = new Parts(detail);
  const bore = 0.093;
  parts.box(p.anodized, [0.032, 0.042, 0.25], [0, 0.096, -0.055], { radius: 0.004 });
  parts.box(p.anodized, [0.03, 0.034, 0.17], [0, 0.058, -0.05], { radius: 0.003 });
  parts.box(p.anodized, [0.034, 0.05, 0.072], [0, 0.03, -0.098], { radius: 0.003 });
  parts.box(p.anodized, [0.037, 0.008, 0.078], [0, 0.008, -0.098], { radius: 0.002 });
  parts.box(p.polymer, [0.002, 0.014, 0.05], [0.0162, 0.1, -0.06]);
  parts.box(p.polymer, [0.0015, 0.006, 0.08], [-0.0162, 0.105, -0.11]);
  triggerGroup(parts, p, 0.02, -0.06);
  pistolGrip(parts, p.tan);
  // Free-float handguard with vent slots.
  parts.box(p.tan, [0.046, 0.05, 0.27], [0, 0.094, -0.315], { radius: 0.009 });
  for (let i = 0; i < 4; i++) for (const side of [-1, 1]) parts.box(p.polymer, [0.002, 0.012, 0.036], [side * 0.0232, 0.098, -0.215 - i * 0.06], { radius: 0.001, segments: 0 });
  for (let i = 0; i < 3; i++) parts.box(p.polymer, [0.014, 0.002, 0.04], [0, 0.0688, -0.24 - i * 0.07], { segments: 0 });
  rail(parts, p.anodized, 0.122, -0.19, -0.035);
  parts.box(p.anodized, [0.021, 0.006, 0.11], [0, 0.121, 0.02], { radius: 0.002 });
  parts.box(p.tan, [0.024, 0.006, 0.24], [0, 0.1205, -0.315], { radius: 0.0025 });
  parts.cylinder(p.steel, 0.0085, 0.0085, 0.1, [0, bore, -0.5], 'z');
  parts.box(p.anodized, [0.022, 0.024, 0.02], [0, bore + 0.002, -0.462], { radius: 0.002 });
  parts.cylinder(p.anodized, 0.0125, 0.0125, 0.055, [0, bore, -0.5775], 'z');
  for (let i = 0; i < 3; i++) parts.box(p.polymer, [0.02, 0.004, 0.006], [0, bore + 0.011, -0.562 - i * 0.012], { segments: 0 });
  parts.disc(p.polymer, 0.0055, [0, bore, -0.6052], '-z');
  // Buffer tube and skeleton stock.
  parts.cylinder(p.anodized, 0.0155, 0.0155, 0.14, [0, 0.089, 0.14], 'z');
  parts.extrude(p.polymer, [[0.08, 0.112], [0.235, 0.116], [0.252, 0.1], [0.252, -0.028], [0.232, -0.034], [0.195, 0.022], [0.11, 0.066], [0.08, 0.075]], 0.036, [0, 0, 0], { corner: 0.01, bevel: 0.004 });
  parts.box(p.rubber, [0.04, 0.152, 0.016], [0, 0.044, 0.258], { radius: 0.005 });
  // Reflex sight: hood around a square window, glass, and a red dot on the optical axis.
  const sightY = 0.162;
  parts.box(p.anodized, [0.03, 0.01, 0.055], [0, 0.134, -0.075], { radius: 0.002 });
  parts.box(p.anodized, [0.005, 0.034, 0.045], [-0.0155, sightY, -0.0755], { radius: 0.0015 });
  parts.box(p.anodized, [0.005, 0.034, 0.045], [0.0155, sightY, -0.0755], { radius: 0.0015 });
  parts.box(p.anodized, [0.036, 0.005, 0.045], [0, sightY + 0.0145, -0.0755], { radius: 0.0015 });
  parts.box(p.anodized, [0.036, 0.011, 0.045], [0, 0.1445, -0.0755], { radius: 0.0015 });
  parts.cylinder(p.anodized, 0.004, 0.004, 0.006, [0.021, 0.153, -0.082], 'x');
  parts.box(p.glass, [0.026, 0.024, 0.0015], [0, sightY, -0.094]);
  parts.disc(p.reticle, 0.0009, [0, sightY, -0.0925]);
  parts.build(root, 'kr5');
  // Curved magazine, pivoting at the top of the magazine well.
  const mag = group(root, 'mag', [0, 0.05, -0.098]);
  const magParts = new Parts(detail);
  magParts.extrude(p.polymer, [[-0.029, 0.0], [0.029, 0.0], [0.027, -0.06], [0.017, -0.12], [0.002, -0.176], [-0.054, -0.168], [-0.043, -0.11], [-0.034, -0.055]], 0.023, [0, 0, 0], { corner: 0.006, bevel: 0.002 });
  for (let i = 0; i < 3; i++) magParts.box(p.polymer, [0.0245, 0.004, 0.05], [0, -0.07 - i * 0.03, -0.012 - i * 0.008], { rotation: [-0.12 - i * 0.07, 0, 0], radius: 0.0015, segments: 1 });
  magParts.box(p.anodized, [0.027, 0.01, 0.066], [0, -0.177, -0.026], { rotation: [-0.26, 0, 0], radius: 0.0025 });
  magParts.build(mag, 'kr5_mag');
  // Side charging handle on the left of the upper receiver.
  const action = group(root, 'action', [-0.017, 0.105, -0.145]);
  const actionParts = new Parts(detail);
  actionParts.box(p.anodized, [0.013, 0.011, 0.02], [-0.006, 0, 0], { radius: 0.003 });
  actionParts.build(action, 'kr5_action');
  anchor(root, 'grip_r', [0, 0, 0]);
  anchor(root, 'grip_l', [-0.024, 0.074, -0.335]);
  anchor(root, 'muzzle', [0, bore, -0.606]);
  anchor(root, 'sight', [0, sightY, -0.053]);
  anchor(root, 'eject', [0.018, 0.1, -0.06]);
  return root;
}

function smg(p: WeaponPalette, detail: Detail): THREE.Group {
  const root = new THREE.Group(); root.name = 'weapon_hornet9';
  const parts = new Parts(detail);
  const bore = 0.07, sightY = 0.128;
  parts.box(p.polymer, [0.04, 0.062, 0.29], [0, 0.075, -0.075], { radius: 0.007 });
  parts.box(p.anodized, [0.034, 0.016, 0.21], [0, 0.098, -0.09], { radius: 0.004 });
  parts.box(p.anodized, [0.02, 0.006, 0.2], [0, 0.109, -0.07], { radius: 0.002 });
  // Aperture rear sight and hooded front post share the sight line.
  parts.torus(p.anodized, 0.0065, 0.0022, [0, sightY, 0.026], 'z');
  parts.box(p.anodized, [0.016, 0.012, 0.008], [0, 0.1165, 0.026], { radius: 0.002 });
  for (const side of [-1, 1]) parts.box(p.anodized, [0.004, 0.022, 0.01], [side * 0.0115, 0.123, 0.026], { radius: 0.0015 });
  parts.torus(p.anodized, 0.0088, 0.0018, [0, sightY - 0.002, -0.2], 'z');
  parts.box(p.anodized, [0.0026, 0.012, 0.003], [0, sightY - 0.006, -0.2]);
  parts.box(p.anodized, [0.018, 0.01, 0.014], [0, 0.113, -0.2], { radius: 0.002 });
  parts.cylinder(p.anodized, 0.0135, 0.0135, 0.07, [0, bore, -0.255], 'z');
  parts.cylinder(p.steel, 0.0105, 0.0105, 0.02, [0, bore, -0.3], 'z');
  parts.disc(p.polymer, 0.0048, [0, bore, -0.3102], '-z');
  parts.box(p.polymer, [0.032, 0.03, 0.042], [0, 0.03, -0.075], { radius: 0.004 });
  parts.extrude(p.polymer, [[-0.198, 0.046], [-0.15, 0.046], [-0.156, 0.012], [-0.172, -0.012], [-0.19, -0.008], [-0.198, 0.02]], 0.03, [0, 0, 0], { corner: 0.006, bevel: 0.003 });
  parts.box(p.anodized, [0.002, 0.015, 0.04], [0.0201, 0.088, -0.06]);
  parts.box(p.polymer, [0.0015, 0.005, 0.07], [-0.0202, 0.098, -0.14]);
  triggerGroup(parts, p, 0.02, -0.052);
  pistolGrip(parts, p.polymer);
  // Folding wire stock.
  for (const side of [-1, 1]) {
    parts.box(p.anodized, [0.006, 0.007, 0.2], [side * 0.014, 0.068, 0.17], { radius: 0.002 });
    parts.box(p.anodized, [0.006, 0.007, 0.2], [side * 0.014, 0.022, 0.172], { rotation: [0.12, 0, 0], radius: 0.002 });
  }
  parts.cylinder(p.anodized, 0.007, 0.007, 0.038, [0, 0.07, 0.072], 'x');
  parts.box(p.rubber, [0.04, 0.086, 0.012], [0, 0.04, 0.272], { radius: 0.004 });
  parts.build(root, 'hornet9');
  const mag = group(root, 'mag', [0, 0.04, -0.075]);
  const magParts = new Parts(detail);
  magParts.box(p.steel, [0.023, 0.18, 0.032], [0, -0.085, 0], { rotation: [0.04, 0, 0], radius: 0.003 });
  magParts.box(p.polymer, [0.027, 0.01, 0.036], [0, -0.178, 0.003], { radius: 0.0025 });
  magParts.build(mag, 'hornet9_mag');
  const action = group(root, 'action', [-0.021, 0.098, -0.165]);
  const actionParts = new Parts(detail);
  actionParts.box(p.anodized, [0.014, 0.01, 0.016], [-0.006, 0, 0], { radius: 0.003 });
  actionParts.build(action, 'hornet9_action');
  anchor(root, 'grip_r', [0, 0, 0]);
  anchor(root, 'grip_l', [-0.023, 0.05, -0.17]);
  anchor(root, 'muzzle', [0, bore, -0.311]);
  anchor(root, 'sight', [0, sightY, 0.031]);
  anchor(root, 'eject', [0.021, 0.088, -0.06]);
  return root;
}

function pumpShotgun(p: WeaponPalette, detail: Detail): THREE.Group {
  const root = new THREE.Group(); root.name = 'weapon_breaker12';
  const parts = new Parts(detail);
  const bore = 0.1, sightY = 0.12;
  parts.box(p.anodized, [0.036, 0.07, 0.18], [0, 0.083, -0.04], { radius: 0.005 });
  parts.box(p.anodized, [0.01, 0.004, 0.18], [0, 0.12, -0.04], { radius: 0.0015 });
  parts.cylinder(p.steel, 0.0115, 0.0115, 0.47, [0, bore, -0.365], 'z');
  parts.box(p.steel, [0.008, 0.004, 0.46], [0, 0.1135, -0.37], { radius: 0.001 });
  if (detail === 'view') for (let z = -0.16; z > -0.6; z -= 0.05) parts.box(p.steel, [0.004, 0.003, 0.004], [0, 0.1105, z], { segments: 0 });
  parts.sphere(p.sightDot, 0.0024, [0, sightY - 0.0025, -0.59]);
  parts.disc(p.polymer, 0.0085, [0, bore, -0.6002], '-z');
  parts.box(p.anodized, [0.03, 0.052, 0.014], [0, 0.086, -0.54], { radius: 0.003 });
  parts.cylinder(p.anodized, 0.0125, 0.0125, 0.02, [0, 0.072, -0.57], 'z');
  parts.box(p.polymer, [0.02, 0.002, 0.07], [0, 0.0475, -0.075]);
  parts.box(p.polymer, [0.002, 0.024, 0.06], [0.0182, 0.092, -0.07]);
  triggerGroup(parts, p, 0.02, -0.06);
  pistolGrip(parts, p.polymer);
  parts.extrude(p.wood, [[0.05, 0.078], [0.3, 0.058], [0.312, 0.048], [0.312, -0.078], [0.292, -0.084], [0.08, 0.012], [0.05, 0.022]], 0.038, [0, 0, 0], { corner: 0.012, bevel: 0.005 });
  parts.box(p.rubber, [0.042, 0.138, 0.018], [0, -0.014, 0.321], { rotation: [-0.05, 0, 0], radius: 0.006 });
  parts.build(root, 'breaker12');
  // The magazine tube is the contract's `mag`; shotgun reloads feed shells into it one at a time.
  const mag = group(root, 'mag', [0, 0.072, -0.13]);
  const magParts = new Parts(detail);
  magParts.cylinder(p.steel, 0.0105, 0.0105, 0.43, [0, 0, -0.215], 'z');
  magParts.build(mag, 'breaker12_mag');
  // Walnut pump with grooves; it slides back along the tube.
  const action = group(root, 'action', [0, 0.072, -0.29]);
  const actionParts = new Parts(detail);
  actionParts.box(p.wood, [0.046, 0.044, 0.17], [0, 0.003, 0], { radius: 0.013 });
  for (let i = -3; i <= 3; i++) actionParts.box(p.polymer, [0.0472, 0.0452, 0.004], [0, 0.003, i * 0.02], { radius: 0.013, segments: detail === 'world' ? 1 : 2 });
  for (const side of [-1, 1]) actionParts.box(p.steel, [0.003, 0.004, 0.16], [side * 0.016, -0.004, 0.09]);
  actionParts.build(action, 'breaker12_action');
  anchor(root, 'grip_r', [0, 0, 0]);
  anchor(root, 'grip_l', [-0.024, 0.06, -0.29]);
  anchor(root, 'muzzle', [0, bore, -0.602]);
  anchor(root, 'sight', [0, sightY, 0.045]);
  anchor(root, 'eject', [0.019, 0.092, -0.07]);
  anchor(root, 'load', [0, 0.045, -0.075]);
  return root;
}

function boltRifle(p: WeaponPalette, detail: Detail): THREE.Group {
  const root = new THREE.Group(); root.name = 'weapon_longbow';
  const parts = new Parts(detail);
  const bore = 0.083, scopeY = 0.14;
  parts.box(p.olive, [0.052, 0.05, 0.38], [0, 0.062, -0.33], { radius: 0.012 });
  parts.box(p.olive, [0.05, 0.045, 0.2], [0, 0.06, -0.04], { radius: 0.009 });
  pistolGrip(parts, p.olive, 0.05, 0.03);
  parts.extrude(p.olive, [[0.05, 0.095], [0.2, 0.1], [0.352, 0.098], [0.372, 0.085], [0.372, -0.06], [0.35, -0.066], [0.16, -0.012], [0.08, 0.0], [0.05, 0.03]], 0.042, [0, 0, 0], { corner: 0.014, bevel: 0.005 });
  parts.box(p.olive, [0.03, 0.018, 0.13], [0, 0.102, 0.245], { radius: 0.007 });
  parts.box(p.rubber, [0.046, 0.16, 0.02], [0, 0.017, 0.382], { radius: 0.006 });
  parts.cylinder(p.anodized, 0.0165, 0.0165, 0.2, [0, bore, -0.04], 'z');
  parts.box(p.anodized, [0.02, 0.008, 0.2], [0, 0.103, -0.04], { radius: 0.0015 });
  parts.cylinder(p.steel, 0.0095, 0.0125, 0.62, [0, bore, -0.45], 'z');
  parts.box(p.anodized, [0.026, 0.024, 0.06], [0, bore, -0.79], { radius: 0.004 });
  for (const z of [-0.774, -0.792, -0.81]) parts.box(p.polymer, [0.0275, 0.008, 0.007], [0, bore, z], { segments: 0 });
  parts.disc(p.polymer, 0.006, [0, bore, -0.8202], '-z');
  parts.box(p.anodized, [0.034, 0.012, 0.08], [0, 0.035, -0.05], { radius: 0.002 });
  triggerGroup(parts, p, 0.017, -0.055);
  // Scope: tube, bells, turrets, rings and dark lenses.
  parts.cylinder(p.anodized, 0.0135, 0.0135, 0.25, [0, scopeY, -0.06], 'z');
  parts.cylinder(p.anodized, 0.024, 0.0135, 0.04, [0, scopeY, -0.205], 'z');
  parts.cylinder(p.anodized, 0.024, 0.024, 0.05, [0, scopeY, -0.25], 'z');
  parts.disc(p.lens, 0.021, [0, scopeY, -0.2752], '-z');
  parts.cylinder(p.anodized, 0.0135, 0.019, 0.03, [0, scopeY, 0.08], 'z');
  parts.cylinder(p.rubber, 0.0195, 0.0195, 0.03, [0, scopeY, 0.11], 'z');
  parts.disc(p.lens, 0.016, [0, scopeY, 0.1252]);
  parts.cylinder(p.anodized, 0.011, 0.011, 0.022, [0, scopeY + 0.022, -0.04], 'y');
  parts.cylinder(p.anodized, 0.011, 0.011, 0.022, [0.022, scopeY, -0.04], 'x');
  for (const z of [-0.13, 0.02]) parts.box(p.anodized, [0.032, 0.038, 0.014], [0, 0.123, z], { radius: 0.004 });
  parts.build(root, 'longbow');
  const mag = group(root, 'mag', [0, 0.045, -0.05]);
  const magParts = new Parts(detail);
  magParts.box(p.anodized, [0.03, 0.06, 0.075], [0, -0.022, 0], { radius: 0.003 });
  magParts.box(p.polymer, [0.032, 0.008, 0.078], [0, -0.054, 0], { radius: 0.002 });
  magParts.build(mag, 'longbow_mag');
  // Bolt: rotates about the bore axis to unlock, then slides back.
  const action = group(root, 'action', [0, bore, 0.035]);
  const actionParts = new Parts(detail);
  actionParts.cylinder(p.steel, 0.0085, 0.0085, 0.12, [0, 0, -0.06], 'z');
  actionParts.cylinder(p.steel, 0.012, 0.012, 0.035, [0, 0, 0.012], 'z');
  actionParts.capsule(p.steel, 0.0035, [0.008, 0, 0.004], [0.048, -0.018, 0.01]);
  actionParts.sphere(p.polymer, 0.0095, [0.052, -0.02, 0.012]);
  actionParts.build(action, 'longbow_action');
  anchor(action, 'knob', [0.052, -0.02, 0.012]);
  anchor(root, 'grip_r', [0, 0, 0]);
  anchor(root, 'grip_l', [-0.028, 0.044, -0.33]);
  anchor(root, 'muzzle', [0, bore, -0.822]);
  anchor(root, 'sight', [0, scopeY, 0.125]);
  anchor(root, 'eject', [0.018, 0.092, -0.02]);
  return root;
}

function pistol(p: WeaponPalette, detail: Detail): THREE.Group {
  const root = new THREE.Group(); root.name = 'weapon_sentry9';
  const parts = new Parts(detail);
  const bore = 0.062, sightY = 0.09;
  parts.box(p.tan, [0.024, 0.024, 0.15], [0, 0.042, -0.085], { radius: 0.004 });
  parts.box(p.tan, [0.02, 0.006, 0.05], [0, 0.0275, -0.13], { radius: 0.0015 });
  parts.extrude(p.tan, [[-0.0334, 0.042], [0.0066, 0.042], [0.022, 0.05], [0.026, 0.034], [0.0416, -0.066], [0.0016, -0.07], [-0.008, -0.06]], 0.028, [0, 0, 0], { corner: 0.006, bevel: 0.003 });
  parts.box(p.tan, [0.01, 0.005, 0.05], [0, 0.008, -0.045], { radius: 0.002 });
  parts.box(p.tan, [0.01, 0.024, 0.006], [0, 0.02, -0.07], { radius: 0.002 });
  parts.box(p.polymer, [0.006, 0.018, 0.006], [0, 0.022, -0.036], { rotation: [0.2, 0, 0], radius: 0.002 });
  parts.build(root, 'sentry9');
  // The magazine sits in the grip and drops out along the grip's lean.
  const mag = group(root, 'mag', [0, 0.04, -0.0134], [-0.314, 0, 0]);
  const magParts = new Parts(detail);
  magParts.box(p.steel, [0.019, 0.105, 0.028], [0, -0.055, 0], { radius: 0.002 });
  magParts.box(p.polymer, [0.024, 0.008, 0.034], [0, -0.112, 0], { radius: 0.002 });
  magParts.build(mag, 'sentry9_mag');
  // Slide with serrations, three-dot sights and the barrel crown.
  const action = group(root, 'action', [0, 0.068, -0.07]);
  const slide = new Parts(detail);
  slide.box(p.anodized, [0.026, 0.03, 0.19], [0, 0, 0], { radius: 0.004 });
  if (detail === 'view') for (let i = 0; i < 5; i++) slide.box(p.polymer, [0.0265, 0.02, 0.0018], [0, -0.001, 0.08 + i * 0.0035], { segments: 0 });
  slide.box(p.polymer, [0.002, 0.012, 0.03], [0.0131, 0.007, 0.02]);
  for (const side of [-1, 1]) {
    slide.box(p.anodized, [0.007, 0.007, 0.008], [side * 0.0055, 0.0185, 0.085]);
    slide.disc(p.sightDot, 0.0011, [side * 0.0055, 0.0185, 0.0892]);
  }
  slide.box(p.anodized, [0.0035, 0.007, 0.006], [0, 0.0185, -0.085]);
  slide.disc(p.sightDot, 0.0011, [0, 0.019, -0.0818]);
  slide.disc(p.polymer, 0.0048, [0, bore - 0.068, -0.0952], '-z');
  slide.build(action, 'sentry9_slide');
  anchor(root, 'grip_r', [0, 0, 0]);
  anchor(root, 'grip_l', [-0.021, -0.014, -0.004]);
  anchor(root, 'muzzle', [0, bore, -0.168]);
  anchor(root, 'sight', [0, sightY, 0.019]);
  anchor(root, 'eject', [0.014, 0.075, -0.05]);
  return root;
}

export function buildWeaponStandIn(id: WeaponId, palette: WeaponPalette, detail: Detail): THREE.Group {
  switch (id) {
    case 'kr5': return carbine(palette, detail);
    case 'hornet9': return smg(palette, detail);
    case 'breaker12': return pumpShotgun(palette, detail);
    case 'longbow': return boltRifle(palette, detail);
    case 'sentry9': return pistol(palette, detail);
  }
}

/** Fixed-blade knife: origin in the fist, blade toward -Z, edge down. */
export function buildKnifeStandIn(p: WeaponPalette, detail: Detail): THREE.Group {
  const root = new THREE.Group(); root.name = 'knife';
  const parts = new Parts(detail);
  parts.box(p.polymer, [0.022, 0.028, 0.11], [0, 0, 0], { radius: 0.007 });
  for (const z of [-0.03, -0.01, 0.01, 0.03]) parts.box(p.rubber, [0.0236, 0.0296, 0.006], [0, 0, z], { radius: 0.007 });
  parts.box(p.steel, [0.024, 0.03, 0.012], [0, 0, 0.061], { radius: 0.004 });
  parts.box(p.steel, [0.026, 0.05, 0.007], [0, -0.003, -0.0585], { radius: 0.002 });
  parts.extrude(p.blade, [[-0.062, 0.012], [-0.19, 0.012], [-0.236, 0.002], [-0.2, -0.012], [-0.062, -0.016]], 0.005, [0, 0, 0], { corner: 0.002, bevel: 0.0016 });
  parts.build(root, 'knife');
  return root;
}

/** Frag grenade: origin at the body centre. */
export function buildFragStandIn(p: WeaponPalette, detail: Detail): THREE.Group {
  const root = new THREE.Group(); root.name = 'frag';
  const parts = new Parts(detail);
  parts.lathe(p.olive, [[0, -0.036], [0.016, -0.034], [0.026, -0.026], [0.03, -0.012], [0.03, 0.006], [0.026, 0.022], [0.016, 0.032], [0.009, 0.036], [0, 0.036]], [0, 0, 0]);
  parts.torus(p.polymer, 0.0302, 0.0016, [0, 0, 0], 'y');
  parts.cylinder(p.steel, 0.0095, 0.0095, 0.018, [0, 0.044, 0], 'y');
  parts.cylinder(p.anodized, 0.007, 0.007, 0.006, [0, 0.055, 0], 'y');
  parts.box(p.steel, [0.012, 0.004, 0.03], [0, 0.052, 0.016], { radius: 0.0012 });
  parts.box(p.steel, [0.012, 0.05, 0.004], [0, 0.03, 0.033], { rotation: [-0.25, 0, 0], radius: 0.0012 });
  parts.torus(p.steel, 0.0105, 0.0016, [-0.016, 0.046, 0], 'x');
  parts.build(root, 'frag');
  return root;
}

/** Gloved hand and sleeved forearm. The right hand wraps a pistol grip; the left holds a handguard
 * from the side (thumb over the top). The `forearm` child pivots at the wrist so it can point at the
 * elbow while the hand stays on the grip; `hold` is where held items sit. */
export function buildArmStandIn(side: 'left' | 'right', p: WeaponPalette, detail: Detail): THREE.Group {
  const root = new THREE.Group(); root.name = side === 'left' ? 'arm_left' : 'arm_right';
  const hand = new Parts(detail);
  const wrist: V3 = side === 'right' ? [0.02, -0.006, 0.07] : [-0.016, -0.012, 0.072];
  if (side === 'right') {
    // Fist around a pistol grip that leans back ~18 degrees: palm and knuckles on the right,
    // fingers curling round the front, thumb over the top left.
    const lean: V3 = [-0.31, 0, 0];
    const tilt = Math.tan(0.31);
    hand.box(p.glove, [0.026, 0.086, 0.078], [0.024, -0.002, 0.012], { rotation: lean, radius: 0.012 });
    hand.box(p.knuckle, [0.01, 0.074, 0.02], [0.039, 0.0, -0.018], { rotation: lean, radius: 0.004 });
    for (let i = 0; i < 4; i++) {
      const y = 0.029 - i * 0.019, z = -y * tilt, r = 0.0095 - i * 0.0004;
      hand.capsule(p.glove, r, [0.03, y, -0.022 + z], [0.008, y, -0.034 + z]);
      hand.capsule(p.glove, r * 0.95, [0.008, y, -0.034 + z], [-0.015, y - 0.002, -0.02 + z]);
    }
    hand.capsule(p.glove, 0.0098, [0.016, 0.04, 0.03], [-0.016, 0.051, -0.006]);
    hand.box(p.glove, [0.056, 0.058, 0.05], [wrist[0], wrist[1], wrist[2] - 0.012], { radius: 0.02 });
  } else {
    // Side grip on a handguard: palm on its left face, fingers wrapping underneath, thumb over the top.
    hand.box(p.glove, [0.024, 0.078, 0.084], [-0.013, -0.004, 0.01], { rotation: [0.05, 0, 0], radius: 0.012 });
    hand.box(p.knuckle, [0.01, 0.02, 0.07], [-0.024, -0.03, -0.018], { radius: 0.004 });
    for (let i = 0; i < 4; i++) {
      const z = -0.05 + i * 0.0185, r = 0.009 - i * 0.0004;
      hand.capsule(p.glove, r, [-0.008, -0.024, z], [0.018, -0.031, z - 0.002]);
      hand.capsule(p.glove, r * 0.95, [0.018, -0.031, z - 0.002], [0.043, -0.016, z - 0.004]);
    }
    hand.capsule(p.glove, 0.0092, [-0.01, 0.026, 0.026], [0.008, 0.046, -0.03]);
    hand.box(p.glove, [0.054, 0.056, 0.05], [wrist[0], wrist[1], wrist[2] - 0.012], { radius: 0.02 });
  }
  hand.build(root, `${root.name}_hand`);
  const forearm = group(root, 'forearm', wrist);
  const sleeve = new Parts(detail);
  sleeve.cylinder(p.glove, 0.031, 0.033, 0.03, [0, 0, 0.012], 'z');
  sleeve.cylinder(p.knuckle, 0.0335, 0.0335, 0.008, [0, 0, 0.03], 'z');
  // Long enough that the sleeve always leaves the screen; only the forearm is modelled.
  sleeve.cylinder(p.sleeve, 0.037, 0.047, 0.5, [0, 0, 0.285], 'z', { radialSegments: 18 });
  sleeve.cylinder(p.sleeve, 0.041, 0.041, 0.035, [0, 0, 0.055], 'z', { radialSegments: 18 });
  sleeve.build(forearm, `${root.name}_sleeve`);
  anchor(root, 'hold', side === 'left' ? [0.02, -0.006, -0.02] : [0.004, 0, -0.004]);
  return root;
}

/** Spent casing for the ejection effect, origin at its centre, long axis along X. */
export function buildCasingGeometry(kind: 'rifle' | 'pistol' | 'hull'): THREE.BufferGeometry {
  const length = kind === 'hull' ? 0.068 : kind === 'rifle' ? 0.045 : 0.019;
  const radius = kind === 'hull' ? 0.0105 : kind === 'rifle' ? 0.0048 : 0.0049;
  const geometry = new THREE.CylinderGeometry(radius * (kind === 'rifle' ? 0.75 : 1), radius, length, 10, 1);
  geometry.rotateZ(-Math.PI / 2);
  return geometry;
}
