/** Validate the operator character GLB against its runtime contract (docs/OPERATOR_ART.md).
 *
 *  node scripts/blender/validate_operator.mjs [--glb public/models/operator-v1.glb]
 *    [--baseline public/models/scout.glb] [--allow-png] [--no-report]
 *
 *  Checks the container, rig names, clip list, weapon socket, budgets and embedded textures; proves
 *  the rig and the seven inherited clips are the scout's (same rest pose, inverse binds and
 *  animation samples); then plays every clip through Three's AnimationMixer on the CPU and samples
 *  the actual skinned vertices for floor contact, foot slip, loop seams and head heights that must
 *  line up with the shared posture hitboxes. Writes art/source/operator-export-review.json. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnimationMixer, LoopOnce, LoopRepeat, Matrix4, Quaternion, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

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
/** Reference travel speeds (m/s) at playback rate 1 for the in-place loops. */
export const REFERENCE_SPEEDS = { Walk: 6.5, Run: 9, CrouchWalk: 2.6 };
/** Right palm on the pistol grip at rest, in glTF metres (Y up, -Z forward). */
export const SOCKET_REST = [0.14, 1.39, -0.336];
const LIMITS = { bytes: 4_000_000, triangles: 25_000, bodyDraws: 4 };
/** Shared posture hitboxes (shared/physics.ts): head box [bottom, top] in metres. */
const HEAD_BOX = { stand: [1.45, 1.8], crouch: [0.95, 1.25], slide: [0.72, 1.0] };

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
  let worst = 0, channels = 0;
  for (const channel of b.channels) {
    const node = baseline.json.nodes[channel.target.node].name;
    if (!BONES.includes(node)) continue;
    const other = a.channels.find(item => operator.json.nodes[item.target.node].name === node && item.target.path === channel.target.path);
    assert.ok(other, `${clip} keeps ${node}.${channel.target.path}`);
    for (const field of ['input', 'output']) worst = Math.max(worst, maxDifference(floats(operator, a.samplers[other.sampler][field]), floats(baseline, b.samplers[channel.sampler][field])));
    channels++;
  }
  assert.ok(worst < 1e-6, `${clip} samples match the scout export: ${worst}`);
  inherited.push({ clip, channels, maxDifference: worst });
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
const soles = { l: [], r: [] }, everything = [];
for (const mesh of skinned) {
  const { skinIndex, skinWeight, position } = mesh.geometry.attributes;
  for (let index = 0; index < position.count; index++) {
    everything.push({ mesh, index });
    for (const side of ['l', 'r']) {
      const joint = mesh.skeleton.bones.findIndex(bone => bone.name === `foot_${side}`);
      for (let lane = 0; lane < 4; lane++) if (skinIndex.getComponent(index, lane) === joint && skinWeight.getComponent(index, lane) >= 1 - 1e-6) { soles[side].push({ mesh, index }); break; }
    }
  }
}
assert.ok(soles.l.length > 10 && soles.r.length > 10, 'rigid boot vertices exist for runtime leg contact');
const point = new Vector3();
const place = ({ mesh, index }) => {
  point.fromBufferAttribute(mesh.geometry.attributes.position, index);
  mesh.applyBoneTransform(index, point); mesh.localToWorld(point);
  assert.ok(Number.isFinite(point.x + point.y + point.z), 'finite skinned position');
  return point.clone();
};
const bone = name => model.getObjectByName(name);
/** The head bone starts at the top of the neck and points up its local Y; the skull centre is 11 cm along it. */
const headCentre = () => new Vector3(0, 0.11, 0).applyMatrix4(bone('head').matrixWorld);
const clip = name => gltf.animations.find(item => item.name === name);
function play(name, loop = LoopOnce) {
  mixer.stopAllAction();
  const action = mixer.clipAction(clip(name)).reset().setLoop(loop, Infinity);
  action.clampWhenFinished = true; action.play();
  return clip(name);
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
  const result = { clip: name, referenceSpeed: reference, duration, samples: samples.length, minFloor: Math.min(...floor), maxFloor: Math.max(...floor), seamPosition, seamVelocity, contactBands: bands };
  assert.ok(result.minFloor >= -0.001, `${name} soles penetrate the floor: ${result.minFloor}`);
  assert.ok(result.maxFloor < limits.maxFloor, `${name} keeps a bounded step height: ${result.maxFloor}`);
  assert.ok(seamPosition < 1e-4, `${name} loops without a position seam: ${seamPosition}`);
  assert.ok(seamVelocity < limits.seamVelocity, `${name} loop velocity seam: ${seamVelocity}`);
  bands.forEach((band, index) => {
    assert.ok(band.contactDuty >= limits.minimumDuty[index], `${name} near-floor coverage in the ${band.heightMetres} m band: ${band.contactDuty}`);
    assert.ok(band.horizontalSlipP95 !== null && band.horizontalSlipP95 < limits.slipP95[index], `${name} foot slip in the ${band.heightMetres} m band: ${band.horizontalSlipP95}`);
  });
  return result;
}

