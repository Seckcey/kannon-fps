import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { DroneState, GameEvent, ShotTrace, SurfaceKind, Vec3 } from '../../shared/protocol';
import { OBSTACLES, type MapObstacle } from '../../shared/map';
import { raycastMap } from '../../shared/physics';
import { renderTier } from '../../src/game/RenderTiers';
import { CombatEffects, resolveVisualMuzzle } from '../../src/game/CombatEffects';
import { effectBudget, effectsOptionsFor, scaledCount } from '../../src/game/effects/budget';
import { EFFECT_KIND } from '../../src/game/effects/QuadBatch';
import { rayDistance } from '../../src/game/effects/mapQuery';
import { DECAL_ATLAS, DECAL_CELLS, buildDecalAtlas } from '../../src/game/effects/decalAtlas';
import { EXPLOSION_RECIPES } from '../../src/game/effects/recipes';
import { EffectRandom } from '../../src/game/effects/random';

type Shot = Extract<GameEvent, { type: 'shot' }>;
type Batch = THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
interface Quad { center: THREE.Vector3; vertices: THREE.Vector3[]; kind: number; color: THREE.Color; opacity: number }

// The west back yard (x = -27) is open ground between the house and the yard fence.
const origin: Vec3 = { x: -27, y: 1.45, z: 0 };
const endpoint: Vec3 = { x: -27, y: 1.45, z: -10 };
const facingShooter: Vec3 = { x: 0, y: 0, z: 1 };
const up: Vec3 = { x: 0, y: 1, z: 0 };
// Open street asphalt north of the bus, clear of every cover box.
const street: Vec3 = { x: 0, y: 0.07, z: -12 };
const remote = { local: false, tracer: true } as const;
const v3 = (point: Vec3) => new THREE.Vector3(point.x, point.y, point.z);
const shot = (traces: ShotTrace[], weapon: Shot['weapon'] = 'kr5', from: Vec3 = origin): Shot => ({
  type: 'shot', playerId: 'son', weapon, from: { ...from }, traces, hit: traces.some(trace => trace?.kind === 'player'), at: 10_000,
});
/** An instance pose. Hidden instances have a zero matrix (three's decompose reports scale 1 for those). */
function instancePose(mesh: THREE.InstancedMesh, index: number) {
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), rotation = new THREE.Quaternion(), ignored = new THREE.Vector3();
  mesh.getMatrixAt(index, matrix);
  const scale = new THREE.Vector3().setFromMatrixScale(matrix);
  matrix.decompose(position, rotation, ignored);
  return { position: position.setFromMatrixPosition(matrix), rotation, scale };
}
const worldTrace = (to: Vec3 = endpoint, surface: SurfaceKind = 'concrete', normal: Vec3 = facingShooter): ShotTrace => ({ to, kind: 'world', normal, surface });

function camera() {
  const value = new THREE.PerspectiveCamera(68, 1, 0.06, 200);
  value.position.set(-25, 3, 4); value.lookAt(-27, 1.45, -5);
  return value;
}
function part<T extends THREE.Object3D>(effects: CombatEffects, name: string): T {
  const object = effects.root.getObjectByName(name);
  assert.ok(object, `${name} exists`);
  return object as T;
}
const glowOf = (effects: CombatEffects) => part<Batch>(effects, 'combat-glow-batch');
const dustOf = (effects: CombatEffects) => part<Batch>(effects, 'combat-dust-batch');
const lightsOf = (effects: CombatEffects) => effects.root.children.filter((child): child is THREE.PointLight => child instanceof THREE.PointLight);
const capacityOf = (mesh: THREE.Mesh) => mesh.geometry.getAttribute('position').count / 4;
function quads(mesh: Batch): Quad[] {
  const { geometry } = mesh;
  const position = geometry.getAttribute('position'), color = geometry.getAttribute('color') as THREE.BufferAttribute;
  const kind = geometry.getAttribute('effectKind'), opacity = geometry.getAttribute('effectOpacity');
  const count = geometry.drawRange.count / 6;
  assert.ok(Number.isInteger(count) && count >= 0 && count <= position.count / 4);
  return Array.from({ length: count }, (_, index) => {
    const vertices = Array.from({ length: 4 }, (_, corner) => new THREE.Vector3().fromBufferAttribute(position, index * 4 + corner));
    const center = vertices.reduce((sum, vertex) => sum.add(vertex), new THREE.Vector3()).multiplyScalar(0.25);
    return { center, vertices, kind: kind.getX(index * 4), opacity: opacity.getX(index * 4), color: new THREE.Color().fromBufferAttribute(color, index * 4) };
  });
}
/** Stored decals (unused ring slots are collapsed to a point). `radius` is half the quad's edge. */
function decalQuads(effects: CombatEffects) {
  const position = part<THREE.Mesh>(effects, 'combat-decals').geometry.getAttribute('position');
  const result: Array<{ center: THREE.Vector3; vertices: THREE.Vector3[]; radius: number }> = [];
  for (let index = 0; index < position.count / 4; index++) {
    const vertices = Array.from({ length: 4 }, (_, corner) => new THREE.Vector3().fromBufferAttribute(position, index * 4 + corner));
    if (vertices[0].distanceTo(vertices[2]) < 1e-6) continue;
    const center = vertices.reduce((sum, vertex) => sum.add(vertex), new THREE.Vector3()).multiplyScalar(0.25);
    result.push({ center, vertices, radius: vertices[0].distanceTo(vertices[1]) / 2 });
  }
  return result;
}
function meshesOf(effects: CombatEffects) {
  const meshes: THREE.Mesh[] = [];
  effects.root.traverse(object => { if (object instanceof THREE.Mesh) meshes.push(object); });
  return meshes;
}
function assertFinite(effects: CombatEffects) {
  for (const mesh of meshesOf(effects)) {
    for (const [name, attribute] of Object.entries(mesh.geometry.attributes)) {
      assert.ok(Array.from(attribute.array as ArrayLike<number>).every(Number.isFinite), `${mesh.name}.${name} stays finite`);
    }
    if (mesh instanceof THREE.InstancedMesh) assert.ok(Array.from(mesh.instanceMatrix.array).every(Number.isFinite), `${mesh.name} matrices stay finite`);
  }
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}
function pane(name: string, x: number, y: number, z: number, turn = 0) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
  mesh.name = name; mesh.position.set(x, y, z); mesh.rotation.y = turn;
  return mesh;
}

test('every effect budget halves on phones, and flash lights exist only where the tier allows them', () => {
  const desktop = effectBudget({ quality: 'desktop' }), phone = effectBudget({ quality: 'phone' });
  for (const key of ['glowParticles', 'dustParticles', 'smokeParticles', 'plumeParticles', 'tracers', 'shells', 'scorches'] as const) {
    assert.ok(desktop[key] > 0, key);
    assert.equal(phone[key], Math.ceil(desktop[key] / 2), `${key} is halved on phones`);
  }
  assert.equal(desktop.scale, 1); assert.equal(phone.scale, 0.5);
  assert.equal(desktop.decals, 128); assert.equal(phone.decals, 48);
  assert.ok(desktop.lights >= 2); assert.equal(phone.lights, 0);
  assert.equal(effectBudget({ quality: 'desktop', muzzleLight: false }).lights, 0);
  assert.equal(effectBudget({ quality: 'desktop', decals: 9.7 }).decals, 9);
  assert.equal(effectBudget({ quality: 'desktop', decals: -3 }).decals, 0);
  assert.equal(effectBudget({ quality: 'desktop', decals: NaN }).decals, 128);
  assert.equal(effectBudget(null).quality, 'desktop');
  assert.equal(scaledCount(5, 0.5), 3); assert.equal(scaledCount(1, 0.5), 1); assert.equal(scaledCount(0, 1), 0); assert.equal(scaledCount(NaN, 1), 0);
  assert.deepEqual(effectsOptionsFor(renderTier('auto', true, true)), { quality: 'phone', muzzleLight: false, decals: 48 });
  assert.deepEqual(effectsOptionsFor(renderTier('high', false, true)), { quality: 'desktop', muzzleLight: true, decals: 192 });

  for (const options of [effectsOptionsFor(renderTier('high', false, true)), { quality: 'phone' as const }]) {
    const effects = new CombatEffects(options), budget = effects.budget;
    assert.deepEqual(budget, effectBudget(options));
    assert.equal(capacityOf(glowOf(effects)), budget.glowParticles + budget.tracers + budget.markers);
    assert.equal(capacityOf(dustOf(effects)), budget.dustParticles + budget.smokeParticles + budget.plumeParticles);
    assert.equal(part<THREE.InstancedMesh>(effects, 'combat-shells').instanceMatrix.count, budget.shells);
    assert.equal(capacityOf(part<THREE.Mesh>(effects, 'combat-decals')), budget.decals + budget.scorches);
    assert.equal(lightsOf(effects).length, budget.lights);
    effects.dispose();
  }
  const fallback = new CombatEffects();
  assert.deepEqual(fallback.budget, desktop, 'the contract default is the desktop budget');
  fallback.dispose();
});

