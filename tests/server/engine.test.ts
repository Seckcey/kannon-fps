import test from 'node:test';
import assert from 'node:assert/strict';
import { highestSurface, idleInput, INPUT_QUEUE_LIMIT, mainZone, MatchEngine, MAX_PITCH, sanitizeInput, torsoCenter, type EngineOptions } from '../../server/engine.js';
import { PRACTICE_RIVALS, PracticeBots } from '../../server/bots.js';
import { ARENA_LIMITS, SPAWNS } from '../../shared/map.js';
import { eyePosition, grenadeLaunch, grenadePosition, magnitude, normalize, raycastMap, subtract } from '../../shared/physics.js';
import { RULES, type GameEvent, type InputFrame, type Loadout, type PlayerState, type Team, type Vec3 } from '../../shared/protocol.js';
import { damageAt, DEFAULT_LOADOUT, DRONE, EXPLOSIVES, explosionDamage, fireIntervalMs, LOADOUT_PRESETS, WEAPONS } from '../../shared/weapons.js';

type Of<T extends GameEvent['type']> = Extract<GameEvent, { type: T }>;
const of = <T extends GameEvent['type']>(events: GameEvent[], type: T): Array<Of<T>> => events.filter((event): event is Of<T> => event.type === type);
const TICK = 1000 / 30;
/** No Quick Hands and no Second Wind: plain reload, swap and regeneration timings. */
const STEADY: Loadout = { primary: 'kr5', secondary: 'sentry9', lethal: 'frag', perks: ['deep-pockets', 'quiet-step', 'steady-aim'] };

interface Setup { ids?: string[]; options?: EngineOptions; loadouts?: Record<string, Loadout>; teams?: Record<string, Team> }
function playing({ ids = ['a', 'b'], options = {}, loadouts = {}, teams = {} }: Setup = {}) {
  const events: GameEvent[] = [], finishes: string[] = [];
  const engine = new MatchEngine({ practiceSeed: 'engine-rules', ...options, onEvent: event => events.push(event), onFinish: reason => finishes.push(reason) });
  for (const id of ids) engine.addPlayer({ id, name: id, color: '#fff' }, 0, false, teams[id]);
  for (const [id, loadout] of Object.entries(loadouts)) assert.equal(engine.setLoadout(id, loadout), true);
  engine.start(0); engine.step(3000, 0);
  for (const player of engine.players.values()) player.protectedUntil = 0;
  const get = (id: string) => engine.players.get(id)!;
  return { engine, events, finishes, a: get('a'), b: get('b'), get };
}
/** Sends the next frame for a player; view time defaults to now (no rewind). */
function send(engine: MatchEngine, id: string, now: number, changes: Partial<InputFrame> = {}) {
  const seq = engine.runtime.get(id)!.input.seq + 1;
  assert.equal(engine.acceptInput(id, { ...idleInput(seq), viewTime: now, ...changes }, now), true);
}
function aimAt(shooter: PlayerState, point: Vec3) {
  const delta = subtract(point, eyePosition(shooter));
  return { yaw: Math.atan2(delta.x, -delta.z), pitch: Math.atan2(delta.y, Math.hypot(delta.x, delta.z)) };
}
const place = (player: PlayerState, x: number, z: number, y = 0) => Object.assign(player, { x, y, z, vx: 0, vy: 0, vz: 0 });
/** Hurts a player as if just now, without crediting anyone. */
const wound = (player: PlayerState, health: number, now: number) => Object.assign(player, { health, lastDamageAt: now });
const head = (player: PlayerState): Vec3 => ({ x: player.x, y: player.y + 1.62, z: player.z });
const near = (actual: Vec3, expected: Vec3, tolerance = 0.002) => assert.ok(magnitude(subtract(actual, expected)) <= tolerance, `${JSON.stringify(actual)} is not near ${JSON.stringify(expected)}`);
const sees = (from: Vec3, to: Vec3) => { const delta = subtract(to, from), length = magnitude(delta); return raycastMap(from, normalize(delta), length) >= length - 0.01; };

test('input accepts exactly a v3 frame and rejects malformed or hostile values whole', () => {
  const valid: InputFrame = { ...idleInput(1), viewTime: 1000 };
  assert.deepEqual(sanitizeInput(valid), valid);
  const hostile: Array<[string, unknown]> = [
    ['yaw', NaN], ['viewTime', NaN], ['viewTime', null], ['viewTime', '5'], ['viewTime', Infinity], ['fire', 'yes'], ['crouch', 1], ['grenade', undefined],
    ['seq', 1.5], ['seq', -1], ['slot', 3], ['slot', '1'], ['streak', 'nuke'], ['streak', undefined],
    ['streakTarget', { x: 999, z: 0 }], ['streakTarget', { x: 0, z: -40 }], ['streakTarget', { x: 0, z: NaN }], ['streakTarget', 'here'], ['streakTarget', [1, 2]],
  ];
  for (const [key, value] of hostile) assert.equal(sanitizeInput({ ...valid, [key]: value }), null, `${key}=${String(value)}`);
  const { melee: _melee, ...missing } = valid;
  assert.equal(sanitizeInput(missing), null, 'A frame from an older page is missing v3 fields.');
  assert.equal(sanitizeInput(null), null); assert.equal(sanitizeInput([valid]), null);
  const clean = sanitizeInput({ ...valid, moveX: 1000, moveZ: -500, pitch: 500, yaw: 500, x: 100000, health: 999, streak: 'mortar', streakTarget: { x: 10, z: -5, y: 3 } });
  assert.ok(clean);
  assert.deepEqual([clean.moveX, clean.moveZ, clean.pitch, clean.streak], [1, -1, MAX_PITCH, 'mortar']);
  assert.ok(Math.abs(clean.yaw) < Math.PI * 2);
  assert.equal('x' in clean, false); assert.equal('health' in clean, false); assert.deepEqual(clean.streakTarget, { x: 10, z: -5 });
  assert.equal('streakTarget' in sanitizeInput({ ...valid, streakTarget: null })!, false, 'A null target reads as no target.');
  // The mortar may target anything up to the inner fence faces; a page must clamp to ARENA_LIMITS before sending.
  for (const target of [{ x: -ARENA_LIMITS.x, z: ARENA_LIMITS.z }, { x: ARENA_LIMITS.x, z: -ARENA_LIMITS.z }]) {
    assert.deepEqual(sanitizeInput({ ...valid, streak: 'mortar', streakTarget: target })?.streakTarget, target);
  }
  for (const target of [{ x: ARENA_LIMITS.x + 0.01, z: 0 }, { x: 0, z: -ARENA_LIMITS.z - 0.01 }]) {
    assert.equal(sanitizeInput({ ...valid, streak: 'mortar', streakTarget: target }), null, JSON.stringify(target));
  }
});

test('spawning equips the class from the weapon table; Deep Pockets adds two magazines and a frag', () => {
  const engine = new MatchEngine();
  const a = engine.addPlayer({ id: 'a', name: 'A', color: '#fff' }, 0);
  assert.deepEqual(a.loadout, DEFAULT_LOADOUT); assert.notEqual(a.loadout, DEFAULT_LOADOUT, 'Each player owns a copy of the preset.');
  assert.deepEqual([a.health, a.slot, a.weapon, a.posture, a.stamina, a.frags, a.streak], [100, 1, 'kr5', 'stand', 1, 2, 0]);
  assert.deepEqual(a.mag, [30, 12]); assert.deepEqual(a.reserve, [30 * 6, 12 * 6]);
  assert.equal(a.protectedUntil, RULES.protectionMs); assert.equal(a.readyAt, WEAPONS.kr5.raiseMs);
  assert.equal(engine.setLoadout('a', LOADOUT_PRESETS.close), true, 'The lobby applies a new class at once.');
  assert.deepEqual([a.weapon, a.frags, ...a.mag, ...a.reserve], ['hornet9', 1, 32, 12, 32 * 4, 12 * 4]);
  const invalid = [{ ...LOADOUT_PRESETS.close, perks: ['quick-hands', 'deep-pockets', 'second-wind'] }, { ...LOADOUT_PRESETS.close, primary: 'sentry9' }, null, 'assault'];
  for (const loadout of invalid) assert.equal(engine.setLoadout('a', loadout as unknown as Loadout), false);
  assert.equal(a.loadout.primary, 'hornet9');
  const b = engine.addPlayer({ id: 'b', name: 'B', color: '#fff' }, 0);
  engine.start(0); engine.step(3000, 0);
  assert.equal(a.readyAt, 3000, 'A round start raises weapons during the countdown.');
  assert.equal(engine.setLoadout('a', LOADOUT_PRESETS.marksman), true);
  assert.equal(a.loadout.primary, 'hornet9', 'During play a new class waits for the next spawn.');
  a.protectedUntil = 0;
  engine.damage(a, b, 150, 3100); engine.step(6100, 0);
  assert.deepEqual([a.health, a.weapon, a.frags], [100, 'longbow', 1]); assert.deepEqual(a.mag, [5, 12]); assert.deepEqual(a.reserve, [20, 48]);
  assert.equal(a.readyAt, 6100 + WEAPONS.longbow.raiseMs * 0.75, 'Quick Hands raises the weapon faster.');
  assert.equal(a.protectedUntil, 6100 + RULES.protectionMs);
});

test('a held jump jumps once, stale input brakes to a stop, and replayed sequences are refused', () => {
  const { engine, a } = playing();
  place(a, -28, -2);
  let now = 3100, jumps = 0, rising = false;
  for (let tick = 0; tick < 45; tick++, now += TICK) {
    send(engine, 'a', now, { moveZ: 1, jump: true }); engine.step(now, 1 / 30);
    if (a.vy > 0 && !rising) jumps++;
    rising = a.vy > 0;
  }
  assert.equal(jumps, 1, 'Holding jump does not bounce.'); assert.equal(a.lastInputSeq, 45);
  send(engine, 'a', now, { moveZ: 1 }); engine.step(now, 1 / 30); now += TICK;
  send(engine, 'a', now, { moveZ: 1, jump: true }); engine.step(now, 1 / 30);
  assert.ok(a.vy > 0, 'A fresh press jumps again.');
  for (let tick = 0; tick < 60; tick++) { now += TICK; engine.step(now, 1 / 30); }
  assert.equal(a.vx, 0); assert.equal(a.vz, 0);
  const position = { x: a.x, z: a.z }; engine.step(now + TICK, 1 / 30); assert.deepEqual({ x: a.x, z: a.z }, position);
  assert.equal(engine.acceptInput('a', { ...idleInput(3), viewTime: now }, now), false);
});

