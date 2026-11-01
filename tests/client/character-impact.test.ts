import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { createAccentImpact, createCharacterImpact, type CharacterImpactKind } from '../../src/game/CharacterImpact';
import { createCharacter } from '../../src/game/Character';
import { applySunVisibility } from '../../src/game/SunVisibility';
import type { PublicPlayerState } from '../../shared/protocol';
import { DEFAULT_LOADOUT } from '../../shared/weapons';

const living = { health: 100, connected: true, protectedUntil: 0 };
let scout: Promise<GLTF> | undefined;
function loadScout() {
  return scout ??= (async () => {
    const bytes = await readFile(new URL('../../public/models/scout.glb', import.meta.url));
    const loader = new GLTFLoader();
    // Retain actual meshes, skin, materials, UVs and animation. Pixels need no GPU for these invariants.
    loader.register(() => ({ name: 'CPU_character_impact_test', loadTexture: async () => new THREE.Texture() }));
    return loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  })();
}

function meshes(model: THREE.Object3D) {
  const result: THREE.Mesh[] = [];
  model.traverse(object => { if (object instanceof THREE.Mesh) result.push(object); });
  return result;
}
function materials(model: THREE.Object3D) {
  return [...new Set(meshes(model).flatMap(mesh => Array.isArray(mesh.material) ? mesh.material : [mesh.material]))];
}
function bodySurface(model: THREE.Object3D) {
  const body = model.getObjectByName('scout_body');
  assert.ok(body, 'Test the actual exported scout body');
  const surface = materials(body).find(material => material.name === 'ScoutSurface');
  assert.ok(surface instanceof THREE.MeshStandardMaterial);
  return surface;
}
function emission(material: THREE.MeshStandardMaterial) {
  return { color: material.emissive.toArray(), intensity: material.emissiveIntensity };
}
function appearance(material: THREE.MeshStandardMaterial) {
  return {
    color: material.color.toArray(), roughness: material.roughness, metalness: material.metalness,
    opacity: material.opacity, transparent: material.transparent, side: material.side,
    depthTest: material.depthTest, depthWrite: material.depthWrite, toneMapped: material.toneMapped,
    map: material.map, normalMap: material.normalMap, roughnessMap: material.roughnessMap,
    metalnessMap: material.metalnessMap, emissiveMap: material.emissiveMap,
  };
}
function pose(model: THREE.Object3D) {
  const transforms: number[][] = [], vertices: number[][] = [];
  model.updateWorldMatrix(true, true);
  model.traverse(object => {
    transforms.push([...object.position.toArray(), ...object.quaternion.toArray(), ...object.scale.toArray()]);
    if (object instanceof THREE.SkinnedMesh) {
      const count = object.geometry.getAttribute('position').count;
      for (const index of [0, Math.floor(count / 3), Math.floor(count / 2), count - 1]) {
        vertices.push(object.getVertexPosition(index, new THREE.Vector3()).applyMatrix4(object.matrixWorld).toArray());
      }
    }
  });
  return { transforms, vertices };
}

