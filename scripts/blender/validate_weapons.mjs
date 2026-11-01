/** Validate the shipped first-person weapons file against its contract (docs/WEAPONS_ART.md):
 *  root and child node names and tags, anchors and where they sit, sight pictures (nothing solid in
 *  front of the eye on a reflex sight; iron sights that show the front post through the rear notch or
 *  ring), hands that close round the real grip and handguard when seated, a pistol slide that clears
 *  the hand, bounds, triangle budgets, KTX2 textures, Meshopt geometry and the 6 MB budget.
 *
 *  node scripts/blender/validate_weapons.mjs [--glb public/models/weapons-v1.glb] [--manifest art/source/weapons/weapons-v1-manifest.json] */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Box3, Matrix4, Quaternion, Ray, Vector3 } from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const glbPath = arg('glb', 'public/models/weapons-v1.glb');
const manifestPath = arg('manifest', 'art/source/weapons/weapons-v1-manifest.json');
const MAX_BYTES = 6_000_000;

/** Contract and plausibility limits. Lengths are along glTF Z (the bore axis), metres. `eye` is how far
 *  behind the sight anchor the sight-picture checks put the aiming eye. */
const WEAPONS = {
  kr5: { root: 'weapon_kr5', length: [0.78, 0.95], sight: 'reflex', eye: 0.22 },
  hornet9: { root: 'weapon_hornet9', length: [0.50, 0.72], sight: 'reflex', eye: 0.22 },
  breaker12: { root: 'weapon_breaker12', length: [0.85, 1.05], sight: 'iron', eye: 0.24 },
  longbow: { root: 'weapon_longbow', length: [1.05, 1.30], sight: 'scope', eye: 0.02 },
  sentry9: { root: 'weapon_sentry9', length: [0.17, 0.23], sight: 'iron', eye: 0.40, slideTravel: 0.022 },
};
const ROOTS = ['weapon_kr5', 'weapon_hornet9', 'weapon_breaker12', 'weapon_longbow', 'weapon_sentry9', 'knife', 'frag', 'arm_left', 'arm_right'];
const ANCHORS = ['grip_r', 'grip_l', 'muzzle', 'sight', 'eject'];
const GLASS = 'WeaponReflexGlass', LENS = 'WeaponLens', GLOW = /^WeaponGlow/;
/** Untextured materials: reflex glass, scope glass and the glowing dots. */
const FLAT = /^(WeaponReflexGlass|WeaponLens)$|^WeaponGlow/;
/** Glass you can see through: blended with a low alpha. Every other surface stops the eye. */
const seeThrough = material => material.alphaMode === 'BLEND' && (material.pbrMetallicRoughness?.baseColorFactor?.[3] ?? 1) <= 0.35;

// --- GLB decoding ------------------------------------------------------------------------------
assert.ok(existsSync(glbPath), `${glbPath} exists`);
const bytes = readFileSync(glbPath);
assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'binary glTF magic');
assert.equal(bytes.readUInt32LE(4), 2, 'glTF 2.0 container');
assert.equal(bytes.readUInt32LE(8), bytes.length, 'declared length matches the file');
assert.ok(bytes.length <= MAX_BYTES, `${bytes.length} bytes within the ${MAX_BYTES} byte budget`);
const jsonLength = bytes.readUInt32LE(12);
assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, 'JSON chunk first');
const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
const binStart = 20 + jsonLength;
assert.equal(bytes.readUInt32LE(binStart + 4), 0x004e4942, 'BIN chunk second');
const binary = bytes.subarray(binStart + 8, binStart + 8 + bytes.readUInt32LE(binStart));
assert.equal(gltf.asset?.version, '2.0');
for (const ext of ['EXT_meshopt_compression', 'KHR_texture_basisu', 'KHR_mesh_quantization']) assert.ok(gltf.extensionsRequired?.includes(ext), `${ext} is required`);
assert.equal(gltf.animations?.length ?? 0, 0, 'no animations');
assert.equal(gltf.skins?.length ?? 0, 0, 'no skins (rigid parts only)');
assert.equal(gltf.cameras?.length ?? 0, 0, 'no cameras');
assert.ok(!gltf.extensions?.KHR_lights_punctual, 'no lights');

