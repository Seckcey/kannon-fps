import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_CREDIT_MS, FRAME_MS, FRAMES_PER_TICK, idleInput, INPUT_QUEUE_LIMIT, MatchEngine, MAX_PLAYOUT_MS, PLAYOUT_RELAX_MS } from '../../server/engine.js';
import { PRACTICE_RIVALS, PracticeBots } from '../../server/bots.js';
import { OBSTACLES } from '../../shared/map.js';
import { eyePosition, isPlayerGrounded, MOVE, movePlayer, PLAYER_RADIUS, subtract, type MoveState } from '../../shared/physics.js';
import { type GameEvent, type InputFrame, type Loadout, type PlayerState, type Vec3 } from '../../shared/protocol.js';
import { DEFAULT_LOADOUT, EXPLOSIVES, fireIntervalMs, hasPerk, LOADOUT_PRESETS, QUICK_HANDS_FACTOR, weaponFor, WEAPONS } from '../../shared/weapons.js';

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
const moveState = (from: PlayerState): MoveState => ({
  x: from.x, y: from.y, z: from.z, vx: from.vx, vy: from.vy, vz: from.vz, yaw: from.yaw, pitch: from.pitch, posture: from.posture,
  stamina: from.stamina, slideUntil: from.slideUntil, slideCooldownUntil: from.slideCooldownUntil, vault: from.vault, sprinting: from.sprinting, dashing: from.dashing,
});
/** The client's model of the server: one 1/30 s step per sent frame, edges against the frame before. */
function predict(from: PlayerState, frames: InputFrame[], loadout: Loadout = DEFAULT_LOADOUT): MoveState {
  const state = moveState(from);
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
  const rt = engine.runtime.get('a')!, arrivals: number[] = [], perTick: Array<{ at: number; frames: number }> = [];
  let last = -Infinity;
  frames.forEach((_, i) => { last = Math.max(last, network.sendAt(i) + network.delay(i)); arrivals.push(last); });
  let now = start, next = 0, tick = 0, maxQueue = 0, clock = rt.clock, maxPerTick = 0;
  while (next < frames.length || rt.queue.length) {
    while (next < frames.length && arrivals[next]! <= now) { assert.equal(engine.acceptInput('a', { ...frames[next]!, viewTime: now }, arrivals[next]!), true); next++; }
    maxQueue = Math.max(maxQueue, rt.queue.length);
    const before = engine.players.get('a')!.lastInputSeq, gap = network.tickGap(tick++);
    engine.step(now, gap / 1000);
    const ran = engine.players.get('a')!.lastInputSeq - before;
    maxPerTick = Math.max(maxPerTick, ran); perTick.push({ at: now, frames: ran });
    assert.ok(rt.clock <= now && rt.clock >= clock, `frame clock ${rt.clock} at tick ${now} after ${clock}`);
    clock = rt.clock; now += gap;
    assert.ok(tick < 100_000);
  }
  return { maxQueue, maxPerTick, lastTick: now, perTick };
}
interface Ran { seq: number; clock: number; tick: number; state: PlayerState }
/** Records every frame the runner's body is simulated with (not the silent-connection idle frame): its sequence
 * number, the clock it ran on, the tick, and the state it left. */
function recordFrames(t: TestContext, id = 'a'): Ran[] {
  const ran: Ran[] = [];
  type Simulate = (this: MatchEngine, player: PlayerState, rt: unknown, queued: { input: InputFrame }, now: number, tickNow: number, dt: number, actions: unknown, real?: boolean) => void;
  const proto = MatchEngine.prototype as unknown as { simulate: Simulate }, original = proto.simulate;
  t.mock.method(proto, 'simulate', function (this: MatchEngine, player: PlayerState, rt: unknown, queued: { input: InputFrame }, now: number, tickNow: number, dt: number, actions: unknown, real = true) {
    original.call(this, player, rt, queued, now, tickNow, dt, actions, real);
    if (player.id === id && real) ran.push({ seq: queued.input.seq, clock: now, tick: tickNow, state: structuredClone(player) });
  });
  return ran;
}
/** Ticks like Node's setInterval(…, 1000 / 30): 33 ms, sometimes 34. */
const nodeTicks = (random: () => number) => () => (random() < 0.15 ? 34 : 33);
/** Send times on the client's 30 Hz grid, each up to `lateness` ms late, never out of order. */
function pacedSends(count: number, random: () => number, lateness: number, start = 3100) {
  const sends: number[] = []; let last = -Infinity;
  for (let i = 0; i < count; i++) { last = Math.max(last, start + i * TICK + random() * lateness); sends.push(last); }
  return sends;
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
    // The queue holds up to six frames of backlog beyond the frames the playout keeps in hand.
    assert.ok(run.maxQueue <= INPUT_QUEUE_LIMIT + MAX_PLAYOUT_MS / FRAME_MS && run.maxPerTick <= FRAMES_PER_TICK, `seed ${seed}: ${JSON.stringify({ ...run, perTick: undefined })}`);
  }
});

