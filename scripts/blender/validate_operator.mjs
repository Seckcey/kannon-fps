/** Validate the operator character GLB against its runtime contract (docs/OPERATOR_ART.md).
 *
 *  node scripts/blender/validate_operator.mjs [--glb public/models/operator-v1.glb]
 *    [--baseline public/models/scout.glb] [--allow-png] [--no-report]
 *
 *  Checks the container, rig names, clip list, weapon socket, budgets and embedded textures; proves
 *  the rig, the five unchanged clips and the Walk/Run hips and legs are the scout's (same rest pose,
 *  inverse binds and animation samples); then plays every clip through Three's AnimationMixer on
 *  the CPU and samples the actual skinned vertices. The body must fit the shared posture rules read
 *  from shared/physics.ts (POSTURE_HEIGHT, EYE_HEIGHT, hitboxes): nothing visible above the hit
 *  boxes, glasses near the camera height, the head inside the head box, the support hand on the
 *  weapon, nothing through the floor, the same foot phase as Walk/Run for CrouchWalk, and compact
 *  low poses. Writes art/source/operator-export-review.json. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnimationMixer, LoopOnce, LoopRepeat, Matrix4, Quaternion, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { tsImport } from 'tsx/esm/api';

/** The live shared rules, so the art is held to whatever the physics workstream ships. */
const { POSTURE_HEIGHT, EYE_HEIGHT, PLAYER_RADIUS, hitboxes } = await tsImport('../../shared/physics.ts', import.meta.url);

const argument = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const flag = name => process.argv.includes(`--${name}`);
const repo = new URL('../../', import.meta.url);
const file = path => isAbsolute(path) ? path : resolve(fileURLToPath(repo), path);
const glbPath = argument('glb', 'public/models/operator-v1.glb');
const baselinePath = argument('baseline', 'public/models/scout.glb');

/** The operator contract (plan: "Operator GLB (I -> C)"). */
export const BONES = ['root', 'pelvis', 'spine', 'chest', 'neck', 'head', 'upper_arm_l', 'forearm_l', 'hand_l',
  'upper_arm_r', 'forearm_r', 'hand_r', 'thigh_l', 'shin_l', 'foot_l', 'thigh_r', 'shin_r', 'foot_r'];
export const INHERITED_CLIPS = ['Idle', 'Walk', 'Run', 'Jump', 'Aim', 'Fire', 'Reload'];
export const AUTHORED_CLIPS = ['Crouch', 'CrouchWalk', 'Slide'];
/** Clips whose every sample equals the scout export. Walk and Run keep the scout's hips and legs
 *  (the CMU-derived motion) sample for sample; their upper body is re-posed upright over the
 *  hit boxes. */
export const UNCHANGED_CLIPS = ['Idle', 'Jump', 'Aim', 'Fire', 'Reload'];
export const UPRIGHT_GAITS = ['Walk', 'Run'];
export const LOWER_BODY = ['root', 'pelvis', 'thigh_l', 'shin_l', 'foot_l', 'thigh_r', 'shin_r', 'foot_r'];
/** Reference travel speeds (m/s) at playback rate 1 for the in-place loops. */
export const REFERENCE_SPEEDS = { Walk: 6.5, Run: 9, CrouchWalk: 2.6 };
/** Right palm on the pistol grip at rest, in glTF metres (Y up, -Z forward). */
export const SOCKET_REST = [0.14, 1.39, -0.336];
/** The shared posture each clip is drawn in. */
export const CLIP_POSTURE = { Idle: 'stand', Walk: 'stand', Run: 'stand', Jump: 'stand', Aim: 'stand', Fire: 'stand', Reload: 'stand', Crouch: 'crouch', CrouchWalk: 'crouch', Slide: 'slide' };
const LIMITS = { bytes: 4_000_000, triangles: 25_000, bodyDraws: 4 };
/** How closely the drawn body follows the shared posture rules (metres unless noted).
 *  - top: nothing visible may rise above the posture's hit boxes (sampling slack only). Walk and
 *    Run keep the scout's captured running bob, which lifts the hips 6 cm above Idle's at the top of
 *    each stride, so with an upright upper body the helmet may rise up to 6 cm over the stand box
 *    for that moment (the old forward lean hid the bob by carrying the whole head 30 cm ahead).
 *  - eye: the glasses may sit at most 3 cm above the camera height (a head must never show before
 *    its owner can see) and at most 6 cm below it (the slide keeps its helmet under its 1.0 m top,
 *    only 8 cm over the 0.92 m slide eye). Walk and Run are judged on their cycle average.
 *  - head: the skull centre stays inside the posture's head box in every clip, so a shot at the
 *    middle of a visible head always counts. Of the helmet and head gear, at least 85% is inside a
 *    hit box at every moment of the low clips, and in Walk/Run at least as much on average over the
 *    stride as in the inherited Idle (65%; its head leans 10 cm forward of the player's position).
 *  - support: the left hand keeps its rest grip on the weapon in every clip but Reload, with the
 *    elbow bent like Idle's, never locked straight.
 *  - coverage: share of all vertices inside the posture's hit boxes (1 cm slack). The low poses
 *    keep at least 70% on average over the clip and never less than two thirds at any moment
 *    (the static Crouch and Slide have one value). They spread the legs along the floor and hold
 *    the weapon out, so they cannot match Idle's 81%; the reviewed low poses kept only 53-58%.
 *  - reach: horizontal distance of any vertex from the player's position in the low poses, so boots
 *    cannot poke through a 0.28 m wall beside the collision radius.
 *  - phase: CrouchWalk's feet run in step with Walk and Run (fraction of a cycle), because the
 *    client fades between gait clips at one shared normalized phase. */