test('a long burst with no frames keeps one fixed set of scene objects and buffers inside their bounds', () => {
  const effects = new CombatEffects(), view = camera(), budget = effects.budget;
  const children = [...effects.root.children], meshes = meshesOf(effects);
  const saved = meshes.map(mesh => ({
    geometry: mesh.geometry, material: mesh.material,
    attributes: Object.fromEntries(Object.entries(mesh.geometry.attributes).map(([name, attribute]) => [name, { attribute, array: attribute.array }])),
  }));
  const palette: ShotTrace[] = [
    { to: endpoint, kind: 'range' }, { to: endpoint, kind: 'player', targetId: 'dad', zone: 'torso' },
    { to: endpoint, kind: 'player', targetId: 'dad', protected: true }, worldTrace(), { to: endpoint, kind: 'drone', targetId: 'drone-1' },
  ];
  // No update between emissions reproduces a paused frame loop while network events keep arriving.
  for (let index = 0; index < 2_000; index++) {
    const traces = Array.from({ length: 8 }, (_, pellet) => palette[(index + pellet) % palette.length]);
    effects.shot(shot(traces, index % 3 ? 'kr5' : 'breaker12'), origin, { local: index % 2 === 0, tracer: index % 3 === 0 });
    if (index % 7 === 0) {
      effects.elimination(origin); effects.respawn(origin); effects.impact(endpoint, facingShooter, 'metal');
      effects.shell(v3(origin), new THREE.Vector3(1, 1, 0), 'kr5'); effects.localShot(origin, endpoint, 'kr5', true);
    }
    if (index % 97 === 0) effects.explosion({ x: -27, y: 0.07, z: -4 }, 'frag');
  }
  assert.deepEqual(effects.root.children, children, 'Events add no scene objects');
  effects.update(0, view);
  assert.deepEqual(meshesOf(effects), meshes, 'No mesh is created per event');
  meshes.forEach((mesh, index) => {
    assert.equal(mesh.geometry, saved[index].geometry); assert.equal(mesh.material, saved[index].material);
    for (const [name, attribute] of Object.entries(mesh.geometry.attributes)) {
      assert.equal(attribute, saved[index].attributes[name].attribute, `${mesh.name}.${name} is the same attribute`);
      assert.equal(attribute.array, saved[index].attributes[name].array, `${mesh.name}.${name} keeps its persistent buffer`);
    }
  });
  assertFinite(effects);
  for (const mesh of [glowOf(effects), dustOf(effects)]) {
    assert.ok(mesh.geometry.drawRange.count > 0 && mesh.geometry.drawRange.count <= capacityOf(mesh) * 6);
    assert.equal(mesh.material.depthWrite, false); assert.equal(mesh.material.depthTest, true);
  }
  const stats = effects.stats();
  assert.ok(stats.glow <= budget.glowParticles && stats.dust <= budget.dustParticles + budget.smokeParticles + budget.plumeParticles && stats.tracers <= budget.tracers);
  assert.ok(stats.smoke <= budget.smokeParticles && stats.plume <= budget.plumeParticles);
  assert.equal(stats.decals, budget.decals, 'The hole ring is full and never larger');
  assert.ok(stats.shells > 0 && stats.shells <= budget.shells);
  effects.update(30, view);
  for (const mesh of [glowOf(effects), dustOf(effects)]) { assert.equal(mesh.geometry.drawRange.count, 0); assert.equal(mesh.visible, false); }
  assert.equal(effects.stats().shells, 0);
  assert.equal(effects.stats().decals, budget.decals, 'Holes outlive the particles');
  effects.shot(shot([worldTrace()]), origin, remote); effects.update(0, view);
  assert.ok(glowOf(effects).visible && dustOf(effects).visible, 'Expired slots serve fresh effects');
  effects.dispose();
});

test('tracers follow the caller, shotguns draw at most eight pellets, and local shots leave the flash to the viewmodel', () => {
  const effects = new CombatEffects(), view = camera();
  const kinds = (kind: number) => quads(glowOf(effects)).filter(quad => quad.kind === kind);
  const pellets: ShotTrace[] = Array.from({ length: 12 }, (_, pellet) => ({ to: { x: -27 + pellet * 0.03, y: 1.45 + pellet * 0.02, z: -10 }, kind: 'range' }));
  const event = shot(pellets, 'breaker12'), before = structuredClone(event);
  deepFreeze(event);
  effects.shot(event, origin, remote); effects.update(0, view);
  const tracers = kinds(EFFECT_KIND.tracer);
  assert.equal(tracers.length, 8, 'The shotgun presents its eight real pellets and ignores surplus traces');
  assert.equal(new Set(tracers.map(quad => quad.center.x.toFixed(5))).size, 8, 'Each pellet keeps its own endpoint');
  assert.ok(kinds(EFFECT_KIND.flash).length > 0 && kinds(EFFECT_KIND.flash).every(quad => quad.center.distanceTo(v3(origin)) < 0.6), 'A remote muzzle flash sits on the muzzle');
  assert.ok(quads(dustOf(effects)).some(quad => quad.center.distanceTo(v3(origin)) < 0.8), 'and leaves a little smoke');
  assert.deepEqual(event, before, 'Presentation never rewrites the event');

  effects.clear(); effects.shot(shot(pellets.slice(0, 1)), origin, remote); effects.update(0, view);
  assert.equal(kinds(EFFECT_KIND.tracer).length, 1, 'Rifles draw one tracer');

  effects.clear(); effects.shot(shot(pellets.slice(0, 1)), origin, { local: false, tracer: false }); effects.update(0, view);
  assert.equal(kinds(EFFECT_KIND.tracer).length, 0, 'No tracer unless the caller asks for one');
  assert.ok(kinds(EFFECT_KIND.flash).length > 0, 'The remote flash still shows');

  effects.clear(); effects.shot(shot([worldTrace()]), origin, { local: true, tracer: false }); effects.update(0, view);
  assert.equal(kinds(EFFECT_KIND.flash).length, 0, 'The viewmodel draws the local flash');
  assert.equal(kinds(EFFECT_KIND.tracer).length, 0);
  assert.ok(quads(dustOf(effects)).some(quad => quad.center.distanceTo(v3(endpoint)) < 0.3), 'The confirmed impact still shows');
  assert.equal(effects.stats().decals, 1);
  assert.ok(lightsOf(effects).every(light => light.intensity === 0), 'A confirmed local shot does not flash a late light');

  effects.clear(); effects.localShot(origin, endpoint, 'kr5', true); effects.update(0, view);
  assert.equal(kinds(EFFECT_KIND.tracer).length, 1, 'The predicted shot draws its tracer at once');
  assert.equal(kinds(EFFECT_KIND.flash).length, 0);
  assert.equal(quads(dustOf(effects)).length, 0, 'Prediction shows no impact before the server confirms it');
  assert.ok(lightsOf(effects)[0].intensity > 0, 'The predicted shot lights the reserved muzzle light');
  effects.dispose();
});

test('impacts read as their surface, players get dark puffs and protected targets shimmer', () => {
  const view = camera();
  const sample = (surface: SurfaceKind | 'player', protectedTarget = false, quality: 'phone' | 'desktop' = 'desktop') => {
    const effects = new CombatEffects({ quality });
    effects.impact(endpoint, facingShooter, surface, protectedTarget); effects.update(0, view);
    const result = { glow: quads(glowOf(effects)), dust: quads(dustOf(effects)) };
    effects.dispose();
    return result;
  };
  const luminance = (color: THREE.Color) => 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
  for (const surface of ['asphalt', 'concrete', 'wood', 'grass', 'metal', 'fabric', 'glass', 'sandbag'] as const) {
    const { glow, dust } = sample(surface), phone = sample(surface, false, 'phone');
    assert.ok(glow.length + dust.length > 0, `${surface} shows an impact`);
    for (const quad of [...glow, ...dust]) assert.ok(quad.center.distanceTo(v3(endpoint)) < 0.25, `${surface} effects start at the contact`);
    const total = glow.length + dust.length, phoneTotal = phone.glow.length + phone.dust.length;
    assert.ok(phoneTotal > 0 && phoneTotal < total, `${surface}: phones get fewer particles (${phoneTotal} of ${total})`);
  }
  const metal = sample('metal');
  assert.ok(metal.glow.filter(quad => quad.kind === EFFECT_KIND.streak).length >= 4, 'Metal throws sparks');
  assert.ok(metal.glow.every(quad => quad.color.r >= quad.color.b), 'Sparks are warm');
  const wood = sample('wood');
  assert.ok(wood.dust.filter(quad => quad.kind === EFFECT_KIND.shard).length >= 3, 'Wood throws splinters');
  assert.ok(wood.dust.every(quad => quad.color.r > quad.color.b), 'Splinters and wood dust are brown');
  const concrete = sample('concrete');
  assert.ok(concrete.dust.some(quad => quad.kind === EFFECT_KIND.chip) && concrete.dust.some(quad => quad.kind === EFFECT_KIND.puff), 'Concrete chips and dusts');
  assert.ok(sample('grass').dust.some(quad => quad.kind === EFFECT_KIND.chip && luminance(quad.color) < 0.1), 'Grass kicks up dark dirt');
  assert.ok(sample('sandbag').dust.filter(quad => quad.kind === EFFECT_KIND.shard).every(quad => quad.color.r > quad.color.b), 'Sandbags spill sand');
  const glass = sample('glass');
  assert.ok(glass.dust.some(quad => quad.kind === EFFECT_KIND.shard && quad.color.b >= quad.color.r) && glass.glow.length > 0, 'Glass splinters and glints');
  const player = sample('player');
  assert.equal(player.glow.length, 0, 'No bright sparks on people');
  assert.ok(player.dust.length > 0 && player.dust.every(quad => luminance(quad.color) < 0.12), 'Hits on people are dark puffs');
  assert.ok(player.dust.every(quad => quad.color.r <= quad.color.g * 1.5), 'and never red');
  const shimmer = sample('player', true);
  assert.equal(shimmer.dust.length, 0, 'Protected targets do not puff');
  assert.ok(shimmer.glow.some(quad => quad.kind === EFFECT_KIND.ring) && shimmer.glow.every(quad => quad.color.b > quad.color.r), 'Protected targets shimmer cool');
});

