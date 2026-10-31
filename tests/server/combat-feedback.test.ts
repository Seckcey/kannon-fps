import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine, idleInput, torsoCenter } from '../../server/engine.js';
import { eyePosition, magnitude, subtract } from '../../shared/physics.js';
import { type GameEvent, type InputFrame, type PlayerState, type Team, type Vec3 } from '../../shared/protocol.js';
import { damageAt, DEFAULT_LOADOUT, PELLET_PATTERN, WEAPONS } from '../../shared/weapons.js';

type ShotEvent = Extract<GameEvent, { type: 'shot' }>;
type DamageEvent = Extract<GameEvent, { type: 'damage' }>;
function playing(ids = ['a', 'b'], options: { mode?: 'ffa' | 'tdm'; teams?: Record<string, Team>; pump?: string[] } = {}) {
  const events: GameEvent[] = [];
  const engine = new MatchEngine({ practiceSeed: 'feedback', mode: options.mode, onEvent: event => events.push(event) });
  for (const id of ids) engine.addPlayer({ id, name: id, color: '#fff' }, 0, false, options.teams?.[id]);
  for (const id of options.pump ?? []) engine.setLoadout(id, { ...DEFAULT_LOADOUT, primary: 'breaker12' });
  engine.start(0); engine.step(3000, 0);
  for (const player of engine.players.values()) player.protectedUntil = 0;
  return { engine, events, a: engine.players.get('a')!, b: engine.players.get('b')!, get: (id: string) => engine.players.get(id)! };
}
const place = (player: PlayerState, x: number, z: number, y = 0) => Object.assign(player, { x, y, z, vx: 0, vy: 0, vz: 0 });
function aimAt(shooter: PlayerState, point: Vec3): Partial<InputFrame> {
  const delta = subtract(point, eyePosition(shooter));
  return { yaw: Math.atan2(delta.x, -delta.z), pitch: Math.atan2(delta.y, Math.hypot(delta.x, delta.z)) };
}
function fire(engine: MatchEngine, id: string, now: number, overrides: Partial<InputFrame> = {}) {
  const seq = engine.runtime.get(id)!.input.seq + 1;
  assert.equal(engine.acceptInput(id, { ...idleInput(seq), fire: true, viewTime: now, ...overrides }, now), true);
}
const shots = (events: GameEvent[]) => events.filter((event): event is ShotEvent => event.type === 'shot');
const damage = (events: GameEvent[]) => events.filter((event): event is DamageEvent => event.type === 'damage');
const rounded = (v: Vec3) => [v.x, v.y, v.z].every(value => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-6);
function checkTraces(shot: ShotEvent, eye: Vec3) {
  const spec = WEAPONS[shot.weapon as keyof typeof WEAPONS];
  assert.equal(shot.traces.length, spec.pellets, 'One trace per pellet, centre first.');
  assert.ok(rounded(shot.from));
  for (const trace of shot.traces) {
    assert.ok(Object.values(trace.to).every(Number.isFinite)); assert.ok(rounded(trace.to), 'Event coordinates keep millimetres.');
    assert.ok(magnitude(subtract(trace.to, eye)) <= spec.maxRange + 1e-3);
    if (trace.kind === 'player') {
      assert.equal(typeof trace.targetId, 'string'); assert.ok(['head', 'torso', 'legs'].includes(trace.zone!)); assert.equal(typeof trace.protected, 'boolean');
      assert.equal(trace.normal, undefined);
    } else {
      assert.equal(trace.zone, undefined); assert.equal(trace.protected, undefined);
      if (trace.kind === 'world') { assert.ok(trace.normal && trace.surface); assert.equal(magnitude(trace.normal), 1); }
      if (trace.kind === 'range') assert.ok(Math.abs(magnitude(subtract(trace.to, eye)) - spec.maxRange) < 2e-3);
    }
  }
}

