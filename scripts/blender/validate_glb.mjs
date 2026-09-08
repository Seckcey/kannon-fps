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
for (const name of ['ScoutRig', 'scout_body', 'weapon_ar', 'weapon_shotgun', 'healing_item', 'muzzle', 'muzzle_shotgun', 'chest']) assert.ok(names.includes(name), `${name} attachment exists`);
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
const primitives = Object.fromEntries(['scout_body', 'weapon_ar', 'weapon_shotgun', 'healing_item'].map(name => {
  const node = gltf.nodes.find(item => item.name === name);
  return [name, gltf.meshes[node.mesh].primitives.length];
}));
assert.ok(primitives.scout_body <= 4, 'Body uses at most four material draws.');
assert.ok(primitives.weapon_ar <= 3 && primitives.weapon_shotgun <= 3, 'Weapons use at most three material draws.');
for (const mesh of gltf.meshes) for (const primitive of mesh.primitives) {
  assert.ok(primitive.attributes.TEXCOORD_0 !== undefined, 'Every mesh has the shared atlas UV channel.');
  assert.equal(primitive.attributes.TEXCOORD_1, undefined, 'Joined meshes must not split their atlas into an unused UV channel.');
}
const surface = gltf.materials.find(material => material.name === 'ScoutSurface');
assert.ok(surface?.pbrMetallicRoughness.metallicRoughnessTexture && surface.normalTexture, 'The shared surface has real roughness/metalness and normal maps.');
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
assert.ok(Math.abs(muzzle.x - .135) < .01 && Math.abs(muzzle.y - 1.457) < .01 && Math.abs(muzzle.z + .847) < .01, 'Shouldered muzzle sits at the forward gun barrel after Blender-to-glTF axis conversion.');
const shotgunMuzzle = new Vector3().setFromMatrixPosition(world.get('muzzle_shotgun'));
assert.ok(shotgunMuzzle.distanceTo(new Vector3(.135, 1.457, -.924)) < .01, 'Shotgun effects use the longer shotgun barrel.');
const supportHand = new Vector3().setFromMatrixPosition(world.get('hand_l'));
assert.ok(supportHand.distanceTo(new Vector3(.135, 1.425, -.51)) < .09, 'Support wrist reaches the raised fore-end grip.');
const triggerHand = new Vector3().setFromMatrixPosition(world.get('hand_r'));
assert.ok(triggerHand.distanceTo(new Vector3(.135, 1.38, -.327)) < .04, 'Trigger wrist reaches the raised pistol grip.');
// Runtime makes these clips additive relative to their own first frame. If that
// frame differs from Idle, part of the authored action disappears during blending.
const binStart = 20 + jsonLength + 8;
function firstTransform(animation, node, property) {
  const channel = animation.channels.find(item => item.target.node === node && item.target.path === property);
  assert.ok(channel, `${animation.name} includes ${gltf.nodes[node].name}.${property}`);
  const accessor = gltf.accessors[animation.samplers[channel.sampler].output];
  assert.equal(accessor.componentType, 5126, 'Animation transforms are float32.');
  const view = gltf.bufferViews[accessor.bufferView];
  const start = binStart + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return Array.from({ length: property === 'rotation' ? 4 : 3 }, (_, index) => bytes.readFloatLE(start + index * 4));
}
const neutralPose = gltf.animations.find(animation => animation.name === 'Idle');
const additiveNeutralFrames = [];
for (const name of ['Fire', 'Reload', 'Heal']) {
  const animation = gltf.animations.find(item => item.name === name);
  let maxRotationError = 0; let maxTranslationError = 0;
  for (const [index, node] of gltf.nodes.entries()) {
    if (!/^(chest|neck|head|upper_arm_[lr]|forearm_[lr]|hand_[lr])$/.test(node.name)) continue;
    maxRotationError = Math.max(maxRotationError, new Quaternion().fromArray(firstTransform(animation, index, 'rotation')).angleTo(new Quaternion().fromArray(firstTransform(neutralPose, index, 'rotation'))));
    maxTranslationError = Math.max(maxTranslationError, new Vector3().fromArray(firstTransform(animation, index, 'translation')).distanceTo(new Vector3().fromArray(firstTransform(neutralPose, index, 'translation'))));
  }
  assert.ok(maxRotationError < .002 && maxTranslationError < .0001, `${name} starts from the same upper-body pose as Idle for additive playback.`);
  additiveNeutralFrames.push({ clip: name, maxRotationErrorRadians: maxRotationError, maxTranslationError });
}
const report = { file: 'public/models/scout.glb', bytes: bytes.length, exportedVertices: vertices, triangles, bones: 18, clips: expected, embeddedTextures: gltf.images.length, materialDraws: primitives, eightPlayerBodyAndARDraws: (primitives.scout_body + primitives.weapon_ar) * 8, muzzle: muzzle.toArray(), shotgunMuzzle: shotgunMuzzle.toArray(), additiveNeutralFrames, coordinateSystem: 'metres; Y up; -Z forward', status: 'passed' };
writeFileSync(fileURLToPath(new URL('../../art/source/scout-export-review.json', import.meta.url)), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
// Structural validity alone can hide between-frame floor penetration. Inspect
// the exported skinned locomotion through the production animation interpolator.
await import('./validate_locomotion.mjs');