test('a Scout impact owns only its body surface and leaves cached models, accents, weapons, UVs and poses intact', async () => {
  const asset = await loadScout(), victim = clone(asset.scene), friend = clone(asset.scene);
  const original = bodySurface(asset.scene);
  assert.equal(bodySurface(victim), original);
  assert.equal(bodySurface(friend), original);
  const originalAppearance = appearance(original), originalEmission = emission(original);
  assert.ok(original.emissiveIntensity === 0 || original.emissive.toArray().every(value => value === 0), 'The shipped body has zero baseline emission, so atlas modulation preserves its resting appearance');
  const beforeMaterials = new Set(materials(victim));
  const bindings = meshes(victim).map(mesh => ({ mesh, geometry: mesh.geometry, uv: mesh.geometry.getAttribute('uv'), material: mesh.material }));
  let clock = 1_000;
  const effect = createCharacterImpact(victim, () => clock);
  const owned = bodySurface(victim);
  assert.notEqual(owned, original);
  const pulseAppearance = { ...originalAppearance, emissiveMap: original.emissiveMap ?? original.map };
  assert.deepEqual(appearance(owned), pulseAppearance);
  assert.ok(owned.emissiveMap, 'The hit response uses the existing body atlas, not a flat color');
  const shaderVersion = owned.version, atlasVersion = owned.emissiveMap.version;
  assert.equal(materials(victim).filter(material => !beforeMaterials.has(material)).length, 1, 'Exactly one material clone, no additional render primitive');
  const untouched = materials(victim).filter(material => material !== owned && material instanceof THREE.MeshStandardMaterial) as THREE.MeshStandardMaterial[];
  const untouchedEmissions = untouched.map(emission);
  const mixer = new THREE.AnimationMixer(victim);
  mixer.clipAction(asset.animations.find(clip => clip.name === 'Walk')!).play();
  mixer.update(.219);
  victim.position.set(4, 2, -3); victim.rotation.y = .8; victim.scale.setScalar(.93);
  const baselinePose = pose(victim);
  effect.update(living);

  for (const kind of ['hit', 'head', 'blast'] as const) {
    effect.impact(kind);
    assert.notDeepEqual(emission(owned), originalEmission, `${kind} responds on the actual skinned surface`);
    assert.deepEqual(emission(original), originalEmission, 'The GLTF cache stays pristine');
    assert.deepEqual(emission(bodySurface(friend)), originalEmission, 'The other player does not flash');
    assert.deepEqual(untouched.map(emission), untouchedEmissions, 'PlayerAccent, StatusLight, Visor and weapon surfaces stay unchanged');
    assert.deepEqual(appearance(owned), pulseAppearance, 'Depth testing, base PBR settings and the prebound emission atlas stay fixed');
    assert.deepEqual(appearance(original), originalAppearance, 'The cached material never gains an emissive atlas');
    assert.equal(owned.version, shaderVersion, 'Hits do not request shader recompilation');
    assert.equal(owned.emissiveMap!.version, atlasVersion, 'Hits never mutate the shared atlas');
    assert.deepEqual(pose(victim), baselinePose, 'No impact transform reaches the root, bones, hands, weapon or skinned vertices');
    clock += 500; effect.update(living);
    assert.deepEqual(emission(owned), originalEmission);
    assert.deepEqual(appearance(owned), pulseAppearance, 'Expiry retains stable shader defines and exact resting emission');
    assert.equal(owned.version, shaderVersion);
  }
  for (const binding of bindings) {
    assert.equal(binding.mesh.geometry, binding.geometry);
    assert.equal(binding.mesh.geometry.getAttribute('uv'), binding.uv);
  }
  effect.dispose();
  for (const binding of bindings) assert.equal(binding.mesh.material, binding.material, 'Disposal releases the private binding');
  mixer.stopAllAction(); mixer.uncacheRoot(victim);
});

test('pulse timing is independent of frame count and repeated damage cannot accumulate brightness or material copies', async () => {
  const asset = await loadScout();
  const a = clone(asset.scene), b = clone(asset.scene);
  let clockA = 0, clockB = 0;
  const effectA = createCharacterImpact(a, () => clockA), effectB = createCharacterImpact(b, () => clockB);
  const surfaceA = bodySurface(a), surfaceB = bodySurface(b), baseline = emission(surfaceA);
  effectA.impact('blast'); effectB.impact('blast');
  for (let frame = 1; frame <= 12; frame++) { clockA = frame * 10; effectA.update(living); }
  clockB = 120; effectB.update(living);
  assert.deepEqual(emission(surfaceA), emission(surfaceB), 'A delayed render gets the same absolute-time brightness');
  const materialBindings = meshes(a).map(mesh => mesh.material);
  const kinds: CharacterImpactKind[] = ['hit', 'head', 'blast'];
  for (let hit = 0; hit < 1_000; hit++) {
    effectA.impact(kinds[hit % kinds.length]);
    assert.ok(surfaceA.emissive.toArray().every(value => Number.isFinite(value) && value >= 0 && value < 2), 'A burst is bounded rather than added to prior hits');
  }
  assert.deepEqual(meshes(a).map(mesh => mesh.material), materialBindings);
  clockA += 60_000; effectA.update(living);
  assert.deepEqual(emission(surfaceA), baseline, 'Background suspension expires the effect on the first resumed update');
  effectA.dispose(); effectB.dispose();
});

test('death and new-spawn protection clear the pulse, a body left by a dropped connection still flashes, and hits resume normally', async () => {
  const model = clone((await loadScout()).scene);
  const effect = createCharacterImpact(model, () => 100);
  const surface = bodySurface(model), baseline = emission(surface);
  effect.update(living);
  effect.impact('hit'); effect.update({ ...living, health: 0 });
  assert.deepEqual(emission(surface), baseline);
  effect.impact('blast');
  assert.deepEqual(emission(surface), baseline, 'Late damage cannot recolor a dead character');
  effect.update({ ...living, protectedUntil: 5_000 });
  effect.impact('head');
  assert.notDeepEqual(emission(surface), baseline);
  effect.update({ ...living, protectedUntil: 10_000 });
  assert.deepEqual(emission(surface), baseline, 'A respawn clears even when the dead snapshot was skipped');
  // The server can still hit a living player whose connection dropped, so the body still shows it.
  const offline = { ...living, connected: false, protectedUntil: 10_000 };
  effect.update(offline);
  effect.impact('head'); assert.notDeepEqual(emission(surface), baseline, 'A hit on a disconnected body flashes');
  effect.update({ ...offline, health: 0 });
  assert.deepEqual(emission(surface), baseline, 'and the flash ends when that body is eliminated');
  effect.update({ ...living, protectedUntil: 15_000 });
  effect.impact('head'); assert.notDeepEqual(emission(surface), baseline);
  effect.dispose(); assert.deepEqual(emission(surface), baseline);
});

