import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneHierarchy } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { WeaponId } from '../../shared/protocol';
import { ARENA_ASSETS, getArenaAssetBuffer } from './assets';
import { ktx2Loader } from './Ktx2';
import { createWeaponPalette, type WeaponPalette } from './viewmodel/materials';
import { buildArmStandIn, buildFragStandIn, buildKnifeStandIn, buildWeaponStandIn, type Detail } from './viewmodel/standins';

/** Named points on a weapon model (contract with scripts/blender/generate_weapons.py).
 * Units are metres; the weapon points along -Z with +Y up. */
export interface WeaponAnchors {
  /** Right palm on the grip; the right arm's origin sits here. */
  gripRight: THREE.Object3D;
  /** Left hand support point on the handguard (or on the right hand for the pistol). */
  gripLeft: THREE.Object3D;
  muzzle: THREE.Object3D;
  /** A point on the optical axis; aiming puts the eye on the line through it along -Z. */
  sight: THREE.Object3D;
  eject: THREE.Object3D;
  /** Moving parts for reloads and actions, when the model has them. */
  magazine: THREE.Object3D | null;
  action: THREE.Object3D | null;
}
export interface WeaponInstance { id: WeaponId; root: THREE.Object3D; anchors: WeaponAnchors }
export interface WeaponLibrary {
  /** A new clone. `purpose` lets first-person copies skip shadows and third-person copies use cheaper materials. */
  weapon(id: WeaponId, purpose: 'view' | 'world'): WeaponInstance;
  knife(): THREE.Object3D;
  frag(): THREE.Object3D;
  /** Gloved forearms; each origin is the palm grip point, the forearm extends toward +Z. */
  arms(): { left: THREE.Object3D; right: THREE.Object3D };
  /** True when the exported GLB supplied the models; false for procedural stand-ins. */
  readonly fromAsset: boolean;
  /** Contract nodes the GLB did not supply; procedural stand-ins fill each of them. Optional so
   * hand-written test doubles of this interface stay valid. */
  readonly missing?: readonly string[];
  dispose(): void;
}

export const WEAPON_IDS: readonly WeaponId[] = ['kr5', 'hornet9', 'breaker12', 'longbow', 'sentry9'];
/** Root node names in the weapons GLB (see the plan's Weapons GLB contract). */
export const WEAPON_NODES: Readonly<Record<WeaponId, string>> = {
  kr5: 'weapon_kr5', hornet9: 'weapon_hornet9', breaker12: 'weapon_breaker12', longbow: 'weapon_longbow', sentry9: 'weapon_sentry9',
};
export const EXTRA_NODES = { knife: 'knife', frag: 'frag', armLeft: 'arm_left', armRight: 'arm_right' } as const;
export const CONTRACT_NODES: readonly string[] = [...WEAPON_IDS.map(id => WEAPON_NODES[id]), ...Object.values(EXTRA_NODES)];
const ANCHOR_NODES = { gripRight: 'grip_r', gripLeft: 'grip_l', muzzle: 'muzzle', sight: 'sight', eject: 'eject' } as const;
type AnchorKey = keyof typeof ANCHOR_NODES;

/** GLTFLoader strips `. : / [ ]` and appends `_1`, `_2` to repeated names; Blender appends `.001`.
 * `grip_r`, `grip_r_3`, `grip_r001` and `grip_r.001` all name the contract node `grip_r`. */
export function matchesNode(name: string, base: string): boolean {
  const clean = name.replace(/[.:/[\]]/g, '').toLowerCase();
  const target = base.toLowerCase();
  if (!clean.startsWith(target)) return false;
  return /^(?:\d{3})?(?:_\d+)*$/.test(clean.slice(target.length));
}
/** First node under `root` (depth first, including `root`) carrying the contract name. */
export function findNode(root: THREE.Object3D, base: string): THREE.Object3D | null {
  if (matchesNode(root.name, base)) return root;
  for (const child of root.children) { const found = findNode(child, base); if (found) return found; }
  return null;
}

export interface WeaponModelOptions {
  /** Supplies the parsed weapons scene instead of downloading `ARENA_ASSETS.weapons` (tests, tools).
   * Resolving null, or rejecting, gives the procedural stand-ins. Injected sources are never shared. */
  source?: () => Promise<THREE.Object3D | null>;
}

interface Entry { promise: Promise<LibraryCore>; users: number; core: LibraryCore | null }
const sharedLibraries = new Map<object, Entry>();
const defaultKey = {};

/** Parses the weapons GLB once per renderer and hands out reference-counted libraries: the viewmodel
 * and the remote players can each hold one, and GPU resources are freed when the last is disposed.
 * Never rejects: a missing or broken file falls back to the procedural stand-ins. */
