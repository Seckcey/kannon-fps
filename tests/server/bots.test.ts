import test from 'node:test';
import assert from 'node:assert/strict';
import { BotNavigation, PracticeBots, PRACTICE_RIVALS } from '../../server/bots.js';
import { MatchEngine, idleInput } from '../../server/engine.js';
import { cameraPosition, directionFromAngles, movePlayer, PLAYER_RADIUS, rayBox } from '../../shared/physics.js';
import { OBSTACLES } from '../../shared/map.js';
import { RULES, type GameEvent, type PlayerState, type PracticeDifficulty, type Vec3 } from '../../shared/protocol.js';

function practice(difficulty: PracticeDifficulty = 'normal', rivalCount = 1) {
  const events: GameEvent[] = [];
  const engine = new MatchEngine({ practice: true, practiceDifficulty: difficulty, practiceSeed: 'practice-regression', onEvent: event => events.push(event) });
  const human = engine.addPlayer({ id: 'human', name: 'Player', color: '#fff' }, 0);
  const bots = PRACTICE_RIVALS.slice(0, rivalCount).map(profile => engine.addPlayer(profile, 0, true));
  engine.start(0); engine.step(3000, 0);
  return { engine, human, bots, events };
}
function place(p: PlayerState, x: number, z: number, yaw = 0) { Object.assign(p, { x, y: 0, z, yaw, pitch: 0, vx: 0, vy: 0, vz: 0, protectedUntil: 0 }); }
function penetrates(p: Vec3): boolean {
  return OBSTACLES.some(b => p.y < b.y + b.h / 2 - 0.01 && p.y + 1.8 > b.y - b.h / 2 + 0.01 &&
    p.x + PLAYER_RADIUS > b.x - b.w / 2 + 0.01 && p.x - PLAYER_RADIUS < b.x + b.w / 2 - 0.01 &&
    p.z + PLAYER_RADIUS > b.z - b.d / 2 + 0.01 && p.z - PLAYER_RADIUS < b.z + b.d / 2 - 0.01);
}

test('navigation finds physically traversable routes around the bus and through house doorways', () => {
  const nav = new BotNavigation();
  for (const [from, to] of [
    [{ x: -28, y: 0, z: 0 }, { x: -11, y: 0, z: 0 }],
    [{ x: -5, y: 0, z: 6 }, { x: -5, y: 0, z: -6 }],
    [{ x: 0, y: 0, z: 20 }, { x: 0, y: 0, z: 6 }],
    [{ x: 0, y: 0, z: -22 }, { x: 0, y: 0, z: -12 }],
  ]) {
    const route = nav.findPath(from!, to!); assert.ok(route.length, 'Every ground destination must be reachable.');
    const state = { ...from!, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0 };
    for (const waypoint of route) {
      assert.ok(nav.clearSegment(state, waypoint));
      for (let tick = 0; tick < 600 && Math.hypot(state.x - waypoint.x, state.z - waypoint.z) > 0.00001; tick++) {
        const distance = Math.hypot(state.x - waypoint.x, state.z - waypoint.z);
        movePlayer(state, { ...idleInput(), yaw: Math.atan2(waypoint.x - state.x, -(waypoint.z - state.z)), moveZ: Math.min(1, distance / (6.5 / 30)) }, 1 / 30);
        assert.ok(!penetrates(state), 'Route must not rely on clipping through a collider.');
      }
      assert.ok(Math.hypot(state.x - waypoint.x, state.z - waypoint.z) < 0.06, 'Shared physics must actually reach each waypoint.');
    }
    assert.ok(Math.hypot(state.x - to!.x, state.z - to!.z) < 0.06);
  }
  const elevated = nav.findPath({ x: 0, y: 0, z: 20 }, { x: -13, y: 3.2, z: 0 });
  assert.ok(elevated.length && nav.isWalkable(elevated.at(-1)!), 'An elevated target must produce a reachable ground approach.');
});

test('a rival recovers from navigation padding by walking clear of the corner', () => {
  const { human, bots } = practice(); const bot = bots[0]!, controller = new PracticeBots('normal', 'corner-recovery');
  place(bot, -4.38, .98); human.connected = false;
  const nav = new BotNavigation(); assert.equal(nav.isWalkable(bot), false); assert.equal(penetrates(bot), false);
  const start = { x: bot.x, y: bot.y, z: bot.z };
  const route = nav.findPath(bot, { x: 0, y: 0, z: 0 }); assert.ok(route.length > 1);
  for (let tick = 0; tick < 180; tick++) {
    const input = controller.input(bot, [bot, human], 6000 + tick * 1000 / 30, 1 / 30, tick + 1);
    const previous = { x: bot.x, z: bot.z }; movePlayer(bot, input, 1 / 30);
    assert.ok(Math.hypot(bot.x - previous.x, bot.z - previous.z) <= 9 / 30 + 0.001, 'Recovery must obey ordinary movement speed.');
    assert.ok(!penetrates(bot));
  }
  assert.ok(nav.isWalkable(bot)); assert.ok(Math.hypot(bot.x - start.x, bot.z - start.z) > 5, 'Recovered navigation must resume patrolling.');
});

