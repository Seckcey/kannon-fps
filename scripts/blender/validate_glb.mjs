import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Matrix4, Quaternion, Vector3 } from 'three';

const path = fileURLToPath(new URL('../../public/models/scout.glb', import.meta.url));
const bytes = readFileSync(path);
assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'Valid binary glTF magic');
assert.equal(bytes.readUInt32LE(4), 2);
assert.equal(bytes.readUInt32LE(8), bytes.length);
const jsonLength = bytes.readUInt32LE(12);
const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
const names = gltf.nodes.map(node => node.name);
for (const name of ['ScoutRig', 'scout_body', 'weapon_ar', 'weapon_shotgun', 'healing_item', 'muzzle', 'chest']) assert.ok(names.includes(name), `${name} attachment exists`);
const expected = ['Idle', 'Walk', 'Run', 'Jump', 'Aim', 'Fire', 'Reload', 'Heal'];
assert.deepEqual(new Set(gltf.animations.map(animation => animation.name)), new Set(expected));
assert.equal(gltf.skins.length, 1);
assert.equal(gltf.skins[0].joints.length, 18);
let vertices = 0; let triangles = 0;
for (const mesh of gltf.meshes) {
  for (const primitive of mesh.primitives) {
    vertices += gltf.accessors[primitive.attributes.POSITION].count;
    triangles += gltf.accessors[primitive.indices].count / 3;
    assert.ok(primitive.attributes.JOINTS_0 !== undefined && primitive.attributes.WEIGHTS_0 !== undefined, 'Every gameplay mesh is skinned.');
  }
}
assert.ok(vertices <= 30_000, `Phone geometry budget: ${vertices} vertices`);
assert.ok(bytes.length <= 5_000_000, 'Packed character asset remains under 5 MB.');
for (const image of gltf.images) assert.ok(image.bufferView !== undefined && !image.uri, 'Textures are embedded and require no third-party host.');
const world = new Map();
function visit(index, parent = new Matrix4()) {
  const node = gltf.nodes[index];
  const local = node.matrix ? new Matrix4().fromArray(node.matrix) : new Matrix4().compose(new Vector3().fromArray(node.translation ?? [0, 0, 0]), new Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]), new Vector3().fromArray(node.scale ?? [1, 1, 1]));
  const matrix = new Matrix4().multiplyMatrices(parent, local); world.set(node.name, matrix);
  for (const child of node.children ?? []) visit(child, matrix);
}
for (const index of gltf.scenes[gltf.scene ?? 0].nodes) visit(index);
const muzzle = new Vector3().setFromMatrixPosition(world.get('muzzle'));
assert.ok(Math.abs(muzzle.x - .135) < .01 && Math.abs(muzzle.y - 1.332) < .01 && Math.abs(muzzle.z + .847) < .01, 'Muzzle sits at the forward gun barrel after Blender-to-glTF axis conversion.');
const report = { file: 'public/models/scout.glb', bytes: bytes.length, exportedVertices: vertices, triangles, bones: 18, clips: expected, embeddedTextures: gltf.images.length, muzzle: muzzle.toArray(), coordinateSystem: 'metres; Y up; -Z forward', status: 'passed' };
writeFileSync(fileURLToPath(new URL('../../art/source/scout-export-review.json', import.meta.url)), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
