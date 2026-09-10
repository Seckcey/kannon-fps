/** Swap the scout's surface atlas for the 2048 x 1024 set from scout_textures.py, compress the
 *  textures to KTX2, and write public/models/scout-v2.glb. Geometry, rig and animation bytes are
 *  carried through untouched; only images change.
 *
 *  node scripts/blender/finish_scout_v2.mjs [--in public/models/scout.glb] [--out public/models/scout-v2.glb] */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { Mode, toktx } from '@gltf-transform/cli';
import sharp from 'sharp';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const input = arg('in', 'public/models/scout.glb'), out = arg('out', 'public/models/scout-v2.glb');
const ATLAS = 'art/source/town-v2/scout';
process.env.PATH = `${process.env.KTX_BIN ?? 'C:\\it\\tools\\ktx\\bin'}${delimiter}${process.env.PATH ?? ''}`;
if (spawnSync('ktx', ['--version'], { windowsHide: true }).status !== 0) throw new Error('KTX-Software "ktx" not found. Install it and set KTX_BIN to its bin folder.');

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const document = await io.read(input);
const replaced = [];
for (const texture of document.getRoot().listTextures()) {
  const name = texture.getName();
  if (!['Scout_Coating', 'Scout_MicroNormal', 'Scout_MetalRoughness'].includes(name)) continue;
  texture.setImage(new Uint8Array(readFileSync(`${ATLAS}/${name}.png`))).setMimeType('image/png');
  replaced.push(name);
}
if (replaced.length !== 3) throw new Error(`Expected three atlas textures, replaced ${replaced.join(', ')}`);
const surface = document.getRoot().listMaterials().find(material => material.getName() === 'ScoutSurface');
// The new normal map carries real height; the old 0.55 scale was for a subtle micro grain.
surface.setNormalScale(1.0);
const visor = document.getRoot().listMaterials().find(material => material.getName() === 'Visor');
visor?.setRoughnessFactor(0.08).setMetallicFactor(0.9);

await document.transform(
  toktx({ mode: Mode.ETC1S, encoder: sharp, pattern: /Scout_MicroNormal/, quality: 255, compression: 5 }),
  toktx({ mode: Mode.ETC1S, encoder: sharp, pattern: /Scout_(Coating|MetalRoughness)/, quality: 200 }),
);
const glb = await io.writeBinary(document);
writeFileSync(out, glb);
const manifest = { input, out, bytes: glb.byteLength, sha256: createHash('sha256').update(glb).digest('hex'), replaced, textures: document.getRoot().listTextures().map(t => ({ name: t.getName(), mime: t.getMimeType(), bytes: t.getImage().byteLength, size: t.getSize() })) };
writeFileSync(`${ATLAS}/scout-v2-manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`${out}: ${(glb.byteLength / 1e6).toFixed(2)} MB, replaced ${replaced.join(', ')}`);
