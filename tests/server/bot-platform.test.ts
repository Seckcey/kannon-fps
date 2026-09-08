import test from 'node:test';
import assert from 'node:assert/strict';
import { BotNavigation, PracticeBots, PRACTICE_RIVALS } from '../../server/bots.js';
import { idleInput, MatchEngine } from '../../server/engine.js';
import { OBSTACLES, SPAWNS } from '../../shared/map.js';
import { movePlayer, PLAYER_HEIGHT, PLAYER_RADIUS, supportHeight, type KinematicState } from '../../shared/physics.js';
import { RULES, type GameEvent, type PlayerState, type PracticeDifficulty, type Vec3 } from '../../shared/protocol.js';

const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
function penetrates(p: Vec3): boolean {
  return OBSTACLES.some(b => p.y < b.y + b.h / 2 - 0.01 && p.y + PLAYER_HEIGHT > b.y - b.h / 2 + 0.01 &&
    p.x + PLAYER_RADIUS > b.x - b.w / 2 + 0.01 && p.x - PLAYER_RADIUS < b.x + b.w / 2 - 0.01 &&
    p.z + PLAYER_RADIUS > b.z - b.d / 2 + 0.01 && p.z - PLAYER_RADIUS < b.z + b.d / 2 - 0.01);
}
function state(p: Vec3): KinematicState { return { ...p, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0 }; }
function traverse(nav: BotNavigation, from: Vec3, to: Vec3, mode: 'aim' | 'walk' | 'sprint', dt = 1 / 30) {
  const route = nav.findPath(from, to), p = state(from), speed = mode === 'aim' ? 4 : mode === 'sprint' ? 9 : 6.5;
  assert.ok(route.length, `Missing route ${JSON.stringify({ from, to })}`);
  for (const goal of route) {
    let arrived = false;
    for (let tick = 0; tick < Math.ceil(20 / dt); tick++) {
      const length = distance(p, goal), before = { ...p };
      movePlayer(p, { ...idleInput(), yaw: length > 0.00001 ? Math.atan2(goal.x - p.x, -(goal.z - p.z)) : p.yaw,
        moveZ: Math.min(1, length / (speed * dt)), aim: mode === 'aim', sprint: mode === 'sprint' }, dt);
      assert.ok(!penetrates(p), `Route penetrated a collider at ${JSON.stringify(p)}`);
      assert.ok(distance(p, before) <= speed * dt + 1e-8, 'Navigation may not exceed ordinary movement speed.');
      if (distance(p, goal) < 0.001 && Math.abs(p.y - goal.y) < 0.001 && Math.abs(p.vy) < 0.001) { arrived = true; break; }
    }
    assert.ok(arrived, `Unreachable waypoint ${JSON.stringify({ from, to, goal, p })}`);
  }
  assert.ok(distance(p, to) < 0.001 && Math.abs(p.y - to.y) < 0.001, 'The destination must retain its elevation.');
  return route;
}
function practice(difficulty: PracticeDifficulty = 'normal', count = 1) {
  const events: GameEvent[] = [];
  const engine = new MatchEngine({ practice: true, practiceDifficulty: difficulty, practiceSeed: `platform-${difficulty}`, onEvent: e => events.push(e) });
  const human = engine.addPlayer({ id: 'human', name: 'Player', color: '#fff' }, 0);
  const bots = PRACTICE_RIVALS.slice(0, count).map(profile => engine.addPlayer(profile, 0, true));
  engine.start(0); engine.step(3000, 0);
  return { engine, human, bots, events };
}
function place(p: PlayerState, at: Vec3, yaw = 0) { Object.assign(p, state(at), { yaw, protectedUntil: 0 }); }

test('all eight spawns reach and leave the raised platform through ordinary stair movement', () => {
  const nav = new BotNavigation(), upper = { x: 3, y: 2, z: 18 };
  for (const mode of ['aim', 'walk', 'sprint'] as const) for (const spawn of SPAWNS) {
    const up = traverse(nav, spawn, upper, mode), down = traverse(nav, upper, spawn, mode);
    for (const height of [0.4, 0.8, 1.2, 1.6, 2]) {
      assert.ok(up.some(p => Math.abs(p.y - height) < 0.001));
      assert.ok(down.some(p => Math.abs(p.y - height) < 0.001));
    }
  }
  for (const dt of [1 / 90, 0.1]) for (const x of [-2.78, 2.78]) for (const mode of ['aim', 'walk', 'sprint'] as const) {
    traverse(nav, { x, y: 0, z: 7.5 }, upper, mode, dt);
    traverse(nav, upper, { x, y: 0, z: 7.5 }, mode, dt);
  }
});

