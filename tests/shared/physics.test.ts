import test from 'node:test';
import assert from 'node:assert/strict';
import { EYE_HEIGHT, eyePosition, findVault, hitboxes, movePlayer, moveDefaults, MOVE, POSTURE_HEIGHT, rayHitboxes, raycastMapDetailed, weaponMuzzle, type MoveState } from '../../shared/physics.js';
import type { InputFrame } from '../../shared/protocol.js';

const frame = (patch: Partial<InputFrame> = {}): InputFrame => ({ seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, fire: false, aim: false, jump: false, sprint: false, reload: false, slot: 1, crouch: false, dash: false, melee: false, grenade: false, streak: null, viewTime: 0, ...patch });
const context = (now: number, patch: Partial<Parameters<typeof movePlayer>[2]> = {}) => ({ now, dt: 1 / 30, jumpPressed: false, crouchPressed: false, moveFactor: 1, adsFactor: 0.52, canSprint: true, ...patch });
const player = (x: number, z: number): MoveState => ({ x, y: 0, z, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, ...moveDefaults() });

test('walking accelerates to walk speed and sprinting and dashing go faster', () => {
  // An open lane heading south (the arena edge stops a player, so start well inside it).
  const state = player(-9, -20); let now = 0;
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

test('crouching and sliding lower the hitboxes; the eye sits in the head box in every posture', () => {
  for (const posture of ['stand', 'crouch', 'slide', 'vault'] as const) {
    const [head, torso, legs] = hitboxes({ x: 2, y: 0.36, z: -3, posture });
    assert.deepEqual([head!.zone, torso!.zone, legs!.zone], ['head', 'torso', 'legs']);
    assert.ok(Math.abs(head!.max.y - (0.36 + POSTURE_HEIGHT[posture])) < 1e-9, `${posture}: head top is the body top`);
    assert.equal(legs!.min.y, 0.36);
    assert.ok(head!.min.y === torso!.max.y && torso!.min.y === legs!.max.y, `${posture}: zones stack`);
    const eye = eyePosition({ x: 2, y: 0.36, z: -3, posture });
    assert.ok(eye.y > head!.min.y && eye.y < head!.max.y, `${posture}: eye inside the head box`);
    assert.ok(Math.abs(eye.y - 0.36 - EYE_HEIGHT[posture]) < 1e-12);
  }
  const stand = hitboxes({ x: 0, y: 0, z: 0, posture: 'stand' })[0]!, crouch = hitboxes({ x: 0, y: 0, z: 0, posture: 'crouch' })[0]!, slide = hitboxes({ x: 0, y: 0, z: 0, posture: 'slide' })[0]!;
  assert.ok(stand.min.y > crouch.min.y && crouch.min.y > slide.min.y);
  // A ray at standing head height passes over a crouched player.
  assert.equal(rayHitboxes({ x: -5, y: 1.6, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0, posture: 'crouch' }, 20), null);
  assert.equal(rayHitboxes({ x: -5, y: 1.6, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0, posture: 'stand' }, 20)?.zone, 'head');
});

test('the cosmetic muzzle never sits inside a wall', () => {
  // Pressed against the teal front wall, looking into it at several angles.
  for (const yaw of [-Math.PI / 2, -Math.PI / 2 + 0.7, -Math.PI / 2 - 0.7]) for (const pitch of [-0.6, 0, 0.6]) {
    const eye = { x: -9.44, y: 1.62, z: -4.5 };
    const muzzle = weaponMuzzle(eye, yaw, pitch);
    assert.ok(muzzle.x > -9.86, `muzzle at ${muzzle.x.toFixed(3)} for yaw ${yaw.toFixed(2)} pitch ${pitch}`);
  }
  // In the open it sits ahead, right and below the eye.
  const open = weaponMuzzle({ x: -7, y: 1.62, z: 0 }, 0, 0);
  assert.ok(open.z < -0.5 && open.x > -7 && open.y < 1.62);
});

test('hitboxes, eye height and detailed rays follow posture and map', () => {
  assert.equal(eyePosition({ x: 0, y: 0, z: 0, posture: 'crouch' }).y, 1.12);
  assert.deepEqual(hitboxes({ x: 0, y: 0, z: 0, posture: 'stand' }).map(box => box.zone), ['head', 'torso', 'legs']);
  const hit = raycastMapDetailed({ x: 0, y: 1.5, z: 0 }, { x: -1, y: 0, z: 0 }, 50);
  assert.equal(hit?.obstacle?.id, 'school-bus-body'); assert.equal(hit?.surface, 'metal'); assert.deepEqual(hit?.normal, { x: 1, y: 0, z: 0 });
});
