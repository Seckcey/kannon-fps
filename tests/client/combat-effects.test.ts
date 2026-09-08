import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { GameEvent, ShotTrace, Vec3 } from '../../shared/protocol';
import { CombatEffects, resolveVisualMuzzle } from '../../src/game/CombatEffects';

type Shot = Extract<GameEvent, { type: 'shot' }>;
const origin = { x: -27, y: 1.45, z: 0 };
const endpoint = { x: -27, y: 1.45, z: -10 };
const shot = (traces: ShotTrace[] | undefined, slot: 1 | 2 = 1): Shot => ({
  type: 'shot', playerId: 'dad', slot, from: { ...origin }, to: { ...endpoint }, hit: false, at: 10_000, traces,
});
function camera() {
  const value = new THREE.PerspectiveCamera(68, 1, .06, 200);
  value.position.set(-25, 3, 4); value.lookAt(-27, 1.45, -5);
  return value;
}
function batches(effects: CombatEffects) {
  return effects.root.children.map(object => {
    assert.ok(object instanceof THREE.Mesh);
    assert.ok(object.material instanceof THREE.ShaderMaterial);
    return object as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  });
}
function quads(mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>) {
  const { geometry } = mesh, position = geometry.getAttribute('position'), color = geometry.getAttribute('color');
  const kind = geometry.getAttribute('effectKind');
  const count = geometry.drawRange.count / 6;
  assert.ok(Number.isInteger(count) && count >= 0 && count <= position.count / 4);
  return Array.from({ length: count }, (_, index) => {
    const vertices = Array.from({ length: 4 }, (_, corner) => new THREE.Vector3().fromBufferAttribute(position, index * 4 + corner));
    const center = vertices.reduce((sum, vertex) => sum.add(vertex), new THREE.Vector3()).multiplyScalar(.25);
    return { center, vertices, kind: kind.getX(index * 4), color: new THREE.Color().fromBufferAttribute(color, index * 4) };
  });
}

test('large shot backlogs retain two fixed resource batches and respect every render-buffer bound', () => {
  const effects = new CombatEffects(), view = camera(), original = batches(effects);
  assert.equal(original.length, 2);
  const resources = original.map(mesh => ({
    geometry: mesh.geometry, material: mesh.material, index: mesh.geometry.index,
    attributes: { ...mesh.geometry.attributes },
    arrays: Object.fromEntries(Object.entries(mesh.geometry.attributes).map(([name, attribute]) => [name, attribute.array])),
  }));
  const palette: ShotTrace[] = [
    { to: endpoint, kind: 'range' },
    { to: endpoint, kind: 'player', targetId: 'son', shield: true },
    { to: endpoint, kind: 'world' },
  ];
  // No update between emissions reproduces paused RAF while transport callbacks
  // keep arriving. The old implementation allocated a new Line per shot here.
  for (let index = 0; index < 2_000; index++) {
    effects.shot(shot(Array.from({ length: 9 }, (_, pellet) => palette[(index + pellet) % palette.length]), 2));
    if (index % 7 === 0) { effects.elimination(origin); effects.heal(origin); effects.respawn(origin); }
  }
  assert.deepEqual(batches(effects), original, 'Events cannot add scene objects');
  effects.update(0, view);
  original.forEach((mesh, index) => {
    const saved = resources[index];
    assert.equal(mesh.geometry, saved.geometry); assert.equal(mesh.material, saved.material); assert.equal(mesh.geometry.index, saved.index);
    for (const [name, attribute] of Object.entries(mesh.geometry.attributes)) {
      assert.equal(attribute, saved.attributes[name]); assert.equal(attribute.array, saved.arrays[name]);
      assert.ok(Array.from(attribute.array).every(Number.isFinite), `${name} remains finite under saturation`);
    }
    const maximumQuads = mesh.material.blending === THREE.AdditiveBlending ? 512 + 96 : 256;
    assert.equal(mesh.geometry.getAttribute('position').count, maximumQuads * 4);
    assert.ok(mesh.geometry.drawRange.count > 0 && mesh.geometry.drawRange.count <= maximumQuads * 6);
    assert.equal(mesh.material.depthWrite, false); assert.equal(mesh.material.depthTest, true);
  });
  effects.update(2, view);
  for (const mesh of original) { assert.equal(mesh.geometry.drawRange.count, 0); assert.equal(mesh.visible, false); }
  effects.shot(shot([{ to: endpoint, kind: 'world' }])); effects.update(0, view);
  assert.ok(original.some(mesh => mesh.visible), 'Expired slots can serve fresh effects');
  effects.clear();
  for (const mesh of original) { assert.equal(mesh.geometry.drawRange.count, 0); assert.equal(mesh.visible, false); }
  effects.update(.01, view);
  assert.ok(original.every(mesh => !mesh.visible), 'Resume cannot replay cleared hidden-tab particles');
  effects.dispose();
});

