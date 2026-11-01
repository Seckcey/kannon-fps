import assert from 'node:assert/strict';
import test from 'node:test';
import { isPlayerGrounded, MOVE, moveDefaults, movePlayer, PLAYER_RADIUS, supportHeight, type MoveEvents, type MoveState } from '../../shared/physics';
import { OBSTACLES } from '../../shared/map';
import { RULES, type InputFrame, type Loadout, type Vec3 } from '../../shared/protocol';
import { LOADOUT_PRESETS, WEAPONS } from '../../shared/weapons';
import { LocalPrediction, MovementPrediction, SNAP_DISTANCE, vaultProgress, type PredictionSource } from '../../src/game/MovementPrediction';

const TICK = 1000 / 30;
const frame = (seq: number, changes: Partial<InputFrame> = {}): InputFrame => ({
  seq, moveX: 0, moveZ: 0, yaw: Math.PI, pitch: 0, fire: false, aim: false, jump: false, sprint: false, reload: false, slot: 1,
  crouch: false, dash: false, melee: false, grenade: false, streak: null, viewTime: 0, ...changes,
});

/** The server's tick in the engine's order (server/engine.ts updatePlayer), written independently of
 * the client: rising edges from the previous accepted input; this tick's knife and cook start before
 * the move, both refused while the body is vaulting, and the cook takes the frag as it starts; then the
 * move with the equipped weapon's factors and no sprint while cooking or knifing; then a release (or a
 * fuse run out in hand) ends the cook. */