test('unseen opponents cannot change patrol decisions, and acquisition obeys reaction time and aim difficulty', () => {
  const { human, bots } = practice(); const bot = bots[0]!;
  place(bot, -28, 0, Math.PI / 2); place(human, -11, 0);
  const unseenA = new PracticeBots('hard', 'sight'), unseenB = new PracticeBots('hard', 'sight');
  for (let tick = 0; tick < 60; tick++) {
    const a = unseenA.input(bot, [bot, human], 6000 + tick * 100, 0.1, tick + 1);
    const b = unseenB.input(bot, [bot, { ...human, x: -11, z: 2 }], 6000 + tick * 100, 0.1, tick + 1);
    assert.deepEqual(a, b, 'Moving an unseen opponent behind the west wall must not reveal their new position.');
    assert.equal(a.fire, false); assert.equal(a.aim, false);
  }
  const results: Array<{ firstShot: number; misses: number; shots: number }> = [];
  for (const difficulty of ['easy', 'normal', 'hard'] as const) {
    const controller = new PracticeBots(difficulty, 'accuracy');
    place(bot, -28, 12); place(human, -28, -8);
    let firstShot = Infinity, misses = 0, shots = 0;
    for (let tick = 0; tick < 300; tick++) {
      const now = 6000 + tick * 1000 / 30;
      const input = controller.input(bot, [bot, human], now, 1 / 30, tick + 1);
      bot.yaw = input.yaw; bot.pitch = input.pitch;
      if (input.fire) {
        firstShot = Math.min(firstShot, now - 6000); shots++;
        const distance = rayBox(cameraPosition(bot, input.yaw, input.pitch, input.aim), directionFromAngles(input.yaw, input.pitch),
          { x: human.x - PLAYER_RADIUS, y: human.y, z: human.z - PLAYER_RADIUS }, { x: human.x + PLAYER_RADIUS, y: human.y + 1.8, z: human.z + PLAYER_RADIUS });
        if (!Number.isFinite(distance)) misses++;
      }
    }
    assert.ok(shots > 0 && firstShot >= { easy: 850, normal: 510, hard: 280 }[difficulty]);
    results.push({ firstShot, misses, shots });
  }
  assert.ok(results[0]!.firstShot > results[1]!.firstShot && results[1]!.firstShot > results[2]!.firstShot);
  const missRates = results.map(r => r.misses / r.shots);
  assert.ok(missRates[0]! > missRates[1]! && missRates[1]! > missRates[2]!, JSON.stringify(results));
  assert.ok(missRates[2]! > 0, 'Even hard difficulty must retain aim error.');
});

test('rivals reload and heal through the existing server timers and regain the exact fixed loadout on respawn', () => {
  const { engine, human, bots, events } = practice(); const bot = bots[0]!;
  place(bot, -28, 0, Math.PI / 2); place(human, -11, 0); bot.health = 40; bot.shield = 0; bot.ammoAR = 10;
  engine.step(6000, 0); assert.equal(bot.slot, 3); assert.equal(bot.heals, 2);
  engine.step(6030, 0); assert.equal(bot.heals, 1); assert.equal(bot.healingUntil, 9030);
  for (let now = 6060; now < 9030; now += 30) engine.step(now, 0);
  assert.equal(bot.health, 40); engine.step(9030, 0); assert.equal(bot.health, 90);
  engine.step(9060, 0); assert.equal(bot.slot, 1); assert.equal(bot.reloadingUntil, 9060 + RULES.arReloadMs);
  engine.step(9060 + RULES.arReloadMs - 1, 0); assert.equal(bot.ammoAR, 10);
  engine.step(9060 + RULES.arReloadMs, 0); assert.equal(bot.ammoAR, 30);
  assert.ok(events.some(e => e.type === 'heal' && e.playerId === bot.id && e.amount === 50));
  engine.damage(bot, human, 150, 11_000); assert.equal(bot.health, 0); assert.equal(bot.aiming, false);
  engine.step(13_999, 0); assert.equal(bot.health, 0); engine.step(14_000, 0);
  assert.deepEqual([bot.health, bot.shield, bot.ammoAR, bot.ammoShotgun, bot.heals, bot.slot, bot.protectedUntil], [100, 50, 30, 6, 2, 1, 16_000]);
  engine.damage(bot, human, 150, 14_100); assert.equal(bot.health, 100);
});