test('only real contacts make impacts and holes; range ends and traces without a surface stay honest', () => {
  const effects = new CombatEffects(), view = camera(), at = v3(endpoint);
  const run = (trace: ShotTrace) => {
    effects.clear(); effects.shot(shot([trace]), origin, { local: true, tracer: false }); effects.update(0, view);
    return {
      glow: quads(glowOf(effects)).filter(quad => quad.center.distanceTo(at) < 0.3).length,
      dust: quads(dustOf(effects)).filter(quad => quad.center.distanceTo(at) < 0.3).length,
      rings: quads(glowOf(effects)).filter(quad => quad.kind === EFFECT_KIND.ring).length,
      holes: effects.stats().decals,
    };
  };
  assert.deepEqual(run({ to: endpoint, kind: 'range' }), { glow: 0, dust: 0, rings: 0, holes: 0 }, 'A range end is empty air');
  const player = run({ to: endpoint, kind: 'player', targetId: 'dad', zone: 'head' });
  assert.ok(player.dust > 0 && player.glow === 0 && player.holes === 0, 'A player hit is a dark puff with no hole');
  const shielded = run({ to: endpoint, kind: 'player', targetId: 'dad', protected: true });
  assert.ok(shielded.rings > 0 && shielded.dust === 0 && shielded.holes === 0, 'A protected target shimmers instead');
  const metal = run(worldTrace(endpoint, 'metal'));
  assert.ok(metal.glow > 0 && metal.holes === 1, 'A world contact with its face gets an impact and a hole');
  const older = run({ to: endpoint, kind: 'world' });
  assert.ok(older.dust > 0 && older.holes === 0, 'Without a face normal the contact shows, but no hole is guessed');
  const drone = run({ to: endpoint, kind: 'drone', targetId: 'drone-1' });
  assert.ok(drone.glow > 0 && drone.holes === 0, 'Drone hits spark');
  effects.dispose();
});

test("the watching player's own hits put no puff or shimmer in front of their eyes", () => {
  const effects = new CombatEffects();
  // The viewer stands 10 m north of a shooter at `origin` and looks back at them. A head hit lands on the
  // front of their own head box, 0.15 m in front of the eye.
  const eye = new THREE.Vector3(-27, 1.62, -10), view = new THREE.PerspectiveCamera(70, 1, 0.05, 200);
  view.position.copy(eye); view.lookAt(v3(origin));
  const head: Vec3 = { x: -27, y: 1.62, z: -9.85 }, other: Vec3 = { x: -26, y: 1.3, z: -6 };
  const near = (point: THREE.Vector3, radius: number) =>
    [...quads(glowOf(effects)), ...quads(dustOf(effects))].filter(quad => quad.kind !== EFFECT_KIND.tracer && quad.center.distanceTo(point) < radius);
  const tracers = () => quads(glowOf(effects)).filter(quad => quad.kind === EFFECT_KIND.tracer);
  const watching = { local: false, tracer: true, viewerId: 'dad' } as const;
  for (const protectedTarget of [false, true]) {
    effects.clear(); effects.update(0, view);
    effects.shot(shot([{ to: head, kind: 'player', targetId: 'dad', zone: 'head', protected: protectedTarget }]), origin, watching);
    effects.update(0.08, view);
    assert.equal(near(eye, 1).length, 0, `${protectedTarget ? 'A shimmer' : 'A dark puff'} never covers the viewer's own screen`);
    assert.equal(tracers().length, 1, 'The incoming tracer still shows where the shot came from');
    assert.ok(tracers()[0].vertices.every(vertex => vertex.distanceTo(eye) > 0.9), 'but stops short of the viewer');
    assert.ok(near(v3(origin), 0.6).length > 0, "and the shooter's muzzle still flashes");
  }
  effects.clear(); effects.update(0, view);
  effects.shot(shot([{ to: other, kind: 'player', targetId: 'mum', zone: 'torso' }]), origin, watching); effects.update(0, view);
  assert.ok(near(v3(other), 0.3).some(quad => quad.kind === EFFECT_KIND.puff), 'Hits on other players still puff');
  // Without a viewer id, hits landing right at the camera are still kept off the screen.
  effects.clear(); effects.update(0, view);
  effects.shot(shot([{ to: head, kind: 'player', targetId: 'dad', protected: true }]), origin, remote);
  effects.shot(shot([{ to: other, kind: 'player', targetId: 'mum' }]), origin, remote);
  effects.impact(head, facingShooter, 'player'); effects.update(0.08, view);
  assert.equal(near(eye, 1).length, 0, 'Hits at the camera are skipped even when the caller gives no viewer');
  assert.ok(tracers().every(quad => quad.vertices.every(vertex => vertex.distanceTo(eye) > 0.9)), 'and tracers into the camera stop short');
  assert.ok(near(v3(other), 0.3).length > 0, 'Hits elsewhere still show');
  effects.dispose();
});

test('bullet holes form a ring buffer of the tier size that reuses the oldest first', () => {
  const effects = new CombatEffects({ quality: 'desktop', decals: 16 }), view = camera();
  for (let index = 0; index < 20; index++) effects.bulletHole({ x: -5 + index * 0.5, y: 0, z: -12 }, up, 'asphalt');
  effects.update(0, view);
  assert.equal(effects.stats().decals, 16);
  const holes = decalQuads(effects);
  assert.equal(holes.length, 16);
  assert.deepEqual(holes.map(hole => Math.round((hole.center.x + 5) / 0.5)).sort((a, b) => a - b), Array.from({ length: 16 }, (_, index) => index + 4), 'The four oldest holes were reused');
  for (const hole of holes) {
    assert.ok(hole.center.y > 0 && hole.center.y < 0.02, 'Holes sit just above the surface');
    assert.ok(hole.vertices.every(vertex => Math.abs(vertex.y - hole.center.y) < 1e-6), 'and lie flat on it');
    assert.ok(hole.radius > 0.02 && hole.radius < 0.1);
  }
  const degenerate: Array<[Vec3, Vec3]> = [[{ x: NaN, y: 0, z: 0 }, up], [{ x: 0, y: 0, z: -12 }, { x: 0, y: 0, z: 0 }], [{ x: 0, y: 0, z: -12 }, { x: Infinity, y: 1, z: 0 }]];
  for (const [position, normal] of degenerate) effects.bulletHole(position, normal, 'asphalt');
  effects.bulletHole({ x: 0, y: 0, z: -12 }, up, 'lava' as SurfaceKind);
  effects.update(0, view);
  assert.equal(decalQuads(effects).length, 16, 'Degenerate holes are ignored and the ring is unchanged');
  effects.explosion(street, 'frag'); effects.update(0, view);
  assert.equal(effects.stats().decals, 16, 'Scorch marks keep their own ring');
  assert.equal(effects.stats().scorches, 1);
  effects.dispose();
  const none = new CombatEffects({ quality: 'phone', decals: 0 });
  none.bulletHole({ x: 0, y: 0, z: -12 }, up, 'asphalt'); none.update(0, view);
  assert.equal(none.stats().decals, 0, 'A zero budget stores nothing');
  none.dispose();
});

