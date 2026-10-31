import assert from 'node:assert/strict';
import test from 'node:test';
import { idleInput, MatchEngine } from '../../server/engine';
import { OBSTACLES } from '../../shared/map';
import { isPlayerGrounded, PLAYER_RADIUS, reached, type MoveState } from '../../shared/physics';
import { type InputFrame, type Loadout, type PlayerState, type WorldSnapshot } from '../../shared/protocol';
import { LOADOUT_PRESETS } from '../../shared/weapons';
import { LocalWeapon } from '../../src/game/LocalWeapon';
import { LocalPrediction, vaultProgress } from '../../src/game/MovementPrediction';

/* The real server engine and the real client prediction, joined by real snapshots over a link with
 * delay and jitter, as the game runs them: the page sends exactly 30 frames a second (a little late
 * now and then), the server ticks on its exact 30 Hz schedule (running a little late now and then)
 * and sends a snapshot every other tick, and the page adopts the newest snapshot on its next drawn
 * frame. Whenever a snapshot replaces the prediction, the predicted body and weapon must not move:
 * the server ran every acknowledged frame exactly as the page predicted it. */

const TICK = 1000 / 30;
/** A tiny seeded generator so every run is the same. */
function seeded(seed: number) {
  return () => { seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0; return ((seed ^ (seed >>> 13)) >>> 0) / 4294967296; };
}

/** GameView's local half without drawing: a sent frame goes through the predictor and the weapon
 * (GameView.sendInput), and a snapshot is adopted as GameView.receiveSnapshot adopts it. */
class Page {
  readonly prediction = new LocalPrediction();
  readonly weapon: LocalWeapon;
  snapshot: WorldSnapshot | null = null;
  private received = -Infinity;
  private lastAck = 0;
  private lastAlive = false;
  private first = true;
  constructor(loadout: Loadout) { this.weapon = new LocalWeapon(loadout); }
  private local() { return this.snapshot?.players.find(player => player.id === 'a'); }
  private playing() {
    const local = this.local();
    return !!local && this.prediction.active && this.snapshot?.phase === 'playing' && local.health > 0 && local.connected;
  }
  serverTime(wall: number) { return this.snapshot ? this.snapshot.serverTime + wall - this.received : 0; }
  send(frame: InputFrame, wall: number) {
    const vaultBefore = this.prediction.movement.state.vault;
    const moved = this.prediction.record(frame, wall, !!this.snapshot && wall - this.received < 500 && this.playing());
    const state = this.prediction.movement.state;
    const now = moved ? this.prediction.movement.time : this.serverTime(wall) + this.prediction.clockLead;
    const pressVault = moved ? vaultBefore : state.vault;
    return this.weapon.step(frame, {
      now, alive: this.playing(), sprinting: !!state.sprinting, dashing: !!state.dashing,
      vaultProgress: vaultProgress(state.vault, now), pressVaultProgress: vaultProgress(pressVault, now), vaultingBefore: !!pressVault, ads: 0,
    });
  }
  /** Returns true when this snapshot starts a life (the prediction starts afresh rather than being checked). */
  receive(snapshot: WorldSnapshot, wall: number): boolean {
    this.snapshot = snapshot; this.received = wall;
    const local = this.local()!, self = snapshot.self!;
    const alive = local.health > 0 && local.connected, spawned = this.first || (!this.lastAlive && alive);
    const restarted = !spawned && local.lastInputSeq < this.lastAck;
    this.lastAck = local.lastInputSeq;
    const ranAt = self.lastInputTime ?? snapshot.serverTime;
    if (spawned) { this.first = false; this.weapon.reset(self, ranAt); }
    else if (restarted) this.weapon.reset(self, ranAt);
    else this.weapon.reconcile(self, local.lastInputSeq, ranAt);
    this.lastAlive = alive;
    this.prediction.receive({ ...local, ...self }, snapshot.serverTime, local.lastInputSeq,
      { playing: snapshot.phase === 'playing', alive, spawned, restarted }, wall);
    return spawned;
  }
}

/** One-way delays (ms) for each frame and each snapshot, how late the page's send timer and the
 * server's tick loop run, and when the page draws. */
