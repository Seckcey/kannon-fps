/** Compress the operator's baked gear atlas to KTX2 and write public/models/operator-v1.glb.
 *
 *  node scripts/blender/finish_operator.mjs [--in <work>/operator-raw.glb] [--out public/models/operator-v1.glb]
 *    [--normal uastc|etc1s]
 *
 *  The raw export comes from generate_operator.py (default work folder <system temp>/kannon-operator).
 *  Geometry, skin and animation bytes are carried through untouched; only the three atlas images are
 *  re-encoded (colour ETC1S, metal/roughness ETC1S at half size, normal UASTC by default because
 *  ETC1S blocks show on normal maps). Runtime hints for the client go in the root `extras`.
 *  KTX-Software's `ktx` must be on PATH or in KTX_BIN (default C:\it\tools\ktx\bin). */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { Mode, toktx } from '@gltf-transform/cli';
import sharp from 'sharp';

const argument = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const input = argument('in', join(tmpdir(), 'kannon-operator', 'operator-raw.glb'));
const out = argument('out', 'public/models/operator-v1.glb');
const normalMode = argument('normal', 'uastc');
const MANIFEST = 'art/source/operator-v1-manifest.json';
const BUDGET = 4_000_000;
process.env.PATH = `${process.env.KTX_BIN ?? 'C:\\it\\tools\\ktx\\bin'}${delimiter}${process.env.PATH ?? ''}`;
if (spawnSync('ktx', ['--version'], { windowsHide: true }).status !== 0) throw new Error('KTX-Software "ktx" not found. Install it and set KTX_BIN to its bin folder.');

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const raw = readFileSync(input);
const document = await io.readBinary(new Uint8Array(raw));
const root = document.getRoot();
const textureNames = root.listTextures().map(texture => texture.getName()).sort();
const expected = ['Operator_BaseColor', 'Operator_MetalRoughness', 'Operator_Normal'];
if (JSON.stringify(textureNames) !== JSON.stringify(expected)) throw new Error(`Expected the three operator atlas images, found ${textureNames.join(', ')}`);
const surface = root.listMaterials().find(material => material.getName() === 'ScoutSurface');
if (!surface?.getNormalTexture()) throw new Error('ScoutSurface lost its normal map in export.');
surface.setNormalScale(1.0);
const lens = root.listMaterials().find(material => material.getName() === 'Visor');
lens?.setRoughnessFactor(0.08).setMetallicFactor(0.9);
if (!/mocap\.cs\.cmu\.edu/.test(root.getAsset().copyright ?? '')) throw new Error('The raw export lost its CMU motion credit (asset.copyright).');

root.setExtras({
  kannon: {
    model: 'operator-v1',
    clips: { inherited: ['Idle', 'Walk', 'Run', 'Jump', 'Aim', 'Fire', 'Reload'], authored: ['Crouch', 'CrouchWalk', 'Slide'] },
    referenceSpeeds: { Walk: 6.5, Run: 9, CrouchWalk: 2.6 },
    upperBodyAdditive: ['Fire', 'Reload'],
    weaponSocket: { node: 'weapon_socket', parent: 'hand_r', axes: '-Z along the barrel, +Y up; parent the weapon root and offset it by minus its grip_r' },
    teamColour: 'PlayerAccent',
    motionCredit: 'operator-motion-NOTICE.txt',
  },
});

// The colour atlas keeps full resolution; normal and metal/roughness detail survives at 1024.
const normalCompression = normalMode === 'etc1s'
  ? toktx({ mode: Mode.ETC1S, encoder: sharp, pattern: /^Operator_Normal$/, quality: 255, compression: 5, resize: [1024, 1024] })
  : toktx({ mode: Mode.UASTC, encoder: sharp, pattern: /^Operator_Normal$/, level: 2, rdo: true, rdoLambda: 2, zstd: 18, resize: [1024, 1024] });
await document.transform(
  normalCompression,
  toktx({ mode: Mode.ETC1S, encoder: sharp, pattern: /^Operator_BaseColor$/, quality: 230, compression: 5 }),
  toktx({ mode: Mode.ETC1S, encoder: sharp, pattern: /^Operator_MetalRoughness$/, quality: 200, compression: 5, resize: [1024, 1024] }),
);
const glb = await io.writeBinary(document);
if (glb.byteLength > BUDGET) throw new Error(`${out} would be ${glb.byteLength} bytes, over the ${BUDGET}-byte budget. Try --normal etc1s.`);
writeFileSync(out, glb);
const manifest = {
  input: input.replace(/\\/g, '/').replace(/^.*\/(kannon-operator|work)\//, '<work>/'), out, bytes: glb.byteLength,
  sha256: createHash('sha256').update(glb).digest('hex'), rawBytes: raw.byteLength, normalMode,
  textures: root.listTextures().map(texture => ({ name: texture.getName(), mimeType: texture.getMimeType(), bytes: texture.getImage().byteLength, size: texture.getSize() })),
};
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${out}: ${(glb.byteLength / 1e6).toFixed(2)} MB; ${manifest.textures.map(t => `${t.name} ${t.size?.join('x')} ${(t.bytes / 1e3).toFixed(0)} kB`).join(', ')}`);