test('held automatic fire keeps the true rate on 30 Hz ticks, and a new pull never spends banked idle time', () => {
  const { engine, a, events } = playing();
  place(a, -28, -20); a.mag[0] = 1000;
  const yaw = Math.PI / 2;
  for (let tick = 0; tick < 120; tick++) { const now = 3100 + tick * TICK; send(engine, 'a', now, { fire: true, yaw }); engine.step(now, 1 / 30); }
  const burst = of(events, 'shot');
  assert.ok(Math.abs(burst.length - 4000 / fireIntervalMs(WEAPONS.kr5)) <= 1, `750 rpm over 4 s is 50 rounds, got ${burst.length}`);
  assert.equal(a.mag[0], 1000 - burst.length);
  let now = 3100 + 120 * TICK;
  send(engine, 'a', now, { yaw }); engine.step(now, 1 / 30);
  now += 500;
  for (let tick = 0; tick < 6; tick++, now += TICK) { send(engine, 'a', now, { fire: true, yaw }); engine.step(now, 1 / 30); }
  const [first, second] = of(events, 'shot').slice(burst.length);
  assert.ok(first && second && second.at - first.at >= fireIntervalMs(WEAPONS.kr5) - 1e-6, 'The second round of a new pull waits a full interval.');
});

test('semi-automatic weapons fire once per press and never faster than their cap', () => {
  const { engine, a, events } = playing();
  place(a, -28, -20); const yaw = Math.PI / 2;
  send(engine, 'a', 3100, { slot: 2, yaw }); engine.step(3100, 0);
  assert.equal(a.weapon, 'sentry9'); assert.equal(a.readyAt, 3100 + WEAPONS.sentry9.raiseMs);
  let now = 3500;
  for (let tick = 0; tick < 30; tick++, now += TICK) { send(engine, 'a', now, { slot: 2, fire: true, yaw }); engine.step(now, 0); }
  assert.equal(of(events, 'shot').length, 1, 'Holding the trigger fires one round.');
  for (let tick = 0; tick < 45; tick++, now += TICK) { send(engine, 'a', now, { slot: 2, fire: tick % 2 === 1, yaw }); engine.step(now, 0); }
  // Release and press again inside every tick, the fastest a page can tap.
  for (let tick = 0; tick < 30; tick++, now += TICK) { send(engine, 'a', now, { slot: 2, yaw }); send(engine, 'a', now + 1, { slot: 2, fire: true, yaw }); engine.step(now + 2, 0); }
  const times = of(events, 'shot').map(shot => shot.at);
  assert.ok(times.length >= 6, `${times.length} rounds`);
  for (let i = 1; i < times.length; i++) assert.ok(times[i]! - times[i - 1]! >= fireIntervalMs(WEAPONS.sentry9) - 1e-6, 'Rapid taps are capped.');
  assert.equal(a.mag[1], 12 - times.length);
});

test('a semi-automatic press made too early fires once, as soon as allowed, while the trigger is held', () => {
  const { engine, a, events } = playing();
  place(a, -28, -20); const yaw = Math.PI / 2;
  send(engine, 'a', 3100, { slot: 2, yaw }); engine.step(3100, 0);
  let now = 3200;
  for (let tick = 0; tick < 20; tick++, now += TICK) { send(engine, 'a', now, { slot: 2, fire: true, yaw }); engine.step(now, 0); }
  const [shot] = of(events, 'shot');
  assert.equal(of(events, 'shot').length, 1, 'One press, one round.');
  assert.equal(a.readyAt, 3100 + WEAPONS.sentry9.raiseMs);
  assert.ok(shot!.at >= a.readyAt && shot!.at < a.readyAt + TICK + 1e-6, `fired at ${shot!.at}, raised at ${a.readyAt}`);
  send(engine, 'a', now, { slot: 2, yaw }); engine.step(now, 0);
  for (let tick = 0; tick < 15; tick++) { now += TICK; send(engine, 'a', now, { slot: 2, moveZ: 1, sprint: true, yaw }); engine.step(now, 1 / 30); }
  const sprintEnded = now;
  for (let tick = 0; tick < 12; tick++) { now += TICK; send(engine, 'a', now, { slot: 2, moveZ: 1, sprint: true, fire: true, yaw }); engine.step(now, 1 / 30); }
  const shots = of(events, 'shot');
  assert.equal(shots.length, 2, 'A press while sprinting fires once after sprint-to-fire.');
  assert.ok(shots[1]!.at >= sprintEnded + WEAPONS.sentry9.sprintToFireMs);
});

test('damage falls off with range and depends on the zone hit', () => {
  const cases: Array<[number, 'head' | 'torso' | 'legs', number]> = [[10, 'torso', 28], [30, 'torso', 25], [50, 'torso', 22], [10, 'head', 39], [10, 'legs', 24]];
  for (const [range, zone, expected] of cases) {
    const { engine, a, b, events } = playing();
    place(a, -28, -20); place(b, -28 + range, -20);
    const point = zone === 'head' ? head(b) : zone === 'legs' ? { x: b.x, y: 0.5, z: b.z } : torsoCenter(b);
    send(engine, 'a', 3100, { fire: true, ...aimAt(a, point) }); engine.step(3100, 0);
    const [shot] = of(events, 'shot'), [hit] = of(events, 'damage');
    assert.equal(shot!.traces[0]!.zone, zone); assert.ok(hit, `${range} m ${zone}`);
    const distance = magnitude(subtract(shot!.traces[0]!.to, eyePosition(a)));
    assert.equal(hit.amount, Math.round(damageAt(WEAPONS.kr5, distance, zone))); assert.equal(hit.amount, expected, `${range} m ${zone}`);
    assert.equal(b.health, 100 - expected);
  }
});

test('shots rewind a strafing target to what the shooter saw: 150 to 380 ms behind hits, 500 ms behind is clamped and misses', () => {
  const zAt = (t: number) => -21 + 5 * (t - 3100) / 1000;
  // 380 ms is a 100 ms round trip each way on top of the 100 ms draw delay and the send, tick and queue waits.
  for (const [aimLag, viewLag, hits] of [[150, 150, true], [150, 0, false], [300, 300, true], [380, 380, true], [500, 500, false]] as const) {
    const { engine, a, b, events } = playing();
    place(a, -28, -20);
    let now = 3100;
    for (let tick = 0; tick < 20; tick++, now = 3100 + tick * TICK) { place(b, -13, zAt(now)); engine.step(now, 0); }
    const fireAt = 3100 + 20 * TICK;
    place(b, -13, zAt(fireAt));
    send(engine, 'a', fireAt, { fire: true, viewTime: fireAt - viewLag, ...aimAt(a, { x: -13, y: 1.15, z: zAt(fireAt - aimLag) }) });
    engine.step(fireAt, 0);
    const [shot] = of(events, 'shot');
    assert.equal(shot!.traces[0]!.kind === 'player', hits, `aim ${aimLag} ms behind with view ${viewLag} ms behind`);
    assert.equal(b.health < 100, hits);
  }
});

test('health refills at 50 per second after 4 s without damage, or after 2.5 s with Second Wind', () => {
  const { engine, a, b } = playing({ loadouts: { b: STEADY } });
  engine.damage(b, a, 60, 4000); engine.damage(a, b, 60, 4000);
  assert.deepEqual([a.health, b.health], [40, 40]);
  engine.step(6499, 0); assert.equal(a.health, 40);
  engine.step(7000, 0); assert.equal(a.health, 65, 'Second Wind (in the default class) starts after 2.5 s.');
  engine.step(7999, 0); assert.equal(b.health, 40); assert.equal(a.health, 100);
  engine.step(8500, 0); assert.equal(b.health, 65);
  engine.damage(b, a, 10, 8500); assert.equal(b.health, 55);
  engine.step(12_499, 0); assert.equal(b.health, 55, 'New damage restarts the pause.');
  engine.step(13_010, 0); assert.equal(b.health, 80); assert.ok(Number.isInteger(b.health));
  engine.step(14_000, 0); assert.equal(b.health, 100);
});

test('the knife downs the nearest enemy in reach and in front with a clear line, then blocks firing briefly', () => {
  const { engine, a, b, events } = playing();
  place(a, -28, -20); place(b, -25.6, -20);
  send(engine, 'a', 3100, { melee: true, yaw: Math.PI / 2 }); engine.step(3100, 0);
  assert.deepEqual(of(events, 'melee').map(e => [e.playerId, e.targetId]), [['a', 'b']]);
  const [down] = of(events, 'elimination');
  assert.deepEqual([down!.cause, down!.attackerId, b.health, a.meleeUntil], ['melee', 'a', 0, 3100 + RULES.meleeMs]);
  assert.ok(of(events, 'medal').some(m => m.playerId === 'a' && m.medal === 'blade'));
  assert.ok(a.readyAt >= a.meleeUntil);
  send(engine, 'a', 3500, { fire: true, yaw: Math.PI / 2 }); engine.step(3500, 0);
  assert.equal(of(events, 'shot').length, 0, 'No firing while the knife is out.');
  for (const [label, ax, az, bx, bz, yaw] of [
    ['out of reach', -28, -20, -25.2, -20, Math.PI / 2], ['behind', -28, -20, -26, -20, -Math.PI / 2], ['through the fence', -25, -11.2, -25, -9.8, Math.PI],
  ] as const) {
    const run = playing();
    place(run.a, ax, az); place(run.b, bx, bz);
    send(run.engine, 'a', 3100, { melee: true, yaw }); run.engine.step(3100, 0);
    assert.equal(of(run.events, 'melee')[0]!.targetId, undefined, label); assert.equal(run.b.health, 100, label);
  }
});