test('a rival releases its AR burst before activating healing after losing sight', () => {
  const { engine, human, bots, events } = practice('hard'); const bot = bots[0]!;
  place(bot, -28, 12); place(human, -28, -2);
  let now = 6000;
  for (; now < 8000; now += 1000 / 30) {
    engine.step(now, 1 / 30);
    if (events.some(e => e.type === 'shot' && e.playerId === bot.id)) break;
  }
  assert.ok(now < 8000, 'Set up a real held AR burst.');
  place(bot, -28, 0, Math.PI / 2); place(human, -11, 0); bot.health = 40;
  engine.step(now + 110, 0); assert.equal(bot.slot, 3); assert.equal(bot.healingUntil, 0);
  engine.step(now + 150, 0); assert.equal(bot.healingUntil, now + 150 + RULES.healMs); assert.equal(bot.heals, 1);
});

test('bot combat respects weapon cadence and damage, pauses on disconnect, and reacquires after recovery', () => {
  const { engine, human, bots, events } = practice('hard'); const bot = bots[0]!;
  place(bot, -28, 12); place(human, -28, -2);
  // This test advances weapon time with dt=0, so first frame an accurate
  // stationary shot through the map's clipped shoulder camera.
  for (let i = 0; i < 20; i++) {
    const eye = cameraPosition(bot, bot.yaw, bot.pitch, true);
    bot.yaw = Math.atan2(human.x - eye.x, -(human.z - eye.z));
    bot.pitch = Math.atan2(human.y + 1.2 - eye.y, Math.hypot(human.x - eye.x, human.z - eye.z));
  }
  for (let tick = 0; tick < 120; tick++) engine.step(6000 + tick * 1000 / 30, 0);
  const shots = events.filter(e => e.type === 'shot' && e.playerId === bot.id);
  assert.ok(shots.length >= 2);
  for (let i = 1; i < shots.length; i++) assert.ok(shots[i]!.at - shots[i - 1]!.at >= RULES.arCadenceMs - 0.001);
  assert.ok(events.some(e => e.type === 'damage' && e.attackerId === bot.id && e.amount === RULES.arDamage), 'AI damage must come from ordinary AR hits.');
  assert.equal(bot.ammoAR, RULES.arMagazine - shots.length);
  engine.setConnected(human.id, false); engine.step(10_100, 1 / 30);
  const paused = { ...bot }, shotCount = events.filter(e => e.type === 'shot').length;
  for (let tick = 0; tick < 90; tick++) engine.step(10_200 + tick * 1000 / 30, 1 / 30);
  assert.deepEqual(bot, paused); assert.equal(events.filter(e => e.type === 'shot').length, shotCount); assert.equal(bot.aiming, false);
  engine.addPlayer({ id: human.id, name: human.name, color: human.color }, 13_300); human.health = 100; human.shield = 50; human.protectedUntil = 0;
  engine.step(13_300, 0); assert.equal(events.filter(e => e.type === 'shot').length, shotCount, 'Recovery must start a fresh reaction delay, not replay old fire.');
});

test('close rivals use ordinary shotgun damage and cannot engage a target behind solid cover', () => {
  const { engine, human, bots, events } = practice('hard'); const bot = bots[0]!;
  place(bot, -28, 12); place(human, -28, 7);
  for (let tick = 0; tick < 60; tick++) engine.step(6000 + tick * 1000 / 30, 0);
  const shots = events.filter(e => e.type === 'shot' && e.playerId === bot.id);
  assert.ok(shots.length >= 1 && shots.every(e => e.type === 'shot' && e.slot === 2));
  for (let i = 1; i < shots.length; i++) assert.ok(shots[i]!.at - shots[i - 1]!.at >= RULES.shotgunCadenceMs - 0.001);
  assert.equal(bot.ammoShotgun, RULES.shotgunMagazine - shots.length); assert.equal(bot.ammoAR, RULES.arMagazine);
  assert.ok(events.some(e => e.type === 'damage' && e.attackerId === bot.id && e.amount > RULES.arDamage && e.amount <= 72));
  place(bot, -28, 0, Math.PI / 2); place(human, -11, 0); human.health = 100; human.shield = 50;
  engine.step(8100, 0); const count = events.filter(e => e.type === 'shot').length;
  for (let tick = 0; tick < 90; tick++) engine.step(8200 + tick * 1000 / 30, 0);
  assert.equal(events.filter(e => e.type === 'shot').length, count); assert.equal(human.health, 100); assert.equal(human.shield, 50);
});

