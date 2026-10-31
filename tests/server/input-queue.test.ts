import test from 'node:test';
import assert from 'node:assert/strict';
import { FRAMES_PER_TICK, idleInput, INPUT_QUEUE_LIMIT, MatchEngine } from '../../server/engine.js';
import { PRACTICE_RIVALS, PracticeBots } from '../../server/bots.js';
import { eyePosition, MOVE, movePlayer, subtract, type MoveState } from '../../shared/physics.js';
import { type GameEvent, type InputFrame, type Loadout, type PlayerState, type Vec3 } from '../../shared/protocol.js';
import { DEFAULT_LOADOUT, LOADOUT_PRESETS, weaponFor, WEAPONS } from '../../shared/weapons.js';

const TICK = 1000 / 30;
type Of<T extends GameEvent['type']> = Extract<GameEvent, { type: T }>;
const of = <T extends GameEvent['type']>(events: GameEvent[], type: T): Array<Of<T>> => events.filter((event): event is Of<T> => event.type === type);
const place = (player: PlayerState, x: number, z: number, y = 0) => Object.assign(player, { x, y, z, vx: 0, vy: 0, vz: 0 });

function playing(loadout: Loadout = DEFAULT_LOADOUT) {
  const events: GameEvent[] = [];
  const engine = new MatchEngine({ practiceSeed: 'input-queue', onEvent: event => events.push(event) });
  for (const id of ['a', 'b']) engine.addPlayer({ id, name: id, color: '#fff' }, 0);
  assert.equal(engine.setLoadout('a', loadout), true);
  engine.start(0); engine.step(3000, 0);
  for (const player of engine.players.values()) player.protectedUntil = 0;
  return { engine, events, a: engine.players.get('a')!, b: engine.players.get('b')!, rt: engine.runtime.get('a')! };
}
/** A tiny seeded generator so jitter is the same on every run. */
function seeded(seed: number) {
  return () => { seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0; return ((seed ^ (seed >>> 13)) >>> 0) / 4294967296; };
}
/** A weaving sprint and dash east along the open street at z = -20, with no jump or crouch (so no timers). */
function weave(count: number): InputFrame[] {
  return Array.from({ length: count }, (_, i) => ({
    ...idleInput(i + 1), moveZ: 1, moveX: Math.sin(i / 7) * 0.8, sprint: i % 90 < 70, dash: i % 150 > 110, yaw: Math.PI / 2 + 0.15 * Math.sin(i / 23), viewTime: 0,
  }));
}
/** The client's model of the server: one 1/30 s step per sent frame, edges against the frame before. */
function predict(from: PlayerState, frames: InputFrame[], loadout: Loadout = DEFAULT_LOADOUT): MoveState {
  const state: MoveState = {
    x: from.x, y: from.y, z: from.z, vx: from.vx, vy: from.vy, vz: from.vz, yaw: from.yaw, pitch: from.pitch, posture: from.posture,
    stamina: from.stamina, slideUntil: from.slideUntil, slideCooldownUntil: from.slideCooldownUntil, vault: from.vault, sprinting: from.sprinting, dashing: from.dashing,
  };
  let previous = { jump: false, crouch: false }, clock = 3000;
  for (const frame of frames) {
    clock += TICK; const weapon = weaponFor(loadout, frame.slot);
    movePlayer(state, frame, { now: clock, dt: 1 / 30, jumpPressed: frame.jump && !previous.jump, crouchPressed: frame.crouch && !previous.crouch, moveFactor: weapon.moveFactor, adsFactor: weapon.adsMoveFactor, canSprint: true });
    previous = frame;
  }
  return state;
}
const pose = (s: { x: number; y: number; z: number; vx: number; vy: number; vz: number; stamina: number }) => [s.x, s.y, s.z, s.vx, s.vy, s.vz, s.stamina];
interface Network { sendAt: (index: number) => number; delay: (index: number) => number; tickGap: (tick: number) => number }
/** Sends `frames` over an in-order link and ticks the server until every frame has been simulated. Checks, every
 * tick, that the per-frame clock never runs ahead of the tick or backwards, and that the queue stays bounded. */
