import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { OBSTACLES } from '../../shared/map.js';
import { SMOKE_SWAY, castsRealtimeShadow, swayOffset } from '../../src/game/World.js';

/** Fast checks on the shipped Kannon Town v3 files that other workstreams build against: every
 *  collision box has its guide, breakables are separate named nodes, blended and unlit
 *  materials are marked, real-time shadows and wind behave on the shipped data, and both tiers
 *  fit their download budgets. The geometric proofs (witness faces, dense cover sampling, open
 *  doors) run in scripts/blender/validate_town_v3.mjs. */
interface GltfNode { name?: string; mesh?: number; translation?: number[]; rotation?: number[]; scale?: number[]; children?: number[]; extras?: { sizeXYZ?: number[]; kannonGuide?: boolean } }
interface Primitive { material: number; indices?: number; attributes: Record<string, number> }
interface Accessor { bufferView: number; byteOffset?: number; componentType: number; normalized?: boolean; count: number; type: string }
interface BufferView { byteOffset?: number; byteLength: number; byteStride?: number; extensions?: { EXT_meshopt_compression?: { byteOffset?: number; byteLength: number; byteStride: number; count: number; mode: string; filter?: string } } }
interface Gltf {
  nodes: GltfNode[]; meshes: Array<{ primitives: Primitive[] }>;
  materials: Array<{ name: string; alphaMode?: string; extensions?: Record<string, { extras?: { shadeAlpha?: unknown }; texture?: { index: number } }> }>;
  textures: Array<{ extensions?: { KHR_texture_basisu?: { source: number } } }>;
  extensionsRequired: string[]; extensionsUsed: string[]; images: Array<{ mimeType?: string; bufferView: number }>;
  accessors: Accessor[]; bufferViews: BufferView[];
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
const binaryChunk = (glb: Buffer) => glb.subarray(28 + glb.readUInt32LE(12));

/** One accessor of the GLB, Meshopt-decoded and de-normalised, as rows of numbers. */
async function accessor(gltf: Gltf, bin: Buffer, index: number): Promise<number[][]> {
  await MeshoptDecoder.ready;
  const a = gltf.accessors[index]!, view = gltf.bufferViews[a.bufferView]!, meshopt = view.extensions?.EXT_meshopt_compression;
  let bytes: Uint8Array = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  if (meshopt) {
    bytes = new Uint8Array(meshopt.count * meshopt.byteStride);
    MeshoptDecoder.decodeGltfBuffer(bytes, meshopt.count, meshopt.byteStride, bin.subarray(meshopt.byteOffset ?? 0, (meshopt.byteOffset ?? 0) + meshopt.byteLength), meshopt.mode as never, meshopt.filter as never);
  }
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = ({ 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 } as Record<number, number>)[a.componentType]!;
  const width = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as Record<string, number>)[a.type]!;
  const stride = view.byteStride ?? size * width, offset = a.byteOffset ?? 0;
  const value = (at: number) => ({ 5120: () => data.getInt8(at), 5121: () => data.getUint8(at), 5122: () => data.getInt16(at, true), 5123: () => data.getUint16(at, true), 5125: () => data.getUint32(at, true), 5126: () => data.getFloat32(at, true) } as Record<number, () => number>)[a.componentType]!();
  const divisor = a.normalized ? ({ 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 } as Record<number, number>)[a.componentType]! : 1;
  return Array.from({ length: a.count }, (_, i) => Array.from({ length: width }, (_, j) => value(offset + i * stride + j * size) / divisor));
}

/** A KTX2 Basis ETC1S image with an alpha slice lists two DFD samples, the second ETC1S AAA (15). */
function ktx2HasAlpha(bytes: Uint8Array): boolean {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.toString('latin1', 1, 7), 'KTX 20');
  const dfd = view.readUInt32LE(48), samples = ((view.readUInt32LE(dfd + 8) >>> 16) - 24) / 16;
  return samples === 2 && ((view.readUInt32LE(dfd + 4 + 24 + 16) >>> 24) & 0x0f) === 15;
}

