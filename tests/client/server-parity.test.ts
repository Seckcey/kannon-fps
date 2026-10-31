import assert from 'node:assert/strict';
import test from 'node:test';
import { idleInput, MatchEngine } from '../../server/engine';
import { OBSTACLES } from '../../shared/map';
import { isPlayerGrounded, PLAYER_RADIUS, reached, type MoveState } from '../../shared/physics';
import { type GameEvent, type InputFrame, type Loadout, type PlayerState, type WorldSnapshot } from '../../shared/protocol';
import { LOADOUT_PRESETS } from '../../shared/weapons';
import { InputPacer } from '../../src/components/gameInput';
import { LocalPlayer } from '../../src/game/LocalPlayer';

/* The real server engine and the page's real LocalPlayer (GameView's prediction of its body and
 * weapon), joined by real snapshots over a link with delay and jitter, as the game runs them: the
 * page sends through the real InputPacer (30 frames a second, at most two per timer wake, a stalled
 * page skipping what it missed), the server ticks on its exact 30 Hz schedule (running a little late
 * now and then) and sends a snapshot every other tick, and the page adopts the newest snapshot on its
 * next drawn frame. Whenever a snapshot replaces the prediction, the predicted body and weapon must
 * not move: the server ran every acknowledged frame exactly as the page predicted it. */

const TICK = 1000 / 30;
/** The match goes live here; links and scenarios count from it. */
const LIVE = 3000;
/** A tiny seeded generator so every run is the same. */
function seeded(seed: number) {
  return () => { seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0; return ((seed ^ (seed >>> 13)) >>> 0) / 4294967296; };
}

/** GameView without drawing: frames go through LocalPlayer as GameView.recordInput sends them, and a
 * snapshot is adopted as GameView.receiveSnapshot adopts it (its new-life rule and live window). */
class Page {
  readonly player: LocalPlayer;
  snapshot: WorldSnapshot | null = null;
  private received = -Infinity;
  private lastAlive = false;
  private first = true;
  constructor(loadout: Loadout) { this.player = new LocalPlayer(loadout); }
  /** GameView.inputLive: frames go out only while alive with the spawn view applied. */
  get inputLive() { return this.lastAlive; }
  local() { return this.snapshot?.players.find(player => player.id === 'a'); }
  private playing() {
    const local = this.local();
    return !!local && this.player.prediction.active && this.snapshot?.phase === 'playing' && local.health > 0 && local.connected;
  }
  serverTime(wall: number) { return this.snapshot ? this.snapshot.serverTime + wall - this.received : 0; }
  send(frame: InputFrame, wall: number) {
    const playing = this.playing();
    return this.player.send(frame, wall, !!this.snapshot && wall - this.received < 500 && playing, playing, 0).events;
  }
  /** Returns true when this snapshot starts a life (the prediction starts afresh rather than being checked). */
  receive(snapshot: WorldSnapshot, wall: number): boolean {
    this.snapshot = snapshot; this.received = wall;
    const local = this.local()!, self = snapshot.self!;
    const alive = local.health > 0 && local.connected, spawned = this.first || (!this.lastAlive && alive);
    this.first = false; this.lastAlive = alive;
    this.player.receive(snapshot, local, self, spawned, wall);
    return spawned;
  }
}

/** One-way delays (ms) for each frame and each snapshot, how late the page's send timer and the
 * server's tick loop wake, and when the page's main thread is blocked (no sends, no drawn frames).
 * Times count from LIVE. */
interface Link {
  name: string; up(random: () => number, sent: number): number; down(random: () => number): number;
  sendLate: number; tickLate(random: () => number): number; stalls?: Array<[start: number, length: number]>;
}
const LINKS: Link[] = [
  { name: 'steady 40 ms link', up: () => 40, down: () => 40, sendLate: 0, tickLate: () => 0 },
  { name: '0-30 ms jitter', up: random => 30 + random() * 30, down: random => 30 + random() * 30, sendLate: 8, tickLate: random => random() * 2 },
  { name: '0-60 ms jitter and late timers', up: random => 40 + random() * 60, down: random => 40 + random() * 60, sendLate: 16, tickLate: random => random() * 4 },
  { name: '5% spikes of 150 ms', up: random => 40 + (random() < 0.05 ? 150 : random() * 10), down: random => 40 + random() * 10, sendLate: 16, tickLate: random => (random() < 0.02 ? 12 : random() * 2) },
  // A shorter route after 3 s: frames arrive 100 ms earlier and the server slews this player's clock back.
  { name: 'an uplink that drops from 140 to 40 ms', up: (random, sent) => (sent < 3000 ? 140 : 40) + random() * 4, down: random => 40 + random() * 4, sendLate: 4, tickLate: random => random() * 2 },
  // The pacer skips the frames a stalled page missed, so the frames after run late and the server slews the clock on.
  { name: '140 ms page stalls', up: random => 40 + random() * 4, down: random => 40 + random() * 4, sendLate: 4, tickLate: random => random() * 2, stalls: [[1700, 140], [4200, 140], [6700, 140]] },
];
const SEEDS = [1, 2, 3];
/** The first second is spent standing while the first snapshots arrive. */
const SETTLE = 30;

