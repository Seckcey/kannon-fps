/** Validate the shipped Kannon Town v3 environment (both tiers): collision guides and witness
 *  faces for every box; render geometry that fills the eight checkpoint cover boxes and the three
 *  crate stacks, sampled every 5 cm over every exposed face, with no deep seam, no see-through
 *  slit and nothing hanging outside; open doors, windows and truck entry; breakable glass and
 *  pots as separate named nodes; lightmap UVs with a shade level in every lightmap's alpha; KTX2
 *  textures; decoration against walkable space; the golden-hour calibration record; and the
 *  byte, triangle and draw-call budgets. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Ray, Vector3 } from 'three';
import { hash } from './split_vehicle_baseline.mjs';
import { readGeometry } from './read_refined_glb.mjs';

const root = new URL('../../', import.meta.url), path = p => new URL(p, root);
const map = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(path('scripts/blender/export_map.ts'))], { cwd: fileURLToPath(root), encoding: 'utf8' }));
const BUDGETS = {
  full: { file: 'public/models/environment-v3.glb', manifest: 'art/source/town-v3/environment-v3-manifest.json', bytes: 30_000_000, texture: 2048 },
  phone: { file: 'public/models/environment-v3-phone.glb', manifest: 'art/source/town-v3/environment-v3-phone-manifest.json', bytes: 14_000_000, texture: 1024 },
};
const MAX_TRIANGLES = 470_000, MAX_PRIMITIVES = 100;
const ARENA = { x: 30.9, z: 22.9 };
const vehicleIds = new Set(['school-bus-body', 'school-bus-hood', 'south-car', 'south-car-cabin', 'north-car', 'north-car-cabin']);
// The eight v3 cover boxes, frozen in shared/map.ts.
const checkpoint = map.obstacles.filter(o => o.surface === 'sandbag' || o.surface === 'barrier');
// Cover boxes whose plain block became a stack of ammunition crates; every side must be filled.
const filled = new Set(['north-mail-crates', 'teal-yard-cover', 'yellow-yard-cover']);
// Decoration allowed in walkable space without collision (small street furniture, flat to a wall,
// or flat on the ground), matched by material-name prefix because the export merges props.
const WALK_THROUGH_ALLOWED = ['Prop_trash_can_', 'Prop_trashbag_', 'Prop_bench_', 'Prop_hand_truck_', 'Prop_generator_', 'Prop_propane_', 'Prop_utility_box_',
  'Prop_ladder_', 'Prop_hose_', 'Prop_manhole_', 'Prop_hydrant_', 'Prop_picnic_table_', 'Prop_patio_set_', 'Prop_wheel_rim_', 'V2_GrassCard', 'V2_Leaves',
  'V3_Pot', 'V3_Boards', 'V3_Cone'];
// Exposed-face sampling: a ray every 5 cm, 3 cm in from the face's edges.
const SPACING = 0.05, EDGE = 0.03;

/** A KTX2 file's Basis ETC1S data has a second (alpha) slice: its DFD lists two samples, the
 *  second with the ETC1S AAA channel id (15). */
function ktx2HasAlpha(bytes) {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.toString('latin1', 1, 7), 'KTX 20', 'KTX2 identifier');
  const dfd = view.readUInt32LE(48);
  const blockSize = view.readUInt32LE(dfd + 8) >>> 16;
  const samples = (blockSize - 24) / 16;
  const channel = index => (view.readUInt32LE(dfd + 4 + 24 + index * 16) >>> 24) & 0x0f;
  return samples === 2 && channel(1) === 15;
}

/** Ray origins over a box face: every SPACING metres, EDGE metres in from its edges. */
function faceGrid(o, axis, sign, outside) {
  const size = [o.w, o.h, o.d], centre = [o.x, o.y, o.z];
  const [a, b] = [0, 1, 2].filter(i => i !== axis);
  const steps = i => Math.max(1, Math.floor((size[i] - 2 * EDGE) / SPACING));
  const points = [];
  for (let i = 0; i <= steps(a); i++) for (let j = 0; j <= steps(b); j++) {
    const origin = [...centre];
    origin[axis] += sign * (size[axis] / 2 + outside);
    origin[a] += -size[a] / 2 + EDGE + (size[a] - 2 * EDGE) * i / steps(a);
    origin[b] += -size[b] / 2 + EDGE + (size[b] - 2 * EDGE) * j / steps(b);
    points.push(origin);
  }
  return points;
}
const isDressing = t => /^(Prop_|V3_)/.test(t.material);
const isFoliage = t => t.material.startsWith('V2_GrassCard') || t.material.startsWith('V2_Leaves');
const UNSOLID = /^(V3_Decals|V3_Smoke)/; // multiply decals and distant smoke never block a view

