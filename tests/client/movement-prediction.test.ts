import assert from 'node:assert/strict';
import test from 'node:test';
import { isPlayerGrounded, moveDefaults, movePlayer, PLAYER_RADIUS, type MoveEvents, type MoveState } from '../../shared/physics';
import { OBSTACLES } from '../../shared/map';
import { RULES, type InputFrame, type Loadout } from '../../shared/protocol';
import { LOADOUT_PRESETS, WEAPONS } from '../../shared/weapons';
import { LocalPrediction, MovementPrediction, SNAP_DISTANCE, vaultProgress, type PredictionSource } from '../../src/game/MovementPrediction';

const TICK = 1000 / 30;
const frame = (seq: number, changes: Partial<InputFrame> = {}): InputFrame => ({
  seq, moveX: 0, moveZ: 0, yaw: Math.PI, pitch: 0, fire: false, aim: false, jump: false, sprint: false, reload: false, slot: 1,
  crouch: false, dash: false, melee: false, grenade: false, streak: null, viewTime: 0, ...changes,
});

/** The server's tick as the plan describes it, written independently of the client: rising edges
 * from the previous accepted input, the equipped weapon's movement factors, no sprint while
 * cooking or knifing, and this tick's knife/grenade edges handled after moving. */
interface ServerPlayer { state: MoveState; previous: InputFrame | null; loadout: Loadout; cookingSince: number; meleeUntil: number; frags: number }
function serverTick(player: ServerPlayer, input: InputFrame, now: number): MoveEvents {
  const previous = player.previous, weapon = WEAPONS[input.slot === 1 ? player.loadout.primary : player.loadout.secondary];
  const events = movePlayer(player.state, input, {
    now, dt: 1 / 30, jumpPressed: input.jump && !previous?.jump, crouchPressed: input.crouch && !previous?.crouch,
    moveFactor: weapon.moveFactor, adsFactor: weapon.adsMoveFactor, canSprint: !player.cookingSince && now >= player.meleeUntil,
  });
  if (input.melee && !previous?.melee && now >= player.meleeUntil && !player.cookingSince) player.meleeUntil = now + RULES.meleeMs;
  if (input.grenade && !previous?.grenade && !player.cookingSince && player.frags > 0 && now >= player.meleeUntil) player.cookingSince = now;
  else if (player.cookingSince && (!input.grenade || now >= player.cookingSince + RULES.fragFuseMs)) { player.cookingSince = 0; player.frags--; }
  player.previous = input;
  return events;
}
const startState = (x: number, z: number, yaw = Math.PI): MoveState => ({ x, y: 0, z, vx: 0, vy: 0, vz: 0, yaw, pitch: 0, ...moveDefaults() });
function source(player: ServerPlayer, round = false): PredictionSource {
  const r = (value: number, digits: number) => round ? Number(value.toFixed(digits)) : value;
  const s = player.state;
  return {
    id: 'dad', name: 'Dad', color: '#ffffff', x: r(s.x, 3), y: r(s.y, 3), z: r(s.z, 3), yaw: r(s.yaw, 4), pitch: r(s.pitch, 4),
    vx: r(s.vx, 3), vy: r(s.vy, 3), vz: r(s.vz, 3), health: 100, slot: 1, weapon: player.loadout.primary, loadout: player.loadout,
    kills: 0, deaths: 0, assists: 0, score: 0, streak: 0, connected: true, respawnAt: 0, protectedUntil: 0, reloadingUntil: 0,
    posture: s.posture, vault: s.vault && round ? { ...s.vault, start: Math.round(s.vault.start), end: Math.round(s.vault.end) } : s.vault ? { ...s.vault } : null,
    slideUntil: round ? Math.round(s.slideUntil) : s.slideUntil, cookingSince: round ? Math.round(player.cookingSince) : player.cookingSince, lastInputSeq: 0,
    sprinting: s.sprinting, dashing: s.dashing, stamina: r(s.stamina, 4), slideCooldownUntil: round ? Math.round(s.slideCooldownUntil) : s.slideCooldownUntil,
    meleeUntil: round ? Math.round(player.meleeUntil) : player.meleeUntil, frags: player.frags,
  };
}
interface Run { inputs: InputFrame[]; states: Array<{ server: ServerPlayer; time: number }>; events: MoveEvents[] }
/** Drive the reference server with a script that may look at the state (deterministic). */
function run(start: MoveState, ticks: number, script: (tick: number, state: MoveState, seq: number) => InputFrame, loadout: Loadout = LOADOUT_PRESETS.assault): Run {
  const player: ServerPlayer = { state: structuredClone(start), previous: null, loadout, cookingSince: 0, meleeUntil: 0, frags: 1 };
  const result: Run = { inputs: [], states: [], events: [] };
  for (let tick = 0; tick < ticks; tick++) {
    const input = script(tick, player.state, tick + 1), time = 50_000 + (tick + 1) * TICK;
    result.events.push(serverTick(player, input, time));
    result.inputs.push(input);
    result.states.push({ server: structuredClone(player), time });
  }
  return result;
}
const MOTION = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'stamina', 'slideUntil', 'slideCooldownUntil'] as const;
function same(actual: MoveState, expected: MoveState, label: string, tolerance = 1e-9) {
  for (const key of MOTION) assert.ok(Math.abs(actual[key] - expected[key]) <= tolerance, `${label} ${key}: predicted ${actual[key]} vs server ${expected[key]}`);
  assert.equal(actual.posture, expected.posture, `${label} posture`);
  assert.equal(!!actual.sprinting, !!expected.sprinting, `${label} sprinting`);
  assert.equal(!!actual.dashing, !!expected.dashing, `${label} dashing`);
  assert.equal(!!actual.vault, !!expected.vault, `${label} vault`);
}
/** Every snapshot point, replaying every later input, must land exactly on the server. */
function assertParity(result: Run, every = 1) {
  for (let split = 0; split < result.states.length - 1; split += every) {
    const prediction = new MovementPrediction(), snapshot = result.states[split]!;
    prediction.reset(source(snapshot.server), snapshot.time, result.inputs[split]!);
    for (let tick = split + 1; tick < result.states.length; tick++) {
      prediction.step(result.inputs[tick]!);
      same(prediction.state, result.states[tick]!.server.state, `snapshot ${split} -> tick ${tick}`);
      assert.ok(Math.abs(prediction.time - result.states[tick]!.time) < 1e-6, 'The predicted clock follows the server ticks');
    }
  }
}