test('bullet holes stay on the face they hit instead of hanging into a doorway', () => {
  const effects = new CombatEffects(), view = camera(), towardStreet: Vec3 = { x: 1, y: 0, z: 0 };
  // The teal house front faces the street at x = -9.86; its door opening starts at z = -3.4.
  effects.bulletHole({ x: -9.86, y: 1.5, z: -3.42 }, towardStreet, 'wood');
  effects.bulletHole({ x: -9.86, y: 1.5, z: -5 }, towardStreet, 'wood');
  effects.update(0, view);
  const [edge, open] = decalQuads(effects).sort((a, b) => b.center.z - a.center.z);
  for (const hole of [edge, open]) assert.ok(hole.vertices.every(vertex => vertex.x > -9.86 && vertex.x < -9.84), 'Holes sit on the wall face');
  assert.ok(edge.center.z + edge.radius <= -3.4 + 1e-6, 'The mark is moved onto the wall, not over the doorway');
  assert.ok(edge.center.distanceTo(new THREE.Vector3(-9.85, 1.5, -3.42)) < 0.1, 'and stays close to where it hit');
  assert.ok(Math.abs(open.center.z + 5) < 1e-6 && Math.abs(open.center.y - 1.5) < 1e-6, 'Holes away from edges stay exactly where they hit');
  effects.dispose();
});

test('the procedural decal atlas has neutral borders, dark centres and its own look per surface', () => {
  const atlas = buildDecalAtlas(), { width, height, cell, columns, rows } = DECAL_ATLAS;
  assert.equal(atlas.length, width * height * 4);
  assert.equal(width, columns * cell); assert.equal(height, rows * cell);
  assert.deepEqual(buildDecalAtlas(), atlas, 'The same atlas every time');
  const pixel = (x: number, y: number) => Array.from(atlas.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));
  const looks = new Set<string>();
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const x0 = column * cell, y0 = row * cell;
    for (let step = 0; step < cell; step++) {
      for (const [x, y] of [[x0 + step, y0], [x0 + step, y0 + cell - 1], [x0, y0 + step], [x0 + cell - 1, y0 + step]]) {
        assert.deepEqual(pixel(x, y), [128, 128, 128, 255], 'Cell borders are neutral so filtering never shows a square');
      }
    }
    const centre = pixel(x0 + cell / 2, y0 + cell / 2);
    assert.ok(centre[0] < 110 && centre[1] < 110 && centre[2] < 110, `cell ${row * columns + column} darkens its centre`);
    const bytes: number[] = [];
    for (let y = y0; y < y0 + cell; y++) bytes.push(...atlas.subarray((y * width + x0) * 4, (y * width + x0 + cell) * 4));
    looks.add(bytes.join());
  }
  assert.equal(looks.size, columns * rows, 'Every surface has its own mark');
});

test('wood bullet holes read as torn grain: a dark hole in a pale splintered halo, with no long dark cracks', () => {
  const atlas = buildDecalAtlas(), { width, cell, columns } = DECAL_ATLAS;
  const x0 = (DECAL_CELLS.wood % columns) * cell, y0 = Math.floor(DECAL_CELLS.wood / columns) * cell;
  let farDark = 0, halo = 0, pale = 0;
  for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
    const u = (x + 0.5) / cell * 2 - 1, v = (y + 0.5) / cell * 2 - 1, r = Math.hypot(u, v);
    const offset = ((y0 + y) * width + x0 + x) * 4, value = (atlas[offset] + atlas[offset + 1] + atlas[offset + 2]) / 3;
    if (r > 0.5 && value < 112) farDark++;
    if (r > 0.16 && r < 0.3) { halo++; if (value > 134) pale++; }
  }
  assert.equal(farDark, 0, 'No dark crack legs reach out from the hole');
  assert.ok(pale > halo * 0.3, `Freshly torn fibres around the hole are paler than the wood (${pale} of ${halo})`);
});

test('glass and pots shatter when a shot path crosses them, and come back for the next round', () => {
  const effects = new CombatEffects(), view = camera(), broken: Array<{ kind: string; position: Vec3 }> = [];
  effects.onBreak = (kind, position) => broken.push({ kind, position: { x: position.x, y: position.y, z: position.z } });
  const glass = pane('Breakable_Glass_Test', -8, 1.5, -6), angled = pane('Breakable_Glass_Angled', -4, 1.5, -6, Math.PI / 4);
  const pot = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), new THREE.MeshBasicMaterial()); pot.name = 'Breakable_Pot_Test'; pot.position.set(-8, 0.3, -9);
  const town = new THREE.Group(); town.add(glass, angled, pot); town.updateMatrixWorld(true);
  const list: THREE.Mesh[] = [];
  effects.setBreakables(list);
  list.push(glass, angled, pot); // The world fills its list once the art has loaded.
  const lane: Vec3 = { x: -8, y: 1.5, z: 0 };

  effects.shot(shot([worldTrace({ x: -8, y: 1.5, z: -4 }, 'wood')], 'kr5', lane), lane, { local: true, tracer: false });
  assert.equal(glass.visible, true, 'A shot that stops short leaves the glass alone');
  effects.shot(shot([{ to: { x: -2.75, y: 1.5, z: -6.75 }, kind: 'range' }], 'kr5', { x: -4.75, y: 1.5, z: -4.75 }), { x: -4.75, y: 1.5, z: -4.75 }, remote);
  assert.equal(angled.visible, true, 'A path through the empty corner of an angled pane misses the pane itself');
  effects.shot(shot([{ to: { x: -8, y: 1.5, z: -12 }, kind: 'range' }], 'kr5', lane), lane, { local: false, tracer: false });
  assert.equal(glass.visible, false, 'A shot through the pane breaks it');
  assert.deepEqual(broken.map(entry => entry.kind), ['glass']);
  assert.ok(Math.abs(broken[0].position.z + 6) < 0.01 && Math.abs(broken[0].position.y - 1.5) < 0.01, 'The break is reported where the path crossed');
  effects.update(0, view);
  const shards = quads(dustOf(effects)).filter(quad => quad.kind === EFFECT_KIND.shard && quad.center.distanceTo(glass.position) < 1);
  assert.ok(shards.length >= 4, 'The pane falls as shards');
  effects.shot(shot([{ to: { x: -8, y: 1.5, z: -12 }, kind: 'range' }], 'kr5', lane), lane, remote);
  assert.equal(broken.length, 1, 'Broken glass stays broken');
  effects.shot(shot([worldTrace({ x: -8, y: 0.3, z: -9 }, 'grass')], 'kr5', lane), lane, remote);
  assert.equal(pot.visible, false);
  assert.deepEqual(broken.map(entry => entry.kind), ['glass', 'pot']);
  assert.equal(effects.stats().broken, 2);
  const height = () => Math.min(...quads(dustOf(effects)).filter(quad => quad.kind === EFFECT_KIND.shard).map(quad => quad.center.y));
  const start = height();
  for (let frame = 0; frame < 20; frame++) effects.update(1 / 60, view);
  assert.ok(height() < start, 'Shards fall');
  effects.clearTransient();
  assert.equal(glass.visible || pot.visible, false, 'Resuming a hidden tab keeps the broken glass');
  effects.clear();
  assert.ok(glass.visible && pot.visible && angled.visible, 'A new round restores every pane and pot');
  assert.equal(effects.stats().broken, 0);
  effects.shot(shot([{ to: { x: -8, y: 1.5, z: -12 }, kind: 'range' }], 'kr5', lane), lane, remote);
  assert.equal(glass.visible, false);
  effects.dispose();
  assert.equal(glass.visible, true, 'Disposal hands the world back intact');
  assert.equal(broken.length, 3);
});

test('explosions emit flash, fireball, sparks, smoke, debris, a dust ring and a scorch; phones get half', () => {
  const view = camera();
  for (const quality of ['desktop', 'phone'] as const) for (const kind of ['frag', 'mortar'] as const) {
    const effects = new CombatEffects({ quality }), recipe = EXPLOSION_RECIPES[kind], scale = effects.budget.scale;
    const count = (value: number) => scaledCount(value, scale);
    effects.explosion(street, kind); effects.update(0, view);
    assert.equal(quads(glowOf(effects)).length, count(recipe.flash) + count(recipe.fire) + count(recipe.sparks), `${quality} ${kind} flash, fire and sparks`);
    assert.equal(quads(dustOf(effects)).length, count(recipe.smoke) + count(recipe.debris) + count(recipe.ring) + count(recipe.column), `${quality} ${kind} smoke, debris and dust`);
    assert.ok(quads(glowOf(effects)).some(quad => quad.kind === EFFECT_KIND.fire), 'There is a fireball');
    assert.equal(effects.stats().scorches, 1);
    const [scorch] = decalQuads(effects);
    assert.ok(Math.abs(scorch.center.y) < 0.03 && scorch.radius > (kind === 'mortar' ? 1.5 : 0.9), 'A scorch mark lies on the street');
    assert.equal(lightsOf(effects).some(light => light.intensity > 0), quality === 'desktop', 'Only desktop flashes a light');
    effects.dispose();
  }
  // The teal house front faces the street at x = -9.86 and its rooms have floors at ground level.
  const beside = new CombatEffects();
  beside.explosion({ x: -9.5, y: 0.07, z: -5 }, 'frag'); beside.update(0, view);
  const [mark] = decalQuads(beside);
  assert.ok(mark.center.x - mark.radius >= -9.86 - 1e-6, 'A scorch beside a house stays out of the room behind the wall');
  assert.ok(mark.radius > 0.9, 'and keeps its size when there is room to move it');
  beside.dispose();
  const effects = new CombatEffects(), recipe = EXPLOSION_RECIPES.drone;
  effects.explosion({ x: 0, y: 11, z: 14 }, 'drone'); effects.update(0, view);
  assert.equal(effects.stats().scorches, 0, 'A drone blown up in the air leaves no scorch');
  assert.equal(quads(dustOf(effects)).length, recipe.smoke + recipe.debris, 'and no dust ring');
  const before = effects.stats().glow, frag = EXPLOSION_RECIPES.frag;
  effects.explosion({ x: NaN, y: 0, z: 0 }, 'frag'); effects.explosion(street, 'nuke' as 'frag');
  assert.equal(effects.stats().glow, before + frag.flash + frag.fire + frag.sparks, 'Bad positions are ignored; unknown kinds fall back to a frag');
  effects.dispose();
  // A grenade that rolled under the bus (its body starts 0.16 m up) scorches the street, not the air under the bus.
  const under = new CombatEffects();
  under.explosion({ x: -2.4, y: 0.07, z: -4 }, 'frag'); under.update(0, view);
  const [shadowed] = decalQuads(under);
  assert.ok(shadowed && Math.abs(shadowed.center.y) < 0.03, 'A blast under the bus marks the street');
  under.dispose();
});

