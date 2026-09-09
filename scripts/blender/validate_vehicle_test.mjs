/** Validate protected town extraction and new vehicle geometry in game space. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { accessor, hash, readGlb, splitBaseline } from './split_vehicle_baseline.mjs';

const root = new URL('../../', import.meta.url);
const extraction = splitBaseline(true);
const map = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('scripts/blender/export_map.ts', root))], { cwd: fileURLToPath(root), encoding: 'utf8' }));
const ids = { bus: ['school-bus-body', 'school-bus-hood'], south: ['south-car', 'south-car-cabin'], north: ['north-car', 'north-car-cabin'] };
// 30 micrometres allows float32 coordinate storage, not artistic protrusions.
const epsilon = 0.00003;
const bounds = Object.fromEntries(Object.entries(ids).map(([id, names]) => [id, names.map(name => {
  const o = map.obstacles.find(v => v.id === name); assert.ok(o);
  return { id: name, min: [o.x - o.w / 2, o.y - o.h / 2, o.z - o.d / 2], max: [o.x + o.w / 2, o.y + o.h / 2, o.z + o.d / 2] };
})]));
const source = readGlb(new URL('public/models/vehicles-improved.glb', root));
const { gltf } = source;
assert.equal(gltf.animations?.length ?? 0, 0);
assert.equal(gltf.cameras?.length ?? 0, 0);
assert.ok(!gltf.extensions?.KHR_lights_punctual);
assert.ok(source.bytes.length < 7_000_000, 'Three replacement vehicles must fit a 7 MB local-test budget');

function lerp(a, b, t) { return a.map((v, i) => v + (b[i] - v) * t); }
function clip(polygon, distance, retainInside) {
  const result = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const da = distance(a), db = distance(b);
    const aInside = retainInside ? da <= 0 : da > 0;
    const bInside = retainInside ? db <= 0 : db > 0;
    if (aInside) result.push(a);
    if (aInside !== bInside) result.push(lerp(a, b, da / (da - db)));
  }
  return result;
}
function subtractBox(polygon, box) {
  // Partition the triangle by the six planes. Fragments outside any plane are
  // retained. The portion inside all six planes is covered by this collider.
  let inside = polygon; const outside = [];
  for (let axis = 0; axis < 3 && inside.length; axis++) for (const lower of [true, false]) {
    const distance = lower ? p => box.min[axis] - epsilon - p[axis] : p => p[axis] - box.max[axis] - epsilon;
    const piece = clip(inside, distance, false); if (piece.length >= 3) outside.push(piece);
    inside = clip(inside, distance, true);
  }
  return outside;
}
function area(polygon) {
  if (polygon.length < 3) return 0;
  const a = new Vector3().fromArray(polygon[0]); let total = 0;
  for (let i = 1; i + 1 < polygon.length; i++) total += new Vector3().fromArray(polygon[i]).sub(a)
    .cross(new Vector3().fromArray(polygon[i + 1]).sub(a)).length() / 2;
  return total;
}
function uncoveredArea(triangle, boxes) {
  let pieces = [triangle];
  for (const box of boxes) pieces = pieces.flatMap(piece => subtractBox(piece, box));
  return pieces.reduce((total, piece) => total + area(piece), 0);
}
function contained(point, boxes) { return boxes.some(b => point.every((v, a) => v >= b.min[a] - epsilon && v <= b.max[a] + epsilon)); }

const groups = Object.fromEntries(Object.keys(ids).map(id => [id, { vertices: 0, triangles: 0, primitives: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], materialIds: new Set(), outsideVertices: 0, crossingTriangles: 0 }]));
const violations = []; const nodeNames = new Set();
function visit(index, parentMatrix = new Matrix4(), owner) {
  const node = gltf.nodes[index]; assert.ok(node); nodeNames.add(node.name);
  const match = /^Vehicle_(bus|south|north)$/.exec(node.name ?? '');
  if (match) owner = match[1];
  const local = node.matrix ? new Matrix4().fromArray(node.matrix) : new Matrix4().compose(new Vector3().fromArray(node.translation ?? [0, 0, 0]), new Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]), new Vector3().fromArray(node.scale ?? [1, 1, 1]));
  const matrix = new Matrix4().multiplyMatrices(parentMatrix, local);
  if (node.mesh !== undefined) {
    assert.ok(owner, `${node.name}: every rendered mesh must belong to exactly one target vehicle`);
    const group = groups[owner];
    for (const p of gltf.meshes[node.mesh].primitives) {
      assert.equal(p.mode ?? 4, 4);
      assert.ok(p.attributes.POSITION !== undefined && p.attributes.NORMAL !== undefined);
      const a = accessor(source, p.attributes.POSITION), normal = accessor(source, p.attributes.NORMAL);
      assert.equal(a.count, normal.count);
      const positions = Array.from({ length: a.count }, (_, i) => new Vector3().fromArray(a.values(i)).applyMatrix4(matrix).toArray());
      for (const point of positions) {
        assert.ok(point.every(Number.isFinite));
        point.forEach((v, axis) => { group.min[axis] = Math.min(group.min[axis], v); group.max[axis] = Math.max(group.max[axis], v); });
        if (!contained(point, bounds[owner])) {
          group.outsideVertices++;
          if (violations.length < 12) violations.push({ vehicle: owner, mesh: node.name, point });
        }
      }
      for (let i = 0; i < normal.count; i++) assert.ok(normal.values(i).every(Number.isFinite));
      const indexAccessor = p.indices === undefined ? undefined : accessor(source, p.indices);
      const indices = indexAccessor ? Array.from({ length: indexAccessor.count }, (_, i) => indexAccessor.values(i)[0]) : positions.map((_, i) => i);
      assert.equal(indices.length % 3, 0);
      for (let i = 0; i < indices.length; i += 3) {
        const triangle = indices.slice(i, i + 3).map(v => { assert.ok(v >= 0 && v < positions.length); return positions[v]; });
        if (uncoveredArea(triangle, bounds[owner]) > 1e-9) {
          group.crossingTriangles++;
          if (violations.length < 12) violations.push({ vehicle: owner, mesh: node.name, triangle: i / 3, points: triangle });
        }
      }
      group.vertices += positions.length; group.triangles += indices.length / 3; group.primitives++; group.materialIds.add(p.material);
    }
  }
  for (const child of node.children ?? []) visit(child, matrix, owner);
}
for (const node of gltf.scenes[gltf.scene ?? 0].nodes) visit(node);
for (const id of Object.keys(ids)) {
  assert.ok(nodeNames.has(`Vehicle_${id}`)); assert.ok(groups[id].triangles > 0);
}
const images = (gltf.images ?? []).map(image => {
  assert.ok(image.uri === undefined && image.bufferView !== undefined, 'Replacement textures must be embedded for reproducible download measurement');
  const v = gltf.bufferViews[image.bufferView];
  return { name: image.name, mimeType: image.mimeType, bytes: v.byteLength, sha256: hash(source.binary.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)) };
});
const report = { status: violations.length ? 'failed' : 'passed', baselineExtraction: extraction,
  source: 'public/models/vehicles-improved.glb', bytes: source.bytes.length, sha256: hash(source.bytes),
  mapSha256: hash(readFileSync(new URL('shared/map.ts', root))), toleranceMetres: epsilon,
  method: 'Every world-space vertex and full triangle polygon is checked against the union of the two original collision boxes. Triangle subtraction detects faces bridging outside a concave union even when all vertices are inside.',
  protected: ['cargo truck', 'all other town triangles', 'all original collision references', 'shared/map.ts', 'generate_town.py', 'environment.glb'],
  vehicles: Object.fromEntries(Object.entries(groups).map(([id, g]) => [id, { ...g, materialIds: [...g.materialIds], collisionBoxes: bounds[id] }])),
  materials: (gltf.materials ?? []).map((m, id) => ({ id, name: m.name, roughness: m.pbrMetallicRoughness?.roughnessFactor ?? 1, metalness: m.pbrMetallicRoughness?.metallicFactor ?? 1, extensions: Object.keys(m.extensions ?? {}) })),
  images, violations };
if (!process.argv.includes('--no-write')) writeFileSync(new URL('art/source/vehicle-test-validation.json', root), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, bytes: report.bytes, vehicles: report.vehicles, violations }, null, 2));
assert.equal(violations.length, 0, 'Improved geometry must remain inside the original vehicle collision union');