const barrier = OBSTACLES.find(box => box.id === 'west-lane-barrier')!;
const barrierFront = barrier.z - barrier.d / 2;
function chain() {
  let vaulted = false, slid = false;
  return run(startState(barrier.x, 0.5), 75, (tick, state, seq) => {
    if (state.vault) vaulted = true;
    if (state.posture === 'slide') slid = true;
    if (tick < 8) return frame(seq, { moveZ: 1, sprint: true });
    if (tick <= 11) return frame(seq, { moveZ: 1, sprint: true, crouch: true });
    if (tick === 12) return frame(seq, { moveZ: 1, sprint: true, jump: true });
    const close = barrierFront - state.z - PLAYER_RADIUS < 0.55;
    if (slid && !vaulted && close && isPlayerGrounded(state)) return frame(seq, { moveZ: 1, sprint: true, jump: true });
    return frame(seq, { moveZ: 1, sprint: true });
  });
}

test('the reference chain really sprints, slides, jumps out of the slide, vaults the barrier and lands', () => {
  const result = chain(), events = result.events;
  const first = (key: keyof MoveEvents) => events.findIndex(event => !!event[key]);
  assert.equal(first('slideStarted'), 8);
  assert.ok(first('jumped') === 12 && events[12]!.slideEnded, 'Jump cancels the slide');
  assert.ok(events.slice(13, first('vaultStarted')).some(event => event.landedSpeed > 0), 'The slide jump lands before the barrier');
  assert.ok(first('vaultStarted') > 12, 'A vault starts after the slide jump lands');
  assert.ok(first('vaultEnded') > first('vaultStarted'));
  assert.ok(events.slice(first('vaultEnded')).some(event => event.landedSpeed > 0), 'Dropping off the far side lands');
  const final = result.states.at(-1)!.server.state;
  assert.ok(final.z > barrier.z + barrier.d / 2 + PLAYER_RADIUS, 'The player ends beyond the barrier');
});

test('prediction replays slide, jump, vault and landing chains exactly from every snapshot', () => {
  assertParity(chain());
});

