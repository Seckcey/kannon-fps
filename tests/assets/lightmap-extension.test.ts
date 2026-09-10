import test from 'node:test';
import assert from 'node:assert/strict';
import { Document, NodeIO } from '@gltf-transform/core';
import { KannonLightmap, LIGHTMAP_EXTENSION, type Lightmap } from '../../scripts/blender/lightmap-extension.mjs';

// 1x1 opaque PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function jsonChunk(glb: Uint8Array) {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const length = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length)));
}

test('lightmap extension survives a GLB write and read', async () => {
  const document = new Document();
  const extension = document.createExtension(KannonLightmap);
  document.createBuffer();
  const atlas = document.createTexture('LM_0').setImage(new Uint8Array(PNG)).setMimeType('image/png');
  const material = document.createMaterial('Siding');
  const lightmap = extension.createLightmap().setIntensity(0.9).setTexture(atlas);
  lightmap.getTextureInfo()!.setTexCoord(1);
  material.setExtension(LIGHTMAP_EXTENSION, lightmap);
  const io = new NodeIO().registerExtensions([KannonLightmap]);
  const glb = await io.writeBinary(document);
  const json = jsonChunk(glb);
  assert.deepEqual(json.materials[0].extensions[LIGHTMAP_EXTENSION], { intensity: 0.9, texture: { index: 0, texCoord: 1 } });
  assert.ok(json.extensionsUsed.includes(LIGHTMAP_EXTENSION));
  assert.equal(json.textures.length, 1, 'the atlas is written even though no standard slot references it');
  const back = await io.readBinary(glb);
  const readLightmap = back.getRoot().listMaterials()[0]!.getExtension<Lightmap>(LIGHTMAP_EXTENSION);
  assert.ok(readLightmap);
  assert.equal(readLightmap!.getIntensity(), 0.9);
  assert.equal(readLightmap!.getTexture()!.getName(), 'LM_0');
  assert.equal(readLightmap!.getTextureInfo()!.getTexCoord(), 1);
});

test('materials without a lightmap are written without the extension', async () => {
  const document = new Document();
  document.createExtension(KannonLightmap);
  document.createMaterial('Plain');
  const io = new NodeIO().registerExtensions([KannonLightmap]);
  const json = jsonChunk(await io.writeBinary(document));
  assert.equal(json.materials[0].extensions, undefined);
});