test('each frame runs one 1/30 s step after the frame before it, also two to a tick, never later than its tick', t => {
  const ran = recordFrames(t);
  const { engine, a, rt } = playing(); place(a, -28, -20);
  // A second of steady frames, a 200 ms stall whose frames all arrive when it ends, then a second more, against
  // Node-like ticks.
  const random = seeded(7), frames = weave(75), stall = (i: number) => (i >= 30 && i < 36 ? (36 - i) * TICK : 0);
  const run = drive(engine, frames, { sendAt: i => 3100 + i * TICK, delay: i => 40 + stall(i), tickGap: nodeTicks(random) });
  assert.equal(a.lastInputSeq, frames.length);
  assert.deepEqual(ran.map(r => r.seq), frames.map(f => f.seq), 'Every frame once, in order.');
  assert.ok(run.perTick.some(tick => tick.frames === 2), 'Setup: the stall\'s frames catch up two to a tick.');
  for (const r of ran) assert.ok(r.clock <= r.tick, `frame ${r.seq} at ${r.clock} after its tick ${r.tick}`);
  // Once streaming (the first frames of a life run as they come, on the tick), every step is exactly one frame.
  for (let i = 10; i < ran.length; i++) {
    const step = ran[i]!.clock - ran[i - 1]!.clock;
    assert.ok(Math.abs(step - FRAME_MS) < 1e-6, `frame ${ran[i]!.seq} ran ${step} ms after frame ${ran[i - 1]!.seq}${ran[i]!.tick === ran[i - 1]!.tick ? ' in the same tick' : ''}`);
  }
  // The snapshot tells the client which clock its acknowledged frame ran on, to replay later frames from.
  const self = engine.snapshot(run.lastTick, 'a').self!;
  assert.equal(self.lastInputSeq, frames.length);
  assert.ok(Math.abs(self.lastInputTime! - ran.at(-1)!.clock) < 1e-3, `${self.lastInputTime} against ${ran.at(-1)!.clock}`);
  assert.ok(Math.abs(rt.clock - ran.at(-1)!.clock) < 1e-9);
});

const barrier = OBSTACLES.find(box => box.id === 'west-lane-barrier')!;
const barrierFront = barrier.z - barrier.d / 2;
/** The client side of a sprint, slide, slide-jump and vault over the west-lane barrier after a second of standing:
 * the frames it sends, deciding each from its own predicted body. Its clock starts anywhere; only one 1/30 s step
 * per frame matters. */
function vaultChain(start: PlayerState, standing = 30) {
  const state = moveState(start), frames: InputFrame[] = [];
  let previous = { jump: false, crouch: false }, clock = 0, slid = false, vaulted = false;
  for (let i = 0; i < standing + 75; i++) {
    const k = i - standing, close = barrierFront - state.z - PLAYER_RADIUS < 0.55;
    const changes: Partial<InputFrame> = k < 0 ? {} : k < 8 ? { moveZ: 1, sprint: true } : k <= 11 ? { moveZ: 1, sprint: true, crouch: true }
      : k === 12 || (slid && !vaulted && close && isPlayerGrounded(state)) ? { moveZ: 1, sprint: true, jump: true } : { moveZ: 1, sprint: true };
    const frame: InputFrame = { ...idleInput(i + 1), yaw: Math.PI, viewTime: 0, ...changes }, weapon = weaponFor(DEFAULT_LOADOUT, frame.slot);
    clock += TICK;
    movePlayer(state, frame, { now: clock, dt: 1 / 30, jumpPressed: frame.jump && !previous.jump, crouchPressed: frame.crouch && !previous.crouch, moveFactor: weapon.moveFactor, adsFactor: weapon.adsMoveFactor, canSprint: true });
    if (state.vault) vaulted = true; if (state.posture === 'slide') slid = true;
    previous = frame; frames.push(frame);
  }
  assert.ok(slid && vaulted, 'Setup: the client slides, then vaults the barrier.');
  return { frames };
}