await MeshoptDecoder.ready;
const views = gltf.bufferViews.map(view => {
  const e = view.extensions?.EXT_meshopt_compression;
  if (!e) return binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  const result = Buffer.alloc(e.count * e.byteStride);
  MeshoptDecoder.decodeGltfBuffer(result, e.count, e.byteStride, binary.subarray(e.byteOffset ?? 0, (e.byteOffset ?? 0) + e.byteLength), e.mode, e.filter);
  return result;
});
function accessor(index) {
  const a = gltf.accessors[index], view = gltf.bufferViews[a.bufferView], data = views[a.bufferView];
  assert.ok(!a.sparse, 'no sparse accessors');
  const size = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType];
  const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  const read = { 5120: 'readInt8', 5121: 'readUInt8', 5122: 'readInt16LE', 5123: 'readUInt16LE', 5125: 'readUInt32LE', 5126: 'readFloatLE' }[a.componentType];
  const stride = view.byteStride ?? size * width, offset = a.byteOffset ?? 0;
  const divisor = a.normalized ? { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }[a.componentType] : 1;
  const value = (i, j) => data[read](offset + i * stride + j * size) / divisor;
  // Normalized signed integers reach -1 at both -127 and -128 (KHR_mesh_quantization).
  return Array.from({ length: a.count }, (_, i) => Array.from({ length: width }, (_, j) => a.normalized ? Math.max(-1, value(i, j)) : value(i, j)));
}
const localMatrix = node => node.matrix ? new Matrix4().fromArray(node.matrix)
  : new Matrix4().compose(new Vector3().fromArray(node.translation ?? [0, 0, 0]), new Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]), new Vector3().fromArray(node.scale ?? [1, 1, 1]));

/** Everything under one root, in that root's own space. */
function collect(rootIndex) {
  const nodes = new Map(), triangles = [], bounds = new Box3(), primitives = [];
  let triangleCount = 0;
  (function visit(index, parent, parentName) {
    const node = gltf.nodes[index];
    const matrix = index === rootIndex ? new Matrix4() : new Matrix4().multiplyMatrices(parent, localMatrix(node));
    if (index !== rootIndex) {
      assert.ok(!nodes.has(node.name), `${gltf.nodes[rootIndex].name}: node name ${node.name} is unique within its root`);
      nodes.set(node.name, { node, matrix, parent: parentName });
    }
    if (node.mesh !== undefined) for (const p of gltf.meshes[node.mesh].primitives) {
      assert.equal(p.mode ?? 4, 4, 'triangle lists');
      const material = gltf.materials[p.material];
      const positions = accessor(p.attributes.POSITION).map(v => new Vector3().fromArray(v).applyMatrix4(matrix));
      for (const attribute of ['NORMAL', 'TEXCOORD_0']) assert.notEqual(p.attributes[attribute], undefined, `${node.name}: ${attribute}`);
      const ids = accessor(p.indices).flat();
      triangleCount += ids.length / 3;
      const see = seeThrough(material);
      for (let i = 0; i < ids.length; i += 3) triangles.push({ a: positions[ids[i]], b: positions[ids[i + 1]], c: positions[ids[i + 2]], material: material.name, node: node.name, see });
      for (const v of positions) { assert.ok([v.x, v.y, v.z].every(Number.isFinite), `${node.name}: finite positions`); bounds.expandByPoint(v); }
      primitives.push({ node: node.name, material, positions });
    }
    for (const child of node.children ?? []) visit(child, matrix, index === rootIndex ? null : node.name);
  })(rootIndex, new Matrix4(), null);
  return { nodes, triangles, triangleCount, bounds, primitives };
}

