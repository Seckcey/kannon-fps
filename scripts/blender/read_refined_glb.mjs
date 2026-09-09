/** Decode the exact Meshopt export before inspecting its world-space triangles. */
import assert from 'node:assert/strict';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { readGlb } from './split_vehicle_baseline.mjs';

export async function readGeometry(path, requireColor = false) {
  const source = readGlb(path), { gltf, binary } = source;
  await MeshoptDecoder.ready;
  const views = gltf.bufferViews.map(v => {
    const e = v.extensions?.EXT_meshopt_compression;
    if (!e) { assert.equal(v.buffer, 0); return binary.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength); }
    assert.equal(e.buffer, 0);
    const result = Buffer.alloc(e.count * e.byteStride);
    MeshoptDecoder.decodeGltfBuffer(result, e.count, e.byteStride, binary.subarray(e.byteOffset ?? 0, (e.byteOffset ?? 0) + e.byteLength), e.mode, e.filter);
    assert.equal(result.length, v.byteLength);
    return result;
  });
  function accessor(index) {
    const a = gltf.accessors[index], v = gltf.bufferViews[a.bufferView], bytes = views[a.bufferView];
    assert.ok(!a.sparse);
    const size = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType];
    const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const read = { 5120: 'readInt8', 5121: 'readUInt8', 5122: 'readInt16LE', 5123: 'readUInt16LE', 5125: 'readUInt32LE', 5126: 'readFloatLE' }[a.componentType];
    const stride = v.byteStride ?? size * width, offset = a.byteOffset ?? 0;
    assert.ok(size && width && offset + (a.count - 1) * stride + width * size <= bytes.length);
    return Array.from({ length: a.count }, (_, i) => Array.from({ length: width }, (_, j) => bytes[read](offset + i * stride + j * size)));
  }
  const world = new Map(), triangles = []; let primitives = 0, vertices = 0;
  function visit(index, parent = new Matrix4()) {
    const n = gltf.nodes[index];
    const local = n.matrix ? new Matrix4().fromArray(n.matrix) : new Matrix4().compose(new Vector3().fromArray(n.translation ?? [0,0,0]), new Quaternion().fromArray(n.rotation ?? [0,0,0,1]), new Vector3().fromArray(n.scale ?? [1,1,1]));
    const matrix = new Matrix4().multiplyMatrices(parent, local); world.set(n.name, matrix);
    if (n.mesh !== undefined) for (const p of gltf.meshes[n.mesh].primitives) {
      assert.equal(p.mode ?? 4, 4); primitives++;
      const positions = accessor(p.attributes.POSITION).map(v => new Vector3().fromArray(v).applyMatrix4(matrix)); vertices += positions.length;
      for (const attribute of ['POSITION','NORMAL','TEXCOORD_0','COLOR_0']) {
        if (attribute === 'COLOR_0' && !requireColor && p.attributes[attribute] === undefined) continue;
        assert.notEqual(p.attributes[attribute], undefined, `${n.name}: ${attribute}`);
        const values = accessor(p.attributes[attribute]); assert.equal(values.length, positions.length);
        assert.ok(values.every(v => v.every(Number.isFinite)), `${n.name}: non-finite ${attribute}`);
      }
      const ids = accessor(p.indices).flat(); assert.equal(ids.length % 3, 0);
      for (let i = 0; i < ids.length; i += 3) {
        const points = ids.slice(i, i + 3).map(j => { assert.ok(j < positions.length); return positions[j]; });
        triangles.push({ points, material: gltf.materials[p.material].name, node: n.name });
      }
    }
    for (const c of n.children ?? []) visit(c, matrix);
  }
  for (const n of gltf.scenes[gltf.scene ?? 0].nodes) visit(n);
  return { ...source, world, triangles, primitives, vertices };
}