const FIT = {
  top: 0.005, gaitBob: 0.06, eyeAbove: 0.03, eyeBelow: 0.06, headGear: { low: 0.85, gait: 0.65 },
  support: { distance: 0.01, elbowDegrees: 160, exempt: ['Reload'] },
  coverage: { mean: 0.70, least: 2 / 3 }, boxSlack: 0.01, reach: PLAYER_RADIUS + 0.28, phase: 0.05,
};
/** The moving and low clips are held to the full posture fit. The static inherited clips get the
 *  top, floor, head-box and support checks, and Idle and Aim the eye check as well. */
const FITTED_CLIPS = ['Walk', 'Run', 'Crouch', 'CrouchWalk', 'Slide'];
assert.deepEqual([...UNCHANGED_CLIPS, ...UPRIGHT_GAITS].sort(), [...INHERITED_CLIPS].sort(), 'every inherited clip is either unchanged or an upright gait');

function parseGlb(bytes, label) {
  assert.ok(bytes.length >= 28, `${label}: too small to be a GLB`);
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, `${label}: binary glTF magic`);
  assert.equal(bytes.readUInt32LE(4), 2, `${label}: glTF version 2`);
  assert.equal(bytes.readUInt32LE(8), bytes.length, `${label}: header length matches the file`);
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, `${label}: first chunk is JSON`);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  const binHeader = 20 + jsonLength;
  assert.equal(bytes.readUInt32LE(binHeader + 4), 0x004e4942, `${label}: second chunk is BIN`);
  const binStart = binHeader + 8, binLength = bytes.readUInt32LE(binHeader);
  return { bytes, json, binStart, binLength };
}

function floats(asset, accessorIndex) {
  const accessor = asset.json.accessors[accessorIndex];
  assert.equal(accessor.componentType, 5126, 'animation and bind data are float32');
  assert.equal(accessor.sparse, undefined, 'no sparse accessors');
  const width = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[accessor.type];
  const view = asset.json.bufferViews[accessor.bufferView];
  const stride = view.byteStride ?? width * 4;
  const start = asset.binStart + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const out = new Float64Array(accessor.count * width);
  for (let i = 0; i < accessor.count; i++) for (let c = 0; c < width; c++) out[i * width + c] = asset.bytes.readFloatLE(start + i * stride + c * 4);
  return out;
}

function maxDifference(a, b) {
  if (a.length !== b.length) return Infinity;
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  return worst;
}

function worldMatrices(json) {
  const world = new Map(), parent = new Map();
  const visit = (index, above) => {
    const node = json.nodes[index];
    const local = node.matrix ? new Matrix4().fromArray(node.matrix) : new Matrix4().compose(
      new Vector3().fromArray(node.translation ?? [0, 0, 0]), new Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]), new Vector3().fromArray(node.scale ?? [1, 1, 1]));
    const matrix = new Matrix4().multiplyMatrices(above, local); world.set(node.name, matrix);
    for (const child of node.children ?? []) { parent.set(json.nodes[child].name, node.name); visit(child, matrix); }
  };
  for (const index of json.scenes[json.scene ?? 0].nodes) visit(index, new Matrix4());
  return { world, parent };
}

/** Texture pixels never affect skinning. Drop them so Node can parse KTX2 builds without a GPU. */
function withoutTextures(asset) {
  const json = structuredClone(asset.json);
  delete json.textures; delete json.images; delete json.samplers;
  for (const material of json.materials ?? []) {
    if (material.pbrMetallicRoughness) { delete material.pbrMetallicRoughness.baseColorTexture; delete material.pbrMetallicRoughness.metallicRoughnessTexture; }
    delete material.normalTexture; delete material.occlusionTexture; delete material.emissiveTexture;
  }
  for (const key of ['extensionsUsed', 'extensionsRequired']) {
    if (!json[key]) continue;
    json[key] = json[key].filter(name => name !== 'KHR_texture_basisu');
    if (!json[key].length) delete json[key];
  }
  let text = Buffer.from(JSON.stringify(json), 'utf8');
  text = Buffer.concat([text, Buffer.alloc((4 - text.length % 4) % 4, 0x20)]);
  const bin = asset.bytes.subarray(asset.binStart, asset.binStart + asset.binLength);
  const out = Buffer.alloc(12 + 8 + text.length + 8 + bin.length);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(text.length, 12); out.writeUInt32LE(0x4e4f534a, 16); text.copy(out, 20);
  out.writeUInt32LE(bin.length, 20 + text.length); out.writeUInt32LE(0x004e4942, 24 + text.length); bin.copy(out, 28 + text.length);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

const percentile = (values, fraction) => values.length ? values.slice().sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)] : null;

// ---------------------------------------------------------------------------------------------
// 1. Container, names and budgets.
const operator = parseGlb(readFileSync(file(glbPath)), glbPath);
const { json } = operator;
const names = json.nodes.map(node => node.name);
for (const bone of BONES) assert.equal(names.filter(name => name === bone).length, 1, `exactly one ${bone} bone node`);
assert.equal(json.skins?.length, 1, 'one skin shared by the whole character');
const joints = json.skins[0].joints.map(index => json.nodes[index].name);
assert.deepEqual([...joints].sort(), [...BONES].sort(), 'the skin uses exactly the 18 scout bones, unrenamed');
const clipNames = json.animations.map(animation => animation.name);
for (const clip of [...INHERITED_CLIPS, ...AUTHORED_CLIPS]) assert.ok(clipNames.includes(clip), `${clip} clip exists`);
assert.deepEqual(clipNames.filter(name => ![...INHERITED_CLIPS, ...AUTHORED_CLIPS].includes(name)), [], 'no clips outside the contract (Heal is retired)');

