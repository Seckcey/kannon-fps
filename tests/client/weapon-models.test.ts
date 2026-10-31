import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { WeaponId } from '../../shared/protocol';
import { CONTRACT_NODES, WEAPON_IDS, WEAPON_NODES, createWeaponLibrary, findNode, isWeaponId, loadWeaponModels, matchesNode, type WeaponInstance } from '../../src/game/WeaponModels';

const renderer = {} as THREE.WebGLRenderer;

async function placeholderScene(): Promise<THREE.Object3D> {
  const bytes = readFileSync(new URL('../../public/models/weapons-v1.glb', import.meta.url));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return (await new GLTFLoader().parseAsync(buffer, '')).scene;
}

function worldPoint(root: THREE.Object3D, node: THREE.Object3D) {
  root.updateMatrixWorld(true);
  return node.getWorldPosition(new THREE.Vector3()).applyMatrix4(new THREE.Matrix4().copy(root.matrixWorld).invert());
}

function assertUsableWeapon(instance: WeaponInstance) {
  const { root, anchors } = instance;
  let meshes = 0;
  root.traverse(object => { if (object instanceof THREE.Mesh) meshes++; });
  assert.ok(meshes > 0, `${instance.id} has visible geometry`);
  for (const key of ['gripRight', 'gripLeft', 'muzzle', 'sight', 'eject'] as const) {
    let inside = false;
    for (let node: THREE.Object3D | null = anchors[key]; node; node = node.parent) if (node === root) inside = true;
    assert.ok(inside, `${instance.id} ${key} belongs to this copy`);
  }
  const muzzle = worldPoint(root, anchors.muzzle), grip = worldPoint(root, anchors.gripRight), sight = worldPoint(root, anchors.sight);
  assert.ok(muzzle.z < grip.z - 0.1, `${instance.id} muzzle is forward of the grip`);
  assert.ok(sight.y > grip.y, `${instance.id} sight sits above the grip`);
  assert.ok(Math.abs(sight.x) < 1e-6, `${instance.id} sight is on the centreline`);
  assert.ok(anchors.magazine, `${instance.id} has a magazine part`);
  assert.ok(anchors.action, `${instance.id} has a moving action`);
}

test('contract names match through Blender and three.js renaming', () => {
  for (const name of ['grip_r', 'Grip_R', 'grip_r_3', 'grip_r001', 'grip_r.001', 'grip_r001_2']) assert.ok(matchesNode(name, 'grip_r'), name);
  for (const name of ['grip_rx', 'grip_l', 'grip', 'grip_r5', 'xgrip_r']) assert.ok(!matchesNode(name, 'grip_r'), name);
  assert.ok(!matchesNode('weapon_kr5', 'weapon_kr'));
  assert.ok(!matchesNode('magazine', 'mag'));
  const root = new THREE.Group(); root.name = 'Scene';
  const nested = new THREE.Group(); nested.name = 'Collection'; root.add(nested);
  const target = new THREE.Object3D(); target.name = 'muzzle_1'; nested.add(target);
  assert.equal(findNode(root, 'muzzle'), target);
  assert.equal(findNode(root, 'sight'), null);
});

interface GltfJson { nodes?: Array<{ name?: string; children?: number[] }> }
function committedGlbJson(): GltfJson {
  const bytes = readFileSync(new URL('../../public/models/weapons-v1.glb', import.meta.url));
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'binary glTF');
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, 'JSON chunk first');
  return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8')) as GltfJson;
}

