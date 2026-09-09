import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
const map = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('scripts/blender/export_map.ts', root))], { cwd: fileURLToPath(root), encoding: 'utf8' }));
const receipt = JSON.parse(readFileSync(new URL('art/source/town-export.json', root)));
assert.equal(receipt.sha256, createHash('sha256').update(bytes).digest('hex'), 'Asset receipt matches the exact export');
assert.equal(receipt.mapSha256, createHash('sha256').update(readFileSync(new URL('shared/map.ts', root))).digest('hex'), 'Blender geometry was exported from the current map');
for (const group of ['Environment', 'CollisionReferences']) assert.ok(world.has(group));
assert.equal(gltf.animations?.length ?? 0, 0); assert.equal(gltf.cameras?.length ?? 0, 0);
assert.ok(!gltf.extensions?.KHR_lights_punctual);
assert.ok(bytes.length <= 7_000_000, 'Keep the environment within the phone download budget');
assert.equal(gltf.nodes.filter(n => n.name?.startsWith('Collision_')).length, map.obstacles.length);
for (const o of map.obstacles) {
  const node = gltf.nodes.find(n => n.name === `Collision_${o.id}`); assert.ok(node, o.id);
  assert.ok(new Vector3().setFromMatrixPosition(world.get(node.name)).distanceTo(new Vector3(o.x,o.y,o.z)) < 1e-5);
  assert.deepEqual(node.extras.sizeXYZ, [o.w,o.h,o.d]);
}
const triangles = []; let primitives = 0, vertices = 0;
for (const [index, node] of gltf.nodes.entries()) {
  if (node.mesh === undefined) continue;
  for (const p of gltf.meshes[node.mesh].primitives) {
    primitives++;
    for (const attribute of ['POSITION','NORMAL','TEXCOORD_0','COLOR_0']) assert.notEqual(p.attributes[attribute], undefined, `${node.name}: ${attribute}`);
    const positions = accessor(p.attributes.POSITION).map(v => new Vector3().fromArray(v).applyMatrix4(nodeWorld.get(index)));
    const colors = accessor(p.attributes.COLOR_0), uv = accessor(p.attributes.TEXCOORD_0), normals = accessor(p.attributes.NORMAL);
    assert.equal(colors.length, positions.length); assert.equal(uv.length, positions.length); assert.equal(normals.length, positions.length);
    assert.ok([...uv,...normals,...colors].every(v => v.every(Number.isFinite))); vertices += positions.length;
    assert.ok(positions.every(p => [p.x,p.y,p.z].every(Number.isFinite)));
    const indices = accessor(p.indices).flat(); assert.equal(indices.length % 3, 0);
    for (let i=0;i<indices.length;i+=3) triangles.push(indices.slice(i,i+3).map(j=>positions[j]));
  }
}
assert.ok(primitives <= 18, 'Keep batches bounded for phones'); assert.ok(triangles.length <= 70_000);
assert.equal(triangles.length, receipt.triangles);
for (const image of gltf.images) {
  assert.equal(image.uri, undefined, 'Textures are embedded');
  const view = gltf.bufferViews[image.bufferView]; assert.ok(view.byteLength > 100 && view.byteOffset + view.byteLength <= binary.length);
  assert.ok(['image/png','image/jpeg'].includes(image.mimeType));
}
const ray = new Ray(), hit = new Vector3();
function intersections(origin, direction, limit) {
  ray.set(new Vector3().fromArray(origin), new Vector3().fromArray(direction)); const distances = [];
  for (const [a,b,c] of triangles) if (ray.intersectTriangle(a,b,c,false,hit)) {
    const distance = hit.distanceTo(ray.origin); if (distance <= limit) distances.push(distance);
  }
  return distances;
}
// Verify actual triangles at all six faces. Empties alone cannot prove collision fidelity.
let faces = 0;
for (const o of map.obstacles) for (let axis=0;axis<3;axis++) for (const sign of [-1,1]) {
  const origin=[o.x,o.y,o.z], size=[o.w,o.h,o.d], direction=[0,0,0];
  origin[axis]+=sign*(size[axis]/2+.04); direction[axis]=-sign;
  assert.ok(intersections(origin,direction,.081).some(d=>Math.abs(d-.04)<.0001), `Missing rendered face: ${o.id} axis ${axis} sign ${sign}`); faces++;
}
const openings=[];
for (const side of [-1,1]) for (const [x,y,z,direction,label] of [
  [side*8.5,1.35,-2.25,[-side,0,0],'front door'],
  [side*8.5,4.8,0,[-side,0,0],'upstairs window'],
  [side*8.5,1.35,9.75,[-side,0,0],'garage door'],
  [side*23.5,4.6,4.2,[-side,0,0],'balcony door'],
]) {
  // Front entries point outward-to-inward; the rear entry is mirrored.
  const dir = label === 'balcony door' ? direction : [side,0,0];
  assert.equal(intersections([x,y,z],dir,2.4).length,0,`Rendered ${label} must stay open`); openings.push(`${side}:${label}`);
}
assert.equal(intersections([2.65,1.5,11],[0,0,-1],3).length,0,'Cargo opening must be a playable hole');
const report={map:map.name,bytes:bytes.length,sha256:receipt.sha256,triangles:triangles.length,vertices,primitives,embeddedTextures:gltf.images.length,collisionReferences:map.obstacles.length,renderedCollisionFaces:faces,openings,stairRoutes:map.stairs.length,status:'passed'};
writeFileSync(new URL('art/source/town-export-review.json',root),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));