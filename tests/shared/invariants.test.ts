import test from 'node:test';
import assert from 'node:assert/strict';
import { MOVE, movePlayer, PLAYER_RADIUS, POSTURE_HEIGHT, spaceFree, type MoveState } from '../../shared/physics.js';
import { ARENA_LIMITS } from '../../shared/map.js';
import type { InputFrame } from '../../shared/protocol.js';
import { Driver, FACE, player, random, snapshotOf } from './support.js';

/** The room a posture's body must always have. A slide must always be able to rise into a crouch. */
const clearance = (state: MoveState) => (state.posture === 'slide' ? POSTURE_HEIGHT.crouch : POSTURE_HEIGHT[state.posture]);

function checkState(state: MoveState, label: string) {
  const fail = (problem: string) => assert.fail(`${label}: ${problem} in ${JSON.stringify(state)}`);
  for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'yaw', 'pitch', 'stamina', 'slideUntil', 'slideCooldownUntil'] as const) {
    if (!Number.isFinite(state[key])) fail(`${key} is ${state[key]}`);
  }
  if (Math.abs(state.x) > ARENA_LIMITS.x - PLAYER_RADIUS + 1e-9 || Math.abs(state.z) > ARENA_LIMITS.z - PLAYER_RADIUS + 1e-9) fail('left the arena');
  if (state.y < 0) fail('below the ground');
  if ((state.posture === 'vault') !== (state.vault !== null)) fail('posture and vault record disagree');
  if (state.vault) {
    // A vault's position is scripted (its velocity only drives animation): it may only carry the body
    // a short way, at most the reach plus a thin wall and a body length, plus the sideways steering.
    const travel = Math.hypot(state.vault.toX - state.vault.fromX, state.vault.toZ - state.vault.fromZ);
    if (travel > 2.8) fail(`a vault carries the body ${travel.toFixed(2)} m`);
    return;
  }
  if (Math.hypot(state.vx, state.vz) > MOVE.slideSpeed + 1e-6) fail(`overspeed ${Math.hypot(state.vx, state.vz)}`);
  // Every posture but the scripted vault must fit where it is.
  if (!spaceFree(state, clearance(state))) fail(`${state.posture} body inside the map`);
}

/** A random start that a standing body fits (some stair offsets would be inside the kitchen counter). */
function fitting(make: () => MoveState): MoveState {
  for (let attempt = 0; attempt < 100; attempt++) { const state = make(); if (spaceFree(state, POSTURE_HEIGHT.stand)) return state; }
  throw new Error('no free start found');
}

/** Starting points that put random play near stairs, windows, rails, fences, cover and vehicles. */
function starts(rand: () => number): Array<{ state: MoveState; yaw: number }> {
  const list: Array<{ state: MoveState; yaw: number }> = [];
  for (const side of [-1, 1]) {
    const toHouse = side < 0 ? FACE.west : FACE.east;
    // Inside and outside stairs, anywhere across their width (the inside ones run under the upstairs floor edges).
    for (const u of [19, 24.35]) list.push({ state: fitting(() => player(side * (u + (rand() * 2 - 1) * 1.25), -5.05)), yaw: FACE.south });
    list.push({ state: player(side * 17.75, -5.05), yaw: FACE.south });
    list.push({ state: fitting(() => player(side * 9.3, 1.2 + rand() * 3.3)), yaw: toHouse });
    list.push({ state: player(side * 24.5, -11.6), yaw: FACE.south });
    list.push({ state: player(side * 24, 4.4, { y: 3.2 }), yaw: side < 0 ? FACE.west : FACE.east });
    list.push({ state: player(side * 15, 0, { y: 3.2 }), yaw: rand() * Math.PI * 2 });
  }
  list.push({ state: player(-6.6, 2), yaw: FACE.south }, { state: player(6.6, -2), yaw: FACE.north });
  list.push({ state: player(-4.8, -10), yaw: FACE.north }, { state: player(-2.4, -13), yaw: FACE.south });
  list.push({ state: player(2.65, 11.5), yaw: FACE.north }, { state: player(-7, -6), yaw: FACE.north });
  return list;
}

/** Random play: held segments of movement with frequent sprint, dash, crouch and jump presses. */
function play(rand: () => number, run: Driver, yaw: number, ticks: number, label: string) {
  let held: Partial<InputFrame> = {}, left = 0;
  for (let tick = 0; tick < ticks; tick++) {
    if (left-- <= 0) {
      left = 3 + Math.floor(rand() * 25);
      const sprint = rand() < 0.6;
      held = {
        moveZ: [1, 1, 1, 1, 0.5, 0, -1][Math.floor(rand() * 7)]!, moveX: [0, 0, 0, 0.5, -0.5, 1, -1][Math.floor(rand() * 7)]!,
        sprint, dash: sprint && rand() < 0.35, aim: rand() < 0.1, fire: rand() < 0.1,
        crouch: rand() < 0.3, jump: rand() < 0.2,
      };
      if (rand() < 0.3) yaw = [FACE.north, FACE.east, FACE.south, FACE.west][Math.floor(rand() * 4)]!;
    }
    yaw += (rand() * 2 - 1) * 0.08;
    // Taps: rising edges for crouch (slides, cancels) and jump (jumps, vaults) in the middle of segments.
    if (rand() < 0.12) held = { ...held, crouch: !held.crouch };
    if (rand() < 0.12) held = { ...held, jump: !held.jump };
    run.step({ ...held, yaw });
    checkState(run.state, `${label} tick ${tick}`);
  }
}

test('random play never leaves a body inside the map, outside the arena, too fast or in a stale vault', () => {
  const rand = random(20261030);
  let runs = 0;
  for (let round = 0; round < 6; round++) for (const { state, yaw } of starts(rand)) {
    checkState(state, `start ${runs}`);
    play(rand, new Driver(state), yaw, 240, `run ${runs++} from ${state.x.toFixed(2)}, ${state.y}, ${state.z.toFixed(2)}`);
  }
  assert.ok(runs >= 100);
});

test('prediction from rounded snapshots rarely drifts during random play', (t) => {
  // Replays 15 ticks (0.5 s) from rounded snapshots, as a client does after each server correction.
  const rand = random(7077), horizon = 15;
  let windows = 0, drifted = 0;
  for (let round = 0; round < 2; round++) for (const { state, yaw } of starts(rand)) {
    const run = new Driver(state);
    play(rand, run, yaw, 240, `parity run from ${state.x.toFixed(2)}, ${state.z.toFixed(2)}`);
    for (let from = 0; from + horizon < run.log.length; from += 3) {
      const predicted = snapshotOf(run.log[from]!.after);
      for (let i = from + 1; i <= from + horizon; i++) movePlayer(predicted, run.log[i]!.input, run.log[i]!.ctx);
      const actual = run.log[from + horizon]!.after;
      windows++;
      if (Math.hypot(predicted.x - actual.x, predicted.y - actual.y, predicted.z - actual.z) > 0.01 || predicted.posture !== actual.posture) drifted++;
    }
  }
  t.diagnostic(`${drifted} of ${windows} replays drifted more than 1 cm`);
  // Rounding can tip a decision that sits exactly on an edge (a step corner, a lintel). Anything systematic,
  // such as walking through a wall the body rested against (once about 8% of replays), shows up as many more.
  assert.ok(drifted / windows < 0.01, `${drifted} of ${windows} replays drifted`);
});