/** Decides frame `index` from the predicted body and its predicted server time, as a player
 * watching the screen does. */
type Script = (index: number, body: MoveState, time: number) => Partial<InputFrame>;
interface Mismatch { wall: number; ack: number; text: string }
interface Outcome {
  /** Snapshots that moved the predicted body by a millimetre or more, and that changed the predicted weapon. */
  body: Array<Mismatch & { cm: number }>; weapon: Mismatch[];
  /** The frames that fired, and that threw a frag or let it go off in hand, as predicted and on the server. */
  pageShots: number[]; serverShots: number[]; pageThrows: string[]; serverThrows: string[];
  /** Frames the server ran (a frame that reaches it after its player went down never runs), and the first frame of each new life. */
  serverFrames: Set<number>; lives: number[];
  snapshots: number;
}
interface Scenario {
  /** The page's own player dies this long after LIVE, as if shot. */
  killAt?: number;
  /** Frames the page sends in this window (after LIVE) reach the server only when it ends. */
  uplinkStall?: [start: number, length: number];
  /** Stop sending and checking once the page's player goes down. */
  firstLifeOnly?: boolean;
}
type Simulate = (this: MatchEngine, player: PlayerState, rt: unknown, queued: { input: InputFrame }, now: number, tickNow: number, dt: number,
  actions: { shots: unknown[]; blasts: unknown[] }, real?: boolean) => void;

/** Plays `frames` frames of `script` over `link`. Every snapshot the page adopts while its player is
 * alive and still sending (a page in play never stops; a silent one is stood down by the server) is
 * checked against the prediction it replaces. */
