/**
 * Extract the three ORIGINAL vehicles without re-authoring the town.
 * Run: node scripts/blender/split_vehicle_baseline.mjs [--check]
 *
 * Positions, normals, UVs, vertex colors and embedded image payloads are copied
 * byte-for-byte from environment.glb. Only index/vertex packing and dependency
 * indices change. This deliberately never runs generate_town.py.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const protectedFiles = {
  'public/models/environment.glb': '10bc88dfbf95e878225f60ed620bae0a8786ef8176f442f1dff15e39d1b62723',
  'shared/map.ts': 'be4c9ed551f132036b2d432959cd8b169434042ac637d1ce3feb97f15bb55f8b',
  'scripts/blender/generate_town.py': '7f0421d701cd087b3960e28ecd2ada10e8a5f987b7e21c8fc363962e4d5c5ddb',
};
const targets = [
  { id: 'bus', name: 'Vehicle_bus', min: [-4.2, -.03, -11.04], max: [-.65, 3.05, .51],
    expected: { TownPaint: 96, TownGlass: 252, TownRubber: 992, TownBronzeMetal: 1076, TownLimestoneTrim: 372 } },
  { id: 'south', name: 'Vehicle_south', min: [-6.37, -.001, 15.14], max: [-1.43, 1.78, 17.26],
    expected: { TownLimestoneSiding: 24, TownGlass: 24, TownRubber: 304, TownBronzeMetal: 24 } },
  { id: 'north', name: 'Vehicle_north', min: [1.53, -.001, -18.46], max: [6.47, 1.78, -16.34],
    expected: { TownLimestoneSiding: 24, TownGlass: 24, TownRubber: 304, TownBronzeMetal: 24 } },
];
const componentSize = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const componentRead = { 5120: 'readInt8', 5121: 'readUInt8', 5122: 'readInt16LE', 5123: 'readUInt16LE', 5125: 'readUInt32LE', 5126: 'readFloatLE' };
const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const clone = value => structuredClone(value);

export function readGlb(path) {
  const bytes = readFileSync(path);
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  assert.equal(bytes.readUInt32LE(jsonLength + 24), 0x004e4942);
  return { bytes, gltf: JSON.parse(bytes.subarray(20, 20 + jsonLength)), binary: bytes.subarray(28 + jsonLength) };
}

export function accessor(source, index) {
  const a = source.gltf.accessors[index], view = source.gltf.bufferViews[a.bufferView];
  assert.ok(!a.sparse && view.buffer === 0, 'Only unsparse embedded buffers are supported');
  const size = componentSize[a.componentType], width = components[a.type], bytes = size * width;
  assert.ok(size && width);
  const offset = (view.byteOffset ?? 0) + (a.byteOffset ?? 0), stride = view.byteStride ?? bytes;
  assert.ok(offset + (a.count - 1) * stride + bytes <= source.binary.length);
  const raw = row => source.binary.subarray(offset + row * stride, offset + row * stride + bytes);
  const values = row => Array.from({ length: width }, (_, col) => raw(row)[componentRead[a.componentType]](col * size));
  return { definition: a, raw, values, count: a.count, bytes };
}

function sourceRecords(source) {
  const { gltf } = source;
  // Source Blender export_yup already applied; no extra Blender-axis rotation.
  for (const n of gltf.nodes) if (n.mesh !== undefined || n.children) {
    assert.ok(!n.matrix && !n.rotation && !n.scale && !n.translation, `${n.name}: unexpected transform; audit before extracting`);
  }
  return gltf.meshes.flatMap((mesh, mi) => mesh.primitives.map((primitive, pi) => {
    assert.equal(primitive.mode ?? 4, 4);
    const position = accessor(source, primitive.attributes.POSITION);
    const index = accessor(source, primitive.indices);
    assert.equal(index.count % 3, 0);
    const groups = { environment: [], bus: [], south: [], north: [] };
    const material = gltf.materials[primitive.material].name;
    for (let t = 0; t < index.count / 3; t++) {
      const vertices = [0, 1, 2].map(c => index.values(t * 3 + c)[0]);
      const points = vertices.map(i => position.values(i));
      const owners = targets.filter(target => target.expected[material] !== undefined &&
        points.every(p => p.every((v, axis) => v >= target.min[axis] && v <= target.max[axis])));
      assert.ok(owners.length <= 1, `Ambiguous source triangle ${mi}:${pi}:${t}`);
      groups[owners[0]?.id ?? 'environment'].push(t);
    }
    return { mi, pi, meshName: mesh.name, nodeName: gltf.nodes.find(n => n.mesh === mi).name, primitive, groups };
  }));
}

function ranges(numbers) {
  const result = [];
  for (const n of numbers) {
    const previous = result.at(-1);
    if (previous && previous[1] + 1 === n) previous[1] = n;
    else result.push([n, n]);
  }
  return result;
}

function primitiveDigest(source, primitive, triangleIds) {
  const attributes = Object.entries(primitive.attributes).sort(([a], [b]) => a.localeCompare(b));
  const attributesData = attributes.map(([name, index]) => [name, accessor(source, index)]);
  const index = accessor(source, primitive.indices);
  const h = createHash('sha256');
  h.update(JSON.stringify(attributesData.map(([name, a]) => [name, a.definition.componentType, a.definition.type, a.definition.normalized ?? false])));
  for (const triangle of triangleIds) for (let corner = 0; corner < 3; corner++) {
    const vertex = index.values(triangle * 3 + corner)[0];
    for (const [, a] of attributesData) h.update(a.raw(vertex));
  }
  return h.digest('hex');
}

function pack(source, records, groups) {
  const gltf = clone(source.gltf);
  gltf.asset.generator = 'Kannon vehicle test: byte-exact baseline extraction';
  gltf.accessors = []; gltf.bufferViews = []; gltf.meshes = [];
  const parts = []; let byteLength = 0;
  function view(data, target) {
    const padded = Buffer.alloc(Math.ceil(data.length / 4) * 4); data.copy(padded);
    const id = gltf.bufferViews.length;
    gltf.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: data.length, ...(target ? { target } : {}) });
    parts.push(padded); byteLength += padded.length; return id;
  }
  function addAccessor(data, definition, count, target) {
    const item = clone(definition); delete item.byteOffset; delete item.min; delete item.max;
    item.bufferView = view(data, target); item.count = count;
    if (definition.type === 'VEC3' && definition.min && definition.max) {
      item.min = [Infinity, Infinity, Infinity]; item.max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < count; i++) for (let c = 0; c < 3; c++) {
        const v = data.readFloatLE((i * 3 + c) * 4); item.min[c] = Math.min(item.min[c], v); item.max[c] = Math.max(item.max[c], v);
      }
    }
    return gltf.accessors.push(item) - 1;
  }
  const materialIds = [...new Set(records.filter(r => groups.some(g => r.groups[g].length)).map(r => r.primitive.material))].sort((a, b) => a - b);
  const textureIds = new Set();
  function visitTextures(item, action) {
    for (const [key, value] of Object.entries(item)) if (value && typeof value === 'object') {
      if (key.endsWith('Texture') && Number.isInteger(value.index)) action(value);
      else visitTextures(value, action);
    }
  }
  gltf.materials = materialIds.map(i => clone(source.gltf.materials[i]));
  for (const material of gltf.materials) visitTextures(material, info => textureIds.add(info.index));
  const textureOrder = [...textureIds].sort((a, b) => a - b);
  const imageOrder = [...new Set(textureOrder.map(i => source.gltf.textures[i].source))].sort((a, b) => a - b);
  gltf.textures = textureOrder.map(i => ({ ...clone(source.gltf.textures[i]), source: imageOrder.indexOf(source.gltf.textures[i].source) }));
  for (const material of gltf.materials) visitTextures(material, info => { info.index = textureOrder.indexOf(info.index); });
  const outputRecords = [];
  if (groups.length === 1 && groups[0] === 'environment') {
    gltf.nodes = clone(source.gltf.nodes);
  } else {
    gltf.nodes = [{ name: 'Vehicles_current', children: [1, 2, 3] }, ...targets.map(t => ({ name: t.name, children: [] }))];
    gltf.scenes = [{ name: 'Vehicles_current', nodes: [0] }]; gltf.scene = 0;
  }
  for (const group of groups) for (const record of records) {
    const selected = record.groups[group]; if (!selected.length) continue;
    const originalIndices = accessor(source, record.primitive.indices);
    const vertexIds = new Map(); const remapped = [];
    for (const t of selected) for (let c = 0; c < 3; c++) {
      const id = originalIndices.values(t * 3 + c)[0];
      if (!vertexIds.has(id)) vertexIds.set(id, vertexIds.size);
      remapped.push(vertexIds.get(id));
    }
    const primitive = clone(record.primitive); primitive.attributes = {};
    for (const [name, original] of Object.entries(record.primitive.attributes)) {
      const a = accessor(source, original);
      primitive.attributes[name] = addAccessor(Buffer.concat([...vertexIds.keys()].map(id => a.raw(id))), a.definition, vertexIds.size, 34962);
    }
    const indexType = vertexIds.size > 65535 ? 5125 : 5123;
    const indexBytes = Buffer.alloc(remapped.length * componentSize[indexType]);
    remapped.forEach((v, i) => indexBytes[indexType === 5125 ? 'writeUInt32LE' : 'writeUInt16LE'](v, i * componentSize[indexType]));
    primitive.indices = addAccessor(indexBytes, { componentType: indexType, type: 'SCALAR' }, remapped.length, 34963);
    primitive.material = materialIds.indexOf(record.primitive.material);
    const meshIndex = gltf.meshes.length;
    const name = group === 'environment' ? record.meshName : `Vehicle_${group}_${record.meshName}`;
    gltf.meshes.push({ name, primitives: [primitive] });
    if (group === 'environment') gltf.nodes.find(n => n.name === record.nodeName).mesh = meshIndex;
    else {
      const parent = gltf.nodes.find(n => n.name === `Vehicle_${group}`);
      parent.children.push(gltf.nodes.length); gltf.nodes.push({ name, mesh: meshIndex });
    }
    outputRecords.push({ group, sourceMesh: record.mi, sourcePrimitive: record.pi, mesh: meshIndex, primitive: 0,
      originalMaterial: record.primitive.material, material: primitive.material, triangles: selected.length,
      sourceTriangleRanges: ranges(selected), attributeBytesSha256: primitiveDigest(source, record.primitive, selected) });
  }
  gltf.images = imageOrder.map(i => {
    const image = clone(source.gltf.images[i]); assert.equal(image.uri, undefined);
    const originalView = source.gltf.bufferViews[image.bufferView];
    image.bufferView = view(source.binary.subarray(originalView.byteOffset ?? 0, (originalView.byteOffset ?? 0) + originalView.byteLength));
    return image;
  });
  gltf.buffers = [{ byteLength }];
  const binary = Buffer.concat(parts);
  const jsonBytes = Buffer.from(JSON.stringify(gltf));
  const json = Buffer.alloc(Math.ceil(jsonBytes.length / 4) * 4, 0x20); jsonBytes.copy(json);
  const header = Buffer.alloc(20); header.write('glTF'); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + json.length + binary.length, 8); header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const binaryHeader = Buffer.alloc(8); binaryHeader.writeUInt32LE(binary.length); binaryHeader.writeUInt32LE(0x004e4942, 4);
  return { bytes: Buffer.concat([header, json, binaryHeader, binary]), records: outputRecords,
    materialMap: materialIds, textureMap: textureOrder, imageMap: imageOrder };
}

function verifyOutput(source, output, packed) {
  // Independent readback: hash every corner attribute in indexed draw order.
  for (const record of packed.records) {
    const p = output.gltf.meshes[record.mesh].primitives[record.primitive];
    assert.equal(primitiveDigest(output, p, Array.from({ length: record.triangles }, (_, i) => i)), record.attributeBytesSha256,
      `${record.group}/${record.sourceMesh}: geometry attribute bytes changed`);
    assert.equal(p.material, record.material);
  }
  for (const [newId, originalId] of packed.materialMap.entries()) {
    const material = clone(output.gltf.materials[newId]);
    function restoreTextures(item) {
      for (const [key, value] of Object.entries(item)) if (value && typeof value === 'object') {
        if (key.endsWith('Texture') && Number.isInteger(value.index)) value.index = packed.textureMap[value.index];
        else restoreTextures(value);
      }
    }
    restoreTextures(material); assert.deepEqual(material, source.gltf.materials[originalId]);
  }
  for (const [newId, originalId] of packed.imageMap.entries()) {
    const image = output.gltf.images[newId], original = source.gltf.images[originalId];
    const view = output.gltf.bufferViews[image.bufferView], originalView = source.gltf.bufferViews[original.bufferView];
    assert.deepEqual(output.binary.subarray(view.byteOffset, view.byteOffset + view.byteLength),
      source.binary.subarray(originalView.byteOffset, originalView.byteOffset + originalView.byteLength));
  }
}

export function splitBaseline(checkOnly = false) {
  for (const [path, expected] of Object.entries(protectedFiles)) assert.equal(hash(readFileSync(new URL(path, root))), expected, `${path} differs from the reviewed baseline`);
  const source = readGlb(new URL('public/models/environment.glb', root));
  const records = sourceRecords(source);
  const perTarget = targets.map(target => {
    const counts = {}; const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const r of records) if (r.groups[target.id].length) {
      const material = source.gltf.materials[r.primitive.material].name;
      counts[material] = (counts[material] ?? 0) + r.groups[target.id].length;
      const positions = accessor(source, r.primitive.attributes.POSITION), indices = accessor(source, r.primitive.indices);
      for (const t of r.groups[target.id]) for (let c = 0; c < 3; c++) positions.values(indices.values(t * 3 + c)[0]).forEach((v, axis) => {
        min[axis] = Math.min(min[axis], v); max[axis] = Math.max(max[axis], v);
      });
    }
    assert.deepEqual(counts, target.expected, `${target.id}: selection must match the reviewed generator component census`);
    return { id: target.id, group: target.name, triangles: Object.values(counts).reduce((a, b) => a + b, 0), originalMaterials: counts, actualVisualBounds: { min, max }, selectionBounds: { min: target.min, max: target.max } };
  });
  const outputSpecs = [
    ['public/models/environment-vehicle-test.glb', ['environment']],
    ['public/models/vehicles-current.glb', ['bus', 'south', 'north']],
  ];
  const outputs = [];
  for (const [path, groups] of outputSpecs) {
    const packed = pack(source, records, groups);
    if (!checkOnly) writeFileSync(new URL(path, root), packed.bytes);
    const output = readGlb(new URL(path, root));
    assert.deepEqual(output.bytes, packed.bytes, `${path}: reproducible binary must match`);
    verifyOutput(source, output, packed);
    if (groups[0] === 'environment') assert.deepEqual(output.gltf.nodes, source.gltf.nodes, 'All original collision-reference nodes and town transforms stay identical');
    outputs.push({ path, bytes: output.bytes.length, sha256: hash(output.bytes), triangles: packed.records.reduce((n, r) => n + r.triangles, 0), primitives: packed.records.length,
      materialMap: packed.materialMap.map((originalId, id) => ({ id, originalId, name: source.gltf.materials[originalId].name, originalJsonSha256: hash(JSON.stringify(source.gltf.materials[originalId])) })),
      images: packed.imageMap.map((originalId, id) => { const original = source.gltf.images[originalId], view = source.gltf.bufferViews[original.bufferView]; return { id, originalId, name: original.name, bytes: view.byteLength, sha256: hash(source.binary.subarray(view.byteOffset, view.byteOffset + view.byteLength)) }; }),
      trianglePartitions: packed.records });
  }
  const originalTriangles = records.reduce((n, r) => n + accessor(source, r.primitive.indices).count / 3, 0);
  assert.equal(outputs.reduce((n, o) => n + o.triangles, 0), originalTriangles);
  // Every source triangle is represented exactly once across the two outputs.
  for (const r of records) {
    const represented = Object.values(r.groups).flat().sort((a, b) => a - b);
    assert.deepEqual(represented, Array.from({ length: accessor(source, r.primitive.indices).count / 3 }, (_, i) => i));
  }
  const manifest = { schema: 1, status: 'passed', method: 'Byte-exact indexed triangle extraction; no Blender regeneration or numeric attribute conversion',
    axes: 'glTF/game XYZ, all original mesh transforms identity', protectedFiles, original: { bytes: source.bytes.length, triangles: originalTriangles, primitives: records.length },
    originalCollisionReferences: source.gltf.nodes.filter(n => n.name?.startsWith('Collision_')).length,
    targets: perTarget, outputs,
    guarantees: ['Every source triangle appears exactly once across both outputs.', 'All indexed vertex attributes are byte-identical in original triangle order within each partition.', 'All used material values, vertex-color formats, UVs, normals and embedded image payloads are unchanged.', 'The common base retains all original collision reference nodes, cargo truck and all non-target map triangles.', 'Original environment.glb, generate_town.py and shared/map.ts remain unchanged.'],
    caveats: ['The old visual details protrude beyond gameplay collision boxes. Their exact baseline is preserved; new vehicle geometry must fit the original collision union.', 'Splitting the original 13 material batches adds 13 current-vehicle draw primitives. This extraction overhead must be stated separately from before/after model cost.'] };
  const manifestPath = new URL('art/source/vehicle-test-baseline.json', root);
  if (checkOnly) assert.deepEqual(JSON.parse(readFileSync(manifestPath)), manifest);
  else writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { status: manifest.status, original: manifest.original, targets: perTarget.map(({ id, triangles }) => ({ id, triangles })), outputs: outputs.map(({ path, bytes, triangles, primitives }) => ({ path, bytes, triangles, primitives })) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`))) {
  console.log(JSON.stringify(splitBaseline(process.argv.includes('--check')), null, 2));
}