test('explosion smoke hangs for seconds, and steady gunfire never eats it early, even on phones', () => {
  const view = camera();
  const clouds = (effects: CombatEffects) => quads(dustOf(effects)).filter(quad => quad.kind === EFFECT_KIND.smoke && quad.vertices[0].distanceTo(quad.vertices[1]) > 1);
  for (const quality of ['desktop', 'phone'] as const) {
    const quiet = new CombatEffects({ quality }), busy = new CombatEffects({ quality });
    for (const effects of [quiet, busy]) { effects.explosion(street, 'frag'); effects.update(0, view); }
    assert.ok(quiet.stats().plume > 0, 'Explosion smoke has a pool of its own');
    let fired = 0;
    for (let frame = 1; frame <= 240; frame++) {
      // Three remote rifles at 750 rounds a minute, all hitting concrete.
      for (const due = Math.floor(frame * 37.5 / 60); fired < due; fired++) busy.shot(shot([worldTrace()]), origin, remote);
      quiet.update(1 / 60, view); busy.update(1 / 60, view);
      assert.equal(busy.stats().plume, quiet.stats().plume, `${quality}: gunfire leaves the explosion smoke alone (frame ${frame})`);
      if (frame === 72) assert.ok(clouds(busy).filter(quad => quad.opacity >= 0.5).length >= (quality === 'phone' ? 6 : 12), `${quality}: a thick cloud at 1.2 s`);
    }
    assert.ok(clouds(busy).length >= (quality === 'phone' ? 3 : 6), `${quality}: smoke still hangs at 4 s`);
    quiet.dispose(); busy.dispose();
  }
});

test('scorch marks never reach under walls or cover, at house corners or on balconies', () => {
  const view = camera(), effects = new CombatEffects();
  const standing = OBSTACLES.filter(box => box.y - box.h / 2 <= 0.05 && box.y + box.h / 2 >= 0.05);
  const gap = (box: MapObstacle, x: number, z: number) =>
    Math.hypot(Math.max(box.x - box.w / 2 - x, 0, x - box.x - box.w / 2), Math.max(box.z - box.d / 2 - z, 0, z - box.z - box.d / 2));
  /** Whether the ground path from a to b runs through a footprint: a mark must never jump through a wall. */
  const crosses = (box: MapObstacle, ax: number, az: number, bx: number, bz: number) => {
    let near = 0, far = 1;
    for (const [start, delta, min, max] of [[ax, bx - ax, box.x - box.w / 2, box.x + box.w / 2], [az, bz - az, box.z - box.d / 2, box.z + box.d / 2]]) {
      if (Math.abs(delta) < 1e-12) { if (start < min || start > max) return false; continue; }
      const t1 = (min - start) / delta, t2 = (max - start) / delta;
      near = Math.max(near, Math.min(t1, t2)); far = Math.min(far, Math.max(t1, t2));
      if (near > far) return false;
    }
    return true;
  };
  const markOf = (position: Vec3) => {
    effects.clear(); effects.explosion(position, 'frag'); effects.update(0, view);
    return decalQuads(effects)[0];
  };
  // Just outside the south-east corner of the yellow house: no wall lies due east, west, north or south.
  const corner = markOf({ x: 22.39, y: 0.07, z: 6.46 });
  assert.ok(corner && corner.radius > 0.9, 'A blast at a corner keeps a full-size mark by sliding away from the corner');
  for (const box of standing) assert.ok(gap(box, corner.center.x, corner.center.z) >= corner.radius - 1e-6, `and the mark stays out from under ${box.id}`);
  assert.ok(Math.hypot(corner.center.x - 22.39, corner.center.z - 6.46) <= corner.radius, 'while still covering the blast');

  // Blasts all over the town, within 1.5 m of the walls, fences and cover.
  const random = new EffectRandom(11);
  let blasts = 0, marked = 0;
  while (blasts < 400) {
    const box = standing[Math.floor(random.next() * standing.length)];
    const x = box.x + random.signed(box.w / 2 + 1.5), z = box.z + random.signed(box.d / 2 + 1.5);
    if (Math.abs(x) > 30.8 || Math.abs(z) > 22.8 || standing.some(other => gap(other, x, z) === 0)) continue;
    blasts++;
    const mark = markOf({ x, y: 0.07, z });
    if (!mark) continue;
    marked++;
    const at = `A blast at (${x.toFixed(2)}, ${z.toFixed(2)})`;
    assert.ok(Math.abs(mark.center.y) < 0.03, `${at} marks the ground`);
    for (const other of standing) {
      assert.ok(gap(other, mark.center.x, mark.center.z) >= mark.radius - 1e-3, `${at} keeps its mark out from under ${other.id}`);
      assert.ok(!crosses(other, x, z, mark.center.x, mark.center.z), `${at} never moves its mark through ${other.id}`);
    }
    assert.ok(Math.hypot(mark.center.x - x, mark.center.z - z) <= mark.radius * 1.45 + 1e-6, `${at} keeps its mark on the blast`);
  }
  assert.ok(marked >= blasts * 0.9, `Nearly every blast still leaves a mark (${marked} of ${blasts})`);

  // On the yellow balcony, beside the open door into the upstairs room.
  const balcony = markOf({ x: 22.35, y: 3.27, z: 4.2 });
  assert.ok(balcony && Math.abs(balcony.center.y - 3.2) < 0.03, 'A balcony blast marks the balcony floor');
  assert.ok(balcony.center.x - balcony.radius >= 22 - 1e-6, 'without reaching through the door into the room');
  assert.ok(balcony.center.x + balcony.radius <= 26.04 + 1e-6 && balcony.center.z + balcony.radius <= 5.88 + 1e-6, 'or under the rails');
  assert.ok(balcony.center.z - balcony.radius >= 2.8 - 1e-6, 'or out over the open edge');
  effects.dispose();
});

test('grenades in flight are drawn, tumble as they move, and vanish when removed or forgotten', () => {
  const effects = new CombatEffects(), view = camera(), body = part<THREE.InstancedMesh>(effects, 'combat-grenades');
  const drawn = () => Array.from({ length: body.count }, (_, index) => instancePose(body, index)).filter(entry => entry.scale.x > 0);
  effects.grenade('g1', { x: 0, y: 1.2, z: -12 }); effects.update(0, view);
  assert.equal(effects.stats().grenades, 1);
  assert.equal(drawn().length, 1); assert.ok(drawn()[0].position.distanceTo(new THREE.Vector3(0, 1.2, -12)) < 1e-6);
  const before = drawn()[0].rotation.clone();
  effects.grenade('g1', { x: 0.4, y: 1.3, z: -12 }); effects.update(1 / 60, view);
  assert.ok(drawn()[0].position.distanceTo(new THREE.Vector3(0.4, 1.3, -12)) < 1e-6, 'It moves');
  assert.ok(drawn()[0].rotation.angleTo(before) > 0.1, 'and tumbles as it flies');
  effects.grenade('g2', { x: 1, y: 0.07, z: -12 }); effects.grenade('g1', null); effects.update(0, view);
  assert.equal(effects.stats().grenades, 1);
  assert.equal(drawn().length, 1); assert.ok(drawn()[0].position.distanceTo(new THREE.Vector3(1, 0.07, -12)) < 1e-6, 'Removing one keeps the other');
  effects.grenade('g3', { x: NaN, y: 0, z: 0 }); effects.grenade(undefined as unknown as string, street);
  assert.equal(effects.stats().grenades, 1, 'Bad grenades are ignored');
  for (let index = 0; index < 40; index++) effects.grenade(`many-${index}`, { x: index * 0.1, y: 0.07, z: -12 });
  assert.equal(effects.stats().grenades, effects.budget.grenades, 'The marker pool is bounded');
  effects.update(10, view);
  assert.equal(effects.stats().grenades, 0, 'Markers nobody updates disappear');
  assert.equal(drawn().length, 0);
  effects.dispose();
});