function play(loadout: Loadout, setup: (a: PlayerState) => void, script: Script, frames: number, link: Link, seed: number, scenario: Scenario = {}): Outcome {
  const outcome: Outcome = { body: [], weapon: [], pageShots: [], serverShots: [], pageThrows: [], serverThrows: [], serverFrames: new Set(), lives: [], snapshots: 0 };
  const events: GameEvent[] = [];
  // What each of player a's frames did on the server (shot events carry the tick's time, not the frame's).
  const proto = MatchEngine.prototype as unknown as { simulate: Simulate }, simulate = proto.simulate;
  proto.simulate = function (player, rt, queued, now, tickNow, dt, actions, real = true) {
    const shots = actions.shots.length, blasts = actions.blasts.length, emitted = events.length;
    simulate.call(this, player, rt, queued, now, tickNow, dt, actions, real);
    if (player.id !== 'a' || !real) return;
    outcome.serverFrames.add(queued.input.seq);
    for (let i = shots; i < actions.shots.length; i++) outcome.serverShots.push(queued.input.seq);
    if (events.slice(emitted).some(event => event.type === 'grenade')) outcome.serverThrows.push(`${queued.input.seq} thrown`);
    if (actions.blasts.length > blasts) outcome.serverThrows.push(`${queued.input.seq} in hand`);
  };
  try {
    const engine = new MatchEngine({ practiceSeed: 'server-parity', onEvent: event => events.push(event) });
    for (const id of ['a', 'b']) engine.addPlayer({ id, name: id, color: '#fff' }, 0);
    assert.equal(engine.setLoadout('a', loadout), true);
    engine.start(0); engine.step(LIVE, 0);
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
    // A blocked main thread runs nothing until the stall ends.
    const unblocked = (wall: number) => {
      for (const [start, length] of link.stalls ?? []) if (wall >= LIVE + start && wall < LIVE + start + length) return LIVE + start + length;
      return wall;
    };
    const page = new Page(loadout), end = LIVE + (frames + 40) * TICK + 6000;
    let newest: WorldSnapshot | null = null, adopted: WorldSnapshot | null = null, sent = 0, killed = false, died = false;

    // The server: ticks carry their scheduled times (server/app.ts TickSchedule); frames are stamped
    // with the whole millisecond they arrive.
    let scheduled = LIVE, ran = LIVE, delivered = -Infinity;
    for (let n = 1; scheduled + TICK <= end; n++) {
      scheduled += TICK; ran = Math.max(ran, scheduled + link.tickLate(ticks));
      const tickTime = scheduled, wall = ran, snapshotDue = n % 2 === 0;
      at(wall, 1, () => {
        if (scenario.killAt !== undefined && !killed && tickTime >= LIVE + scenario.killAt) { killed = true; engine.damage(a, b, 1000, tickTime); }
        engine.step(tickTime, TICK / 1000);
        if (!snapshotDue) return;
        const snapshot = engine.snapshot(tickTime, 'a');
        delivered = Math.max(delivered, wall + link.down(downs));
        at(delivered, 0, () => { newest = snapshot; });
      });
    }
    // The page's send timer (GameScreen): take what the pacer says is due, set the next wake, then send.
    const pacer = new InputPacer();
    let arrived = -Infinity;
    const wake = (wall: number) => {
      const due = pacer.take(wall);
      const next = unblocked(wall + pacer.wait(wall) + sends() * link.sendLate);
      if (sent < frames && next <= end) at(next, 2, () => wake(next));
      for (let i = 0; i < due && sent < frames && page.inputLive && !(died && scenario.firstLifeOnly); i++) {
        const frame: InputFrame = { ...idleInput(++sent), ...script(sent - 1, page.player.prediction.movement.state, page.player.prediction.movement.time) };
        for (const event of page.send(frame, wall)) {
          if (event.type === 'shot') outcome.pageShots.push(frame.seq);
          if (event.type === 'throw') outcome.pageThrows.push(`${frame.seq} ${event.inHand ? 'in hand' : 'thrown'}`);
        }
        const stall = scenario.uplinkStall, held = stall && wall >= LIVE + stall[0] && wall < LIVE + stall[0] + stall[1] ? LIVE + stall[0] + stall[1] : wall;
        arrived = Math.max(arrived, held + link.up(ups, wall - LIVE));
        const viewTime = Math.max(0, Math.round(page.serverTime(wall) - 100)), arrival = arrived;
        at(arrival, 0, () => { engine.acceptInput('a', { ...frame, viewTime }, Math.floor(arrival)); });
      }
    };
    const first = LIVE + sends() * TICK;
    at(first, 2, () => wake(first));
    // Drawn frames at 60 Hz adopt the newest snapshot.
    const drawPhase = sends() * 16;
    for (let index = 0; LIVE + drawPhase + index * 1000 / 60 <= end; index++) {
      const wall = LIVE + drawPhase + index * 1000 / 60;
      if (unblocked(wall) !== wall) continue;
      at(wall, 3, () => {
        const snapshot = newest;
        if (!snapshot || snapshot === adopted) return;
        adopted = snapshot;
        const body = { ...page.player.prediction.movement.state }, weapon = structuredClone(page.player.weapon.state);
        const clock = page.player.prediction.movement.time;
        if (page.receive(snapshot, wall)) { if (sent > SETTLE) outcome.lives.push(sent + 1); return; }
        const ack = snapshot.self!.lastInputSeq;
        if (page.local()!.health <= 0) died = true;
        if (ack <= SETTLE || ack >= sent && sent >= frames || page.local()!.health <= 0 || (died && scenario.firstLifeOnly)) return;
        outcome.snapshots++;
        const after = page.player.prediction.movement.state;
        const moved = Math.hypot(after.x - body.x, after.y - body.y, after.z - body.z);
        if (moved >= 0.001) outcome.body.push({ wall, ack, cm: moved * 100, text: `${body.posture}${body.vault ? ', vaulting' : ''} → ${after.posture}${after.vault ? ', vaulting' : ''}` });
        const now = page.player.weapon.state, differences: string[] = [];
        for (const key of ['slot', 'frags', 'reloadSlot', 'triggerPending'] as const) if (now[key] !== weapon[key]) differences.push(`${key} ${weapon[key]} → ${now[key]}`);
        for (const key of ['mag', 'reserve'] as const) if (now[key][0] !== weapon[key][0] || now[key][1] !== weapon[key][1]) differences.push(`${key} ${weapon[key]} → ${now[key]}`);
        // Timers count from the predicted clock of the newest frame (which the snapshot may move, along with every
        // timer, when the server moved this player's clock), and arrive to the microsecond.
        const shift = page.player.prediction.movement.time - clock, set = (ms: number) => ms !== 0 && Number.isFinite(ms);
        const timers: Array<[string, number, number]> = [
          ['readyAt', weapon.readyAt, now.readyAt], ['meleeUntil', weapon.meleeUntil, now.meleeUntil], ['reloadingUntil', weapon.reloadingUntil, now.reloadingUntil],
          ['cookingSince', weapon.cookingSince, now.cookingSince], ['lastSprintAt', weapon.lastSprintAt, now.lastSprintAt],
          ['nextFireAt 1', weapon.nextFireAt[0], now.nextFireAt[0]], ['nextFireAt 2', weapon.nextFireAt[1], now.nextFireAt[1]],
        ];
        for (const [key, before, after] of timers) {
          if (set(before) !== set(after) || (set(before) && !(Math.abs(after - shift - before) <= 0.01))) differences.push(`${key} ${before.toFixed(3)} → ${after.toFixed(3)} (clock ${shift.toFixed(3)})`);
        }
        if (differences.length) outcome.weapon.push({ wall, ack, text: differences.join(', ') });
      });
    }
    while (queue.length) queue.shift()!.run();
  } finally { proto.simulate = simulate; }
  return outcome;
}