test('AI victories and ties are valid only in practice and rematches reset the whole round', () => {
  const { engine, human, bots } = practice('normal', 3); const bot = bots[0]!;
  place(human, -28, -2); bot.kills = 14; engine.damage(human, bot, 150, 6000);
  assert.equal(engine.phase, 'finished'); assert.deepEqual(engine.winnerIds, [bot.id]);
  engine.start(7000); assert.equal(engine.phase, 'countdown'); assert.deepEqual(engine.winnerIds, []);
  for (const p of engine.players.values()) assert.deepEqual([p.kills, p.deaths, p.health, p.shield, p.ammoAR, p.ammoShotgun, p.heals, p.aiming], [0, 0, 100, 50, 30, 6, 2, false]);
  human.kills = 4; bot.kills = 4; engine.finish('Time is up.', 310_000);
  assert.deepEqual(new Set(engine.winnerIds), new Set([human.id, bot.id]));
  const friends = new MatchEngine(); assert.throws(() => friends.addPlayer(PRACTICE_RIVALS[0]!, 0, true), /only in practice/);
});

test('published aim state follows fresh inputs and clears on expiry, disconnect, death, and respawn', () => {
  const engine = new MatchEngine();
  const a = engine.addPlayer({ id: 'a', name: 'A', color: '#fff' }, 0), b = engine.addPlayer({ id: 'b', name: 'B', color: '#fff' }, 0);
  engine.start(0); engine.step(3000, 0);
  engine.acceptInput(a.id, { ...idleInput(1), aim: true }, 6000); engine.step(6000, 0); assert.equal(a.aiming, true);
  engine.step(6301, 0); assert.equal(a.aiming, false);
  engine.acceptInput(a.id, { ...idleInput(2), aim: true }, 6400); engine.step(6400, 0); engine.setConnected(a.id, false); assert.equal(a.aiming, false);
  engine.addPlayer(a, 6500); engine.acceptInput(a.id, { ...idleInput(1), aim: true }, 6500); engine.step(6500, 0);
  engine.damage(a, b, 150, 6500); assert.equal(a.aiming, false); engine.step(9500, 0); assert.equal(a.aiming, false);
});

test('three active rivals complete a bounded practice simulation without clipping or excessive tick work', t => {
  const { engine, human, bots, events } = practice('normal', 3);
  const traveled = new Map(bots.map(p => [p.id, 0])), positions = new Map(bots.map(p => [p.id, { x: p.x, y: p.y, z: p.z }]));
  const stationary = new Map(bots.map(p => [p.id, { current: 0, longest: 0 }]));
  const timings: number[] = [], start = performance.now();
  for (let tick = 1; tick <= 9001 && engine.phase !== 'finished'; tick++) {
    const before = performance.now(); engine.step(3000 + tick * 1000 / 30, 1 / 30); timings.push(performance.now() - before);
    for (const bot of bots) {
      assert.ok(!penetrates(bot), `${bot.name} must stay out of solid geometry.`);
      const previous = positions.get(bot.id)!, distance = Math.hypot(bot.x - previous.x, bot.z - previous.z);
      const idle = stationary.get(bot.id)!; idle.current = bot.health > 0 && distance < 0.005 ? idle.current + 1 : 0; idle.longest = Math.max(idle.longest, idle.current);
      if (distance < 1) traveled.set(bot.id, traveled.get(bot.id)! + distance);
      positions.set(bot.id, { x: bot.x, y: bot.y, z: bot.z });
    }
  }
  const elapsed = performance.now() - start; timings.sort((a, b) => a - b);
  t.diagnostic(`${timings.length} simulated ticks; ${elapsed.toFixed(1)}ms total; p95 ${timings[Math.floor(timings.length * 0.95)]!.toFixed(3)}ms; ${events.filter(e => e.type === 'shot').length} shots; ${events.filter(e => e.type === 'elimination').length} eliminations; travel ${JSON.stringify([...traveled.values()].map(v => Math.round(v)))}; longest stationary ${JSON.stringify([...stationary.values()].map(v => Math.round(v.longest / 30)))}s`);
  assert.equal(engine.phase, 'finished'); assert.ok(elapsed < 10_000, 'One practice room should fit comfortably inside a 30Hz server budget.');
  assert.ok([...traveled.values()].every(distance => distance > 30), 'Every rival must roam the arena.');
  assert.ok([...stationary.values()].every(idle => idle.longest < 30 * 10), 'No living rival may stall on its route for ten seconds.');
  assert.ok(events.some(e => e.type === 'elimination' && e.playerId !== human.id && e.attackerId !== human.id), 'Rivals must compete with each other, too.');
  assert.ok(events.some(e => e.type === 'damage' && e.playerId === human.id), 'Practice must challenge the human player.');
});