const meshNodes = json.nodes.filter(node => node.mesh !== undefined);
assert.deepEqual(meshNodes.map(node => node.name), ['scout_body'], 'one skinned body mesh and no weapon meshes');
for (const node of meshNodes) assert.equal(node.skin, 0, `${node.name} is skinned`);
for (const name of names) assert.ok(!/^(weapon_(ar|shotgun|kr5|hornet9|breaker12|longbow|sentry9)|healing_item|muzzle|knife|frag)/i.test(name), `${name}: weapons ship in weapons-v1.glb, not on the character`);

const socketIndex = names.indexOf('weapon_socket');
assert.ok(socketIndex >= 0, 'weapon_socket exists');
const socketNode = json.nodes[socketIndex];
assert.equal(socketNode.mesh, undefined, 'weapon_socket is an empty');
assert.equal(socketNode.children, undefined, 'weapon_socket has no children of its own');
const { world, parent } = worldMatrices(json);
assert.equal(parent.get('weapon_socket'), 'hand_r', 'weapon_socket is a child of hand_r');
const socketPosition = new Vector3(), socketRotation = new Quaternion(), socketScale = new Vector3();
world.get('weapon_socket').decompose(socketPosition, socketRotation, socketScale);
assert.ok(socketPosition.distanceTo(new Vector3(...SOCKET_REST)) < 0.02, `weapon_socket rests on the right palm grip: ${socketPosition.toArray()}`);
const socketAngle = socketRotation.angleTo(new Quaternion());
assert.ok(socketAngle < 0.02, `weapon_socket points forward (-Z) with +Y up at rest: ${socketAngle} rad`);
assert.ok(Math.abs(socketScale.x - 1) < 1e-4 && Math.abs(socketScale.y - 1) < 1e-4 && Math.abs(socketScale.z - 1) < 1e-4, 'weapon_socket is unscaled');
const handPosition = new Vector3().setFromMatrixPosition(world.get('hand_r'));
assert.ok(socketPosition.distanceTo(handPosition) < 0.09, 'weapon_socket sits in the right hand, not at the wrist of another bone');

const body = json.meshes[meshNodes[0].mesh];
let vertices = 0, triangles = 0;
const usedMaterials = new Set();
for (const primitive of body.primitives) {
  assert.ok(primitive.attributes.JOINTS_0 !== undefined && primitive.attributes.WEIGHTS_0 !== undefined, 'every primitive is skinned');
  assert.ok(primitive.attributes.TEXCOORD_0 !== undefined, 'every primitive has the atlas UV channel');
  assert.equal(primitive.attributes.TEXCOORD_1, undefined, 'no stray second UV channel');
  assert.equal(primitive.mode ?? 4, 4, 'triangles');
  vertices += json.accessors[primitive.attributes.POSITION].count;
  triangles += json.accessors[primitive.indices].count / 3;
  usedMaterials.add(json.materials[primitive.material].name);
}
assert.ok(body.primitives.length <= LIMITS.bodyDraws, `body uses at most ${LIMITS.bodyDraws} material draws: ${body.primitives.length}`);
assert.ok(triangles <= LIMITS.triangles, `triangle budget: ${triangles}`);
assert.ok(operator.bytes.length <= LIMITS.bytes, `size budget: ${operator.bytes.length} bytes`);
assert.ok(usedMaterials.has('PlayerAccent'), 'PlayerAccent carries the team or player colour');
assert.ok(usedMaterials.has('ScoutSurface'), 'ScoutSurface carries the packed gear atlas');
const surface = json.materials.find(material => material.name === 'ScoutSurface');
assert.ok(surface.pbrMetallicRoughness?.baseColorTexture && surface.pbrMetallicRoughness.metallicRoughnessTexture && surface.normalTexture, 'the gear atlas has colour, metal/roughness and normal maps');
const accent = json.materials.find(material => material.name === 'PlayerAccent');
assert.equal(accent.pbrMetallicRoughness?.baseColorTexture, undefined, 'PlayerAccent is a plain colour the game can replace');
for (const image of json.images ?? []) {
  assert.ok(image.bufferView !== undefined && !image.uri, 'textures are embedded');
  if (!flag('allow-png')) assert.equal(image.mimeType, 'image/ktx2', `${image.name} is KTX2-compressed`);
}

