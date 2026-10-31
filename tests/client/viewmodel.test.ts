import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { WeaponId } from '../../shared/protocol';
import { RULES } from '../../shared/protocol';
import { WEAPONS } from '../../shared/weapons';
import { SUN_DIRECTION } from '../../src/game/Atmosphere';
import { ViewModel, type ViewModelState } from '../../src/game/ViewModel';
import { WEAPON_IDS, createWeaponLibrary, findNode, type WeaponLibrary } from '../../src/game/WeaponModels';
import { HANDLING } from '../../src/game/viewmodel/handling';
import { KNIFE_MOVE, crossedEvents, reloadChoreography, sampleTrack, shellCycle } from '../../src/game/viewmodel/choreography';
import { MuzzleSmoke } from '../../src/game/viewmodel/effects';
import { Spring, stepSpring } from '../../src/game/viewmodel/spring';

const renderer = {} as THREE.WebGLRenderer;
const DT = 1 / 60;

const state = (patch: Partial<ViewModelState> = {}): ViewModelState => ({
  weapon: 'kr5', ads: 0, sprint: 0, dash: false, posture: 'stand', speed: 0, grounded: true, lookDelta: { yaw: 0, pitch: 0 },
  reload: -1, reloadEmpty: false, raise: 1, wallBlock: 0, cook: -1, scoped: false, reduceMotion: false, ...patch,
});
async function viewModel(library: WeaponLibrary = createWeaponLibrary(null)) {
  const view = new ViewModel(renderer, { library });
  await view.ready;
  return view;
}
function run(view: ViewModel, value: ViewModelState | ((t: number) => ViewModelState), seconds: number, dt = DT) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) view.update(typeof value === 'function' ? value(i * dt) : value, dt, 0);
}
const position = (object: THREE.Object3D) => { object.updateWorldMatrix(true, false); return new THREE.Vector3().setFromMatrixPosition(object.matrixWorld); };
const root = (view: ViewModel) => view.instance!.root;
const anchors = (view: ViewModel) => view.instance!.anchors;

test('springs are exact: the same motion at any frame rate, settling without blowing up', () => {
  for (const damping of [0.35, 1, 1.8]) {
    const coarse = { value: 1, velocity: 0 }, fine = { value: 1, velocity: 0 };
    stepSpring(coarse, 0, 4, damping, 0.1);
    for (let i = 0; i < 100; i++) stepSpring(fine, 0, 4, damping, 0.001);
    assert.ok(Math.abs(coarse.value - fine.value) < 1e-9 && Math.abs(coarse.velocity - fine.velocity) < 1e-7, `damping ${damping}`);
  }
  const critical = new Spring(3, 1, 1);
  let min = Infinity;
  for (let i = 0; i < 200; i++) min = Math.min(min, critical.update(0, DT));
  assert.ok(min >= 0, 'critical damping never overshoots from rest');
  const broken = { value: Number.NaN, velocity: 3 };
  stepSpring(broken, 0.5, 4, 0.5, DT);
  assert.deepEqual(broken, { value: 0.5, velocity: 0 });
  const huge = new Spring(8, 0.4); huge.impulse(5); huge.update(0, 10);
  assert.ok(Math.abs(huge.value) < 1e-9, 'a long stall settles instead of exploding');
});