test('exact emissive baselines survive interruption, zero original intensity, invalid clocks and disposal', () => {
  for (const intensity of [0, .37, 1.6]) {
    const surface = new THREE.MeshStandardMaterial({ emissive: new THREE.Color(.11, .22, .33), emissiveIntensity: intensity });
    const baseline = emission(surface);
    let clock = 50;
    const effect = createAccentImpact(surface, () => clock);
    let disposals = 0; surface.addEventListener('dispose', () => disposals++);
    effect.impact('hit'); clock = 70; effect.update(living); effect.impact('blast');
    clock = 10_000; effect.update(living);
    assert.deepEqual(emission(surface), baseline);
    effect.impact('head'); clock = NaN; effect.update(living);
    assert.deepEqual(emission(surface), baseline);
    effect.impact('blast'); assert.deepEqual(emission(surface), baseline);
    clock = 20_000; effect.impact('blast'); effect.dispose(); effect.dispose();
    assert.deepEqual(emission(surface), baseline);
    effect.impact('hit'); effect.update(living);
    assert.deepEqual(emission(surface), baseline);
    assert.equal(disposals, 0, 'A caller-owned fallback material is not disposed by its pulse');
    surface.dispose();
  }
});

test('Scout cleanup disposes its private material once, never shared textures, and ignores late impacts', async () => {
  const asset = await loadScout(), model = clone(asset.scene);
  const shared = materials(asset.scene);
  const effect = createCharacterImpact(model, () => 20);
  const owned = bodySurface(model), baseline = emission(owned);
  let privateDisposals = 0, sharedDisposals = 0, textureDisposals = 0;
  owned.addEventListener('dispose', () => privateDisposals++);
  const onMaterialDispose = () => sharedDisposals++;
  const onTextureDispose = () => textureDisposals++;
  const textures = new Set<THREE.Texture>();
  for (const material of shared) {
    material.addEventListener('dispose', onMaterialDispose);
    if (material instanceof THREE.MeshStandardMaterial) for (const texture of [material.map, material.normalMap, material.roughnessMap, material.metalnessMap, material.emissiveMap]) if (texture) textures.add(texture);
  }
  for (const texture of textures) texture.addEventListener('dispose', onTextureDispose);
  assert.ok(textures.size > 0, 'The asset includes shared PBR texture references');
  effect.impact('blast'); effect.dispose(); effect.dispose();
  effect.impact('hit'); effect.update(living);
  assert.equal(privateDisposals, 1); assert.equal(sharedDisposals, 0); assert.equal(textureDisposals, 0);
  assert.deepEqual(emission(owned), baseline);
  assert.equal(bodySurface(model), bodySurface(asset.scene));
  for (const material of shared) material.removeEventListener('dispose', onMaterialDispose);
  for (const texture of textures) texture.removeEventListener('dispose', onTextureDispose);
});

test('the loading fallback follows the same isolation, lifecycle and late-disposal contract', () => {
  const victim = createCharacter('#f123ab'), other = createCharacter('#54ed32');
  const accent = materials(victim.root).find(material => material instanceof THREE.MeshStandardMaterial && material.color.getHexString() === 'f123ab');
  assert.ok(accent instanceof THREE.MeshStandardMaterial);
  const baseline = emission(accent), otherSurfaces = materials(other.root).filter(material => material instanceof THREE.MeshStandardMaterial) as THREE.MeshStandardMaterial[];
  const otherBefore = otherSurfaces.map(emission), beforePose = pose(victim.root);
  victim.impact('head');
  assert.notDeepEqual(emission(accent), baseline);
  assert.deepEqual(otherSurfaces.map(emission), otherBefore);
  assert.deepEqual(pose(victim.root), beforePose);
  const player: PublicPlayerState = {
    id: 'victim', name: 'Victim', color: '#f123ab', x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
    vx: 0, vy: 0, vz: 0, health: 0, slot: 1, weapon: 'kr5', loadout: DEFAULT_LOADOUT,
    kills: 0, deaths: 1, assists: 0, score: 0, streak: 0, connected: true, respawnAt: 3_000, protectedUntil: 0,
    reloadingUntil: 0, posture: 'stand', vault: null, slideUntil: 0, cookingSince: 0, lastInputSeq: 0,
  };
  victim.update(player, 0, 0, false);
  assert.deepEqual(emission(accent), baseline);
  victim.impact('blast'); assert.deepEqual(emission(accent), baseline);
  victim.update({ ...player, health: 100, protectedUntil: 5_000 }, 0, 3_000, false);
  victim.impact('blast'); assert.notDeepEqual(emission(accent), baseline);
  let disposals = 0; accent.addEventListener('dispose', () => disposals++);
  victim.dispose(); victim.dispose(); victim.impact('hit');
  assert.equal(disposals, 1); assert.deepEqual(emission(accent), baseline);
  other.dispose();
});

