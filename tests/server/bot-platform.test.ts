import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { BOT_SETTINGS, BotNavigation, PracticeBots, PRACTICE_RIVALS } from '../../server/bots.js';
import * as engineModule from '../../server/engine.js';
import { ARENA_LIMITS, OBSTACLES, SPAWNS, STAIR_ROUTES } from '../../shared/map.js';
import { moveDefaults, movePlayer, MOVE, PLAYER_RADIUS, POSTURE_HEIGHT, spaceFree, supportHeight, type MoveState } from '../../shared/physics.js';
import {
  RULES, type GameEvent, type GameMode, type InputFrame, type Phase, type PlayerState, type PracticeDifficulty, type Profile, type Team, type Vec3, type WorldSnapshot,
} from '../../shared/protocol.js';
import { botLoadout, hasPerk, LOADOUT_PRESETS, weaponFor, WEAPONS, DEEP_POCKETS_EXTRA_MAGS } from '../../shared/weapons.js';

const DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
const TICK = 1000 / 30;
const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
const CHECKPOINT_COVER = ['west-lane-sandbags', 'east-lane-sandbags', 'west-lane-barrier', 'east-lane-barrier', 'north-centre-sandbags', 'south-centre-sandbags', 'teal-yard-sandbags', 'yellow-yard-sandbags'];

function penetrates(p: Vec3 & { posture?: MoveState['posture'] }): boolean {
  const height = POSTURE_HEIGHT[p.posture ?? 'stand'];
  return OBSTACLES.some(b => p.y < b.y + b.h / 2 - 0.01 && p.y + height > b.y - b.h / 2 + 0.01 &&
    p.x + PLAYER_RADIUS > b.x - b.w / 2 + 0.01 && p.x - PLAYER_RADIUS < b.x + b.w / 2 - 0.01 &&
    p.z + PLAYER_RADIUS > b.z - b.d / 2 + 0.01 && p.z - PLAYER_RADIUS < b.z + b.d / 2 - 0.01);
}
const frame = (patch: Partial<InputFrame> = {}): InputFrame => ({
  seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, fire: false, aim: false, jump: false, sprint: false, reload: false, slot: 1,
  crouch: false, dash: false, melee: false, grenade: false, streak: null, viewTime: 0, ...patch,
});
const body = (p: Vec3): MoveState => ({ x: p.x, y: p.y, z: p.z, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, ...moveDefaults() });
const rifle = WEAPONS.kr5;
/** Top speed of a full forward stick with the rifle, measured from the shared movement itself (on open street,
 * put back after every step), so these limits hold however the physics scales aimed speed. */