test('only actual pellet contacts create endpoint impacts; protected and range contacts do not become damage sparks', () => {
  const effects = new CombatEffects(), view = camera();
  const glow = batches(effects).find(mesh => mesh.material.blending === THREE.AdditiveBlending)!;
  const dust = batches(effects).find(mesh => mesh.material.blending === THREE.NormalBlending)!;
  const nearEndpoint = () => quads(glow).filter(quad => quad.center.distanceTo(new THREE.Vector3(endpoint.x, endpoint.y, endpoint.z)) < .1);
  for (const trace of [
    { to: endpoint, kind: 'range' as const },
    { to: endpoint, kind: 'player' as const, targetId: 'son', protected: true, shield: true },
  ]) {
    effects.clear(); effects.shot({ ...shot([trace]), hit: true }); effects.update(0, view);
    assert.equal(quads(dust).length, 0);
    assert.equal(nearEndpoint().length, 0, 'The aggregate any-pellet hit bit cannot invent this pellet impact');
    assert.ok(quads(glow).some(quad => quad.center.distanceTo(new THREE.Vector3(origin.x, origin.y, origin.z)) < .1), 'Accepted shots still have visible muzzle feedback');
  }
  const contactColors: THREE.Color[] = [];
  for (const shield of [true, false]) {
    effects.clear(); effects.shot(shot([{ to: endpoint, kind: 'player', targetId: 'son', shield }])); effects.update(0, view);
    assert.equal(quads(dust).length, 0, 'Player contact does not emit stone debris');
    const contacts = nearEndpoint(); assert.ok(contacts.length > 0);
    contactColors.push(contacts[0].color);
  }
  assert.ok(contactColors[0].b > contactColors[0].r, 'Shield collision uses cool light');
  assert.ok(contactColors[1].r > contactColors[1].b, 'Armor collision uses warm fragments');
  effects.clear(); effects.shot(shot([{ to: endpoint, kind: 'world' }])); effects.update(0, view);
  assert.ok(quads(dust).length > 0, 'Authoritative world contact emits debris even when no player was hit');
  assert.ok(quads(dust).every(quad => quad.center.distanceTo(new THREE.Vector3(endpoint.x, endpoint.y, endpoint.z)) < .1));
  effects.clear(); effects.shot({ ...shot(undefined), hit: false }); effects.update(0, view);
  assert.equal(quads(dust).length, 0, 'An older server without per-trace metadata cannot prove a world impact');
  assert.equal(nearEndpoint().length, 0);
  effects.dispose();
});

test('shotgun feedback follows all nine authoritative pellets without changing or expanding accepted traces', () => {
  const effects = new CombatEffects(), view = camera();
  const glow = batches(effects).find(mesh => mesh.material.blending === THREE.AdditiveBlending)!;
  const traces: ShotTrace[] = Array.from({ length: 12 }, (_, pellet) => ({ to: { x: -27 + pellet * .03, y: 1.45 + pellet * .02, z: -10 }, kind: 'range' }));
  const event = shot(traces, 2), original = structuredClone(event);
  Object.freeze(event.from); Object.freeze(event.to); traces.forEach(trace => { Object.freeze(trace.to); Object.freeze(trace); }); Object.freeze(traces); Object.freeze(event);
  effects.shot(event); effects.update(0, view);
  const trails = quads(glow).filter(quad => quad.kind === 1);
  assert.equal(trails.length, 9, 'The renderer respects the bounded actual shotgun pellet contract');
  assert.equal(new Set(trails.map(quad => quad.center.x.toFixed(5))).size, 9, 'Distinct supplied endpoints remain distinct instead of using the center ray nine times');
  assert.deepEqual(event, original);
  effects.clear(); effects.shot({ ...event, slot: 1 }); effects.update(0, view);
  assert.equal(quads(glow).filter(quad => quad.kind === 1).length, 1, 'AR presentation uses one ray even if given surplus metadata');
  effects.dispose();
});