// 2. Same rig and the same seven clips as the scout export.
const baseline = parseGlb(readFileSync(file(baselinePath)), baselinePath);
const baselineIndex = new Map(baseline.json.nodes.map((node, index) => [node.name, index]));
let restDifference = 0;
for (const bone of BONES) {
  const a = operator.json.nodes[names.indexOf(bone)], b = baseline.json.nodes[baselineIndex.get(bone)];
  for (const [field, fallback] of [['translation', [0, 0, 0]], ['rotation', [0, 0, 0, 1]], ['scale', [1, 1, 1]]]) {
    restDifference = Math.max(restDifference, maxDifference(a[field] ?? fallback, b[field] ?? fallback));
  }
  const children = node => (node.children ?? []).map(child => (node === a ? operator : baseline).json.nodes[child].name).filter(name => BONES.includes(name)).sort();
  assert.deepEqual(children(a), children(b), `${bone} keeps the scout hierarchy`);
}
assert.ok(restDifference < 1e-5, `rest pose matches the scout rig: ${restDifference}`);
const inverseBinds = skinAsset => {
  const values = floats(skinAsset, skinAsset.json.skins[0].inverseBindMatrices);
  return new Map(skinAsset.json.skins[0].joints.map((joint, i) => [skinAsset.json.nodes[joint].name, values.subarray(i * 16, i * 16 + 16)]));
};
const operatorBinds = inverseBinds(operator), baselineBinds = inverseBinds(baseline);
const bindDifference = Math.max(...BONES.map(bone => maxDifference(operatorBinds.get(bone), baselineBinds.get(bone))));
assert.ok(bindDifference < 1e-5, `inverse bind matrices match the scout: ${bindDifference}`);

const inherited = [];
for (const clip of INHERITED_CLIPS) {
  const a = operator.json.animations.find(item => item.name === clip), b = baseline.json.animations.find(item => item.name === clip);
  assert.ok(b, `${baselinePath} has ${clip}`);
  let worst = 0, channels = 0, upperWorst = 0, upperChannels = 0;
  for (const channel of b.channels) {
    const node = baseline.json.nodes[channel.target.node].name;
    if (!BONES.includes(node)) continue;
    const other = a.channels.find(item => operator.json.nodes[item.target.node].name === node && item.target.path === channel.target.path);
    assert.ok(other, `${clip} keeps ${node}.${channel.target.path}`);
    const input = maxDifference(floats(operator, a.samplers[other.sampler].input), floats(baseline, b.samplers[channel.sampler].input));
    assert.ok(input < 1e-6, `${clip} ${node}.${channel.target.path} keeps the scout's sample times: ${input}`);
    const output = maxDifference(floats(operator, a.samplers[other.sampler].output), floats(baseline, b.samplers[channel.sampler].output));
    if (UPRIGHT_GAITS.includes(clip) && !LOWER_BODY.includes(node)) { upperWorst = Math.max(upperWorst, output); upperChannels++; continue; }
    worst = Math.max(worst, output); channels++;
  }
  const scope = UPRIGHT_GAITS.includes(clip) ? 'hip and leg' : 'all';
  assert.ok(worst < 1e-6, `${clip} ${scope} samples match the scout export: ${worst}`);
  if (UPRIGHT_GAITS.includes(clip)) assert.equal(channels, LOWER_BODY.length * 3, `${clip} compares every hip and leg channel`);
  inherited.push({ clip, identical: scope, channels, maxDifference: worst, ...(UPRIGHT_GAITS.includes(clip) ? { reposedUpperChannels: upperChannels, upperMaxDifference: upperWorst } : {}) });
}

// Runtime turns Fire/Reload into additive deltas from their first frame; it must equal Idle's.
const firstValue = (animation, nodeName, path) => {
  const channel = animation.channels.find(item => operator.json.nodes[item.target.node].name === nodeName && item.target.path === path);
  assert.ok(channel, `${animation.name} animates ${nodeName}.${path}`);
  return Array.from(floats(operator, animation.samplers[channel.sampler].output).subarray(0, path === 'rotation' ? 4 : 3));
};
const idle = operator.json.animations.find(item => item.name === 'Idle');
for (const clip of ['Fire', 'Reload']) {
  const animation = operator.json.animations.find(item => item.name === clip);
  let rotation = 0;
  for (const bone of ['chest', 'neck', 'head', 'upper_arm_l', 'forearm_l', 'hand_l', 'upper_arm_r', 'forearm_r', 'hand_r']) {
    rotation = Math.max(rotation, new Quaternion().fromArray(firstValue(animation, bone, 'rotation')).angleTo(new Quaternion().fromArray(firstValue(idle, bone, 'rotation'))));
  }
  assert.ok(rotation < 0.002, `${clip} starts from Idle's upper-body pose for additive playback`);
}

// 3. Play the clips through Three's mixer and sample the real skin.
const loader = new GLTFLoader();
const gltf = await loader.parseAsync(withoutTextures(operator), '');
const model = gltf.scene;
const mixer = new AnimationMixer(model);
const skinned = [];
model.traverse(object => { if (object.isSkinnedMesh) skinned.push(object); });
assert.ok(skinned.length >= 1, 'the skinned body loads');
/** Every vertex; the rigid boot vertices (LegContact); the glasses, which mark the eyes; and the
 *  helmet and head gear (at least half weighted to the head bone). */
