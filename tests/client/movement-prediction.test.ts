import assert from 'node:assert/strict';
import test from 'node:test';
import { MatchEngine, idleInput } from '../../server/engine';
import { movePlayer, type KinematicState } from '../../shared/physics';
import type { InputFrame } from '../../shared/protocol';
import { MovementPrediction } from '../../src/game/MovementPrediction';

type Action = 'ar-reload' | 'shotgun-reload' | 'heal' | 'none';
const motionKeys = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'yaw', 'pitch'] as const;
const motion = (player: KinematicState): KinematicState => Object.fromEntries(motionKeys.map(key => [key, player[key]])) as unknown as KinematicState;

function playing(action: Action = 'none') {
  const engine = new MatchEngine();
  const player = engine.addPlayer({ id: 'dad', name: 'Dad', color: '#ffffff' }, 0);
  engine.addPlayer({ id: 'son', name: 'Son', color: '#44bbbb' }, 0);
  engine.start(0); engine.step(3_000, 0);
  Object.assign(player, { x: -28, y: 0, z: 12, health: 60, ammoAR: 20, ammoShotgun: 4, protectedUntil: 0 });
  const slot = action === 'heal' ? 3 : action === 'shotgun-reload' ? 2 : 1;
  engine.acceptInput(player.id, { ...idleInput(1), slot, reload: action.endsWith('reload'), fire: action === 'heal' }, 3_100);
  engine.step(3_100, 0);
  return { engine, player, now: 3_100, seq: 1 };
}

function predict(fixture: ReturnType<typeof playing>) {
  const helper = new MovementPrediction();
  const snapshot = Object.freeze(structuredClone(fixture.player));
  helper.reset(snapshot, fixture.now);
  return { helper, state: motion(snapshot) };
}

function step(fixture: ReturnType<typeof playing>, prediction: ReturnType<typeof predict>, changes: Partial<InputFrame> = {}, dt = 1 / 30) {
  const input = Object.freeze({ ...idleInput(++fixture.seq), slot: fixture.player.slot, moveZ: 1, sprint: true, ...changes });
  fixture.now += dt * 1_000;
  assert.equal(fixture.engine.acceptInput(fixture.player.id, input, fixture.now), true);
  fixture.engine.step(fixture.now, dt);
  const sprinting = prediction.helper.step(prediction.state, input, dt);
  for (const key of motionKeys) assert.ok(Math.abs(prediction.state[key] - fixture.player[key]) < 1e-9,
    `${key}: prediction ${prediction.state[key]} must match actual engine ${fixture.player[key]}`);
  return sprinting;
}

test('confirmed AR/shotgun reloads and healing fix the old 9-versus-6.5 m/s prediction mismatch', () => {
  for (const action of ['ar-reload', 'shotgun-reload', 'heal'] as const) {
    const fixture = playing(action), prediction = predict(fixture);
    const oldPrediction = motion(fixture.player);
    const oldInput = { ...idleInput(2), slot: fixture.player.slot, moveZ: 1, sprint: true };
    movePlayer(oldPrediction, oldInput, 1 / 30);
    assert.equal(step(fixture, prediction), false, 'Limited movement must not request the sprint FOV');
    assert.equal(Math.hypot(fixture.player.vx, fixture.player.vz), 6.5);
    assert.equal(Math.hypot(oldPrediction.vx, oldPrediction.vz), 9);
    assert.ok(Math.abs(oldPrediction.z - fixture.player.z) > .08, 'The regression recreates the previous excess movement');
    for (let index = 0; index < 8; index++) assert.equal(step(fixture, prediction), false);
  }
});

test('ordinary walking, sprinting, aiming and analog speeds retain actual server movement', () => {
  for (const [changes, speed, sprinting] of [
    [{ sprint: false }, 6.5, false],
    [{ sprint: true }, 9, true],
    [{ aim: true, sprint: true }, 4, false],
    [{ moveZ: .25, sprint: false }, 1.625, false],
  ] as const) {
    const fixture = playing(), prediction = predict(fixture);
    assert.equal(step(fixture, prediction, changes), sprinting);
    assert.equal(Math.hypot(prediction.state.vx, prediction.state.vz), speed);
  }
  for (const action of ['ar-reload', 'shotgun-reload', 'heal'] as const) {
    const fixture = playing(action), prediction = predict(fixture);
    assert.equal(step(fixture, prediction, { aim: true }), false);
    assert.equal(Math.hypot(prediction.state.vx, prediction.state.vz), 4, 'Aim still takes precedence over movement speed');
  }
});