test('the committed weapons GLB is either the empty placeholder or carries the whole node contract', async () => {
  const json = committedGlbJson(), nodes = json.nodes ?? [];
  const present = CONTRACT_NODES.filter(base => nodes.some(node => matchesNode(node.name ?? '', base)));
  if (present.length === 0) {
    // Placeholder: the real loader path must still give every model.
    const library = await loadWeaponModels(renderer, { source: placeholderScene });
    assert.equal(library.fromAsset, false);
    library.dispose();
    return;
  }
  // Real art (decoded only in the browser): check names and anchors straight from the JSON.
  assert.deepEqual(present, [...CONTRACT_NODES], 'every contract node is exported');
  const below = (index: number, out: string[] = []): string[] => {
    for (const child of nodes[index]?.children ?? []) { out.push(nodes[child]?.name ?? ''); below(child, out); }
    return out;
  };
  for (const id of WEAPON_IDS) {
    const index = nodes.findIndex(node => matchesNode(node.name ?? '', WEAPON_NODES[id]));
    const names = below(index);
    for (const anchor of ['grip_r', 'grip_l', 'muzzle', 'sight', 'eject', 'mag']) assert.ok(names.some(name => matchesNode(name, anchor)), `${WEAPON_NODES[id]} has ${anchor}`);
  }
});

test('the placeholder GLB parses in Node and every model falls back to a stand-in', async t => {
  const nodes = committedGlbJson().nodes ?? [];
  if (CONTRACT_NODES.some(base => nodes.some(node => matchesNode(node.name ?? '', base)))) { t.skip('the real weapons art is committed; its textures decode only in a browser'); return; }
  const library = await loadWeaponModels(renderer, { source: placeholderScene });
  assert.equal(library.fromAsset, false);
  assert.deepEqual([...library.missing ?? []].sort(), [...CONTRACT_NODES].sort());
  for (const id of WEAPON_IDS) for (const purpose of ['view', 'world'] as const) {
    const instance = library.weapon(id, purpose);
    assert.equal(instance.id, id);
    assert.equal(instance.root.name, WEAPON_NODES[id]);
    assertUsableWeapon(instance);
  }
  const knife = library.knife(), frag = library.frag(), arms = library.arms();
  for (const object of [knife, frag, arms.left, arms.right]) {
    let meshes = 0; object.traverse(child => { if (child instanceof THREE.Mesh) meshes++; });
    assert.ok(meshes > 0, object.name);
  }
  assert.ok(findNode(arms.left, 'forearm') && findNode(arms.right, 'forearm'), 'stand-in forearms pivot at the wrist');
  library.dispose();
});

test('stand-ins stay inside the art budget and keep a sensible size', () => {
  const library = createWeaponLibrary(null);
  const lengths: Record<string, number> = {};
  for (const id of WEAPON_IDS) {
    const { root } = library.weapon(id, 'view');
    let triangles = 0;
    root.traverse(object => { if (object instanceof THREE.Mesh) triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3; });
    assert.ok(triangles <= 12_000, `${id} has ${triangles} triangles`);
    const box = new THREE.Box3().setFromObject(root);
    lengths[id] = box.max.z - box.min.z;
    let world = 0;
    library.weapon(id, 'world').root.traverse(object => { if (object instanceof THREE.Mesh) world += object.geometry.getAttribute('position').count / 3; });
    assert.ok(world < triangles, `${id} third-person copy is lighter (${world} < ${triangles})`);
  }
  assert.ok(lengths.sentry9! > 0.15 && lengths.sentry9! < 0.3, `pistol ${lengths.sentry9}`);
  assert.ok(lengths.hornet9! > 0.45 && lengths.hornet9! < lengths.kr5!, `smg ${lengths.hornet9}`);
  assert.ok(lengths.kr5! > 0.8 && lengths.kr5! < 1, `carbine ${lengths.kr5}`);
  assert.ok(lengths.longbow! > lengths.kr5!, `bolt rifle ${lengths.longbow}`);
  library.dispose();
});