/** What the client sees on each snapshot: it adopts the acknowledged frame's state and clock (`lastInputTime`) and
 * replays the frames it sent since, one 1/30 s step each. Returns how far that replay lands from where the server
 * then put the body, for every pair of acknowledgements up to `span` snapshots apart (a client skips snapshots that
 * arrive together). */
function corrections(ran: Ran[], frames: InputFrame[], acks: number[], span = 3) {
  const bySeq = new Map(ran.map(r => [r.seq, r]));
  const out: Array<{ from: number; to: number; off: number }> = [];
  for (let i = 0; i < acks.length; i++) for (let j = i + 1; j <= Math.min(acks.length - 1, i + span); j++) {
    const from = bySeq.get(acks[i]!), to = bySeq.get(acks[j]!);
    if (!from || !to || to.seq <= from.seq) continue;
    const state = moveState(from.state);
    let previous: InputFrame = frames[from.seq - 1]!;
    for (let seq = from.seq + 1; seq <= to.seq; seq++) {
      const frame = frames[seq - 1]!, weapon = weaponFor(DEFAULT_LOADOUT, frame.slot);
      movePlayer(state, frame, { now: from.clock + (seq - from.seq) * FRAME_MS, dt: 1 / 30, jumpPressed: frame.jump && !previous.jump, crouchPressed: frame.crouch && !previous.crouch, moveFactor: weapon.moveFactor, adsFactor: weapon.adsMoveFactor, canSprint: true });
      previous = frame;
    }
    out.push({ from: from.seq, to: to.seq, off: Math.hypot(state.x - to.state.x, state.y - to.state.y, state.z - to.state.z) });
  }
  return out;
}

test('slide, slide-jump and vault timers follow the client\'s clock under Node-like ticks, jitter, late sends and 150 ms spikes', t => {
  const ran = recordFrames(t);
  const profiles: Array<{ name: string; ticks: 'exact' | 'node'; jitter: number; lateness: number; spikes?: number }> = [
    { name: 'steady link, exact ticks', ticks: 'exact', jitter: 0, lateness: 0 },
    { name: 'steady link, Node ticks', ticks: 'node', jitter: 0, lateness: 0 },
    { name: '0-10 ms jitter', ticks: 'node', jitter: 10, lateness: 8 },
    { name: '0-30 ms jitter', ticks: 'node', jitter: 30, lateness: 16 },
    { name: '0-60 ms jitter', ticks: 'node', jitter: 60, lateness: 16 },
    { name: '5% spikes of 150 ms', ticks: 'node', jitter: 5, lateness: 16, spikes: 150 },
  ];
  for (const profile of profiles) for (const seed of [1, 2, 3, 4, 5, 6]) {
    ran.length = 0;
    const random = seeded(seed * 31 + profile.jitter);
    const { engine, a, b } = playing(); place(a, barrier.x, 0.5); a.yaw = Math.PI; place(b, 28, -20);
    const chain = vaultChain(a), sends = pacedSends(chain.frames.length, random, profile.lateness);
    const delays = chain.frames.map(() => 40 + (profile.spikes && random() < 0.05 ? profile.spikes : random() * profile.jitter));
    const run = drive(engine, chain.frames, { sendAt: i => sends[i]!, delay: i => delays[i]!, tickGap: profile.ticks === 'exact' ? () => TICK : nodeTicks(random) });
    const label = `${profile.name}, seed ${seed}`;
    assert.deepEqual(ran.map(r => r.seq), chain.frames.map(f => f.seq), `${label}: every frame once, in order`);
    assert.ok(ran.some(r => r.state.posture === 'slide') && ran.some(r => r.state.vault), `${label}: the server slides and vaults too`);
    // The acknowledgement each snapshot carries (every other tick), from the last frame run by then.
    const acks = run.perTick.filter((_, i) => i % 2 === 0).map(tick => ran.filter(r => r.tick <= tick.at).at(-1)?.seq ?? 0).filter(seq => seq > 0);
    const worst = corrections(ran, chain.frames, acks).reduce((most, c) => (c.off > most.off ? c : most), { from: 0, to: 0, off: 0 });
    // A timer one tick off moves a vaulting body 17-31 cm; the clock check may ease the clock 1 ms a frame.
    assert.ok(worst.off < 0.01, `${label}: replaying frames ${worst.from + 1}-${worst.to} from the snapshot lands ${(worst.off * 100).toFixed(2)} cm from the server`);
  }
});