const describe = (list: Mismatch[]) => list.slice(0, 4).map(entry => `frame ${entry.ack}: ${entry.text}`).join('; ');
/** What to leave out: snapshots adopted before wall time `from`, shots before frame `firstFrame`, and the first
 * `grace` frames of each new life. */
interface Skip { from?: number; firstFrame?: number; grace?: number }
const inGrace = (outcome: Outcome, seq: number, grace: number) => outcome.lives.some(first => seq >= first && seq < first + grace);
/** No snapshot moved the predicted body by a centimetre or changed the predicted weapon. */
function agrees(outcome: Outcome, label: string, { from = -Infinity, grace = 0 }: Skip = {}) {
  const kept = (entry: Mismatch) => entry.wall >= from && !inGrace(outcome, entry.ack, grace);
  const body = outcome.body.filter(entry => kept(entry) && entry.cm >= 1), weapon = outcome.weapon.filter(kept);
  assert.deepEqual(body.map(entry => `frame ${entry.ack}: ${entry.cm.toFixed(2)} cm (${entry.text})`), [], `${label}: the body jumped`);
  assert.equal(describe(weapon), '', `${label}: a snapshot changed the predicted weapon`);
}
/** The page predicted exactly the frames that fired on the server, among the frames the server ran. */
function sameShots(outcome: Outcome, label: string, { firstFrame = 0, grace = 0 }: Skip = {}) {
  const kept = (seq: number) => seq >= firstFrame && outcome.serverFrames.has(seq) && !inGrace(outcome, seq, grace);
  const pageShots = outcome.pageShots.filter(kept), serverShots = outcome.serverShots.filter(kept);
  const server = new Set(serverShots), page = new Set(pageShots);
  const pageOnly = pageShots.filter(seq => !server.has(seq)), serverOnly = serverShots.filter(seq => !page.has(seq));
  assert.ok(serverShots.length > 0, `${label}: setup, the server fired`);
  assert.ok(!pageOnly.length && !serverOnly.length,
    `${label}: ${pageShots.length} predicted shots, ${serverShots.length} on the server; predicted only in frames ${pageOnly.slice(0, 8).join(', ')}; on the server only in frames ${serverOnly.slice(0, 8).join(', ')}`);
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
      agrees(outcome, label);
    }
  });
}

/** Standing in the open street facing down it, the routine's frames after the first second. */
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

/** Bursts, taps, a swap and back, a reload, firing again, sprint-to-fire, the knife and a cooked frag
 * thrown far away; Quick Hands (Close Quarters, Marksman) puts many timers between frames. */
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
  { name: 'Hornet 9', loadout: LOADOUT_PRESETS.close, steps: [[50, { fire: true }], [4, {}], [30, { fire: true }], [10, { moveZ: 1, sprint: true }], [40, { fire: true }], [1, { reload: true }], [80, {}], [20, { fire: true }], [6, { moveZ: 1, sprint: true, dash: true }], [30, { fire: true }]] },
  { name: 'Heron 7', loadout: LOADOUT_PRESETS.marksman, steps: [...tap(5, 40, { aim: true }), [1, { slot: 2 }], ...tap(4, 6, { slot: 2 }), [1, {}], [30, {}], [12, { aim: true, fire: true }], [40, {}]] },
  { name: 'Breaker 12 shotgun', loadout: { ...LOADOUT_PRESETS.close, primary: 'breaker12' }, steps: [...tap(4, 30), [1, { reload: true }], [60, {}], [1, { fire: true }], [40, {}], ...tap(3, 25), [1, { reload: true }], [20, {}], [1, { slot: 2 }], [30, { slot: 2 }]] },
];

