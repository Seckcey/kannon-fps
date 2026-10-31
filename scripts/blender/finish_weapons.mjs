/** Turn the raw Blender export into the shipped first-person weapons file: contract node names
 *  and extras, KTX2 (Basis Universal) textures, Meshopt geometry, and a manifest.
 *
 *  node scripts/blender/finish_weapons.mjs [--input <raw.glb>] [--out public/models/weapons-v1.glb]
 *       [--manifest art/source/weapons/weapons-v1-manifest.json] [--build art/source/weapons/weapons-build.json]
 *
 *  The default input is <temp>/kannon-weapons-v1/weapons-raw.glb, written by generate_weapons.py.
 *  Needs KTX-Software's `ktx`; set KTX_BIN to its bin folder (default C:\it\tools\ktx\bin). */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { NodeIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMaterialsEmissiveStrength } from '@gltf-transform/extensions';
import { dedup, meshopt, prune } from '@gltf-transform/functions';
import { Mode, toktx } from '@gltf-transform/cli';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const input = arg('input', join(tmpdir(), 'kannon-weapons-v1', 'weapons-raw.glb'));
const out = arg('out', 'public/models/weapons-v1.glb');
const manifestPath = arg('manifest', 'art/source/weapons/weapons-v1-manifest.json');
const buildPath = arg('build', 'art/source/weapons/weapons-build.json');
if (!existsSync(input)) throw new Error(`Raw export ${input} not found. Run npm run weapons:generate first.`);

process.env.PATH = `${process.env.KTX_BIN ?? 'C:\\it\\tools\\ktx\\bin'}${delimiter}${process.env.PATH ?? ''}`;
if (spawnSync('ktx', ['--version'], { windowsHide: true }).status !== 0) throw new Error('KTX-Software "ktx" not found. Install it and set KTX_BIN to its bin folder.');

/** Root nodes of the GLB contract (docs/WEAPONS_ART.md) and the model id each one carries. */
const ROOTS = {
  weapon_kr5: 'kr5', weapon_hornet9: 'hornet9', weapon_breaker12: 'breaker12', weapon_longbow: 'longbow', weapon_sentry9: 'sentry9',
  knife: 'knife', frag: 'frag', arm_left: 'arm_left', arm_right: 'arm_right',
};
const ANCHORS = new Set(['grip_r', 'grip_l', 'muzzle', 'sight', 'eject']);
const PIVOTS = new Set(['mag', 'action']);

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const document = await io.read(input);
const root = document.getRoot();
const build = existsSync(buildPath) ? JSON.parse(readFileSync(buildPath, 'utf8')) : { models: {} };

// Scene roots must be exactly the contract roots, untransformed.
const scene = root.getDefaultScene() ?? root.listScenes()[0];
const roots = scene.listChildren();
const rootNames = roots.map(node => node.getName()).sort();
const expected = Object.keys(ROOTS).sort();
if (JSON.stringify(rootNames) !== JSON.stringify(expected)) throw new Error(`Unexpected scene roots: ${rootNames.join(', ')}`);
for (const node of roots) {
  const id = ROOTS[node.getName()];
  node.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
  const entry = build.models[id] ?? {};
  node.setExtras({ kannonWeapons: 'weapons-v1', model: id, ...(entry.extras ?? {}) });
  // Blender object names are '<root>__<node>'; the contract uses the bare node name.
  node.traverse(child => {
    if (child === node) return;
    const name = child.getName();
    const bare = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name;
    child.setName(bare);
    if (ANCHORS.has(bare)) child.setExtras({ anchor: bare });
    else if (PIVOTS.has(bare)) child.setExtras({ part: bare });
    else if (child.getMesh()) child.setExtras({ part: bare.replace(/_mesh$/, '') });
  });
}