for (const { tier, file, manifest: manifestPath, budget } of TIERS) {
  const bytes = read(file);
  const gltf = json(bytes);
  const bin = binaryChunk(bytes);
  const manifest = JSON.parse(read(manifestPath).toString('utf8')) as { sha256: string; bytes: number; breakables: string[]; shadeAlpha: string[] };
  const primitivesOf = (nodeName: string) => gltf.meshes[gltf.nodes.find(node => node.name === nodeName)!.mesh!]!.primitives;

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

  test(`${tier}: breakable glass and pots are separate single-draw nodes; two panes start broken`, () => {
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
    // An intact pane is a thin box (12 triangles); a broken one keeps a jagged ring of shards.
    const triangles = (node: GltfNode) => gltf.accessors[gltf.meshes[node.mesh!]!.primitives[0]!.indices!]!.count / 3;
    assert.deepEqual(glass.filter(node => triangles(node) > 60).map(node => node.name).sort(), ['Breakable_Glass_1', 'Breakable_Glass_3']);
  });

  test(`${tier}: decals and smoke are unlit runtime materials; the dressing is lightmapped`, () => {
    const named = (prefix: string) => gltf.materials.filter(material => material.name.startsWith(prefix));
    for (const prefix of ['V3_Decals', 'V3_Smoke', 'V3_WindowGlass', 'V3_Wire']) {
      assert.ok(named(prefix).length >= 1, `${prefix} present`);
      for (const material of named(prefix)) assert.equal(material.extensions?.KANNON_lightmap, undefined, `${material.name} not lightmapped`);
    }
    assert.equal(named('V3_Smoke')[0]!.alphaMode, 'BLEND');
    for (const prefix of ['V3_Burlap', 'V3_Barrier', 'V3_Canvas', 'V3_Paint', 'V3_Burnt', 'V3_BusPaint', 'V3_Boards', 'V3_Pot', 'V3_Cone']) {
      assert.ok(named(prefix).length >= 1, `${prefix} present`);
      assert.ok(named(prefix).every(material => material.extensions?.KANNON_lightmap), `${prefix} lightmapped`);
    }
  });

  test(`${tier}: every lightmap carries its shade level in a KTX2 alpha channel`, () => {
    const atlases = new Set<number>();
    for (const material of gltf.materials) {
      const lightmap = material.extensions?.KANNON_lightmap;
      if (!lightmap) continue;
      assert.equal(lightmap.extras?.shadeAlpha, true, `${material.name} declares its shade level`);
      atlases.add(gltf.textures[lightmap.texture!.index]!.extensions!.KHR_texture_basisu!.source);
    }
    assert.equal(atlases.size, 5, 'architecture, ground, foliage, props and pots atlases');
    for (const image of atlases) {
      const view = gltf.bufferViews[gltf.images[image]!.bufferView]!;
      assert.ok(ktx2HasAlpha(bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)), `image ${image} keeps its alpha`);
    }
    assert.deepEqual(manifest.shadeAlpha, ['LM_arch', 'LM_foliage', 'LM_ground', 'LM_pots', 'LM_props']);
  });

  test(`${tier}: only the pots and grass cards cast real-time shadows, decided per mesh`, () => {
    // Build the meshes the way GLTFLoader does: one shared material per glTF material, one mesh
    // per primitive, grouped under the node when a node has several.
    const materials = gltf.materials.map(definition => {
      const material = new THREE.MeshStandardMaterial(); material.name = definition.name;
      if (definition.extensions?.KANNON_lightmap) material.lightMap = new THREE.Texture();
      return material;
    });
    const casting: string[] = [];
    for (const node of gltf.nodes) {
      if (node.mesh === undefined) continue;
      const primitives = gltf.meshes[node.mesh]!.primitives;
      const meshes = primitives.map((primitive, i) => {
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), materials[primitive.material]!);
        mesh.name = primitives.length === 1 ? node.name! : `${node.name}_${i}`; return mesh;
      });
      if (meshes.length > 1) { const group = new THREE.Group(); group.name = node.name!; group.add(...meshes); }
      for (const mesh of meshes) if (castsRealtimeShadow(mesh)) casting.push(`${node.name}:${(mesh.material as THREE.Material).name}`);
    }
    assert.deepEqual(casting.sort(), ['Breakable_Pot_0:V3_Pot', 'Breakable_Pot_1:V3_Pot', 'Breakable_Pot_2:V3_Pot', 'Breakable_Pot_3:V3_Pot', 'Foliage:V2_GrassCard']);
  });

  test(`${tier}: the smoke columns sway in world metres at the shipped node scale`, async () => {
    const node = gltf.nodes.find(n => n.name === 'Smoke')!;
    assert.equal(node.rotation, undefined);
    const [tx, ty, tz] = node.translation!, [sx, sy, sz] = node.scale!;
    const local = await accessor(gltf, bin, primitivesOf('Smoke')[0]!.attributes.POSITION!);
    // The quantised positions sit in the node's unit box, which is why the old shader that read
    // `position.y` barely moved; the world positions are what the sway now reads.
    assert.ok(local.every(p => p.every(c => Math.abs(c) <= 1)) && sy > 100);
    const world = local.map(([x, y, z]) => ({ x: tx! + sx! * x!, y: ty! + sy! * y!, z: tz! + sz! * z! }));
    const peak = (p: { x: number; y: number; z: number }) => { let most = 0; for (let t = 0; t < 120; t += 0.25) { const o = swayOffset(SMOKE_SWAY, p, t); most = Math.max(most, Math.hypot(o.x, o.z)); } return most; };
    const bases = world.filter(p => p.y < 0), tops = world.filter(p => p.y > 50);
    assert.equal(bases.length, 8); assert.equal(tops.length, 8);
    for (const p of bases) assert.ok(peak(p) < 0.01, `a column base at ${p.y.toFixed(1)} m stays put`);
    for (const p of tops) assert.ok(peak(p) > 1.5, `a column top at ${p.y.toFixed(0)} m drifts ${peak(p).toFixed(2)} m`);
  });

  test(`${tier}: wire and grass cards carry per-vertex sun visibility in their colour alpha`, async () => {
    const colours = async (node: string, material: string) => {
      const primitive = primitivesOf(node).find(p => gltf.materials[p.material]!.name.startsWith(material))!;
      return accessor(gltf, bin, primitive.attributes.COLOR_0!);
    };
    for (const [node, material, range] of [['Props', 'V3_Wire', [0.1, 0.6]], ['Foliage', 'V2_GrassCard', [0.05, 0.8]]] as const) {
      const rows = await colours(node, material);
      assert.ok(rows.every(colour => colour.length === 4), `${material} colours have an alpha channel`);
      const visibility = rows.map(colour => colour[3]!);
      assert.ok(visibility.every(v => v < 0.02 || v > 0.98), `${material}: each vertex either sees the sun or does not`);
      const shaded = visibility.filter(v => v < 0.5).length / visibility.length;
      assert.ok(shaded > range[0] && shaded < range[1], `${material}: ${(shaded * 100).toFixed(0)}% of vertices in shade`);
      if (material === 'V3_Wire') assert.ok(rows.every(colour => colour.slice(0, 3).every(c => c > 0.98)), 'the wire keeps its own colour');
    }
  });
}