test('a cooked frag explodes in hand at the fuse and hurts only what it can see, its thrower included', () => {
  const { engine, events, get } = playing({ ids: ['a', 'b', 'c'] });
  const a = get('a'), b = get('b'), c = get('c');
  place(a, -14, 14.5); place(b, -14, 16.4); place(c, -14, 12.6);
  assert.equal(sees(torsoCenter(a), torsoCenter(c)), false, 'The garage wall stands between them.');
  send(engine, 'a', 3100, { grenade: true }); engine.step(3100, 0);
  assert.deepEqual([a.cookingSince, a.frags], [3100, 1]);
  for (let now = 3134; now < 6500; now += 33) { send(engine, 'a', now, { grenade: true }); engine.step(now, 0); }
  assert.equal(of(events, 'explosion').length, 0);
  send(engine, 'a', 6500, { grenade: true }); engine.step(6500, 0);
  const [blast] = of(events, 'explosion');
  assert.equal(blast!.cause, 'frag'); near(blast!.position, { x: -14, y: 1.62, z: 14.5 });
  assert.deepEqual(new Set(of(events, 'damage').map(d => `${d.playerId}:${d.cause}`)), new Set(['a:frag', 'b:frag']));
  assert.deepEqual([a.health, b.health, c.health], [0, 0, 100]);
  assert.deepEqual([a.kills, a.deaths, b.deaths], [1, 1, 1]);
  assert.ok(of(events, 'medal').some(m => m.playerId === 'a' && m.medal === 'grenadier'));
  assert.equal(a.streak, 0, 'A kill made going down does not start a streak.');
});

test('a frag is thrown on release and explodes where the shared trajectory puts it at cook start plus the fuse', () => {
  const { engine, a, events } = playing();
  place(a, -28, -20);
  const view = { yaw: Math.PI / 2, pitch: 0.2 };
  send(engine, 'a', 3100, { grenade: true, ...view }); engine.step(3100, 0);
  send(engine, 'a', 4100, { ...view }); engine.step(4100, 0);
  const [thrown] = of(events, 'grenade');
  assert.ok(thrown); assert.deepEqual([thrown.explodeAt, thrown.at, a.cookingSince, a.frags], [6500, 4100, 0, 1]);
  const launch = grenadeLaunch(eyePosition(a), view.yaw, view.pitch, a, EXPLOSIVES.frag.throwSpeed, EXPLOSIVES.frag.throwLift);
  near(thrown.from, launch.from); near(thrown.velocity, launch.velocity);
  for (let now = 4150; now < 6500; now += 50) engine.step(now, 0);
  assert.equal(of(events, 'explosion').length, 0);
  engine.step(6500, 0);
  const [blast] = of(events, 'explosion');
  near(blast!.position, grenadePosition(thrown.from, thrown.velocity, thrown.explodeAt - thrown.at), 0.0015);
});

test('a frag being cooked drops live where its thrower goes down', () => {
  const { engine, a, b, events } = playing();
  place(a, -28, -20); place(b, -10, -20);
  send(engine, 'a', 3100, { grenade: true }); engine.step(3100, 0);
  engine.damage(a, b, 150, 3300);
  const [dropped] = of(events, 'grenade');
  assert.ok(dropped); assert.deepEqual(dropped.velocity, { x: 0, y: 0, z: 0 }); assert.equal(dropped.explodeAt, 6500);
  near(dropped.from, { x: -28, y: 1.62, z: -20 });
  for (let now = 3400; now <= 6500; now += 100) engine.step(now, 0);
  assert.equal(of(events, 'explosion').length, 1);
});

test('a cooked frag stays in hand through a network stall; only a real frame releases it', () => {
  const { engine, a, events } = playing();
  place(a, -28, -20);
  send(engine, 'a', 3100, { grenade: true, yaw: 1 }); engine.step(3100, 0);
  // No frames arrive for half a second: movement stops, but silence is not a release.
  for (let now = 3133; now <= 3600; now += 33) engine.step(now, 1 / 30);
  assert.equal(of(events, 'grenade').length, 0, 'A stalled connection does not throw the grenade.');
  assert.deepEqual([a.cookingSince, a.frags], [3100, 1]);
  send(engine, 'a', 3650, { yaw: 1 }); engine.step(3650, 0);
  const [thrown] = of(events, 'grenade');
  assert.ok(thrown); assert.deepEqual([thrown.at, thrown.explodeAt, a.cookingSince], [3650, 6500, 0]);
  // A stall that outlasts the fuse ends in the hand, as holding it would.
  const held = playing(); place(held.a, -28, -20);
  send(held.engine, 'a', 3100, { grenade: true }); held.engine.step(3100, 0);
  for (let now = 3200; now <= 6500; now += 100) held.engine.step(now, 0);
  assert.equal(of(held.events, 'grenade').length, 0);
  const [blast] = of(held.events, 'explosion');
  assert.ok(blast); assert.equal(blast.at, 6500); near(blast.position, { x: -28, y: 1.62, z: -20 });
});

test('reloads draw from the reserve, an empty magazine reloads slower, and each elimination returns a magazine', () => {
  const { engine, a, b } = playing();
  a.mag[0] = 10; a.reserve[0] = 25;
  send(engine, 'a', 3100, { reload: true }); engine.step(3100, 0);
  assert.deepEqual([a.reloadingUntil, a.reloadSlot], [3100 + WEAPONS.kr5.reloadMs, 1]);
  engine.step(5199, 0); assert.equal(a.mag[0], 10);
  engine.step(5200, 0); assert.deepEqual([a.mag[0], a.reserve[0], a.reloadingUntil], [30, 5, 0]);
  a.mag[0] = 0; place(a, -28, -20);
  send(engine, 'a', 5300, { fire: true, yaw: Math.PI / 2 }); engine.step(5300, 0);
  assert.equal(a.reloadingUntil, 5300 + WEAPONS.kr5.emptyReloadMs, 'Pulling the trigger on empty starts the slower empty reload.');
  engine.step(5300 + WEAPONS.kr5.emptyReloadMs, 0); assert.deepEqual([a.mag[0], a.reserve[0]], [5, 0]);
  engine.damage(b, a, 150, 8000); assert.equal(a.reserve[0], 30, 'An elimination returns one magazine.');
  engine.step(11_000, 0); b.protectedUntil = 0; a.reserve[0] = 175;
  engine.damage(b, a, 150, 11_100); assert.equal(a.reserve[0], 180, 'The reserve never grows past what a spawn carries.');
});

test('swapping waits for the new weapon to come up, faster with Quick Hands, and a swap cancels a reload', () => {
  for (const [loadout, raise] of [[DEFAULT_LOADOUT, WEAPONS.sentry9.raiseMs], [LOADOUT_PRESETS.close, WEAPONS.sentry9.raiseMs * 0.75]] as const) {
    const { engine, a, events } = playing({ loadouts: { a: loadout } });
    place(a, -28, -20); a.mag[0] = 5;
    const yaw = Math.PI / 2;
    send(engine, 'a', 3100, { reload: true, yaw }); engine.step(3100, 0); assert.ok(a.reloadingUntil);
    send(engine, 'a', 3200, { slot: 2, yaw }); engine.step(3200, 0);
    assert.deepEqual([a.reloadingUntil, a.mag[0], a.weapon, a.readyAt], [0, 5, 'sentry9', 3200 + raise]);
    send(engine, 'a', 3200 + raise - 1, { slot: 2, fire: true, yaw }); engine.step(3200 + raise - 1, 0);
    assert.equal(of(events, 'shot').length, 0, 'Still raising.');
    send(engine, 'a', 3200 + raise + 10, { slot: 2, yaw }); engine.step(3200 + raise + 10, 0);
    send(engine, 'a', 3200 + raise + 40, { slot: 2, fire: true, yaw }); engine.step(3200 + raise + 40, 0);
    assert.equal(of(events, 'shot').length, 1);
  }
});

test('after a bolt or pump shot the sidearm fires as soon as it is up, and swapping back cannot skip the cycle', () => {
  for (const primary of ['longbow', 'breaker12'] as const) {
    const { engine, a, events } = playing({ loadouts: { a: { ...STEADY, primary } } });
    place(a, -28, -20);
    const yaw = Math.PI / 2, spec = WEAPONS[primary], cycle = 3100 + fireIntervalMs(spec);
    const fired = (weapon: string) => of(events, 'shot').filter(shot => shot.weapon === weapon).map(shot => shot.at);
    send(engine, 'a', 3100, { fire: true, yaw }); engine.step(3100, 0);
    send(engine, 'a', 3133, { yaw }); engine.step(3133, 0);
    send(engine, 'a', 3166, { slot: 2, yaw }); engine.step(3166, 0);
    const up = 3166 + WEAPONS.sentry9.raiseMs;
    assert.equal(a.readyAt, up); assert.ok(up < cycle, `Setup: the sidearm is up before the ${primary} could fire again.`);
    send(engine, 'a', up, { slot: 2, fire: true, yaw }); engine.step(up, 0);
    assert.deepEqual(fired('sentry9'), [up], `${primary}: the sidearm waits only for its own raise.`);
    // Straight back to the main gun: it still has to finish its own bolt or pump cycle.
    const back = up + 10;
    send(engine, 'a', back, { slot: 1, yaw }); engine.step(back, 0);
    for (let now = back + TICK; now < back + 2000 && fired(primary).length < 2; now += TICK) { send(engine, 'a', now, { slot: 1, fire: true, yaw }); engine.step(now, 0); }
    const [, second] = fired(primary), allowed = Math.max(cycle, back + spec.raiseMs);
    assert.ok(second !== undefined && second >= allowed && second < allowed + TICK + 1e-6, `${primary}: second shot at ${second}, allowed from ${allowed}`);
  }
});