const soles = { l: [], r: [] }, everything = [], lens = [], headGear = [];
for (const mesh of skinned) {
  const { skinIndex, skinWeight, position } = mesh.geometry.attributes;
  const joint = name => mesh.skeleton.bones.findIndex(bone => bone.name === name);
  const weight = (index, target) => { let total = 0; for (let lane = 0; lane < 4; lane++) if (skinIndex.getComponent(index, lane) === target) total += skinWeight.getComponent(index, lane); return total; };
  const feet = { l: joint('foot_l'), r: joint('foot_r') }, head = joint('head');
  for (let index = 0; index < position.count; index++) {
    const item = { mesh, index };
    everything.push(item);
    if (mesh.material?.name === 'Visor') lens.push(item);
    if (weight(index, head) >= 0.5) headGear.push(item);
    for (const side of ['l', 'r']) if (weight(index, feet[side]) >= 1 - 1e-6) soles[side].push(item);
  }
}
assert.ok(soles.l.length > 10 && soles.r.length > 10, 'rigid boot vertices exist for runtime leg contact');
assert.ok(lens.length > 10, 'the Visor glasses mark the eyes');
assert.ok(headGear.length > 100, 'the helmet and head gear ride on the head bone');
const point = new Vector3();
const place = ({ mesh, index }) => {
  point.fromBufferAttribute(mesh.geometry.attributes.position, index);
  mesh.applyBoneTransform(index, point); mesh.localToWorld(point);
  assert.ok(Number.isFinite(point.x + point.y + point.z), 'finite skinned position');
  return point.clone();
};
const bone = name => model.getObjectByName(name);
const positionOf = object => new Vector3().setFromMatrixPosition(object.matrixWorld);
/** The head bone starts at the top of the neck and points up its local Y; the skull centre is 11 cm along it. */
const headCentre = () => new Vector3(0, 0.11, 0).applyMatrix4(bone('head').matrixWorld);
const clip = name => gltf.animations.find(item => item.name === name);
function play(name, loop = LoopOnce) {
  mixer.stopAllAction();
  const action = mixer.clipAction(clip(name)).reset().setLoop(loop, Infinity);
  action.clampWhenFinished = true; action.play();
  return clip(name);
}
function at(animation, fraction) { mixer.setTime(animation.duration * fraction); model.updateMatrixWorld(true); }

// The support hand's grip on the weapon, measured in the bind pose before any clip plays.
model.updateMatrixWorld(true);
const socket = model.getObjectByName('weapon_socket');
const supportOffset = () => positionOf(bone('hand_l')).applyMatrix4(socket.matrixWorld.clone().invert());
const SUPPORT_REST = supportOffset();
const elbowDegrees = side => {
  const shoulder = positionOf(bone(`upper_arm_${side}`)), elbow = positionOf(bone(`forearm_${side}`)), wrist = positionOf(bone(`hand_${side}`));
  return shoulder.sub(elbow).angleTo(wrist.sub(elbow)) * 180 / Math.PI;
};
const BOXES = Object.fromEntries(['stand', 'crouch', 'slide'].map(posture => [posture, hitboxes({ x: 0, y: 0, z: 0, posture })]));
const headBox = posture => BOXES[posture].find(box => box.zone === 'head');
const inBoxes = (p, posture, slack = FIT.boxSlack) => BOXES[posture].some(box =>
  p.x >= box.min.x - slack && p.x <= box.max.x + slack && p.y >= box.min.y - slack && p.y <= box.max.y + slack && p.z >= box.min.z - slack && p.z <= box.max.z + slack);

/** Posture fit of one clip from the real skin: silhouette top and floor, glasses (eye) height, head
 *  centre against the head box, share of the body and of the head gear inside the hit boxes,
 *  horizontal reach, and the support hand's grip and elbow bend. Worst values over the clip, plus
 *  clip averages for the eye height and the head gear and body coverage. */
function fit(name) {
  const animation = play(name), posture = CLIP_POSTURE[name];
  const samples = Math.min(120, Math.max(64, Math.ceil(animation.duration * 60))), full = animation.duration < 1.2 ? 1 : 3;
  const out = { clip: name, posture, duration: animation.duration, samples: samples + 1, top: -Infinity, topOverShare: 0, bodyMin: Infinity, reach: 0, coverage: 1, coverageMean: 0, headGearCoverage: 1, headGearMean: 0,
    eye: [Infinity, -Infinity], eyeMean: 0, headCentre: [Infinity, -Infinity], headOffset: 0, support: 0, elbowLeft: [Infinity, -Infinity], elbowRight: [Infinity, -Infinity] };
  const range = (pair, value) => [Math.min(pair[0], value), Math.max(pair[1], value)];
  let passes = 0, over = 0;
  for (let index = 0; index <= samples; index++) {
    at(animation, index / samples);
    const head = headCentre();
    out.headCentre = range(out.headCentre, head.y);
    out.headOffset = Math.max(out.headOffset, Math.abs(head.x), Math.abs(head.z));
    let eye = 0; for (const item of lens) eye += place(item).y;
    out.eye = range(out.eye, eye / lens.length); out.eyeMean += eye / lens.length / (samples + 1);
    out.support = Math.max(out.support, supportOffset().distanceTo(SUPPORT_REST));
    out.elbowLeft = range(out.elbowLeft, elbowDegrees('l')); out.elbowRight = range(out.elbowRight, elbowDegrees('r'));
    if (index % full && index !== samples) continue;
    let covered = 0, gear = 0, top = -Infinity;
    for (const item of everything) {
      const p = place(item);
      top = Math.max(top, p.y); out.bodyMin = Math.min(out.bodyMin, p.y); out.reach = Math.max(out.reach, Math.hypot(p.x, p.z));
      if (inBoxes(p, posture)) covered++;
    }
    for (const item of headGear) if (inBoxes(place(item), posture)) gear++;
    out.top = Math.max(out.top, top); passes++; if (top > POSTURE_HEIGHT[posture] + FIT.top) over++;
    out.coverage = Math.min(out.coverage, covered / everything.length);
    out.headGearCoverage = Math.min(out.headGearCoverage, gear / headGear.length);
    out.headGearMean += gear / headGear.length; out.coverageMean += covered / everything.length;
  }
  out.topOverShare = over / passes; out.headGearMean /= passes; out.coverageMean /= passes;
  return out;
}