function assetScene() {
  const scene = new THREE.Group(); scene.name = 'Scene';
  const geometry = new THREE.BoxGeometry(0.04, 0.08, 0.7), material = new THREE.MeshStandardMaterial({ name: 'KR5_Body', normalMap: new THREE.Texture() });
  const kr5 = new THREE.Mesh(geometry, material); kr5.name = 'weapon_kr5'; kr5.position.set(2, 0, 0);
  const point = (parent: THREE.Object3D, name: string, x: number, y: number, z: number) => { const node = new THREE.Object3D(); node.name = name; node.position.set(x, y, z); parent.add(node); return node; };
  // Names as three.js and Blender hand them over: repeated names get `_N`, Blender adds digits.
  point(kr5, 'grip_r_1', 0, 0, 0.1); point(kr5, 'grip_l', -0.02, 0.05, -0.2); point(kr5, 'muzzle001', 0, 0.06, -0.35);
  point(kr5, 'sight', 0, 0.12, -0.02); point(kr5, 'eject', 0.02, 0.06, -0.05);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.15, 0.04), material); mag.name = 'mag'; mag.position.set(0, -0.06, -0.08); kr5.add(mag);
  const action = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.02), material); action.name = 'action'; action.position.set(-0.02, 0.07, -0.1); kr5.add(action);
  const collection = new THREE.Group(); collection.name = 'Weapons'; collection.add(kr5); scene.add(collection);
  // A pistol without a muzzle empty: the library estimates it.
  const pistol = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.12, 0.2), material); pistol.name = 'weapon_sentry9';
  point(pistol, 'grip_r_2', 0, 0, 0); point(pistol, 'grip_l_1', -0.02, -0.01, 0); point(pistol, 'sight_1', 0, 0.06, 0.02); point(pistol, 'eject_1', 0.015, 0.05, -0.04);
  scene.add(pistol);
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.4), material); arm.name = 'arm_right'; scene.add(arm);
  return { scene, geometry, material, kr5 };
}

test('exported nodes replace their stand-ins, are cloned per use and keep their anchors', async () => {
  const { scene, geometry } = assetScene();
  const warnings: unknown[] = [];
  const warn = console.warn; console.warn = (...args: unknown[]) => { warnings.push(args); };
  let library;
  try { library = await loadWeaponModels(renderer, { source: async () => scene }); } finally { console.warn = warn; }
  assert.equal(library.fromAsset, false, 'only part of the contract is present');
  const missing = library.missing ?? [];
  assert.ok(!missing.includes('weapon_kr5') && !missing.includes('weapon_sentry9') && !missing.includes('arm_right'));
  assert.ok(missing.includes('weapon_hornet9') && missing.includes('knife') && missing.includes('arm_left'));
  assert.equal(warnings.length, 1, 'one warning for the pistol without a muzzle');

  const first = library.weapon('kr5', 'view'), second = library.weapon('kr5', 'view');
  assert.notEqual(first.root, second.root);
  assert.equal(first.root.position.length(), 0, 'preview offsets from the export are removed');
  assert.equal((first.root as THREE.Mesh).geometry, geometry, 'clones share GPU geometry');
  assert.equal(first.anchors.gripRight.name, 'grip_r_1');
  assert.equal(first.anchors.muzzle.name, 'muzzle001');
  assert.ok(first.anchors.magazine && second.anchors.magazine && first.anchors.magazine !== second.anchors.magazine);
  first.anchors.magazine!.position.y -= 0.2;
  assert.ok(Math.abs(second.anchors.magazine!.position.y + 0.06) < 1e-9, 'moving one copy never moves another');
  assert.ok(Math.abs(worldPoint(first.root, first.anchors.muzzle).z + 0.35) < 1e-9);

  const pistol = library.weapon('sentry9', 'view');
  const estimated = worldPoint(pistol.root, pistol.anchors.muzzle);
  assert.ok(estimated.z < -0.05 && estimated.z > -0.12, `estimated muzzle sits at the front (${estimated.z})`);
  assert.equal(pistol.anchors.magazine, null, 'no magazine part is reported when the export has none');

  const world = library.weapon('kr5', 'world');
  const worldMaterial = (world.root as THREE.Mesh).material as THREE.MeshStandardMaterial;
  assert.notEqual(worldMaterial, (first.root as THREE.Mesh).material, 'third-person copies get their own material');
  assert.equal(worldMaterial.normalMap, null);
  assert.equal((world.root as THREE.Mesh).castShadow, true);
  assert.equal((first.root as THREE.Mesh).castShadow, false);
  assert.equal(library.weapon('hornet9', 'view').root.name, 'weapon_hornet9', 'a missing weapon still works');

  let disposed = 0;
  geometry.addEventListener('dispose', () => disposed++);
  library.dispose();
  assert.equal(disposed, 1, 'library disposal frees the exported geometry');
  library.dispose();
  assert.equal(disposed, 1, 'disposing twice is harmless');
});