test('the first shot after a sprint waits sprint-to-fire, and longer after the faster dash', () => {
  for (const dash of [false, true]) {
    const { engine, a, events } = playing();
    place(a, -28, -20);
    const yaw = Math.PI / 2;
    let now = 3100, lastSprint = 0;
    for (let tick = 0; tick < 20; tick++, now += TICK) {
      send(engine, 'a', now, { moveZ: 1, sprint: true, dash, yaw }); engine.step(now, 1 / 30);
      if (a.sprinting) lastSprint = now;
    }
    assert.ok(lastSprint > 0); assert.equal(!!a.dashing, dash);
    for (let tick = 0; tick < 20 && !of(events, 'shot').length; tick++, now += TICK) { send(engine, 'a', now, { moveZ: 1, sprint: true, dash, fire: true, yaw }); engine.step(now, 1 / 30); }
    const delay = WEAPONS.kr5.sprintToFireMs * (dash ? 1.4 : 1), [first] = of(events, 'shot');
    assert.ok(first, 'The shot comes eventually.');
    assert.ok(first.at >= lastSprint + delay && first.at < lastSprint + delay + TICK + 1e-6, `${first.at - lastSprint} ms after the sprint`);
  }
});

test('the Breaker 12 reloads shell by shell and a shot stops the reload between shells', () => {
  const pump: Loadout = { ...DEFAULT_LOADOUT, primary: 'breaker12' };
  const { engine, a, events } = playing({ loadouts: { a: pump } });
  place(a, -28, -20); a.mag[0] = 2;
  const spec = WEAPONS.breaker12, yaw = Math.PI / 2;
  assert.equal(a.reserve[0], spec.magazine * (spec.reserveMags + 2));
  send(engine, 'a', 3100, { reload: true, yaw }); engine.step(3100, 0);
  assert.equal(a.reloadingUntil, 3100 + spec.shellStartMs! + 4 * spec.perShellMs!);
  engine.step(3100 + spec.shellStartMs! + spec.perShellMs! - 1, 0); assert.equal(a.mag[0], 2);
  engine.step(3100 + spec.shellStartMs! + spec.perShellMs!, 0); assert.equal(a.mag[0], 3);
  engine.step(3100 + spec.shellStartMs! + 2 * spec.perShellMs!, 0); assert.equal(a.mag[0], 4);
  send(engine, 'a', 4400, { fire: true, yaw }); engine.step(4400, 0);
  assert.deepEqual([a.reloadingUntil, a.mag[0], a.reserve[0], of(events, 'shot').length], [0, 3, spec.magazine * 5 - 2, 1]);
  const [shot] = of(events, 'shot'); assert.equal(shot!.traces.length, spec.pellets);
});

test('a trigger tap that cannot fire yet leaves a shell reload running; a held press stops it only when it fires', () => {
  const { engine, a, events } = playing({ loadouts: { a: { ...STEADY, primary: 'breaker12' } } });
  place(a, -28, -20);
  const spec = WEAPONS.breaker12, yaw = Math.PI / 2, shells = (spec.shellStartMs ?? 0) + spec.perShellMs!;
  send(engine, 'a', 3100, { fire: true, yaw }); engine.step(3100, 0);
  send(engine, 'a', 3133, { yaw }); engine.step(3133, 0);
  send(engine, 'a', 3200, { reload: true, yaw }); engine.step(3200, 0);
  assert.equal(a.reloadingUntil, 3200 + shells);
  // Tapped and let go inside the pump's fire delay.
  send(engine, 'a', 3400, { fire: true, yaw }); engine.step(3400, 0);
  send(engine, 'a', 3433, { yaw }); engine.step(3433, 0);
  assert.deepEqual([a.reloadingUntil, a.mag[0], of(events, 'shot').length], [3200 + shells, 5, 1], 'The early tap changed nothing.');
  engine.step(3200 + shells, 0); assert.deepEqual([a.mag[0], a.reloadingUntil], [spec.magazine, 0], 'The reload finished.');
  // Held through the delay instead: the shot goes off once allowed, and only then ends the reload.
  send(engine, 'a', 4300, { fire: true, yaw }); engine.step(4300, 0);
  send(engine, 'a', 4333, { yaw }); engine.step(4333, 0);
  send(engine, 'a', 4400, { reload: true, yaw }); engine.step(4400, 0);
  const cycle = 4300 + fireIntervalMs(spec);
  let now = 4500;
  for (; now < cycle; now += TICK) { send(engine, 'a', now, { fire: true, yaw }); engine.step(now, 0); assert.equal(a.reloadingUntil, 4400 + shells, 'Still reloading while the shot waits.'); }
  send(engine, 'a', now, { fire: true, yaw }); engine.step(now, 0);
  assert.deepEqual([of(events, 'shot').length, a.mag[0], a.reloadingUntil], [3, 4, 0]);
});

test('team deathmatch splits the humans, fills even sides with bots, spawns each team at home and has no friendly fire', () => {
  const engine = new MatchEngine({ mode: 'tdm', fillBots: true, practiceSeed: 'teams' });
  const dad = engine.addPlayer({ id: 'dad', name: 'Dad', color: '#fff' }, 0), son = engine.addPlayer({ id: 'son', name: 'Son', color: '#fff' }, 0);
  assert.notEqual(dad.team, son.team, 'The two humans are split.');
  for (const rival of PRACTICE_RIVALS.slice(0, 2)) engine.addPlayer(rival, 0, true);
  const roster = [...engine.players.values()];
  for (const team of ['teal', 'gold'] as const) {
    assert.equal(roster.filter(p => p.team === team).length, 2); assert.equal(roster.filter(p => p.team === team && !p.bot).length, 1);
  }
  engine.removePlayer('son');
  assert.deepEqual(['teal', 'gold'].map(team => [...engine.players.values()].filter(p => p.team === team).length).sort(), [1, 2], 'Bots reseat to even the sides.');
  engine.start(0);
  for (const player of engine.players.values()) assert.ok(player.team === 'teal' ? player.x < 0 : player.x > 0, `${player.id} spawns at home`);

  const { engine: match, events, get, finishes } = playing({ ids: ['a', 'b', 'c'], options: { mode: 'tdm' }, teams: { a: 'teal', b: 'gold', c: 'teal' } });
  const a = get('a'), b = get('b'), c = get('c');
  place(a, -28, -20); place(c, -24, -20); place(b, -18, -20);
  send(match, 'a', 3100, { fire: true, ...aimAt(a, torsoCenter(b)) }); match.step(3100, 0);
  const [shot] = of(events, 'shot');
  assert.equal(shot!.traces[0]!.targetId, 'b', 'Bullets pass through teammates.');
  assert.deepEqual([c.health, b.health < 100], [100, true]);
  wound(b, 10, 3100); match.teamScores.teal = RULES.tdmScoreLimit - 1;
  send(match, 'a', 3300, { fire: true, ...aimAt(a, torsoCenter(b)) }); match.step(3300, 0);
  assert.equal(match.phase, 'finished'); assert.equal(match.winningTeam, 'teal');
  assert.deepEqual(new Set(match.winnerIds), new Set(['a', 'c'])); assert.equal(finishes.length, 1);
  assert.deepEqual(match.snapshot(3300).teamScores, { teal: RULES.tdmScoreLimit, gold: 0 });
});

test('team grenades and the drone never hurt teammates', () => {
  const { engine, events, get } = playing({ ids: ['a', 'b', 'c'], options: { mode: 'tdm' }, teams: { a: 'teal', b: 'gold', c: 'teal' } });
  const a = get('a'), b = get('b'), c = get('c');
  place(a, -28, -20); place(c, -27, -20); place(b, -26, -20);
  send(engine, 'a', 3100, { grenade: true }); engine.step(3100, 0);
  for (let now = 3200; now <= 6500; now += 100) { send(engine, 'a', now, { grenade: true }); engine.step(now, 0); }
  assert.deepEqual(new Set(of(events, 'damage').map(d => d.playerId)), new Set(['a', 'b']));
  assert.equal(c.health, 100);

  const air = playing({ ids: ['a', 'b', 'c'], options: { mode: 'tdm' }, teams: { a: 'teal', b: 'gold', c: 'teal' } });
  place(air.get('a'), -28, -20); place(air.get('c'), 0, -19); place(air.get('b'), 3, -19); air.get('a').rewards = ['drone'];
  send(air.engine, 'a', 3100, { streak: 'drone' }); air.engine.step(3100, 0);
  assert.equal(air.engine.snapshot(3100).drones[0]!.team, 'teal');
  for (let now = 3150; now < 13_000; now += 50) { air.get('b').health = 100; air.engine.step(now, 0); }
  const fired = of(air.events, 'shot').filter(shot => shot.weapon === 'drone');
  assert.ok(fired.length > 5); assert.ok(fired.every(shot => shot.traces.every(trace => trace.targetId !== 'c')));
  assert.equal(air.get('c').health, 100);
});

test('movement uses the weapon handling, publishes aim and sprint, and no sprinting while cooking or knifing', () => {
  const speed = (p: PlayerState) => Math.hypot(p.vx, p.vz);
  for (const [changes, expected, label] of [
    [{}, 5 * WEAPONS.kr5.moveFactor, 'hip'], [{ aim: true }, 5 * WEAPONS.kr5.adsMoveFactor, 'aiming'],
    [{ sprint: true }, 6.9 * WEAPONS.kr5.moveFactor, 'sprinting'], [{ sprint: true, grenade: true }, 5 * WEAPONS.kr5.moveFactor, 'cooking'],
  ] as const) {
    const { engine, a } = playing();
    place(a, -28, -2);
    for (let tick = 0; tick < 20; tick++) { const now = 3100 + tick * TICK; send(engine, 'a', now, { moveZ: 1, ...changes }); engine.step(now, 1 / 30); }
    assert.ok(Math.abs(speed(a) - expected) < 0.01, `${label}: ${speed(a)} m/s`);
    assert.equal(a.aiming, 'aim' in changes, label); assert.equal(a.sprinting, label === 'sprinting', label);
  }
  const { engine, a } = playing();
  place(a, -28, -2);
  send(engine, 'a', 3100, { moveZ: 1, sprint: true, melee: true }); engine.step(3100, 1 / 30);
  assert.equal(a.sprinting, false, 'No sprinting while the knife is out.');
  send(engine, 'a', 3100 + RULES.meleeMs + 1, { moveZ: 1, sprint: true }); engine.step(3100 + RULES.meleeMs + 1, 1 / 30);
  assert.equal(a.sprinting, true);
});

