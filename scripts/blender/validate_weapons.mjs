/** Validate the shipped first-person weapons file against its contract (docs/WEAPONS_ART.md):
 *  root and child node names, anchors and where they sit, clear sight lines, arms that wrap their
 *  palm grip point, bounds, triangle budgets, KTX2 textures, Meshopt geometry and the 6 MB budget.
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

/** Contract and plausibility limits. Lengths are along glTF Z (the bore axis), metres. */
const WEAPONS = {
  kr5: { root: 'weapon_kr5', length: [0.78, 0.95], sight: 'reflex' },
  hornet9: { root: 'weapon_hornet9', length: [0.50, 0.72], sight: 'reflex' },
  breaker12: { root: 'weapon_breaker12', length: [0.85, 1.05], sight: 'iron' },
  longbow: { root: 'weapon_longbow', length: [1.05, 1.30], sight: 'scope' },
  sentry9: { root: 'weapon_sentry9', length: [0.17, 0.23], sight: 'iron' },
};
const ROOTS = ['weapon_kr5', 'weapon_hornet9', 'weapon_breaker12', 'weapon_longbow', 'weapon_sentry9', 'knife', 'frag', 'arm_left', 'arm_right'];
const ANCHORS = ['grip_r', 'grip_l', 'muzzle', 'sight', 'eject'];
const FLAT = /^WeaponLens$|^WeaponGlow/;

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
  const nodes = new Map(), triangles = [], bounds = new Box3();
  let triangleCount = 0;
  const primitives = [];
  (function visit(index, parent) {
    const node = gltf.nodes[index];
    const matrix = index === rootIndex ? new Matrix4() : new Matrix4().multiplyMatrices(parent, localMatrix(node));
    if (index !== rootIndex) {
      assert.ok(!nodes.has(node.name), `${gltf.nodes[rootIndex].name}: node name ${node.name} is unique within its root`);
      nodes.set(node.name, { node, matrix });
    }
    if (node.mesh !== undefined) for (const p of gltf.meshes[node.mesh].primitives) {
      assert.equal(p.mode ?? 4, 4, 'triangle lists');
      const material = gltf.materials[p.material];
      const positions = accessor(p.attributes.POSITION).map(v => new Vector3().fromArray(v).applyMatrix4(matrix));
      for (const attribute of ['NORMAL', 'TEXCOORD_0']) assert.notEqual(p.attributes[attribute], undefined, `${node.name}: ${attribute}`);
      const ids = accessor(p.indices).flat();
      triangleCount += ids.length / 3;
      for (let i = 0; i < ids.length; i += 3) triangles.push({ a: positions[ids[i]], b: positions[ids[i + 1]], c: positions[ids[i + 2]], material: material.name, node: node.name });
      for (const v of positions) { assert.ok([v.x, v.y, v.z].every(Number.isFinite), `${node.name}: finite positions`); bounds.expandByPoint(v); }
      primitives.push({ node: node.name, material, positions });
    }
    for (const child of node.children ?? []) visit(child, matrix);
  })(rootIndex, new Matrix4());
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

// --- Scene and materials -------------------------------------------------------------------------
const scene = gltf.scenes[gltf.scene ?? 0];
const rootNodes = scene.nodes.map(i => gltf.nodes[i]);
assert.deepEqual(rootNodes.map(n => n.name).sort(), [...ROOTS].sort(), 'scene roots are exactly the contract roots');
for (const node of rootNodes) {
  assert.ok(!node.mesh, `${node.name}: root is a transform, not a mesh`);
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
  if (FLAT.test(material.name)) {
    if (material.name.startsWith('WeaponGlow')) assert.ok(Math.max(...(material.emissiveFactor ?? [0])) > 0, `${material.name}: glows`);
    continue;
  }
  const pbr = material.pbrMetallicRoughness ?? {};
  assert.ok(pbr.baseColorTexture && pbr.metallicRoughnessTexture && material.normalTexture && material.occlusionTexture, `${material.name}: baked colour, ORM and normal maps`);
}