test('keyframe tracks pass through their keys without overshooting', () => {
  const track = [0, 0, 0.2, 1, 0.5, 1, 0.6, -0.5, 1, 0];
  for (let i = 0; i < track.length; i += 2) assert.ok(Math.abs(sampleTrack(track, track[i]!) - track[i + 1]!) < 1e-12);
  for (let t = 0; t <= 1; t += 0.001) {
    const value = sampleTrack(track, t);
    assert.ok(value <= 1 + 1e-9 && value >= -0.5 - 1e-9, `no overshoot at ${t}`);
    if (t > 0.2 && t < 0.5) assert.ok(Math.abs(value - 1) < 1e-9, 'holds stay flat');
  }
  // Reload timelines line up with the game's reload sounds at 25%, 60% and 85%.
  for (const [style, empty] of [['rifle', false], ['rifle', true], ['smg', false], ['pistol', true], ['bolt', false]] as const) {
    const seen: Array<[string, number]> = [];
    const choreo = reloadChoreography(style, empty);
    for (const event of choreo.events ?? []) seen.push([event.kind, event.t]);
    assert.deepEqual(seen.map(([, t]) => t), [0.25, 0.6, 0.85], `${style}${empty ? ' empty' : ''}`);
    let crossed = 0; crossedEvents(choreo, 0.2, 0.61, () => crossed++);
    assert.equal(crossed, 2);
  }
  const cycle = { reach: 0, shellInHand: false, insert: 0 };
  assert.equal(shellCycle(0.5, cycle).shellInHand, true);
  assert.equal(shellCycle(0.9, cycle).shellInHand, false);
  assert.equal(KNIFE_MOVE.duration, RULES.meleeMs / 1000, 'the knife swing lasts as long as the server melee');
});

test('arms sit on the grips with forearms reaching back toward the body', async () => {
  const view = await viewModel();
  for (const id of WEAPON_IDS) {
    run(view, state({ weapon: id }), 0.8);
    const { left, right } = view.arms;
    assert.ok(left && right);
    assert.ok(position(right).distanceTo(position(anchors(view).gripRight)) < 1e-6, `${id} right hand on the grip`);
    assert.ok(position(left).distanceTo(position(anchors(view).gripLeft)) < 1e-6, `${id} left hand on the support grip`);
    for (const arm of [left, right]) {
      const forearm = findNode(arm, 'forearm')!;
      forearm.updateWorldMatrix(true, false);
      const direction = new THREE.Vector3(0, 0, 1).transformDirection(forearm.matrixWorld);
      assert.ok(direction.z > 0.2 && direction.y < 0, `${id} ${arm.name} forearm runs back and down (${direction.toArray().map(v => v.toFixed(2))})`);
    }
    const grip = position(anchors(view).gripRight);
    assert.ok(grip.x > 0.05 && grip.y < -0.1 && grip.z < -0.25, `${id} rests low on the right at the hip`);
  }
  view.dispose();
});

test('switching weapons lowers the old one, then raises the new one', async () => {
  const view = await viewModel();
  run(view, state(), 0.6);
  const carbine = view.instance!;
  const rest = position(carbine.anchors.gripRight);
  run(view, state({ weapon: 'sentry9' }), 0.08);
  assert.equal(view.weapon, 'kr5', 'the carbine is still going down');
  assert.ok(position(carbine.anchors.gripRight).y < rest.y - 0.03, 'and it has dropped');
  run(view, state({ weapon: 'sentry9' }), 0.15);
  assert.equal(view.weapon, 'sentry9');
  assert.equal(carbine.root.visible, false);
  const lowered = position(anchors(view).gripRight).y;
  run(view, state({ weapon: 'sentry9' }), 0.6);
  assert.ok(position(anchors(view).gripRight).y > lowered + 0.1, 'the pistol came up');
  run(view, state({ weapon: 'kr5' }), 0.8);
  assert.equal(view.instance, carbine, 'switching back reuses the same model');
  // Back at rest, give or take the idle breathing.
  assert.ok(position(carbine.anchors.gripRight).distanceTo(rest) < 0.004);
  view.dispose();
});