test('firing waits until a vault is 70% through, and firing, throwing or knifing ends spawn protection', () => {
  const { engine, a, events } = playing();
  place(a, -9.3, 2.8);
  send(engine, 'a', 3100, { moveZ: 1, jump: true, yaw: -Math.PI / 2 }); engine.step(3100, 1 / 30);
  const vault = a.vault; assert.ok(vault, 'The front window sill is vaultable.');
  let now = 3100, firstShot = -1;
  for (let tick = 1; tick < 20 && firstShot < 0; tick++) {
    now = 3100 + tick * TICK;
    send(engine, 'a', now, { moveZ: 1, fire: true, yaw: -Math.PI / 2 }); engine.step(now, 1 / 30);
    if (of(events, 'shot').length) firstShot = now;
  }
  const progress = (firstShot - vault.start) / (vault.end - vault.start);
  assert.ok(progress >= 0.7 && progress < 0.7 + TICK / (vault.end - vault.start) + 1e-6, `first shot at ${progress.toFixed(2)} of the vault`);
  for (const action of [{ fire: true }, { grenade: true }, { melee: true }] as const) {
    const run = playing(); place(run.a, -28, -20); run.a.protectedUntil = 10_000;
    send(run.engine, 'a', 3100, { ...action, yaw: Math.PI / 2 }); run.engine.step(3100, 0);
    if ('grenade' in action) { send(run.engine, 'a', 3133, { yaw: Math.PI / 2 }); run.engine.step(3133, 0); }
    assert.equal(run.a.protectedUntil, 0, JSON.stringify(action));
  }
});

test('respawns avoid every spot a living enemy can see while a hidden spawn exists', () => {
  {
    const { engine, a, b } = playing();
    place(b, -14, 10);
    const visible = SPAWNS.map(spawn => sees(eyePosition(b), { x: spawn.x, y: 1.2, z: spawn.z }));
    const farthest = SPAWNS.map((spawn, index) => ({ index, distance: Math.hypot(spawn.x - b.x, spawn.z - b.z) })).sort((p, q) => q.distance - p.distance)[0]!;
    assert.ok(visible[farthest.index] && visible.includes(false), 'Setup: the farthest spawn is in view of the enemy.');
    engine.damage(a, b, 150, 3100); engine.step(6100, 0);
    const chosen = SPAWNS.findIndex(spawn => spawn.x === a.x && spawn.z === a.z);
    assert.ok(chosen >= 0 && !visible[chosen], `spawned at ${chosen}, which the enemy can see`);
    const hidden = SPAWNS.map((spawn, index) => ({ index, distance: Math.hypot(spawn.x - b.x, spawn.z - b.z) })).filter(({ index }) => !visible[index]).sort((p, q) => q.distance - p.distance);
    assert.equal(chosen, hidden[0]!.index, 'Among hidden spawns, the farthest.');
  }
  {
    const { engine, a, b } = playing({ options: { mode: 'tdm' }, teams: { a: 'teal', b: 'gold' } });
    place(b, -28, 6);
    engine.damage(a, b, 150, 3100); engine.step(6100, 0);
    assert.ok(a.x < 0, 'Teal spawns on its own side.');
    assert.equal(sees(eyePosition(b), { x: a.x, y: 1.2, z: a.z }), false, 'The intruder cannot see the spawn chosen.');
  }
});

test('team deathmatch moves a respawn to the far side when enemies watch every home spawn, but never a round start', () => {
  const { engine, get } = playing({ ids: ['a', 'b', 'c'], options: { mode: 'tdm' }, teams: { a: 'teal', b: 'gold', c: 'gold' } });
  const a = get('a'), b = get('b'), c = get('c');
  // Two gold players in the teal back yard: between them they can see all four teal spawns.
  place(b, -30.4, -22.4); place(c, -25.4, 17.6);
  const seen = (point: Vec3) => [b, c].some(enemy => sees(eyePosition(enemy), { x: point.x, y: point.y + 1.2, z: point.z }));
  assert.ok(SPAWNS.filter(spawn => spawn.x < 0).every(seen), 'Setup: every teal spawn is in view.');
  assert.ok(SPAWNS.some(spawn => spawn.x > 0 && !seen(spawn)), 'Setup: a gold-side spawn is hidden from both.');
  engine.damage(a, b, 150, 3100); engine.step(3100 + RULES.respawnMs, 0);
  assert.equal(a.health, 100);
  assert.equal(seen(a), false, 'The respawn is out of both intruders\' sight.');
  assert.ok(a.x > 0, 'With home in view, the spawn moves to the far side.');

  // A new round always starts each team at home.
  engine.finish('Test round over.', 4000); engine.start(5000);
  for (const player of engine.players.values()) assert.ok(player.team === 'teal' ? player.x < 0 : player.x > 0, `${player.id} starts at home`);

  // A full four-a-side round spreads each team over its own four spawns instead of stacking teammates.
  const full = new MatchEngine({ mode: 'tdm', practiceSeed: 'four-a-side' });
  for (let i = 0; i < RULES.maxPlayers; i++) full.addPlayer({ id: `p${i}`, name: `P${i}`, color: '#fff' }, 0);
  full.start(0);
  const roster = [...full.players.values()];
  assert.equal(new Set(roster.map(p => `${p.x},${p.z}`)).size, RULES.maxPlayers, roster.map(p => `${p.id} ${p.team} (${p.x}, ${p.z})`).join('; '));
  for (const player of roster) assert.ok(player.team === 'teal' ? player.x < 0 : player.x > 0, `${player.id} starts at home`);
});

test('streaks earn rewards at 3, 5 and 7 kills, reset when you go down, and earned rewards wait for later lives', () => {
  const { engine, a, b, events } = playing();
  let now = 3100;
  for (let kill = 1; kill <= 7; kill++) {
    engine.damage(b, a, 150, now); now += RULES.respawnMs; engine.step(now, 0); b.protectedUntil = 0; now += 10;
    assert.equal(a.streak, kill);
  }
  assert.deepEqual(a.rewards, ['recon', 'mortar', 'drone']);
  assert.deepEqual(of(events, 'streak').map(e => [e.reward, e.action]), [['recon', 'earned'], ['mortar', 'earned'], ['drone', 'earned']]);
  assert.deepEqual(of(events, 'medal').filter(m => m.medal.startsWith('streak')).map(m => m.medal), ['streak-3', 'streak-5', 'streak-7']);
  assert.equal(of(events, 'score').filter(s => s.reason === 'streak-reward').length, 3);
  a.protectedUntil = 0; engine.damage(a, b, 150, now);
  assert.equal(a.streak, 0); assert.deepEqual(a.rewards, ['recon', 'mortar', 'drone'], 'Unused rewards are kept.');
  engine.step(now + RULES.respawnMs, 0); assert.deepEqual(a.rewards, ['recon', 'mortar', 'drone']);
});

test('Recon Sweep lasts 20 s; unearned or untargeted rewards do nothing', () => {
  const { engine, a, events } = playing();
  send(engine, 'a', 3100, { streak: 'drone' }); engine.step(3100, 0);
  assert.deepEqual([engine.drones.length, of(events, 'streak').length], [0, 0], 'A reward you have not earned does nothing.');
  a.rewards = ['mortar', 'recon'];
  send(engine, 'a', 3200, { streak: 'mortar' }); engine.step(3200, 0);
  assert.deepEqual([engine.mortars.length, a.rewards], [0, ['mortar', 'recon']], 'The mortar needs a spot on the map.');
  send(engine, 'a', 3300, { streak: 'recon' }); engine.step(3300, 0);
  assert.deepEqual(a.rewards, ['mortar']);
  assert.deepEqual(engine.snapshot(3300).recon, [{ ownerId: 'a', until: 3300 + RULES.reconMs }]);
  engine.step(3300 + RULES.reconMs - 1, 0); assert.equal(engine.recon.length, 1);
  engine.step(3300 + RULES.reconMs, 0); assert.equal(engine.recon.length, 0);
  assert.deepEqual(of(events, 'streak').map(e => [e.reward, e.action]), [['recon', 'used'], ['recon', 'ended']]);
});

test('Mortar Volley lands three seeded shells after its delays on the highest surface, sparing its caller', () => {
  const run = () => {
    const { engine, a, b, events } = playing();
    place(a, 1.5, -21); place(b, 0, -20); a.rewards = ['mortar']; a.streak = 2;
    send(engine, 'a', 3100, { streak: 'mortar', streakTarget: { x: 0, z: -20 } }); engine.step(3100, 0);
    assert.deepEqual(engine.snapshot(3100).mortars, [{ id: engine.mortars[0]!.id, ownerId: 'a', x: 0, z: -20, impacts: EXPLOSIVES.mortar.delaysMs.map(delay => 3100 + delay) }]);
    for (let now = 3200; now <= 6600; now += 100) engine.step(now, 0);
    return { engine, a, b, events };
  };
  const { engine, a, b, events } = run();
  const blasts = of(events, 'explosion');
  assert.deepEqual(blasts.map(blast => blast.at), [5100, 5800, 6500]);
  for (const blast of blasts) {
    assert.equal(blast.cause, 'mortar');
    assert.ok(Math.hypot(blast.position.x, blast.position.z + 20) <= EXPLOSIVES.mortar.scatter + 1e-6);
    assert.ok(Math.abs(blast.position.y - highestSurface(blast.position.x, blast.position.z)) < 1e-3);
  }
  assert.ok(of(events, 'damage').every(d => d.playerId !== 'a'), 'The caller is never hit by their own mortar.');
  assert.equal(b.deaths, 1); assert.equal(of(events, 'elimination')[0]!.cause, 'mortar');
  assert.equal(a.streak, 2, 'Reward kills do not extend streaks.');
  assert.equal(engine.mortars.length, 0); assert.deepEqual(of(events, 'streak').map(e => e.action), ['used', 'ended']);
  assert.deepEqual(run().events.filter(e => e.type === 'explosion'), blasts, 'Scatter is seeded, not random.');
  assert.ok(Math.abs(highestSurface(-16, 0) - 6.42) < 1e-9, 'Shells land on the house roof, not inside.');
});