test('a swap\'s raise and a reload run from the frame\'s own clock, not the tick\'s', t => {
  const ran = recordFrames(t);
  const random = seeded(11), handling = hasPerk(DEFAULT_LOADOUT, 'quick-hands') ? QUICK_HANDS_FACTOR : 1;
  const { engine, a } = playing(); place(a, -28, -20);
  a.mag[0] = 10;
  // Frame 40 swaps to the sidearm, frame 60 swaps back, frame 80 reloads.
  const frames = Array.from({ length: 100 }, (_, i): InputFrame => ({ ...idleInput(i + 1), viewTime: 0, slot: i + 1 >= 40 && i + 1 < 60 ? 2 : 1, reload: i + 1 === 80 }));
  const sends = pacedSends(frames.length, random, 16), delays = frames.map(() => 40 + random() * 40);
  let readyAfterSwap = NaN, reloadUntil = NaN;
  const rt = engine.runtime.get('a')!, arrivals: number[] = [];
  let last = -Infinity; frames.forEach((_, i) => { last = Math.max(last, sends[i]! + delays[i]!); arrivals.push(last); });
  for (let now = 3100, next = 0; next < frames.length || rt.queue.length; now += random() < 0.15 ? 34 : 33) {
    while (next < frames.length && arrivals[next]! <= now) { engine.acceptInput('a', { ...frames[next]!, viewTime: now }, arrivals[next]!); next++; }
    engine.step(now, 0.033);
    if (Number.isNaN(readyAfterSwap) && a.lastInputSeq >= 40) readyAfterSwap = ran.find(r => r.seq === 40)!.state.readyAt;
    if (Number.isNaN(reloadUntil) && a.lastInputSeq >= 80) reloadUntil = ran.find(r => r.seq === 80)!.state.reloadingUntil;
  }
  const clockOf = (seq: number) => ran.find(r => r.seq === seq)!.clock;
  assert.ok(Math.abs(clockOf(40) - (clockOf(20) + 20 * FRAME_MS)) < 1e-6 && Math.abs(clockOf(80) - (clockOf(20) + 60 * FRAME_MS)) < 1e-6, 'Setup: steady one-frame steps.');
  assert.ok(Math.abs(readyAfterSwap - (clockOf(40) + WEAPONS.sentry9.raiseMs * handling)) < 1e-6, `raise ends ${readyAfterSwap}, frame 40 ran at ${clockOf(40)}`);
  assert.ok(Math.abs(reloadUntil - (clockOf(80) + WEAPONS.kr5.reloadMs * handling)) < 1e-6, `reload ends ${reloadUntil}, frame 80 ran at ${clockOf(80)}`);
});

test('other players see a steady runner: after one late frame, every tick moves them exactly one frame', () => {
  // Exact 30 Hz ticks (server/app.ts) and a sprint along the open street with up to 30 ms of uplink jitter.
  for (const jitter of [0, 8, 16, 30]) for (const seed of [1, 2, 3, 4, 5, 6]) {
    const random = seeded(seed * 7 + jitter), phase = random() * TICK;
    const { engine, a, b } = playing(); place(a, -28, -20); place(b, 28, 20);
    const frames = Array.from({ length: 120 }, (_, i): InputFrame => ({ ...idleInput(i + 1), moveZ: 1, sprint: true, yaw: Math.PI / 2, viewTime: 0 }));
    const delays = frames.map(() => 40 + random() * jitter);
    const run = drive(engine, frames, { sendAt: i => 3100 + phase + i * TICK, delay: i => delays[i]!, tickGap: () => TICK });
    // After the first second (a few frames to start streaming, and at most one late frame to grow the playout).
    const uneven = run.perTick.filter(tick => tick.at > 4100 && tick.at < run.lastTick - 300 && tick.frames !== 1);
    assert.ok(uneven.length <= (jitter ? 2 : 0), `jitter 0-${jitter} ms, seed ${seed}: ${JSON.stringify(uneven)}`);
  }
});

