/** Download the CC0 Poly Haven textures and models used by Kannon Town v2 into the local
 *  asset store and record their provenance in art/source/town-v2/cc0-manifest.json.
 *
 *  node scripts/blender/fetch_cc0_assets.mjs [--store C:\it\kannon-assets] [--only <id,id>]
 *
 *  Poly Haven assets are CC0 1.0 (https://polyhaven.com/license). Nothing here is committed
 *  except the manifest; the generator reads files from the store. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const STORE = arg('store') ?? process.env.KANNON_ASSETS ?? 'C:\\it\\kannon-assets';
const only = arg('only')?.split(',');
const UA = { 'User-Agent': 'Mozilla/5.0 kannon-arena-asset-fetch (curl-compatible)' };

/** Poly Haven texture ids by role. Roles are what the generator asks for. */
export const TEXTURES = {
  asphalt: 'asphalt_02',
  concrete: 'concrete_floor_01',
  roof: 'grey_roof_01',
  grass: 'leafy_grass',
  planks_white: 'white_planks_clean',
  plaster: 'painted_plaster_wall',
  floor_wood: 'wood_floor_deck',
  hills: 'aerial_grass_rock',
  bark: 'bark_brown_02',
  fabric: 'fabric_pattern_07',
  metal_painted: 'painted_metal_shutter',
  dirt: 'brown_mud_leaves_01',
};
export const TEXTURE_RESOLUTION = '2k';
export const TEXTURE_MAPS = ['Diffuse', 'col_1', 'nor_gl', 'arm', 'Rough', 'AO'];

/** Poly Haven model ids used as props, with the target triangle budget after decimation. */
export const MODELS = {
  metal_trash_can: 3000, old_tyre: 2000, fire_hydrant: 4000, street_lamp_01: 4000, utility_box_01: 2000,
  planter_box_02: 2500, cardboard_box_01: 1500, wooden_crate_02: 2000, Barrel_02: 1500, exterior_aircon_unit: 3000,
  water_manhole_cover: 1200, concrete_road_barrier: 3000, painted_wooden_bench: 700, plastic_crate_03: 2000,
  wooden_picnic_table: 3000, compost_bags: 3000, rusted_wheel_rim_01: 2000, security_light: 1500, trashbag: 1500,
  hand_truck: 3000, propane_tank: 2000, portable_generator: 4000, ladder_sectioned_01: 3000,
  garden_hose_wall_mounted_01: 2500, outdoor_table_chair_set_01: 3500, wooden_barrels_01: 4000, potted_plant_02: 6000,
  shrub_02: 8000, modular_electricity_poles: 6000, modular_electric_cables: 4000,
};
export const MODEL_RESOLUTION = '1k';

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

async function api(path) {
  const response = await fetch(`https://api.polyhaven.com/${path}`, { headers: UA });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

async function download(url, target) {
  if (existsSync(target) && statSync(target).size > 0) return false;
  mkdirSync(dirname(target), { recursive: true });
  const response = await fetch(url, { headers: UA });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  return true;
}

async function fetchTexture(id) {
  const files = await api(`files/${id}`);
  const info = await api(`info/${id}`);
  const entry = { id, name: info.name, type: 'texture', licence: 'CC0 1.0', source: `https://polyhaven.com/a/${id}`, resolution: TEXTURE_RESOLUTION, files: {} };
  for (const map of TEXTURE_MAPS) {
    const variant = files[map]?.[TEXTURE_RESOLUTION]?.jpg ?? files[map]?.[TEXTURE_RESOLUTION]?.png;
    if (!variant) continue;
    const target = join(STORE, 'polyhaven', 'textures', id, `${id}_${map}_${TEXTURE_RESOLUTION}.${variant.url.split('.').pop()}`);
    const fresh = await download(variant.url, target);
    entry.files[map] = { path: target, url: variant.url, bytes: statSync(target).size, sha256: sha256(target) };
    console.log(`${fresh ? 'downloaded' : 'cached'} ${id} ${map}`);
  }
  // Some assets publish colour variants (col_1, col_2) instead of a single Diffuse map.
  if (!entry.files.Diffuse && entry.files.col_1) entry.files.Diffuse = entry.files.col_1;
  if (!entry.files.Diffuse || !entry.files.nor_gl) throw new Error(`${id}: missing Diffuse or nor_gl`);
  return entry;
}

async function fetchModel(id) {
  const files = await api(`files/${id}`);
  const info = await api(`info/${id}`);
  const variant = files.gltf?.[MODEL_RESOLUTION]?.gltf;
  if (!variant) throw new Error(`${id}: no ${MODEL_RESOLUTION} glTF`);
  const folder = join(STORE, 'polyhaven', 'models', id);
  const entry = { id, name: info.name, type: 'model', licence: 'CC0 1.0', source: `https://polyhaven.com/a/${id}`, resolution: MODEL_RESOLUTION, polycount: info.polycount, lods: !!info.lods, targetTriangles: MODELS[id], files: {} };
  const main = join(folder, `${id}.gltf`);
  await download(variant.url, main);
  entry.files.gltf = { path: main, url: variant.url, bytes: statSync(main).size, sha256: sha256(main) };
  for (const [relative, include] of Object.entries(variant.include ?? {})) {
    const target = join(folder, relative);
    await download(include.url, target);
    entry.files[relative] = { path: target, url: include.url, bytes: statSync(target).size, sha256: sha256(target) };
  }
  console.log(`fetched model ${id} (${Object.keys(entry.files).length} files, ${info.polycount} polys)`);
  return entry;
}

const manifestPath = join(ROOT, 'art', 'source', 'town-v2', 'cc0-manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { store: STORE, assets: {} };
manifest.store = STORE;
for (const [role, id] of Object.entries(TEXTURES)) {
  if (only && !only.includes(id)) continue;
  manifest.assets[id] = { ...(await fetchTexture(id)), role };
}
for (const id of Object.keys(MODELS)) {
  if (only && !only.includes(id)) continue;
  manifest.assets[id] = await fetchModel(id);
}
manifest.fetched = new Date().toISOString();
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest: ${Object.keys(manifest.assets).length} assets -> ${manifestPath}`);