test('the Attack Drone circles for 25 s, fires at visible enemies with a seeded chance, and can be shot down', () => {
  const { engine, a, b, events } = playing();
  place(a, -28, -20); place(b, 0, -19); a.rewards = ['drone'];
  send(engine, 'a', 3100, { streak: 'drone' }); engine.step(3100, 0);
  const [drone] = engine.snapshot(3100).drones;
  assert.ok(drone); assert.deepEqual([drone.ownerId, drone.health, drone.until, drone.y], ['a', RULES.droneHealth, 3100 + RULES.droneMs, DRONE.height]);
  assert.ok(Math.abs(Math.hypot(drone.x, drone.z) - DRONE.orbitRadius) < 1e-3);
  for (let now = 3200; now < 3100 + RULES.droneMs; now += 50) engine.step(now, 0);
  const shots = of(events, 'shot').filter(shot => shot.weapon === 'drone');
  assert.ok(shots.length >= 10, `${shots.length} drone shots`);
  for (let i = 1; i < shots.length; i++) assert.ok(shots[i]!.at - shots[i - 1]!.at >= DRONE.fireIntervalMs - 1e-6);
  assert.ok(shots.every(shot => shot.playerId === 'a' && shot.traces.every(trace => trace.targetId !== 'a')));
  assert.ok(shots.some(shot => shot.hit) && shots.some(shot => !shot.hit), 'Some shots hit and some miss.');
  assert.ok(of(events, 'damage').filter(d => d.cause === 'drone').every(d => d.playerId === 'b' && d.amount === DRONE.damage));
  assert.equal(a.streak, 0, 'Drone kills do not extend streaks.');
  engine.step(3100 + RULES.droneMs, 0);
  assert.equal(engine.drones.length, 0); assert.deepEqual(of(events, 'streak').map(e => e.action), ['used', 'ended']);

  const shootDown = playing({ ids: ['a', 'b', 'c'] }), c = shootDown.get('c');
  place(shootDown.a, -28, -20); place(c, 0, -19); shootDown.a.rewards = ['drone']; c.mag[0] = 100;
  send(shootDown.engine, 'a', 3100, { streak: 'drone' }); shootDown.engine.step(3100, 0);
  const live = shootDown.engine.drones[0]!;
  let now = 3100;
  for (let tick = 0; tick < 300 && shootDown.engine.drones.length; tick++) {
    now += TICK;
    const angle = live.angle + DRONE.speed / DRONE.orbitRadius * (now - live.startedAt) / 1000;
    const target = { x: Math.cos(angle) * DRONE.orbitRadius, y: DRONE.height, z: Math.sin(angle) * DRONE.orbitRadius };
    c.health = 100; c.protectedUntil = 0;
    send(shootDown.engine, 'c', now, { fire: sees(eyePosition(c), target), ...aimAt(c, target) }); shootDown.engine.step(now, 0);
  }
  assert.equal(shootDown.engine.drones.length, 0, 'Enough hits bring it down.');
  assert.ok(of(shootDown.events, 'shot').some(shot => shot.playerId === 'c' && shot.traces[0]!.kind === 'drone' && shot.traces[0]!.targetId === live.id));
  assert.ok(of(shootDown.events, 'medal').some(m => m.playerId === 'c' && m.medal === 'drone-down'));
  assert.ok(of(shootDown.events, 'score').some(s => s.playerId === 'c' && s.reason === 'drone-down'));
  assert.ok(of(shootDown.events, 'explosion').some(e => e.cause === 'drone' && e.id === live.id));
});

test('each viewer receives their own full state while everyone else stays public', () => {
  const { engine, a, b } = playing();
  a.rewards = ['recon']; Object.assign(a, { x: 1.23456789, yaw: 0.123456789, readyAt: 3456.7 });
  const view = engine.snapshot(3100.4, 'a');
  assert.equal(view.serverTime, 3100); assert.deepEqual([view.mode, view.scoreLimit, view.teamScores], ['ffa', RULES.ffaScoreLimit, undefined]);
  assert.deepEqual([view.drones, view.recon, view.mortars], [[], [], []]);
  assert.equal(view.self?.id, 'a'); assert.deepEqual(view.self.mag, a.mag); assert.deepEqual(view.self.rewards, ['recon']); assert.equal(view.self.readyAt, 3457);
  const hidden = ['mag', 'reserve', 'frags', 'rewards', 'reloadSlot', 'readyAt', 'meleeUntil', 'stamina', 'slideCooldownUntil', 'lastDamageAt'];
  for (const player of view.players) for (const key of hidden) assert.equal(key in player, false, `${player.id}.${key} is private`);
  const own = view.players.find(player => player.id === 'a')!;
  assert.deepEqual([own.x, own.yaw], [1.235, 0.1235], 'Positions keep millimetres and angles four decimals.');
  assert.equal(engine.snapshot(3100, 'b').self?.id, 'b'); assert.equal(b.id, 'b');
  assert.equal(engine.snapshot(3100).self, undefined); assert.equal(engine.snapshot(3100, 'nobody').self, undefined);
  view.self.mag[0] = 0; view.players[0]!.loadout.perks[0] = 'quick-hands';
  assert.equal(a.mag[0], 30); assert.equal(a.loadout.perks[0], 'deep-pockets', 'Snapshots are copies.');
});

test('eliminations score points and medals: headshot, long shot, first strike, even score, double and assists', () => {
  const { engine, events, get } = playing({ ids: ['a', 'b', 'c'] });
  const a = get('a'), b = get('b'), c = get('c');
  place(a, -28, -20); place(b, 7, -20); place(c, -28, -18);
  engine.damage(b, c, 25, 3100); wound(b, 30, 3100);
  send(engine, 'a', 3200, { fire: true, ...aimAt(a, head(b)) }); engine.step(3200, 0);
  const [down] = of(events, 'elimination');
  assert.deepEqual([down!.attackerId, down!.weapon, down!.headshot, down!.assists], ['a', 'kr5', true, ['c']]);
  assert.ok(Math.abs(down!.distance - 35) < 0.05);
  assert.deepEqual(of(events, 'score').map(s => [s.playerId, s.reason, s.points]), [
    ['a', 'elimination', 100], ['a', 'headshot', 50], ['a', 'long-shot', 50], ['a', 'first-strike', 100], ['c', 'assist', 50],
  ]);
  assert.deepEqual(of(events, 'medal').map(m => m.medal), ['headshot', 'long-shot', 'first-strike']);
  assert.deepEqual([a.score, a.kills, c.assists, c.score], [300, 1, 1, 50]);
  const before = events.length;
  engine.step(6200, 0); b.protectedUntil = 0; a.protectedUntil = 0;
  engine.damage(a, b, 150, 6300);
  assert.ok(of(events.slice(before), 'medal').some(m => m.playerId === 'b' && m.medal === 'even-score'), 'Downing whoever downed you evens the score.');
  assert.ok(!of(events.slice(before), 'medal').some(m => m.medal === 'first-strike'));
  engine.step(9300, 0); for (const p of [a, b, c]) p.protectedUntil = 0;
  const mark = events.length;
  engine.damage(b, a, 150, 9400); engine.damage(c, a, 150, 9400 + RULES.multiKillWindowMs);
  assert.deepEqual(of(events.slice(mark), 'medal').filter(m => m.medal === 'double').map(m => m.playerId), ['a']);
});

test('a shotgun blast is a headshot only when the head took the largest share of it', () => {
  assert.equal(mainZone({ head: 28, torso: 84, legs: 0 }), 'torso');
  assert.equal(mainZone({ head: 14, torso: 14, legs: 0 }), 'torso', 'A tie is not a headshot.');
  assert.equal(mainZone({ head: 28, torso: 0, legs: 14 }), 'head');
  assert.equal(mainZone({ head: 0, torso: 0, legs: 0 }), undefined);
  for (const [label, aimY, headshot] of [['upper chest', 1.35, false], ['face', 1.62, true]] as const) {
    const { engine, a, b, events } = playing({ loadouts: { a: { ...STEADY, primary: 'breaker12' } } });
    place(a, -28, -20); place(b, -25, -20); wound(b, 40, 3000);
    send(engine, 'a', 3100, { fire: true, ...aimAt(a, { x: b.x, y: aimY, z: b.z }) }); engine.step(3100, 0);
    const zones = of(events, 'shot')[0]!.traces.filter(trace => trace.kind === 'player').map(trace => trace.zone!);
    const count = (zone: string) => zones.filter(z => z === zone).length;
    assert.ok(count('head') > 0 && (headshot ? count('head') > count('torso') + count('legs') : count('head') < count('torso')), `${label} setup: ${zones.join(',')}`);
    const [down] = of(events, 'elimination'), [hit] = of(events, 'damage');
    assert.ok(down, `${label}: the blast downs the target`);
    assert.equal(down.headshot, headshot, label); assert.equal(hit!.zone, headshot ? 'head' : 'torso', label);
    assert.equal(of(events, 'medal').some(m => m.medal === 'headshot'), headshot, label);
    assert.equal(of(events, 'score').some(s => s.reason === 'headshot'), headshot, label);
  }
});

test('multi-kills only pair kills made while standing in one life', () => {
  const { engine, events, get } = playing({ ids: ['a', 'b', 'c'] });
  const a = get('a'), b = get('b'), c = get('c');
  const multi = () => [of(events, 'medal').filter(m => m.playerId === 'a' && (m.medal === 'double' || m.medal === 'triple')).length, of(events, 'score').filter(s => s.playerId === 'a' && s.reason === 'multi').length];
  engine.damage(b, a, 150, 3100);
  engine.damage(a, c, 150, 3150);
  engine.step(3150 + RULES.respawnMs, 0); for (const p of [a, c]) p.protectedUntil = 0;
  engine.damage(c, a, 150, 3100 + RULES.multiKillWindowMs - 100);
  assert.deepEqual(multi(), [0, 0], 'A kill before going down does not pair with one after the respawn.');

  // A grenade that lands after its thrower went down does not make a multi-kill either.
  const late = playing({ ids: ['a', 'b', 'c', 'd'] });
  const [la, lb, lc, ld] = ['a', 'b', 'c', 'd'].map(late.get) as [PlayerState, PlayerState, PlayerState, PlayerState];
  place(la, -28, -20); place(lc, -27, -20); place(ld, 28, 20);
  send(late.engine, 'a', 3100, { grenade: true }); late.engine.step(3100, 0);
  late.engine.damage(lb, la, 150, 3200);
  late.engine.damage(la, ld, 150, 4000);
  for (let now = 4100; now <= 6500; now += 100) late.engine.step(now, 0);
  assert.deepEqual([lc.deaths, la.kills], [1, 2], 'Setup: the dropped frag downs c after a went down.');
  assert.equal(of(late.events, 'medal').some(m => m.playerId === 'a' && (m.medal === 'double' || m.medal === 'triple')), false);
});