test('a swap driven by the game raise is finished exactly when the weapon can fire', async () => {
  const view = await viewModel(), reference = await viewModel();
  run(view, state(), 0.6);
  run(reference, state({ weapon: 'sentry9' }), 1.2);
  const raiseSeconds = WEAPONS.sentry9.raiseMs / 1000;
  let swappedAt = -1;
  const driven = (offset: number) => (t: number) => {
    if (swappedAt < 0 && view.weapon === 'sentry9') swappedAt = t + offset;
    return state({ weapon: 'sentry9', raise: Math.min(1, (t + offset) / raiseSeconds) });
  };
  run(view, driven(0), raiseSeconds * 0.6);
  // A third of the raise puts the old weapon away (the check itself samples one frame late).
  assert.ok(swappedAt > 0 && swappedAt <= raiseSeconds * 0.3 + 2 / 60, `the old weapon is away early (${swappedAt.toFixed(3)} s)`);
  assert.ok(position(anchors(view).gripRight).y < position(anchors(reference).gripRight).y - 0.03, 'still coming up part way through');
  run(view, driven(raiseSeconds * 0.6), raiseSeconds * 0.4);
  run(view, state({ weapon: 'sentry9' }), 2 / 60);
  assert.ok(position(anchors(view).gripRight).distanceTo(position(anchors(reference).gripRight)) < 0.004, 'up as soon as the raise completes');
  view.dispose(); reference.dispose();
});

test('the sight sits on the view axis within a millimetre at full aim', async () => {
  const view = await viewModel();
  for (const id of WEAPON_IDS) {
    run(view, state({ weapon: id }), 0.8);
    run(view, state({ weapon: id, ads: 1 }), 1.2);
    const { sight } = anchors(view);
    const point = position(sight);
    const ahead = new THREE.Vector3(0, 0, -1).applyQuaternion(root(view).quaternion).add(point);
    assert.ok(Math.hypot(point.x, point.y) < 0.001, `${id} sight off axis by ${Math.hypot(point.x, point.y)}`);
    assert.ok(Math.hypot(ahead.x, ahead.y) < 0.001, `${id} sight line tilted by ${Math.hypot(ahead.x, ahead.y)} m at 1 m`);
    assert.ok(Math.abs(point.z + HANDLING[id].adsEye) < 0.002, `${id} eye relief`);
    run(view, state({ weapon: id }), 0.6);
  }
  view.dispose();
});

test('recoil kicks the weapon back and up, then settles exactly', async () => {
  const library = createWeaponLibrary(null);
  const shooter = await viewModel(library), twin = await viewModel(createWeaponLibrary(null));
  for (const id of ['kr5', 'breaker12', 'sentry9'] as WeaponId[]) {
    for (const view of [shooter, twin]) run(view, state({ weapon: id }), 0.8);
    shooter.fire();
    for (const view of [shooter, twin]) run(view, state({ weapon: id }), 0.04);
    const kicked = root(shooter).position.clone(), resting = root(twin).position.clone();
    assert.ok(kicked.z > resting.z + 0.006, `${id} pushed back (${(kicked.z - resting.z).toFixed(4)} m)`);
    const muzzleUp = position(anchors(shooter).muzzle).y - position(anchors(twin).muzzle).y;
    assert.ok(muzzleUp > 0.004, `${id} muzzle rose ${muzzleUp.toFixed(4)} m`);
    assert.ok(shooter.effects.flash.active, 'muzzle flash shows');
    for (const view of [shooter, twin]) run(view, state({ weapon: id }), 1.6);
    assert.ok(root(shooter).position.distanceTo(root(twin).position) < 1e-5, `${id} recoil settled`);
    assert.ok(root(shooter).quaternion.angleTo(root(twin).quaternion) < 1e-5);
    assert.equal(shooter.effects.flash.active, false);
  }
  // Heavier weapons kick harder.
  const peak = async (id: WeaponId) => {
    const a = await viewModel(), b = await viewModel();
    for (const view of [a, b]) run(view, state({ weapon: id }), 0.8);
    a.fire();
    let best = 0;
    for (let i = 0; i < 20; i++) { for (const view of [a, b]) view.update(state({ weapon: id }), DT, 0); best = Math.max(best, root(a).quaternion.angleTo(root(b).quaternion)); }
    a.dispose(); b.dispose();
    return best;
  };
  assert.ok(await peak('breaker12') > (await peak('hornet9')) * 2, 'the shotgun flips far more than the SMG');
  shooter.dispose(); twin.dispose();
});