test('the playout grows a frame after a late frame and shrinks again after a while without one', () => {
  const { engine, a, rt } = playing(); place(a, -28, -20);
  let now = 3100, seq = 0;
  const send = (at: number) => assert.equal(engine.acceptInput('a', { ...idleInput(++seq), moveX: seq % 2 ? 0.5 : -0.5, viewTime: at }, at), true);
  // Steady frames, each 10 ms before its tick.
  const steady = (ticks: number) => { for (let i = 0; i < ticks; i++, now += TICK) { send(now - 10); engine.step(now, 1 / 30); } };
  steady(30);
  assert.equal(rt.playout, 0); assert.equal(rt.streaming, true);
  // One frame comes 20 ms after its tick: that tick holds, and from then on a frame is kept in hand.
  engine.step(now, 1 / 30); now += TICK; send(now - TICK + 20); send(now - 10); engine.step(now, 1 / 30); now += TICK;
  assert.equal(rt.playout, FRAME_MS);
  const held = a.lastInputSeq;
  steady(30);
  assert.equal(a.lastInputSeq, held + 30, 'One frame a tick...'); assert.equal(rt.queue.length, 1, '...with one in hand.');
  // Five seconds of frames arriving a tick early: back to running each frame on its own tick, after one double step.
  steady(Math.ceil(PLAYOUT_RELAX_MS / TICK));
  assert.equal(rt.playout, 0);
  assert.equal(a.lastInputSeq, seq, 'Nothing is left waiting.');
});

test('a jump in sequence numbers cannot stall a player or move their clock past the tick', () => {
  const { engine, a, rt } = playing(); place(a, -28, -20);
  let now = 3100, seq = 0;
  for (let i = 0; i < 20; i++, now += TICK) { assert.equal(engine.acceptInput('a', { ...idleInput(++seq), moveZ: 1, yaw: Math.PI / 2, viewTime: now }, now - 5), true); engine.step(now, 1 / 30); }
  seq += 10_000;
  const x = a.x;
  for (let i = 0; i < 10; i++, now += TICK) {
    assert.equal(engine.acceptInput('a', { ...idleInput(++seq), moveZ: 1, yaw: Math.PI / 2, viewTime: now }, now - 5), true);
    engine.step(now, 1 / 30);
    assert.ok(rt.clock <= now, `clock ${rt.clock} at tick ${now}`);
  }
  assert.ok(a.lastInputSeq > 10_020 && a.x > x + 0.5, 'The frames after the jump run.');
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
  // At most the five-frame catch-up allowance of extra sprinting.
  const travelled = (p: PlayerState) => p.x + 28, allowance = FRAME_CREDIT_MS / FRAME_MS * MOVE.sprint * WEAPONS.kr5.moveFactor / 30;
  assert.ok(travelled(honest.a) > 15, 'Setup: the honest sprint runs down the open street.');
  assert.ok(travelled(fast.a) <= travelled(honest.a) + allowance + 1e-6, `${travelled(fast.a)} m against ${travelled(honest.a)} m`);
  assert.ok(maxQueue <= INPUT_QUEUE_LIMIT + MAX_PLAYOUT_MS / FRAME_MS);
});

test('holding frames back and spending them at once gains no more than the catch-up allowance', () => {
  const sprint = (seq: number, now: number): InputFrame => ({ ...idleInput(seq), moveZ: 1, sprint: true, yaw: Math.PI / 2, viewTime: now });
  const { engine, a } = playing(); place(a, -28, -20);
  let seq = 0, now = 3100;
  const counts: Array<{ at: number; frames: number }> = [];
  // Ten seconds of 30 frames a second: stream, hold six frames back (200 ms behind cover), then send them two a tick.
  for (let tick = 0; tick < 300; tick++, now += TICK) {
    const phase = tick % 30, n = phase < 18 ? 1 : phase < 24 ? 0 : 2;
    for (let k = 0; k < n; k++) assert.equal(engine.acceptInput('a', sprint(++seq, now), now), true);
    const before = a.lastInputSeq; engine.step(now, 1 / 30); counts.push({ at: now, frames: a.lastInputSeq - before });
  }
  let worst = -Infinity;
  for (let i = 0; i < counts.length; i++) {
    let sum = 0;
    for (let j = i; j < counts.length; j++) { sum += counts[j]!.frames; worst = Math.max(worst, sum - (counts[j]!.at - counts[i]!.at) / TICK - 1); }
  }
  assert.ok(worst <= FRAME_CREDIT_MS / FRAME_MS + 1e-6, `${worst} frames beyond real time`);
  assert.ok(counts.every(c => c.frames <= FRAMES_PER_TICK));
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
      assert.equal(bot.lastInputTime, now, `${bot.id}: on the tick's clock`);
    });
  }
});

/** Frames on a script: `send` queues a frame for its arrival, and `until` runs the server's exact 30 Hz ticks, handing
 * each frame over as its arrival comes up. Player a stands in the open street, b far away. */