function drive(engine: MatchEngine, frames: InputFrame[], network: Network, start = 3100) {
  const rt = engine.runtime.get('a')!, arrivals: number[] = [];
  let last = -Infinity;
  frames.forEach((_, i) => { last = Math.max(last, network.sendAt(i) + network.delay(i)); arrivals.push(last); });
  let now = start, next = 0, tick = 0, maxQueue = 0, clock = rt.clock, maxPerTick = 0;
  while (next < frames.length || rt.queue.length) {
    while (next < frames.length && arrivals[next]! <= now) { assert.equal(engine.acceptInput('a', { ...frames[next]!, viewTime: now }, arrivals[next]!), true); next++; }
    maxQueue = Math.max(maxQueue, rt.queue.length);
    const before = engine.players.get('a')!.lastInputSeq, gap = network.tickGap(tick++);
    engine.step(now, gap / 1000);
    maxPerTick = Math.max(maxPerTick, engine.players.get('a')!.lastInputSeq - before);
    assert.ok(rt.clock <= now && rt.clock >= clock, `frame clock ${rt.clock} at tick ${now} after ${clock}`);
    clock = rt.clock; now += gap;
    assert.ok(tick < 100_000);
  }
  return { maxQueue, maxPerTick, lastTick: now };
}

test('every frame is simulated once, in order, one 1/30 s step each, although the tick clock is not locked to the send clock', () => {
  const frames = weave(240);
  const { engine, a, b } = playing(); place(a, -28, -20); place(b, 28, 20);
  const expected = predict(a, frames);
  // Exactly 30.000 frames a second against Node-like ticks of 33 and 34 ms: the server falls behind, then catches up.
  const run = drive(engine, frames, { sendAt: i => 3100 + i * TICK, delay: () => 40, tickGap: tick => (tick % 2 ? 34 : 33) });
  assert.equal(a.lastInputSeq, frames.length);
  assert.deepEqual(pose(a), pose(expected), 'The server body is exactly where the client predicted it.');
  assert.ok(run.maxQueue <= 2 && run.maxPerTick <= FRAMES_PER_TICK, JSON.stringify(run));
});

test('jitter up to 150 ms and a late send timer still simulate every frame once, in order, with the predicted steps', () => {
  for (const seed of [1, 2, 3, 4]) {
    const random = seeded(seed), frames = weave(300);
    const { engine, a, b } = playing(); place(a, -28, -20); place(b, 28, 20);
    const expected = predict(a, frames);
    const lateness = frames.map(() => random() * 25), delays = frames.map(() => 30 + random() * 150);
    const run = drive(engine, frames, { sendAt: i => 3100 + i * TICK + lateness[i]!, delay: i => delays[i]!, tickGap: () => (random() < 0.15 ? 34 : 33) });
    assert.equal(a.lastInputSeq, frames.length, `seed ${seed}`);
    assert.deepEqual(pose(a), pose(expected), `seed ${seed}: no frame dropped, merged or replayed`);
    assert.ok(run.maxQueue <= INPUT_QUEUE_LIMIT && run.maxPerTick <= FRAMES_PER_TICK, `seed ${seed}: ${JSON.stringify(run)}`);
  }
});

test('the frame clock is one step per frame, never later than the tick, and catches up after a stall', () => {
  const { engine, a, rt } = playing(); place(a, -28, -20);
  let seq = 0;
  const send = (now: number, changes: Partial<InputFrame> = {}) => assert.equal(engine.acceptInput('a', { ...idleInput(++seq), viewTime: now, ...changes }, now), true);
  send(3100); engine.step(3100, 1 / 30);
  assert.equal(rt.clock, 3100, 'A steady frame runs on its tick.');
  // A second of silence, then six frames at once: the oldest are given the steps the client gave them.
  for (let i = 0; i < 6; i++) send(4100);
  engine.step(4100, 1 / 30);
  assert.equal(rt.queue.length, 4); assert.ok(Math.abs(rt.clock - (4100 - 4 * TICK)) < 1e-9, `${rt.clock}`);
  engine.step(4100 + TICK, 1 / 30); assert.ok(Math.abs(rt.clock - (4100 - TICK)) < 1e-9, `${rt.clock}`);
  engine.step(4100 + 2 * TICK, 1 / 30); assert.ok(Math.abs(rt.clock - (4100 + 2 * TICK)) < 1e-9, 'The backlog is gone and the clock is back on the tick.');
  assert.equal(a.lastInputSeq, seq);
});

