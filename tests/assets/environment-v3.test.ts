import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { OBSTACLES } from '../../shared/map.js';

/** Fast checks on the shipped Kannon Town v3 files that other workstreams build against: every
 *  collision box has its guide, breakables are separate named nodes, blended and unlit
 *  materials are marked, and both tiers fit their download budgets. The geometric proofs
 *  (witness faces, cover fill, open doors) run in scripts/blender/validate_town_v3.mjs. */
interface GltfNode { name?: string; mesh?: number; translation?: number[]; extras?: { sizeXYZ?: number[]; kannonGuide?: boolean } }
interface Gltf {
  nodes: GltfNode[]; meshes: Array<{ primitives: Array<{ material: number; attributes: Record<string, number> }> }>;
  materials: Array<{ name: string; alphaMode?: string; extensions?: Record<string, unknown> }>;
  extensionsRequired: string[]; extensionsUsed: string[]; images: Array<{ mimeType?: string }>;
}
const TIERS = [
  { tier: 'full', file: 'public/models/environment-v3.glb', manifest: 'art/source/town-v3/environment-v3-manifest.json', budget: 30_000_000 },
  { tier: 'phone', file: 'public/models/environment-v3-phone.glb', manifest: 'art/source/town-v3/environment-v3-phone-manifest.json', budget: 14_000_000 },
] as const;
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url));
function json(glb: Buffer): Gltf {
  assert.equal(glb.readUInt32LE(0), 0x46546c67, 'glTF binary');
  const length = glb.readUInt32LE(12);
  assert.equal(glb.readUInt32LE(16), 0x4e4f534a, 'JSON chunk first');
  return JSON.parse(glb.subarray(20, 20 + length).toString('utf8')) as Gltf;
}

for (const { tier, file, manifest: manifestPath, budget } of TIERS) {
  const bytes = read(file);
  const gltf = json(bytes);
  const manifest = JSON.parse(read(manifestPath).toString('utf8')) as { sha256: string; bytes: number; breakables: string[] };

  test(`${tier}: the file is the one its manifest describes and fits its budget`, () => {
    assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256);
    assert.equal(bytes.byteLength, manifest.bytes);
    assert.ok(bytes.byteLength <= budget, `${bytes.byteLength} bytes within ${budget}`);
    assert.ok(gltf.extensionsRequired.includes('EXT_meshopt_compression') && gltf.extensionsRequired.includes('KHR_texture_basisu'));
    assert.ok(gltf.extensionsUsed.includes('KANNON_lightmap'));
    assert.ok(gltf.images.every(image => image.mimeType === 'image/ktx2'));
  });

  test(`${tier}: every collision box, including the eight checkpoint covers, has an exact guide`, () => {
    const guides = new Map(gltf.nodes.filter(node => node.name?.startsWith('Collision_')).map(node => [node.name!.slice('Collision_'.length), node]));
    assert.equal(guides.size, OBSTACLES.length);
    const checkpoint = OBSTACLES.filter(o => o.surface === 'sandbag' || o.surface === 'barrier');
    assert.equal(checkpoint.length, 8);
    for (const o of OBSTACLES) {
      const guide = guides.get(o.id);
      assert.ok(guide, `guide for ${o.id}`);
      assert.deepEqual(guide.extras?.sizeXYZ, [o.w, o.h, o.d]);
      assert.equal(guide.extras?.kannonGuide, true);
      const [x, y, z] = guide.translation ?? [0, 0, 0];
      assert.ok(Math.hypot(x! - o.x, y! - o.y, z! - o.z) < 1e-3, `${o.id} guide position`);
    }
  });

  test(`${tier}: breakable glass and pots are separate single-draw nodes`, () => {
    const breakables = gltf.nodes.filter(node => /^Breakable_(Glass|Pot)_\d+$/.test(node.name ?? ''));
    const glass = breakables.filter(node => node.name!.startsWith('Breakable_Glass_'));
    const pots = breakables.filter(node => node.name!.startsWith('Breakable_Pot_'));
    assert.ok(glass.length >= 6, `${glass.length} panes`);
    assert.ok(pots.length >= 4, `${pots.length} pots`);
    assert.deepEqual(breakables.map(node => node.name).sort(), [...manifest.breakables].sort());
    for (const node of breakables) {
      assert.notEqual(node.mesh, undefined, `${node.name} has a mesh`);
      assert.equal(gltf.meshes[node.mesh!]!.primitives.length, 1, `${node.name} is one draw call`);
    }
    for (const node of glass) {
      const material = gltf.materials[gltf.meshes[node.mesh!]!.primitives[0]!.material]!;
      assert.ok(material.name.startsWith('V3_WindowGlass'));
      assert.equal(material.alphaMode, 'BLEND');
    }
  });

  test(`${tier}: decals and smoke are unlit runtime materials; the dressing is lightmapped`, () => {
    const named = (prefix: string) => gltf.materials.filter(material => material.name.startsWith(prefix));
    for (const prefix of ['V3_Decals', 'V3_Smoke', 'V3_WindowGlass']) {
      assert.ok(named(prefix).length >= 1, `${prefix} present`);
      for (const material of named(prefix)) assert.equal(material.extensions?.KANNON_lightmap, undefined, `${material.name} not lightmapped`);
    }
    assert.equal(named('V3_Smoke')[0]!.alphaMode, 'BLEND');
    for (const prefix of ['V3_Burlap', 'V3_Barrier', 'V3_Canvas', 'V3_Paint', 'V3_Burnt', 'V3_BusPaint', 'V3_Boards', 'V3_Pot']) {
      assert.ok(named(prefix).length >= 1, `${prefix} present`);
      assert.ok(named(prefix).every(material => material.extensions?.KANNON_lightmap), `${prefix} lightmapped`);
    }
  });
}