interface Link { name: string; up(random: () => number): number; down(random: () => number): number; sendLate: number; tickLate(random: () => number): number }
const LINKS: Link[] = [
  { name: 'steady 40 ms link', up: () => 40, down: () => 40, sendLate: 0, tickLate: () => 0 },
  { name: '0-30 ms jitter', up: random => 30 + random() * 30, down: random => 30 + random() * 30, sendLate: 8, tickLate: random => random() * 2 },
  { name: '0-60 ms jitter and late timers', up: random => 40 + random() * 60, down: random => 40 + random() * 60, sendLate: 16, tickLate: random => random() * 4 },
  { name: '5% spikes of 150 ms', up: random => 40 + (random() < 0.05 ? 150 : random() * 10), down: random => 40 + random() * 10, sendLate: 16, tickLate: random => (random() < 0.02 ? 12 : random() * 2) },
];
const SEEDS = [1, 2, 3];
/** The first second is spent standing while the first snapshots arrive. */
const SETTLE = 30;

/** Decides frame `index` from the predicted body and its predicted server time, as a player
 * watching the screen does. */
type Script = (index: number, body: MoveState, time: number) => Partial<InputFrame>;
interface Outcome {
  /** The largest jump of the predicted body when a snapshot replaced the prediction (m), and where. */
  moved: number; movedAt: string;
  /** Weapon state a snapshot changed: the prediction had fired, reloaded or raised differently. */
  weapon: string[];
  /** The frames that fired, as predicted and on the server. */
  pageShots: number[]; serverShots: number[];
  snapshots: number;
}
type Simulate = (this: MatchEngine, player: PlayerState, rt: unknown, queued: { input: InputFrame }, now: number, tickNow: number, dt: number,
  actions: { shots: unknown[] }, real?: boolean) => void;
/** Notes the frame each of player a's shots goes off in (the shot event carries the tick's time,
 * not the frame's). Returns a function that stops noting. */
function noteShots(frames: number[]): () => void {
  const proto = MatchEngine.prototype as unknown as { simulate: Simulate }, simulate = proto.simulate;
  proto.simulate = function (player, rt, queued, now, tickNow, dt, actions, real = true) {
    const before = actions.shots.length;
    simulate.call(this, player, rt, queued, now, tickNow, dt, actions, real);
    if (player.id === 'a') for (let i = before; i < actions.shots.length; i++) frames.push(queued.input.seq);
  };
  return () => { proto.simulate = simulate; };
}

/** Plays `frames` frames of `script` over `link`. Every snapshot that arrives while the page is
 * still sending (a page in play never stops; a silent one is stood down by the server) is checked
 * against the prediction it replaces. */