for (const routine of ROUTINES) {
  test(`${routine.name}: the predicted shots, ammunition and timers match the server's on every link`, () => {
    for (const link of LINKS) for (const seed of SEEDS) {
      const run = firingRoutine(routine.steps), label = `${routine.name}, ${link.name}, seed ${seed}`;
      const outcome = play(routine.loadout, run.setup, run.script, run.frames, link, seed);
      assert.ok(outcome.snapshots > 60, `${label}: setup, ${outcome.snapshots} snapshots checked`);
      agrees(outcome, label);
      sameShots(outcome, label);
    }
  });
}

// Until a new life's frames stream (about eight), the server runs them on the tick's clock: on a steady link that
// is exactly where the page predicts them, while jitter that brings two in one tick can put a timer a frame apart
// until the next snapshot carries the server's clock and timers.
test('a new life fires from its first frames: exactly on a steady link, and on every link once its frames stream', () => {
  for (const [name, loadout] of [['Hornet 9 with Quick Hands', LOADOUT_PRESETS.close], ['KR-5', LOADOUT_PRESETS.assault]] as const) {
    for (const link of LINKS) for (const seed of SEEDS) {
      // The trigger is held in bursts throughout; the player is shot down mid-burst and holds it again from the respawn.
      const run = firingRoutine(Array.from({ length: 12 }, () => [[30, { fire: true }], [6, {}]] as Array<[number, Partial<InputFrame>]>).flat());
      const label = `${name}, ${link.name}, seed ${seed}`;
      const outcome = play(loadout, run.setup, run.script, run.frames, link, seed, { killAt: 2500 });
      const skip = { grace: link === LINKS[0] ? 0 : 15 };
      assert.equal(outcome.lives.length, 1, `${label}: setup, one new life`);
      agrees(outcome, label, skip);
      sameShots(outcome, label, skip);
    }
  }
});

test('after a 450 ms uplink stall mid-burst, the prediction is back in step within half a second', () => {
  for (const link of LINKS.slice(0, 4)) for (const seed of SEEDS) {
    const run = firingRoutine(Array.from({ length: 8 }, () => [[40, { fire: true }], [5, {}]] as Array<[number, Partial<InputFrame>]>).flat());
    const label = `Hornet 9, ${link.name}, seed ${seed}`;
    const outcome = play(LOADOUT_PRESETS.close, run.setup, run.script, run.frames, link, seed, { uplinkStall: [3000, 450] });
    // The server stood the silent player down and ran the backlog as it came; everything after settles.
    agrees(outcome, label, { from: LIVE + 3000 + 450 + 500 });
    sameShots(outcome, label, { firstFrame: Math.ceil((3000 + 450 + 500) / TICK) });
  }
});

test('a frag let go on the fuse\'s last frames is thrown on both sides, and one held through the fuse goes off in hand on the same frame', () => {
  // The fuse is 3.4 s, exactly 102 frames: the cook starts on the first held frame.
  for (const [held, outcomeName] of [[100, 'thrown'], [101, 'thrown'], [102, 'thrown'], [103, 'in hand'], [110, 'in hand']] as const) {
    for (const link of LINKS) for (const seed of SEEDS) {
      const run = firingRoutine([[held, { grenade: true, pitch: 0.5 }], [20, {}]]);
      const label = `held ${held} frames, ${link.name}, seed ${seed}`;
      const outcome = play(LOADOUT_PRESETS.assault, run.setup, run.script, run.frames, link, seed, { firstLifeOnly: true });
      assert.equal(outcome.pageThrows.length, 1, `${label}: setup, ${outcome.pageThrows.join(', ')}`);
      assert.ok(outcome.pageThrows[0]!.endsWith(outcomeName), `${label}: ${outcome.pageThrows[0]}`);
      assert.deepEqual(outcome.serverThrows, outcome.pageThrows, `${label}: the frag left on the same frame, the same way`);
      agrees(outcome, label);
    }
  }
});