test('the match ends at 15 eliminations or when time is up, once, with every tied leader winning', () => {
  const { engine, a, b, finishes } = playing();
  a.kills = RULES.ffaScoreLimit - 1; engine.damage(b, a, 150, 3100);
  assert.deepEqual([engine.phase, engine.winnerIds, finishes.length], ['finished', ['a'], 1]);
  const timed = playing();
  timed.a.kills = 3; timed.b.kills = 3;
  timed.engine.step(3000 + RULES.matchSeconds * 1000, 0);
  assert.equal(timed.engine.phase, 'finished'); assert.deepEqual(new Set(timed.engine.winnerIds), new Set(['a', 'b']));
  assert.equal(timed.engine.winningTeam, undefined);
});

function simultaneousDuel(order: string[], kills = 0) {
  const events: GameEvent[] = []; let finishCount = 0;
  const engine = new MatchEngine({ practiceSeed: 'duel', onEvent: event => events.push(event), onFinish: () => { finishCount++; } });
  for (const id of order) engine.addPlayer({ id, name: id, color: '#fff' }, 0);
  engine.start(0); engine.step(3000, 0);
  const a = engine.players.get('a')!, b = engine.players.get('b')!;
  place(a, -28, 12); place(b, -28, -2);
  for (const p of [a, b]) Object.assign(p, { protectedUntil: 0, kills, health: 24, lastDamageAt: 3000 });
  send(engine, 'a', 3100, { fire: true, ...aimAt(a, torsoCenter(b)) });
  send(engine, 'b', 3100, { fire: true, ...aimAt(b, torsoCenter(a)) });
  engine.step(3100, 0);
  return { engine, a, b, events, finishCount: () => finishCount };
}
test('mutual lethal shots resolve together, whatever the join order', () => {
  for (const order of [['a', 'b'], ['b', 'a']]) {
    const { engine, a, b, events } = simultaneousDuel(order);
    assert.deepEqual([a.health, b.health, a.kills, b.kills, a.deaths, b.deaths, a.streak, b.streak], [0, 0, 1, 1, 1, 1, 0, 0]);
    assert.deepEqual([a.mag[0], b.mag[0], engine.phase], [29, 29, 'playing']);
    assert.equal(of(events, 'shot').filter(shot => shot.hit).length, 2);
    assert.deepEqual(of(events, 'medal').filter(m => m.medal === 'first-strike').map(m => m.playerId).sort(), ['a', 'b'], 'A trade shares the first strike.');
  }
});
test('simultaneous score-limit eliminations finish once as a draw', () => {
  for (const order of [['a', 'b'], ['b', 'a']]) {
    const { engine, a, b, finishCount } = simultaneousDuel(order, RULES.ffaScoreLimit - 1);
    assert.deepEqual([a.kills, b.kills, engine.phase, engine.endedAt], [RULES.ffaScoreLimit, RULES.ffaScoreLimit, 'finished', 3100]);
    assert.deepEqual(new Set(engine.winnerIds), new Set(['a', 'b']));
    assert.equal(finishCount(), 1, 'A simultaneous draw announces one result.');
  }
});
test('simultaneous contributions grant one elimination without join order breaking a tie', () => {
  const credited: string[] = [];
  for (const order of [['a', 'b', 'c'], ['b', 'a', 'c']]) {
    const engine = new MatchEngine({ practiceSeed: 'tie' });
    for (const id of order) engine.addPlayer({ id, name: id, color: '#fff' }, 0);
    engine.start(0); engine.step(3000, 0);
    const a = engine.players.get('a')!, b = engine.players.get('b')!, c = engine.players.get('c')!;
    place(a, -29, 12); place(b, -25.5, 12); place(c, -28, -2);
    for (const p of [a, b, c]) p.protectedUntil = 0;
    wound(c, 24, 3000);
    send(engine, 'a', 3100, { fire: true, ...aimAt(a, torsoCenter(c)) }); send(engine, 'b', 3100, { fire: true, ...aimAt(b, torsoCenter(c)) });
    engine.step(3100, 0);
    assert.deepEqual([c.health, c.deaths, a.kills + b.kills, a.mag[0], b.mag[0]], [0, 1, 1, 29, 29]);
    credited.push(a.kills ? 'a' : 'b');
  }
  assert.equal(credited[0], credited[1]);
});

test('a press and its release batched between ticks are both simulated, one step apart, so no fire, jump, reload, crouch or knife action is lost', () => {
  const { engine, a, b, events } = playing();
  place(a, -28, 12); place(b, -28, -2);
  const aim = aimAt(a, torsoCenter(b));
  send(engine, 'a', 3100, { fire: true, ...aim }); send(engine, 'a', 3101, { ...aim });
  engine.step(3130, 0);
  assert.equal(of(events, 'shot').length, 1); assert.equal(a.mag[0], 29);
  engine.step(3330, 0); assert.equal(of(events, 'shot').length, 1, 'A released tap does not become held fire.');
  send(engine, 'a', 3400, { jump: true }); send(engine, 'a', 3401, {});
  engine.step(3430, 1 / 30); assert.ok(a.vy > 0);
  send(engine, 'a', 3500, { reload: true }); send(engine, 'a', 3501, {});
  engine.step(3530, 0);
  assert.ok(Math.abs(a.reloadingUntil - (3530 - TICK + WEAPONS.kr5.reloadMs)) < 1e-6, 'The press frame runs one step before the release frame, which ends on the tick.');
  send(engine, 'a', 6000, { melee: true }); send(engine, 'a', 6001, {});
  engine.step(6030, 0); assert.equal(of(events, 'melee').length, 1);
  send(engine, 'a', 7000, { grenade: true }); send(engine, 'a', 7001, {});
  engine.step(7030, 0); assert.equal(of(events, 'grenade').length, 1, 'A quick tap throws at once.');
  const run = playing(); place(run.a, -28, -20);
  let now = 3100;
  for (let tick = 0; tick < 20; tick++, now += TICK) { send(run.engine, 'a', now, { moveZ: 1, sprint: true, yaw: Math.PI / 2 }); run.engine.step(now, 1 / 30); }
  send(run.engine, 'a', now, { moveZ: 1, sprint: true, crouch: true, yaw: Math.PI / 2 }); send(run.engine, 'a', now + 1, { moveZ: 1, sprint: true, yaw: Math.PI / 2 });
  run.engine.step(now + 20, 1 / 30);
  assert.equal(run.a.posture, 'slide', 'A crouch tap between ticks still starts the slide.');
});

test('a queued shot keeps its weapon and view while a later swap still applies', () => {
  const { engine, a, b, events } = playing();
  place(a, -28, 12); place(b, -28, -2); engine.step(3050, 0);
  send(engine, 'a', 3100, { fire: true, slot: 1, ...aimAt(a, torsoCenter(b)) });
  send(engine, 'a', 3101, { slot: 2, yaw: Math.PI, pitch: 0.4 });
  engine.step(3130, 0);
  assert.deepEqual([a.slot, a.yaw, a.pitch, a.mag[0], a.mag[1]], [2, Math.PI, 0.4, 29, 12]);
  const [shot] = of(events, 'shot'); assert.equal(shot!.weapon, 'kr5'); assert.equal(shot!.traces[0]!.targetId, 'b');
  send(engine, 'a', 3200, { slot: 1 }); send(engine, 'a', 3201, { slot: 2, fire: true });
  engine.step(3230, 0); assert.equal(of(events, 'shot').length, 1, 'A press made after a swap waits for the new weapon.');
});

test('queued presses stay bounded by the fire rate, the queue limit, duplicate sequences, kept-press expiry and disconnects', () => {
  const { engine, a, events } = playing();
  place(a, -28, -20);
  const yaw = Math.PI / 2, queue = () => engine.runtime.get('a')!.queue;
  const tap = (now: number) => { send(engine, 'a', now, { fire: true, yaw }); send(engine, 'a', now + 1, { yaw }); };
  const drain = (from: number) => { let now = from; for (; queue().length; now += TICK) engine.step(now, 0); return now; };
  // Eight taps in 15 ms: only the newest six frames wait, and the dropped taps leave one kept press.
  for (let i = 0; i < 8; i++) tap(3100 + i * 2);
  assert.equal(queue().length, INPUT_QUEUE_LIMIT);
  let now = drain(3130);
  assert.equal(of(events, 'shot').length, 2, 'Press edges cannot beat the fire rate: six frames are 200 ms of the shooter\'s clock.');
  assert.equal(a.mag[0], 28);
  const seq = engine.runtime.get('a')!.input.seq;
  assert.equal(engine.acceptInput('a', { ...idleInput(seq), fire: true, viewTime: now }, now), false);
  engine.step(now, 0); now += TICK; assert.equal(of(events, 'shot').length, 2, 'A refused duplicate cannot queue an action.');
  // A tap in a frame dropped from a full queue is kept only briefly.
  now += 500; send(engine, 'a', now, { fire: true, yaw });
  for (let i = 1; i <= INPUT_QUEUE_LIMIT; i++) send(engine, 'a', now + i, { yaw });
  now = drain(now + 400); assert.equal(of(events, 'shot').length, 2, 'An old kept press expires.');
  tap(now); engine.setConnected('a', false); engine.step(now + 30, 0); assert.equal(of(events, 'shot').length, 2);
  engine.addPlayer({ id: 'a', name: 'a', color: '#fff' }, now + 100); engine.step(now + 130, 0);
  assert.equal(of(events, 'shot').length, 2, 'Recovery cannot replay a tap from before the disconnect.');
});