const ray = new Ray(), hit = new Vector3();
function hits(tris, origin, direction, filter = () => true) {
  ray.set(origin, direction);
  const out = [];
  for (const t of tris) if (filter(t) && ray.intersectTriangle(t.a, t.b, t.c, false, hit)) out.push({ distance: hit.distanceTo(origin), t });
  return out.sort((p, q) => p.distance - q.distance);
}
const position = entry => new Vector3().setFromMatrixPosition(entry.matrix);
const rotation = entry => new Quaternion().setFromRotationMatrix(entry.matrix);
const solid = t => !t.see;
/** How many of `count` rays fanned out across `axis` from `origin` meet `tris` within `reach`. */
function around(origin, axis, tris, reach, count = 12) {
  const u = new Vector3(1, 0, 0).cross(axis).lengthSq() > 0.1 ? new Vector3(1, 0, 0).cross(axis).normalize() : new Vector3(0, 1, 0).cross(axis).normalize();
  const v = axis.clone().cross(u).normalize();
  let met = 0;
  for (let k = 0; k < count; k++) {
    const a = (k / count) * Math.PI * 2;
    const direction = u.clone().multiplyScalar(Math.cos(a)).addScaledVector(v, Math.sin(a));
    if (hits(tris, origin, direction).some(h => h.distance < reach)) met++;
  }
  return met;
}
/** Triangles of one root placed by a matrix (an arm seated on an anchor, a knife in a hand). */
const placed = (tris, matrix) => tris.map(t => ({ ...t, a: t.a.clone().applyMatrix4(matrix), b: t.b.clone().applyMatrix4(matrix), c: t.c.clone().applyMatrix4(matrix) }));
/** Each tag value names one node per root: `anchor` on empties, `part` on the mag/action pivots only,
 *  `mesh` on every mesh. Returns part -> node name. */
function checkTags(label, nodes) {
  const parts = new Map(), anchors = new Map();
  for (const [name, { node }] of nodes) {
    const extras = node.extras ?? {};
    if (node.mesh !== undefined) {
      assert.equal(extras.mesh, name.replace(/_mesh$/, ''), `${label}: mesh ${name} carries extras.mesh`);
      assert.equal(extras.part, undefined, `${label}: mesh ${name} carries no extras.part (only pivots do)`);
      assert.equal(extras.anchor, undefined, `${label}: mesh ${name} is not an anchor`);
    }
    if (extras.part !== undefined) {
      assert.ok(!parts.has(extras.part), `${label}: extras.part "${extras.part}" names exactly one node`);
      assert.equal(node.mesh, undefined, `${label}: part ${extras.part} is a pivot, not a mesh`);
      parts.set(extras.part, name);
    }
    if (extras.anchor !== undefined) {
      assert.ok(!anchors.has(extras.anchor), `${label}: extras.anchor "${extras.anchor}" names exactly one node`);
      anchors.set(extras.anchor, name);
    }
  }
  return parts;
}

// --- Scene and materials -------------------------------------------------------------------------
const scene = gltf.scenes[gltf.scene ?? 0];
const rootNodes = scene.nodes.map(i => gltf.nodes[i]);
assert.deepEqual(rootNodes.map(n => n.name).sort(), [...ROOTS].sort(), 'scene roots are exactly the contract roots');
for (const node of rootNodes) {
  assert.equal(node.mesh, undefined, `${node.name}: root is a transform, not a mesh`);
  assert.ok(localMatrix(node).equals(new Matrix4()), `${node.name}: root sits at the origin, unrotated`);
}
for (const image of gltf.images) {
  assert.equal(image.mimeType, 'image/ktx2', `${image.name}: KTX2`);
  assert.equal(image.uri, undefined, `${image.name}: embedded`);
  const view = gltf.bufferViews[image.bufferView];
  const data = binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  assert.deepEqual([...data.subarray(0, 12)], [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a], `${image.name}: KTX2 identifier`);
  const w = data.readUInt32LE(20), h = data.readUInt32LE(24);
  assert.ok(w <= 2048 && h <= 2048 && (w & (w - 1)) === 0 && (h & (h - 1)) === 0, `${image.name}: ${w}x${h} is a power of two within 2048`);
}
for (const material of gltf.materials) {
  const pbr = material.pbrMetallicRoughness ?? {};
  if (material.name === GLASS) {
    assert.ok(seeThrough(material), `${GLASS}: blended with alpha <= 0.35 (${material.alphaMode}, alpha ${pbr.baseColorFactor?.[3]})`);
    assert.ok(pbr.baseColorFactor[3] >= 0.05, `${GLASS}: still reads as glass`);
    assert.ok(!pbr.baseColorTexture && !material.normalTexture && !material.doubleSided, `${GLASS}: untextured, one-sided`);
    continue;
  }
  assert.equal(material.alphaMode ?? 'OPAQUE', 'OPAQUE', `${material.name}: opaque`);
  if (FLAT.test(material.name)) {
    if (GLOW.test(material.name)) assert.ok(Math.max(...(material.emissiveFactor ?? [0])) > 0, `${material.name}: glows`);
    continue;
  }
  assert.ok(pbr.baseColorTexture && pbr.metallicRoughnessTexture && material.normalTexture && material.occlusionTexture, `${material.name}: baked colour, ORM and normal maps`);
}
assert.ok(gltf.materials.some(m => m.name === GLASS), `${GLASS} is present`);

