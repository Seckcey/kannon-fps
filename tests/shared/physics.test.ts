import test from 'node:test';
import assert from 'node:assert/strict';
import { eyePosition, findVault, hitboxes, movePlayer, moveDefaults, MOVE, raycastMapDetailed, type MoveState } from '../../shared/physics.js';
import type { InputFrame } from '../../shared/protocol.js';

const frame = (patch: Partial<InputFrame> = {}): InputFrame => ({ seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, fire: false, aim: false, jump: false, sprint: false, reload: false, slot: 1, crouch: false, dash: false, melee: false, grenade: false, streak: null, viewTime: 0, ...patch });
const context = (now: number, patch: Partial<Parameters<typeof movePlayer>[2]> = {}) => ({ now, dt: 1 / 30, jumpPressed: false, crouchPressed: false, moveFactor: 1, adsFactor: 0.52, canSprint: true, ...patch });
const player = (x: number, z: number): MoveState => ({ x, y: 0, z, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, ...moveDefaults() });

test('walking accelerates to walk speed and sprinting and dashing go faster', () => {
  const state = player(0, 20); let now = 0;
  for (let i = 0; i < 15; i++) movePlayer(state, frame({ moveZ: 1, yaw: Math.PI }), context(now += 33));
  assert.ok(Math.abs(Math.hypot(state.vx, state.vz) - MOVE.walk) < 0.01);
  for (let i = 0; i < 15; i++) movePlayer(state, frame({ moveZ: 1, yaw: Math.PI, sprint: true }), context(now += 33));
  assert.ok(Math.abs(Math.hypot(state.vx, state.vz) - MOVE.sprint) < 0.01);
  for (let i = 0; i < 8; i++) movePlayer(state, frame({ moveZ: 1, yaw: Math.PI, sprint: true, dash: true }), context(now += 33));
  assert.ok(Math.abs(Math.hypot(state.vx, state.vz) - MOVE.dash) < 0.01);
  assert.ok(state.stamina < 1);
});

test('crouching while sprinting starts a slide that ends crouched', () => {
  const state = player(-7, -8); let now = 0;
  for (let i = 0; i < 20; i++) movePlayer(state, frame({ moveZ: 1, yaw: Math.PI, sprint: true }), context(now += 33));
  const events = movePlayer(state, frame({ moveZ: 1, yaw: Math.PI, sprint: true, crouch: true }), context(now += 33, { crouchPressed: true }));
  assert.equal(events.slideStarted, true); assert.equal(state.posture, 'slide');
  for (let i = 0; i < 40 && state.posture === 'slide'; i++) movePlayer(state, frame({ moveZ: 1, yaw: Math.PI, crouch: true }), context(now += 33));
  assert.equal(state.posture, 'crouch');
});

test('a low window sill can be vaulted and a solid wall cannot', () => {
  const window = findVault(player(-9.3, 2.8), frame({ moveZ: 1, yaw: -Math.PI / 2 }), 0);
  assert.ok(window && window.toX < -10.2, 'vaults through the teal front window');
  assert.equal(findVault(player(-9.3, -4.5), frame({ moveZ: 1, yaw: -Math.PI / 2 }), 0), null);
});

test('hitboxes, eye height and detailed rays follow posture and map', () => {
  assert.equal(eyePosition({ x: 0, y: 0, z: 0, posture: 'crouch' }).y, 1.12);
  assert.deepEqual(hitboxes({ x: 0, y: 0, z: 0, posture: 'stand' }).map(box => box.zone), ['head', 'torso', 'legs']);
  const hit = raycastMapDetailed({ x: 0, y: 1.5, z: 0 }, { x: -1, y: 0, z: 0 }, 50);
  assert.equal(hit?.obstacle?.id, 'school-bus-body'); assert.equal(hit?.surface, 'metal'); assert.deepEqual(hit?.normal, { x: 1, y: 0, z: 0 });
});