function scripted(loadout: Loadout = DEFAULT_LOADOUT) {
  const { engine, events, a, b, rt } = playing(loadout);
  place(a, -28, -20); place(b, 28, 20);
  let tick = 1, seq = 0, last = -Infinity;
  const pending: Array<{ at: number; frame: InputFrame }> = [];
  const now = () => 3000 + tick * TICK;
  const until = (time: number) => {
    for (; now() <= time + 1e-9; tick++) {
      while (pending[0] && pending[0].at <= now()) { const { at, frame } = pending.shift()!; engine.acceptInput('a', frame, at); }
      engine.step(now(), TICK / 1000);
    }
  };
  /** One frame arriving at `at` (or after the frame before it), `skip` sequence numbers on from the last. */
  const send = (at: number, changes: Partial<InputFrame> = {}, skip = 1) => {
    seq += skip; last = Math.max(last, at);
    pending.push({ at: last, frame: { ...idleInput(seq), yaw: Math.PI / 2, pitch: 0.1, viewTime: last, ...changes } });
  };
  /** `count` frames at 30 a second from `from`, run through. Returns when the next is due. */
  const stream = (from: number, count: number, changes: (index: number) => Partial<InputFrame> = () => ({})) => {
    for (let i = 0; i < count; i++) send(from + i * TICK, changes(i));
    until(from + count * TICK);
    return from + count * TICK;
  };
  /** One frame every `every` ms for `span` ms: each lands far behind its clock, which is put back on the tick. */
  const sparse = (from: number, span: number, every = 280) => {
    let at = from;
    for (; at < from + span; at += every) { send(at); until(at); }
    return at;
  };
  /** Silence until the player is stood down, the frames that build a new stream, and a frame skipping `skip` numbers. */
  const restart = (skip: number, changes: Partial<InputFrame> = {}) => {
    const next = stream(now() + 320, 7);
    send(next, changes, skip); until(next + TICK);
    return next + TICK;
  };
  return { engine, events, a, b, rt, now, until, send, stream, sparse, restart, sequence: () => seq };
}

/** How far behind the tick a frame clock can run before it is put back on it (CLOCK_RESET_MS, a full playout and a
 * frame). A frame that came that late starts its timers there: lag tolerance, spent once and paid back by the next
 * late frame. */
const CLOCK_LAG = 250 + MAX_PLAYOUT_MS + TICK;

test('time saved while no timer runs buys nothing: frames far apart and a sequence jump as a stream restarts leave a bolt and a reload their time', t => {
  const bolt = fireIntervalMs(WEAPONS.longbow), reload = WEAPONS.longbow.reloadMs * (hasPerk(LOADOUT_PRESETS.marksman, 'quick-hands') ? QUICK_HANDS_FACTOR : 1);
  const ran = recordFrames(t), clockOf = (seq: number) => ran.filter(frame => frame.seq === seq).at(-1)!.clock;
  for (const saved of [0, 2000, 6000]) {
    const shot = scripted(LOADOUT_PRESETS.marksman);
    let next = shot.stream(shot.sparse(shot.stream(3010, 30), saved), 15);
    assert.ok(shot.rt.shifted <= 0, `${saved} ms saved: ${shot.rt.shifted.toFixed(1)} ms of allowance banked`);
    next = shot.stream(next, 2, i => ({ fire: i === 0 }));
    next = shot.restart(40, { fire: true });
    for (let i = 0; i < 90 && of(shot.events, 'shot').length < 2; i++) next = shot.stream(next, 1, () => ({ fire: i % 2 === 0 }));
    const [first, second] = of(shot.events, 'shot');
    assert.ok(second, 'setup: a second shot');
    const boltClock = clockOf(second.seq!) - clockOf(first!.seq!), boltTick = second.at - first!.at;
    assert.ok(boltClock >= bolt - 2 * TICK, `${saved} ms saved: the bolt took ${boltClock.toFixed(1)} ms of ${bolt} on the frame clock`);
    assert.ok(boltTick >= bolt - CLOCK_LAG, `${saved} ms saved: the bolt took ${boltTick.toFixed(1)} ms of ${bolt}`);

    const reloading = scripted(LOADOUT_PRESETS.marksman);
    next = reloading.stream(reloading.sparse(reloading.stream(3010, 30), saved), 15);
    reloading.a.mag[0] = 1;
    next = reloading.stream(next, 1, () => ({ reload: true }));
    assert.ok(reloading.a.reloadingUntil > 0, 'setup: reloading');
    const startedClock = reloading.rt.clock, startedTick = reloading.now() - TICK;
    next = reloading.restart(90);
    for (let i = 0; i < 150 && reloading.a.mag[0] === 1; i++) next = reloading.stream(next, 1);
    assert.equal(reloading.a.mag[0], WEAPONS.longbow.magazine, 'setup: reloaded');
    const reloadClock = reloading.rt.clock - startedClock, reloadTick = reloading.now() - TICK - startedTick;
    assert.ok(reloadClock >= reload - 2 * TICK, `${saved} ms saved: the reload took ${reloadClock.toFixed(1)} ms of ${reload} on the frame clock`);
    assert.ok(reloadTick >= reload - CLOCK_LAG, `${saved} ms saved: the reload took ${reloadTick.toFixed(1)} ms of ${reload}`);
  }
});