test('sending faster than 30 frames a second never moves anyone faster, and the wait stays bounded', () => {
  const sprint = (i: number): InputFrame => ({ ...idleInput(i + 1), moveZ: 1, sprint: true, yaw: Math.PI / 2, viewTime: 0 });
  const honest = playing(); place(honest.a, -28, -20);
  const fast = playing(); place(fast.a, -28, -20);
  const seconds = 3, ticks = seconds * 30;
  let maxQueue = 0;
  for (let tick = 0; tick < ticks; tick++) {
    const now = 3100 + tick * TICK;
    assert.equal(honest.engine.acceptInput('a', { ...sprint(tick), viewTime: now }, now), true);
    for (const k of [0, 1]) assert.equal(fast.engine.acceptInput('a', { ...sprint(2 * tick + k), viewTime: now }, now), true);
    maxQueue = Math.max(maxQueue, fast.rt.queue.length);
    honest.engine.step(now, 1 / 30); fast.engine.step(now, 1 / 30);
  }
  // At most the six-frame catch-up allowance of extra sprinting.
  const travelled = (p: PlayerState) => p.x + 28, allowance = INPUT_QUEUE_LIMIT * MOVE.sprint * WEAPONS.kr5.moveFactor / 30;
  assert.ok(travelled(honest.a) > 15, 'Setup: the honest sprint runs down the open street.');
  assert.ok(travelled(fast.a) <= travelled(honest.a) + allowance + 1e-6, `${travelled(fast.a)} m against ${travelled(honest.a)} m`);
  assert.ok(maxQueue <= INPUT_QUEUE_LIMIT);
});

test('after a long stall the oldest movement is dropped but its tap still fires, and an empty queue holds the body still', () => {
  const { engine, a, events, rt } = playing(); place(a, -28, -20);
  // Two seconds of frames arrive together; frame 5 tapped the trigger.
  for (let i = 1; i <= 60; i++) assert.equal(engine.acceptInput('a', { ...idleInput(i), yaw: Math.PI / 2, fire: i === 5, viewTime: 5100 }, 5100), true);
  assert.equal(rt.queue.length, INPUT_QUEUE_LIMIT);
  engine.step(5100, 1 / 30);
  assert.equal(of(events, 'shot').length, 1, 'The dropped frame\'s tap still fires.');
  for (let now = 5100 + TICK; rt.queue.length; now += TICK) engine.step(now, 1 / 30);
  assert.equal(of(events, 'shot').length, 1); assert.equal(a.lastInputSeq, 60);
  // A frame of running, then nothing: the body waits for the next frame as the prediction does.
  const start = engine.players.get('a')!.lastInputSeq;
  for (let i = 1; i <= 20; i++) { const now = 6000 + i * TICK; assert.equal(engine.acceptInput('a', { ...idleInput(start + i), moveZ: 1, sprint: true, yaw: Math.PI / 2, viewTime: now }, now), true); engine.step(now, 1 / 30); }
  const last = 6000 + 20 * TICK, held = { x: a.x, z: a.z, vx: a.vx };
  assert.ok(held.vx > 5, 'Setup: running.');
  for (let now = last + TICK; now <= last + 280; now += TICK) engine.step(now, 1 / 30);
  assert.deepEqual({ x: a.x, z: a.z, vx: a.vx }, held, 'No frame waiting: no movement.');
  for (let now = last + 300 + TICK; now <= last + 1500; now += TICK) engine.step(now, 1 / 30);
  assert.ok(a.vx === 0 && a.x > held.x, 'A silent connection brakes to a stop.');
});