test('the carbine publishes one trace for open range, a world contact with its surface, and the nearest player with the zone', () => {
  for (const kind of ['range', 'world', 'player'] as const) {
    const { engine, a, b, events } = playing();
    place(a, -28, kind === 'world' ? 0 : -20, kind === 'range' ? 10 : 0);
    place(b, kind === 'player' ? -18 : 20, kind === 'player' ? -20 : 20);
    fire(engine, 'a', 3100, kind === 'player' ? aimAt(a, torsoCenter(b)) : kind === 'world' ? { yaw: Math.PI / 2 } : { yaw: Math.PI / 2, pitch: 0.3 });
    engine.step(3100, 0);
    const [shot] = shots(events); assert.ok(shot); checkTraces(shot, eyePosition(a));
    assert.deepEqual([shot.weapon, shot.traces[0]!.kind, shot.hit], ['kr5', kind, kind === 'player']);
    assert.equal(a.mag[0], 29); assert.equal(damage(events).length, kind === 'player' ? 1 : 0);
    if (kind === 'world') { assert.equal(shot.traces[0]!.surface, 'concrete'); assert.deepEqual(shot.traces[0]!.normal, { x: -1, y: 0, z: 0 }); }
    if (kind === 'player') { assert.deepEqual([shot.traces[0]!.targetId, shot.traces[0]!.zone, shot.traces[0]!.protected], ['b', 'torso', false]); assert.ok(Math.abs(shot.traces[0]!.to.x - (b.x - 0.3)) < 2e-3); }
  }
});

test('the Breaker 12 publishes its fixed eight-pellet pattern, and off-centre pellets keep their own endpoints and damage', () => {
  const { engine, a, b, events } = playing(['a', 'b'], { pump: ['a'] });
  place(a, -28, -20); place(b, -18, -20.6);
  fire(engine, 'a', 3100, aimAt(a, { x: -18, y: 1.15, z: -20 })); engine.step(3100, 0);
  const [shot] = shots(events); assert.ok(shot); checkTraces(shot, eyePosition(a));
  assert.equal(shot.traces.length, PELLET_PATTERN.length);
  assert.notEqual(shot.traces[0]!.kind, 'player', 'The centre pellet passes beside the target.');
  const pellets = shot.traces.filter(trace => trace.kind === 'player');
  assert.ok(pellets.length >= 1 && pellets.every(pellet => pellet.targetId === 'b'));
  for (const pellet of pellets) assert.notDeepEqual(pellet.to, shot.traces[0]!.to);
  const expected = Math.round(pellets.reduce((total, pellet) => total + damageAt(WEAPONS.breaker12, magnitude(subtract(pellet.to, eyePosition(a))), pellet.zone!), 0));
  assert.deepEqual(damage(events).map(event => [event.playerId, event.amount, event.cause]), [['b', expected, 'bullet']]);
  assert.equal(b.health, 100 - expected); assert.equal(a.mag[0], 5);
});

test('one pellet spread can tag two players, each with one damage event', () => {
  const { engine, a, events, get } = playing(['a', 'b', 'c'], { pump: ['a'] });
  place(a, -28, -20); place(get('b'), -21, -20.5); place(get('c'), -21, -19.5);
  fire(engine, 'a', 3100, aimAt(a, { x: -21, y: 1.15, z: -20 })); engine.step(3100, 0);
  const [shot] = shots(events); checkTraces(shot!, eyePosition(a));
  assert.deepEqual(new Set(shot!.traces.filter(trace => trace.kind === 'player').map(trace => trace.targetId)), new Set(['b', 'c']));
  assert.deepEqual(damage(events).map(event => event.playerId).sort(), ['b', 'c']);
});

test('protected players stop rays without damage or a confirmed hit; the flag is a value, not a live reference', () => {
  for (const slot of [1, 2] as const) {
    const { engine, a, b, events } = playing();
    place(a, -28, -20); place(b, -21, -20); b.protectedUntil = 4100;
    fire(engine, 'a', 3100, { slot, ...aimAt(a, torsoCenter(b)) }); engine.step(3100, 0);
    if (slot === 2) { fire(engine, 'a', 3600, { slot, fire: false }); engine.step(3600, 0); fire(engine, 'a', 3633, { slot, ...aimAt(a, torsoCenter(b)) }); engine.step(3633, 0); }
    const protectedShot = shots(events).at(-1)!; checkTraces(protectedShot, eyePosition(a));
    assert.equal(protectedShot.hit, false); assert.equal(damage(events).length, 0);
    assert.ok(protectedShot.traces.every(trace => trace.kind === 'player' && trace.targetId === 'b' && trace.protected === true));
    assert.equal(b.health, 100);
    fire(engine, 'a', 4100, { slot, fire: false }); engine.step(4100, 0);
    fire(engine, 'a', 4300, { slot, ...aimAt(a, torsoCenter(b)) }); engine.step(4300, 0);
    const open = shots(events).at(-1)!;
    assert.equal(open.hit, true); assert.ok(open.traces.every(trace => trace.protected === false));
    assert.ok(b.health < 100);
    assert.ok(protectedShot.traces.every(trace => trace.protected === true), 'Published flags never change afterwards.');
  }
});