interface ServerPlayer { state: MoveState; previous: InputFrame | null; loadout: Loadout; cookingSince: number; meleeUntil: number; frags: number }
function serverTick(player: ServerPlayer, input: InputFrame, now: number): MoveEvents {
  const previous = player.previous, weapon = WEAPONS[input.slot === 1 ? player.loadout.primary : player.loadout.secondary];
  if (input.melee && !previous?.melee && now >= player.meleeUntil && !player.cookingSince && !player.state.vault) player.meleeUntil = now + RULES.meleeMs;
  if (input.grenade && !previous?.grenade && !player.cookingSince && player.frags > 0 && now >= player.meleeUntil && !player.state.vault) {
    player.cookingSince = now; player.frags--;
  }
  const events = movePlayer(player.state, input, {
    now, dt: 1 / 30, jumpPressed: input.jump && !previous?.jump, crouchPressed: input.crouch && !previous?.crouch,
    moveFactor: weapon.moveFactor, adsFactor: weapon.adsMoveFactor, canSprint: !player.cookingSince && now >= player.meleeUntil,
  });
  if (player.cookingSince && (!input.grenade || now >= player.cookingSince + RULES.fragFuseMs)) player.cookingSince = 0;
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
function run(start: MoveState, ticks: number, script: (tick: number, state: MoveState, seq: number) => InputFrame, loadout: Loadout = LOADOUT_PRESETS.assault, frags = 1): Run {
  const player: ServerPlayer = { state: structuredClone(start), previous: null, loadout, cookingSince: 0, meleeUntil: 0, frags };
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

test('knifing and cooking stop the sprint on their own tick, in prediction and on the server alike', () => {
  const knife = run(startState(-6, 20, Math.PI / 2), 60, (tick, _state, seq) => frame(seq, { moveZ: 1, sprint: true, melee: tick === 10, yaw: Math.PI / 2 }));
  assert.equal(knife.states[9]!.server.state.sprinting, true);
  assert.equal(knife.states[10]!.server.state.sprinting, false, 'The knife starts before the move, so its own tick no longer sprints');
  assert.ok(knife.states.slice(10, 28).every(entry => !entry.server.state.sprinting), 'No sprint for the 600 ms knife');
  assert.equal(knife.states.at(-1)!.server.state.sprinting, true, 'Sprint resumes after the knife');
  assertParity(knife);
  const cook = run(startState(-6, 20, Math.PI / 2), 50, (tick, _state, seq) => frame(seq, { moveZ: 1, sprint: true, grenade: tick >= 5 && tick < 25, yaw: Math.PI / 2 }));
  assert.equal(cook.states[4]!.server.state.sprinting, true);
  assert.ok(cook.states.slice(5, 26).every(entry => !entry.server.state.sprinting), 'No sprint from the cook tick through the release tick');
  assert.equal(cook.states[5]!.server.frags, 0, 'The frag leaves the belt when the cook starts');
  assert.equal(cook.states.at(-1)!.server.state.sprinting, true);
  assert.equal(cook.states.at(-1)!.server.frags, 0, 'The release throws the only frag');
  assertParity(cook);
});

test('a snapshot taken mid-cook already counts the frag gone, so a second cook soon after the release is predicted', () => {
  // Two frags: cook, release, sprint a moment, cook again. Snapshots taken during the first cook carry the
  // server's count with that frag already gone; taking it again at the release would leave none for the second.
  const cooks = run(startState(-6, 20, Math.PI / 2), 50, (tick, _state, seq) =>
    frame(seq, { moveZ: 1, sprint: true, grenade: (tick >= 5 && tick < 15) || (tick >= 20 && tick < 32), yaw: Math.PI / 2 }), LOADOUT_PRESETS.assault, 2);
  assert.equal(cooks.states[10]!.server.frags, 1, 'Mid-cook, the server has already taken the first frag');
  assert.equal(cooks.states[18]!.server.state.sprinting, true, 'Sprinting again between the cooks');
  assert.ok(cooks.states.slice(20, 33).every(entry => !entry.server.state.sprinting), 'The second cook stops the sprint');
  assert.equal(cooks.states.at(-1)!.server.frags, 0);
  assertParity(cooks);
});

test('the knife and a cook pressed on the last tick of a vault are refused on both sides, so the sprint carries on after it', () => {
  for (const key of ['melee', 'grenade'] as const) {
    let pressed = 0;
    const result = run(startState(barrier.x, barrierFront - PLAYER_RADIUS - 0.4), 60, (tick, state, seq) => {
      const time = 50_000 + (tick + 1) * TICK;
      if (tick === 2) return frame(seq, { moveZ: 1, jump: true });
      // The vault ends during this tick's move, but the body starts the tick still vaulting.
      if (!pressed && state.vault && time >= state.vault.end) {
        pressed = seq;
        return frame(seq, { moveZ: 1, sprint: true, ...(key === 'melee' ? { melee: true } : { grenade: true }) });
      }
      // A real cook later on: it can only start if the refused press left the frag on the belt.
      return frame(seq, { moveZ: 1, sprint: true, grenade: key === 'grenade' && !!pressed && tick >= pressed + 20 && tick < pressed + 30 });
    });
    assert.ok(pressed > 0, `${key}: the press lands on the vault's last tick`);
    const refused = result.states[pressed - 1]!.server;
    assert.equal(refused.meleeUntil, 0, `${key}: no knife was started`);
    assert.equal(refused.cookingSince, 0, `${key}: no cook was started`);
    assert.equal(refused.frags, 1, `${key}: the frag is still on the belt`);
    assert.ok(result.states.slice(pressed, pressed + 18).some(entry => entry.server.state.sprinting), `${key}: sprinting resumes within the 600 ms a knife would block`);
    if (key === 'grenade') assert.equal(result.states.at(-1)!.server.frags, 0, 'The later cook takes the frag');
    assertParity(result);
  }
});

test('the equipped weapon sets walking and aimed speeds, and a swap changes them on that tick', () => {
  for (const [loadout, aim, expected] of [
    [LOADOUT_PRESETS.marksman, true, 5 * 0.42], [LOADOUT_PRESETS.close, true, 5 * 0.62],
    [LOADOUT_PRESETS.assault, false, 5 * 0.95], [LOADOUT_PRESETS.marksman, false, 5 * 0.88],
  ] as const) {
    const result = run(startState(-6, 20, Math.PI / 2), 30, (_tick, _state, seq) => frame(seq, { moveZ: 1, aim, yaw: Math.PI / 2 }), loadout);
    const final = result.states.at(-1)!.server.state;
    assert.ok(Math.abs(Math.hypot(final.vx, final.vz) - expected) < 1e-9, `${loadout.primary} aim=${aim}`);
    assertParity(result, 7);
  }
  const swap = run(startState(-6, 20, Math.PI / 2), 40, (tick, _state, seq) => frame(seq, { moveZ: 1, aim: true, slot: tick >= 20 ? 2 : 1, yaw: Math.PI / 2 }), LOADOUT_PRESETS.marksman);
  const final = swap.states.at(-1)!.server.state;
  assert.ok(Math.abs(Math.hypot(final.vx, final.vz) - 5 * WEAPONS.sentry9.adsMoveFactor) < 1e-9);
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
  for (let seq = 1; seq <= 5; seq++) local.record(frame(seq, { yaw: Math.PI / 2 }), seq * TICK, false);
  local.receive(source(standing(-6)), 1_000, 2, live, 200);
  assert.deepEqual(local.pending.map(input => input.seq), [3, 4, 5]);
  local.receive(source(standing(-6)), 1_033, 3, { ...live, playing: false }, 233);
  assert.deepEqual(local.pending, [], 'Countdown inputs are never simulated by the server');
  for (let seq = 6; seq <= 8; seq++) local.record(frame(seq), 233 + seq, false);
  local.receive(source(standing(-6)), 1_066, 5, { ...live, spawned: true }, 266);
  assert.deepEqual(local.pending, []);
  for (let seq = 1; seq <= 200; seq++) local.record(frame(seq), 300, false);
  assert.equal(local.pending.length, 120, 'The in-flight list is bounded');
});

test('after a reconnect restarts the server count at 0, no held frame is replayed', () => {
  const east = { moveZ: 1, yaw: Math.PI / 2 };
  const drive = (restarted: boolean) => {
    const local = new LocalPrediction();
    local.receive(source(standing(-6)), 1_000, 0, { ...live, spawned: true }, 0);
    for (let seq = 1; seq <= 3; seq++) local.record(frame(seq, east), seq * TICK, true);
    local.receive(source(standing(-6)), 1_033, 0, live, 100);
    // The socket dies silently: the walk goes on into it for three seconds, then the server takes the
    // player back where they were frozen, reporting input 0 as the last one processed.
    for (let seq = 4; seq <= 93; seq++) local.record(frame(seq, east), seq * TICK, seq < 20);
    local.receive(source(standing(-6)), 4_200, 0, { ...live, restarted }, 3_200);
    return local;
  };
  const local = drive(true);
  assert.equal(local.pending.length, 0, 'Frames lost with the old socket or already simulated are not in flight');
  assert.ok(Math.abs(local.movement.state.x + 6) < 1e-9, 'The body stays where the server froze it');
  local.record(frame(94, east), 3_233, true);
  assert.deepEqual(local.pending.map(input => input.seq), [94], 'New frames are in flight again');
  const stale = drive(false);
  assert.ok(stale.movement.state.x > -6 + 10, `Without it, the 90 held frames replay down the street (x ${stale.movement.state.x.toFixed(2)})`);
});

test('corrections glide the drawn body onto the server path, while spawns and teleports jump', () => {
  const local = new LocalPrediction();
  assert.equal(local.receive(source(standing(-6)), 1_000, 0, live, 0), true, 'The first snapshot places the view');
  const drawn = local.feet(0);
  assert.equal(local.receive(source(standing(-6.3)), 1_033, 0, live, 33), false);
  assert.ok(Math.abs(local.feet(33).x - drawn.x) < 1e-12, 'No visible jump on reconciliation');
  for (let i = 0; i < 60; i++) local.settle(1 / 60);
  assert.ok(Math.abs(local.feet(1_033).x + 6.3) < 1e-3, 'The correction has glided away');
  assert.equal(local.receive(source(standing(-6.3 + SNAP_DISTANCE + 0.5)), 1_066, 0, live, 1_066), true, 'A teleport jumps');
  assert.deepEqual(local.correction, { x: 0, y: 0, z: 0 });
  assert.equal(local.receive(source(standing(-6)), 1_100, 0, { ...live, spawned: true }, 1_100), true, 'A new life jumps');
});

test('each sent input in live play moves the body one server tick, and frames draw it between the last two ticks', () => {
  const local = new LocalPrediction(), east = { moveZ: 1, yaw: Math.PI / 2 };
  assert.equal(local.record(frame(1, east), 0, true), null, 'Nothing moves before the first snapshot supplies the body');
  local.receive(source(standing(-6)), 1_000, 1, live, 10);
  const reference = standing(-6);
  reference.previous = frame(1, east);
  const start = local.feet(10), walk = frame(2, east);
  const events = local.record(walk, 100, true);
  serverTick(reference, walk, 1_000 + TICK);
  assert.ok(events && !events.jumped, 'A live input returns its tick events');
  same(local.movement.state, reference.state, 'one tick');
  assert.ok(Math.abs(local.movement.time - (1_000 + TICK)) < 1e-9, 'The tick runs on the predicted server clock');
  const moved = reference.state.x - start.x;
  assert.ok(moved > 0.01, 'The tick moved east');
  assert.ok(Math.abs(local.feet(100).x - start.x) < 1e-12, 'Just after the tick the body is still drawn where it was');
  assert.ok(Math.abs(local.feet(100 + TICK / 2).x - (start.x + moved / 2)) < 1e-9, 'Halfway to the next send it is drawn halfway');
  assert.ok(Math.abs(local.feet(100 + TICK * 3).x - reference.state.x) < 1e-12, 'It never runs ahead of the latest tick');
  assert.equal(local.record(frame(3, east), 100 + TICK, false), null, 'Inputs the server will not simulate do not move the body');
  same(local.movement.state, reference.state, 'unmoved');
  assert.deepEqual(local.pending.map(input => input.seq), [2, 3]);
});

test('a send timer that fires early or late moves the drawn body smoothly and never backwards', () => {
  const local = new LocalPrediction(), east = { moveZ: 1, yaw: Math.PI / 2 };
  local.receive(source(standing(-6)), 1_000, 0, live, 0);
  const jitter = [0, 9, -7, 4, -9, 8, 0, -5, 7, -3, 9, -8, 2, -6, 5, 0, 0, 0];
  const sends = jitter.map((offset, index) => (index + 1) * TICK + offset);
  let next = 0, previous = local.feet(0), fastest = 0, now = 0;
  for (; now <= 30 * TICK; now += 1000 / 60) {
    while (next < sends.length && sends[next]! <= now) { local.record(frame(next + 1, east), sends[next]!, true); next++; }
    local.settle(1 / 60);
    const drawn = local.feet(now);
    assert.ok(drawn.x >= previous.x - 1e-9, `The body never steps back (${now.toFixed(1)} ms)`);
    fastest = Math.max(fastest, drawn.x - previous.x);
    previous = drawn;
  }
  assert.ok(fastest < 2 * MOVE.walk / 60, `No frame jumps ahead: at most ${fastest.toFixed(3)} m in one frame`);
  assert.ok(Math.abs(local.feet(now).x - local.movement.state.x) < 1e-3, 'Once the inputs stop it rests on the predicted path');
});

/** A client driven the way GameView drives LocalPrediction: each sent input is recorded (in live
 * play it moves the body one tick), each render frame settles the correction and draws the body,
 * and the newest snapshot is adopted on the next render frame. The reference server above runs one
 * input per 30 Hz tick behind a fixed one-way delay and sends a snapshot every other tick (15 Hz). */
interface Link { latency: number; sendPhase: number; renderHz: number; renderPhase: number; round: boolean }
interface View { now: number; drawn: Vec3; state: MoveState }
interface Player { input(index: number, now: number): Partial<InputFrame>; look(view: View): void }
interface Session { server: Map<number, MoveEvents>; client: Map<number, MoveEvents>; snapBack: number; final: MoveState }
type Snapshot = { source: PredictionSource; serverTime: number; ack: number };
const EPOCH = 50_000;
function session(link: Link, start: MoveState, player: Player, sends = 70): Session {
  const queue: Array<{ time: number; order: number; run: () => void }> = [];
  // At one instant: arrivals, then the server tick, then the client's send, then its render frame.
  const at = (time: number, order: number, run: () => void) => {
    let index = queue.length;
    while (index > 0 && (queue[index - 1]!.time > time || (queue[index - 1]!.time === time && queue[index - 1]!.order > order))) index--;
    queue.splice(index, 0, { time, order, run });
  };
  const server: ServerPlayer = { state: structuredClone(start), previous: null, loadout: LOADOUT_PRESETS.assault, cookingSince: 0, meleeUntil: 0, frags: 1 };
  const inbox: InputFrame[] = [], result: Session = { server: new Map(), client: new Map(), snapBack: 0, final: server.state };
  const end = EPOCH + sends * TICK + 2 * link.latency + 200;
  let acknowledged = 0, newest: Snapshot | null = null, adopted: Snapshot | null = null;
  for (let tick = 1; EPOCH + tick * TICK <= end; tick++) {
    const time = EPOCH + tick * TICK;
    at(time, 1, () => {
      const input = inbox.shift();
      if (input) { result.server.set(input.seq, serverTick(server, input, time)); acknowledged = input.seq; }
      if (tick % 2) return;
      const snapshot: Snapshot = { source: source(server, link.round), serverTime: link.round ? Math.round(time) : time, ack: acknowledged };
      at(time + link.latency, 0, () => { newest = snapshot; });
    });
  }
  const prediction = new LocalPrediction();
  let received = -Infinity, firstLife = true, lastFrame = EPOCH;
  for (let index = 0; index < sends; index++) {
    const time = EPOCH + link.sendPhase + index * TICK;
    at(time, 2, () => {
      const input = frame(index + 1, player.input(index, time));
      const events = prediction.record(input, time, prediction.active && time - received < 500);
      if (events) result.client.set(input.seq, events);
      at(time + link.latency, 0, () => { inbox.push(input); });
    });
  }
  for (let index = 0; EPOCH + link.renderPhase + index * 1000 / link.renderHz <= end; index++) {
    const time = EPOCH + link.renderPhase + index * 1000 / link.renderHz;
    at(time, 3, () => {
      const snapshot: Snapshot | null = newest;
      if (snapshot && snapshot !== adopted) {
        adopted = snapshot; received = time;
        const before = { ...prediction.correction };
        const snapped = prediction.receive(snapshot.source, snapshot.serverTime, snapshot.ack, { playing: true, alive: true, spawned: firstLife }, time);
        firstLife = false;
        const after = prediction.correction;
        if (!snapped) result.snapBack = Math.max(result.snapBack, Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z));
      }
      prediction.settle((time - lastFrame) / 1000); lastFrame = time;
      player.look({ now: time, drawn: prediction.feet(time), state: prediction.movement.state });
    });
  }
  while (queue.length) queue.shift()!.run();
  return result;
}
function* links(round = false): Generator<Link> {
  for (const latency of [30, 40, 50, 60, 70, 80, 90, 100]) for (const sendPhase of [0.3, 8.6, 17.1, 25.4])
    for (const renderHz of [60, 120]) for (const renderPhase of [0.1, 5.3, 11.7]) yield { latency, sendPhase, renderHz, renderPhase, round };
}
const linkLabel = (link: Link) => `${link.latency} ms each way, sends +${link.sendPhase} ms, ${link.renderHz} Hz frames +${link.renderPhase} ms`;
/** Jumps at send `jumpAt` (unless `jumpFirst` is false: then it only starts watching there), then presses
 * jump on the first render frame (plus `delay` ms) at which the view shows the body back on the ground:
 * the latest predicted tick ('tick') or the drawn feet ('drawn'). */
function jumpOnLanding(script: (index: number) => Partial<InputFrame>, jumpAt: number, trigger: 'tick' | 'drawn', delay: number, jumpFirst = true): Player {
  let watching = false, airborne = false, landed = -Infinity, pressed = false;
  return {
    input(index, now) {
      if (index === jumpAt) { watching = true; return jumpFirst ? { ...script(index), jump: true } : script(index); }
      if (!pressed && landed > -Infinity && now >= landed + delay) { pressed = true; return { ...script(index), jump: true }; }
      return script(index);
    },
    look({ now, drawn, state }) {
      if (!watching || landed > -Infinity) return;
      if (!isPlayerGrounded(state)) { airborne = true; return; }
      if (airborne && (trigger === 'tick' || drawn.y - supportHeight(drawn) < 0.005)) landed = now;
    },
  };
}
/** Stand while the first snapshots arrive, sprint, slide, then jump out of the slide (send 22). */
const slideJump = (index: number): Partial<InputFrame> =>
  index < 10 ? {} : index < 18 ? { moveZ: 1, sprint: true } : index < 22 ? { moveZ: 1, sprint: true, crouch: true } : { moveZ: 1, sprint: true };
const walkEast = (index: number): Partial<InputFrame> => ({ moveZ: index < 10 ? 0 : 1, yaw: Math.PI / 2 });
const moves = (events: MoveEvents) => ({
  jumped: events.jumped, slideStarted: events.slideStarted, slideEnded: events.slideEnded,
  vaultStarted: events.vaultStarted, vaultEnded: events.vaultEnded, landed: events.landedSpeed > 0,
});
function agree(result: Session, label: string) {
  assert.ok(result.client.size >= 50, `${label}: the client predicted the run`);
  for (const [seq, events] of result.client) {
    const server = result.server.get(seq);
    assert.ok(server, `${label}: input ${seq} reached the server`);
    assert.deepEqual(moves(events), moves(server), `${label}: input ${seq} moved the same on the screen and on the server`);
  }
}

test('a jump pressed on the frame the view lands from a slide jump vaults the barrier on the screen and on the server alike', () => {
  let vaults = 0, runs = 0;
  for (const link of links()) {
    const result = session(link, startState(barrier.x, 1.8), jumpOnLanding(slideJump, 22, 'drawn', 0));
    agree(result, linkLabel(link));
    assert.ok(result.snapBack < 1e-9, `${linkLabel(link)}: snapped back ${result.snapBack} m`);
    runs++;
    if ([...result.server.values()].some(events => events.vaultStarted)) vaults++;
  }
  // Scenario check: the slide jump lands beside the barrier, so the landing press is a vault.
  assert.ok(vaults > runs / 2, `${vaults} of ${runs} timings vaulted`);
});

test('a hop pressed 0 to 10 ms after the view lands is accepted on both sides, with no snap-back', () => {
  for (const link of links()) {
    if (link.renderPhase !== 5.3 || ![30, 60, 100].includes(link.latency)) continue;
    for (const trigger of ['tick', 'drawn'] as const) for (const delay of [0, 5, 10]) {
      const label = `${linkLabel(link)}, ${trigger} landing +${delay} ms`;
      const result = session(link, startState(-6, 20, Math.PI / 2), jumpOnLanding(walkEast, 12, trigger, delay));
      agree(result, label);
      assert.ok(result.snapBack < 1e-9, `${label}: snapped back ${result.snapBack} m`);
      assert.equal([...result.server.values()].filter(events => events.jumped).length, 2, `${label}: both hops happen`);
    }
  }
});

test('running down the house stairs and vaulting in through a window match the server with no snap-back', () => {
  const downstairs = (index: number): Partial<InputFrame> => (index < 10 ? { yaw: 0 } : { moveZ: 1, sprint: true, yaw: 0 });
  const indoors = (index: number): Partial<InputFrame> => ({ moveZ: index < 10 ? 0 : 1, yaw: -Math.PI / 2 });
  for (const link of links()) {
    if (link.renderPhase !== 5.3 || ![30, 60, 100].includes(link.latency)) continue;
    // Sprinting down the stairs steps from tread to tread without leaving the ground, so the run
    // jumps part-way down and presses again on the landing on a lower tread. Then a vault through
    // the front window (over the 0.95 m sill) followed by a press on the landing inside.
    const stairs = session(link, { ...startState(-19, 3.6, 0), y: 3.2 }, jumpOnLanding(downstairs, 24, 'drawn', 0));
    agree(stairs, `stairs, ${linkLabel(link)}`);
    assert.ok(stairs.snapBack < 1e-9, `stairs, ${linkLabel(link)}: snapped back ${stairs.snapBack} m`);
    assert.ok(stairs.final.y < 0.05 && [...stairs.server.values()].some(events => events.jumped), 'The run reaches the bottom with a jump on the way');
    const sill = session(link, startState(-8.9, 1.6, -Math.PI / 2), jumpOnLanding(indoors, 12, 'drawn', 0));
    agree(sill, `window, ${linkLabel(link)}`);
    assert.ok(sill.snapBack < 1e-9, `window, ${linkLabel(link)}: snapped back ${sill.snapBack} m`);
    assert.ok([...sill.server.values()].some(events => events.vaultStarted) && sill.final.x < -11, 'The press vaults in through the window');
  }
});

test('snapshots rounded like the wire format keep the landing press in agreement and corrections under a centimetre', () => {
  for (const link of links(true)) {
    if (link.renderPhase !== 11.7) continue;
    for (const trigger of ['tick', 'drawn'] as const) {
      const result = session(link, startState(barrier.x, 1.8), jumpOnLanding(slideJump, 22, trigger, 0));
      agree(result, `${linkLabel(link)}, rounded, ${trigger}`);
      assert.ok(result.snapBack < 0.01, `${linkLabel(link)}: corrected ${result.snapBack} m`);
    }
  }
});

test('vault progress follows the vault timing and is 1 when not vaulting', () => {
  assert.equal(vaultProgress(null, 10), 1);
  const vault = { fromX: 0, fromY: 0, fromZ: 0, toX: 0, toY: 1, toZ: 1, start: 1_000, end: 1_400, exitSpeed: 4, exitYaw: 0 };
  assert.equal(vaultProgress(vault, 900), 0);
  assert.equal(vaultProgress(vault, 1_280), 0.7);
  assert.equal(vaultProgress(vault, 2_000), 1);
});