test('a fully aimed Heron 7 shot keeps its aim when the release frame arrives in the same tick', () => {
  const head = (player: PlayerState): Vec3 => ({ x: player.x, y: player.y + 1.62, z: player.z });
  const aimAt = (shooter: PlayerState, point: Vec3) => { const d = subtract(point, eyePosition(shooter)); return { yaw: Math.atan2(d.x, -d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) }; };
  // Both arrive before one tick; in the second case the queue overflows so the shot is a kept press used by the release frame.
  for (const overflow of [false, true]) {
    const { engine, a, b, events } = playing(LOADOUT_PRESETS.marksman);
    place(a, -28, 12); place(b, -28, -8);
    const view = aimAt(a, head(b));
    let seq = 0, now = 3100;
    for (; now < 4200; now += TICK) { assert.equal(engine.acceptInput('a', { ...idleInput(++seq), aim: true, ...view, viewTime: now }, now), true); engine.step(now, 1 / 30); }
    assert.equal(engine.acceptInput('a', { ...idleInput(++seq), fire: true, aim: true, ...view, viewTime: now }, now), true);
    for (let i = 0; i < (overflow ? INPUT_QUEUE_LIMIT : 1); i++) assert.equal(engine.acceptInput('a', { ...idleInput(++seq), ...view, viewTime: now }, now + 1), true);
    engine.step(now + 2, 1 / 30);
    const [shot] = of(events, 'shot');
    assert.ok(shot, `overflow ${overflow}: the shot was fired`);
    assert.deepEqual([shot.weapon, shot.traces[0]!.kind, shot.traces[0]!.targetId, shot.traces[0]!.zone], ['longbow', 'player', 'b', 'head'], `overflow ${overflow}: fired with full aim, no hip spread`);
    assert.equal(b.health, 0);
  }
});

test('rivals still hand over one frame per tick, simulated with the tick\'s own clock and step', t => {
  t.mock.method(PracticeBots.prototype, 'input', function (this: PracticeBots, player: PlayerState, _others: readonly PlayerState[], now: number, _dt: number, seq: number): InputFrame {
    return { ...idleInput(seq), moveZ: 1, moveX: player.id === 'bot-scout' ? 0.5 : -0.5, sprint: true, yaw: Math.PI / 2, viewTime: now };
  });
  const engine = new MatchEngine({ practice: true, practiceSeed: 'queue-bots' });
  engine.addPlayer({ id: 'human', name: 'Human', color: '#fff' }, 0);
  const bots = PRACTICE_RIVALS.map(rival => engine.addPlayer(rival, 0, true));
  engine.start(0); engine.step(3000, 0);
  for (const [index, bot] of bots.entries()) place(bot, -28, -20 + index * 0.1);
  let now = 3000;
  for (const gap of [50, 20, 70, 33]) {
    now += gap;
    const expected = bots.map(bot => {
      const state = { ...bot, loadout: bot.loadout } as PlayerState, weapon = weaponFor(bot.loadout, bot.slot), seq = engine.runtime.get(bot.id)!.input.seq + 1;
      movePlayer(state, { ...idleInput(seq), moveZ: 1, moveX: bot.id === 'bot-scout' ? 0.5 : -0.5, sprint: true, yaw: Math.PI / 2, viewTime: now }, { now, dt: gap / 1000, jumpPressed: false, crouchPressed: false, moveFactor: weapon.moveFactor, adsFactor: weapon.adsMoveFactor, canSprint: true });
      return { seq, pose: pose(state) };
    });
    engine.step(now, gap / 1000);
    bots.forEach((bot, i) => {
      assert.equal(bot.lastInputSeq, expected[i]!.seq, `${bot.id}: this tick's frame`);
      assert.deepEqual(pose(bot), expected[i]!.pose, `${bot.id}: one step of the tick's own length`);
      assert.equal(engine.runtime.get(bot.id)!.queue.length, 0);
    });
  }
});