test('aiming keeps recoil readable: the sight stays near the centre under fire', async () => {
  const view = await viewModel();
  run(view, state(), 0.6); run(view, state({ ads: 1 }), 1);
  let worst = 0;
  for (let shot = 0; shot < 12; shot++) {
    view.fire();
    for (let i = 0; i < 5; i++) { view.update(state({ ads: 1 }), DT, 0); const sight = position(anchors(view).sight); worst = Math.max(worst, Math.hypot(sight.x, sight.y)); }
  }
  assert.ok(worst < 0.012, `sight wandered ${worst.toFixed(4)} m during a burst`);
  view.dispose();
});

test('reloads move the magazine mid-way and put everything back at the end', async () => {
  const view = await viewModel();
  for (const id of ['kr5', 'hornet9', 'longbow', 'sentry9'] as WeaponId[]) {
    for (const empty of [false, true]) {
      run(view, state({ weapon: id }), 0.8);
      const { magazine, action } = anchors(view);
      assert.ok(magazine && action);
      const magRest = magazine.position.clone(), actionRest = action.position.clone(), actionTurn = action.quaternion.clone();
      const seconds = (empty ? WEAPONS[id].emptyReloadMs : WEAPONS[id].reloadMs) / 1000;
      let displaced = false, handAway = 0;
      run(view, t => {
        const progress = Math.min(1, t / seconds);
        return state({ weapon: id, reload: progress, reloadEmpty: empty });
      }, seconds * 0.5);
      displaced = !magazine.visible || magazine.position.distanceTo(magRest) > 0.05;
      handAway = position(view.arms.left!).distanceTo(position(anchors(view).gripLeft));
      assert.ok(displaced, `${id}${empty ? ' empty' : ''}: the magazine is out mid-way`);
      assert.ok(handAway > 0.05, `${id}: the support hand left the grip (${handAway.toFixed(3)})`);
      run(view, t => state({ weapon: id, reload: Math.min(1, 0.5 + t / seconds) }), seconds * 0.5 + 0.05);
      run(view, state({ weapon: id }), 0.6);
      assert.ok(magazine.visible && magazine.position.distanceTo(magRest) < 1e-6, `${id}: magazine restored`);
      assert.ok(action.position.distanceTo(actionRest) < 1e-6 && action.quaternion.angleTo(actionTurn) < 1e-6, `${id}: action restored`);
      assert.ok(position(view.arms.left!).distanceTo(position(anchors(view).gripLeft)) < 1e-4, `${id}: hand back on the grip`);
    }
  }
  view.dispose();
});

test('an empty reload drops the old magazine', async () => {
  const view = await viewModel();
  run(view, state(), 0.8);
  run(view, t => state({ reload: Math.min(1, t / 2.6), reloadEmpty: true }), 0.8);
  assert.equal(view.effects.drops.liveCount, 1);
  run(view, state(), 1);
  assert.equal(view.effects.drops.liveCount, 0);
  view.dispose();
});

test('the shotgun loads shell by shell, at the server pace', async () => {
  const view = await viewModel();
  run(view, state({ weapon: 'breaker12' }), 0.8);
  const pump = anchors(view).action!, pumpRest = pump.position.clone();
  const shells = 4, total = (350 + 450 * shells) / 1000;
  let shownFrames = 0, hiddenAfterShown = 0, wasShown = false;
  run(view, t => {
    const shown = !!view.props.shell?.visible;
    if (shown) shownFrames++;
    if (wasShown && !shown) hiddenAfterShown++;
    wasShown = shown;
    return state({ weapon: 'breaker12', reload: Math.min(1, t / total) });
  }, total);
  assert.ok(shownFrames > 20, 'a shell is carried to the port');
  assert.ok(hiddenAfterShown >= shells - 1 && hiddenAfterShown <= shells + 1, `about one shell per cycle (${hiddenAfterShown})`);
  assert.ok(pump.position.distanceTo(pumpRest) < 1e-6, 'the pump stays forward while loading');
  run(view, state({ weapon: 'breaker12' }), 0.6);
  assert.equal(view.props.shell?.visible, false);
  view.dispose();
});