function gait(name, reference, limits) {
  const animation = play(name);
  const duration = animation.duration, steps = Math.ceil(duration * 480), dt = duration / steps;
  const samples = [];
  for (let index = 0; index <= steps; index++) {
    mixer.setTime(duration * index / steps); model.updateMatrixWorld(true);
    samples.push({ l: soles.l.map(place), r: soles.r.map(place) });
  }
  const floor = samples.map(row => Math.min(...row.l.map(p => p.y), ...row.r.map(p => p.y)));
  const bands = [];
  for (const height of [0.02, 0.04]) {
    const velocities = []; let contact = 0;
    for (let index = 1; index < samples.length; index++) {
      let lowest = null;
      for (const side of ['l', 'r']) for (let v = 0; v < samples[index][side].length; v++) {
        const pa = samples[index - 1][side][v], pb = samples[index][side][v];
        if (Math.min(pa.y, pb.y) >= -0.001 && Math.max(pa.y, pb.y) < height && (!lowest || pa.y + pb.y < lowest.height)) lowest = { pa, pb, height: pa.y + pb.y };
      }
      if (!lowest) continue;
      contact++;
      const velocity = lowest.pb.clone().sub(lowest.pa).divideScalar(dt); velocity.z -= reference;
      velocities.push(Math.hypot(velocity.x, velocity.z));
    }
    bands.push({ heightMetres: height, contactDuty: contact / steps, horizontalSlipMedian: percentile(velocities, 0.5), horizontalSlipP95: percentile(velocities, 0.95) });
  }
  let seamPosition = 0, seamVelocity = 0;
  for (const side of ['l', 'r']) for (let v = 0; v < soles[side].length; v++) {
    const first = samples[0][side][v], second = samples[1][side][v], last = samples.at(-1)[side][v], prior = samples.at(-2)[side][v];
    seamPosition = Math.max(seamPosition, first.distanceTo(last));
    seamVelocity = Math.max(seamVelocity, second.clone().sub(first).sub(last.clone().sub(prior)).length() / dt);
  }
  // Rotations interpolate between the 120 Hz keys, so the boot velocity jumps a little at every key,
  // most in a fast swing. A real loop seam stands out above those; the seam must be no rougher than
  // the clip's own keys (their 90th percentile), measured the same way.
  const keys = animation.tracks.reduce((best, track) => (track.times.length > best.length ? track.times : best), []);
  play(name, LoopRepeat);
  const solesAt = time => { mixer.setTime(time); model.updateMatrixWorld(true); return [...soles.l, ...soles.r].map(place); };
  const keyJumps = [];
  for (let k = 1; k < keys.length - 1; k++) {
    const [before, at, after] = [solesAt(keys[k] - dt), solesAt(keys[k]), solesAt(keys[k] + dt)];
    let worst = 0;
    for (let v = 0; v < at.length; v++) worst = Math.max(worst, after[v].clone().sub(at[v]).sub(at[v].clone().sub(before[v])).length() / dt);
    keyJumps.push(worst);
  }
  const keyJumpP90 = percentile(keyJumps, 0.9);
  const result = { clip: name, referenceSpeed: reference, duration, samples: samples.length, minFloor: Math.min(...floor), maxFloor: Math.max(...floor), seamPosition, seamVelocity,
    keyVelocityJump: { median: percentile(keyJumps, 0.5), p90: keyJumpP90, max: Math.max(...keyJumps) }, contactBands: bands };
  assert.ok(result.minFloor >= -0.001, `${name} soles penetrate the floor: ${result.minFloor}`);
  assert.ok(result.maxFloor < limits.maxFloor, `${name} keeps a bounded step height: ${result.maxFloor}`);
  assert.ok(seamPosition < 1e-4, `${name} loops without a position seam: ${seamPosition}`);
  assert.ok(seamVelocity < limits.seamVelocity, `${name} loop velocity seam: ${seamVelocity}`);
  assert.ok(seamVelocity <= keyJumpP90, `${name} loop velocity seam ${seamVelocity.toFixed(3)} m/s is no rougher than its own keys (90th percentile ${keyJumpP90.toFixed(3)} m/s)`);
  bands.forEach((band, index) => {
    assert.ok(band.contactDuty >= limits.minimumDuty[index], `${name} near-floor coverage in the ${band.heightMetres} m band: ${band.contactDuty}`);
    assert.ok(band.horizontalSlipP95 !== null && band.horizontalSlipP95 < limits.slipP95[index], `${name} foot slip in the ${band.heightMetres} m band: ${band.horizontalSlipP95}`);
  });
  return result;
}

/** Hold poses: soles on or above the floor and planted feet that do not slide. */
function hold(name, options = {}) {
  const animation = play(name, LoopRepeat);
  const samples = Math.max(8, Math.ceil(animation.duration * 60));
  let soleMin = Infinity, footTravel = 0;
  let previousFeet = null;
  for (let index = 0; index <= samples; index++) {
    mixer.setTime(animation.duration * index / samples); model.updateMatrixWorld(true);
    const feet = [...soles.l, ...soles.r].map(place);
    soleMin = Math.min(soleMin, ...feet.map(p => p.y));
    if (previousFeet && options.planted) footTravel = Math.max(footTravel, ...feet.map((p, i) => (p.y < 0.03 && previousFeet[i].y < 0.03 ? Math.hypot(p.x - previousFeet[i].x, p.z - previousFeet[i].z) : 0)));
    previousFeet = feet;
  }
  const result = { clip: name, duration: animation.duration, soleMin, plantedFootTravel: footTravel };
  assert.ok(soleMin >= -0.002, `${name} boots stay out of the floor: ${soleMin}`);
  if (options.planted) assert.ok(footTravel < 0.004, `${name} planted feet do not slide between samples: ${footTravel}`);
  return result;
}

