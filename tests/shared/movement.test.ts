import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlayerGrounded, MOVE, movePlayer, POSTURE_HEIGHT, type MoveState } from '../../shared/physics.js';
import { clone, context, Driver, FACE, frame, LANE_X, OPEN, player, speedOf, TICK_MS, withObstacle } from './support.js';

const near = (actual: number, expected: number, tolerance: number, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} expected ${expected} ± ${tolerance}, got ${actual}`);

test('ground acceleration is 40 m/s² and braking 30 m/s²', () => {
  const run = new Driver(player(LANE_X, 0));
  run.step({ moveZ: 1, yaw: FACE.south });
  near(speedOf(run.state), 40 / 30, 1e-9, 'one tick of acceleration');
  run.steps(3, { moveZ: 1, yaw: FACE.south });
  near(speedOf(run.state), MOVE.walk, 1e-9, 'walk speed after 0.125 s');
  run.step({ yaw: FACE.south });
  near(speedOf(run.state), MOVE.walk - 1, 1e-9, 'one tick of braking');
  run.steps(4, { yaw: FACE.south });
  near(speedOf(run.state), 0, 1e-9, 'stopped after 0.167 s');
});

test('walking speeds depend on direction: forward 5.0, back 4.0, strafe 4.5', () => {
  const cases: Array<[Partial<ReturnType<typeof frame>>, number]> = [
    [{ moveZ: 1 }, MOVE.walk], [{ moveZ: -1 }, MOVE.back], [{ moveX: 1 }, MOVE.strafe], [{ moveX: -1 }, MOVE.strafe],
    [{ moveX: Math.SQRT1_2, moveZ: Math.SQRT1_2 }, MOVE.strafe + (MOVE.walk - MOVE.strafe) * Math.SQRT1_2],
  ];
  for (const [patch, expected] of cases) {
    const run = new Driver(player(OPEN.x, OPEN.z));
    run.steps(6, { ...patch, yaw: FACE.south });
    near(speedOf(run.state), expected, 1e-6, JSON.stringify(patch));
  }
});

test('crouching walks at 2.6, hip speed uses the weapon factor and aiming uses the aimed factor', () => {
  const measure = (patch: Partial<ReturnType<typeof frame>>, factors = {}) => {
    const run = new Driver(player(OPEN.x, OPEN.z), 0, factors);
    run.steps(10, { moveZ: 1, yaw: FACE.south, ...patch });
    return speedOf(run.state);
  };
  near(measure({}, { moveFactor: 0.9 }), MOVE.walk * 0.9, 1e-6, 'hip factor');
  near(measure({ aim: true }, { moveFactor: 0.95, adsFactor: 0.52 }), 2.6, 1e-6, 'aimed walk is 5.0 × 0.52');
  near(measure({ crouch: true }), MOVE.crouch, 1e-6, 'crouch walk');
  near(measure({ crouch: true, aim: true }, { adsFactor: 0.5 }), MOVE.crouch * 0.5, 1e-6, 'crouched and aimed');
});

test('sprint runs at 6.9 only forward-ish and never while aiming or firing', () => {
  const measure = (patch: Partial<ReturnType<typeof frame>>, factors = {}) => {
    const run = new Driver(player(LANE_X, -10), 0, factors);
    run.steps(20, { yaw: FACE.south, sprint: true, ...patch });
    return { speed: speedOf(run.state), sprinting: !!run.state.sprinting };
  };
  assert.deepEqual(measure({ moveZ: 1 }), { speed: MOVE.sprint, sprinting: true });
  // Diagonal input (31° off forward), turned so the run still goes straight down the lane.
  const diagonal = measure({ moveZ: 1, moveX: 0.6, yaw: FACE.south - Math.atan(0.6) });
  assert.equal(diagonal.sprinting, true); near(diagonal.speed, MOVE.sprint, 1e-6, 'diagonal sprint');
  assert.equal(measure({ moveZ: 0.2, moveX: 1 }).sprinting, false, 'mostly sideways is not a sprint');
  assert.equal(measure({ moveZ: -1 }).sprinting, false, 'no backward sprint');
  const aiming = measure({ moveZ: 1, aim: true });
  assert.equal(aiming.sprinting, false); near(aiming.speed, MOVE.walk * 0.52, 1e-6, 'aiming cancels sprint');
  const firing = measure({ moveZ: 1, fire: true });
  assert.equal(firing.sprinting, false); near(firing.speed, MOVE.walk, 1e-6, 'firing cancels sprint');
  assert.equal(measure({ moveZ: 1 }, { canSprint: false }).sprinting, false, 'server can forbid sprint');
  near(measure({ moveZ: 1 }, { moveFactor: 0.88 }).speed, MOVE.sprint * 0.88, 1e-6, 'heavy weapon sprint');
});

test('dash runs at 8.2, drains stamina in 3 s, fades to sprint below 20% and refills in 4 s', () => {
  const run = new Driver(player(LANE_X, -21));
  run.steps(10, { moveZ: 1, yaw: FACE.south, sprint: true });
  run.steps(15, { moveZ: 1, yaw: FACE.south, sprint: true, dash: true });
  near(speedOf(run.state), MOVE.dash, 1e-6, 'full dash');
  assert.equal(run.state.dashing, true);
  near(run.state.stamina, 1 - 15 * TICK_MS / MOVE.dashMs, 1e-9, 'stamina drains at 1/3 per second');
  // Run the dash down to 10% stamina: the speed has faded halfway back to sprint.
  run.until(state => state.stamina <= 0.1 + 1e-9, { moveZ: 1, yaw: FACE.south, sprint: true, dash: true });
  const fadeTarget = MOVE.sprint + (MOVE.dash - MOVE.sprint) * (run.state.stamina / MOVE.dashFadeStamina);
  near(speedOf(run.state), fadeTarget, 0.05, 'dash fades below 20%');
  run.until(state => !state.dashing, { moveZ: 1, yaw: FACE.south, sprint: true, dash: true });
  assert.ok(run.state.stamina < 0.02, 'emptied, now refilling');
  run.steps(3, { moveZ: 1, yaw: FACE.south, sprint: true, dash: true });
  near(speedOf(run.state), MOVE.sprint, 1e-6, 'empty stamina sprints');
  assert.equal(run.state.dashing, false, 'no flicker back into a dash while stamina is nearly empty');
  assert.ok(run.state.stamina > 0 && run.state.stamina < MOVE.dashFadeStamina);
  // Rest: stamina refills in 4 s; a new dash waits until 20% is back.
  const rest = new Driver(player(OPEN.x, OPEN.z, { stamina: 0 }));
  rest.steps(Math.round(0.8 * 30) - 1);
  assert.ok(rest.state.stamina < MOVE.dashFadeStamina);
  rest.steps(Math.round(3.2 * 30) + 1);
  near(rest.state.stamina, 1, 1e-9, 'full after 4 s');
});

test('a jump peaks near 0.95 m and the landing reports the fall speed', () => {
  const run = new Driver(player(OPEN.x, OPEN.z));
  const start = run.step({ jump: true });
  assert.equal(start.jumped, true);
  let apex = run.state.y, landed = 0, ticks = 1;
  while (ticks < 60) {
    const events = run.step(); ticks++;
    apex = Math.max(apex, run.state.y);
    if (events.landedSpeed) { landed = events.landedSpeed; break; }
  }
  near(apex, MOVE.jumpSpeed ** 2 / (2 * MOVE.gravity), 0.01, 'apex');
  near(apex, 0.95, 0.02, 'apex in metres');
  near(landed, MOVE.jumpSpeed, 0.25, 'landing speed');
  near(ticks * TICK_MS, 2 * MOVE.jumpSpeed / MOVE.gravity * 1000, 40, 'air time');
  assert.equal(run.state.y, 0);
});

test('jumping from a crouch stands up instead of jumping', () => {
  const run = new Driver(player(OPEN.x, OPEN.z));
  run.steps(3, { crouch: true });
  assert.equal(run.state.posture, 'crouch');
  const stand = run.step({ jump: true });
  assert.equal(run.state.posture, 'stand'); assert.equal(stand.jumped, false); assert.equal(run.state.vy, 0);
  run.step();
  assert.equal(run.step({ jump: true }).jumped, true, 'the next press jumps');
});

test('standing up from a crouch, a slide or a vault needs headroom', () => {
  // A temporary bar 1.45 m up: a crouched body (1.25 m) fits under it, a standing one (1.8 m) does not.
  withObstacle({ id: 'test-low-bar', x: OPEN.x, y: 1.5, z: OPEN.z, w: 2, h: 0.1, d: 2, kind: 'wall', surface: 'trim' }, () => {
    const run = new Driver(player(OPEN.x, OPEN.z, { posture: 'crouch' }));
    run.steps(3);
    assert.equal(run.state.posture, 'crouch', 'released crouch under the bar stays crouched');
    assert.equal(run.step({ jump: true }).jumped, false, 'cannot jump up into the bar');
    assert.equal(run.state.posture, 'crouch');
    run.until(state => state.posture === 'stand', { moveZ: 1, yaw: FACE.south }, 60);
    assert.ok(run.state.z - 0.42 >= OPEN.z + 1 - 1e-6, 'stands only once clear of the bar');
    // A slide that ends under the bar ends crouched even with crouch released.
    const slide = new Driver(player(OPEN.x, OPEN.z - 0.2, { posture: 'slide', slideUntil: 20, vx: 0, vz: 4 }));
    slide.step({ moveZ: 1, yaw: FACE.south });
    assert.equal(slide.state.posture, 'crouch');
  });
});

test('air control is 20% of ground acceleration and never brakes', () => {
  // Moving at walk speed, a jump keeps the speed with no input and with input pulling backwards.
  // (-6.6, -12) heading south has open street on both sides.
  for (const air of [{}, { moveZ: -1 }, { moveX: 1 }]) {
    const run = new Driver(player(-6.6, -12));
    run.steps(10, { moveZ: 1, yaw: FACE.south });
    run.step({ moveZ: 1, yaw: FACE.south, jump: true });
    near(speedOf(run.state), MOVE.walk, 1e-6, `take-off ${JSON.stringify(air)}`);
    const before = speedOf(run.state);
    run.steps(10, { yaw: FACE.south, ...air });
    assert.ok(!isPlayerGrounded(run.state), 'still airborne');
    assert.ok(speedOf(run.state) >= before - 1e-6, `no air braking with ${JSON.stringify(air)}`);
  }
  // From a standing jump, holding forward gains at most 8 m/s² in the air.
  const standing = new Driver(player(OPEN.x, OPEN.z));
  standing.step({ jump: true });
  standing.steps(9, { moveZ: 1, yaw: FACE.south });
  near(speedOf(standing.state), MOVE.accel * MOVE.airControl * 9 * TICK_MS / 1000, 1e-6, 'air acceleration');
  // Strafing in the air turns the velocity without slowing it (facing south, right is -x).
  const turning = new Driver(player(-6.6, -12));
  turning.steps(10, { moveZ: 1, yaw: FACE.south });
  turning.step({ moveZ: 1, yaw: FACE.south, jump: true });
  turning.steps(8, { moveX: 1, yaw: FACE.south });
  assert.ok(turning.state.vx < -0.5, 'velocity turned toward the strafe');
  assert.ok(speedOf(turning.state) >= MOVE.walk - 1e-6);
});

test('steps up to 0.45 m are climbed; higher edges block', () => {
  // Walk into the 0.96 m west-lane barrier: blocked, velocity into it cleared.
  const barrier = new Driver(player(-6.6, 8));
  barrier.steps(20, { moveZ: 1, yaw: FACE.south });
  near(barrier.state.z, 9.2 - 0.42, 1e-6, 'stopped at the barrier face');
  assert.equal(barrier.state.y, 0);
  // The 0.36 m truck cargo floor is a step.
  const truck = new Driver(player(2.65, 11.5));
  truck.steps(20, { moveZ: -1, yaw: FACE.south });
  near(truck.state.y, 0.36, 1e-9, 'stepped onto the cargo floor');
});

test('walking up and down the stairs never leaves the ground', () => {
  for (const side of [-1, 1]) for (const u of [19, 24.35]) {
    const run = new Driver(player(side * u, -5.05));
    let airborne = 0;
    run.until(state => { if (!isPlayerGrounded(state)) airborne++; return state.z > 3.6; }, { moveZ: 1, yaw: FACE.south }, 120);
    near(run.state.y, 3.2, 1e-9, `top of ${side * u}`);
    run.until(state => { if (!isPlayerGrounded(state)) airborne++; return state.z < -4.9; }, { moveZ: 1, yaw: FACE.north, sprint: true }, 120);
    near(run.state.y, 0, 1e-9, `bottom of ${side * u}`);
    assert.equal(airborne, 0, `stairs at x ${side * u} stayed grounded`);
  }
});

test('a slide needs ground, a sprint, 6 m/s and a 600 ms cooldown', () => {
  // (-6.6, -12) heading south: open street to the barrier at z 9.2.
  const sprintTo = (factors = {}) => { const run = new Driver(player(-6.6, -12), 0, factors); run.steps(10, { moveZ: 1, yaw: FACE.south, sprint: true }); return run; };
  // Walking: crouch is just a crouch.
  const walk = new Driver(player(-6.6, -12));
  walk.steps(10, { moveZ: 1, yaw: FACE.south });
  assert.equal(walk.step({ moveZ: 1, yaw: FACE.south, crouch: true }).slideStarted, false);
  assert.equal(walk.state.posture, 'crouch');
  // Sprinting too slowly (heavy weapon under 6 m/s): crouch.
  const slow = sprintTo({ moveFactor: 0.85 });
  assert.ok(speedOf(slow.state) < MOVE.slideMinStartSpeed);
  assert.equal(slow.step({ moveZ: 1, yaw: FACE.south, sprint: true, crouch: true }).slideStarted, false);
  // Airborne: no slide.
  const air = sprintTo();
  air.step({ moveZ: 1, yaw: FACE.south, sprint: true, jump: true });
  assert.equal(air.step({ moveZ: 1, yaw: FACE.south, sprint: true, crouch: true }).slideStarted, false);
  assert.equal(air.state.posture, 'stand');
  // A real slide, then the cooldown.
  const run = sprintTo();
  assert.equal(run.step({ moveZ: 1, yaw: FACE.south, sprint: true, crouch: true }).slideStarted, true);
  assert.equal(run.state.posture, 'slide');
  run.until((_, events) => events.slideEnded, { moveZ: 1, yaw: FACE.south, sprint: true, crouch: true }, 40);
  const endedAt = run.now;
  run.step({ moveZ: 1, yaw: FACE.south, sprint: true });
  run.steps(5, { moveZ: 1, yaw: FACE.south, sprint: true });
  assert.ok(run.state.sprinting && speedOf(run.state) >= MOVE.slideMinStartSpeed, 'back at sprint speed');
  assert.ok(run.now - endedAt < MOVE.slideCooldownMs);
  assert.equal(run.step({ moveZ: 1, yaw: FACE.south, sprint: true, crouch: true }).slideStarted, false, 'cooldown');
  run.until(state => state.posture === 'stand' && !!state.sprinting && run.now - endedAt >= MOVE.slideCooldownMs, { moveZ: 1, yaw: FACE.south, sprint: true }, 40);
  assert.equal(run.step({ moveZ: 1, yaw: FACE.south, sprint: true, crouch: true }).slideStarted, true, 'after the cooldown');
});

test('a slide starts at 8.8 m/s, eases to 3.5 over 0.8 s and steers at 1.2 rad/s', () => {
  // Steering right (toward -x) curves away from the bus and toward the open side of the street.
  const run = new Driver(player(-6.6, -12));
  run.steps(10, { moveZ: 1, yaw: FACE.south, sprint: true });
  run.step({ moveZ: 1, yaw: FACE.south, sprint: true, crouch: true });
  const decel = (MOVE.slideSpeed - MOVE.slideEndSpeed) / (MOVE.slideMs / 1000);
  near(speedOf(run.state), MOVE.slideSpeed - decel / 30, 1e-6, 'boosted to 8.8 then eased one tick');
  let ticks = 1, heading = Math.atan2(run.state.vx, -run.state.vz), maxTurn = 0;
  for (; ticks < 40 && run.state.posture === 'slide'; ticks++) {
    run.step({ moveX: 1, moveZ: 0.2, yaw: FACE.south, crouch: true });
    const next = Math.atan2(run.state.vx, -run.state.vz);
    if (run.state.posture === 'slide') maxTurn = Math.max(maxTurn, Math.abs(Math.atan2(Math.sin(next - heading), Math.cos(next - heading))));
    heading = next;
  }
  near(ticks * TICK_MS, MOVE.slideMs, TICK_MS + 1, 'slide length');
  near(maxTurn, MOVE.slideSteer / 30, 1e-6, 'steering rate');
  assert.ok(speedOf(run.state) <= MOVE.slideEndSpeed + 0.3);
  assert.equal(run.state.posture, 'crouch', 'ends crouched with crouch held');
  assert.ok(run.state.slideCooldownUntil >= run.now);
});

test('a slide stands up at the end when crouch is released', () => {
  const run = new Driver(player(LANE_X, -21));
  run.steps(30, { moveZ: 1, yaw: FACE.south, sprint: true });
  run.step({ moveZ: 1, yaw: FACE.south, sprint: true, crouch: true });
  run.until((_, events) => events.slideEnded, { moveZ: 1, yaw: FACE.south }, 40);
  assert.equal(run.state.posture, 'stand');
});

test('jumping out of a slide keeps 90% of its speed', () => {
  for (const [slideTicks, air] of [[2, { moveZ: 1, sprint: true }], [5, {}]] as const) {
    const run = new Driver(player(LANE_X, -21));
    run.steps(30, { moveZ: 1, yaw: FACE.south, sprint: true });
    run.step({ moveZ: 1, yaw: FACE.south, sprint: true, crouch: true });
    run.steps(slideTicks, { moveZ: 1, yaw: FACE.south, sprint: true, crouch: true });
    const before = speedOf(run.state);
    const events = run.step({ ...air, yaw: FACE.south, jump: true });
    assert.equal(events.jumped, true); assert.equal(events.slideEnded, true);
    assert.equal(run.state.posture, 'stand');
    near(speedOf(run.state), before * MOVE.slideJumpKeep, 1e-6, `kept speed after ${slideTicks} slide ticks`);
    assert.ok(run.state.vy > 0);
    // Air control may raise it back toward the sprint target, but never brakes it.
    run.steps(5, { moveZ: 1, yaw: FACE.south, sprint: true });
    assert.ok(speedOf(run.state) >= before * MOVE.slideJumpKeep - 1e-6);
  }
});

test('sliding off a ledge ends the slide', () => {
  // Sliding along the 3 m bus roof toward its open end.
  const run = new Driver(player(-2.4, -1, { y: 3, posture: 'slide', slideUntil: 600, vz: 8 }), 0);
  run.until((_, events) => events.slideEnded, { moveZ: 1, yaw: FACE.south, crouch: true }, 20);
  assert.ok(run.state.y < 3 && run.state.z > 0.5, 'left the roof');
  assert.equal(run.state.posture, 'stand', 'airborne slides stand up even with crouch held');
});

test('a held crouch keeps the player crouched; sprint does not stand them up', () => {
  const run = new Driver(player(LANE_X, -10));
  run.steps(5, { crouch: true, sprint: true, moveZ: 1, yaw: FACE.south });
  assert.equal(run.state.posture, 'crouch'); assert.equal(run.state.sprinting, false);
  near(speedOf(run.state), MOVE.crouch, 1e-6);
  run.steps(2, { sprint: true, moveZ: 1, yaw: FACE.south });
  assert.equal(run.state.posture, 'stand');
});

test('bad numbers in inputs or context never corrupt the state', () => {
  const state = player(OPEN.x, OPEN.z);
  const bad = frame({ moveX: Number.NaN, moveZ: Number.POSITIVE_INFINITY, yaw: Number.NaN, pitch: Number.NaN });
  movePlayer(state, bad, context(33, { dt: Number.NaN }));
  movePlayer(state, bad, context(66, { moveFactor: Number.NaN, adsFactor: Number.NaN }));
  movePlayer(state, frame({ moveZ: 1, yaw: Number.NaN, sprint: true, dash: true }), context(99, { moveFactor: Number.NaN }));
  for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'yaw', 'pitch', 'stamina'] as const) assert.ok(Number.isFinite(state[key]), key);
  // A stale 'vault' posture without a vault record recovers.
  const stale = player(OPEN.x, OPEN.z, { posture: 'vault' });
  movePlayer(stale, frame(), context(33));
  assert.equal(stale.posture, 'stand');
});

/** Rounds like a snapshot: positions 3 decimals, angles 4, times whole milliseconds. */
function snapshotOf(state: MoveState): MoveState {
  const r = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
  const copy = clone(state);
  for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'stamina'] as const) copy[key] = r(copy[key], 3);
  copy.yaw = r(copy.yaw, 4); copy.pitch = r(copy.pitch, 4);
  copy.slideUntil = Math.round(copy.slideUntil); copy.slideCooldownUntil = Math.round(copy.slideCooldownUntil);
  if (copy.vault) {
    const v = copy.vault;
    copy.vault = { ...v, fromX: r(v.fromX, 3), fromY: r(v.fromY, 3), fromZ: r(v.fromZ, 3), toX: r(v.toX, 3), toY: r(v.toY, 3), toZ: r(v.toZ, 3),
      start: Math.round(v.start), end: Math.round(v.end), exitSpeed: r(v.exitSpeed, 3), exitYaw: r(v.exitYaw, 4) };
  }
  return copy;
}

/** Sprint, slide, slide-jump, land, sprint, vault the barrier, land; inputs depend on the state like a player's. */
function chainRun(): Driver {
  const run = new Driver(player(-6.6, -6));
  const forward = { moveZ: 1, yaw: FACE.south, sprint: true };
  run.steps(30, forward);
  run.step({ ...forward, crouch: true });
  run.steps(7, { ...forward, crouch: true });
  run.step({ ...forward, jump: true });
  run.until((_, events) => events.landedSpeed > 0, forward, 40);
  run.until(state => state.z >= 9.2 - 0.42 - 0.6, forward, 60);
  run.step({ ...forward, jump: true });
  run.until((_, events) => events.vaultEnded, { ...forward, jump: true }, 30);
  run.until((_, events) => events.landedSpeed > 0, forward, 40);
  run.steps(10, forward);
  return run;
}

test('replaying the same inputs reproduces a slide, jump, vault and landing exactly', () => {
  const server = chainRun();
  const kinds = new Set(server.log.flatMap(({ events }) => Object.entries(events).filter(([, value]) => value === true || (typeof value === 'number' && value > 0)).map(([key]) => key)));
  for (const kind of ['slideStarted', 'slideEnded', 'jumped', 'vaultStarted', 'vaultEnded', 'landedSpeed']) assert.ok(kinds.has(kind), `chain includes ${kind}`);
  assert.ok(server.state.z > 9.8, 'crossed the barrier');
  // Exact replay from the start.
  const replay = player(-6.6, -6);
  for (const tick of server.log) {
    const events = movePlayer(replay, tick.input, tick.ctx);
    assert.deepEqual(events, tick.events);
    assert.deepEqual(replay, tick.after);
  }
});

/** Replays the recorded inputs from a rounded snapshot of every `every`-th tick, as prediction does after a
 * server correction, and checks the final pose agrees with the server's. */
function assertReplayParity(server: Driver, label: string, every = 3, tolerance = 0.02) {
  for (let from = 0; from < server.log.length - 1; from += every) {
    const predicted = snapshotOf(server.log[from]!.after);
    for (let i = from + 1; i < server.log.length; i++) movePlayer(predicted, server.log[i]!.input, server.log[i]!.ctx);
    const actual = server.state;
    const error = Math.hypot(predicted.x - actual.x, predicted.y - actual.y, predicted.z - actual.z);
    assert.ok(error < tolerance, `${label}: replay from tick ${from} drifted ${error.toFixed(4)} m`);
    assert.equal(predicted.posture, actual.posture, `${label}: posture after replay from tick ${from}`);
  }
}

test('prediction replayed from a rounded snapshot stays within 2 cm through the chain', () => {
  assertReplayParity(chainRun(), 'street chain');
});

test('prediction replayed from rounded snapshots agrees on the stairs and through a window', () => {
  // Sprint up the inside stairs, turn on the landing, run back down, jump on the way.
  const stairs = new Driver(player(-19, -5.05));
  stairs.until(state => state.z > 3.6, { moveZ: 1, yaw: FACE.south, sprint: true }, 90);
  stairs.steps(3, { yaw: FACE.north });
  stairs.until(state => state.z < -1, { moveZ: 1, yaw: FACE.north, sprint: true }, 90);
  stairs.step({ moveZ: 1, yaw: FACE.north, sprint: true, jump: true });
  stairs.until(state => state.y === 0 && state.z < -4.9, { moveZ: 1, yaw: FACE.north }, 90);
  assertReplayParity(stairs, 'stairs', 2);
  // Sprint at the teal front window, vault in, keep running into the house.
  const window = new Driver(player(-6, 1.6));
  window.until(state => state.x <= -9.44 + 0.6, { moveZ: 1, yaw: FACE.west, sprint: true }, 40);
  window.step({ moveZ: 1, yaw: FACE.west, sprint: true, jump: true });
  window.until((_, events) => events.vaultEnded, { moveZ: 1, yaw: FACE.west, sprint: true }, 30);
  window.steps(20, { moveZ: 1, yaw: FACE.west, sprint: true });
  assert.ok(window.state.x < -11, 'inside the house');
  assertReplayParity(window, 'window', 1);
});

test('collision height follows posture', () => {
  assert.deepEqual(POSTURE_HEIGHT, { stand: 1.8, crouch: 1.25, slide: 1.0, vault: 1.25 });
  // A crouched player cannot be pushed into the 1.45 m bar by standing up while walking under it.
  withObstacle({ id: 'test-bar', x: LANE_X, y: 1.5, z: 0, w: 2, h: 0.1, d: 2, kind: 'wall', surface: 'trim' }, () => {
    const run = new Driver(player(LANE_X, -2));
    run.steps(30, { moveZ: 1, yaw: FACE.south });
    assert.ok(run.state.z <= -1 - 0.42 + 1e-6, 'standing body stops at the bar');
    const crouched = new Driver(player(LANE_X, -2));
    crouched.steps(30, { moveZ: 1, yaw: FACE.south, crouch: true });
    assert.ok(crouched.state.z > 0, 'crouched body passes under');
  });
});

test('a corrupt state inside an obstacle can walk out instead of sticking', () => {
  const stuck = player(-6.6, 9.5); // centre of the west-lane barrier footprint, below its top
  const run = new Driver(stuck);
  run.steps(20, { moveZ: -1, yaw: FACE.south });
  assert.ok(run.state.z < 9.2 - 0.42 + 0.05, `escaped to ${run.state.z}`);
});

test('dt is clamped to 0.1 s', () => {
  const state = player(LANE_X, -10, { vz: 5 });
  movePlayer(state, frame({ moveZ: 1, yaw: FACE.south }), context(1000, { dt: 5 }));
  assert.ok(state.z - -10 <= 5 * 0.1 + 1e-9);
});