export function loadWeaponModels(renderer: THREE.WebGLRenderer, options: WeaponModelOptions = {}): Promise<WeaponLibrary> {
  if (options.source) {
    return readScene(options.source).then(scene => { const core = new LibraryCore(scene); return core.handle(() => core.dispose()); });
  }
  const key = (renderer as object | null | undefined) ?? defaultKey;
  let entry = sharedLibraries.get(key);
  if (!entry) {
    const created: Entry = { users: 0, core: null, promise: readScene(() => readWeaponsAsset(renderer)).then(scene => new LibraryCore(scene)) };
    created.promise.then(core => { created.core = core; });
    sharedLibraries.set(key, created);
    entry = created;
  }
  const active = entry;
  active.users++;
  return active.promise.then(core => core.handle(() => {
    active.users--;
    if (active.users > 0) return;
    if (sharedLibraries.get(key) === active) sharedLibraries.delete(key);
    core.dispose();
  }));
}

async function readScene(source: () => Promise<THREE.Object3D | null>): Promise<THREE.Object3D | null> {
  try { return await source(); }
  catch (error) {
    console.warn('Weapon models could not load; using built-in stand-ins.', error);
    return null;
  }
}

async function readWeaponsAsset(renderer: THREE.WebGLRenderer | null | undefined): Promise<THREE.Object3D | null> {
  const buffer = await getArenaAssetBuffer(ARENA_ASSETS.weapons);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  if (renderer && typeof (renderer as Partial<THREE.WebGLRenderer>).extensions === 'object') loader.setKTX2Loader(ktx2Loader(renderer));
  // Parse the bytes accepted by warmup; a second download could fail after joining.
  const gltf = await loader.parseAsync(buffer, '/models/');
  return gltf.scene;
}

/** Builds a library straight from a parsed weapons scene (or none, for all stand-ins). The caller owns
 * the result; nothing is shared. */
export function createWeaponLibrary(scene: THREE.Object3D | null): WeaponLibrary {
  const core = new LibraryCore(scene);
  return core.handle(() => core.dispose());
}

type AnchorOffsets = Partial<Record<AnchorKey, THREE.Vector3>>;
interface AssetTemplate { root: THREE.Object3D; synthesized: AnchorOffsets }

class LibraryCore {
  readonly missing: string[] = [];
  private readonly assets = new Map<string, AssetTemplate>();
  private readonly standIns = new Map<string, THREE.Group>();
  private readonly worldMaterials = new Map<THREE.Material, THREE.Material>();
  private palette: WeaponPalette | null = null;
  private disposed = false;

  constructor(private readonly scene: THREE.Object3D | null) {
    for (const name of CONTRACT_NODES) {
      const node = scene ? findNode(scene, name) : null;
      if (!node || !hasGeometry(node)) { this.missing.push(name); continue; }
      // Exported roots may sit side by side for previews; consumers place them, so start at the origin.
      node.removeFromParent();
      node.position.set(0, 0, 0); node.quaternion.identity(); node.updateMatrix();
      this.assets.set(name, { root: node, synthesized: {} });
    }
    for (const id of WEAPON_IDS) {
      const asset = this.assets.get(WEAPON_NODES[id]);
      if (asset) asset.synthesized = this.synthesizeAnchors(id, asset.root);
    }
  }
  get fromAsset() { return this.missing.length === 0; }

  handle(release: () => void): WeaponLibrary {
    let released = false;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const core = this;
    return {
      get fromAsset() { return core.fromAsset; },
      get missing() { return core.missing; },
      weapon: (id, purpose) => core.weapon(id, purpose),
      knife: () => core.extra(EXTRA_NODES.knife, 'view'),
      frag: () => core.extra(EXTRA_NODES.frag, 'view'),
      arms: () => ({ left: core.extra(EXTRA_NODES.armLeft, 'view'), right: core.extra(EXTRA_NODES.armRight, 'view') }),
      dispose() { if (released) return; released = true; release(); },
    };
  }

  weapon(id: WeaponId, purpose: 'view' | 'world'): WeaponInstance {
    const asset = this.assets.get(WEAPON_NODES[id]);
    const template = asset?.root ?? this.standIn(WEAPON_NODES[id], purpose === 'world' ? 'world' : 'view', () => buildWeaponStandIn(id, this.materials(), purpose === 'world' ? 'world' : 'view'));
    const root = this.instantiate(template, purpose);
    return { id, root, anchors: anchorsOf(root, asset?.synthesized ?? {}) };
  }

  extra(name: string, purpose: 'view' | 'world'): THREE.Object3D {
    const asset = this.assets.get(name);
    if (asset) return this.instantiate(asset.root, purpose);
    const detail: Detail = purpose === 'world' ? 'world' : 'view';
    const palette = this.materials();
    const build = name === EXTRA_NODES.knife ? () => buildKnifeStandIn(palette, detail)
      : name === EXTRA_NODES.frag ? () => buildFragStandIn(palette, detail)
        : () => buildArmStandIn(name === EXTRA_NODES.armLeft ? 'left' : 'right', palette, detail);
    return this.instantiate(this.standIn(name, detail, build), purpose);
  }