test('surface shortcuts cannot climb faces, skip stair rises, cross unsupported edges or reach other cover tops', () => {
  const nav = new BotNavigation();
  for (const [a, b] of [
    [{ x: 0, y: 0, z: 25 }, { x: 0, y: 2, z: 17 }],
    [{ x: 9, y: 0, z: 17 }, { x: 0, y: 2, z: 17 }],
    [{ x: 0, y: 0, z: 7.5 }, { x: 0, y: 2, z: 14 }],
    [{ x: 0, y: 0.4, z: 8.88 }, { x: 0, y: 1.2, z: 11.18 }],
    [{ x: 6, y: 2, z: 17 }, { x: 8, y: 2, z: 17 }],
    [{ x: 0, y: 2, z: 20 }, { x: 0, y: 2, z: 23 }],
  ]) assert.equal(nav.clearSegment(a!, b!), false);
  assert.equal(nav.isWalkable({ x: -19, y: 3.5, z: 0 }), false);
  assert.equal(nav.requiresAscent({ x: -28, y: 0, z: 0 }, { x: -19, y: 3.5, z: 0 }), false);
  const groundApproach = nav.findPath({ x: -28, y: 0, z: 0 }, { x: -19, y: 3.5, z: 0 });
  assert.ok(groundApproach.length && groundApproach.every(p => p.y === 0), 'This remains one existing stair route, not general climbing.');
  assert.equal(nav.clearSegment({ x: -6, y: 2, z: 14 }, { x: 6, y: 2, z: 20 }), true);
});

test('padding recovery and gravity settling preserve the current support surface', () => {
  const nav = new BotNavigation();
  for (const from of [{ x: 6.9, y: 2, z: 17 }, { x: 0, y: 2, z: 20.8 }, { x: 3.3, y: 0.8, z: 10.08 }, { x: 0, y: 0.4, z: 9.61 },
    { x: 0, y: 0.8, z: 10.772159429768635 }, { x: 0, y: 1.2, z: 11.8799 }, { x: 0, y: 1.6, z: 12.5799 }]) {
    assert.equal(nav.isWalkable(from), false); assert.equal(penetrates(from), false);
    const route = traverse(nav, from, { x: 0, y: 2, z: 17 }, 'walk');
    assert.equal(route[0]!.y, from.y, 'Recovery exits padding on the same supporting surface.');
  }
  const falling = { x: 0, y: 1.84, z: 12.08 };
  const route = traverse(nav, falling, { x: 0, y: 0, z: 7.5 }, 'sprint');
  assert.deepEqual(route[0], { x: 0, y: 1.6, z: 12.08 }, 'Finish the fall before continuing down the stairs.');
  const { human, bots } = practice(); place(bots[0]!, falling); human.connected = false;
  const input = new PracticeBots('normal', 'settling').input(bots[0]!, [human, bots[0]!], 6000, 1 / 30, 1);
  assert.ok([input.moveX, input.moveZ, input.yaw, input.pitch].every(Number.isFinite));
  assert.equal(input.moveX, 0); assert.equal(input.moveZ, 0); assert.equal(input.jump, false);
});