function play(loadout: Loadout, setup: (a: PlayerState) => void, script: Script, frames: number, link: Link, seed: number): Outcome {
  const outcome: Outcome = { moved: 0, movedAt: '', weapon: [], pageShots: [], serverShots: [], snapshots: 0 };
  const stopNoting = noteShots(outcome.serverShots);
  try {
    const engine = new MatchEngine({ practiceSeed: 'server-parity' });
    for (const id of ['a', 'b']) engine.addPlayer({ id, name: id, color: '#fff' }, 0);
    assert.equal(engine.setLoadout('a', loadout), true);
    engine.start(0); engine.step(3000, 0);
    const a = engine.players.get('a')!, b = engine.players.get('b')!;
    for (const player of [a, b]) player.protectedUntil = 0;
    Object.assign(b, { x: 28, y: 0, z: 20, vx: 0, vy: 0, vz: 0 });
    setup(a);

    // Separate streams, so a change to one part of the link leaves the others' draws alone.
    const sends = seeded(seed * 4 + 1), ups = seeded(seed * 4 + 2), downs = seeded(seed * 4 + 3), ticks = seeded(seed * 4 + 4);
    const queue: Array<{ time: number; order: number; run: () => void }> = [];
    // At one instant: arrivals, then the server tick, then the page's send, then its drawn frame.
    const at = (time: number, order: number, run: () => void) => {
      let index = queue.length;
      while (index > 0 && (queue[index - 1]!.time > time || (queue[index - 1]!.time === time && queue[index - 1]!.order > order))) index--;
      queue.splice(index, 0, { time, order, run });
    };
    const page = new Page(loadout), end = 3000 + (frames + 20) * TICK + 400;
    let newest: WorldSnapshot | null = null, adopted: WorldSnapshot | null = null;

    // The server: ticks carry their scheduled times (server/app.ts TickSchedule); frames are stamped
    // with the whole millisecond they arrive.
    let scheduled = 3000, ran = 3000, delivered = -Infinity;
    for (let n = 1; scheduled + TICK <= end; n++) {
      scheduled += TICK; ran = Math.max(ran, scheduled + link.tickLate(ticks));
      const tickTime = scheduled, wall = ran, snapshotDue = n % 2 === 0;
      at(wall, 1, () => {
        engine.step(tickTime, TICK / 1000);
        if (!snapshotDue) return;
        const snapshot = engine.snapshot(tickTime, 'a');
        delivered = Math.max(delivered, wall + link.down(downs));
        at(delivered, 0, () => { newest = snapshot; });
      });
    }
    // The page: exactly 30 frames a second on average (src/components/gameInput.ts InputPacer).
    const start = 3000 + sends() * TICK;
    let sent = -Infinity, arrived = -Infinity;
    for (let index = 0; index < frames; index++) {
      sent = Math.max(sent, start + index * TICK + sends() * link.sendLate);
      const wall = sent;
      at(wall, 2, () => {
        const frame: InputFrame = { ...idleInput(index + 1), ...script(index, page.prediction.movement.state, page.prediction.movement.time) };
        for (const event of page.send(frame, wall)) if (event.type === 'shot') outcome.pageShots.push(frame.seq);
        arrived = Math.max(arrived, wall + link.up(ups));
        const viewTime = Math.max(0, Math.round(page.serverTime(wall) - 100)), arrival = arrived;
        at(arrival, 0, () => { engine.acceptInput('a', { ...frame, viewTime }, Math.floor(arrival)); });
      });
    }
    // Drawn frames at 60 Hz adopt the newest snapshot.
    const drawPhase = sends() * 16;
    for (let index = 0; 3000 + drawPhase + index * 1000 / 60 <= end; index++) {
      const wall = 3000 + drawPhase + index * 1000 / 60;
      at(wall, 3, () => {
        const snapshot = newest;
        if (!snapshot || snapshot === adopted) return;
        adopted = snapshot;
        const body = { ...page.prediction.movement.state }, weapon = structuredClone(page.weapon.state);
        if (page.receive(snapshot, wall)) return;
        const ack = snapshot.self!.lastInputSeq;
        if (ack <= SETTLE || ack >= frames) return;
        outcome.snapshots++;
        const after = page.prediction.movement.state;
        const moved = Math.hypot(after.x - body.x, after.y - body.y, after.z - body.z);
        if (moved > outcome.moved) {
          outcome.moved = moved;
          outcome.movedAt = `snapshot acknowledging frame ${ack} (${body.posture}${body.vault ? ', vaulting' : ''} → ${after.posture}${after.vault ? ', vaulting' : ''})`;
        }
        const now = page.weapon.state, differences: string[] = [];
        for (const key of ['slot', 'frags', 'reloadSlot'] as const) if (now[key] !== weapon[key]) differences.push(`${key} ${weapon[key]} → ${now[key]}`);
        for (const key of ['mag', 'reserve'] as const) if (now[key][0] !== weapon[key][0] || now[key][1] !== weapon[key][1]) differences.push(`${key} ${weapon[key]} → ${now[key]}`);
        // Timers arrive to the microsecond.
        for (const key of ['readyAt', 'meleeUntil', 'reloadingUntil', 'cookingSince'] as const) if (Math.abs(now[key] - weapon[key]) > 0.01) differences.push(`${key} ${weapon[key].toFixed(3)} → ${now[key].toFixed(3)}`);
        if (differences.length) outcome.weapon.push(`frame ${ack}: ${differences.join(', ')}`);
      });
    }
    while (queue.length) queue.shift()!.run();
  } finally { stopNoting(); }
  return outcome;
}

/** The page predicted exactly the frames that fired on the server. */
function sameShots(outcome: Outcome, label: string) {
  const server = new Set(outcome.serverShots), page = new Set(outcome.pageShots);
  const pageOnly = outcome.pageShots.filter(seq => !server.has(seq)), serverOnly = outcome.serverShots.filter(seq => !page.has(seq));
  assert.ok(outcome.serverShots.length > 0, `${label}: setup, the server fired`);
  assert.ok(!pageOnly.length && !serverOnly.length,
    `${label}: ${outcome.pageShots.length} predicted shots, ${outcome.serverShots.length} on the server; predicted only in frames ${pageOnly.slice(0, 8).join(', ')}; on the server only in frames ${serverOnly.slice(0, 8).join(', ')}`);
}