// --- Arms and knife (needed to check hands on the weapons) -------------------------------------------
const rootIndex = name => scene.nodes.find(i => gltf.nodes[i].name === name);
const arms = {};
for (const name of ['arm_left', 'arm_right']) {
  const index = rootIndex(name);
  const arm = collect(index);
  checkTags(name, arm.nodes);
  assert.ok(arm.nodes.get('arm')?.node.mesh !== undefined, `${name}: arm mesh`);
  arm.heldAxis = new Vector3().fromArray(gltf.nodes[index].extras?.heldAxis ?? [0, 0, 0]);
  assert.ok(Math.abs(arm.heldAxis.length() - 1) < 1e-3, `${name}: extras.heldAxis is a unit vector`);
  arms[name] = arm;
}
const knife = collect(rootIndex('knife'));
checkTags('knife', knife.nodes);

// --- Weapons -------------------------------------------------------------------------------------
const report = {};
const forward = new Vector3(0, 0, -1);
for (const [id, spec] of Object.entries(WEAPONS)) {
  const { nodes, triangles, triangleCount, bounds, primitives } = collect(rootIndex(spec.root));
  const label = spec.root;
  for (const name of ANCHORS) {
    const entry = nodes.get(name);
    assert.ok(entry, `${label}: anchor ${name}`);
    assert.equal(entry.node.mesh, undefined, `${label}: ${name} is an empty`);
    assert.equal(entry.node.extras?.anchor, name, `${label}: ${name} carries extras.anchor`);
    assert.equal(entry.parent, null, `${label}: ${name} is a direct child of the root`);
    assert.ok(Math.abs(rotation(entry).length() - 1) < 1e-4, `${label}: ${name} rotation is a unit quaternion`);
  }
  const parts = checkTags(label, nodes);
  assert.deepEqual([...parts.keys()].sort(), ['action', 'mag'], `${label}: parts are exactly mag and action`);
  for (const part of ['mag', 'action']) {
    const entry = nodes.get(part);
    assert.ok(entry && parts.get(part) === part, `${label}: ${part} pivot carries extras.part`);
    const meshChild = (entry.node.children ?? []).map(c => gltf.nodes[c]).find(c => c.mesh !== undefined);
    assert.ok(meshChild && meshChild.name === `${part}_mesh`, `${label}: ${part} pivot holds ${part}_mesh`);
  }
  assert.ok([...nodes.values()].some(e => e.node.mesh !== undefined && e.node.name === 'body'), `${label}: body mesh`);
  assert.ok(triangleCount <= 12_000, `${label}: ${triangleCount} triangles within 12,000`);
  const length = bounds.max.z - bounds.min.z;
  assert.ok(length >= spec.length[0] && length <= spec.length[1], `${label}: length ${length.toFixed(3)} m`);
  assert.ok(bounds.max.x - bounds.min.x < 0.13, `${label}: width ${(bounds.max.x - bounds.min.x).toFixed(3)} m`);
  const grip = position(nodes.get('grip_r')), gripL = position(nodes.get('grip_l')), muzzle = position(nodes.get('muzzle'));
  const sight = position(nodes.get('sight')), eject = position(nodes.get('eject'));
  assert.ok(grip.length() < 1e-4, `${label}: the origin is the right palm grip point`);
  assert.ok(Math.abs(muzzle.x) < 1e-3 && muzzle.z - bounds.min.z < 0.03, `${label}: muzzle on the bore at the front`);
  assert.ok(muzzle.z < grip.z - 0.10 && muzzle.z < sight.z, `${label}: the weapon points along -Z`);
  assert.ok(Math.abs(sight.x) < 1e-3 && sight.y > muzzle.y + 0.004 && sight.y > grip.y + 0.04, `${label}: sight above the bore, on the centre line`);
  assert.ok(eject.x > 0.006, `${label}: ejection on the right`);
  if (id === 'sentry9') assert.ok(gripL.distanceTo(grip) < 0.06, `${label}: support hand wraps the firing hand`);
  else {
    assert.ok(gripL.z < grip.z - 0.15 && Math.abs(gripL.x) < 0.01, `${label}: support hand forward on the fore-end`);
    assert.ok(bounds.max.z > 0.18, `${label}: stock behind the grip`);
  }

  // Hands seated on their anchors: forearms run back to the shooter, and each fist closes round the
  // weapon's actual grip, handguard or pump (not just round its own palm point).
  const forearm = q => new Vector3(0, 0, 1).applyQuaternion(q);
  const right = forearm(rotation(nodes.get('grip_r'))), left = forearm(rotation(nodes.get('grip_l')));
  assert.ok(right.z > 0.5, `${label}: right forearm points back (${right.toArray().map(v => v.toFixed(2))})`);
  assert.ok(left.z > 0.2 && left.x < 0.1, `${label}: left forearm points back and left (${left.toArray().map(v => v.toFixed(2))})`);
  const seatedRight = placed(arms.arm_right.triangles, nodes.get('grip_r').matrix);
  const seatedLeft = placed(arms.arm_left.triangles, nodes.get('grip_l').matrix);
  const heldRight = arms.arm_right.heldAxis.clone().applyQuaternion(rotation(nodes.get('grip_r')));
  const heldLeft = arms.arm_left.heldAxis.clone().applyQuaternion(rotation(nodes.get('grip_l')));
  assert.ok(Math.abs(heldRight.y) > 0.85, `${label}: the firing fist holds an upright grip (${heldRight.toArray().map(v => v.toFixed(2))})`);
  const inGrip = around(grip, heldRight, triangles, 0.032);
  assert.ok(inGrip >= 11, `${label}: the pistol grip fills the firing fist (${inGrip}/12 rays meet it within 32 mm)`);
  const gloveRight = around(grip, heldRight, seatedRight, 0.06);
  assert.ok(gloveRight >= 8, `${label}: the seated firing glove closes round the grip (${gloveRight}/12)`);
  let inSupport;
  if (id === 'sentry9') {
    inSupport = around(gripL, heldLeft, [...triangles, ...seatedRight], 0.05);
    assert.ok(inSupport >= 9, `${label}: the support fist closes round the grip and firing hand (${inSupport}/12)`);
  } else {
    assert.ok(Math.abs(heldLeft.z) > 0.9, `${label}: the support fist holds a fore-end along the bore (${heldLeft.toArray().map(v => v.toFixed(2))})`);
    inSupport = around(gripL, heldLeft, triangles, 0.04);
    assert.ok(inSupport >= 10, `${label}: the handguard or pump fills the support fist (${inSupport}/12 rays meet it within 40 mm)`);
  }
  const gloveLeft = around(gripL, heldLeft, seatedLeft, 0.06);
  assert.ok(gloveLeft >= 7, `${label}: the seated support glove closes round its fore-end (${gloveLeft}/12)`);

  // Moving slide: neither seated hand may sit inside the slide anywhere along its travel.
  if (spec.slideTravel) {
    const slide = new Box3();
    for (const p of primitives) if (p.node === 'action_mesh') for (const v of p.positions) slide.expandByPoint(v);
    slide.max.z += spec.slideTravel;
    slide.expandByScalar(-0.0005);
    const inside = [...seatedRight, ...seatedLeft].flatMap(t => [t.a, t.b, t.c]).filter(v => slide.containsPoint(v)).length;
    assert.equal(inside, 0, `${label}: the hands stay clear of the slide through ${spec.slideTravel * 1000} mm of travel (${inside} glove vertices inside)`);
  }

  // Sight picture, with the eye on the line through the sight anchor along -Z.
  const eye = sight.clone().add(new Vector3(0, 0, spec.eye));
  const reach = sight.z - muzzle.z;
  if (spec.sight === 'scope') {
    const first = hits(triangles, eye, forward)[0];
    assert.ok(first && first.t.material === LENS, `${label}: the eye looks into the ocular lens`);
  } else if (spec.sight === 'reflex') {
    // Nothing solid between the eye and the target: rays parallel to the bore through the window,
    // 2-6 mm off the axis, may cross only see-through glass. A dark opaque lens fails here.
    for (const r of [0.002, 0.004, 0.006]) for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const blocked = hits(triangles, eye.clone().add(new Vector3(r * Math.cos(a), r * Math.sin(a), 0)), forward, solid);
      assert.equal(blocked.length, 0, `${label}: clear view through the sight ${(r * 1000).toFixed(0)} mm off the axis (blocked by ${blocked[0]?.t.node}/${blocked[0]?.t.material} ${(blocked[0]?.distance - spec.eye).toFixed(3)} m past the sight)`);
    }
    assert.ok(hits(triangles, eye.clone().add(new Vector3(0, 0.003, 0)), forward, t => t.see).length > 0, `${label}: the window holds see-through glass`);
    const first = hits(triangles, eye, forward)[0];
    assert.ok(first && GLOW.test(first.t.material) && Math.abs(first.distance - spec.eye) < 0.003, `${label}: the reticle dot is the first thing on the sight axis`);
    const dots = triangles.filter(t => GLOW.test(t.material));
    const centre = dots.reduce((sum, t) => sum.add(t.a).add(t.b).add(t.c), new Vector3()).divideScalar(Math.max(1, dots.length * 3));
    assert.ok(dots.length && Math.hypot(centre.x - sight.x, centre.y - sight.y) < 5e-4 && Math.abs(centre.z - sight.z) < 0.005, `${label}: reticle dot on the sight axis`);
  } else {
    // Clear just above the front sight's tip...
    for (const dx of [-0.0012, 0, 0.0012]) {
      const blocked = hits(triangles, eye.clone().add(new Vector3(dx, 0.0005, 0)), forward, solid);
      assert.equal(blocked.length, 0, `${label}: clear just above the sight line (blocked by ${blocked[0]?.t.node})`);
    }
    // ...the front post shows through the rear notch or ring: rays just under the line pass the rear
    // sight and stop on the post...
    for (const dy of [0.0005, 0.0010, 0.0015, 0.0020]) {
      const first = hits(triangles, eye.clone().add(new Vector3(0, -dy, 0)), forward, solid)[0];
      const past = first ? first.distance - spec.eye : NaN;
      assert.ok(first && past > 0.08 && past < reach + 0.01, `${label}: the front post shows through the rear sight ${(dy * 1000).toFixed(1)} mm under the line (stopped ${past.toFixed(3)} m past the rear sight by ${first?.t.node})`);
    }
    // ...with light on both sides of it...
    for (const side of [-1, 1]) {
      let light = false;
      for (let x = 0.0002; x <= 0.0030 && !light; x += 0.0002) {
        const direction = sight.clone().add(new Vector3(side * x, -0.001, 0)).sub(eye).normalize();
        light = hits(triangles, eye, direction, solid).length === 0;
      }
      assert.ok(light, `${label}: light shows ${side < 0 ? 'left' : 'right'} of the front post`);
    }
    // ...and every glowing sight dot faces the eye.
    const groups = [];
    for (const t of triangles.filter(t => GLOW.test(t.material))) {
      const c = t.a.clone().add(t.b).add(t.c).divideScalar(3);
      const group = groups.find(g => g.first.distanceTo(c) < 0.004);
      if (group) { group.sum.add(c); group.n++; } else groups.push({ first: c, sum: c.clone(), n: 1 });
    }
    for (const group of groups) {
      const target = group.sum.divideScalar(group.n);
      const first = hits(triangles, eye, target.clone().sub(eye).normalize())[0];
      assert.ok(first && GLOW.test(first.t.material), `${label}: the sight dot at ${target.toArray().map(v => v.toFixed(3))} is visible from the eye (hidden by ${first?.t.node})`);
    }
  }
  const drawCalls = primitives.length + 2;
  report[id] = { triangles: triangleCount, drawCallsWithArms: drawCalls, length: +length.toFixed(3), muzzle: muzzle.toArray().map(v => +v.toFixed(4)), sight: sight.toArray().map(v => +v.toFixed(4)),
    gripLeft: gripL.toArray().map(v => +v.toFixed(4)), seated: { grip: inGrip, support: inSupport } };
}