test('every difficulty ascends to an observed upper opponent within its usual firing distance and stays supported while strafing', () => {
  for (const difficulty of ['easy', 'normal', 'hard'] as const) {
    const { human, bots } = practice(difficulty), bot = bots[0]!, nav = new BotNavigation();
    place(bot, { x: 0, y: 0, z: 6 }, Math.PI); place(human, { x: 0, y: 2, z: 17 });
    const controller = new PracticeBots(difficulty, 'observed-upper'); let arrivedAt = -1, firstShot = Infinity;
    for (let tick = 0; tick < 600; tick++) {
      const now = 6000 + tick * 1000 / 30, input = controller.input(bot, [human, bot], now, 1 / 30, tick + 1), previous = { ...bot };
      assert.equal(input.jump, false); assert.ok([input.moveX, input.moveZ, input.yaw, input.pitch].every(Number.isFinite));
      if (input.fire) firstShot = Math.min(firstShot, now - 6000);
      movePlayer(bot, input, 1 / 30); bot.slot = input.slot;
      assert.ok(!penetrates(bot)); assert.ok(distance(bot, previous) <= 9 / 30 + 1e-8);
      if (Math.abs(bot.y - 2) < 0.001 && nav.isWalkable(bot)) { if (arrivedAt < 0) arrivedAt = tick; }
      if (arrivedAt >= 0) assert.ok(Math.abs(bot.y - 2) < 0.001, 'Combat strafing must remain on the upper support surface.');
      if (arrivedAt >= 0 && tick > arrivedAt + 120) break;
    }
    assert.ok(arrivedAt >= 0 && arrivedAt < 300, `${difficulty} must reach the platform rather than remain firing below it.`);
    assert.ok(Number.isFinite(firstShot) && firstShot >= { easy: 850, normal: 510, hard: 280 }[difficulty], 'Existing reaction delay still applies.');
    // A controller with no visible target resumes its ordinary patrol and must
    // be able to leave the upper surface through the stairs, not a ledge.
    human.connected = false; const downHeights = new Set<number>(); let returned = false;
    for (let tick = 0; tick < 900; tick++) {
      const input = controller.input(bot, [human, bot], 30_000 + tick * 1000 / 30, 1 / 30, 1000 + tick);
      assert.equal(input.jump, false); assert.ok([input.moveX, input.moveZ].every(Number.isFinite));
      movePlayer(bot, input, 1 / 30); bot.slot = input.slot; assert.ok(!penetrates(bot));
      const support = supportHeight(bot);
      for (const height of [0.4, 0.8, 1.2, 1.6]) if (Math.abs(support - height) < 0.001) {
        downHeights.add(height); assert.ok(Math.abs(bot.x) <= 2.78, 'Descent stays within the explicit stair corridor.');
      }
      if (bot.y === 0) { returned = true; break; }
    }
    assert.ok(returned && downHeights.size === 4, `${difficulty} must patrol back down every stair level.`);
  }
});

test('elevated routing uses observed positions only and replans when a nearby observed goal changes support height', t => {
  const { human, bots } = practice('hard'), bot = bots[0]!;
  place(bot, { x: -28, y: 0, z: 0 }, Math.PI / 2);
  const unseenA = new PracticeBots('hard', 'hidden-upper'), unseenB = new PracticeBots('hard', 'hidden-upper');
  for (let tick = 0; tick < 30; tick++) {
    const a = unseenA.input(bot, [bot, { ...human, x: 0, y: 2, z: 17 }], 6000 + tick * 100, 0.1, tick + 1);
    const b = unseenB.input(bot, [bot, { ...human, x: 5, y: 2, z: 15 }], 6000 + tick * 100, 0.1, tick + 1);
    assert.deepEqual(a, b, 'Hidden platform occupants cannot redirect a patrol.');
    assert.equal(a.aim, false);
  }
  place(bot, { x: 0, y: 0, z: 6 }, Math.PI); place(human, { x: 0, y: 2, z: 17 });
  const lostA = new PracticeBots('hard', 'lost-upper'), lostB = new PracticeBots('hard', 'lost-upper');
  assert.deepEqual(lostA.input(bot, [human, bot], 6000, 1 / 30, 1), lostB.input(bot, [human, bot], 6000, 1 / 30, 1));
  for (let tick = 1; tick <= 30; tick++) {
    const a = lostA.input(bot, [bot, { ...human, x: -28, y: 0, z: 0 }], 6000 + tick * 100, 0.1, tick + 1);
    const b = lostB.input(bot, [bot, { ...human, x: -28, y: 2, z: 0 }], 6000 + tick * 100, 0.1, tick + 1);
    assert.deepEqual(a, b, 'After losing sight, changed hidden elevation cannot alter the last-seen route or subsequent patrol.');
  }
  place(bot, { x: 14, y: 0, z: 7 }, Math.atan2(-14, -(11.18 - 7))); place(human, { x: 0, y: 1.2, z: 11.18 });
  const calls: Vec3[] = [], original = BotNavigation.prototype.findPath;
  t.mock.method(BotNavigation.prototype, 'findPath', function (this: BotNavigation, start: Vec3, goal: Vec3) { calls.push({ ...goal }); return original.call(this, start, goal); });
  const controller = new PracticeBots('hard', 'height-change');
  const first = controller.input(bot, [human, bot], 6000, 1 / 30, 1);
  assert.equal(first.aim, true); assert.ok(calls.some(p => p.y === 1.2)); calls.length = 0;
  place(human, { x: 0, y: 2, z: 13.14 });
  assert.ok(distance({ x: 0, y: 1.2, z: 11.18 }, human) < 2, 'Goal movement is below the old horizontal replan threshold.');
  controller.input(bot, [human, bot], 6610, 1 / 30, 2);
  assert.ok(calls.some(p => p.y === 2 && p.z === 13.14), 'The route must be refreshed for the newly observed upper goal.');
});