test('an operator export without scout names pulses only its non-accent skinned body materials', () => {
  const geometry = new THREE.BoxGeometry(0.4, 1.8, 0.3), count = geometry.getAttribute('position').count;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(count * 4).fill(0), 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: count * 4 }, (_, index) => index % 4 === 0 ? 1 : 0), 4));
  const gear = new THREE.MeshStandardMaterial({ name: 'OperatorGear' }), accent = new THREE.MeshStandardMaterial({ name: 'PlayerAccent' });
  const visor = new THREE.MeshStandardMaterial({ name: 'Visor' });
  geometry.clearGroups(); geometry.addGroup(0, 12, 0); geometry.addGroup(12, 12, 1); geometry.addGroup(24, 12, 2);
  const mesh = new THREE.SkinnedMesh(geometry, [gear, accent, visor]), bone = new THREE.Bone();
  mesh.add(bone); mesh.bind(new THREE.Skeleton([bone]));
  const model = new THREE.Group(); model.add(mesh);
  const effect = createCharacterImpact(model, () => 0);
  const bound = mesh.material as THREE.MeshStandardMaterial[];
  assert.notEqual(bound[0], gear, 'The body surface is privately cloned');
  assert.equal(bound[1], accent); assert.equal(bound[2], visor);
  const restingAccent = emission(accent), restingVisor = emission(visor), restingGear = emission(bound[0]!);
  effect.update(living); effect.impact('head');
  assert.notDeepEqual(emission(bound[0]!), restingGear);
  assert.deepEqual(emission(accent), restingAccent); assert.deepEqual(emission(visor), restingVisor);
  effect.dispose();
  assert.deepEqual(mesh.material, [gear, accent, visor], 'Disposal restores the shared materials');
  geometry.dispose(); gear.dispose(); accent.dispose(); visor.dispose();
});

test('the pulse copy keeps the per-character sun shading, so a hit body still darkens in baked shade', async () => {
  const shaded = (material: THREE.Material, sun: { value: number }) => {
    const shader = { uniforms: {} as Record<string, unknown>, vertexShader: '', fragmentShader: '#include <common>\nvoid main() {\n#include <lights_fragment_begin>\n}' };
    material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    assert.equal(shader.uniforms.uSunVisibility, sun, 'The copy reads this character\'s sun uniform');
    assert.match(shader.fragmentShader, /directLight\.color \*= uSunVisibility/);
  };
  const geometry = new THREE.BoxGeometry(0.4, 1.8, 0.3), count = geometry.getAttribute('position').count;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(count * 4).fill(0), 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: count * 4 }, (_, index) => index % 4 === 0 ? 1 : 0), 4));
  const gear = new THREE.MeshStandardMaterial({ name: 'OperatorGear' }), sun = { value: 0.2 };
  applySunVisibility(gear, sun);
  const mesh = new THREE.SkinnedMesh(geometry, gear), bone = new THREE.Bone();
  mesh.add(bone); mesh.bind(new THREE.Skeleton([bone]));
  const operator = new THREE.Group(); operator.add(mesh);
  const effect = createCharacterImpact(operator, () => 0);
  const copy = mesh.material as THREE.MeshStandardMaterial;
  assert.notEqual(copy, gear, 'The pulse draws through a private copy');
  assert.match(copy.customProgramCacheKey(), /kannon-sun-visibility/, 'The copy compiles the sun-shading variant');
  assert.equal(copy.customProgramCacheKey(), gear.customProgramCacheKey(), 'Hit bodies share the program of unhit ones');
  shaded(copy, sun);
  effect.dispose(); geometry.dispose(); gear.dispose();
  // The exported Scout body keeps its hook the same way.
  const scout = clone((await loadScout()).scene), scoutSun = { value: 0.6 };
  const cache = new Map<THREE.Material, THREE.Material>();
  scout.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const own = (material: THREE.Material) => { let copy = cache.get(material); if (!copy) { copy = material.clone(); applySunVisibility(copy, scoutSun); cache.set(material, copy); } return copy; };
    object.material = Array.isArray(object.material) ? object.material.map(own) : own(object.material);
  });
  const scoutEffect = createCharacterImpact(scout, () => 0);
  shaded(bodySurface(scout), scoutSun);
  scoutEffect.dispose();
  for (const material of cache.values()) material.dispose();
});
