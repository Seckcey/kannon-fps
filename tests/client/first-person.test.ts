import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { directionFromAngles, EYE_HEIGHT, isPlayerGrounded } from '../../shared/physics';
import type { InputFrame, Posture } from '../../shared/protocol';
import {
  blastFeedback, cameraFov, FirstPersonCamera, FirstPersonMotion, flinchKick, LandingFilter, landingStrength, SLIDE_ROLL, SPRINT_FOV_BONUS, STEP_DOWN_SPEED, Stride,
  verticalFov, viewYaw, WALL_BLOCK_CLEAR, WALL_BLOCK_NEAR, zoomFov, type CameraFrame, type MotionFrame,
} from '../../src/game/FirstPersonCamera';
import { relative, stereoPan } from '../../src/game/audio/spatial';
import { MovementPrediction, type PredictionSource } from '../../src/game/MovementPrediction';
import { DEFAULT_LOADOUT, STEADY_AIM_ADS_FACTOR, STEADY_AIM_FLINCH_FACTOR } from '../../shared/weapons';

const near = (actual: number, expected: number, tolerance = 1e-6, label = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} vs ${expected}`);
const base = (changes: Partial<CameraFrame> = {}): CameraFrame => ({
  dt: 1 / 60, feet: { x: 2, y: 0, z: -3 }, posture: 'stand', grounded: true, speed: 0, vx: 0, vz: 0, yaw: 0.4, pitch: -0.2,
  fov: 90, aspect: 16 / 9, ads: 0, adsZoom: 1.3, sprint: 0, sprinting: false, dashing: false, vault: -1, reduceMotion: false, ...changes,
});
function settle(view: FirstPersonCamera, camera: THREE.PerspectiveCamera, frame: CameraFrame, seconds: number) {
  for (let t = 0; t < seconds; t += frame.dt) view.update(camera, frame);
}

test('field of view converts horizontal degrees by aspect, adds 4 degrees when sprinting and zooms like an optic', () => {
  near(verticalFov(90, 16 / 9), THREE.MathUtils.radToDeg(2 * Math.atan(1 / (16 / 9))), 1e-9);
  near(verticalFov(90, 1), 90, 1e-9);
  near(zoomFov(60, 1), 60, 1e-9);
  near(zoomFov(60, 1.3), THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(Math.PI / 6) / 1.3)), 1e-9);
  near(cameraFov(90, 16 / 9, 1, 0, 1.3), verticalFov(90, 16 / 9) + SPRINT_FOV_BONUS, 1e-9);
  near(cameraFov(90, 16 / 9, 0, 1, 4.2), zoomFov(verticalFov(90, 16 / 9), 4.2), 1e-9);
  near(cameraFov(90, 16 / 9, 0, 0.5, 1.3), zoomFov(verticalFov(90, 16 / 9), 1.15), 1e-9, 'Half aimed is half the zoom');
  assert.ok(Number.isFinite(cameraFov(NaN, NaN, 0, 0, NaN)), 'Bad settings still give a usable view');
});

test('the camera sits at the posture eye height and looks exactly along the sent view', () => {
  const view = new FirstPersonCamera(), camera = new THREE.PerspectiveCamera();
  const frame = base();
  view.snap(frame.feet, 'stand');
  view.update(camera, frame);
  near(camera.position.y, EYE_HEIGHT.stand, 1e-9, 'stand eye');
  near(camera.position.x, 2, 1e-9); near(camera.position.z, -3, 1e-9);
  const direction = camera.getWorldDirection(new THREE.Vector3()), expected = directionFromAngles(frame.yaw, frame.pitch);
  near(direction.x, expected.x, 1e-9); near(direction.y, expected.y, 1e-9); near(direction.z, expected.z, 1e-9);
  for (const posture of ['crouch', 'slide', 'vault'] as Posture[]) {
    settle(view, camera, base({ posture }), 1.5);
    near(camera.position.y, EYE_HEIGHT[posture], 0.01, `${posture} eye`);
  }
  const crouched = new FirstPersonCamera(); crouched.snap(frame.feet, 'stand');
  crouched.update(camera, base({ posture: 'crouch' }));
  assert.ok(camera.position.y > EYE_HEIGHT.crouch + 0.3, 'Crouching eases down rather than snapping');
});

test('a slide rolls the camera about 4 degrees; reduced motion keeps it level and removes bob', () => {
  const view = new FirstPersonCamera(), camera = new THREE.PerspectiveCamera();
  view.snap({ x: 0, y: 0, z: 0 }, 'slide');
  settle(view, camera, base({ posture: 'slide', speed: 8, vx: 0, vz: -8, yaw: 0, pitch: 0 }), 1);
  near(Math.abs(camera.rotation.z), SLIDE_ROLL, 0.002, 'slide roll');
  const still = new FirstPersonCamera();
  still.snap({ x: 0, y: 0, z: 0 }, 'slide');
  settle(still, camera, base({ posture: 'slide', speed: 8, vz: -8, yaw: 0, reduceMotion: true }), 1);
  near(camera.rotation.z, 0, 1e-9, 'reduced motion roll');
  const walker = new FirstPersonCamera(), heights = new Set<string>();
  walker.snap({ x: 0, y: 0, z: 0 }, 'stand');
  for (let i = 0; i < 90; i++) { walker.update(camera, base({ speed: 5, feet: { x: 0, y: 0, z: -i * 5 / 60 }, reduceMotion: true })); heights.add(camera.position.y.toFixed(6)); }
  assert.equal(heights.size, 1, 'No bob with reduced motion');
  const bobbing = new FirstPersonCamera(); let low = Infinity, high = -Infinity;
  bobbing.snap({ x: 0, y: 0, z: 0 }, 'stand');
  for (let i = 0; i < 120; i++) { bobbing.update(camera, base({ speed: 5, feet: { x: 0, y: 0, z: -i * 5 / 60 } })); if (i > 60) { low = Math.min(low, camera.position.y); high = Math.max(high, camera.position.y); } }
  assert.ok(high - low > 0.01 && high - low < 0.06, `walking bob ${high - low}`);
});

test('a hard landing dips the view and springs back; stairs glide while jumps follow at once', () => {
  const view = new FirstPersonCamera(), camera = new THREE.PerspectiveCamera(), frame = base();
  view.snap(frame.feet, 'stand');
  view.land(landingStrength(10, true));
  let lowest = Infinity;
  for (let i = 0; i < 20; i++) { view.update(camera, frame); lowest = Math.min(lowest, camera.position.y); }
  assert.ok(lowest < EYE_HEIGHT.stand - 0.05, `dip ${EYE_HEIGHT.stand - lowest}`);
  settle(view, camera, frame, 1.5);
  near(camera.position.y, EYE_HEIGHT.stand, 0.002, 'recovered');
  const gentle = new FirstPersonCamera(); gentle.snap(frame.feet, 'stand'); gentle.land(landingStrength(10, true), true);
  let gentleLowest = Infinity;
  for (let i = 0; i < 20; i++) { gentle.update(camera, frame); gentleLowest = Math.min(gentleLowest, camera.position.y); }
  assert.ok(EYE_HEIGHT.stand - gentleLowest < (EYE_HEIGHT.stand - lowest) * 0.5, 'Reduced motion softens the dip');
  const stairs = new FirstPersonCamera(); stairs.snap(frame.feet, 'stand');
  stairs.update(camera, base({ feet: { x: 2, y: 0.32, z: -3 } }));
  assert.ok(camera.position.y < EYE_HEIGHT.stand + 0.32 - 0.05, 'A step up glides');
  settle(stairs, camera, base({ feet: { x: 2, y: 0.32, z: -3 } }), 0.6);
  near(camera.position.y, EYE_HEIGHT.stand + 0.32, 0.003);
  stairs.update(camera, base({ feet: { x: 2, y: 0.8, z: -3 }, grounded: false }));
  near(camera.position.y, EYE_HEIGHT.stand + 0.8, 1e-9, 'Airborne height is never smoothed');
});

test('strides count footfalls from distance travelled and pause in the air', () => {
  const stride = new Stride();
  let steps = 0;
  for (let i = 0; i < 92; i++) if (stride.update(5, 1 / 60, 0.75, true)) steps++;
  assert.equal(steps, 10, 'About 7.6 m at 0.75 m per step');
  for (let i = 0; i < 60; i++) assert.equal(stride.update(5, 1 / 60, 0.75, false), false);
  assert.equal(stride.update(0.2, 1, 0.75, true), false, 'Standing still is silent');
});

test('the death view sinks toward the floor and turns toward the attacker', () => {
  const view = new FirstPersonCamera(), camera = new THREE.PerspectiveCamera(), hip = verticalFov(90, 16 / 9);
  view.snap({ x: 0, y: 0, z: 0 }, 'stand');
  view.update(camera, base({ feet: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 }));
  for (let i = 0; i < 180; i++) view.updateDeath(camera, 1 / 60, { x: 10, y: 0, z: 0 }, false, hip);
  assert.ok(camera.position.y < 0.6, `eye ${camera.position.y}`);
  const direction = camera.getWorldDirection(new THREE.Vector3());
  assert.ok(direction.x > 0.9, 'Facing the attacker on +X');
  view.update(camera, base({ feet: { x: 0, y: 0, z: 0 } }));
  near(camera.position.y, EYE_HEIGHT.stand, 0.2, 'A new life returns to the eye');
});

test('dying scoped or aimed eases the death view back to the hip field of view, also in the projection', () => {
  for (const [label, changes] of [
    ['Heron 7 scoped', { ads: 1, adsZoom: 4.2 }], ['carbine aimed', { ads: 1, adsZoom: 1.3 }], ['sprinting', { sprint: 1, sprinting: true }],
  ] as const) for (const [fov, aspect] of [[90, 16 / 9], [80, 2.16]] as const) {
    const view = new FirstPersonCamera(), camera = new THREE.PerspectiveCamera(), hip = verticalFov(fov, aspect);
    view.snap({ x: 0, y: 0, z: 0 }, 'stand');
    view.update(camera, base({ feet: { x: 0, y: 0, z: 0 }, fov, aspect, ...changes }));
    assert.ok(Math.abs(camera.fov - hip) > 3, `${label}: the zoom is on at the moment of death`);
    const zoomed = camera.fov;
    view.updateDeath(camera, 1 / 60, null, false, hip);
    assert.ok(Math.abs(camera.fov - hip) < Math.abs(zoomed - hip) && Math.abs(camera.fov - hip) > 0.5, `${label}: it eases, not jumps`);
    for (let i = 0; i < 14; i++) view.updateDeath(camera, 1 / 60, null, false, hip);
    assert.ok(Math.abs(camera.fov - hip) < Math.abs(zoomed - hip) * 0.06, `${label}: most of the way back a quarter second in`);
    for (let i = 0; i < 45; i++) view.updateDeath(camera, 1 / 60, null, false, hip);
    near(camera.fov, hip, 1e-9, `${label} at ${fov} degrees: exactly the hip view a second in`);
    const projected = new THREE.PerspectiveCamera(hip, aspect, camera.near, camera.far);
    projected.updateProjectionMatrix();
    near(camera.projectionMatrix.elements[5]!, projected.projectionMatrix.elements[5]!, 1e-9, `${label}: the projection follows`);
    for (let i = 0; i < 150; i++) view.updateDeath(camera, 1 / 60, null, true, hip);
    near(camera.fov, hip, 1e-9, `${label}: and stays there for the rest of the wait`);
  }
});

test('the ears face the drawn view: the yaw of the death view and of the first-person view', () => {
  const view = new FirstPersonCamera(), camera = new THREE.PerspectiveCamera();
  view.snap({ x: 0, y: 0, z: 0 }, 'stand');
  for (const yaw of [0, 0.4, -2.5, 3]) {
    view.update(camera, base({ feet: { x: 0, y: 0, z: 0 }, yaw, pitch: -0.3 }));
    near(viewYaw(camera), Math.atan2(Math.sin(yaw), Math.cos(yaw)), 1e-9, `first person at yaw ${yaw}`);
  }
  // Shot from behind-left: the death view turns around to face the attacker, who is then drawn ahead.
  view.update(camera, base({ feet: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 }));
  const killer = { x: -4, y: 0, z: 10 };
  for (let i = 0; i < 120; i++) view.updateDeath(camera, 1 / 60, killer, false, verticalFov(90, 16 / 9));
  camera.updateMatrixWorld();
  const facing = viewYaw(camera), ears = { x: camera.position.x, y: camera.position.y, z: camera.position.z, yaw: facing, indoors: false };
  const heard = relative(ears, { x: killer.x, y: killer.y + 1.2, z: killer.z });
  assert.ok(heard.ahead > 0 && Math.abs(stereoPan(heard)) < 0.05, `The attacker drawn ahead is heard ahead (pan ${stereoPan(heard)})`);
  const stale = relative({ ...ears, yaw: 0 }, { x: killer.x, y: killer.y + 1.2, z: killer.z });
  assert.ok(stale.ahead < 0, 'The input yaw from before the death would put them behind');
  // Another player off to the left of the turned view: heard on the left, not the opposite ear.
  const side = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).multiplyScalar(-6).add(camera.position);
  assert.ok(stereoPan(relative(ears, side)) < -0.3, 'Left of the drawn view is the left ear');
});

const motionFrame = (changes: Partial<MotionFrame> = {}): MotionFrame => ({
  dt: 1 / 60, posture: 'stand', sprinting: false, aimWanted: false, wallDistance: 20, adsMs: 240, steadyAim: false, ...changes,
});

test('aiming down sights takes the weapon aim time, 20% less with the steady-aim perk, and never while sprinting or against a wall', () => {
  for (const steadyAim of [false, true]) {
    const motion = new FirstPersonMotion();
    const events = [];
    let frames = 0;
    while (motion.ads < 1 && frames < 100) { events.push(motion.update(motionFrame({ aimWanted: true, steadyAim, dt: 1 / 100 }))); frames++; }
    const expected = 240 * (steadyAim ? STEADY_AIM_ADS_FACTOR : 1) / 10;
    assert.ok(Math.abs(frames - expected) <= 1, `${frames} frames of 10 ms, expected ${expected}`);
    assert.equal(events[0]!.aim, true, 'The first aimed frame reports the change (for the aim sound)');
    assert.ok(events.slice(1).every(event => event.aim === null));
  }
  const sprinting = new FirstPersonMotion();
  for (let i = 0; i < 60; i++) sprinting.update(motionFrame({ aimWanted: true, sprinting: true }));
  assert.equal(sprinting.ads, 0); assert.ok(sprinting.sprint > 0.99);
  const walled = new FirstPersonMotion();
  for (let i = 0; i < 60; i++) walled.update(motionFrame({ aimWanted: true, wallDistance: 0.3 }));
  assert.equal(walled.ads, 0, 'A lowered weapon cannot aim'); assert.ok(walled.wallBlock > 0.99);
});

test('the weapon lowers against a wall with hysteresis so it does not flicker at the edge', () => {
  const motion = new FirstPersonMotion();
  motion.update(motionFrame({ wallDistance: WALL_BLOCK_NEAR + 0.02 })); assert.equal(motion.fireBlocked, false);
  motion.update(motionFrame({ wallDistance: WALL_BLOCK_NEAR - 0.01 })); assert.equal(motion.fireBlocked, true);
  motion.update(motionFrame({ wallDistance: (WALL_BLOCK_NEAR + WALL_BLOCK_CLEAR) / 2 })); assert.equal(motion.fireBlocked, true, 'Still lowered in the gap');
  motion.update(motionFrame({ wallDistance: WALL_BLOCK_CLEAR + 0.01 })); assert.equal(motion.fireBlocked, false);
  motion.update(motionFrame({ wallDistance: NaN })); assert.equal(motion.fireBlocked, false, 'No reading means open air');
  motion.update(motionFrame({ wallDistance: 0.2 })); motion.leave();
  assert.equal(motion.fireBlocked, false); assert.equal(motion.ads, 0);
});

test('slides and vaults are read from the predicted body once each', () => {
  const motion = new FirstPersonMotion();
  assert.equal(motion.update(motionFrame({ posture: 'slide' })).slide, true);
  assert.equal(motion.update(motionFrame({ posture: 'slide' })).slide, false);
  assert.equal(motion.update(motionFrame({ posture: 'vault' })).vault, true);
  motion.reset('vault');
  assert.equal(motion.update(motionFrame({ posture: 'vault' })).vault, false, 'A respawn mid-vault does not replay it');
});

test('flinch kicks the view up by the damage, 40% less with the steady-aim perk; blasts shake and flash by distance', () => {
  const half = () => 0.75;
  const light = flinchKick(10, false, half), heavy = flinchKick(80, false, half), steady = flinchKick(80, true, half);
  near(heavy.pitch, 0.018, 1e-12, 'Capped at 40 damage'); near(light.pitch, 0.018 / 4, 1e-12);
  near(steady.pitch, heavy.pitch * STEADY_AIM_FLINCH_FACTOR, 1e-12); near(steady.yaw, heavy.yaw * STEADY_AIM_FLINCH_FACTOR, 1e-12);
  assert.ok(heavy.yaw > 0); assert.equal(flinchKick(NaN, false).pitch, 0);
  const close = blastFeedback(2, 'frag', true), far = blastFeedback(15, 'frag', true), hidden = blastFeedback(2, 'frag', false);
  assert.ok(close.shake > far.shake && far.shake > 0); assert.ok(close.flash > 0.7); assert.equal(far.flash, 0); assert.equal(hidden.flash, 0);
  assert.ok(blastFeedback(20, 'mortar', true).shake > 0, 'Mortars shake from further away');
  assert.deepEqual(blastFeedback(NaN, 'frag', true), { shake: 0, flash: 0 });
});

const body = (x: number, y: number, z: number, yaw: number): PredictionSource => ({
  id: 'dad', name: 'Dad', color: '#ffffff', x, y, z, yaw, pitch: 0, vx: 0, vy: 0, vz: 0, health: 100, slot: 1, weapon: 'kr5', loadout: DEFAULT_LOADOUT,
  kills: 0, deaths: 0, assists: 0, score: 0, streak: 0, connected: true, respawnAt: 0, protectedUntil: 0, reloadingUntil: 0,
  posture: 'stand', vault: null, slideUntil: 0, cookingSince: 0, lastInputSeq: 0,
});
const input = (seq: number, changes: Partial<InputFrame>): InputFrame => ({
  seq, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, fire: false, aim: false, jump: false, sprint: false, reload: false, slot: 1,
  crouch: false, dash: false, melee: false, grenade: false, streak: null, viewTime: 0, ...changes,
});
/** Moves the local player one server tick per input, as GameView.recordInput does. `felt` holds the
 * landings the player feels; `heard` what another player hears from the 15 Hz snapshots of the same run. */
function landings(start: PredictionSource, ticks: number, script: (tick: number) => Partial<InputFrame>) {
  const prediction = new MovementPrediction(), local = new LandingFilter(), remote = new LandingFilter(), felt: number[] = [], heard: number[] = [];
  let vaulted = false;
  prediction.reset(start, 10_000);
  for (let tick = 0; tick < ticks; tick++) {
    const events = prediction.step(input(tick + 1, { yaw: start.yaw, ...script(tick) }));
    const state = prediction.state, grounded = isPlayerGrounded(state);
    if (events.vaultStarted) vaulted = true;
    const strength = local.tick(events, grounded, state.posture);
    if (strength > 0) felt.push(strength);
    if (tick % 2) continue;
    const thump = remote.observe(grounded, state.vy, state.posture);
    if (thump > 0) heard.push(thump);
  }
  return { felt, heard, state: prediction.state, vaulted };
}
const gaits = [['walking', { moveZ: 1 }], ['running', { moveZ: 1, sprint: true }], ['dashing', { moveZ: 1, sprint: true, dash: true }]] as const;

test('walking, running and dashing down the house stairs stays smooth: no landing dip or thump on the steps', () => {
  for (const x of [-19, 19, -24.35, 24.35]) for (const [gait, changes] of gaits) {
    const run = landings(body(x, 3.2, 3.6, 0), 120, () => changes);
    assert.ok(run.state.y < 0.05, `${gait} from x=${x} reached the bottom (y ${run.state.y.toFixed(2)})`);
    assert.deepEqual(run.felt, [], `${gait} down the stairs at x=${x} is not a landing`);
    assert.deepEqual(run.heard, [], `others hear no landing while ${gait} down the stairs at x=${x}`);
  }
});

test('jumps, vault drops and real falls still land with a dip and a thump', () => {
  const hop = landings(body(-6, 0, 20, Math.PI / 2), 40, tick => ({ jump: tick === 0 }));
  assert.equal(hop.felt.length, 1, 'A jump lands once');
  near(hop.felt[0]!, landingStrength(6, true), 0.05, 'A jump lands at about its launch speed');
  assert.equal(hop.heard.length, 1, 'Others hear the jump land');
  for (const side of [-1, 1]) {
    // Through the front window beside the sofa: over the 0.95 m sill and down onto the floor inside.
    const vault = landings(body(side * 8.9, 0, 1.6, side * Math.PI / 2), 40, tick => ({ moveZ: 1, jump: tick === 2 }));
    assert.ok(vault.vaulted && vault.state.y === 0 && Math.abs(vault.state.x) > 11, 'The press vaults in through the window');
    assert.equal(vault.felt.length, 1, 'The drop after the vault lands although a step-down that size would not');
  }
  for (const x of [-22.6, 22.6]) {
    const fall = landings(body(x, 3.2, 3.5, 0), 60, () => ({ moveZ: 1 }));
    assert.ok(fall.state.y < 0.05, `walked off the balcony at x=${x}`);
    assert.equal(fall.felt.length, 1, 'A drop from the balcony lands');
    assert.ok(fall.felt[0]! > 0.4, `strength ${fall.felt[0]}`);
    assert.equal(fall.heard.length, 1);
  }
});

test('landing strength grows with speed; an unplanned fall only counts beyond a stair step-down', () => {
  near(landingStrength(6, true), 0.5, 1e-12); near(landingStrength(24, true), 1, 1e-12);
  assert.equal(landingStrength(STEP_DOWN_SPEED, false), 0);
  assert.ok(landingStrength(STEP_DOWN_SPEED + 0.4, false) > 0 && landingStrength(STEP_DOWN_SPEED + 0.4, false) < landingStrength(STEP_DOWN_SPEED + 0.4, true));
  near(landingStrength(10, false), landingStrength(10, true), 1e-12, 'Big falls count fully');
  for (const bad of [0, -3, NaN]) assert.equal(landingStrength(bad, true), 0);
  const filter = new LandingFilter();
  const still = { jumped: false, vaultEnded: false, landedSpeed: 0 };
  filter.tick({ ...still, jumped: true }, false, 'stand');
  filter.tick(still, true, 'stand');
  assert.equal(filter.tick({ ...still, landedSpeed: 5 }, true, 'stand'), 0, 'A jump that ended on a step without a landing does not make the next step-down deliberate');
  assert.equal(filter.observe(true, 0, 'stand'), 0);
  filter.observe(false, -2.5, 'stand');
  assert.equal(filter.observe(true, 0, 'stand'), 0, 'Others never hear falls slower than 3 m/s');
});