function topSpeed(patch: Partial<InputFrame>): number {
  const at = { x: 0, y: 0, z: -20 }, p = body(at);
  for (let i = 0; i < 30; i++) {
    movePlayer(p, frame({ moveZ: 1, ...patch }), { now: i * TICK, dt: 1 / 30, jumpPressed: false, crouchPressed: false, moveFactor: rifle.moveFactor, adsFactor: rifle.adsMoveFactor, canSprint: true });
    Object.assign(p, at);
  }
  return Math.hypot(p.vx, p.vz);
}
const SPEED = { aim: topSpeed({ aim: true }), walk: topSpeed({}), sprint: topSpeed({ sprint: true }) } as const;
/** Walks a navigation route with ordinary inputs, braking into each waypoint, and checks it never clips. */
function traverse(nav: BotNavigation, from: Vec3, to: Vec3, mode: keyof typeof SPEED, dt = 1 / 30) {
  const route = nav.findPath(from, to), p = body(from);
  let now = 0;
  assert.ok(route.length, `Missing route ${JSON.stringify({ from, to })}`);
  for (const goal of route) {
    let arrived = false;
    for (let tick = 0; tick < Math.ceil(20 / dt); tick++) {
      const length = distance(p, goal), before = { ...p };
      const wanted = Math.min(SPEED[mode], Math.sqrt(2 * 20 * length), length / dt), sprint = mode === 'sprint' && wanted >= SPEED.sprint * 0.98;
      now += dt * 1000;
      movePlayer(p, frame({ yaw: length > 1e-5 ? Math.atan2(goal.x - p.x, -(goal.z - p.z)) : p.yaw, moveZ: Math.min(1, wanted / (sprint ? SPEED.sprint : SPEED[mode === 'aim' ? 'aim' : 'walk'])), aim: mode === 'aim', sprint }),
        { now, dt, jumpPressed: false, crouchPressed: false, moveFactor: rifle.moveFactor, adsFactor: rifle.adsMoveFactor, canSprint: true });
      assert.ok(!penetrates(p), `Route penetrated a collider at ${JSON.stringify(p)}`);
      assert.ok(distance(p, before) <= SPEED[mode] * dt + 1e-6, 'Navigation may not exceed ordinary movement speed.');
      if (distance(p, goal) < 0.002 && Math.abs(p.y - goal.y) < 0.001 && Math.abs(p.vy) < 0.001) { arrived = true; break; }
    }
    assert.ok(arrived, `Unreachable waypoint ${JSON.stringify({ from, to, goal, p })}`);
  }
  assert.ok(distance(p, to) < 0.01 && Math.abs(p.y - to.y) < 0.001, 'The destination must keep its elevation.');
  return route;
}
function makePlayer(id: string, at: Vec3, patch: Partial<PlayerState> = {}): PlayerState {
  const loadout = patch.loadout ?? LOADOUT_PRESETS.assault;
  return {
    id, name: id, color: '#fff', x: at.x, y: at.y, z: at.z, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, ...moveDefaults(),
    health: RULES.health, slot: 1, weapon: loadout.primary, loadout, kills: 0, deaths: 0, assists: 0, score: 0, streak: 0,
    connected: true, respawnAt: 0, protectedUntil: 0, reloadingUntil: 0, cookingSince: 0, lastInputSeq: 0,
    mag: [WEAPONS[loadout.primary].magazine, WEAPONS[loadout.secondary].magazine], reserve: [120, 48], frags: 1, rewards: [], reloadSlot: 0,
    readyAt: 0, meleeUntil: 0, lastDamageAt: 0, ...patch,
  };
}
/** Applies a rival's frame with the shared movement rules (what MatchEngine does before combat). */
function drive(p: PlayerState, input: InputFrame, previous: InputFrame | undefined, now: number, dt = 1 / 30) {
  if (input.slot !== p.slot) Object.assign(p, { slot: input.slot, weapon: weaponFor(p.loadout, input.slot).id });
  const spec = weaponFor(p.loadout, p.slot);
  movePlayer(p, input, { now, dt, jumpPressed: input.jump && !previous?.jump, crouchPressed: input.crouch && !previous?.crouch, moveFactor: spec.moveFactor, adsFactor: spec.adsMoveFactor, canSprint: true });
}