test('knifing and cooking stop the sprint from the next tick in prediction and on the server alike', () => {
  const knife = run(startState(-6, 20, Math.PI / 2), 60, (tick, _state, seq) => frame(seq, { moveZ: 1, sprint: true, melee: tick === 10, yaw: Math.PI / 2 }));
  assert.equal(knife.states[10]!.server.state.sprinting, true, 'The knife tick itself still moves at sprint speed');
  assert.equal(knife.states[11]!.server.state.sprinting, false);
  assert.ok(knife.states.slice(11, 28).every(entry => !entry.server.state.sprinting), 'No sprint for the 600 ms knife');
  assert.equal(knife.states.at(-1)!.server.state.sprinting, true, 'Sprint resumes after the knife');
  assertParity(knife, 3);
  const cook = run(startState(-6, 20, Math.PI / 2), 50, (tick, _state, seq) => frame(seq, { moveZ: 1, sprint: true, grenade: tick >= 5 && tick < 25, yaw: Math.PI / 2 }));
  assert.ok(cook.states.slice(6, 25).every(entry => !entry.server.state.sprinting), 'No sprint while cooking');
  assert.equal(cook.states.at(-1)!.server.state.sprinting, true);
  assert.equal(cook.states.at(-1)!.server.frags, 0, 'The release throws the only frag');
  assertParity(cook, 3);
});

test('the equipped weapon sets walking and aimed speeds, and a swap changes them on that tick', () => {
  for (const [loadout, aim, expected] of [
    [LOADOUT_PRESETS.marksman, true, 5 * 0.88 * 0.42], [LOADOUT_PRESETS.close, true, 5 * 1 * 0.62],
    [LOADOUT_PRESETS.assault, false, 5 * 0.95], [LOADOUT_PRESETS.marksman, false, 5 * 0.88],
  ] as const) {
    const result = run(startState(-6, 20, Math.PI / 2), 30, (_tick, _state, seq) => frame(seq, { moveZ: 1, aim, yaw: Math.PI / 2 }), loadout);
    const final = result.states.at(-1)!.server.state;
    assert.ok(Math.abs(Math.hypot(final.vx, final.vz) - expected) < 1e-9, `${loadout.primary} aim=${aim}`);
    assertParity(result, 7);
  }
  const swap = run(startState(-6, 20, Math.PI / 2), 40, (tick, _state, seq) => frame(seq, { moveZ: 1, aim: true, slot: tick >= 20 ? 2 : 1, yaw: Math.PI / 2 }), LOADOUT_PRESETS.marksman);
  const final = swap.states.at(-1)!.server.state;
  assert.ok(Math.abs(Math.hypot(final.vx, final.vz) - 5 * WEAPONS.sentry9.moveFactor * WEAPONS.sentry9.adsMoveFactor) < 1e-9);
  assertParity(swap, 5);
});

test('snapshots rounded like the wire format keep replay drift within a couple of centimetres', () => {
  const result = chain();
  for (let split = 0; split < result.states.length - 12; split += 4) {
    const prediction = new MovementPrediction(), snapshot = result.states[split]!;
    prediction.reset(source(snapshot.server, true), Math.round(snapshot.time), result.inputs[split]!);
    for (let tick = split + 1; tick <= split + 10; tick++) prediction.step(result.inputs[tick]!);
    const expected = result.states[split + 10]!.server.state;
    const drift = Math.hypot(prediction.state.x - expected.x, prediction.state.y - expected.y, prediction.state.z - expected.z);
    assert.ok(drift < 0.02, `snapshot ${split}: ${drift.toFixed(4)} m`);
  }
});

test('the acknowledged input is the edge baseline: a held jump does not jump again after reconciliation', () => {
  const result = run(startState(-6, 20, Math.PI / 2), 30, (tick, _state, seq) => frame(seq, { jump: tick >= 2, yaw: Math.PI / 2 }));
  assert.equal(result.events.filter(event => event.jumped).length, 1, 'Holding jump jumps once on the server');
  const prediction = new MovementPrediction(), snapshot = result.states[20]!;
  prediction.reset(source(snapshot.server), snapshot.time, result.inputs[20]!);
  let jumps = 0;
  for (let tick = 21; tick < 30; tick++) if (prediction.step(result.inputs[tick]!).jumped) jumps++;
  assert.equal(jumps, 0);
  assert.equal(isPlayerGrounded(snapshot.server.state), true, 'The first jump has landed by this snapshot');
  prediction.reset(source(snapshot.server), snapshot.time, null);
  assert.equal(prediction.step(result.inputs[21]!).jumped, true, 'Without the acknowledged input the held key would look like a new press');
});