  private materials(): WeaponPalette { return this.palette ??= createWeaponPalette(); }
  private standIn(name: string, detail: Detail, build: () => THREE.Group): THREE.Group {
    const key = `${name}:${detail}`;
    let template = this.standIns.get(key);
    if (!template) { template = build(); this.standIns.set(key, template); }
    return template;
  }

  private instantiate(template: THREE.Object3D, purpose: 'view' | 'world'): THREE.Object3D {
    const root = cloneHierarchy(template);
    root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      object.castShadow = purpose === 'world';
      object.receiveShadow = purpose === 'world';
      // Bind-pose bounds can cull a posed skinned hand at the edge of the view.
      if (object instanceof THREE.SkinnedMesh && purpose === 'view') object.frustumCulled = false;
      if (purpose === 'world') object.material = Array.isArray(object.material) ? object.material.map(material => this.worldMaterial(material)) : this.worldMaterial(object.material);
    });
    return root;
  }

  /** Third-person copies are a few pixels tall: drop the detail maps. */
  private worldMaterial(material: THREE.Material): THREE.Material {
    let copy = this.worldMaterials.get(material);
    if (!copy) {
      copy = material.clone();
      if (copy instanceof THREE.MeshStandardMaterial) { copy.normalMap = null; copy.bumpMap = null; copy.roughnessMap = null; }
      copy.name = `${material.name}_World`;
      this.worldMaterials.set(material, copy);
    }
    return copy;
  }

  /** Estimate anchors the export omitted from where the stand-in keeps them, scaled to the asset's bounds. */
  private synthesizeAnchors(id: WeaponId, root: THREE.Object3D): AnchorOffsets {
    const absent = (Object.keys(ANCHOR_NODES) as AnchorKey[]).filter(key => !findNode(root, ANCHOR_NODES[key]));
    if (!absent.length) return {};
    console.warn(`Weapon model ${WEAPON_NODES[id]} has no ${absent.map(key => ANCHOR_NODES[key]).join(', ')}; estimating from its shape.`);
    const reference = this.standIn(WEAPON_NODES[id], 'view', () => buildWeaponStandIn(id, this.materials(), 'view'));
    const fromBox = meshBounds(reference), toBox = meshBounds(root);
    const result: AnchorOffsets = {};
    for (const key of absent) {
      const point = findNode(reference, ANCHOR_NODES[key])!.position.clone();
      const size = fromBox.getSize(new THREE.Vector3()), target = toBox.getSize(new THREE.Vector3());
      result[key] = new THREE.Vector3(
        toBox.min.x + (point.x - fromBox.min.x) / Math.max(1e-6, size.x) * target.x,
        toBox.min.y + (point.y - fromBox.min.y) / Math.max(1e-6, size.y) * target.y,
        toBox.min.z + (point.z - fromBox.min.z) / Math.max(1e-6, size.z) * target.z,
      );
    }
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
    const collect = (root: THREE.Object3D) => root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material);
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      }
    });
    for (const asset of this.assets.values()) collect(asset.root);
    if (this.scene) collect(this.scene);
    for (const template of this.standIns.values()) collect(template);
    for (const material of this.worldMaterials.values()) materials.add(material);
    if (this.palette) { for (const material of this.palette.materials()) materials.add(material); for (const texture of this.palette.textures()) textures.add(texture); }
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
    this.assets.clear(); this.standIns.clear(); this.worldMaterials.clear(); this.palette = null;
  }
}

function hasGeometry(root: THREE.Object3D): boolean {
  let found = false;
  root.traverse(object => { if (object instanceof THREE.Mesh) found = true; });
  return found;
}

function meshBounds(root: THREE.Object3D): THREE.Box3 {
  root.updateMatrixWorld(true);
  const inverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const box = new THREE.Box3(), part = new THREE.Box3(), matrix = new THREE.Matrix4();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.computeBoundingBox();
    part.copy(object.geometry.boundingBox!).applyMatrix4(matrix.multiplyMatrices(inverse, object.matrixWorld));
    box.union(part);
  });
  if (box.isEmpty()) box.set(new THREE.Vector3(-0.02, -0.08, -0.5), new THREE.Vector3(0.02, 0.12, 0.2));
  return box;
}

function anchorsOf(root: THREE.Object3D, synthesized: AnchorOffsets): WeaponAnchors {
  const point = (key: AnchorKey) => {
    const found = findNode(root, ANCHOR_NODES[key]);
    if (found) return found;
    const node = new THREE.Object3D(); node.name = ANCHOR_NODES[key];
    node.position.copy(synthesized[key] ?? new THREE.Vector3()); root.add(node);
    return node;
  };
  return {
    gripRight: point('gripRight'), gripLeft: point('gripLeft'), muzzle: point('muzzle'), sight: point('sight'), eject: point('eject'),
    magazine: findNode(root, 'mag'), action: findNode(root, 'action'),
  };
}