test('a shot accepted before a weapon switch keeps its trace and contact without flashing the newly equipped weapon', () => {
  const effects = new CombatEffects(), view = camera();
  const glow = batches(effects).find(mesh => mesh.material.blending === THREE.AdditiveBlending)!;
  const dust = batches(effects).find(mesh => mesh.material.blending === THREE.NormalBlending)!;
  for (const trace of [
    { to: endpoint, kind: 'world' as const },
    { to: endpoint, kind: 'player' as const, targetId: 'son', shield: true },
  ]) {
    const event = shot([trace]), before = structuredClone(event);
    effects.clear(); effects.shot(event, undefined, false); effects.update(0, view);
    const glowing = quads(glow);
    assert.equal(glowing.filter(quad => quad.kind === 0).length, 0, 'The now-unequipped weapon produces no muzzle flare');
    assert.ok(glowing.some(quad => quad.center.z < -1 && quad.center.z > -4), 'The accepted tracer remains visible along its authoritative route');
    const contacts = trace.kind === 'world' ? quads(dust) : glowing;
    assert.ok(contacts.some(quad => quad.center.distanceTo(new THREE.Vector3(endpoint.x, endpoint.y, endpoint.z)) < .1), 'The actual hit still produces contact feedback');
    assert.deepEqual(event, before, 'Suppressing a cosmetic flash cannot rewrite a shot or its hit metadata');

    effects.clear(); effects.shot(event); effects.update(0, view);
    assert.ok(quads(glow).some(quad => quad.kind === 0), 'Existing calls retain muzzle feedback by default');
  }
  effects.dispose();
});

test('point-blank contacts retain impacts without backwards beams or zero-length contact loss', () => {
  const effects = new CombatEffects(), view = camera();
  const scenarios = [
    { contact: { ...origin, z: -.15 }, muzzle: { ...origin, z: -.85 } },
    { contact: { ...origin, z: -.85 }, muzzle: { ...origin, z: -.85 } },
    { contact: { ...origin }, muzzle: { ...origin } },
  ];
  for (const kind of ['player', 'world'] as const) for (const { contact, muzzle } of scenarios) {
    const event: Shot = { ...shot([{ to: contact, kind, ...(kind === 'player' ? { targetId: 'son', shield: true } : {}) }]), to: contact };
    const before = structuredClone(event);
    effects.clear(); effects.shot(event, muzzle, false); effects.update(0, view);
    const visible = batches(effects).flatMap(quads);
    assert.ok(visible.length > 0, `${kind} contact remains visible even when there is no forward tracer segment`);
    const accepted = new THREE.Vector3(contact.x, contact.y, contact.z);
    for (const quad of visible) {
      assert.ok(quad.center.distanceTo(accepted) < .09, 'All remaining quads belong to the accepted impact, not a beam travelling backwards from the barrel');
      assert.ok(quad.vertices[0].distanceTo(quad.vertices[2]) < .2, 'A long reverse tracer cannot masquerade as a contact particle');
      assert.ok(quad.vertices.every(vertex => vertex.toArray().every(Number.isFinite)), 'Coincident origins and contacts stay finite');
    }
    assert.deepEqual(event, before);
  }
  const { contact, muzzle } = scenarios[0];
  effects.clear(); effects.shot({ ...shot([{ to: contact, kind: 'range' }]), to: contact }, muzzle, false); effects.update(0, view);
  assert.ok(batches(effects).every(mesh => mesh.geometry.drawRange.count === 0 && !mesh.visible), 'A range endpoint behind the visual origin provides neither a forward beam nor an impact');
  effects.dispose();
});

