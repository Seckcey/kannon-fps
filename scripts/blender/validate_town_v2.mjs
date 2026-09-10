/** Validate the shipped Kannon Town v2 environment: collision witness faces, open doors and
 *  windows, lightmap UVs, texture formats, prop placement against walkable space, and the
 *  byte, triangle and texture budgets for both tiers. */
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
  full: { file: 'public/models/environment-v2.glb', manifest: 'art/source/town-v2/environment-v2-manifest.json', bytes: 30_000_000, texture: 4096 },
  phone: { file: 'public/models/environment-v2-phone.glb', manifest: 'art/source/town-v2/environment-v2-phone-manifest.json', bytes: 13_000_000, texture: 2048 },
};
const ARENA = { x: 30.9, z: 22.9 };
const vehicleIds = new Set(['school-bus-body', 'school-bus-hood', 'south-car', 'south-car-cabin', 'north-car', 'north-car-cabin']);
// Props that stand in walkable space without collision, by design (small, wall-hugging or flat),
// matched by material name prefix because the export merges every prop into one mesh.
const WALK_THROUGH_ALLOWED = ['Prop_potted_plant_', 'Prop_trash_can_', 'Prop_trashbag_', 'Prop_bench_', 'Prop_hand_truck_', 'Prop_generator_', 'Prop_propane_', 'Prop_utility_box_', 'Prop_ladder_', 'Prop_hose_', 'Prop_manhole_', 'Prop_hydrant_', 'Prop_picnic_table_', 'Prop_patio_set_', 'Prop_wheel_rim_', 'V2_GrassCard', 'V2_Leaves'];
const isProp = t => t.material.startsWith('Prop_');
const isFoliage = t => t.material.startsWith('V2_GrassCard') || t.material.startsWith('V2_Leaves');

function insideBox(p, o, pad = 0.05) {
  return Math.abs(p.x - o.x) <= o.w / 2 + pad && Math.abs(p.y - o.y) <= o.h / 2 + pad && Math.abs(p.z - o.z) <= o.d / 2 + pad;
}