test('the first movement step reaching or passing an action deadline stays limited, then sprint resumes', () => {
  for (const action of ['ar-reload', 'shotgun-reload', 'heal'] as const) for (const crossingDt of [.001, .002]) {
    const fixture = playing(action);
    const deadline = fixture.player.healingUntil || fixture.player.reloadingUntil;
    fixture.now = deadline - 1;
    fixture.engine.step(fixture.now, 0);
    const prediction = predict(fixture);
    assert.equal(step(fixture, prediction, {}, crossingDt), false, 'Expiry happens after this tick moves');
    assert.equal(fixture.player.healingUntil, 0); assert.equal(fixture.player.reloadingUntil, 0);
    assert.equal(Math.hypot(prediction.state.vx, prediction.state.vz), 6.5);
    assert.equal(step(fixture, prediction, {}, .001), true, 'The next tick can sprint without waiting indefinitely for another snapshot');
    assert.equal(Math.hypot(prediction.state.vx, prediction.state.vz), 9);
  }
});

test('switching weapons cancels known movement locks before moving and switching back cannot resurrect them', () => {
  for (const action of ['ar-reload', 'shotgun-reload', 'heal'] as const) {
    const fixture = playing(action), prediction = predict(fixture);
    const initialSlot = fixture.player.slot;
    assert.equal(step(fixture, prediction, { slot: initialSlot === 1 ? 2 : 1 }), true);
    assert.equal(fixture.player.healingUntil, 0); assert.equal(fixture.player.reloadingUntil, 0);
    assert.equal(step(fixture, prediction, { slot: initialSlot }), true);
    assert.equal(Math.hypot(prediction.state.vx, prediction.state.vz), 9);
  }
});

test('new action starts remain authoritative and begin limiting movement after their accepted snapshot', () => {
  for (const action of ['ar-reload', 'shotgun-reload', 'heal'] as const) {
    const fixture = playing(), prediction = predict(fixture);
    const slot = action === 'heal' ? 3 : action === 'shotgun-reload' ? 2 : 1;
    assert.equal(step(fixture, prediction, { slot, fire: action === 'heal', reload: action.endsWith('reload') }), true,
      'The server moves before it starts an action; prediction must not start a lock early');
    assert.ok(fixture.player.healingUntil || fixture.player.reloadingUntil);
    prediction.helper.reset(Object.freeze(structuredClone(fixture.player)), fixture.now);
    assert.equal(step(fixture, prediction, { slot }), false);
    assert.equal(Math.hypot(prediction.state.vx, prediction.state.vz), 6.5);
  }
  const fixture = playing(), prediction = predict(fixture);
  fixture.player.health = 100; fixture.player.ammoAR = 30;
  assert.equal(step(fixture, prediction, { reload: true }), true);
  assert.equal(step(fixture, prediction, { slot: 3, fire: true }), true);
  assert.equal(fixture.player.healingUntil, 0); assert.equal(fixture.player.reloadingUntil, 0);
});

test('pending replay and subsequent frame steps use the snapshot timeline across expiry and authoritative reset', () => {
  const fixture = playing('ar-reload');
  fixture.now = fixture.player.reloadingUntil - 90;
  fixture.engine.step(fixture.now, 0);
  const prediction = predict(fixture);
  // Pending frames are replayed in assumed 30 Hz tick order, even though this
  // test (like delayed browser delivery) runs long after their server timestamp.
  assert.equal(step(fixture, prediction), false);
  assert.equal(step(fixture, prediction), false);
  assert.equal(step(fixture, prediction), false, 'The third pending tick crosses the deadline but is still limited');
  assert.equal(step(fixture, prediction, {}, 1 / 60), true, 'The following render frame continues the same clock');

  // A later authoritative snapshot always replaces speculative local lock/time
  // state, including cancellation/recovery; no lock from an old life survives.
  const healing = playing('heal');
  prediction.helper.reset(healing.player, healing.now);
  Object.assign(prediction.state, motion(healing.player));
  assert.equal(step(healing, prediction), false);
  healing.engine.setConnected(healing.player.id, false);
  healing.engine.addPlayer({ id: healing.player.id, name: 'Dad', color: '#ffffff' }, healing.now + 100);
  healing.now += 100; healing.seq = 0;
  prediction.helper.reset(healing.player, healing.now);
  Object.assign(prediction.state, motion(healing.player));
  assert.equal(step(healing, prediction), true);
});