/** Best circular shift (fraction of a cycle) that lines up track b with track a, by correlation. */
function phaseShift(a, b) {
  const normalise = values => { const mean = values.reduce((s, v) => s + v, 0) / values.length; const deviation = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length); return values.map(v => (v - mean) / deviation); };
  const x = normalise(a), y = normalise(b), n = x.length;
  let best = 0, score = -Infinity;
  for (let shift = 0; shift < n; shift++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += x[i] * y[(i + shift) % n];
    if (sum > score) { score = sum; best = shift; }
  }
  return { shift: (best > n / 2 ? best - n : best) / n, correlation: score / n };
}
/** Fore-and-aft foot travel over one normalized cycle. */
function footTracks(name, count = 240) {
  const animation = play(name), tracks = { l: [], r: [] };
  for (let index = 0; index < count; index++) { at(animation, index / count); for (const side of ['l', 'r']) tracks[side].push(positionOf(bone(`foot_${side}`)).z); }
  return tracks;
}

const gaitLimits = {
  // Same regression limits as validate_locomotion.mjs for the inherited CMU-derived gait.
  Walk: { maxFloor: 0.12, seamVelocity: 1.3, slipP95: [0.6, 1.2], minimumDuty: [0.28, 0.48] },
  Run: { maxFloor: 0.12, seamVelocity: 1.8, slipP95: [1, 2.5], minimumDuty: [0.24, 0.40] },
  // CrouchWalk is phased like Walk/Run, so its loop starts mid-swing, where its own keys jump up to
  // about 2 m/s; the relative seam check above is the strict one, this is a backstop.
  CrouchWalk: { maxFloor: 0.14, seamVelocity: 2.0, slipP95: [0.35, 0.6], minimumDuty: [0.45, 0.55] },
};
const locomotion = Object.entries(REFERENCE_SPEEDS).map(([name, speed]) => gait(name, speed, gaitLimits[name]));
const holds = [hold('Idle', { planted: true }), hold('Aim', { planted: true }), hold('Crouch', { planted: true }), hold('Slide')];

// Posture fit against the shared rules for every clip. Failures are collected so one run shows them all.
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const fits = [...INHERITED_CLIPS, ...AUTHORED_CLIPS].map(fit);
for (const result of fits) {
  const { clip: name, posture } = result, box = headBox(posture), eye = EYE_HEIGHT[posture];
  const show = values => values.map(value => value.toFixed(3)).join('..');
  const gaitBob = UPRIGHT_GAITS.includes(name);
  check(result.top <= POSTURE_HEIGHT[posture] + (gaitBob ? FIT.gaitBob : FIT.top),
    `${name} silhouette top ${result.top.toFixed(3)} m stays under the ${posture} height ${POSTURE_HEIGHT[posture]} m${gaitBob ? ` plus the ${FIT.gaitBob} m running bob` : ''}`);
  // Jump plays in the air, where y = 0 is the player's feet rather than the floor; its tuck is checked below.
  if (name !== 'Jump') check(result.bodyMin >= -0.002, `${name} body stays out of the floor: ${result.bodyMin.toFixed(4)} m`);
  check(result.headCentre[0] >= box.min.y && result.headCentre[1] <= box.max.y && result.headOffset <= box.max.x,
    `${name} head centre (height ${show(result.headCentre)} m, ${result.headOffset.toFixed(3)} m off centre) stays inside the ${posture} head box ${box.min.y}..${box.max.y} m, half width ${box.max.x} m`);
  if (!FIT.support.exempt.includes(name)) {
    check(result.support <= FIT.support.distance, `${name} support hand stays on the weapon: ${(result.support * 100).toFixed(1)} cm from its grip`);
    check(result.elbowLeft[1] <= FIT.support.elbowDegrees, `${name} left elbow stays bent: up to ${result.elbowLeft[1].toFixed(0)} degrees`);
  }
  if (gaitBob) {
    check(result.eyeMean >= eye - FIT.eyeBelow && result.eyeMean <= eye + FIT.eyeAbove, `${name} glasses average ${result.eyeMean.toFixed(3)} m near the ${posture} camera height ${eye} m`);
  } else if (FITTED_CLIPS.includes(name) || name === 'Idle' || name === 'Aim') {
    check(result.eye[0] >= eye - FIT.eyeBelow && result.eye[1] <= eye + FIT.eyeAbove, `${name} glasses ${show(result.eye)} m sit near the ${posture} camera height ${eye} m`);
  }
  if (AUTHORED_CLIPS.includes(name)) {
    check(result.headGearCoverage >= FIT.headGear.low, `${name} head gear inside the hit boxes: ${(result.headGearCoverage * 100).toFixed(0)}% at worst (needs ${FIT.headGear.low * 100}%)`);
  } else if (gaitBob) {
    check(result.headGearMean >= FIT.headGear.gait, `${name} head gear inside the hit boxes: ${(result.headGearMean * 100).toFixed(0)}% over the stride (needs ${FIT.headGear.gait * 100}%)`);
  }
  if (AUTHORED_CLIPS.includes(name)) {
    check(result.coverageMean >= FIT.coverage.mean && result.coverage >= FIT.coverage.least,
      `${name} body inside the ${posture} hit boxes: ${(result.coverageMean * 100).toFixed(1)}% on average, ${(result.coverage * 100).toFixed(1)}% at worst (needs ${FIT.coverage.mean * 100}% and two thirds)`);
    check(result.reach <= FIT.reach, `${name} stays within ${FIT.reach.toFixed(2)} m of the player: ${result.reach.toFixed(3)} m`);
  }
}