test('a disconnect clears published velocity and actions, and reconnecting waits for fresh input', () => {
  const { engine, a } = playing();
  place(a, -28, 12);
  for (let now = 3100; now < 3300; now += TICK) { send(engine, 'a', now, { moveX: 1, fire: true, reload: true, grenade: true }); engine.step(now, 1 / 30); }
  assert.ok(a.vx > 0); assert.ok(a.cookingSince > 0);
  const frags = a.frags;
  engine.setConnected('a', false);
  assert.deepEqual([a.vx, a.vy, a.vz, a.reloadingUntil, a.cookingSince, a.frags, a.aiming, a.sprinting], [0, 0, 0, 0, 0, frags + 1, false, false]);
  const position = { x: a.x, y: a.y, z: a.z }; engine.step(3400, 1 / 30);
  assert.deepEqual({ x: a.x, y: a.y, z: a.z }, position);
  engine.addPlayer({ id: 'a', name: 'Dad', color: '#fff' }, 3500); engine.step(3500, 1 / 30);
  assert.deepEqual([a.vx, a.vz, a.lastInputSeq], [0, 0, 0]);
  assert.equal(engine.acceptInput('a', { ...idleInput(1), moveX: -1, viewTime: 3600 }, 3600), true);
  engine.step(3600, 1 / 30); assert.ok(a.vx < 0);
});

test('a dropped player stays a frozen body that bullets, the knife, a frag and the drone can down, and heals only like an idle player', () => {
  {
    const { engine, a, b, events } = playing({ loadouts: { a: STEADY } });
    place(a, -28, -20); place(b, -18, -20); wound(a, 10, 3000); a.streak = 6;
    engine.setConnected('a', false);
    send(engine, 'b', 3100, { fire: true, ...aimAt(b, torsoCenter(a)) }); engine.step(3100, 0);
    const [down] = of(events, 'elimination');
    assert.deepEqual([down?.playerId, down?.attackerId, down?.cause, b.kills, a.deaths, a.streak], ['a', 'b', 'bullet', 1, 1, 0], 'Leaving mid-fight does not dodge the kill.');
    engine.step(3100 + RULES.respawnMs + 500, 0); assert.equal(a.health, 0, 'A dropped player is not respawned while away.');
    engine.addPlayer({ id: 'a', name: 'a', color: '#fff' }, 7000); engine.step(7000, 0); assert.equal(a.health, 100, 'They respawn on return.');
  }
  {
    const { engine, a } = playing({ loadouts: { a: STEADY } });
    wound(a, 10, 3000); engine.setConnected('a', false);
    engine.step(6999, 0); assert.equal(a.health, 10);
    engine.step(7500, 0); assert.equal(a.health, 35, 'Healing goes on while away, at the idle rate.');
    engine.addPlayer({ id: 'a', name: 'a', color: '#fff' }, 7500); engine.step(7500 + TICK, 0);
    assert.ok(a.health < 40, `Coming back is not a fresh start (${a.health}).`);
  }
  {
    const { engine, a, b, events } = playing();
    place(a, -28, -20); place(b, -25.6, -20); engine.setConnected('a', false);
    send(engine, 'b', 3100, { melee: true, yaw: -Math.PI / 2 }); engine.step(3100, 0);
    assert.deepEqual(of(events, 'melee').map(e => e.targetId), ['a']); assert.equal(a.health, 0, 'The knife finds the frozen body.');
  }
  {
    const { engine, a, b, events } = playing();
    place(a, -28, -20); place(b, -26.5, -20); engine.setConnected('a', false);
    send(engine, 'b', 3100, { grenade: true }); engine.step(3100, 0);
    for (let now = 3200; now <= 6500; now += 100) { send(engine, 'b', now, { grenade: true }); engine.step(now, 0); }
    assert.ok(of(events, 'damage').some(d => d.playerId === 'a' && d.cause === 'frag'), 'A frag hurts the frozen body.');
  }
  {
    const { engine, a, b, events } = playing();
    place(b, -28, -20); place(a, 0, -19); b.rewards = ['drone']; engine.setConnected('a', false);
    send(engine, 'b', 3100, { streak: 'drone' }); engine.step(3100, 0);
    for (let now = 3150; now < 3100 + RULES.droneMs; now += 50) { a.health = 100; engine.step(now, 0); }
    assert.ok(of(events, 'damage').some(d => d.playerId === 'a' && d.cause === 'drone'), 'The drone fires on the frozen body.');
  }
});

test('team results keep everyone on their side while players leave the results screen, and the rematch reseats', () => {
  const { engine, get } = playing({ ids: ['a', 'b', 'c', 'd'], options: { mode: 'tdm' } });
  const teams = () => Object.fromEntries([...engine.players.values()].map(p => [p.id, p.team]));
  const before = teams();
  assert.deepEqual(before, { a: 'teal', b: 'gold', c: 'teal', d: 'gold' });
  engine.teamScores.teal = 5; engine.finish('Time is up.', 4000);
  assert.equal(engine.winningTeam, 'teal'); assert.deepEqual(new Set(engine.winnerIds), new Set(['a', 'c']));
  engine.removePlayer('b'); engine.removePlayer('d');
  assert.deepEqual(teams(), { a: 'teal', c: 'teal' }, 'A winner is never moved to the losing side under the results.');
  engine.start(5000);
  assert.notEqual(get('a').team, get('c').team, 'The next round evens the sides again.');

  const filled = new MatchEngine({ mode: 'tdm', fillBots: true, practiceSeed: 'results' });
  for (const id of ['h1', 'h2']) filled.addPlayer({ id, name: id, color: '#fff' }, 0);
  for (const rival of PRACTICE_RIVALS.slice(0, 2)) filled.addPlayer(rival, 0, true);
  filled.start(0); filled.step(3000, 0); filled.finish('Time is up.', 4000);
  const sides = new Map([...filled.players.values()].map(p => [p.id, p.team]));
  filled.removePlayer('h2');
  for (const player of filled.players.values()) assert.equal(player.team, sides.get(player.id), `${player.id} keeps its side on the results screen`);
  assert.equal(filled.addPlayer(PRACTICE_RIVALS[2]!, 4100, true).team, sides.get('h2'), 'A rival added after the match takes the smaller side.');
});

test('one frag downing two rivals as the round\'s first kills awards First Strike once', () => {
  const { engine, events, get } = playing({ ids: ['a', 'b', 'c'] });
  const a = get('a'), b = get('b'), c = get('c');
  place(a, -28, -20); place(b, -27, -20); place(c, -28, -19);
  send(engine, 'a', 3100, { grenade: true }); engine.step(3100, 0);
  for (let now = 3200; now <= 6500; now += 100) { send(engine, 'a', now, { grenade: true }); engine.step(now, 0); }
  assert.deepEqual([b.deaths, c.deaths, a.kills], [1, 1, 2], 'Setup: one frag downs both rivals in one resolution.');
  assert.deepEqual(of(events, 'score').filter(s => s.reason === 'first-strike').map(s => s.playerId), ['a']);
  assert.deepEqual(of(events, 'medal').filter(m => m.medal === 'first-strike').map(m => m.playerId), ['a']);
  assert.equal(a.score, 2 * 100 + 100, 'Two eliminations and one First Strike.');
});

test('real rooms roll spread from a secret source and seed rivals privately, so the public round id predicts nothing', t => {
  const shots = () => {
    const events: GameEvent[] = [];
    // No practice seed, exactly as the server creates rooms.
    const engine = new MatchEngine({ onEvent: event => events.push(event) });
    for (const id of ['a', 'b']) engine.addPlayer({ id, name: id, color: '#fff' }, 0);
    engine.setLoadout('a', LOADOUT_PRESETS.marksman); engine.start(0); engine.step(3000, 0);
    engine.id = 'the-round-id-every-snapshot-shows';
    const a = engine.players.get('a')!; place(a, -28, -20); place(engine.players.get('b')!, 28, 20);
    for (let i = 0; i < 4; i++) {
      const now = 3100 + i * 1500;
      send(engine, 'a', now, { fire: true, yaw: Math.PI / 2 }); engine.step(now, 0);
      send(engine, 'a', now + TICK, { yaw: Math.PI / 2 }); engine.step(now + TICK, 0);
    }
    return of(events, 'shot').map(shot => shot.traces[0]!.to);
  };
  const first = shots(), second = shots();
  assert.equal(first.length, 4, 'Setup: four Heron 7 shots from the hip.');
  assert.notDeepEqual(first, second, 'Two rooms showing the same round id roll different spread.');
  const seeds: string[] = [], reset = PracticeBots.prototype.reset;
  t.mock.method(PracticeBots.prototype, 'reset', function (this: PracticeBots, seed?: string) { seeds.push(String(seed)); return reset.call(this, seed); });
  const casual = new MatchEngine({ fillBots: true });
  casual.addPlayer({ id: 'h', name: 'H', color: '#fff' }, 0); casual.addPlayer(PRACTICE_RIVALS[0]!, 0, true);
  casual.start(0);
  assert.equal(seeds.length, 1); assert.notEqual(seeds[0], casual.id); assert.ok(seeds[0]!.length >= 32, 'Rival brains get a private seed each round.');
});

test('bots in team play receive the mode and only send complete frames to the engine', () => {
  const engine = new MatchEngine({ mode: 'tdm', practice: true, practiceSeed: 'bot-frames' });
  const human = engine.addPlayer({ id: 'human', name: 'Human', color: '#fff' }, 0);
  for (const rival of PRACTICE_RIVALS) engine.addPlayer(rival, 0, true);
  engine.start(0);
  for (let tick = 0; tick < 300; tick++) engine.step(3000 + tick * TICK, 1 / 30);
  for (const player of engine.players.values()) {
    const input = engine.runtime.get(player.id)!.input;
    assert.ok(sanitizeInput(input), `${player.id} holds a complete frame`);
  }
  assert.ok(human.team);
});