test('all eight spawns reach both upstairs rooms and return through ordinary stair movement', () => {
  const nav = new BotNavigation();
  for (const x of [-13, 13]) for (const mode of ['aim', 'walk', 'sprint'] as const) for (const spawn of SPAWNS) {
    const upper = { x, y: 3.2, z: 0 };
    for (const route of [traverse(nav, spawn, upper, mode), traverse(nav, upper, spawn, mode)]) {
      for (let i = 1; i <= 9; i++) assert.ok(route.some(p => Math.abs(p.y - i * .32) < .001), `Missing stair level ${i}`);
    }
  }
});
test('all four stairwells and the open cargo entry work at variable frame rates and movement speeds', () => {
  const nav = new BotNavigation();
  for (const stair of STAIR_ROUTES) for (const dt of [1 / 90, 1 / 30, .1]) for (const mode of ['aim', 'walk', 'sprint'] as const) {
    traverse(nav, stair.approach, stair.exit, mode, dt);
    traverse(nav, stair.exit, stair.approach, mode, dt);
  }
});
test('navigation still reaches every room, floor, yard and the truck with the checkpoint cover in place', () => {
  const nav = new BotNavigation();
  for (const id of CHECKPOINT_COVER) assert.ok(OBSTACLES.some(b => b.id === id), `Missing cover ${id}`);
  const places: Record<string, Vec3> = {
    'teal front room': { x: -13, y: 0, z: 0 }, 'teal rear room': { x: -18.5, y: 0, z: 4.5 }, 'teal garage': { x: -14, y: 0, z: 9.5 }, 'teal upstairs': { x: -13, y: 3.2, z: 0 },
    'teal balcony': { x: -24, y: 3.2, z: 4.4 }, 'teal yard': { x: -28, y: 0, z: -8 }, 'yellow front room': { x: 13, y: 0, z: 0 }, 'yellow rear room': { x: 18.5, y: 0, z: 4.5 },
    'yellow garage': { x: 14, y: 0, z: 9.5 }, 'yellow upstairs': { x: 13, y: 3.2, z: 0 }, 'yellow balcony': { x: 24, y: 3.2, z: 4.4 }, 'yellow yard': { x: 28, y: 0, z: -8 },
    'truck cargo bed': { x: 2.65, y: 0.36, z: 8 }, 'north street': { x: 0, y: 0, z: -20 }, 'south street': { x: 0, y: 0, z: 20 },
  };
  for (const [name, place] of Object.entries(places)) {
    assert.ok(nav.isWalkable(place), `${name} must be walkable`);
    for (const spawn of [SPAWNS[0]!, SPAWNS[1]!]) {
      const route = traverse(nav, spawn, place, 'walk');
      assert.ok(route.length, `${name} must be reachable`);
    }
  }
  // Patrols visit both houses, both upper floors, the yards and the street.
  const regions: Array<[string, (p: Vec3) => boolean]> = [
    ['teal house', p => p.x < -10 && p.x > -22 && Math.abs(p.z) < 6], ['yellow house', p => p.x > 10 && p.x < 22 && Math.abs(p.z) < 6],
    ['teal upstairs', p => p.x < -10 && p.y > 3], ['yellow upstairs', p => p.x > 10 && p.y > 3], ['street', p => Math.abs(p.x) < 9],
    ['teal yard', p => p.x < -22], ['yellow yard', p => p.x > 22], ['truck', p => Math.abs(p.y - 0.36) < 0.01],
  ];
  for (const [name, inside] of regions) assert.ok(nav.patrolPoints.some(inside), `Patrols should cover the ${name}.`);
});
test('routes pass around the checkpoint sandbags and barriers instead of through them', () => {
  const nav = new BotNavigation();
  for (const id of CHECKPOINT_COVER) {
    const box = OBSTACLES.find(b => b.id === id)!, across = box.w < box.d ? 'x' : 'z', half = (across === 'x' ? box.w : box.d) / 2;
    // The nearest walkable spot straight out from each face.
    const side = (sign: number) => {
      for (let reach = half + 0.6; reach < half + 3; reach += 0.1) {
        const p = across === 'x' ? { x: box.x + sign * reach, y: 0, z: box.z } : { x: box.x, y: 0, z: box.z + sign * reach };
        if (nav.isWalkable(p)) return p;
      }
      assert.fail(`No walkable spot beside ${id}`);
    };
    const from = side(-1), to = side(1);
    assert.equal(nav.clearSegment(from, to), false, `${id} must block a straight line`);
    assert.ok(!nav.nodes.some(p => p.y < 0.5 && Math.abs(p.x - box.x) < box.w / 2 + PLAYER_RADIUS && Math.abs(p.z - box.z) < box.d / 2 + PLAYER_RADIUS), `${id} must hold no waypoint`);
    traverse(nav, from, to, 'sprint'); traverse(nav, to, from, 'walk');
  }
});
test('a rival resting against any wall, counter, stair side or vehicle has a route away that ordinary movement can walk', () => {
  // The physics leaves a body that walked into something touching it, at the body radius or a few millimetres off.
  // Every such spot on the ground, the truck bed and the upper floors needs a way out, including the narrow alley
  // beside the outside stairs and the pocket behind the kitchen counter.
  assert.ok(SPEED.aim < SPEED.walk && SPEED.walk < SPEED.sprint);
  const nav = new BotNavigation();
  let starts = 0;
  for (const level of [0, 0.36, 3.2]) for (const b of OBSTACLES) {
    if (b.y - b.h / 2 > level + 1.7 || b.y + b.h / 2 < level + 0.5) continue;
    for (const gap of [1e-9, 0.003]) for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const) {
      const p = { x: sx ? b.x + sx * (b.w / 2 + PLAYER_RADIUS + gap) : b.x, y: level, z: sz ? b.z + sz * (b.d / 2 + PLAYER_RADIUS + gap) : b.z };
      if (!spaceFree(p, POSTURE_HEIGHT.stand) || Math.abs(supportHeight(p) - level) > 1e-6 || nav.isWalkable(p)) continue;
      starts++;
      traverse(nav, p, level > 1 ? { x: Math.sign(p.x) * 13, y: 3.2, z: 0 } : { x: 0, y: 0, z: -20 }, 'walk');
    }
  }
  assert.ok(starts > 1000, `only ${starts} resting spots were checked`);
});
test('navigation cannot climb walls, cross the stairwell void, leave a balcony or route onto a bus roof', () => {
  const nav = new BotNavigation();
  for (const [a, b] of [
    [{ x: -8, y: 0, z: 0 }, { x: -13, y: 3.2, z: 0 }],
    [{ x: -17, y: 3.2, z: 0 }, { x: -21, y: 3.2, z: 0 }],
    [{ x: -24.35, y: 3.2, z: 4 }, { x: -28, y: 3.2, z: 4 }],
    [{ x: -24.35, y: .32, z: -4.5 }, { x: -24.35, y: .96, z: -2.9 }],
  ]) assert.equal(nav.clearSegment(a!, b!), false);
  assert.equal(nav.isWalkable({ x: -2.4, y: 3, z: -4.4 }), false);
  assert.equal(nav.requiresAscent({ x: 0, y: 0, z: -4.4 }, { x: -2.4, y: 3, z: -4.4 }), false);
  assert.equal(nav.clearSegment({ x: -13, y: 3.2, z: -3 }, { x: -13, y: 3.2, z: 3 }), true);
});
test('jumping from a balcony or shed cannot strand a player behind the boundary fences', () => {
  for (const [from, yaw] of [[{ x: 28, y: 2.6, z: 17 }, Math.PI], [{ x: 24.35, y: 3.2, z: 4.5 }, Math.PI / 2]] as const) {
    const p = body(from);
    for (let i = 0; i < 120; i++) {
      movePlayer(p, frame({ yaw, moveZ: 1, sprint: true, jump: i === 0 }), { now: i * TICK, dt: 1 / 30, jumpPressed: i === 0, crouchPressed: false, moveFactor: 1, adsFactor: 1, canSprint: true });
      assert.ok(Math.abs(p.x) <= ARENA_LIMITS.x - PLAYER_RADIUS + 1e-7);
      assert.ok(Math.abs(p.z) <= ARENA_LIMITS.z - PLAYER_RADIUS + 1e-7);
    }
  }
});
test('padding recovery and gravity settling preserve the stair or upper floor beneath the rival', () => {
  const nav = new BotNavigation();
  for (const from of [{ x: -10.6, y: 3.2, z: 0 }, { x: -25.18, y: .32, z: -4.5 }, { x: -24.35, y: .64, z: -3.3 }]) {
    assert.equal(nav.isWalkable(from), false); assert.equal(penetrates(from), false);
    const route = traverse(nav, from, { x: -13, y: 3.2, z: 0 }, 'walk');
    assert.equal(route[0]!.y, from.y, 'Exit padding on the current support surface.');
  }
  const falling = { x: -24.35, y: 1.2, z: -2.9 }, destination = { x: -24.35, y: 0, z: -5.05 };
  const route = traverse(nav, falling, destination, 'sprint');
  assert.deepEqual(route[0], { ...falling, y: .96 });
  const bot = makePlayer('bot-scout', falling, { bot: true }), human = makePlayer('human', { x: -13, y: 3.2, z: 0 }, { connected: false });
  const input = new PracticeBots('normal', 'settling').input(bot, [human, bot], 6000, 1 / 30, 1, 'ffa');
  assert.ok([input.moveX, input.moveZ, input.yaw, input.pitch].every(Number.isFinite));
  assert.equal(input.moveX, 0); assert.equal(input.moveZ, 0); assert.equal(input.jump, false);
});
test('every difficulty follows a visible rival up the rear stairs, fights from the balcony, then walks back down', () => {
  for (const difficulty of DIFFICULTIES) {
    const bot = makePlayer('bot-scout', { x: -24.35, y: 0, z: -6 }, { bot: true, yaw: Math.PI }), human = makePlayer('human', { x: -24.35, y: 3.2, z: 4.15 });
    const nav = new BotNavigation(), controller = new PracticeBots(difficulty, 'observed-upper');
    let arrivedAt = -1, firstShot = Infinity, previous: InputFrame | undefined;
    for (let tick = 0; tick < 600; tick++) {
      const now = 6000 + tick * TICK, input = controller.input(bot, [human, bot], now, 1 / 30, tick + 1, 'ffa'), before = { ...bot };
      assert.equal(input.jump, false); assert.ok([input.moveX, input.moveZ, input.yaw, input.pitch].every(Number.isFinite));
      if (input.fire) firstShot = Math.min(firstShot, now - 6000);
      drive(bot, input, previous, now); previous = input;
      assert.ok(!penetrates(bot)); assert.ok(distance(bot, before) <= Math.max(MOVE.dash, MOVE.slideSpeed) / 30 + 1e-8);
      if (Math.abs(bot.y - 3.2) < .001 && nav.isWalkable(bot) && arrivedAt < 0) arrivedAt = tick;
      if (arrivedAt >= 0) assert.ok(Math.abs(bot.y - 3.2) < .001, 'Strafing must stay upstairs.');
      if (arrivedAt >= 0 && tick > arrivedAt + 120) break;
    }
    assert.ok(arrivedAt >= 0 && arrivedAt < 300, `${difficulty} should reach the balcony within ten seconds (${arrivedAt}).`);
    assert.ok(Number.isFinite(firstShot) && firstShot >= BOT_SETTINGS[difficulty].reaction * 0.85 - TICK, `${difficulty} first shot ${firstShot}`);
    human.connected = false; const heights = new Set<number>(); let returned = false;
    for (let tick = 0; tick < 1800; tick++) {
      const now = 30_000 + tick * TICK, input = controller.input(bot, [human, bot], now, 1 / 30, 1000 + tick, 'ffa');
      drive(bot, input, previous, now); previous = input; assert.ok(!penetrates(bot)); assert.equal(input.jump, false);
      for (let i = 1; i <= 9; i++) if (Math.abs(supportHeight(bot) - i * .32) < .001) heights.add(i);
      if (bot.y === 0) { returned = true; break; }
    }
    assert.ok(returned && heights.size === 9, `${difficulty} should come down every stair level when resuming patrol (${[...heights].join(',')}).`);
  }
});
test('hidden occupants cannot redirect patrols; observed elevation changes trigger a route update', t => {
  const human = makePlayer('human', { x: -13, y: 3.2, z: 0 }), bot = makePlayer('bot-scout', { x: -28, y: 0, z: 0 }, { bot: true, yaw: Math.PI / 2 });
  const a = new PracticeBots('hard', 'hidden-upper'), b = new PracticeBots('hard', 'hidden-upper'), botA = { ...bot }, botB = { ...bot };
  for (let tick = 0; tick < 30; tick++) {
    assert.deepEqual(a.input(botA, [botA, { ...human, z: 0 }], 6000 + tick * 100, .1, tick + 1, 'ffa'), b.input(botB, [botB, { ...human, z: 3 }], 6000 + tick * 100, .1, tick + 1, 'ffa'));
  }
  Object.assign(bot, { x: -27.5, y: 0, z: 1 }); Object.assign(human, { x: -24.35, y: 2.88, z: 2.05 });
  const calls: Vec3[] = [], original = BotNavigation.prototype.findPath;
  t.mock.method(BotNavigation.prototype, 'findPath', function (this: BotNavigation, start: Vec3, goal: Vec3) { calls.push({ ...goal }); return original.call(this, start, goal); });
  const controller = new PracticeBots('hard', 'height-change');
  const first = controller.input(bot, [human, bot], 6000, 1 / 30, 1, 'ffa');
  assert.equal(first.aim, true); assert.ok(calls.some(p => p.y === 2.88)); calls.length = 0;
  Object.assign(human, { x: -24.35, y: 3.2, z: 3.45 });
  controller.input(bot, [human, bot], 6610, 1 / 30, 2, 'ffa');
  assert.ok(calls.some(p => p.y === 3.2), 'An observed height change must replan even when horizontal movement is below two metres.');
});