test('a sequence jump as a stream restarts moves running timers one step at most', () => {
  for (const skip of [2, 12, 40, 1000]) {
    const s = scripted(LOADOUT_PRESETS.marksman);
    const t = s.stream(3010, 30);
    s.a.mag[0] = 1;
    s.stream(t, 1, () => ({ reload: true }));
    const until = s.a.reloadingUntil;
    assert.ok(until > 0, 'setup: reloading');
    s.restart(skip);
    assert.ok(s.a.reloadingUntil > 0, 'setup: still reloading');
    assert.ok(until - s.a.reloadingUntil <= TICK + 1e-6, `${skip} numbers skipped moved the reload ${(until - s.a.reloadingUntil).toFixed(1)} ms sooner`);
  }
});

test('no timer moves further ahead of the frame clock than what is left of the catch-up allowance', () => {
  const s = scripted(LOADOUT_PRESETS.marksman), t = s.stream(3010, 30);
  s.a.mag[0] = 1;
  s.stream(t, 1, () => ({ reload: true }));
  const next = s.stream(s.now() + 320, 7);
  // Nearly all of it used, as the clock check and stream starts can use it over a life.
  s.rt.shifted = -FRAME_CREDIT_MS + 5;
  const until = s.a.reloadingUntil;
  assert.ok(until > 0, 'setup: reloading');
  s.send(next, {}, 40); s.until(next + TICK);
  // What it had left, and the sliver that came back over those ticks.
  const moved = until - s.a.reloadingUntil;
  assert.ok(moved > 4 && moved <= 7, `The reload moved ${moved.toFixed(1)} ms sooner`);
  assert.ok(s.rt.shifted >= -FRAME_CREDIT_MS - 1e-6, `${s.rt.shifted.toFixed(1)} ms used`);
});

test('the catch-up allowance comes back slowly, whole with each life, and not with a reconnect', () => {
  const s = scripted(LOADOUT_PRESETS.assault);
  s.stream(3010, 30);
  s.rt.shifted = -100;
  const from = s.now();
  s.until(from + 1000);
  assert.ok(Math.abs(s.rt.shifted + 80) < 2, `A second gives back 20 ms: ${s.rt.shifted.toFixed(1)}`);
  s.rt.shifted = -100;
  s.engine.setConnected('a', false);
  s.engine.addPlayer({ id: 'a', name: 'a', color: '#fff' }, s.now());
  assert.equal(s.rt.shifted, -100, 'Leaving and joining again gives none back');
  s.engine.damage(s.a, s.b, 1000, s.now());
  while (s.a.health <= 0) s.until(s.now());
  assert.equal(s.rt.shifted, 0, 'A new life starts with all of it');
});

test('off the stream, a frame after a reload finished on the tick cannot shoot from a clock behind it', t => {
  // A modified page stands still through the reload, sends one frame a quarter of a second before its end, then six at once.
  const ran = recordFrames(t), s = scripted(LOADOUT_PRESETS.assault);
  const next = s.stream(3010, 30);
  s.a.mag[0] = 1;
  s.stream(next, 1, () => ({ reload: true }));
  const until = s.a.reloadingUntil;
  assert.ok(until > 0, 'setup: reloading');
  s.send(until - 250); s.until(until - 200);
  s.until(until + 40);
  assert.equal(s.a.mag[0], WEAPONS.kr5.magazine, 'setup: reloaded on the tick');
  const burst = s.now();
  for (let i = 0; i < 6; i++) s.send(burst, { fire: true });
  s.until(burst + 6 * TICK);
  const [shot] = of(s.events, 'shot');
  assert.ok(shot, 'setup: fired');
  const clock = ran.filter(frame => frame.seq === shot.seq).at(-1)!.clock;
  assert.ok(clock >= until, `The shot's frame clock ${clock.toFixed(1)} is behind the reload's end ${until.toFixed(1)}`);
});