test('attack drones glide between snapshots with spinning rotors and a friend-or-foe light', () => {
  const effects = new CombatEffects(), view = camera(), fleet = part<THREE.Group>(effects, 'combat-drones');
  const drone = (x: number, health = 200): DroneState => ({ id: 'd1', ownerId: 'dad', team: 'teal', x, y: 11, z: 14, yaw: Math.PI / 2, health, until: 40_000 });
  const enemy = { playerId: 'son', team: 'gold' as const }, friend = { playerId: 'mum', team: 'teal' as const };
  effects.setDrones([drone(0)], 10_000, enemy); effects.update(0, view);
  const model = fleet.children.find(child => child.visible)!;
  assert.ok(model, 'The drone is drawn');
  assert.ok(model.position.distanceTo(new THREE.Vector3(0, 11, 14)) < 1e-6);
  assert.equal(effects.stats().drones, 1);
  const rotor = model.getObjectByName('drone-rotor')!, spin = rotor.rotation.y;
  effects.update(0.1, view);
  assert.notEqual(rotor.rotation.y, spin, 'Rotors spin');
  effects.setDrones([drone(0.7)], 10_100, enemy); effects.update(0.05, view);
  assert.ok(Math.abs(model.position.x - 0.35) < 0.02, `It is drawn between snapshots (x=${model.position.x.toFixed(3)})`);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(model.quaternion);
  assert.ok(forward.x > 0.9, 'and faces its flight direction');
  const gun = new THREE.Vector3(0, -0.1, -0.43).applyMatrix4(model.matrixWorld);
  effects.shot(shot([{ to: { x: 0.35, y: 0, z: 6 }, kind: 'range' }], 'drone', { x: 0.7, y: 11, z: 14 }), { x: 50, y: 0, z: 0 }, { local: false, tracer: false });
  effects.update(0, view);
  const flashes = quads(glowOf(effects)).filter(quad => quad.kind === EFFECT_KIND.flash);
  assert.ok(flashes.length > 0 && flashes.every(quad => quad.center.distanceTo(gun) < 0.05), 'A drone shot flashes at the gun of the drone the player sees');
  const beacon = model.getObjectByName('drone-beacon') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  assert.ok(beacon.material.color.r > beacon.material.color.b, 'An enemy drone shows a red light');
  effects.setDrones([drone(0.7)], 10_100, friend); effects.update(0, view);
  assert.ok(beacon.material.color.b > beacon.material.color.r, 'A friendly drone shows a blue light');
  effects.setDrones([drone(0.7)], 10_100, { playerId: 'dad' }); effects.update(0, view);
  assert.ok(beacon.material.color.b > beacon.material.color.r, 'Your own drone is friendly in free-for-all');
  effects.setDrones([drone(1.4, 60)], 10_200, enemy);
  for (let frame = 0; frame < 30; frame++) effects.update(1 / 60, view);
  assert.ok(quads(dustOf(effects)).some(quad => quad.center.distanceTo(model.position) < 1.5), 'A damaged drone trails smoke');
  assert.ok(model.position.x <= 1.4 + 8.2 * 0.15 + 1e-6, 'Extrapolation past the last snapshot is short');
  effects.setDrones([], 10_300, enemy); effects.update(0.016, view);
  assert.ok(fleet.children.every(child => !child.visible), 'Drones leave when the snapshot drops them');
  assert.equal(effects.stats().drones, 0);
  effects.setDrones([{ ...drone(0), x: NaN }], 10_400); effects.setDrones(null as unknown as DroneState[], NaN); effects.update(0.016, view);
  assert.ok(fleet.children.every(child => !child.visible), 'Bad drone data draws nothing');
  const crowd = Array.from({ length: 12 }, (_, index) => ({ ...drone(index), id: `d${index}` }));
  effects.setDrones(crowd, 10_500); effects.update(0, view);
  assert.equal(effects.stats().drones, effects.budget.drones, 'The drone pool is bounded');
  assertFinite(effects);
  effects.dispose();
});

test('ejected shells arc, settle on the ground and expire, and the pool stays bounded', () => {
  const effects = new CombatEffects(), view = camera(), shells = part<THREE.InstancedMesh>(effects, 'combat-shells');
  const pose = (index: number) => instancePose(shells, index);
  effects.shell(new THREE.Vector3(0, 1.4, -12), new THREE.Vector3(1.6, 1.2, 0.3), 'kr5');
  effects.update(0, view);
  assert.equal(effects.stats().shells, 1); assert.equal(shells.visible, true);
  assert.ok(pose(0).position.distanceTo(new THREE.Vector3(0, 1.4, -12)) < 1e-6);
  for (let frame = 0; frame < 90; frame++) effects.update(1 / 60, view);
  const landed = pose(0);
  assert.ok(landed.position.y >= 0 && landed.position.y < 0.03, `It rests on the street (y=${landed.position.y.toFixed(4)})`);
  assert.ok(landed.position.x > 0.4, 'after flying out to the side');
  const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(landed.rotation);
  assert.ok(Math.abs(axis.y) < 0.05, 'and lies on its side');
  effects.update(10, view);
  assert.equal(effects.stats().shells, 0); assert.equal(shells.visible, false);
  for (let index = 0; index < 1000; index++) effects.shell(new THREE.Vector3(0, 1.4, -12), new THREE.Vector3(1, 1, 0), index % 2 ? 'breaker12' : 'longbow');
  assert.equal(effects.stats().shells, effects.budget.shells, 'The shell pool is bounded');
  effects.shell(new THREE.Vector3(NaN, 0, 0), new THREE.Vector3(), 'kr5'); effects.shell(new THREE.Vector3(), new THREE.Vector3(0, Infinity, 0), 'kr5');
  effects.shell(new THREE.Vector3(0, 1, -12), new THREE.Vector3(1, 1, 0), 'laser' as 'kr5');
  effects.update(1 / 60, view);
  assertFinite(effects);
  effects.dispose();
});

test('flash lights are a fixed pool that only changes brightness', () => {
  const view = camera();
  const effects = new CombatEffects({ quality: 'desktop' }), lights = lightsOf(effects), children = [...effects.root.children];
  assert.equal(lights.length, effects.budget.lights);
  assert.ok(lights.every(light => light.intensity === 0 && light.visible && !light.castShadow), 'Idle lights stay in the scene at zero brightness so shaders never recompile');
  effects.shot(shot([worldTrace()]), origin, remote); effects.update(0, view);
  const lit = lights.filter(light => light.intensity > 0);
  assert.equal(lit.length, 1);
  assert.ok(lit[0].position.distanceTo(v3(origin)) < 0.1, 'The flash lights up at the muzzle');
  assert.notEqual(lit[0], lights[0], 'Remote flashes leave the local light free');
  effects.update(1, view);
  assert.ok(lights.every(light => light.intensity === 0), 'Flashes fade out completely');
  effects.localShot(origin, endpoint, 'kr5', false); effects.update(0, view);
  assert.ok(lights[0].intensity > 0);
  effects.explosion(street, 'mortar'); effects.update(0, view);
  assert.ok(lights.some(light => light !== lights[0] && light.intensity > lights[0].intensity * 5), 'Explosions are much brighter');
  for (let index = 0; index < 50; index++) effects.shot(shot([worldTrace()]), origin, remote);
  assert.deepEqual(effects.root.children, children, 'No light is ever added');
  effects.dispose();
  for (const options of [{ quality: 'phone' as const }, { quality: 'desktop' as const, muzzleLight: false }]) {
    const plain = new CombatEffects(options);
    plain.shot(shot([worldTrace()]), origin, remote); plain.explosion(street, 'frag'); plain.localShot(origin, endpoint, 'kr5', true); plain.update(0, view);
    assert.equal(lightsOf(plain).length, 0);
    plain.dispose();
  }
});