test('a full export reports fromAsset', async () => {
  const scene = new THREE.Group();
  const material = new THREE.MeshStandardMaterial();
  for (const name of CONTRACT_NODES) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.1, 0.5), material); mesh.name = name; scene.add(mesh);
    if (name.startsWith('weapon_')) for (const anchor of ['grip_r', 'grip_l', 'muzzle', 'sight', 'eject']) { const node = new THREE.Object3D(); node.name = anchor; mesh.add(node); }
  }
  const library = await loadWeaponModels(renderer, { source: async () => scene });
  assert.equal(library.fromAsset, true);
  assert.deepEqual(library.missing, []);
  library.dispose();
});

test('a broken source falls back to stand-ins instead of failing the match', async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const library = await loadWeaponModels(renderer, { source: async () => { throw new Error('corrupt'); } });
    assert.equal(library.fromAsset, false);
    for (const id of WEAPON_IDS) assertUsableWeapon(library.weapon(id, 'view'));
    library.dispose();
  } finally { console.warn = warn; }
});

test('an id that is not a weapon gives the carbine and never breaks the shared library', async () => {
  for (const id of WEAPON_IDS) assert.ok(isWeaponId(id));
  for (const bad of ['rpg', 'drone', 'toString', '__proto__', 'constructor', '', undefined, 5]) assert.ok(!isWeaponId(bad), String(bad));
  const warn = console.warn, warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const library = createWeaponLibrary(null);
    for (const bad of ['rpg', 'drone', 'toString', '__proto__', 'constructor', 'rpg']) {
      for (const purpose of ['view', 'world'] as const) {
        const instance = library.weapon(bad as WeaponId, purpose);
        assert.equal(instance.id, 'kr5', `"${bad}" gives the carbine`);
        assert.equal(instance.root.name, WEAPON_NODES.kr5);
        assertUsableWeapon(instance);
      }
    }
    assert.equal(warnings.length, 5, 'one warning per unknown id');
    assert.doesNotThrow(() => library.dispose(), 'disposal still frees everything');

    // One holder's bad request leaves the other holder of the same parsed library working.
    const shared = {} as THREE.WebGLRenderer;
    const [a, b] = await Promise.all([loadWeaponModels(shared), loadWeaponModels(shared)]);
    assertUsableWeapon(a.weapon('drone' as WeaponId, 'world'));
    assertUsableWeapon(b.weapon('sentry9', 'view'));
    assert.doesNotThrow(() => { a.dispose(); b.dispose(); });
  } finally { console.warn = warn; }
});

test('shared loads parse once per renderer and free resources after the last user', async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const shared = {} as THREE.WebGLRenderer;
    const [a, b] = await Promise.all([loadWeaponModels(shared), loadWeaponModels(shared)]);
    const meshOf = (instance: WeaponInstance) => { let mesh: THREE.Mesh | null = null; instance.root.traverse(object => { if (!mesh && object instanceof THREE.Mesh) mesh = object; }); return mesh! as THREE.Mesh; };
    const fromA = meshOf(a.weapon('kr5', 'view')), fromB = meshOf(b.weapon('kr5', 'view'));
    assert.equal(fromA.geometry, fromB.geometry, 'both users share one parsed library');
    let disposed = 0;
    fromA.geometry.addEventListener('dispose', () => disposed++);
    a.dispose(); a.dispose();
    assert.equal(disposed, 0, 'still in use by the second holder');
    assert.ok(meshOf(b.weapon('sentry9', 'view')));
    b.dispose();
    assert.equal(disposed, 1, 'freed when the last holder lets go');
    const c = await loadWeaponModels(shared);
    assert.notEqual(meshOf(c.weapon('kr5', 'view')).geometry, fromA.geometry, 'a later load starts fresh');
    c.dispose();
  } finally { console.warn = warn; }
});