test('pump and bolt actions cycle after each shot and eject at the right moment', async () => {
  const view = await viewModel();
  run(view, state({ weapon: 'breaker12' }), 0.8);
  const pump = anchors(view).action!, pumpRest = pump.position.z;
  view.fire();
  assert.equal(view.effects.casings.liveCount, 0, 'the hull leaves with the pump, not the shot');
  let travel = 0;
  run(view, () => { travel = Math.max(travel, pump.position.z - pumpRest); return state({ weapon: 'breaker12' }); }, 0.3);
  assert.ok(travel > 0.07, `the pump racked back ${travel.toFixed(3)} m`);
  assert.equal(view.effects.casings.liveCount, 1);
  run(view, state({ weapon: 'breaker12' }), 0.5);
  assert.ok(Math.abs(pump.position.z - pumpRest) < 1e-6);

  run(view, state({ weapon: 'longbow' }), 0.8);
  const bolt = anchors(view).action!, boltRest = bolt.position.clone();
  view.fire();
  let lifted = 0, pulled = 0, handAway = 0;
  run(view, () => {
    lifted = Math.max(lifted, bolt.quaternion.angleTo(new THREE.Quaternion()));
    pulled = Math.max(pulled, bolt.position.z - boltRest.z);
    handAway = Math.max(handAway, position(view.arms.right!).distanceTo(position(anchors(view).gripRight)));
    return state({ weapon: 'longbow' });
  }, 1);
  assert.ok(lifted > 0.9 && pulled > 0.08, `bolt lifted ${lifted.toFixed(2)} rad and pulled ${pulled.toFixed(3)} m`);
  assert.ok(handAway > 0.03, 'the right hand works the bolt');
  assert.ok(bolt.position.distanceTo(boltRest) < 1e-6);
  view.dispose();
});

test('casings fly out to the right and expire', async () => {
  const view = await viewModel();
  run(view, state(), 0.8);
  view.fire();
  assert.equal(view.effects.casings.liveCount, 1);
  const casings = view.effects.casings.group.children[0] as THREE.InstancedMesh;
  const at = (mesh: THREE.InstancedMesh) => { const matrix = new THREE.Matrix4(); mesh.getMatrixAt(0, matrix); return new THREE.Vector3().setFromMatrixPosition(matrix); };
  view.update(state(), DT, 0);
  const start = at(casings);
  run(view, state(), 0.1);
  assert.ok(at(casings).x > start.x + 0.1, 'moving right, away from the gun');
  for (let i = 0; i < 40; i++) view.fire();
  assert.ok(view.effects.casings.liveCount <= 12, 'pooled');
  run(view, state(), 1.2);
  assert.equal(view.effects.casings.liveCount, 0);
  view.dispose();
});

test('muzzle smoke never sits over the aim point while aiming', async () => {
  const view = await viewModel();
  run(view, state(), 0.6); run(view, state({ ads: 1 }), 1);
  let checked = 0;
  for (let shot = 0; shot < 6; shot++) {
    view.fire();
    for (let i = 0; i < 8; i++) {
      view.update(state({ ads: 1 }), DT, 0);
      for (const puff of view.effects.smoke.live()) {
        const radial = Math.hypot(puff.position.x, puff.position.y) / Math.max(1e-3, -puff.position.z);
        if (radial < MuzzleSmoke.CLEAR * 0.5) assert.ok(MuzzleSmoke.clearance(puff.position, 1) < 0.02, 'puffs near the centre are invisible');
        checked++;
      }
    }
  }
  assert.ok(checked > 0);
  assert.equal(MuzzleSmoke.clearance(new THREE.Vector3(0, 0, -1), 0), 1, 'hip fire keeps the smoke');
  view.dispose();
});