async function validate(tier) {
  const budget = BUDGETS[tier];
  const manifest = JSON.parse(readFileSync(path(budget.manifest)));
  const release = await readGeometry(path(budget.file), true);
  const { gltf, world, triangles, primitives, bytes } = release;
  assert.equal(hash(bytes), manifest.sha256, `${tier}: manifest SHA-256 matches the file`);
  assert.ok(bytes.length <= budget.bytes, `${tier}: ${bytes.length} bytes within ${budget.bytes}`);
  assert.ok(triangles.length <= 420_000, `${tier}: ${triangles.length} triangles within budget`);
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
  const materialIndex = new Map(gltf.materials.map((m, i) => [i, m]));
  for (const mesh of gltf.meshes) for (const primitive of mesh.primitives) {
    const material = materialIndex.get(primitive.material);
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
  assert.ok(lightmapped >= 40, `${tier}: ${lightmapped} lightmapped primitives`);

  // Collision guides for every obstacle, positioned exactly.
  assert.equal(gltf.nodes.filter(n => n.name?.startsWith('Collision_')).length, map.obstacles.length);
  for (const o of map.obstacles) {
    const n = gltf.nodes.find(n => n.name === `Collision_${o.id}`); assert.ok(n, o.id);
    assert.ok(new Vector3().setFromMatrixPosition(world.get(n.name)).distanceTo(new Vector3(o.x, o.y, o.z)) < 1e-3, `${o.id} guide position`);
    assert.deepEqual(n.extras.sizeXYZ, [o.w, o.h, o.d]);
    assert.equal(n.extras.kannonGuide, true);
  }

  // Visible witness faces on every non-vehicle collision box, and open doors, windows and truck entry.
  const solid = triangles.filter(t => !t.node.startsWith('Collision_'));
  const ray = new Ray(), hit = new Vector3();
  function intersections(origin, direction, limit, set = solid) {
    ray.set(new Vector3().fromArray(origin), new Vector3().fromArray(direction)); const distances = [];
    for (const { points: [a, b, c] } of set) if (ray.intersectTriangle(a, b, c, false, hit)) { const d = hit.distanceTo(ray.origin); if (d <= limit) distances.push(d); }
    return distances;
  }
  let witnessed = 0;
  // Three cover boxes swapped their plain wood block for stacked props; every side and the top
  // must still hit something visible inside the box so the collision never feels invisible.
  const filled = new Set(['north-mail-crates', 'teal-yard-cover', 'yellow-yard-cover']);
  for (const o of map.obstacles.filter(o => !vehicleIds.has(o.id))) for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
    const origin = [o.x, o.y, o.z], size = [o.w, o.h, o.d], direction = [0, 0, 0];
    origin[axis] += sign * (size[axis] / 2 + 0.04); direction[axis] = -sign;
    if (filled.has(o.id)) {
      if (axis === 1 && sign < 0) continue;
      // Three rays across the face, low down for the sides; at least two must meet a prop
      // (not the ground) inside the box.
      const across = axis === 0 ? 2 : 0;
      const props = solid.filter(isProp);
      const hits = [-0.25, 0, 0.25].filter(f => {
        const start = [...origin]; start[across] += f * size[across];
        if (axis !== 1) start[1] = o.y - o.h / 2 + 0.3;
        return intersections(start, direction, size[axis] + 0.05, props).length > 0;
      }).length;
      assert.ok(hits >= 2, `Too little visible inside ${o.id} from axis ${axis}, sign ${sign} (${hits}/3 rays)`); witnessed++;
      continue;
    }
    // 16-bit quantized positions sit within a millimetre of the collision face.
    assert.ok(intersections(origin, direction, 0.081).some(d => d <= 0.043), `Missing witness face: ${o.id}, axis ${axis}, sign ${sign}`); witnessed++;
  }
  const openings = [];
  for (const side of [-1, 1]) for (const [x, y, z, label] of [[side * 8.5, 1.35, -2.25, 'front door'], [side * 8.5, 4.8, 0, 'upstairs window'], [side * 8.5, 1.35, 9.75, 'garage door'], [side * 23.5, 4.6, 4.2, 'balcony door']]) {
    assert.equal(intersections([x, y, z], [label === 'balcony door' ? -side : side, 0, 0], 2.4).length, 0, `${label} stays open`); openings.push(`${side}:${label}`);
  }
  assert.equal(intersections([2.65, 1.2, 11.5], [0, 0, -1], 1.6).length, 0, 'truck entrance stays open');

  // Props: anything standing in walkable space must be on the documented allowance.
  const obstacles = map.obstacles.filter(o => o.surface !== 'fence');
  const offenders = new Map();
  for (const t of triangles) {
    if (!(isProp(t) || isFoliage(t))) continue;
    for (const p of t.points) {
      if (Math.abs(p.x) > ARENA.x || Math.abs(p.z) > ARENA.z || p.y > 2.05 || p.y < 0.12) continue;
      if (obstacles.some(o => insideBox(p, o))) continue;
      // Small props resting on top of cover (a box on a crate, a tyre on a barrel) are fine.
      if (obstacles.some(o => Math.abs(p.x - o.x) <= o.w / 2 + 0.05 && Math.abs(p.z - o.z) <= o.d / 2 + 0.05 && p.y >= o.y + o.h / 2 - 0.02 && p.y <= o.y + o.h / 2 + 0.6)) continue;
      offenders.set(t.material, (offenders.get(t.material) ?? 0) + 1);
    }
  }
  for (const material of offenders.keys()) assert.ok(WALK_THROUGH_ALLOWED.some(prefix => material.startsWith(prefix)), `${material} occupies walkable space without an allowance`);
  // Draw calls: one primitive per material family.
  assert.ok(primitives <= 80, `${tier}: ${primitives} primitives (draw calls) within budget`);

  console.log(`${tier}: ${bytes.length} bytes, ${triangles.length} triangles, ${primitives} primitives, ${gltf.images.length} ktx2 images, ${lightmapped} lightmapped primitives, ${witnessed} witness faces, ${openings.length} openings open, walk-through props: ${[...offenders.keys()].join(', ') || 'none'}`);
}

await validate('full');
await validate('phone');
console.log('KANNON_TOWN_V2 validation passed');