const barrier = OBSTACLES.find(box => box.id === 'west-lane-barrier')!;
const barrierFront = barrier.z - barrier.d / 2;

interface Run { frames: number; setup: (a: PlayerState) => void; script: Script; check: (label: string) => void }
/** Counts the slides the predicted body starts, and when the last one ended (frames after SETTLE). */
function slideCounter() {
  const counter = { slides: 0, sliding: false, endedAt: -1, see(k: number, body: MoveState) {
    if (body.posture === 'slide' && !counter.sliding) counter.slides++;
    if (counter.sliding && body.posture !== 'slide') counter.endedAt = k;
    counter.sliding = body.posture === 'slide';
  } };
  return counter;
}

/** Sprint at the west-lane barrier, slide, jump out of the slide, vault the barrier on the first
 * grounded frame within reach (judged on the predicted body), land and stop short of the parked car. */
function barrierRun(): Run {
  const counter = slideCounter();
  let vaulted = false, landed = false;
  const script: Script = (index, body) => {
    const k = index - SETTLE, run = { moveZ: 1, sprint: true };
    if (k < 0) return {};
    counter.see(k, body);
    if (body.vault) vaulted = true;
    else if (vaulted && isPlayerGrounded(body)) landed = true;
    if (k < 8) return run;
    if (k <= 11) return { ...run, crouch: true };
    if (k === 12) return { ...run, jump: true };
    if (!vaulted) return barrierFront - body.z - PLAYER_RADIUS < 0.55 && isPlayerGrounded(body) ? { ...run, jump: true } : run;
    return landed ? {} : run;
  };
  return {
    frames: SETTLE + 75,
    setup: a => { Object.assign(a, { x: barrier.x, y: 0, z: 0.5, vx: 0, vy: 0, vz: 0, yaw: Math.PI }); },
    script: (index, body, time) => ({ yaw: Math.PI, ...script(index, body, time) }),
    check: label => assert.ok(counter.slides === 1 && vaulted && landed, `${label}: setup, the page slid ${counter.slides} times, vaulted ${vaulted}, landed ${landed}`),
  };
}

/** Down the open street: a slide held to its full 800 ms, a slide pressed on the very frame the
 * cooldown runs out (let go of crouch while sliding), a dash, a jump, a slide pressed on landing,
 * and another slide on the cooldown's last frame. Every slide here ends, and every cooldown runs
 * out, exactly on a frame. */
function streetRun(): Run {
  const counter = slideCounter();
  const script: Script = (index, body, time) => {
    const k = index - SETTLE, run = { moveZ: 1, sprint: true };
    if (k < 0) return {};
    counter.see(k, body);
    // The next frame is the first on which the cooldown has run out.
    const cooled = reached(time + TICK, body.slideCooldownUntil) && !reached(time, body.slideCooldownUntil);
    if (counter.sliding) return { ...run, crouch: counter.slides !== 2 };
    switch (counter.slides) {
      case 0: return { ...run, crouch: k >= 10 };
      case 1: case 3: return { ...run, crouch: cooled };
      case 2: {
        // Dash, jump, and press crouch on the first frame back on the ground.
        const since = k - counter.endedAt;
        return since < 15 ? { ...run, dash: true } : since === 15 ? { ...run, dash: true, jump: true } : { ...run, crouch: since > 18 && isPlayerGrounded(body) };
      }
      default: return {};
    }
  };
  return {
    frames: SETTLE + 190,
    setup: a => { Object.assign(a, { x: -28, y: 0, z: -20, vx: 0, vy: 0, vz: 0, yaw: Math.PI / 2 }); },
    script: (index, body, time) => ({ yaw: Math.PI / 2, ...script(index, body, time) }),
    check: label => assert.equal(counter.slides, 4, `${label}: setup, the page slid four times`),
  };
}