test('scoping hides the weapon and arms, and unscoping shows them again', async () => {
  const view = await viewModel();
  run(view, state({ weapon: 'longbow' }), 0.8);
  run(view, state({ weapon: 'longbow', ads: 1, scoped: true }), 0.3);
  assert.equal(root(view).visible, false);
  assert.equal(view.arms.left!.visible, false); assert.equal(view.arms.right!.visible, false);
  view.fire(); view.update(state({ weapon: 'longbow', ads: 1, scoped: true }), DT, 0);
  assert.equal(view.effects.flash.group.visible, false, 'no flash over the scope');
  run(view, state({ weapon: 'longbow', ads: 1, scoped: true }), 0.6);
  assert.equal(view.effects.casings.liveCount, 1, 'the bolt still ejects');
  assert.equal(view.effects.casings.group.visible, false, 'but the casing never crosses the scope picture');
  assert.equal(view.effects.smoke.mesh.visible, false);
  run(view, state({ weapon: 'longbow' }), 0.1);
  assert.equal(root(view).visible, true);
  assert.equal(view.arms.right!.visible, true);
  view.dispose();
});

test('muzzleWorld maps viewmodel space through the world camera', async () => {
  const view = await viewModel();
  view.setProjection(62, 16 / 9);
  run(view, state(), 0.8);
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.05, 500);
  camera.position.set(4, 1.62, -3); camera.rotation.set(-0.2, 0.7, 0, 'YXZ'); camera.updateMatrixWorld();
  const local = position(anchors(view).muzzle);
  const world = view.muzzleWorld(camera, new THREE.Vector3());
  assert.ok(world.distanceTo(local.clone().applyMatrix4(camera.matrixWorld)) < 1e-9);
  assert.ok(world.distanceTo(camera.position) > 0.5 && world.distanceTo(camera.position) < 1.2);
  // A different world projection still lands on the same pixel.
  const wide = new THREE.PerspectiveCamera(80, 16 / 9, 0.05, 500);
  wide.position.copy(camera.position); wide.quaternion.copy(camera.quaternion); wide.updateMatrixWorld();
  const mapped = view.muzzleWorld(wide, new THREE.Vector3());
  const pixel = mapped.clone().project(wide), expected = local.clone().applyMatrix4(view.camera.projectionMatrix);
  assert.ok(Math.abs(pixel.x - expected.x) < 1e-6 && Math.abs(pixel.y - expected.y) < 1e-6);
  const eject = view.ejectWorld(camera, new THREE.Vector3());
  assert.ok(eject.distanceTo(position(anchors(view).eject).applyMatrix4(camera.matrixWorld)) < 1e-9);
  view.dispose();
});

test('look sway lags behind a turn, banks into it and settles', async () => {
  const view = await viewModel(), twin = await viewModel();
  for (const v of [view, twin]) run(v, state(), 0.8);
  for (let i = 0; i < 20; i++) { view.update(state({ lookDelta: { yaw: 0.04, pitch: 0 } }), DT, 0); twin.update(state(), DT, 0); }
  const muzzle = position(anchors(view).muzzle), still = position(anchors(twin).muzzle);
  assert.ok(muzzle.x < still.x - 0.01, `turning right leaves the muzzle behind on the left (${(muzzle.x - still.x).toFixed(3)})`);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(root(view).quaternion), stillUp = new THREE.Vector3(0, 1, 0).applyQuaternion(root(twin).quaternion);
  assert.ok(up.x > stillUp.x + 0.01, 'the weapon banks into the turn');
  for (const v of [view, twin]) run(v, state(), 1.5);
  assert.ok(root(view).position.distanceTo(root(twin).position) < 1e-5);
  // A hard flick stays bounded.
  for (let i = 0; i < 10; i++) view.update(state({ lookDelta: { yaw: 0.6, pitch: -0.4 } }), DT, 0);
  for (const value of root(view).position.toArray()) assert.ok(Number.isFinite(value));
  assert.ok(root(view).quaternion.angleTo(root(twin).quaternion) < 0.3);
  view.dispose(); twin.dispose();
});