// CrouchWalk must step in time with Walk and Run, because CharacterBlend fades gaits at one phase.
const feet = { Walk: footTracks('Walk'), Run: footTracks('Run'), CrouchWalk: footTracks('CrouchWalk') };
const phase = {};
for (const reference of ['Walk', 'Run']) {
  for (const side of ['l', 'r']) {
    const { shift, correlation } = phaseShift(feet[reference][side], feet.CrouchWalk[side]);
    phase[`${reference}_${side}`] = { shift, correlation };
    check(Math.abs(shift) <= FIT.phase, `CrouchWalk ${side === 'l' ? 'left' : 'right'} foot steps in phase with ${reference}: off by ${shift.toFixed(3)} of a cycle`);
  }
}
const round = value => Math.round(value * 1000) / 1000;
console.log('posture fit (metres; eye = glasses centre; offset = head centre from the player position; gear/coverage = share inside hit boxes):');
console.table(Object.fromEntries(fits.map(f => [f.clip, { top: round(f.top), 'top over': round(f.topOverShare), eye: f.eye.map(round).join('..'), 'eye avg': round(f.eyeMean), head: f.headCentre.map(round).join('..'), offset: round(f.headOffset),
  gear: `${round(f.headGearCoverage)} (${round(f.headGearMean)})`, coverage: `${round(f.coverage)} (${round(f.coverageMean)})`, reach: round(f.reach), floor: round(f.bodyMin), 'grip cm': round(f.support * 100), 'elbow L': f.elbowLeft.map(Math.round).join('..') }])));
console.log('CrouchWalk phase offset (cycles):', Object.fromEntries(Object.entries(phase).map(([key, value]) => [key, round(value.shift)])));
if (failures.length) {
  console.error(`\nPosture fit failures (${failures.length}):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
const jump = play('Jump');
mixer.setTime(jump.duration * 0.3); model.updateMatrixWorld(true);
assert.ok(Math.min(...[...soles.l, ...soles.r].map(place).map(p => p.y)) > -0.05, 'Jump tucks the feet up, not through the floor');

// 4. Credits: the CMU-derived gait keeps its provenance and public notice.
const motion = new URL('art/source/motion/cmu-09/', repo);
const provenance = JSON.parse(readFileSync(new URL('provenance.json', motion), 'utf8'));
for (const item of provenance.sources) {
  const original = readFileSync(new URL(item.file, motion));
  assert.equal(createHash('sha256').update(original).digest('hex'), item.sha256, `${item.file} keeps its recorded digest`);
}
const notice = readFileSync(file('public/models/operator-motion-NOTICE.txt'), 'utf8');
assert.match(notice, /mocap\.cs\.cmu\.edu/, 'the public notice credits the CMU database');
assert.match(notice, /NSF EIA-0196217/, 'the public notice keeps the requested funding acknowledgement');
assert.match(json.asset.copyright ?? '', /mocap\.cs\.cmu\.edu/, 'the GLB itself carries the motion credit');

const report = {
  status: 'passed', file: glbPath, bytes: operator.bytes.length, sha256: createHash('sha256').update(operator.bytes).digest('hex'),
  vertices, triangles, bodyDraws: body.primitives.length, materials: [...usedMaterials], bones: BONES.length, clips: clipNames,
  textures: (json.images ?? []).map(image => ({ name: image.name, mimeType: image.mimeType, bytes: json.bufferViews[image.bufferView].byteLength })),
  weaponSocket: { parent: 'hand_r', restPosition: socketPosition.toArray(), restRotationErrorRadians: socketAngle, convention: 'metres; Y up; -Z forward along the barrel' },
  sameRigAsScout: { baseline: baselinePath, restPoseMaxDifference: restDifference, inverseBindMaxDifference: bindDifference, inheritedClips: inherited },
  referenceSpeeds: REFERENCE_SPEEDS, locomotion, holds,
  postureRules: { source: 'shared/physics.ts', postureHeight: POSTURE_HEIGHT, eyeHeight: EYE_HEIGHT, playerRadius: PLAYER_RADIUS, hitboxes: BOXES, limits: FIT },
  supportGrip: { restOffsetInSocket: SUPPORT_REST.toArray() },
  postureFit: fits, crouchWalkPhase: phase,
  coordinateSystem: 'metres; Y up; -Z forward',
};
if (!flag('no-report')) writeFileSync(file('art/source/operator-export-review.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  status: report.status, bytes: report.bytes, sha256: report.sha256, triangles, vertices, clips: clipNames,
  inherited: inherited.map(item => ({ clip: item.clip, identical: item.identical, maxDifference: item.maxDifference })),
  locomotion: locomotion.map(l => ({ clip: l.clip, minFloor: round(l.minFloor), slipP95: l.contactBands.map(b => round(b.horizontalSlipP95)), seamVelocity: round(l.seamVelocity) })),
}, null, 1));