test('damage events carry the cause, zone and source; eliminations carry weapon, headshot, distance and assists', () => {
  const { engine, a, b, events } = playing();
  place(a, -28, -20); place(b, -13, -20);
  fire(engine, 'a', 3100, aimAt(a, { x: b.x, y: 1.62, z: b.z })); engine.step(3100, 0);
  const [hit] = damage(events);
  assert.deepEqual(hit, { type: 'damage', playerId: 'b', attackerId: 'a', amount: Math.round(28 * 1.4), cause: 'bullet', zone: 'head', from: { x: -28, y: 1.62, z: -20 }, at: 3100 });
  Object.assign(b, { health: 10, lastDamageAt: 3100 });
  fire(engine, 'a', 3133, { fire: false }); engine.step(3133, 0);
  fire(engine, 'a', 3200, aimAt(a, torsoCenter(b))); engine.step(3200, 0);
  const elimination = events.find((event): event is Extract<GameEvent, { type: 'elimination' }> => event.type === 'elimination');
  assert.deepEqual(elimination, { type: 'elimination', playerId: 'b', attackerId: 'a', cause: 'bullet', weapon: 'kr5', headshot: false, distance: 15, assists: [], at: 3200 });
});

test('simultaneous accepted shots publish one damage event per attacker, apply the total once and award one elimination', () => {
  const credited: string[] = [];
  for (const order of [['a', 'b', 'c'], ['b', 'a', 'c']]) {
    const { engine, events, get } = playing(order);
    const a = get('a'), b = get('b'), c = get('c');
    place(a, -29, 12); place(b, -25.5, 12); place(c, -28, -2); Object.assign(c, { health: 40, lastDamageAt: 3000 });
    fire(engine, 'a', 3100, aimAt(a, torsoCenter(c))); fire(engine, 'b', 3100, aimAt(b, torsoCenter(c))); engine.step(3100, 0);
    assert.equal(shots(events).length, 2);
    for (const shot of shots(events)) { assert.equal(shot.hit, true); assert.equal(shot.traces[0]!.targetId, 'c'); }
    assert.deepEqual(damage(events).map(event => event.attackerId).sort(), ['a', 'b']);
    assert.ok(damage(events).every(event => event.amount === 28));
    assert.deepEqual([c.health, c.deaths, a.kills + b.kills], [0, 1, 1]);
    const [down] = events.filter((event): event is Extract<GameEvent, { type: 'elimination' }> => event.type === 'elimination');
    assert.equal(down!.assists.length, 1, 'The other shooter assists.');
    credited.push(down!.attackerId);
  }
  assert.equal(credited[0], credited[1], 'Equal damage is not broken by join order.');
});

test('rejected cadence and stale inputs cannot publish extra traces or change outcomes', () => {
  const { engine, a, b, events } = playing(['a', 'b'], { pump: ['a'] });
  place(a, -28, -20); place(b, -23, -20);
  fire(engine, 'a', 3100, aimAt(a, torsoCenter(b))); engine.step(3100, 0);
  fire(engine, 'a', 3150, { fire: false }); engine.step(3150, 0);
  fire(engine, 'a', 3200, aimAt(a, torsoCenter(b))); engine.step(3200, 0); engine.step(4000, 0);
  assert.equal(shots(events).length, 1, 'The pump cannot fire again within its interval.');
  assert.equal(damage(events).length, 1); assert.equal(a.mag[0], 5);
});

test('zero, negative, sub-rounding, protected and already-down damage changes nothing and emits nothing', () => {
  for (const setup of [{ amount: 0 }, { amount: -40 }, { amount: 0.49 }, { amount: 24, protectedUntil: 3101 }, { amount: 24, health: 0 }]) {
    const { amount, ...state } = setup;
    const { engine, a, b, events } = playing(); Object.assign(b, state);
    const before = structuredClone(b); engine.damage(b, a, amount, 3100);
    assert.deepEqual(b, before); assert.deepEqual(events, []); assert.equal(a.kills, 0);
  }
});

test('teammates neither stop nor take bullets in team deathmatch', () => {
  const { engine, events, get } = playing(['a', 'b', 'c'], { mode: 'tdm', teams: { a: 'teal', b: 'gold', c: 'teal' } });
  const a = get('a'), b = get('b'), c = get('c');
  place(a, -28, -20); place(c, -25, -20); place(b, -18, -20);
  fire(engine, 'a', 3100, aimAt(a, torsoCenter(b))); engine.step(3100, 0);
  const [shot] = shots(events);
  assert.deepEqual([shot!.traces[0]!.kind, shot!.traces[0]!.targetId], ['player', 'b']);
  assert.deepEqual(damage(events).map(event => event.playerId), ['b']); assert.equal(c.health, 100);
});