function insideBox(p, o, pad = 0.05) {
  return Math.abs(p.x - o.x) <= o.w / 2 + pad && Math.abs(p.y - o.y) <= o.h / 2 + pad && Math.abs(p.z - o.z) <= o.d / 2 + pad;
}
const nearTruck = (p, pad) => map.obstacles.some(o => o.surface === 'truck' && Math.abs(p.x - o.x) <= o.w / 2 + pad && Math.abs(p.z - o.z) <= o.d / 2 + pad && p.y <= o.y + o.h / 2 + pad);

async function validate(tier) {
  const budget = BUDGETS[tier];
  const manifest = JSON.parse(readFileSync(path(budget.manifest)));
  const release = await readGeometry(path(budget.file), true);
  const { gltf, world, triangles, primitives, bytes } = release;
  assert.equal(hash(bytes), manifest.sha256, `${tier}: manifest SHA-256 matches the file`);
  assert.ok(bytes.length <= budget.bytes, `${tier}: ${bytes.length} bytes within ${budget.bytes}`);
  assert.ok(triangles.length <= MAX_TRIANGLES, `${tier}: ${triangles.length} triangles within ${MAX_TRIANGLES}`);
  assert.ok(primitives <= MAX_PRIMITIVES, `${tier}: ${primitives} primitives (draw calls) within ${MAX_PRIMITIVES}`);
  assert.ok(gltf.extensionsRequired.includes('EXT_meshopt_compression') && gltf.extensionsRequired.includes('KHR_texture_basisu'));
  assert.ok(gltf.extensionsUsed.includes('KANNON_lightmap'));
  assert.equal(gltf.animations?.length ?? 0, 0); assert.equal(gltf.cameras?.length ?? 0, 0); assert.ok(!gltf.extensions?.KHR_lights_punctual);

  // Every image is KTX2 within the tier's size limit.
  for (const image of gltf.images) {
    assert.equal(image.mimeType, 'image/ktx2', `${image.name ?? image.uri}: ktx2`);
    assert.equal(image.uri, undefined);
  }
  for (const texture of manifest.textures) assert.ok(Math.max(...texture.size) <= budget.texture, `${tier}: texture ${texture.name} ${texture.size} within ${budget.texture}`);

  // Lightmapped materials reference a KTX2 atlas on TEXCOORD_1, and their primitives carry it.
  let lightmapped = 0;
  for (const mesh of gltf.meshes) for (const primitive of mesh.primitives) {
    const material = gltf.materials[primitive.material];
    const lightmap = material?.extensions?.KANNON_lightmap;
    if (!lightmap) continue;
    lightmapped++;
    assert.equal(lightmap.texture.texCoord, 1);
    assert.ok(lightmap.intensity > 0 && lightmap.intensity < 20);
    assert.notEqual(primitive.attributes.TEXCOORD_1, undefined, `${mesh.name}: lightmapped primitive has TEXCOORD_1`);
    const accessor = gltf.accessors[primitive.attributes.TEXCOORD_1];
    if (accessor.min && accessor.max) {
      assert.ok(accessor.min.every(v => v >= -1e-3) && accessor.max.every(v => v <= 1 + 1e-3 || accessor.componentType !== 5126), `${mesh.name}: TEXCOORD_1 within the atlas`);
    }
  }
  assert.ok(lightmapped >= 50, `${tier}: ${lightmapped} lightmapped primitives`);
  // Every lightmap carries its shade level in alpha, and says so, so real-time shadows remove
  // only baked sun (src/game/Lightmaps.ts).
  const imageBytes = index => { const view = gltf.bufferViews[gltf.images[index].bufferView]; return release.binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength); };
  const shadeAtlases = new Set();
  for (const material of gltf.materials) {
    const lightmap = material.extensions?.KANNON_lightmap;
    if (!lightmap) continue;
    assert.equal(lightmap.extras?.shadeAlpha, true, `${material.name}: lightmap declares its shade alpha`);
    const image = gltf.textures[lightmap.texture.index].extensions?.KHR_texture_basisu?.source;
    assert.ok(Number.isInteger(image) && ktx2HasAlpha(imageBytes(image)), `${material.name}: lightmap KTX2 keeps its alpha channel`);
    shadeAtlases.add(image);
  }
  assert.deepEqual(manifest.shadeAlpha, ['LM_arch', 'LM_foliage', 'LM_ground', 'LM_pots', 'LM_props'], `${tier}: every atlas has a shade level`);
  const materialNamed = prefix => gltf.materials.find(m => m.name?.startsWith(prefix));
  for (const name of ['V3_WindowGlass', 'V3_Smoke']) assert.equal(materialNamed(name)?.alphaMode, 'BLEND', `${name} is alpha blended`);
  for (const name of ['V3_WindowGlass', 'V3_Smoke', 'V3_Decals']) assert.ok(!materialNamed(name)?.extensions?.KANNON_lightmap, `${name} is not lightmapped`);

  // Golden-hour calibration travelled with the file's manifest.
  const calibration = manifest.calibration;
  assert.ok(calibration && calibration.sunDirection.length === 3 && calibration.lightMapIntensity > 0, `${tier}: calibration recorded`);
  const elevation = Math.asin(calibration.sunDirection[1] / Math.hypot(...calibration.sunDirection)) * 180 / Math.PI;
  assert.ok(elevation > 12 && elevation < 30, `${tier}: low golden-hour sun (${elevation.toFixed(1)} deg)`);

  // Collision guides for every obstacle, positioned exactly.
  assert.equal(gltf.nodes.filter(n => n.name?.startsWith('Collision_')).length, map.obstacles.length);
  for (const o of map.obstacles) {
    const n = gltf.nodes.find(n => n.name === `Collision_${o.id}`); assert.ok(n, o.id);
    assert.ok(new Vector3().setFromMatrixPosition(world.get(n.name)).distanceTo(new Vector3(o.x, o.y, o.z)) < 1e-3, `${o.id} guide position`);
    assert.deepEqual(n.extras.sizeXYZ, [o.w, o.h, o.d]);
    assert.equal(n.extras.kannonGuide, true);
  }

  const visible = triangles.filter(t => !t.node.startsWith('Collision_') && !UNSOLID.test(t.material));
  // Breakables are cosmetic: shots and players pass through them, so openings ignore them.
  const solid = visible.filter(t => !t.node.startsWith('Breakable_'));
  const ray = new Ray(), hit = new Vector3();
  function intersections(origin, direction, limit, set = solid) {
    ray.set(new Vector3().fromArray(origin), new Vector3().fromArray(direction)); const distances = [];
    for (const { points: [a, b, c] } of set) if (ray.intersectTriangle(a, b, c, false, hit)) { const d = hit.distanceTo(ray.origin); if (d <= limit) distances.push(d); }
    return distances;
  }

  /** Cast a ray every 5 cm at every exposed face of a box (sides and top) and find where it first
   *  meets `set`: the offset from the collision face, positive in front of it. A ray that meets
   *  nothing within the box has found a see-through slit. */
  function sampleFaces(o, set, inside, outside) {
    const report = { rays: 0, bad: 0, through: 0, deepest: Infinity, worst: null };
    for (let axis = 0; axis < 3; axis++) {
      // Axis-aligned rays only meet triangles whose projection covers their origin: bucket them.
      const [a, b] = [0, 1, 2].filter(i => i !== axis), cell = 0.1, buckets = new Map();
      for (const t of set) {
        const pa = t.points.map(p => p.getComponent(a)), pb = t.points.map(p => p.getComponent(b));
        for (let i = Math.floor(Math.min(...pa) / cell); i <= Math.floor(Math.max(...pa) / cell); i++) for (let j = Math.floor(Math.min(...pb) / cell); j <= Math.floor(Math.max(...pb) / cell); j++) {
          const key = `${i},${j}`; if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(t);
        }
      }
      for (const sign of [-1, 1]) {
        if (axis === 1 && sign < 0) continue;
        const size = [o.w, o.h, o.d][axis], direction = [0, 0, 0]; direction[axis] = -sign;
        for (const origin of faceGrid(o, axis, sign, 0.3)) {
          const near = buckets.get(`${Math.floor(origin[a] / cell)},${Math.floor(origin[b] / cell)}`) ?? [];
          const offset = 0.3 - Math.min(Infinity, ...intersections(origin, direction, 0.3 + size, near));
          report.rays++;
          if (offset === -Infinity) report.through++;
          if (offset < -inside || offset > outside) { report.bad++; report.worst ??= { axis, sign, origin: origin.map(v => +v.toFixed(3)), offset }; }
          report.deepest = Math.min(report.deepest, offset);
        }
      }
    }
    return report;
  }

  // Witness faces: v2's rule for architecture and the rest of the cover; the crate stacks and the
  // checkpoint cover are sampled densely below.
  let witnessed = 0;
  const dressing = solid.filter(isDressing);
  for (const o of map.obstacles.filter(o => !vehicleIds.has(o.id) && !checkpoint.includes(o) && !filled.has(o.id))) for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
    const origin = [o.x, o.y, o.z], size = [o.w, o.h, o.d], direction = [0, 0, 0];
    origin[axis] += sign * (size[axis] / 2 + 0.04); direction[axis] = -sign;
    // 16-bit quantized positions sit within a millimetre of the collision face.
    assert.ok(intersections(origin, direction, 0.081).some(d => d <= 0.043), `Missing witness face: ${o.id}, axis ${axis}, sign ${sign}`); witnessed++;
  }

  // Crate stacks: every ray must meet a crate, the tarp or what rests on top within 10 cm behind
  // the collision face, so no part of the box blocks shots without something visible there.
  const stackReport = [];
  for (const o of map.obstacles.filter(o => filled.has(o.id))) {
    const near = dressing.filter(t => t.points.some(p => insideBox(p, o, 0.3)));
    const report = sampleFaces(o, near, 0.1, Infinity);
    assert.equal(report.bad, 0, `${o.id}: ${report.bad} of ${report.rays} rays find nothing within 10 cm of the collision face (${report.through} see through; first ${JSON.stringify(report.worst)})`);
    stackReport.push(`${o.id} ${report.rays} rays, deepest ${(-report.deepest * 100).toFixed(1)} cm`);
  }

  // Checkpoint cover: a ray every 5 cm over every exposed face must meet the sandbags or concrete
  // within a few centimetres of the collision face: no invisible lip, no deep seam, no slit.
  const coverReport = [];
  for (const o of checkpoint) {
    const material = o.surface === 'sandbag' ? 'V3_Burlap' : 'V3_Barrier';
    const own = solid.filter(t => t.material.startsWith(material) && insideBox(t.points[0], o, 0.2));
    const [inside, outside] = o.surface === 'sandbag' ? [0.055, 0.05] : [0.06, 0.04];
    const report = sampleFaces(o, own, inside, outside);
    assert.equal(report.bad, 0, `${o.id}: ${report.bad} of ${report.rays} rays meet the ${o.surface} more than ${inside * 100} cm behind or ${outside * 100} cm in front of the collision face (${report.through} see through; first ${JSON.stringify(report.worst)})`);
    // Nothing of this cover hangs far outside its box.
    for (const t of own) for (const p of t.points) assert.ok(insideBox(p, o, 0.07), `${o.id}: ${material} vertex outside its box at ${p.toArray().map(v => v.toFixed(2))}`);
    coverReport.push(`${o.id} ${report.rays} rays, deepest ${(-report.deepest * 100).toFixed(1)} cm`);
  }

  // Doors, windows and the truck entrance stay open to players and shots.
  const openings = [];
  for (const side of [-1, 1]) for (const [x, y, z, label] of [[side * 8.5, 1.35, -2.25, 'front door'], [side * 8.5, 4.8, 0, 'upstairs window'], [side * 8.5, 1.35, 9.75, 'garage door'], [side * 23.5, 4.6, 4.2, 'balcony door']]) {
    assert.equal(intersections([x, y, z], [label === 'balcony door' ? -side : side, 0, 0], 2.4).length, 0, `${label} stays open`); openings.push(`${side}:${label}`);
  }
  assert.equal(intersections([2.65, 1.2, 11.5], [0, 0, -1], 1.6).length, 0, 'truck entrance stays open');

  // Breakables: separate named nodes, one primitive each, where the runtime expects them.
  const breakableNodes = gltf.nodes.filter(n => /^Breakable_/.test(n.name ?? ''));
  const glass = breakableNodes.filter(n => n.name.startsWith('Breakable_Glass_')), pots = breakableNodes.filter(n => n.name.startsWith('Breakable_Pot_'));
  assert.ok(glass.length >= 6, `${tier}: ${glass.length} breakable panes`);
  assert.ok(pots.length >= 4, `${tier}: ${pots.length} breakable pots`);
  for (const n of breakableNodes) {
    assert.notEqual(n.mesh, undefined, `${n.name} has a mesh`);
    assert.equal(gltf.meshes[n.mesh].primitives.length, 1, `${n.name} is one draw`);
    const own = triangles.filter(t => t.node === n.name);
    assert.ok(own.length > 0, `${n.name} has triangles`);
    const xs = own.flatMap(t => t.points.map(p => p.x)), ys = own.flatMap(t => t.points.map(p => p.y)), zs = own.flatMap(t => t.points.map(p => p.z));
    const [cx, cy, cz] = [xs, ys, zs].map(v => (Math.min(...v) + Math.max(...v)) / 2);
    if (n.name.startsWith('Breakable_Glass_')) {
      assert.ok(Math.abs(Math.abs(cx) - 9.75) < 0.05 && cy > 4.15 && cy < 5.85 && Math.abs(cz) < 3.4, `${n.name} sits in an upstairs street window`);
      assert.ok(gltf.materials[gltf.meshes[n.mesh].primitives[0].material].name.startsWith('V3_WindowGlass'));
    } else {
      assert.ok(Math.max(...ys) - Math.min(...ys) < 1.2 && Math.max(...xs) - Math.min(...xs) < 0.8, `${n.name} is pot sized`);
      assert.ok(Math.abs(cx) <= ARENA.x && Math.abs(cz) <= ARENA.z, `${n.name} is inside the arena`);
    }
  }

  // Distant smoke stays far outside the arena; decals lie on the ground.
  const smoke = triangles.filter(t => t.material.startsWith('V3_Smoke'));
  assert.ok(smoke.length >= 4, `${tier}: smoke columns present`);
  for (const t of smoke) for (const p of t.points) assert.ok(Math.hypot(p.x, p.z) > 120, `smoke at ${Math.hypot(p.x, p.z).toFixed(0)} m stays distant`);
  const decals = triangles.filter(t => t.material.startsWith('V3_Decals'));
  assert.ok(decals.length > 100, `${tier}: decals present`);
  for (const t of decals) for (const p of t.points) assert.ok(p.y > -0.06 && p.y < 0.08, `decal vertex at height ${p.y.toFixed(3)} lies on the ground`);

  // Decoration standing in walkable space must be on the documented allowance.
  const obstacles = map.obstacles.filter(o => o.surface !== 'fence');
  const offenders = new Map();
  for (const t of visible) {
    if (!(isDressing(t) || isFoliage(t)) || UNSOLID.test(t.material)) continue;
    for (const p of t.points) {
      if (Math.abs(p.x) > ARENA.x || Math.abs(p.z) > ARENA.z || p.y > 2.05 || p.y < 0.12) continue;
      if (obstacles.some(o => insideBox(p, o))) continue;
      // Small props resting on top of cover (a box on a crate, a tarp over the crates) are fine.
      if (obstacles.some(o => Math.abs(p.x - o.x) <= o.w / 2 + 0.05 && Math.abs(p.z - o.z) <= o.d / 2 + 0.05 && p.y >= o.y + o.h / 2 - 0.02 && p.y <= o.y + o.h / 2 + 0.6)) continue;
      // Truck fittings (bumper, lamps, mirrors, steps) cling to the truck's boxes.
      if (nearTruck(p, 0.45)) continue;
      offenders.set(t.material, (offenders.get(t.material) ?? 0) + 1);
    }
  }
  for (const material of offenders.keys()) assert.ok(WALK_THROUGH_ALLOWED.some(prefix => material.startsWith(prefix)), `${material} occupies walkable space without an allowance`);

  console.log(`${tier}: ${bytes.length} bytes, ${triangles.length} triangles, ${primitives} primitives, ${gltf.images.length} ktx2 images, ${lightmapped} lightmapped primitives (${shadeAtlases.size} atlases with shade alpha), ${witnessed} witness faces, checkpoint cover [${coverReport.join(', ')}], crate stacks [${stackReport.join(', ')}], ${openings.length} openings open, ${glass.length} panes and ${pots.length} pots breakable, sun ${elevation.toFixed(1)} deg, walk-through decoration: ${[...offenders.keys()].join(', ') || 'none'}`);
}

await validate('full');
await validate('phone');
console.log('KANNON_TOWN_V3 validation passed');
