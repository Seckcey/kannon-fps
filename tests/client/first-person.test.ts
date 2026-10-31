import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { directionFromAngles, EYE_HEIGHT } from '../../shared/physics';
import type { Posture } from '../../shared/protocol';
import {
  blastFeedback, cameraFov, FirstPersonCamera, FirstPersonMotion, flinchKick, SLIDE_ROLL, SPRINT_FOV_BONUS, Stride, verticalFov, WALL_BLOCK_CLEAR, WALL_BLOCK_NEAR, zoomFov,
  type CameraFrame, type MotionFrame,
} from '../../src/game/FirstPersonCamera';
import { STEADY_AIM_ADS_FACTOR, STEADY_AIM_FLINCH_FACTOR } from '../../shared/weapons';

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
  view.land(10);
  let lowest = Infinity;
  for (let i = 0; i < 20; i++) { view.update(camera, frame); lowest = Math.min(lowest, camera.position.y); }
  assert.ok(lowest < EYE_HEIGHT.stand - 0.05, `dip ${EYE_HEIGHT.stand - lowest}`);
  settle(view, camera, frame, 1.5);
  near(camera.position.y, EYE_HEIGHT.stand, 0.002, 'recovered');
  const gentle = new FirstPersonCamera(); gentle.snap(frame.feet, 'stand'); gentle.land(10, true);
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
  const view = new FirstPersonCamera(), camera = new THREE.PerspectiveCamera();
  view.snap({ x: 0, y: 0, z: 0 }, 'stand');
  view.update(camera, base({ feet: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 }));
  for (let i = 0; i < 180; i++) view.updateDeath(camera, 1 / 60, { x: 10, y: 0, z: 0 }, false);
  assert.ok(camera.position.y < 0.6, `eye ${camera.position.y}`);
  const direction = camera.getWorldDirection(new THREE.Vector3());
  assert.ok(direction.x > 0.9, 'Facing the attacker on +X');
  view.update(camera, base({ feet: { x: 0, y: 0, z: 0 } }));
  near(camera.position.y, EYE_HEIGHT.stand, 0.2, 'A new life returns to the eye');
});

const motionFrame = (changes: Partial<MotionFrame> = {}): MotionFrame => ({
  dt: 1 / 60, grounded: true, vy: 0, posture: 'stand', sprinting: false, aimWanted: false, wallDistance: 20, adsMs: 240, steadyAim: false, ...changes,
});

test('aiming down sights takes the weapon aim time, 20% less with Steady Aim, and never while sprinting or against a wall', () => {
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

test('landings, slides and vaults are read from the predicted body once each', () => {
  const motion = new FirstPersonMotion();
  assert.equal(motion.update(motionFrame({ grounded: false, vy: 3 })).landed, 0);
  motion.update(motionFrame({ grounded: false, vy: -6 })); motion.update(motionFrame({ grounded: false, vy: -8 }));
  assert.equal(motion.update(motionFrame()).landed, 8, 'The fastest fall speed of the jump');
  assert.equal(motion.update(motionFrame()).landed, 0);
  motion.update(motionFrame({ grounded: false, vy: -1.5 }));
  assert.equal(motion.update(motionFrame()).landed, 0, 'A small hop is not a landing');
  assert.equal(motion.update(motionFrame({ posture: 'slide' })).slide, true);
  assert.equal(motion.update(motionFrame({ posture: 'slide' })).slide, false);
  assert.equal(motion.update(motionFrame({ posture: 'vault' })).vault, true);
  motion.reset('vault');
  assert.equal(motion.update(motionFrame({ posture: 'vault' })).vault, false, 'A respawn mid-vault does not replay it');
});

test('flinch kicks the view up by the damage, 40% less with Steady Aim; blasts shake and flash by distance', () => {
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