// ---- Whole matches through MatchEngine -------------------------------------------------------
// These drive the v3 engine surface from the plan (Shared Contract, "Engine (A → tests/clients)").
// It is typed structurally here so this suite compiles while server/engine.ts is rewritten alongside.
interface EngineV3 {
  phase: Phase; winnerIds: string[];
  addPlayer(profile: Profile, now?: number, bot?: boolean, team?: Team): PlayerState;
  start(now?: number): void; step(now: number, dt: number): void; finish(reason: string, now?: number): void;
  setConnected(id: string, connected: boolean): void; snapshot(now?: number, viewerId?: string): WorldSnapshot;
}
interface EngineV3Options { practice?: boolean; practiceDifficulty?: PracticeDifficulty; practiceSeed?: string; mode?: GameMode; onEvent?: (event: GameEvent) => void }
const MatchEngine = engineModule.MatchEngine as unknown as new (options?: EngineV3Options) => EngineV3;
interface Recorded { id: string; now: number; mode: GameMode | undefined; frame: InputFrame }
/** Watches every frame the rivals hand the engine; install once per test. */
function recordFrames(t: TestContext) {
  const sink: { onFrame?: (record: Recorded) => void } = {}, original = PracticeBots.prototype.input;
  t.mock.method(PracticeBots.prototype, 'input', function (this: PracticeBots, ...args: Parameters<PracticeBots['input']>) {
    const result = original.apply(this, args); sink.onFrame?.({ id: args[0].id, now: args[2], mode: args[5], frame: result }); return result;
  });
  return sink;
}
function practice(difficulty: PracticeDifficulty, mode: GameMode) {
  const events: GameEvent[] = [];
  const engine = new MatchEngine({ practice: true, practiceDifficulty: difficulty, practiceSeed: `platform-${mode}-${difficulty}`, mode, onEvent: e => events.push(e) });
  const human = engine.addPlayer({ id: 'human', name: 'Player', color: '#fff' }, 0);
  const bots = PRACTICE_RIVALS.map(profile => engine.addPlayer(profile, 0, true));
  engine.start(0); engine.step(RULES.countdownMs, 0);
  return { engine, human, bots, events };
}
function assertFrame(record: Recorded, mode: GameMode) {
  const { frame } = record;
  assert.equal(record.mode, mode, 'The engine passes the match mode to the rivals.');
  assert.equal(frame.viewTime, record.now, 'Rival frames carry the server time they were made at.');
  assert.ok([frame.moveX, frame.moveZ, frame.yaw, frame.pitch].every(Number.isFinite) && Math.abs(frame.moveX) <= 1 && Math.abs(frame.moveZ) <= 1);
  assert.ok(frame.slot === 1 || frame.slot === 2); assert.equal(frame.jump, false);
}
function playRound(t: TestContext, sink: ReturnType<typeof recordFrames>, difficulty: PracticeDifficulty, mode: GameMode) {
  const frames = { count: 0 };
  sink.onFrame = record => { frames.count++; assertFrame(record, mode); };
  const round = practice(difficulty, mode);
  const { engine, bots } = round;
  const travel = bots.map(() => 0), stationary = bots.map(() => 0), longest = bots.map(() => 0), positions = bots.map(p => ({ x: p.x, y: p.y, z: p.z }));
  const started = performance.now();
  for (let tick = 1; tick <= RULES.matchSeconds * 30 + 1 && engine.phase !== 'finished'; tick++) {
    engine.step(RULES.countdownMs + tick * TICK, 1 / 30);
    bots.forEach((bot, i) => {
      assert.ok([bot.x, bot.y, bot.z, bot.vx, bot.vy, bot.vz].every(Number.isFinite)); assert.ok(!penetrates(bot), `${bot.name} clipped at ${JSON.stringify({ x: bot.x, y: bot.y, z: bot.z })}`);
      const moved = distance(bot, positions[i]!);
      if (moved < 1) travel[i]! += moved;
      stationary[i] = bot.health > 0 && moved < 0.005 ? stationary[i]! + 1 : 0; longest[i] = Math.max(longest[i]!, stationary[i]!);
      positions[i] = { x: bot.x, y: bot.y, z: bot.z };
    });
  }
  const elapsed = performance.now() - started;
  t.diagnostic(`${mode} ${difficulty}: ${frames.count} rival frames; ${elapsed.toFixed(0)} ms; travel ${travel.map(Math.round).join('/')}; longest stationary ${longest.map(n => (n / 30).toFixed(1)).join('/')}s`);
  assert.equal(engine.phase, 'finished'); assert.ok(elapsed < 15_000, 'One practice room must fit comfortably in a 30 Hz budget.');
  assert.ok(frames.count > 1000);
  assert.ok(travel.every(n => n > 30), 'Every rival roams the town.'); assert.ok(longest.every(n => n < 300), 'No living rival stalls for ten seconds.');
  const ownFrags = round.events.filter(e => e.type === 'damage' && e.cause === 'frag' && e.playerId === e.attackerId);
  assert.deepEqual(ownFrags, [], 'Rivals never hurt themselves with their own frags.');
  return round;
}