test('stride bob follows the feet, sprint swings harder and reduced motion calms it', async () => {
  const sway = async (patch: Partial<ViewModelState>) => {
    const view = await viewModel(), twin = await viewModel();
    for (const v of [view, twin]) run(v, state(), 0.8);
    let max = 0;
    for (let i = 0; i < 120; i++) {
      view.update(state(patch), DT, 0); twin.update(state(patch.reduceMotion ? { reduceMotion: true } : {}), DT, 0);
      max = Math.max(max, position(anchors(view).muzzle).distanceTo(position(anchors(twin).muzzle)));
    }
    view.dispose(); twin.dispose();
    return max;
  };
  const walk = await sway({ speed: 5 }), calm = await sway({ speed: 5, reduceMotion: true });
  assert.ok(walk > 0.008, `walking bob ${walk.toFixed(4)}`);
  assert.ok(calm < walk * 0.4, `reduced motion ${calm.toFixed(4)} vs ${walk.toFixed(4)}`);
  const view = await viewModel();
  run(view, state(), 0.8);
  run(view, state({ sprint: 1, speed: 6.9 }), 0.8);
  const sprinting = position(anchors(view).muzzle);
  assert.ok(sprinting.y < -0.25, 'sprinting points the muzzle down');
  run(view, state({ sprint: 1, dash: true, speed: 8.2 }), 1);
  assert.ok(position(anchors(view).muzzle).y > sprinting.y + 0.2, 'the faster sprint lifts the weapon');
  view.dispose();
});

test('jumping, landing, crouching and sliding move the weapon and settle', async () => {
  const view = await viewModel(), twin = await viewModel();
  for (const v of [view, twin]) run(v, state(), 0.8);
  run(view, state({ grounded: false }), 0.6); run(twin, state(), 0.6);
  view.update(state(), DT, 0); twin.update(state(), DT, 0);
  view.land(1);
  let dip = 0;
  for (let i = 0; i < 12; i++) { view.update(state(), DT, 0); twin.update(state(), DT, 0); dip = Math.max(dip, root(twin).position.y - root(view).position.y); }
  assert.ok(dip > 0.008, `landing dips the weapon ${dip.toFixed(4)} m`);
  for (const v of [view, twin]) run(v, state(), 1.5);
  assert.ok(root(view).position.distanceTo(root(twin).position) < 1e-4);
  run(view, state({ posture: 'slide', speed: 8 }), 0.4);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(root(view).quaternion);
  assert.ok(up.x < -0.15, 'sliding cants the weapon');
  run(view, state({ posture: 'crouch' }), 0.8);
  run(view, state(), 1.2); run(twin, state(), 2.4);
  assert.ok(root(view).position.distanceTo(root(twin).position) < 1e-4);
  view.dispose(); twin.dispose();
});

test('walls, swaps and spawns lower or retract the weapon', async () => {
  const view = await viewModel(), twin = await viewModel();
  run(view, state(), 0.8); run(twin, state(), 0.8);
  const rest = position(anchors(view).muzzle);
  run(view, state({ wallBlock: 1 }), 0.6);
  const blocked = position(anchors(view).muzzle);
  assert.ok(blocked.z > rest.z + 0.1, `retracted ${(blocked.z - rest.z).toFixed(3)} m`);
  assert.ok(blocked.y < rest.y, 'and lowered');
  run(view, state({ raise: 0 }), 0.6);
  const grip = position(anchors(view).gripRight).applyMatrix4(view.camera.projectionMatrix);
  view.camera.updateProjectionMatrix();
  assert.ok(grip.y < -1, 'a lowered weapon is below the view');
  run(view, state(), 1.2); run(twin, state(), 2.4);
  assert.ok(position(anchors(view).muzzle).distanceTo(position(anchors(twin).muzzle)) < 1e-4);
  view.dispose(); twin.dispose();
});