// --- Knife and frag ------------------------------------------------------------------------------
{
  assert.ok(knife.triangleCount <= 3000, `knife: ${knife.triangleCount} triangles`);
  const length = knife.bounds.max.z - knife.bounds.min.z;
  assert.ok(length > 0.25 && length < 0.35 && knife.bounds.min.z < -0.15 && knife.bounds.max.z < 0.10, `knife: ${length.toFixed(3)} m, blade toward -Z from the grip point`);
  const seat = knife.nodes.get('grip_r');
  assert.ok(seat && seat.node.extras?.anchor === 'grip_r', 'knife: grip_r anchor');
  const held = arms.arm_right.heldAxis.clone().applyQuaternion(rotation(seat));
  const inFist = around(position(seat), held, knife.triangles, 0.03);
  assert.ok(inFist >= 11, `knife: the handle fills the right fist (${inFist}/12)`);
  const frag = collect(rootIndex('frag'));
  checkTags('frag', frag.nodes);
  assert.ok(frag.triangleCount <= 3000, `frag: ${frag.triangleCount} triangles`);
  const size = frag.bounds.getSize(new Vector3());
  assert.ok([size.x, size.y, size.z].every(v => v > 0.05 && v < 0.13), `frag: ${size.toArray().map(v => v.toFixed(3))} m`);
  report.knife = { triangles: knife.triangleCount, length: +length.toFixed(3), rightFist: inFist };
  report.frag = { triangles: frag.triangleCount, size: size.toArray().map(v => +v.toFixed(3)) };
}

