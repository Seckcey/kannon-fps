import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine, idleInput, sanitizeInput } from '../../server/engine.js';
import { cameraPosition, directionFromAngles, movePlayer, raycastMap } from '../../shared/physics.js';
import { RULES, type GameEvent, type InputFrame, type PlayerState } from '../../shared/protocol.js';

function playing() {
  const events: GameEvent[] = []; const engine = new MatchEngine({ onEvent: (e) => events.push(e) });
  const a = engine.addPlayer({ id: 'a', name: 'Dad', color: '#ffffff' }, 0);
  const b = engine.addPlayer({ id: 'b', name: 'Kannon', color: '#ffffff' }, 0);
  engine.start(0); engine.step(3000, 1 / 30);
  a.protectedUntil = 0; b.protectedUntil = 0;
  return { engine, a, b, events };
}
function input(overrides: Partial<InputFrame> = {}): InputFrame { return { ...idleInput(1), ...overrides }; }
function aimAt(shooter: PlayerState, target: PlayerState) {
  let yaw = Math.atan2(target.x - shooter.x, -(target.z - shooter.z)); let pitch = 0;
  for (let i = 0; i < 20; i++) {
    const eye = cameraPosition(shooter, yaw, pitch, true);
    const dx = target.x - eye.x, dz = target.z - eye.z;
    yaw = Math.atan2(dx, -dz); pitch = Math.atan2(target.y + 1.2 - eye.y, Math.hypot(dx, dz));
  }
  return { yaw, pitch, aim: true };
}
test('input rejects malformed values and clamps movement/view without trusting client positions', () => {
  assert.equal(sanitizeInput({ ...input(), yaw: NaN }), null);
  assert.equal(sanitizeInput({ ...input(), fire: 'yes' }), null);
  assert.equal(sanitizeInput({ ...input(), seq: 1.5 }), null);
  assert.equal(sanitizeInput({ ...input(), slot: 9 }), null);
  const clean = sanitizeInput({ ...input(), moveX: 1000, moveZ: -500, pitch: 500, yaw: 500, x: 100000 });
  assert.ok(clean); assert.equal(clean.moveX, 1); assert.equal(clean.moveZ, -1); assert.equal(clean.pitch, 1.3);
  assert.ok(Math.abs(clean.yaw) <= Math.PI * 2); assert.equal('x' in clean, false);
});
test('movement normalizes diagonal speed, blocks walls, stays within arena and supports steps', () => {
  const state = { x: -28, y: 0, z: 25, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0 };
  movePlayer(state, input({ moveX: 1, moveZ: 1 }), 0.1);
  assert.ok(Math.abs(Math.hypot(state.vx, state.vz) - 6.5) < 1e-6);
  Object.assign(state, { x: -25, z: 0 });
  for (let i = 0; i < 100; i++) movePlayer(state, input({ moveX: 1 }), 1 / 30);
  assert.ok(state.x < -23.3, 'west block must prevent walking through');
  for (let i = 0; i < 500; i++) movePlayer(state, input({ moveX: -1, sprint: true }), 1 / 30);
  assert.ok(state.x >= -31.58);
  Object.assign(state, { x: 0, y: 0, z: 8, vy: 0 });
  for (let i = 0; i < 35; i++) movePlayer(state, input({ moveZ: -1 }), 1 / 30);
  assert.ok(state.y >= 1.9, `stairs should reach platform, got ${state.y}`);
});
test('jump requires a fresh press and stale input stops movement', () => {
  const { engine, a } = playing();
  Object.assign(a, { x: -28, y: 0, z: 25 });
  engine.acceptInput('a', input({ moveZ: 1, jump: true }), 3100); engine.step(3100, 1 / 30);
  assert.ok(a.vy > 0); assert.equal(a.lastInputSeq, 1);
  engine.step(3500, 1 / 30); assert.equal(a.vx, 0); assert.equal(a.vz, 0);
  assert.equal(engine.acceptInput('a', input({ seq: 1 }), 3500), false);
});
test('healing consumes one charge, completes after three seconds, and damage cancels it', () => {
  const { engine, a, b, events } = playing(); a.health = 25; a.shield = 0;
  engine.acceptInput('a', input({ slot: 3, fire: true }), 3100); engine.step(3100, 1 / 30);
  assert.equal(a.heals, 1); assert.equal(a.healingUntil, 6100);
  engine.step(6099, 1 / 30); assert.equal(a.health, 25);
  engine.step(6100, 1 / 30); assert.equal(a.health, 75); assert.equal(a.healingUntil, 0);
  assert.ok(events.some((e) => e.type === 'heal' && e.amount === 50));
  engine.acceptInput('a', input({ seq: 2, slot: 3, fire: false }), 6200); engine.step(6200, 1 / 30);
  engine.acceptInput('a', input({ seq: 3, slot: 3, fire: true }), 6300); engine.step(6300, 1 / 30);
  assert.equal(a.heals, 0); engine.damage(a, b, 10, 6400); assert.equal(a.healingUntil, 0);
  engine.step(9500, 1 / 30); assert.equal(a.health, 65);
});
test('firing or switching away cancels healing and removes spawn protection', () => {
  const { engine, a } = playing(); a.health = 50; a.protectedUntil = 10_000;
  engine.acceptInput('a', input({ slot: 3, fire: true }), 3100); engine.step(3100, 1 / 30);
  assert.ok(a.healingUntil);
  engine.acceptInput('a', input({ seq: 2, slot: 1, fire: true }), 3200); engine.step(3200, 1 / 30);
  assert.equal(a.healingUntil, 0); assert.equal(a.protectedUntil, 0); assert.equal(a.ammoAR, 29);
});
test('authoritative hits respect cadence, shields, reload timers, and wall occlusion', () => {
  const { engine, a, b, events } = playing();
  Object.assign(a, { x: -28, y: 0, z: 12 }); Object.assign(b, { x: -28, y: 0, z: -2 });
  let seq = 1;
  const shot = (now: number) => { engine.acceptInput('a', input({ seq: seq++, fire: true, ...aimAt(a, b) }), now); engine.step(now, 1 / 30); };
  shot(3100); assert.equal(b.shield, 26); assert.equal(a.ammoAR, 29);
  shot(3200); assert.equal(b.shield, 26); assert.equal(a.ammoAR, 29);
  shot(3250); assert.equal(b.shield, 2);
  shot(3400); assert.equal(b.shield, 0); assert.equal(b.health, 78);
  assert.ok(events.some((e) => e.type === 'shot' && e.hit));
  engine.acceptInput('a', input({ seq: seq++, reload: true }), 3500); engine.step(3500, 1 / 30);
  assert.equal(a.reloadingUntil, 5300); engine.step(5299, 1 / 30); assert.equal(a.ammoAR, 27);
  engine.step(5300, 1 / 30); assert.equal(a.ammoAR, 30);
  Object.assign(a, { x: -28, z: 0 }); Object.assign(b, { x: -10, z: 0, shield: 50, health: 100 });
  shot(6000); assert.equal(b.shield, 50); assert.equal(b.health, 100);
});
test('shotgun has close-range punch and server-owned cooldown', () => {
  const { engine, a, b } = playing();
  Object.assign(a, { x: -28, y: 0, z: 12 }); Object.assign(b, { x: -28, y: 0, z: 7 });
  engine.acceptInput('a', input({ fire: true, slot: 2, ...aimAt(a, b) }), 3100); engine.step(3100, 1 / 30);
  assert.equal(a.ammoShotgun, 5); assert.equal(b.shield, 0); assert.equal(b.health, 78);
  engine.acceptInput('a', input({ seq: 2, fire: true, slot: 2, ...aimAt(a, b) }), 3200); engine.step(3200, 1 / 30);
  assert.equal(a.ammoShotgun, 5);
});
test('elimination respawns in three seconds with fixed loadout and protection; score limit ends match', () => {
  const { engine, a, b } = playing();
  engine.damage(b, a, 150, 3100); assert.equal(b.health, 0); assert.equal(b.respawnAt, 6100); assert.equal(a.kills, 1); assert.equal(b.deaths, 1);
  engine.step(6099, 1 / 30); assert.equal(b.health, 0);
  engine.step(6100, 1 / 30); assert.equal(b.health, 100); assert.equal(b.shield, 50); assert.equal(b.heals, 2); assert.equal(b.slot, 1);
  assert.equal(b.ammoAR, 30); assert.equal(b.ammoShotgun, 6); assert.equal(b.protectedUntil, 8100);
  engine.damage(b, a, 150, 7000); assert.equal(b.health, 100);
  a.kills = 14; engine.damage(b, a, 150, 8100); assert.equal(engine.phase, 'finished'); assert.deepEqual(engine.winnerIds, ['a']);
});
test('match timer and reconnect sequence reset remain authoritative', () => {
  const { engine, a } = playing();
  engine.acceptInput('a', input({ seq: 100 }), 3100); engine.step(3100, 1 / 30);
  engine.setConnected('a', false); engine.addPlayer({ id: 'a', name: 'Dad', color: '#ffffff' }, 3200);
  assert.equal(a.lastInputSeq, 0); assert.equal(engine.acceptInput('a', input({ seq: 1 }), 3200), true);
  engine.step(3000 + RULES.matchSeconds * 1000, 1 / 30); assert.equal(engine.phase, 'finished'); assert.deepEqual(engine.winnerIds, ['a', 'b']);
});
test('camera is clipped against shared map geometry', () => {
  const player = { x: -13.5, y: 0, z: 0 }; const camera = cameraPosition(player, Math.PI / 2, 0, false);
  assert.ok(camera.x > -15, 'camera must stop in front of west wall');
  assert.ok(raycastMap({ x: -28, y: 1, z: 0 }, directionFromAngles(Math.PI / 2, 0), 100) < 6);
});
test('stale or disconnected fire cannot continue shooting, and server stalls cannot teleport players', () => {
  const { engine, a, b } = playing();
  Object.assign(a, { x: -28, y: 0, z: 12 }); Object.assign(b, { x: -28, y: 0, z: -2 });
  engine.acceptInput('a', input({ fire: true, moveZ: 1, ...aimAt(a, b) }), 3100); engine.step(3100, 1 / 30);
  const ammo = a.ammoAR; const z = a.z;
  engine.step(5000, 1.9); assert.equal(a.ammoAR, ammo); assert.equal(a.z, z);
  engine.acceptInput('a', input({ seq: 2, fire: true, moveZ: 1 }), 5100); engine.step(5100, 2);
  assert.ok(Math.hypot(a.x + 28, a.z - z) <= 0.66, 'Long server stalls clamp movement delta instead of teleporting.');
  const after = a.ammoAR; engine.setConnected('a', false); engine.step(5500, 1 / 30); assert.equal(a.ammoAR, after);
});
test('shoulder camera cannot shoot through cover that blocks the muzzle', () => {
  const { engine, a, b } = playing();
  Object.assign(a, { x: -5, y: 0, z: 6 }); Object.assign(b, { x: -5, y: 0.55, z: -6 });
  engine.acceptInput('a', input({ fire: true, ...aimAt(a, b) }), 3100); engine.step(3100, 0);
  assert.equal(a.ammoAR, 29); assert.equal(b.shield, 50); assert.equal(b.health, 100);
});
test('batched press/release frames preserve one fire, jump, and reload action between ticks', () => {
  const { engine, a, b, events } = playing();
  Object.assign(a, { x: -28, y: 0, z: 12 }); Object.assign(b, { x: -28, y: 0, z: -2 });
  engine.acceptInput('a', input({ seq: 1, fire: true, ...aimAt(a, b) }), 3100);
  engine.acceptInput('a', input({ seq: 2, fire: false, ...aimAt(a, b) }), 3101);
  engine.step(3130, 1 / 30);
  assert.equal(a.ammoAR, 29); assert.equal(b.shield, 26); assert.equal(events.filter(e => e.type === 'shot').length, 1);
  engine.step(3330, 1 / 30); assert.equal(a.ammoAR, 29, 'Released taps must not become held fire.');
  engine.acceptInput('a', input({ seq: 3, jump: true }), 3400);
  engine.acceptInput('a', input({ seq: 4, jump: false }), 3401);
  engine.step(3430, 1 / 30); assert.ok(a.vy > 0); assert.ok(a.y > 0);
  engine.acceptInput('a', input({ seq: 5, reload: true }), 3500);
  engine.acceptInput('a', input({ seq: 6, reload: false }), 3501);
  engine.step(3530, 1 / 30); assert.equal(a.reloadingUntil, 3530 + RULES.arReloadMs);
  engine.step(3530 + RULES.arReloadMs, 1 / 30); assert.equal(a.ammoAR, 30);
});
test('queued fire preserves its weapon and view while later movement and weapon selection remain current', () => {
  const { engine, a, b, events } = playing();
  Object.assign(a, { x: -28, y: 0, z: 12 }); Object.assign(b, { x: -28, y: 0, z: -2 });
  engine.acceptInput('a', input({ seq: 1, fire: true, slot: 1, ...aimAt(a, b) }), 3100);
  engine.acceptInput('a', input({ seq: 2, fire: false, slot: 2, yaw: Math.PI, pitch: 0.4 }), 3101);
  engine.step(3130, 0);
  assert.equal(a.slot, 2); assert.equal(a.yaw, Math.PI); assert.equal(a.pitch, 0.4);
  assert.equal(a.ammoAR, 29); assert.equal(a.ammoShotgun, 6); assert.equal(b.shield, 26);
  const shot = events.find(e => e.type === 'shot'); assert.ok(shot && shot.type === 'shot'); assert.equal(shot.slot, 1);
  a.health = 50;
  engine.acceptInput('a', input({ seq: 3, fire: true, slot: 3 }), 3400);
  engine.acceptInput('a', input({ seq: 4, fire: false, slot: 1 }), 3401);
  engine.step(3430, 0);
  assert.equal(a.ammoAR, 29, 'A healing press cannot become gunfire after a later slot change.');
  assert.equal(a.heals, 2); assert.equal(a.healingUntil, 0, 'Switching away cancels the queued heal.');
  engine.acceptInput('a', input({ seq: 5, fire: true, slot: 3 }), 3500);
  engine.acceptInput('a', input({ seq: 6, fire: false, slot: 3 }), 3501);
  engine.step(3530, 0); assert.equal(a.heals, 1); assert.equal(a.healingUntil, 6530);
});
test('queued presses remain bounded by cooldown, duplicate sequence rejection, input expiry, and disconnects', () => {
  const { engine, a, events } = playing(); let seq = 1;
  const tap = (now: number) => {
    engine.acceptInput('a', input({ seq: seq++, fire: true }), now);
    engine.acceptInput('a', input({ seq: seq++, fire: false }), now + 1);
  };
  for (let i = 0; i < 8; i++) tap(3100 + i * 2);
  engine.step(3130, 0); assert.equal(a.ammoAR, 29); assert.equal(events.filter(e => e.type === 'shot').length, 1);
  tap(3150); engine.step(3160, 0); assert.equal(a.ammoAR, 29, 'Press edges cannot bypass the weapon cooldown.');
  engine.acceptInput('a', input({ seq, fire: false }), 3300);
  assert.equal(engine.acceptInput('a', input({ seq, fire: true }), 3301), false);
  engine.step(3330, 0); assert.equal(a.ammoAR, 29, 'Rejected duplicate input cannot enqueue an action.');
  seq++; tap(3400); engine.step(3800, 0); assert.equal(a.ammoAR, 29, 'Old queued actions expire.');
  tap(3900); engine.setConnected('a', false); engine.step(3930, 0); assert.equal(a.ammoAR, 29);
  engine.addPlayer({ id: 'a', name: 'Dad', color: '#ffffff' }, 4000); engine.step(4030, 0); assert.equal(a.ammoAR, 29, 'Recovery cannot resurrect a disconnected tap.');
});
test('batched shot cannot bypass a reload by switching slots, and held AR still repeats at its cadence', () => {
  const { engine, a } = playing(); a.ammoAR = 20;
  engine.acceptInput('a', input({ seq: 1, reload: true }), 3100); engine.step(3100, 0);
  engine.acceptInput('a', input({ seq: 2, fire: true, slot: 1 }), 3200);
  engine.acceptInput('a', input({ seq: 3, fire: false, slot: 2 }), 3201); engine.step(3230, 0);
  assert.equal(a.ammoAR, 20, 'Switching cannot validate a shot that was queued while the AR was reloading.');
  engine.acceptInput('a', input({ seq: 4, fire: true, slot: 1 }), 3400); engine.step(3400, 0); assert.equal(a.ammoAR, 19);
  engine.acceptInput('a', input({ seq: 5, fire: true, slot: 1 }), 3550); engine.step(3550, 0); assert.equal(a.ammoAR, 18);
  engine.acceptInput('a', input({ seq: 6, fire: true, slot: 1 }), 3700); engine.step(3700, 0); assert.equal(a.ammoAR, 17);
});