/** Hold poses: soles on or above the floor, head inside the posture's hitbox, nothing sinks. */
function hold(name, posture, options = {}) {
  const animation = play(name, LoopRepeat);
  const samples = Math.max(8, Math.ceil(animation.duration * 60));
  let soleMin = Infinity, bodyMin = Infinity, bodyMax = -Infinity, headMin = Infinity, headMax = -Infinity, headReach = 0, footTravel = 0;
  let previousFeet = null;
  for (let index = 0; index <= samples; index++) {
    mixer.setTime(animation.duration * index / samples); model.updateMatrixWorld(true);
    const feet = [...soles.l, ...soles.r].map(place);
    soleMin = Math.min(soleMin, ...feet.map(p => p.y));
    if (previousFeet && options.planted) footTravel = Math.max(footTravel, ...feet.map((p, i) => (p.y < 0.03 && previousFeet[i].y < 0.03 ? Math.hypot(p.x - previousFeet[i].x, p.z - previousFeet[i].z) : 0)));
    previousFeet = feet;
    if (index % 4 === 0) for (const item of everything) { const p = place(item); bodyMin = Math.min(bodyMin, p.y); bodyMax = Math.max(bodyMax, p.y); }
    const head = headCentre();
    headMin = Math.min(headMin, head.y); headMax = Math.max(headMax, head.y); headReach = Math.max(headReach, Math.hypot(head.x, head.z));
  }
  const [bottom, top] = HEAD_BOX[posture];
  const result = { clip: name, posture, duration: animation.duration, soleMin, bodyMin, bodyTop: bodyMax, headCentre: [headMin, headMax], headHorizontalReach: headReach, plantedFootTravel: footTravel };
  assert.ok(soleMin >= -0.002, `${name} boots stay out of the floor: ${soleMin}`);
  assert.ok(bodyMin >= (options.bodyFloor ?? -0.002), `${name} body stays out of the floor: ${bodyMin}`);
  assert.ok(headMin >= bottom - 0.03 && headMax <= top + 0.03, `${name} head centre ${headMin.toFixed(3)}..${headMax.toFixed(3)} sits in the ${posture} head box ${bottom}..${top}`);
  assert.ok(headReach < 0.35, `${name} head stays over the player's collision column: ${headReach}`);
  if (options.top) assert.ok(bodyMax <= options.top, `${name} silhouette top ${bodyMax} fits the ${posture} height`);
  if (options.planted) assert.ok(footTravel < 0.004, `${name} planted feet do not slide between samples: ${footTravel}`);
  return result;
}

const gaitLimits = {
  // Same regression limits as validate_locomotion.mjs for the inherited CMU-derived gait.
  Walk: { maxFloor: 0.12, seamVelocity: 1.3, slipP95: [0.6, 1.2], minimumDuty: [0.28, 0.48] },
  Run: { maxFloor: 0.12, seamVelocity: 1.8, slipP95: [1, 2.5], minimumDuty: [0.24, 0.40] },
  CrouchWalk: { maxFloor: 0.14, seamVelocity: 1.0, slipP95: [0.35, 0.6], minimumDuty: [0.45, 0.55] },
};
const locomotion = Object.entries(REFERENCE_SPEEDS).map(([name, speed]) => gait(name, speed, gaitLimits[name]));
const holds = [
  hold('Idle', 'stand', { planted: true }),
  hold('Aim', 'stand', { planted: true }),
  hold('Crouch', 'crouch', { planted: true, top: 1.34 }),
  hold('Slide', 'slide', { bodyFloor: -0.03, top: 1.08 }),
];
const crouchWalkTop = (() => {
  const animation = play('CrouchWalk'); let top = -Infinity;
  for (let index = 0; index <= 16; index++) { mixer.setTime(animation.duration * index / 16); model.updateMatrixWorld(true); for (const item of everything) top = Math.max(top, place(item).y); }
  return top;
})();
assert.ok(crouchWalkTop <= 1.38, `CrouchWalk stays low: ${crouchWalkTop}`);
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
  referenceSpeeds: REFERENCE_SPEEDS, locomotion, holds, crouchWalkTop,
  coordinateSystem: 'metres; Y up; -Z forward',
};
if (!flag('no-report')) writeFileSync(file('art/source/operator-export-review.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, bytes: report.bytes, triangles, vertices, clips: clipNames, locomotion: locomotion.map(l => ({ clip: l.clip, minFloor: l.minFloor, slipP95: l.contactBands.map(b => b.horizontalSlipP95) })), holds: holds.map(h => ({ clip: h.clip, head: h.headCentre, top: h.bodyTop, bodyMin: h.bodyMin })) }, null, 2));