// --- Arms ----------------------------------------------------------------------------------------
for (const name of ['arm_left', 'arm_right']) {
  const { nodes, triangles, triangleCount, bounds, heldAxis } = arms[name];
  assert.ok(triangleCount <= 8000, `${name}: ${triangleCount} triangles within 8,000`);
  assert.ok(bounds.max.z > 0.30 && bounds.min.z > -0.16, `${name}: forearm runs toward +Z from the palm (${bounds.min.z.toFixed(3)} .. ${bounds.max.z.toFixed(3)})`);
  const spread = Math.max(-bounds.min.x, bounds.max.x, -bounds.min.y, bounds.max.y);
  assert.ok(spread < 0.16, `${name}: stays within 0.16 m of the forearm line (${spread.toFixed(3)} m)`);
  // The fist closes round its palm grip point: most rays across the held axis meet the glove.
  const wrapped = around(new Vector3(), heldAxis, triangles, 0.06);
  // The firing fist closes fully; the support hand leaves the top of the handguard open.
  const needed = name === 'arm_right' ? 8 : 7;
  assert.ok(wrapped >= needed, `${name}: hand wraps its palm grip point (${wrapped}/12 rays, need ${needed})`);
  report[name] = { triangles: triangleCount, reach: [+bounds.min.z.toFixed(3), +bounds.max.z.toFixed(3)], spread: +spread.toFixed(3), wrapped };
  const hold = nodes.get('hold');
  if (name === 'arm_left') {
    // `hold` is where the view model puts a held knife: its handle runs along the fist's held axis,
    // blade out of the thumb end, and fills the fist.
    assert.ok(hold && hold.node.mesh === undefined && hold.node.extras?.anchor === 'hold' && hold.parent === null, `${name}: hold anchor`);
    assert.ok(position(hold).length() < 1e-4, `${name}: hold sits at the palm grip point`);
    const blade = forward.clone().applyQuaternion(rotation(hold));
    assert.ok(blade.dot(heldAxis) > 0.98, `${name}: a held knife's blade runs along the held axis (${blade.dot(heldAxis).toFixed(3)})`);
    const inFist = around(new Vector3(), heldAxis, placed(knife.triangles, hold.matrix), 0.03);
    assert.ok(inFist >= 11, `${name}: a held knife's handle fills the fist (${inFist}/12)`);
    report[name].holdKnife = inFist;
  } else assert.equal(hold, undefined, `${name}: no hold node`);
}

if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.sha256, createHash('sha256').update(bytes).digest('hex'), 'manifest SHA-256 matches the file');
}
console.log(JSON.stringify({ file: glbPath, bytes: bytes.length, images: gltf.images.length, materials: gltf.materials.length, models: report }, null, 2));
console.log('KANNON_WEAPONS validation passed');