test('cosmetic barrels stay on the visible side of cover, using the same map rays as the server', () => {
  const authoritative = { x: -11, y: 1.45, z: -4 }, visual = { x: -9.5, y: 1.45, z: -4 };
  const from = resolveVisualMuzzle(authoritative, visual);
  assert.ok(from.x >= authoritative.x && from.x < -10.14, 'The cosmetic barrel cannot cross the house front at x=-10.14');
  assert.equal(from.y, authoritative.y); assert.equal(from.z, authoritative.z);
  const open: Vec3 = { x: -26.865, y: 1.457, z: -0.847 };
  assert.ok(resolveVisualMuzzle(origin, open).distanceTo(v3(open)) < 1e-8, 'Unobstructed shots begin at the modeled barrel');
  for (const invalid of [{ x: NaN, y: 0, z: 0 }, { x: 50, y: 40, z: 30 }]) assert.deepEqual(resolveVisualMuzzle(origin, invalid).toArray(), [origin.x, origin.y, origin.z]);
  const downward = resolveVisualMuzzle(origin, { ...origin, y: -0.2 });
  assert.ok(downward.y >= 0 && downward.y < origin.y, 'The floor also clips cosmetic offsets');
  const random = new EffectRandom(99);
  for (let index = 0; index < 600; index++) {
    const start = { x: random.range(-31, 31), y: random.range(0.05, 7), z: random.range(-23, 23) };
    const direction = new THREE.Vector3(random.signed(), random.signed(), random.signed()).normalize();
    const limit = random.range(0.2, 80);
    assert.equal(rayDistance(start.x, start.y, start.z, direction.x, direction.y, direction.z, limit), raycastMap(start, direction, limit), 'Effects use the same map rays as the server');
  }
});

test('point-blank contacts keep their impact without backwards beams', () => {
  const effects = new CombatEffects(), view = camera();
  const scenarios = [
    { contact: { ...origin, z: -0.15 }, muzzle: { ...origin, z: -0.85 } },
    { contact: { ...origin, z: -0.85 }, muzzle: { ...origin, z: -0.85 } },
    { contact: { ...origin }, muzzle: { ...origin } },
  ];
  for (const kind of ['player', 'world'] as const) for (const { contact, muzzle } of scenarios) {
    const trace: ShotTrace = kind === 'player' ? { to: contact, kind, targetId: 'dad' } : worldTrace(contact);
    const event = shot([trace]), before = structuredClone(event);
    effects.clear(); effects.shot(event, muzzle, { local: true, tracer: true }); effects.update(0, view);
    const visible = [...quads(glowOf(effects)), ...quads(dustOf(effects))];
    assert.ok(visible.length > 0, `${kind} contact remains visible even without a forward tracer`);
    assert.ok(visible.every(quad => quad.kind !== EFFECT_KIND.tracer), 'No tracer is drawn backwards into the barrel');
    for (const quad of visible) {
      assert.ok(quad.center.distanceTo(v3(contact)) < 0.3, 'Everything belongs to the accepted impact');
      assert.ok(quad.vertices.every(vertex => vertex.toArray().every(Number.isFinite)), 'Coincident origins and contacts stay finite');
    }
    assert.deepEqual(event, before);
  }
  effects.clear(); effects.shot(shot([{ to: scenarios[0].contact, kind: 'range' }]), scenarios[0].muzzle, { local: true, tracer: true }); effects.update(0, view);
  assert.ok([glowOf(effects), dustOf(effects)].every(mesh => mesh.geometry.drawRange.count === 0 && !mesh.visible), 'A range end behind the barrel gives neither beam nor impact');
  effects.dispose();
});

test('a cosmetic tracer stops at a nearby wall instead of drawing through it', () => {
  const effects = new CombatEffects(), view = camera();
  // The authoritative ray runs clear east of the teal house; the animated barrel sits outside its north face.
  const event = shot([{ to: { x: -9, y: 1.45, z: 8 }, kind: 'range' }], 'kr5', { x: -9, y: 1.45, z: -8 });
  const before = structuredClone(event);
  effects.shot(event, { x: -10.7, y: 1.45, z: -8 }, { local: true, tracer: true }); effects.update(0.07, view);
  const tracers = quads(glowOf(effects)).filter(quad => quad.kind === EFFECT_KIND.tracer);
  assert.equal(tracers.length, 1);
  assert.ok(tracers[0].vertices.every(vertex => vertex.z <= -6.12), 'The tracer stops at the north wall, not the distant endpoint');
  assert.deepEqual(event, before, 'Visual occlusion never rewrites authoritative hit data');
  effects.dispose();
});

test('a predicted shot keeps its light and tracer on the near side of cover', () => {
  const effects = new CombatEffects(), view = camera();
  // The player stands in the street outside the teal house front (x = -9.86) and aims through its door
  // (z -3.4 to -1.1); the animated barrel pokes through the wall beside the door, into the room.
  const eye: Vec3 = { x: -9.3, y: 1.62, z: -3 }, barrel: Vec3 = { x: -10.4, y: 1.5, z: -4 }, contact: Vec3 = { x: -15.86, y: 1.5, z: -2.2 };
  effects.localShot(barrel, contact, 'kr5', true, eye); effects.update(0.05, view);
  const [light] = lightsOf(effects);
  assert.ok(light.intensity > 0 && light.position.x > -9.86, 'The muzzle light stays on the street side of the wall');
  const tracers = quads(glowOf(effects)).filter(quad => quad.kind === EFFECT_KIND.tracer);
  assert.ok(tracers.every(quad => quad.vertices.every(vertex => vertex.x > -9.9)), 'and no tracer is drawn inside the room');
  effects.clear(); effects.localShot(barrel, contact, 'kr5', true); effects.update(0, view);
  assert.ok(lightsOf(effects)[0].position.distanceTo(v3(barrel)) < 1e-6, 'Without the eye the barrel point is used as given');
  effects.dispose();
});

test('broken or hostile input never throws or creates NaN vertices', () => {
  const effects = new CombatEffects(), view = camera();
  for (const value of [NaN, Infinity, -Infinity]) {
    const bad: Vec3 = { x: value, y: 1, z: 0 };
    effects.shot(shot([worldTrace()], 'kr5', bad), origin, remote);
    effects.shot(shot([{ to: bad, kind: 'world', normal: bad, surface: 'wood' }, { to: endpoint, kind: 'player', targetId: 'dad' }]), bad, remote);
    effects.impact(bad, up, 'metal'); effects.impact(endpoint, bad, 'metal'); effects.bulletHole(endpoint, bad, 'wood');
    effects.explosion({ x: 0, y: value, z: 0 }, 'frag'); effects.grenade('g', bad);
    effects.shell(new THREE.Vector3(value, 0, 0), new THREE.Vector3(0, value, 0), 'kr5');
    effects.localShot(bad, endpoint, 'kr5', true); effects.localShot(origin, bad, 'kr5', true);
    effects.update(value, view);
  }
  effects.shot({ ...shot([]), traces: undefined as unknown as ShotTrace[] }, origin, remote);
  effects.shot(null as unknown as Shot, origin, remote);
  effects.shot(shot([null as unknown as ShotTrace, { to: endpoint, kind: 'world', normal: { x: 0, y: 0, z: 0 }, surface: 'lava' as SurfaceKind }], 'laser' as 'kr5'), origin, remote);
  effects.shot(shot([worldTrace()]), origin, undefined);
  effects.impact(endpoint, facingShooter, 'lava' as SurfaceKind); effects.impact(endpoint, { x: 0, y: 0, z: 0 }, 'wood');
  effects.shell(v3(origin), new THREE.Vector3(1, 1, 0), 'laser' as 'kr5');
  effects.setBreakables(undefined as unknown as THREE.Mesh[]); effects.setBreakables([{} as THREE.Mesh]);
  effects.setDrones(undefined as unknown as DroneState[], 0);
  effects.update(-1, view); effects.update(0.016, view);
  assertFinite(effects);
  // End-on and coincident camera rays cannot create NaN vertices.
  for (const eye of [origin, endpoint, { x: -27, y: 1.45, z: 4 }, { x: -27, y: 1.45, z: -1.75 }]) {
    effects.clear(); view.position.set(eye.x, eye.y, eye.z); view.lookAt(-27, 1.45, -20);
    effects.shot(shot([{ to: endpoint, kind: 'range' }, worldTrace(endpoint, 'metal')]), origin, remote); effects.update(0, view);
    assertFinite(effects);
  }
  const broken = new THREE.PerspectiveCamera(); broken.position.set(NaN, 0, 0);
  effects.shot(shot([worldTrace()]), origin, remote); effects.update(0.016, broken);
  assertFinite(effects);
  effects.dispose();
});

test('eliminations raise a little dust, never a burst of light or anything red', () => {
  const view = camera(), body: Vec3 = { x: -27, y: 0, z: -3 };
  const sample = (quality: 'phone' | 'desktop') => {
    const effects = new CombatEffects({ quality });
    effects.elimination(body); effects.update(0, view);
    const result = { glow: quads(glowOf(effects)), dust: quads(dustOf(effects)) };
    effects.dispose();
    return result;
  };
  const desktop = sample('desktop'), phone = sample('phone');
  assert.equal(desktop.glow.length, 0, 'No sparkle burst');
  assert.ok(desktop.dust.length >= 6, 'A little dust');
  for (const quad of desktop.dust) {
    assert.ok(quad.opacity <= 0.4, 'subtle');
    assert.ok(quad.center.distanceTo(v3(body)) < 1.6, 'around the body');
    assert.ok(quad.color.r <= quad.color.g * 1.4, 'earthy, not red');
  }
  assert.ok(phone.dust.length > 0 && phone.dust.length < desktop.dust.length);
  const effects = new CombatEffects();
  effects.respawn(body); effects.update(0, view);
  assert.ok(quads(glowOf(effects)).some(quad => quad.kind === EFFECT_KIND.ring), 'Respawns keep a soft shimmer');
  effects.dispose();
});