// --- Weapons -------------------------------------------------------------------------------------
const report = {};
const rootIndex = name => scene.nodes.find(i => gltf.nodes[i].name === name);
for (const [id, spec] of Object.entries(WEAPONS)) {
  const { nodes, triangles, triangleCount, bounds } = collect(rootIndex(spec.root));
  const label = spec.root;
  for (const name of ANCHORS) {
    const entry = nodes.get(name);
    assert.ok(entry, `${label}: anchor ${name}`);
    assert.equal(entry.node.mesh, undefined, `${label}: ${name} is an empty`);
    assert.equal(entry.node.extras?.anchor, name, `${label}: ${name} carries extras.anchor`);
    assert.ok(Math.abs(rotation(entry).length() - 1) < 1e-4, `${label}: ${name} rotation is a unit quaternion`);
  }
  for (const part of ['mag', 'action']) {
    const entry = nodes.get(part);
    assert.ok(entry, `${label}: ${part} pivot`);
    assert.equal(entry.node.extras?.part, part, `${label}: ${part} carries extras.part`);
    assert.ok((entry.node.children ?? []).some(c => gltf.nodes[c].mesh !== undefined), `${label}: ${part} holds a mesh`);
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
  // Seated arms run back toward the shooter: right forearm back, left forearm back and to the left.
  const forearm = q => new Vector3(0, 0, 1).applyQuaternion(q);
  const right = forearm(rotation(nodes.get('grip_r'))), left = forearm(rotation(nodes.get('grip_l')));
  assert.ok(right.z > 0.5, `${label}: right forearm points back (${right.toArray().map(v => v.toFixed(2))})`);
  assert.ok(left.z > 0.2 && left.x < 0.1, `${label}: left forearm points back and left (${left.toArray().map(v => v.toFixed(2))})`);
  // Sight picture.
  const opaque = t => !FLAT.test(t.material);
  const forward = new Vector3(0, 0, -1);
  const reach = sight.z - muzzle.z;
  if (spec.sight === 'scope') {
    const first = hits(triangles, sight.clone().add(new Vector3(0, 0, 0.02)), forward)[0];
    assert.ok(first && FLAT.test(first.t.material), `${label}: the eye looks into the ocular lens`);
  } else {
    const clear = hits(triangles, sight.clone().add(new Vector3(0, 0.0004, 0.002)), forward, opaque).filter(h => h.distance < reach);
    assert.equal(clear.length, 0, `${label}: clear sight line (blocked by ${clear[0]?.t.node} at ${clear[0]?.distance.toFixed(3)} m)`);
    if (spec.sight === 'iron') {
      const post = hits(triangles, sight.clone().add(new Vector3(0, -0.0015, 0.002)), forward, opaque).filter(h => h.distance > 0.08 && h.distance < reach + 0.01);
      assert.ok(post.length > 0, `${label}: front sight sits on the sight line`);
    } else {
      const dots = triangles.filter(t => t.material.startsWith('WeaponGlow'));
      const centre = dots.reduce((sum, t) => sum.add(t.a).add(t.b).add(t.c), new Vector3()).divideScalar(Math.max(1, dots.length * 3));
      assert.ok(dots.length && Math.hypot(centre.x - sight.x, centre.y - sight.y) < 5e-4 && Math.abs(centre.z - sight.z) < 0.005, `${label}: reticle dot on the sight axis`);
    }
  }
  const mag = collect(rootIndex(spec.root)).primitives.filter(p => p.node === 'mag_mesh');
  assert.ok(mag.length > 0, `${label}: magazine mesh`);
  report[id] = { triangles: triangleCount, length: +length.toFixed(3), muzzle: muzzle.toArray().map(v => +v.toFixed(4)), sight: sight.toArray().map(v => +v.toFixed(4)), gripLeft: gripL.toArray().map(v => +v.toFixed(4)) };
}

// --- Knife and frag ------------------------------------------------------------------------------
{
  const knife = collect(rootIndex('knife'));
  assert.ok(knife.triangleCount <= 3000, `knife: ${knife.triangleCount} triangles`);
  const length = knife.bounds.max.z - knife.bounds.min.z;
  assert.ok(length > 0.25 && length < 0.35 && knife.bounds.min.z < -0.15 && knife.bounds.max.z < 0.10, `knife: ${length.toFixed(3)} m, blade toward -Z from the grip point`);
  const frag = collect(rootIndex('frag'));
  assert.ok(frag.triangleCount <= 3000, `frag: ${frag.triangleCount} triangles`);
  const size = frag.bounds.getSize(new Vector3());
  assert.ok([size.x, size.y, size.z].every(v => v > 0.05 && v < 0.13), `frag: ${size.toArray().map(v => v.toFixed(3))} m`);
  report.knife = { triangles: knife.triangleCount, length: +length.toFixed(3) };
  report.frag = { triangles: frag.triangleCount, size: size.toArray().map(v => +v.toFixed(3)) };
}

// --- Arms ----------------------------------------------------------------------------------------
for (const name of ['arm_left', 'arm_right']) {
  const index = rootIndex(name);
  const { nodes, triangles, triangleCount, bounds } = collect(index);
  assert.ok(nodes.get('arm')?.node.mesh !== undefined, `${name}: arm mesh`);
  assert.ok(triangleCount <= 8000, `${name}: ${triangleCount} triangles within 8,000`);
  assert.ok(bounds.max.z > 0.30 && bounds.min.z > -0.16, `${name}: forearm runs toward +Z from the palm (${bounds.min.z.toFixed(3)} .. ${bounds.max.z.toFixed(3)})`);
  const spread = Math.max(-bounds.min.x, bounds.max.x, -bounds.min.y, bounds.max.y);
  assert.ok(spread < 0.16, `${name}: stays within 0.16 m of the forearm line (${spread.toFixed(3)} m)`);
  const axis = new Vector3().fromArray(gltf.nodes[index].extras?.heldAxis ?? [0, 0, 0]);
  assert.ok(Math.abs(axis.length() - 1) < 1e-3, `${name}: extras.heldAxis is a unit vector`);
  // The fist closes round its palm grip point: most rays across the held axis meet the glove.
  const u = new Vector3(1, 0, 0).cross(axis).lengthSq() > 0.1 ? new Vector3(1, 0, 0).cross(axis).normalize() : new Vector3(0, 1, 0).cross(axis).normalize();
  const v = axis.clone().cross(u).normalize();
  let wrapped = 0;
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const direction = u.clone().multiplyScalar(Math.cos(a)).addScaledVector(v, Math.sin(a));
    if (hits(triangles, new Vector3(), direction).some(h => h.distance < 0.06)) wrapped++;
  }
  // The firing fist closes fully; the support hand leaves the top of the handguard open.
  const needed = name === 'arm_right' ? 8 : 7;
  assert.ok(wrapped >= needed, `${name}: hand wraps its palm grip point (${wrapped}/12 rays, need ${needed})`);
  report[name] = { triangles: triangleCount, reach: [+bounds.min.z.toFixed(3), +bounds.max.z.toFixed(3)], spread: +spread.toFixed(3), wrapped };
}

if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.sha256, createHash('sha256').update(bytes).digest('hex'), 'manifest SHA-256 matches the file');
}
console.log(JSON.stringify({ file: glbPath, bytes: bytes.length, images: gltf.images.length, materials: gltf.materials.length, models: report }, null, 2));
console.log('KANNON_WEAPONS validation passed');
