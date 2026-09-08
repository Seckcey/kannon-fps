import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Matrix4, Quaternion, Ray, Vector3 } from 'three';

const root = new URL('../../', import.meta.url);
const bytes = readFileSync(new URL('public/models/environment.glb', root));
assert.equal(bytes.readUInt32LE(0), 0x46546c67);
assert.equal(bytes.readUInt32LE(4), 2);
assert.equal(bytes.readUInt32LE(8), bytes.length);
const jsonLength = bytes.readUInt32LE(12);
const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
const binary = bytes.subarray(28 + jsonLength);
const componentBytes = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };
const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
function accessor(index) {
  const a = gltf.accessors[index]; const view = gltf.bufferViews[a.bufferView];
  const width = components[a.type]; const size = componentBytes[a.componentType];
  const offset = (view.byteOffset ?? 0) + (a.byteOffset ?? 0); const stride = view.byteStride ?? width * size;
  assert.ok(width && size && offset + (a.count - 1) * stride + width * size <= binary.length);
  const read = a.componentType === 5126 ? 'readFloatLE' : a.componentType === 5125 ? 'readUInt32LE' : a.componentType === 5123 ? 'readUInt16LE' : 'readUInt8';
  return Array.from({ length: a.count }, (_, i) => Array.from({ length: width }, (_, c) => binary[read](offset + i * stride + c * size)));
}

const world = new Map(); const nodeWorld = new Map();
function visit(index, parent = new Matrix4()) {
  const node = gltf.nodes[index];
  const local = node.matrix ? new Matrix4().fromArray(node.matrix) : new Matrix4().compose(new Vector3().fromArray(node.translation ?? [0, 0, 0]), new Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]), new Vector3().fromArray(node.scale ?? [1, 1, 1]));
  const matrix = new Matrix4().multiplyMatrices(parent, local); world.set(node.name, matrix); nodeWorld.set(index, matrix);
  for (const child of node.children ?? []) visit(child, matrix);
}
for (const node of gltf.scenes[gltf.scene ?? 0].nodes) visit(node);
for (const group of ['Environment', 'ArenaCore', 'ArenaTrim', 'Exterior', 'Foliage', 'Horizon', 'CollisionReferences']) assert.ok(world.has(group), `Named integration group ${group}`);
assert.equal(gltf.animations?.length ?? 0, 0, 'Environment is static');
assert.equal(gltf.cameras?.length ?? 0, 0, 'Preview cameras are not exported');
assert.ok(!gltf.extensions?.KHR_lights_punctual, 'Preview lights are not exported');
assert.ok(!gltf.nodes.some(node => node.name.includes('PreviewWater')), 'Water remains the runtime shader');

const mapSource = readFileSync(new URL('shared/map.ts', root), 'utf8');
const obstacles = Array.from(mapSource.matchAll(/\{ id: '([^']+)', x: ([-\d.]+), y: ([-\d.]+), z: ([-\d.]+), w: ([-\d.]+), h: ([-\d.]+), d: ([-\d.]+), color: '[^']+', kind: '([^']+)'/g)).map(match => ({ id: match[1], x: +match[2], y: +match[3], z: +match[4], w: +match[5], h: +match[6], d: +match[7], kind: match[8] }));
assert.equal(obstacles.length, 17);
for (const obstacle of obstacles) {
  const name = `Collision_${obstacle.id}`;
  const node = gltf.nodes.find(node => node.name === name); assert.ok(node, `${name} reference exists`);
  const position = new Vector3().setFromMatrixPosition(world.get(name));
  assert.ok(position.distanceTo(new Vector3(obstacle.x, obstacle.y, obstacle.z)) < 1e-5, `${name} world transform matches the live map`);
  assert.deepEqual(node.extras.sizeXYZ, [obstacle.w, obstacle.h, obstacle.d]);
}

const coreTriangles = []; const opaqueTriangles = []; let vertices = 0; let triangles = 0; let primitives = 0;
const batches = [];
function inGameplaySolid(point) {
  const tolerance = .041;
  if (Math.abs(point.x) <= 32 + 1e-5 && Math.abs(point.z) <= 32 + 1e-5 && point.y >= -.651 && point.y <= .041) return true;
  return obstacles.some(o => Math.abs(point.x - o.x) <= o.w / 2 + tolerance && Math.abs(point.y - o.y) <= o.h / 2 + tolerance && Math.abs(point.z - o.z) <= o.d / 2 + tolerance);
}
for (const [nodeIndex, node] of gltf.nodes.entries()) {
  if (node.mesh === undefined) continue;
  for (const primitive of gltf.meshes[node.mesh].primitives) {
    assert.ok(primitive.attributes.NORMAL !== undefined && primitive.attributes.TEXCOORD_0 !== undefined && primitive.attributes.COLOR_0 !== undefined);
    const positions = accessor(primitive.attributes.POSITION).map(position => new Vector3().fromArray(position).applyMatrix4(nodeWorld.get(nodeIndex)));
    const indices = accessor(primitive.indices).flat();
    vertices += positions.length; triangles += indices.length / 3; primitives++;
    const core = node.name.startsWith('ArenaCore_') || node.name.startsWith('ArenaTrim_');
    for (const point of positions) {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z));
      if (core) assert.ok(inGameplaySolid(point), `Decorative vertex must not invent gameplay cover: ${node.name} ${point.toArray()}`);
    }
    for (const normal of accessor(primitive.attributes.NORMAL)) assert.ok(Math.abs(Math.hypot(...normal) - 1) < .002, 'Unit exported normals');
    const opaque = !['EnvLeaves', 'EnvFlower'].includes(gltf.materials[primitive.material].name);
    if (core || opaque) for (let i = 0; i < indices.length; i += 3) {
      const triangle = [positions[indices[i]], positions[indices[i + 1]], positions[indices[i + 2]]];
      if (core) coreTriangles.push(triangle);
      if (opaque) opaqueTriangles.push(triangle);
    }
    batches.push({ name: node.name, triangles: indices.length / 3, vertices: positions.length });
  }
}
assert.ok(triangles <= 70_000, `Desktop environment budget: ${triangles} triangles`);
assert.ok(vertices <= 140_000, `Bounded indexed environment budget: ${vertices} vertices`);
assert.ok(primitives <= 18, `Environment color batches: ${primitives}`);
assert.ok(bytes.length <= 7_000_000, `Packed environment budget: ${bytes.length} bytes`);