test('rivals play full practice rounds through MatchEngine at every difficulty with their own loadouts', t => {
  const sink = recordFrames(t);
  for (const difficulty of DIFFICULTIES) {
    const { engine, human, bots, events } = playRound(t, sink, difficulty, 'ffa');
    bots.forEach(bot => assert.deepEqual(bot.loadout, botLoadout(bot.id, difficulty), `${bot.name} plays its fixed loadout`));
    assert.equal(bots.find(b => b.id === 'bot-rook')!.loadout.primary, difficulty === 'hard' ? 'longbow' : 'kr5');
    for (const event of events) if (event.type === 'shot' && event.playerId.startsWith('bot-')) {
      // An Attack Drone's shots are reported under its owner, with the weapon 'drone'.
      const loadout = botLoadout(event.playerId, difficulty);
      assert.ok(event.weapon === loadout.primary || event.weapon === loadout.secondary || event.weapon === 'drone', `${event.playerId} fired ${event.weapon}`);
    }
    assert.ok(events.some(e => e.type === 'damage' && e.playerId === human.id), 'Practice must challenge the player.');
    assert.ok(events.some(e => e.type === 'elimination' && e.playerId !== human.id && e.attackerId !== human.id), 'Rivals compete with each other too.');
    for (const bot of bots) {
      const throws = events.filter(e => e.type === 'grenade' && e.playerId === bot.id).map(e => e.at);
      if (difficulty === 'easy') assert.equal(throws.length, 0, 'Relaxed rivals never throw frags.');
      for (let i = 1; i < throws.length; i++) assert.ok(throws[i]! - throws[i - 1]! >= 8000 - TICK, 'Frag use is bounded by the cooldown.');
    }
    const snapshot = engine.snapshot(RULES.countdownMs + 1, 'human');
    assert.ok(snapshot.players.every(p => p.loadout && (p.weapon === p.loadout.primary || p.weapon === p.loadout.secondary)));
  }
});
test('team deathmatch rivals split into teams and never hurt teammates', t => {
  const sink = recordFrames(t);
  for (const difficulty of DIFFICULTIES) {
    const { human, bots, events } = playRound(t, sink, difficulty, 'tdm');
    const everyone = [human, ...bots], teamOf = new Map(everyone.map(p => [p.id, p.team]));
    assert.ok(everyone.every(p => p.team === 'teal' || p.team === 'gold'));
    assert.equal(everyone.filter(p => p.team === 'teal').length, 2); assert.equal(everyone.filter(p => p.team === 'gold').length, 2);
    for (const event of events) {
      if (event.type === 'damage' && event.attackerId !== event.playerId) assert.notEqual(teamOf.get(event.attackerId), teamOf.get(event.playerId), 'No friendly fire.');
      if (event.type === 'shot') for (const trace of event.traces) if (trace.kind === 'player' && trace.targetId) assert.notEqual(teamOf.get(trace.targetId), teamOf.get(event.playerId));
    }
    assert.ok(events.some(e => e.type === 'elimination' && e.attackerId.startsWith('bot-') && teamOf.get(e.attackerId) !== teamOf.get(e.playerId)), 'Rivals fight the other team.');
  }
});
test('rivals pause on an upper floor while no person is connected, then resume with ordinary movement; rematches reset the round', () => {
  const { engine, human, bots } = practice('normal', 'ffa'), bot = bots[0]!;
  Object.assign(bot, { x: -13, y: 3.2, z: 0, vx: 0, vy: 0, vz: 0, protectedUntil: 0 });
  engine.setConnected(human.id, false); engine.step(6000, 1 / 30);
  const paused = { x: bot.x, y: bot.y, z: bot.z, yaw: bot.yaw };
  for (let tick = 1; tick <= 90; tick++) engine.step(6000 + tick * TICK, 1 / 30);
  assert.deepEqual({ x: bot.x, y: bot.y, z: bot.z, yaw: bot.yaw }, paused, 'Rivals hold still with no person to play.');
  engine.addPlayer({ id: human.id, name: human.name, color: human.color }, 9100); engine.step(9100, 1 / 30);
  assert.ok(distance(bot, paused) <= MOVE.dash / 30 + 1e-8 && !penetrates(bot), 'Recovery is ordinary movement from the current floor.');
  engine.finish('Test rematch.', 9200); engine.start(9300);
  for (const player of [human, ...bots]) {
    const deep = hasPerk(player.loadout, 'deep-pockets'), primary = WEAPONS[player.loadout.primary], secondary = WEAPONS[player.loadout.secondary];
    assert.deepEqual([player.y, player.kills, player.deaths, player.health, player.mag, player.frags],
      [0, 0, 0, RULES.health, [primary.magazine, secondary.magazine], RULES.fragsPerLife + (deep ? 1 : 0)]);
    assert.equal(player.reserve[0], primary.magazine * (primary.reserveMags + (deep ? DEEP_POCKETS_EXTRA_MAGS : 0)));
  }
});