test('upper-platform disconnect recovery and rematch use the unchanged engine lifecycle', () => {
  const { engine, human, bots } = practice(), bot = bots[0]!;
  place(bot, { x: 0, y: 2, z: 17 }); engine.setConnected(human.id, false); engine.step(6000, 1 / 30);
  const paused = { ...bot };
  for (let tick = 1; tick <= 90; tick++) engine.step(6000 + tick * 1000 / 30, 1 / 30);
  assert.deepEqual(bot, paused);
  engine.addPlayer(human, 9100); engine.step(9100, 1 / 30);
  assert.ok(distance(bot, paused) <= 9 / 30 + 1e-8 && !penetrates(bot), 'Recovery remains ordinary movement from the current surface.');
  engine.finish('Test rematch.', 9200); engine.start(9300);
  for (const player of engine.players.values()) assert.deepEqual([player.y, player.kills, player.deaths, player.health, player.shield, player.ammoAR, player.ammoShotgun, player.heals], [0, 0, 0, RULES.health, RULES.shield, RULES.arMagazine, RULES.shotgunMagazine, RULES.healCharges]);
});

test('three rivals finish real rounds at all three difficulties with bounded navigation work and no clipping', t => {
  for (const difficulty of ['easy', 'normal', 'hard'] as const) {
    const { engine, human, bots, events } = practice(difficulty, 3);
    place(human, { x: 0, y: 2, z: 17 });
    // Begin with combat on the upper surface, then let ordinary eliminations,
    // respawns and navigation run the rest of the round without intervention.
    place(bots[0]!, { x: -4, y: 2, z: 18 }, Math.atan2(4, 1));
    const travel = bots.map(() => 0), stationary = bots.map(() => 0), longest = bots.map(() => 0), positions = bots.map(p => ({ ...p }));
    const timings: number[] = []; let upperTicks = 0;
    const started = performance.now();
    for (let tick = 1; tick <= 9001 && engine.phase !== 'finished'; tick++) {
      const before = performance.now(); engine.step(3000 + tick * 1000 / 30, 1 / 30); timings.push(performance.now() - before);
      bots.forEach((bot, i) => {
        assert.ok([bot.x, bot.y, bot.z, bot.vx, bot.vy, bot.vz].every(Number.isFinite)); assert.ok(!penetrates(bot));
        const moved = distance(bot, positions[i]!);
        if (moved < 1) travel[i]! += moved;
        stationary[i] = bot.health > 0 && moved < 0.005 ? stationary[i]! + 1 : 0; longest[i] = Math.max(longest[i]!, stationary[i]!);
        if (bot.health > 0 && Math.abs(bot.y - 2) < 0.001) upperTicks++;
        positions[i] = { ...bot };
        const input = engine.runtime.get(bot.id)!.input;
        assert.equal(input.jump, false); assert.ok([input.moveX, input.moveZ, input.yaw, input.pitch].every(Number.isFinite));
      });
    }
    const elapsed = performance.now() - started; timings.sort((a, b) => a - b);
    t.diagnostic(`${difficulty}: ${timings.length} ticks; ${elapsed.toFixed(1)}ms total; p95 ${timings[Math.floor(timings.length * 0.95)]!.toFixed(3)}ms; upper ${upperTicks} rival-ticks; travel ${travel.map(n => Math.round(n)).join('/')}; longest stationary ${longest.map(n => (n / 30).toFixed(1)).join('/')}s`);
    assert.equal(engine.phase, 'finished'); assert.ok(elapsed < 10_000); assert.ok(upperTicks > 0);
    assert.ok(travel.every(n => n > 30)); assert.ok(longest.every(n => n < 300), `${difficulty} must not leave a living bot stuck for ten seconds.`);
    assert.ok(events.some(e => e.type === 'damage' && e.playerId === human.id));
    assert.ok(events.some(e => e.type === 'elimination' && e.playerId !== human.id && e.attackerId !== human.id));
  }
});