const hit = new Vector3();
function nearest(origin, direction, limit, frontFacesOnly = false, candidates = coreTriangles) {
  const ray = new Ray(origin, direction); let distance = Infinity;
  for (const [a, b, c] of candidates) if (ray.intersectTriangle(a, b, c, frontFacesOnly, hit)) { const d = origin.distanceTo(hit); if (d <= limit) distance = Math.min(distance, d); }
  return distance;
}
for (const obstacle of obstacles) {
  for (const axis of ['x', 'y', 'z']) for (const side of [-1, 1]) {
    const dimensions = { x: obstacle.w, y: obstacle.h, z: obstacle.d };
    const origin = new Vector3(obstacle.x, obstacle.y, obstacle.z); origin[axis] += side * (dimensions[axis] / 2 + .08);
    const direction = new Vector3(); direction[axis] = -side;
    assert.ok(nearest(origin, direction, .125, true) < .125, `Every solid face is closed with outward winding: ${obstacle.id}/${axis}/${side}`);
  }
}
for (const [name, origin, direction, distance] of [
  ['north gate', [0, 2, -12], [0, 0, -1], 11],
  ['central lane', [0, 1, -5], [0, 0, 1], 12],
  ['west flank', [-27, 1, -25], [0, 0, 1], 50],
  ['east flank', [27, 1, -25], [0, 0, 1], 50],
]) assert.equal(nearest(new Vector3(...origin), new Vector3(...direction), distance), Infinity, `${name} remains visually open`);

const leaf = gltf.materials.find(material => material.name === 'EnvLeaves');
assert.equal(leaf.alphaMode, 'MASK'); assert.equal(leaf.alphaCutoff, .5); assert.equal(leaf.doubleSided, true);
assert.ok(nearest(new Vector3(24, .08, 24), new Vector3(0, -1, 0), .1, true) < .1, 'Paving faces upward');
const exteriorProbes = [
  ['observatory shaft', [82, 29, -105], [-1, 0, 0], 5],
  ['observatory dome', [72, 65, -105], [0, -1, 0], 10],
  ['landmark cliff', [72, 2, -150], [0, 0, 1], 15],
  ['coastal facade', [-30, 2, -10], [-1, 0, 0], 8],
  ['olive trunk', [-35, 3, 24.5], [0, 0, -1], 3],
];
for (const [name, origin, direction, limit] of exteriorProbes) assert.ok(nearest(new Vector3(...origin), new Vector3(...direction), limit, true, opaqueTriangles) < limit, `${name} has visible outward-facing geometry`);
for (const material of gltf.materials) assert.equal(Boolean(material.doubleSided), ['EnvLeaves', 'EnvFlower'].includes(material.name), `${material.name} has the intended face-culling mode`);
for (const name of ['EnvLimestone', 'EnvGround', 'EnvPetrol']) {
  const material = gltf.materials.find(material => material.name === name);
  assert.ok(material.pbrMetallicRoughness.baseColorTexture && material.pbrMetallicRoughness.metallicRoughnessTexture && material.normalTexture, `${name} complete basecolor/normal/roughness maps`);
}
const images = gltf.images.map(image => {
  assert.ok(image.bufferView !== undefined && !image.uri, 'Embedded textures have no external dependency');
  const view = gltf.bufferViews[image.bufferView];
  return { name: image.name, mimeType: image.mimeType, bytes: view.byteLength };
});
const report = { status: 'passed', asset: 'public/models/environment.glb', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), triangles, exportedVertices: vertices, colorBatches: primitives, materials: gltf.materials.length, images, batches, colliderReferences: obstacles.length, surfaceChecks: obstacles.length * 6, outwardWindingChecks: obstacles.length * 6 + 1 + exteriorProbes.length, clearRouteChecks: 4, coordinateSystem: 'metres; Y up; floor y=0', mapSha256: createHash('sha256').update(mapSource).digest('hex') };
writeFileSync(new URL('art/source/environment-export-review.json', root), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
