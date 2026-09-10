/** Attach baked lightmaps, resize per tier, compress textures to KTX2 (Basis Universal) and
 *  geometry with Meshopt, then write the runtime GLB and a manifest.
 *
 *  node scripts/blender/finish_town_v2.mjs --input in.glb --lightmaps lm.json --out out.glb [--tier full|phone] [--manifest out.json]
 *
 *  Needs KTX-Software's `ktx` executable. Set KTX_BIN to its bin folder; the default is the
 *  extracted install at C:\it\tools\ktx\bin. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { NodeIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune } from '@gltf-transform/functions';
import { Mode, toktx } from '@gltf-transform/cli';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { KannonLightmap, LIGHTMAP_EXTENSION } from './lightmap-extension.mjs';

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const input = arg('input'), lightmapsPath = arg('lightmaps'), out = arg('out'), tier = arg('tier') ?? 'full', manifestPath = arg('manifest');
if (!input || !out || !lightmapsPath) throw new Error('Usage: --input <glb> --lightmaps <json> --out <glb> [--tier full|phone] [--manifest <json>]');
if (!['full', 'phone'].includes(tier)) throw new Error(`Unknown tier ${tier}`);

process.env.PATH = `${process.env.KTX_BIN ?? 'C:\\it\\tools\\ktx\\bin'}${delimiter}${process.env.PATH ?? ''}`;
if (spawnSync('ktx', ['--version'], { windowsHide: true }).status !== 0) throw new Error('KTX-Software "ktx" not found. Install it and set KTX_BIN to its bin folder.');

/** Texture size limits per tier. Environment colour stays sharpest; normal and roughness maps
 *  tile at metre scale and read fine at half size; props are small on screen. */
const BUDGET = {
  full: { lightmap: 2048, colour: 2048, detail: 1024, prop: 512 },
  phone: { lightmap: 1024, colour: 1024, detail: 512, prop: 256 },
}[tier];
const square = size => [size, size];

await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions([...ALL_EXTENSIONS, KannonLightmap]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const document = await io.read(input);
const lightmaps = JSON.parse(readFileSync(lightmapsPath, 'utf8'));
const extension = document.createExtension(KannonLightmap);

const atlases = new Map();
for (const [name, file] of Object.entries(lightmaps.atlases ?? {})) {
  const bytes = readFileSync(resolve(dirname(lightmapsPath), file));
  atlases.set(name, document.createTexture(name).setImage(new Uint8Array(bytes)).setMimeType('image/png'));
}
const materialsByName = new Map(document.getRoot().listMaterials().map(material => [material.getName(), material]));
const missing = [];
for (const [materialName, entry] of Object.entries(lightmaps.materials ?? {})) {
  const material = materialsByName.get(materialName);
  if (!material) { missing.push(materialName); continue; }
  const atlas = atlases.get(entry.atlas);
  if (!atlas) throw new Error(`Material ${materialName} references unknown atlas ${entry.atlas}`);
  const lightmap = extension.createLightmap().setIntensity(entry.intensity ?? 1).setTexture(atlas);
  lightmap.getTextureInfo().setTexCoord(1);
  material.setExtension(LIGHTMAP_EXTENSION, lightmap);
}
if (missing.length) throw new Error(`Lightmap sidecar names materials not in the GLB: ${missing.join(', ')}`);
for (const name of lightmaps.alphaMask ?? []) materialsByName.get(name)?.setAlphaMode('MASK').setAlphaCutoff(0.5);
for (const name of lightmaps.doubleSided ?? []) materialsByName.get(name)?.setDoubleSided(true);
for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
  const material = primitive.getMaterial();
  if (material?.getExtension(LIGHTMAP_EXTENSION) && !primitive.getAttribute('TEXCOORD_1')) {
    throw new Error(`Primitive in ${mesh.getName()} uses lightmapped ${material.getName()} but has no TEXCOORD_1`);
  }
}

await document.transform(
  dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.MESH, PropertyType.TEXTURE, PropertyType.MATERIAL] }),
  prune({ keepAttributes: true, keepExtras: true }),
  // Everything is ETC1S (the smallest GPU format). Four passes with disjoint name patterns:
  // lightmaps, environment colour (2k sets), environment normal/roughness, and props.
  toktx({ mode: Mode.ETC1S, encoder: sharp, pattern: /^LM_/, resize: square(BUDGET.lightmap), quality: 200 }),
  toktx({ mode: Mode.ETC1S, encoder: sharp, pattern: /^(?!LM_).*_(Diffuse|diff|col_1)_2k/, resize: square(BUDGET.colour), quality: 170 }),
  toktx({ mode: Mode.ETC1S, encoder: sharp, pattern: /^(?!LM_)(?!.*_(Diffuse|diff|col_1)_2k).*_2k/, resize: square(BUDGET.detail), quality: 200 }),
  toktx({ mode: Mode.ETC1S, encoder: sharp, pattern: /^(?!LM_)(?!.*_2k)/, resize: square(BUDGET.prop), quality: 160 }),
  // 16-bit positions keep millimetre layering (clapboards, decals) intact in the 60 m house meshes.
  meshopt({ encoder: MeshoptEncoder, level: 'high', quantizePosition: 16, quantizeTexcoord: 14, quantizeNormal: 10 }),
);

const glb = await io.writeBinary(document);
writeFileSync(out, glb);
const textures = document.getRoot().listTextures().map(texture => ({ name: texture.getName(), mime: texture.getMimeType(), bytes: texture.getImage()?.byteLength ?? 0, size: texture.getSize() }));
const manifest = {
  input, tier, bytes: glb.byteLength, sha256: createHash('sha256').update(glb).digest('hex'),
  triangles: document.getRoot().listMeshes().reduce((sum, mesh) => sum + mesh.listPrimitives().reduce((s, p) => s + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION')?.getCount() ?? 0) / 3, 0), 0),
  materials: document.getRoot().listMaterials().length,
  textures,
  lightmapped: document.getRoot().listMaterials().filter(material => material.getExtension(LIGHTMAP_EXTENSION)).map(material => material.getName()),
};
if (manifestPath) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`${out}: ${(glb.byteLength / 1e6).toFixed(2)} MB, ${textures.length} textures (${textures.filter(t => t.mime === 'image/ktx2').length} ktx2), ${manifest.lightmapped.length} lightmapped materials, ${Math.round(manifest.triangles)} triangles`);