test('resuming a hidden tab drops flying particles but keeps marks; a new round resets everything', () => {
  const effects = new CombatEffects(), view = camera();
  effects.shot(shot([worldTrace()]), origin, remote); effects.grenade('g1', street);
  effects.shell(v3(origin), new THREE.Vector3(1, 1, 0), 'kr5'); effects.update(0, view);
  effects.clearTransient(); effects.update(0, view);
  assert.equal(glowOf(effects).visible || dustOf(effects).visible, false, 'Flying particles are gone');
  assert.deepEqual([effects.stats().shells, effects.stats().grenades, effects.stats().tracers], [0, 0, 0]);
  assert.equal(effects.stats().decals, 1, 'Bullet holes stay');
  effects.clear();
  assert.equal(effects.stats().decals, 0);
  assert.equal(part<THREE.Mesh>(effects, 'combat-decals').visible, false);
  effects.dispose();
});

test('switching quality rebuilds the budgets without losing the breakables', () => {
  const effects = new CombatEffects(), view = camera(), glass = pane('Breakable_Glass_Test', -8, 1.5, -6), lane: Vec3 = { x: -8, y: 1.5, z: 0 };
  glass.updateMatrixWorld(true);
  effects.setBreakables([glass]);
  effects.bulletHole({ x: 0, y: 0, z: -12 }, up, 'asphalt');
  effects.configure({ quality: 'phone' });
  assert.deepEqual(effects.budget, effectBudget({ quality: 'phone' }));
  assert.equal(lightsOf(effects).length, 0);
  assert.equal(capacityOf(glowOf(effects)), effects.budget.glowParticles + effects.budget.tracers + effects.budget.markers);
  effects.shot(shot([{ to: { x: -8, y: 1.5, z: -12 }, kind: 'range' }], 'kr5', lane), lane, remote); effects.update(0, view);
  assert.equal(glass.visible, false, 'Breakables survive a quality change');
  const desktop = effectsOptionsFor(renderTier('auto', false, true));
  effects.configure(desktop);
  assert.equal(lightsOf(effects).length, effects.budget.lights);
  const children = [...effects.root.children];
  effects.configure(desktop);
  assert.deepEqual(effects.root.children, children, 'The same options change nothing');
  effects.shot(shot([worldTrace()]), origin, remote); effects.update(0, view);
  assert.ok(glowOf(effects).visible);
  effects.dispose();
});

test('precompiling covers every effect shader, including the drone parts, against the world lights', async () => {
  const effects = new CombatEffects(), scene = new THREE.Scene(), view = camera();
  const calls: Array<{ object: THREE.Object3D; camera: THREE.Camera; scene: THREE.Scene | null | undefined }> = [];
  const renderer = { compileAsync: (object: THREE.Object3D, camera: THREE.Camera, target?: THREE.Scene | null) => { calls.push({ object, camera, scene: target }); return Promise.resolve(object); } };
  await effects.precompile(renderer as unknown as THREE.WebGLRenderer, scene, view);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].object, effects.root); assert.equal(calls[0].camera, view); assert.equal(calls[0].scene, scene);
  const materials = new Set<string>();
  effects.root.traverse(object => { if (object instanceof THREE.Mesh) materials.add((object.material as THREE.Material).name); });
  for (const name of ['combat-glow-batch', 'combat-dust-batch', 'combat-decals', 'combat-shells', 'combat-grenades', 'combat-drone', 'combat-drone-blades', 'combat-drone-rotor-blur', 'combat-drone-foe']) {
    assert.ok(materials.has(name), `${name} is compiled before it is first needed`);
  }
  assert.equal(effects.stats().drones, 0, 'The prepared drone stays hidden until a drone flies');
  assert.ok(part<THREE.Group>(effects, 'combat-drones').children.every(child => !child.visible));
  effects.dispose();
  await effects.precompile(renderer as unknown as THREE.WebGLRenderer, scene, view);
  assert.equal(calls.length, 1, 'Nothing is compiled after disposal');
});

test('precompiling counts every light once, whether or not the effects are already in the scene', async () => {
  // Mirrors three r185 WebGLRenderer.compile: lights come from the target scene, and again from the compiled
  // object when that object is not the target scene itself.
  const lightsSeen = (object: THREE.Object3D, target: THREE.Object3D) => {
    let count = 0;
    const visit = (child: THREE.Object3D) => { if ((child as THREE.Light).isLight) count++; };
    target.traverseVisible(visit);
    if (object !== target) object.traverseVisible(visit);
    return count;
  };
  for (const placement of ['outside', 'child', 'nested'] as const) {
    const effects = new CombatEffects(), scene = new THREE.Scene(), world = new THREE.Group();
    scene.add(new THREE.HemisphereLight(), new THREE.DirectionalLight(), world);
    if (placement === 'child') scene.add(effects.root);
    if (placement === 'nested') world.add(new THREE.Group(), effects.root, new THREE.Group());
    scene.add(new THREE.Group());
    const parent = effects.root.parent, siblings = parent ? [...parent.children] : [];
    const seen: number[] = [];
    const renderer = {
      compileAsync: (object: THREE.Object3D, _camera: THREE.Camera, target?: THREE.Scene | null) => {
        seen.push(lightsSeen(object, target ?? object));
        return Promise.resolve(object);
      },
    };
    await effects.precompile(renderer as unknown as THREE.WebGLRenderer, scene, camera());
    assert.deepEqual(seen, [2 + effects.budget.lights], `${placement}: the two world lights and the ${effects.budget.lights} flash lights, each counted once`);
    assert.equal(effects.root.parent, parent, `${placement}: the effects stay where the caller put them`);
    if (parent) assert.deepEqual(parent.children, siblings, 'in the same place among their siblings');
    effects.dispose();
  }
  const effects = new CombatEffects(), scene = new THREE.Scene();
  scene.add(effects.root);
  const failing = { compileAsync: () => { throw new Error('context lost'); } };
  await assert.rejects(effects.precompile(failing as unknown as THREE.WebGLRenderer, scene, camera()), /context lost/);
  assert.equal(effects.root.parent, scene, 'A failed compile still leaves the effects in the scene');
  effects.dispose();
});

test('disposal releases every owned GPU resource once, restores breakables and ignores late events', () => {
  const effects = new CombatEffects(), scene = new THREE.Scene(), view = camera();
  scene.add(effects.root);
  const glass = pane('Breakable_Glass_Test', -8, 1.5, -6), lane: Vec3 = { x: -8, y: 1.5, z: 0 };
  glass.updateMatrixWorld(true);
  effects.setBreakables([glass]);
  effects.shot(shot([{ to: { x: -8, y: 1.5, z: -12 }, kind: 'range' }], 'kr5', lane), lane, remote);
  effects.setDrones([{ id: 'd1', ownerId: 'dad', x: 0, y: 11, z: 14, yaw: 0, health: 200, until: 40_000 }], 1_000);
  effects.grenade('g1', street); effects.shell(v3(origin), new THREE.Vector3(1, 1, 0), 'kr5'); effects.explosion(street, 'frag');
  effects.update(0.016, view);
  const disposals = new Map<object, number>();
  const track = (resource: THREE.BufferGeometry | THREE.Material | THREE.Texture) => {
    if (disposals.has(resource)) return;
    disposals.set(resource, 0);
    (resource as THREE.Material).addEventListener('dispose', () => disposals.set(resource, disposals.get(resource)! + 1));
  };
  effects.root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    track(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      track(material);
      if (material instanceof THREE.ShaderMaterial) for (const uniform of Object.values(material.uniforms)) if (uniform.value instanceof THREE.Texture) track(uniform.value);
    }
  });
  const glassResources = [glass.geometry, glass.material as THREE.Material];
  for (const resource of glassResources) disposals.delete(resource);
  assert.ok(disposals.size >= 10, 'batches, decals, atlas, shells, grenades and the drone parts are tracked');
  effects.dispose(); effects.dispose();
  effects.shot(shot([worldTrace()]), origin, remote); effects.impact(endpoint, up, 'metal'); effects.bulletHole(endpoint, facingShooter, 'wood');
  effects.explosion(street, 'frag'); effects.grenade('g2', street); effects.shell(v3(origin), new THREE.Vector3(), 'kr5');
  effects.setDrones([], 2_000); effects.localShot(origin, endpoint, 'kr5', true); effects.elimination(origin); effects.respawn(origin);
  effects.configure({ quality: 'phone' }); effects.update(0.016, view); effects.clear(); effects.clearTransient();
  assert.equal(effects.root.parent, null); assert.equal(effects.root.children.length, 0);
  for (const [resource, count] of disposals) assert.equal(count, 1, `${(resource as { type?: string }).type} is disposed exactly once`);
  assert.equal(glass.visible, true, 'The world keeps its glass after the effects go away');
});