for (const [name, route] of [['A slide, a slide jump and a vault at the barrier', barrierRun], ['Full-length slides, slides on the cooldown\'s last frame, a dash and a landing slide', streetRun]] as const) {
  test(`${name}: every snapshot agrees with the predicted body on every link`, () => {
    for (const link of LINKS) for (const seed of SEEDS) {
      const run = route(), label = `${link.name}, seed ${seed}`;
      const outcome = play(LOADOUT_PRESETS.assault, run.setup, run.script, run.frames, link, seed);
      run.check(label);
      assert.ok(outcome.snapshots > 15, `${label}: setup, ${outcome.snapshots} snapshots checked`);
      // A one-frame timer difference moves a sliding or vaulting body 15-30 cm.
      assert.ok(outcome.moved < 0.01, `${label}: the body jumped ${(outcome.moved * 100).toFixed(2)} cm at the ${outcome.movedAt}`);
    }
  });
}

/** Standing in the open street facing down it: bursts, taps, a swap and back, a reload, firing
 * again, the knife, then a cooked frag thrown far away. */
function firingRoutine(steps: Array<[frames: number, changes: Partial<InputFrame>]>): { frames: number; setup: (a: PlayerState) => void; script: Script } {
  const timeline: Array<Partial<InputFrame>> = [];
  for (const [count, changes] of steps) for (let i = 0; i < count; i++) timeline.push(changes);
  return {
    frames: SETTLE + timeline.length,
    setup: a => { Object.assign(a, { x: -28, y: 0, z: -20, vx: 0, vy: 0, vz: 0, yaw: Math.PI / 2, pitch: 0.1 }); },
    script: index => ({ yaw: Math.PI / 2, pitch: 0.1, ...(index < SETTLE ? {} : timeline[index - SETTLE]) }),
  };
}
const tap = (count: number, every: number, changes: Partial<InputFrame> = {}): Array<[number, Partial<InputFrame>]> =>
  Array.from({ length: count }, () => [[1, { ...changes, fire: true }], [every - 1, changes]] as Array<[number, Partial<InputFrame>]>).flat();

const ROUTINES: Array<{ name: string; loadout: Loadout; steps: Array<[number, Partial<InputFrame>]> }> = [
  {
    name: 'KR-5 Carbine', loadout: LOADOUT_PRESETS.assault, steps: [
      [40, { fire: true }], [5, {}], [25, { fire: true }], [3, {}],
      [1, { slot: 2 }], [12, { slot: 2 }], ...tap(5, 5, { slot: 2 }), [1, {}], [20, {}],
      [60, { fire: true }], [2, {}], [1, { reload: true }], [80, {}], [30, { fire: true }],
      [10, { moveZ: 1, sprint: true }], [20, { fire: true }],
      [1, { melee: true }], [20, {}], [12, { grenade: true, pitch: 0.4 }], [30, {}],
    ],
  },
  { name: 'Hornet 9', loadout: LOADOUT_PRESETS.close, steps: [[50, { fire: true }], [4, {}], [30, { fire: true }], [10, { moveZ: 1, sprint: true }], [40, { fire: true }], [1, { reload: true }], [80, {}], [20, { fire: true }]] },
  { name: 'Heron 7', loadout: LOADOUT_PRESETS.marksman, steps: [...tap(5, 40, { aim: true }), [1, { slot: 2 }], ...tap(4, 6, { slot: 2 }), [1, {}], [30, {}], [12, { aim: true, fire: true }], [40, {}]] },
  { name: 'Breaker 12 shotgun', loadout: { ...LOADOUT_PRESETS.close, primary: 'breaker12' }, steps: [...tap(4, 30), [1, { reload: true }], [60, {}], [1, { fire: true }], [40, {}], ...tap(3, 25)] },
];

for (const routine of ROUTINES) {
  test(`${routine.name}: the predicted shots, ammunition and timers match the server's on every link`, () => {
    for (const link of LINKS) for (const seed of SEEDS) {
      const run = firingRoutine(routine.steps), label = `${routine.name}, ${link.name}, seed ${seed}`;
      const outcome = play(routine.loadout, run.setup, run.script, run.frames, link, seed);
      assert.ok(outcome.snapshots > 60, `${label}: setup, ${outcome.snapshots} snapshots checked`);
      assert.deepEqual(outcome.weapon, [], `${label}: a snapshot changed the predicted weapon`);
      sameShots(outcome, label);
      assert.ok(outcome.moved < 0.01, `${label}: the body jumped ${(outcome.moved * 100).toFixed(2)} cm at the ${outcome.movedAt}`);
    }
  });
}