test('each cook has the whole of the clock\'s room to move', () => {
  const s = scripted(LOADOUT_PRESETS.assault);
  let next = s.stream(3010, 30);
  next = s.stream(next, 1, () => ({ grenade: true }));
  s.rt.cookShifted = FRAME_CREDIT_MS;
  next = s.stream(next, 1);
  assert.ok(s.a.frags > 0, 'setup: a frag left');
  s.stream(next, 1, () => ({ grenade: true }));
  assert.ok(s.a.cookingSince > 0, 'setup: cooking again');
  assert.equal(s.rt.cookShifted, 0);
});

test('a silent player\'s idle frames leave the time the page counts its frames from', () => {
  const s = scripted(LOADOUT_PRESETS.assault);
  const next = s.stream(3010, 30), ranAt = s.a.lastInputTime!;
  s.until(next + 1000);
  assert.ok(s.rt.clock > ranAt + 900, 'setup: idle frames ran on the tick');
  assert.equal(s.a.lastInputTime, ranAt);
});

test('however far apart the frames come, a frag held in hand goes off close to its fuse', () => {
  const fuse = EXPLOSIVES.frag.fuseMs;
  for (const every of [TICK, 100, 200, 250, 290]) {
    const s = scripted(LOADOUT_PRESETS.assault);
    let t = s.stream(3010, 30);
    t = s.stream(t, 1, () => ({ grenade: true }));
    const cooked = s.a.cookingSince;
    assert.ok(cooked > 0, 'setup: cooking');
    for (let at = t; at < t + 6000; at += every) { s.send(at, { grenade: true }); s.until(at); }
    const [blast] = of(s.events, 'explosion');
    assert.ok(blast, `${every} ms apart: it went off in hand`);
    // It is judged on the frames: the allowance, a clock as far behind the tick as it goes, and the wait for one more frame.
    const held = blast.at - cooked;
    assert.ok(held >= fuse - 2 * TICK && held <= fuse + FRAME_CREDIT_MS + CLOCK_LAG + every, `${every} ms apart: held ${held.toFixed(0)} ms on a ${fuse} ms fuse`);
    // Thrown after a long hold, its fuse has moved no further either.
    const thrower = scripted(LOADOUT_PRESETS.assault);
    t = thrower.stream(3010, 30);
    t = thrower.stream(t, 1, () => ({ grenade: true }));
    const start = thrower.a.cookingSince;
    const release = t + 2000;
    for (let at = t; at < release; at += every) { thrower.send(at, { grenade: true }); thrower.until(at); }
    thrower.send(release, {}); thrower.until(release + 400);
    const [thrown] = of(thrower.events, 'grenade');
    assert.ok(thrown, `${every} ms apart: thrown`);
    assert.ok(thrown.explodeAt - start <= fuse + FRAME_CREDIT_MS + 1, `${every} ms apart: the thrown fuse ran ${thrown.explodeAt - start} ms`);
  }
});

test('a life\'s first frame runs one step after its spawn however late it arrives, so the raise ends on the same frame', () => {
  for (const loadout of [LOADOUT_PRESETS.assault, LOADOUT_PRESETS.marksman]) for (const delay of [50, 100, 250, 290, 310, 350, 450, 1000]) {
    const s = scripted(loadout);
    s.stream(3010, 45);
    s.engine.damage(s.a, s.b, 1000, s.now() - TICK);
    while (s.a.health <= 0) s.until(s.now());
    const spawn = s.rt.aliveSince, raise = s.a.readyAt - spawn, before = s.sequence();
    s.until(spawn + delay - 1);
    assert.equal(s.a.lastInputTime, spawn, `first frame ${delay} ms after the spawn: idle frames leave the clock at the spawn`);
    s.stream(spawn + delay, 40, () => ({ fire: true }));
    const shot = of(s.events, 'shot').find(event => event.at >= spawn);
    assert.ok(shot, 'setup: fired');
    assert.equal(shot.seq! - before, Math.ceil((raise - 0.01) / TICK), `first frame ${delay} ms after the spawn: the frame the raise ended on`);
  }
});

test('a player who joined during the countdown counts their frames from the round going live', () => {
  const engine = new MatchEngine({ practiceSeed: 'input-queue' });
  for (const id of ['a', 'b']) engine.addPlayer({ id, name: id, color: '#fff' }, 0);
  engine.start(0); engine.step(2700, 0);
  const c = engine.addPlayer({ id: 'c', name: 'c', color: '#fff' }, 2700);
  assert.equal(c.lastInputTime, 2700);
  engine.step(3000, 0);
  assert.equal(c.lastInputTime, 3000);
  assert.equal(engine.runtime.get('c')!.clock, 3000);
});