const standing = (x: number, z = 20): ServerPlayer => ({ state: startState(x, z, Math.PI / 2), previous: null, loadout: LOADOUT_PRESETS.assault, cookingSince: 0, meleeUntil: 0, frags: 1 });
const live = { playing: true, alive: true, spawned: false };

test('local prediction keeps only unacknowledged inputs, and none outside live play or after a new life', () => {
  const local = new LocalPrediction();
  for (let seq = 1; seq <= 5; seq++) local.record(frame(seq, { yaw: Math.PI / 2 }));
  local.receive(source(standing(-6)), 1_000, 2, live);
  assert.deepEqual(local.pending.map(input => input.seq), [3, 4, 5]);
  local.receive(source(standing(-6)), 1_033, 3, { ...live, playing: false });
  assert.deepEqual(local.pending, [], 'Countdown inputs are never simulated by the server');
  for (let seq = 6; seq <= 8; seq++) local.record(frame(seq));
  local.receive(source(standing(-6)), 1_066, 5, { ...live, spawned: true });
  assert.deepEqual(local.pending, []);
  for (let seq = 1; seq <= 200; seq++) local.record(frame(seq));
  assert.equal(local.pending.length, 120, 'The in-flight list is bounded');
});

test('corrections glide the drawn body onto the server path, while spawns and teleports jump', () => {
  const local = new LocalPrediction();
  assert.equal(local.receive(source(standing(-6)), 1_000, 0, live), true, 'The first snapshot places the view');
  const drawn = local.feet();
  assert.equal(local.receive(source(standing(-6.3)), 1_033, 0, live), false);
  assert.ok(Math.abs(local.feet().x - drawn.x) < 1e-12, 'No visible jump on reconciliation');
  for (let i = 0; i < 60; i++) local.settle(1 / 60);
  assert.ok(Math.abs(local.feet().x + 6.3) < 1e-3, 'The correction has glided away');
  assert.equal(local.receive(source(standing(-6.3 + SNAP_DISTANCE + 0.5)), 1_066, 0, live), true, 'A teleport jumps');
  assert.deepEqual(local.correction, { x: 0, y: 0, z: 0 });
  assert.equal(local.receive(source(standing(-6)), 1_100, 0, { ...live, spawned: true }), true, 'A new life jumps');
});

test('the predicted clock leads the snapshot by the inputs in flight, smoothed and kept across lives', () => {
  const local = new LocalPrediction();
  for (let seq = 1; seq <= 3; seq++) local.record(frame(seq));
  local.receive(source(standing(-6)), 1_000, 0, live);
  assert.ok(Math.abs(local.clockLead - 3 * TICK) < 1e-6, 'The first measurement is taken directly');
  for (let seq = 4; seq <= 6; seq++) local.record(frame(seq));
  local.receive(source(standing(-6)), 1_033, 0, live);
  assert.ok(Math.abs(local.clockLead - (0.8 * 3 * TICK + 0.2 * 6 * TICK)) < 1e-6, 'Later measurements are smoothed');
  const lead = local.clockLead;
  local.receive(source(standing(-6)), 1_066, 6, { ...live, spawned: true });
  local.receive(source(standing(-6)), 1_100, 6, { ...live, playing: false });
  assert.equal(local.clockLead, lead, 'Respawns and countdowns keep the round-trip estimate');
});

test('vault progress follows the vault timing and is 1 when not vaulting', () => {
  assert.equal(vaultProgress(null, 10), 1);
  const vault = { fromX: 0, fromY: 0, fromZ: 0, toX: 0, toY: 1, toZ: 1, start: 1_000, end: 1_400, exitSpeed: 4, exitYaw: 0 };
  assert.equal(vaultProgress(vault, 900), 0);
  assert.equal(vaultProgress(vault, 1_280), 0.7);
  assert.equal(vaultProgress(vault, 2_000), 1);
});
