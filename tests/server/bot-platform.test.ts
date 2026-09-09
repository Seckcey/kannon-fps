import test from 'node:test';
import assert from 'node:assert/strict';
import { BotNavigation, PracticeBots, PRACTICE_RIVALS } from '../../server/bots.js';
import { idleInput, MatchEngine } from '../../server/engine.js';
import { ARENA_LIMITS, OBSTACLES, SPAWNS, STAIR_ROUTES } from '../../shared/map.js';
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
  for (const [from, yaw] of [[{x:28,y:2.6,z:17},Math.PI],[{x:24.35,y:3.2,z:4.5},Math.PI/2]] as const) {
    const p=state(from);
    for (let i=0;i<120;i++) {
      movePlayer(p,{...idleInput(),yaw,moveZ:1,sprint:true,jump:i===0},1/30);
      assert.ok(Math.abs(p.x)<=ARENA_LIMITS.x-PLAYER_RADIUS+1e-7);
      assert.ok(Math.abs(p.z)<=ARENA_LIMITS.z-PLAYER_RADIUS+1e-7);
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
  const { human, bots } = practice(); place(bots[0]!, falling); human.connected = false;
  const input = new PracticeBots('normal', 'settling').input(bots[0]!, [human, bots[0]!], 6000, 1 / 30, 1);
  assert.ok([input.moveX, input.moveZ, input.yaw, input.pitch].every(Number.isFinite));
  assert.equal(input.moveX, 0); assert.equal(input.moveZ, 0); assert.equal(input.jump, false);
});
test('every difficulty follows a visible rival up rear stairs and stays supported while fighting', () => {
  for (const difficulty of ['easy', 'normal', 'hard'] as const) {
    const { human, bots } = practice(difficulty), bot = bots[0]!, nav = new BotNavigation();
    place(bot, { x: -24.35, y: 0, z: -6 }, Math.PI); place(human, { x: -24.35, y: 3.2, z: 4.15 });
    const controller = new PracticeBots(difficulty, 'observed-upper'); let arrivedAt = -1, firstShot = Infinity;
    for (let tick = 0; tick < 600; tick++) {
      const now = 6000 + tick * 1000 / 30, input = controller.input(bot, [human, bot], now, 1 / 30, tick + 1), previous = { ...bot };
      assert.equal(input.jump, false); assert.ok([input.moveX, input.moveZ, input.yaw, input.pitch].every(Number.isFinite));
      if (input.fire) firstShot = Math.min(firstShot, now - 6000);
      movePlayer(bot, input, 1 / 30); bot.slot = input.slot;
      assert.ok(!penetrates(bot)); assert.ok(distance(bot, previous) <= 9 / 30 + 1e-8);
      if (Math.abs(bot.y - 3.2) < .001 && nav.isWalkable(bot)) { if (arrivedAt < 0) arrivedAt = tick; }
      if (arrivedAt >= 0) assert.ok(Math.abs(bot.y - 3.2) < .001, 'Strafing must stay upstairs.');
      if (arrivedAt >= 0 && tick > arrivedAt + 120) break;
    }
    assert.ok(arrivedAt >= 0 && arrivedAt < 300, `${difficulty} should reach the balcony within ten seconds.`);
    assert.ok(Number.isFinite(firstShot) && firstShot >= { easy: 850, normal: 510, hard: 280 }[difficulty]);
    human.connected = false; const heights = new Set<number>(); let returned = false;
    for (let tick = 0; tick < 1500; tick++) {
      const input = controller.input(bot, [human, bot], 30_000 + tick * 1000 / 30, 1 / 30, 1000 + tick);
      movePlayer(bot, input, 1 / 30); bot.slot = input.slot; assert.ok(!penetrates(bot)); assert.equal(input.jump, false);
      for (let i = 1; i <= 9; i++) if (Math.abs(supportHeight(bot) - i * .32) < .001) heights.add(i);
      if (bot.y === 0) { returned = true; break; }
    }
    assert.ok(returned && heights.size === 9, `${difficulty} should descend every stair level when resuming patrol.`);
  }
});
test('hidden occupants cannot redirect patrols; observed elevation changes trigger a route update', t => {
  const { human, bots } = practice('hard'), bot = bots[0]!;
  place(bot, { x: -28, y: 0, z: 0 }, Math.PI / 2);
  const a = new PracticeBots('hard', 'hidden-upper'), b = new PracticeBots('hard', 'hidden-upper');
  for (let tick = 0; tick < 30; tick++) {
    assert.deepEqual(a.input(bot, [bot, { ...human, x: -13, y: 3.2, z: 0 }], 6000 + tick * 100, .1, tick + 1),
      b.input(bot, [bot, { ...human, x: -13, y: 3.2, z: 3 }], 6000 + tick * 100, .1, tick + 1));
  }
  place(bot, { x: -27.5, y: 0, z: 1 }, Math.PI / 2); place(human, { x: -24.35, y: 2.88, z: 2.05 });
  const calls: Vec3[] = [], original = BotNavigation.prototype.findPath;
  t.mock.method(BotNavigation.prototype, 'findPath', function (this: BotNavigation, start: Vec3, goal: Vec3) { calls.push({ ...goal }); return original.call(this, start, goal); });
  const controller = new PracticeBots('hard', 'height-change');
  const first = controller.input(bot, [human, bot], 6000, 1 / 30, 1);
  assert.equal(first.aim, true); assert.ok(calls.some(p => p.y === 2.88)); calls.length = 0;
  place(human, { x: -24.35, y: 3.2, z: 3.45 });
  controller.input(bot, [human, bot], 6610, 1 / 30, 2);
  assert.ok(calls.some(p => p.y === 3.2), 'An observed height change must replan even when horizontal movement is below two metres.');
});
test('upper-platform disconnect recovery and rematch use the unchanged engine lifecycle', () => {
  const { engine, human, bots } = practice(), bot = bots[0]!;
  place(bot, { x: -13, y: 3.2, z: 0 }); engine.setConnected(human.id, false); engine.step(6000, 1 / 30);
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
    place(human, { x: -13, y: 3.2, z: 0 });
    // Begin with combat on the upper surface, then let ordinary eliminations,
    // respawns and navigation run the rest of the round without intervention.
    place(bots[0]!, { x: -13, y: 3.2, z: 4 }, Math.atan2(4, 1));
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
        if (bot.health > 0 && Math.abs(bot.y - 3.2) < 0.001) upperTicks++;
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