// Plain metal/rough materials only: Blender's IOR/specular extras would push three.js onto the
// physical shader for no visible gain.
const dropped = ['KHR_materials_ior', 'KHR_materials_specular', 'KHR_materials_transmission', 'KHR_materials_volume', 'KHR_materials_sheen', 'KHR_materials_clearcoat'];
for (const material of root.listMaterials()) for (const name of dropped) material.setExtension(name, null);
for (const extension of root.listExtensionsUsed()) if (dropped.includes(extension.extensionName)) extension.dispose();

// Reticle dots and tritium sights: Blender's previews use a strong glow, but three.js tone mapping
// clips anything much above 3 to white. These strengths keep the red dot red and the night sights green.
const GLOW = { WeaponGlowRed: { color: [1.0, 0.06, 0.03], strength: 2.2 }, WeaponGlowGreen: { color: [0.35, 1.0, 0.3], strength: 1.6 } };
const emissiveStrength = document.createExtension(KHRMaterialsEmissiveStrength);
for (const material of root.listMaterials()) {
  const glow = GLOW[material.getName()];
  if (!glow) continue;
  material.setEmissiveFactor(glow.color).setExtension('KHR_materials_emissive_strength', emissiveStrength.createEmissiveStrength().setEmissiveStrength(glow.strength));
}

await document.transform(
  dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.TEXTURE, PropertyType.MATERIAL] }),
  prune({ keepLeaves: true, keepAttributes: true, keepExtras: true }),
  // ETC1S keeps the whole set small on the GPU and in the download. Normal maps get the highest
  // ETC1S quality. Occlusion/roughness/metal is low-frequency, so it ships at half the colour size.
  toktx({ mode: Mode.ETC1S, encoder: sharp, pattern: /_Normal/, quality: 255, compression: 5 }),
  toktx({ mode: Mode.ETC1S, encoder: sharp, pattern: /_BaseColor/, quality: 230, compression: 5 }),
  toktx({ mode: Mode.ETC1S, encoder: sharp, pattern: /weapon_kr5_ORM/, quality: 200, compression: 5, resize: [1024, 1024] }),
  toktx({ mode: Mode.ETC1S, encoder: sharp, pattern: /(hornet9|breaker12|longbow|sentry9|arm_left|arm_right)_ORM/, quality: 200, compression: 5, resize: [512, 512] }),
  toktx({ mode: Mode.ETC1S, encoder: sharp, pattern: /^(knife|frag)_ORM/, quality: 200, compression: 5, resize: [256, 256] }),
  // 16-bit positions keep sub-millimetre bevels; UVs at 14 bits stay within a texel of 2048.
  meshopt({ encoder: MeshoptEncoder, level: 'high', quantizePosition: 16, quantizeTexcoord: 14, quantizeNormal: 10 }),
);

const glb = await io.writeBinary(document);
writeFileSync(out, glb);

const triangles = {};
for (const node of roots) {
  let count = 0;
  node.traverse(child => {
    for (const primitive of child.getMesh()?.listPrimitives() ?? []) count += (primitive.getIndices()?.getCount() ?? primitive.getAttribute('POSITION').getCount()) / 3;
  });
  triangles[node.getName()] = count;
}
const textures = root.listTextures().map(texture => ({ name: texture.getName(), mime: texture.getMimeType(), bytes: texture.getImage()?.byteLength ?? 0, size: texture.getSize() }));
const manifest = {
  input: input.replace(/\\/g, '/').replace(/^.*\/(kannon-weapons-v1\/)/, '<temp>/$1'), out, bytes: glb.byteLength,
  sha256: createHash('sha256').update(glb).digest('hex'), triangles,
  materials: root.listMaterials().map(material => material.getName()), textures,
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`${out}: ${(glb.byteLength / 1e6).toFixed(2)} MB, ${textures.length} textures (${textures.filter(t => t.mime === 'image/ktx2').length} ktx2), ${Object.values(triangles).reduce((a, b) => a + b, 0)} triangles`);