test('visual barrels and tracer strips remain on the visible side of real shared-map cover', () => {
  const authoritative = { x: 14, y: 1.45, z: 1 }, visual = { x: 15.5, y: 1.45, z: 1 };
  const from = resolveVisualMuzzle(authoritative, visual);
  assert.ok(from.x >= authoritative.x && from.x < 15, 'The cosmetic barrel cannot cross the east building face at x=15');
  assert.equal(from.y, authoritative.y); assert.equal(from.z, authoritative.z);
  const open: Vec3 = { x: -26.865, y: 1.457, z: -.847 };
  assert.ok(resolveVisualMuzzle(origin, open).distanceTo(new THREE.Vector3(open.x, open.y, open.z)) < 1e-8, 'Unobstructed shots begin at the actual modeled barrel');
  for (const invalid of [{ x: NaN, y: 0, z: 0 }, { x: 50, y: 40, z: 30 }]) assert.deepEqual(resolveVisualMuzzle(origin, invalid).toArray(), [origin.x, origin.y, origin.z]);
  const downward = resolveVisualMuzzle(origin, { ...origin, y: -.2 });
  assert.ok(downward.y >= 0 && downward.y < origin.y, 'The floor also clips cosmetic offsets');

  const effects = new CombatEffects(), view = camera();
  const glow = batches(effects).find(mesh => mesh.material.blending === THREE.AdditiveBlending)!;
  // The authoritatively clear ray stays east of the west building. An animated
  // barrel offset outside its north face would point through it if not clipped.
  const event: Shot = { ...shot([{ to: { x: -14, y: 1.45, z: 8 }, kind: 'range' }]), from: { x: -14, y: 1.45, z: -8 }, to: { x: -14, y: 1.45, z: 8 } };
  const before = structuredClone(event);
  effects.shot(event, { x: -16, y: 1.45, z: -8 }); effects.update(.07, view);
  const trails = quads(glow).filter(quad => quad.kind === 1);
  assert.equal(trails.length, 1);
  assert.ok(trails[0].vertices.every(vertex => vertex.z <= -7.48), 'A cosmetic tracer stops at the nearby north wall, not the accepted distant endpoint');
  assert.deepEqual(event, before, 'Visual occlusion never rewrites authoritative hit data');
  effects.dispose();
});

test('camera-aligned shots stay finite and disposal releases each owned resource once despite late events', () => {
  const effects = new CombatEffects(), scene = new THREE.Scene(), view = camera();
  scene.add(effects.root);
  const original = batches(effects), disposals = new Map<THREE.BufferGeometry | THREE.Material, number>();
  for (const mesh of original) for (const resource of [mesh.geometry, mesh.material]) {
    disposals.set(resource, 0); resource.addEventListener('dispose', () => disposals.set(resource, disposals.get(resource)! + 1));
  }
  for (const eye of [origin, endpoint, { x: -27, y: 1.45, z: 4 }, { x: -27, y: 1.45, z: -1.75 }]) {
    effects.clear(); view.position.set(eye.x, eye.y, eye.z); view.lookAt(-27, 1.45, -20);
    effects.shot(shot([{ to: endpoint, kind: 'range' }])); effects.update(0, view);
    for (const mesh of original) assert.ok(Array.from(mesh.geometry.getAttribute('position').array).every(Number.isFinite), 'End-on or coincident camera rays cannot create NaN vertices');
  }
  effects.update(NaN, view); effects.update(-1, view);
  effects.dispose(); effects.dispose();
  effects.shot(shot([{ to: endpoint, kind: 'world' }])); effects.elimination(origin); effects.heal(origin); effects.respawn(origin); effects.update(0, view); effects.clear();
  assert.equal(effects.root.parent, null); assert.equal(effects.root.children.length, 0);
  for (const [resource, count] of disposals) assert.equal(count, 1, `${resource.type} has one owner and one disposal`);
  for (const mesh of original) assert.equal(mesh.geometry.drawRange.count, 0, 'Late events cannot resurrect disposed effects');
});