test('the knife swing and the grenade throw take the left hand and give it back', async () => {
  const view = await viewModel();
  run(view, state(), 0.8);
  view.melee();
  run(view, state(), 0.2);
  assert.equal(view.props.knife!.visible, true);
  assert.ok(position(view.arms.left!).distanceTo(position(anchors(view).gripLeft)) > 0.1);
  run(view, state(), 0.7);
  assert.equal(view.props.knife!.visible, false);
  assert.ok(position(view.arms.left!).distanceTo(position(anchors(view).gripLeft)) < 1e-3);

  run(view, t => state({ cook: Math.min(1, t / 3.4) }), 0.5);
  assert.equal(view.props.frag!.visible, true, 'the cooking grenade is in hand');
  const held = position(view.props.frag!);
  assert.ok(held.x < 0 && held.z < -0.2, 'held up on the left');
  run(view, state(), 0.25);
  assert.equal(view.props.frag!.visible, false, 'released by the throw');
  run(view, state(), 0.6);
  assert.ok(position(view.arms.left!).distanceTo(position(anchors(view).gripLeft)) < 1e-3);
  view.vault();
  run(view, state({ posture: 'vault' }), 0.2);
  assert.ok(position(view.arms.left!).distanceTo(position(anchors(view).gripLeft)) > 0.1, 'the hand plants on the ledge');
  run(view, state(), 0.8);
  assert.ok(position(view.arms.left!).distanceTo(position(anchors(view).gripLeft)) < 1e-3);
  view.dispose();
});

test('lighting follows the world sun relative to the camera and copies the sky', async () => {
  const view = await viewModel();
  const camera = new THREE.PerspectiveCamera();
  camera.rotation.set(0.3, -1.1, 0, 'YXZ'); camera.updateMatrixWorld();
  const world = new THREE.Scene(); world.environment = new THREE.Texture(); world.environmentIntensity = 0.055;
  view.setWorld(camera, world);
  view.update(state(), DT, 0);
  const expected = SUN_DIRECTION.clone().applyQuaternion(camera.quaternion.clone().invert());
  assert.ok(view.sunDirection.distanceTo(expected) < 1e-9);
  assert.equal(view.scene.environment, world.environment);
  assert.equal(view.scene.environmentIntensity, 0.055);
  // The environment lookup lands on the world direction (r185 uses the transpose of this rotation).
  const lookup = new THREE.Matrix4().makeRotationFromEuler(view.scene.environmentRotation).transpose();
  const cameraSpaceUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion.clone().invert());
  assert.ok(cameraSpaceUp.applyMatrix4(lookup).distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-9);
  view.dispose();
});

test('disposal releases the library and is safe to repeat', async () => {
  const library = createWeaponLibrary(null);
  let released = 0;
  const wrapped: WeaponLibrary = { ...library, weapon: library.weapon, knife: library.knife, frag: library.frag, arms: library.arms, fromAsset: library.fromAsset, missing: library.missing, dispose: () => { released++; library.dispose(); } };
  const view = await viewModel(wrapped);
  run(view, state(), 0.3);
  view.dispose(); view.dispose();
  assert.equal(released, 1);
  view.update(state(), DT, 0); view.fire();
  // A view model disposed before its library arrives still releases it.
  let late = 0;
  const pending = new ViewModel(renderer, { library: Promise.resolve({ ...wrapped, dispose: () => { late++; } }) });
  pending.dispose();
  await pending.ready;
  assert.equal(late, 1);
});
