import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine, idleInput } from '../../server/engine.js';
import { cameraPosition, PLAYER_HEIGHT, PLAYER_RADIUS } from '../../shared/physics.js';
import { RULES, type GameEvent, type InputFrame, type PlayerState, type Vec3 } from '../../shared/protocol.js';

type ShotEvent = Extract<GameEvent, { type: 'shot' }>;
type DamageEvent = Extract<GameEvent, { type: 'damage' }>;
function playing(ids = ['a', 'b']) {
  const events: GameEvent[] = [];
  const engine = new MatchEngine({ onEvent: event => events.push(event) });
  for (const id of ids) engine.addPlayer({ id, name: id, color: '#fff' }, 0);
  engine.start(0); engine.step(3000, 0);
  for (const player of engine.players.values()) player.protectedUntil = 0;
  return { engine, events, a: engine.players.get('a')!, b: engine.players.get('b')! };
}
function aimAt(shooter: PlayerState, target: PlayerState): Partial<InputFrame> {
  let yaw = Math.atan2(target.x - shooter.x, -(target.z - shooter.z)); let pitch = 0;
  for (let i = 0; i < 20; i++) {
    const eye = cameraPosition(shooter, yaw, pitch, true);
    const dx = target.x - eye.x, dz = target.z - eye.z;
    yaw = Math.atan2(dx, -dz); pitch = Math.atan2(target.y + 1.2 - eye.y, Math.hypot(dx, dz));
  }
  return { yaw, pitch, aim: true };
}
function fire(engine: MatchEngine, id: string, now: number, overrides: Partial<InputFrame> = {}) {
  const seq = engine.runtime.get(id)!.input.seq + 1;
  assert.equal(engine.acceptInput(id, { ...idleInput(seq), fire: true, aim: true, ...overrides }, now), true);
}
function shots(events: GameEvent[]): ShotEvent[] { return events.filter((event): event is ShotEvent => event.type === 'shot'); }
function damage(events: GameEvent[]): DamageEvent[] { return events.filter((event): event is DamageEvent => event.type === 'damage'); }
function near(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`); }
function distance(a: Vec3, b: Vec3) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
function checkTraces(shot: ShotEvent) {
  assert.ok(shot.traces);
  assert.equal(shot.traces.length, shot.slot === 1 ? 1 : 9, 'Only existing muzzle rays are published, excluding the camera ray.');
  assert.deepEqual(shot.to, shot.traces[0]!.to, 'Legacy display endpoint remains the center pellet.');
  for (const trace of shot.traces) {
    assert.ok(Object.values(trace.to).every(Number.isFinite));
    assert.ok(distance(shot.from, trace.to) <= (shot.slot === 1 ? 100 : 40) + 1e-8);
    if (trace.kind === 'player') {
      assert.equal(typeof trace.targetId, 'string'); assert.equal(typeof trace.shield, 'boolean'); assert.equal(typeof trace.protected, 'boolean');
    } else {
      assert.equal(trace.targetId, undefined); assert.equal(trace.shield, undefined); assert.equal(trace.protected, undefined);
      if (trace.kind === 'range') near(distance(shot.from, trace.to), shot.slot === 1 ? 100 : 40);
    }
  }
}

test('AR publishes one original muzzle endpoint for range, wall occlusion, and the closest player', () => {
  for (const kind of ['range', 'world', 'player'] as const) {
    const { engine, a, b, events } = playing();
    Object.assign(a, { x: -28, y: kind === 'range' ? 10 : 0, z: kind === 'world' ? -4 : 12 });
    Object.assign(b, { x: kind === 'player' ? -28 : -11, y: 0, z: kind === 'player' ? -2 : 0 });
    fire(engine, 'a', 3100, kind === 'player' ? aimAt(a, b) : { yaw: kind === 'world' ? Math.PI / 2 : 0 }); engine.step(3100, 0);
    const [shot] = shots(events); assert.ok(shot); checkTraces(shot);
    assert.equal(shot.traces![0]!.kind, kind); assert.equal(shot.hit, kind === 'player');
    assert.equal(a.ammoAR, 29); assert.equal(a.ammoShotgun, 6);
    assert.equal(b.health, 100); assert.equal(b.shield, kind === 'player' ? 26 : 50);
    assert.equal(damage(events).length, kind === 'player' ? 1 : 0);
    if (kind === 'world') near(shot.to.x, -22.14); // The rear house wall occludes the player behind it.
    if (kind === 'player') { assert.equal(shot.traces![0]!.targetId, 'b'); near(shot.to.z, b.z + PLAYER_RADIUS); }
  }
});

test('off-center shotgun hits retain their own endpoints when the center ends at range or a wall', () => {
  for (const center of ['range', 'world'] as const) {
    const { engine, a, b, events } = playing();
    Object.assign(a, { x: -28, y: center === 'range' ? 10 : 0, z: 12 });
    Object.assign(b, { x: -26.7, y: center === 'range' ? 10 : 0, z: -8 });
    fire(engine, 'a', 3100, { slot: 2 }); engine.step(3100, 0);
    const [shot] = shots(events); assert.ok(shot); checkTraces(shot);
    assert.equal(shot.traces![0]!.kind, center); assert.equal(shot.hit, true);
    const pellets = shot.traces!.filter(trace => trace.kind === 'player');
    assert.equal(pellets.length, center === 'range' ? 1 : 2);
    for (const pellet of pellets) {
      assert.equal(pellet.targetId, 'b'); assert.notDeepEqual(pellet.to, shot.to);
      near(pellet.to.z, b.z + PLAYER_RADIUS);
      assert.ok(Math.abs(pellet.to.x - b.x) <= PLAYER_RADIUS);
      assert.ok(pellet.to.y >= b.y && pellet.to.y <= b.y + PLAYER_HEIGHT);
    }
    assert.equal(a.ammoShotgun, 5); assert.equal(b.health, 100);
    assert.equal(b.shield, center === 'range' ? 44 : 38);
    assert.deepEqual(damage(events).map(event => event.amount), [center === 'range' ? 6 : 12]);
  }
});

test('one shotgun spread can tag separate players without turning the center miss into a player endpoint', () => {
  const { engine, a, b, events } = playing(['a', 'b', 'c']); const c = engine.players.get('c')!;
  Object.assign(a, { x: -28, y: 10, z: 12 }); Object.assign(b, { x: -26.7, y: 10, z: -8 }); Object.assign(c, { x: -28.55, y: 10, z: -8 });
  fire(engine, 'a', 3100, { slot: 2 }); engine.step(3100, 0);
  const [shot] = shots(events); assert.ok(shot); checkTraces(shot);
  assert.equal(shot.traces![0]!.kind, 'range'); assert.equal(shot.hit, true);
  assert.deepEqual(shot.traces!.filter(trace => trace.kind === 'player').map(trace => trace.targetId), ['c', 'b']);
  assert.deepEqual(damage(events).map(event => [event.playerId, event.amount, event.shieldDamage, event.healthDamage]), [['c', 6, 6, 0], ['b', 6, 6, 0]]);
  assert.deepEqual([a.ammoShotgun, b.health, b.shield, c.health, c.shield], [5, 100, 44, 100, 44]);
});

test('protected players stop AR and shotgun rays without damage or a confirmed hit', () => {
  for (const slot of [1, 2] as const) {
    const { engine, a, b, events } = playing();
    Object.assign(a, { x: -28, y: 0, z: 12 }); Object.assign(b, { x: -28, y: 0, z: 7, protectedUntil: 4100 });
    fire(engine, 'a', 3100, { slot, ...aimAt(a, b) }); engine.step(3100, 0);
    const [protectedShot] = shots(events); assert.ok(protectedShot); checkTraces(protectedShot);
    assert.equal(protectedShot.hit, false); assert.equal(damage(events).length, 0);
    assert.ok(protectedShot.traces!.every(trace => trace.kind === 'player' && trace.targetId === 'b' && trace.shield && trace.protected));
    assert.deepEqual([b.health, b.shield, b.deaths, a.kills], [100, 50, 0, 0]);
    b.shield = 0;
    fire(engine, 'a', 4100, { slot, ...aimAt(a, b) }); engine.step(4100, 0);
    const unprotectedShot = shots(events)[1]!; checkTraces(unprotectedShot);
    assert.equal(unprotectedShot.hit, true);
    assert.ok(unprotectedShot.traces!.every(trace => trace.kind === 'player' && trace.shield === false && trace.protected === false));
    assert.equal(b.health, slot === 1 ? 76 : 28);
    assert.ok(protectedShot.traces!.every(trace => trace.shield && trace.protected), 'Event flags are immutable values, not references to later player state.');
  }
});

test('damage metadata distinguishes shield-only hits, a shield break, and subsequent health damage', () => {
  const { engine, a, b, events } = playing();
  Object.assign(a, { x: -28, y: 0, z: 12 }); Object.assign(b, { x: -28, y: 0, z: -2 });
  for (const now of [3100, 3250, 3400, 3550]) { fire(engine, 'a', now, aimAt(a, b)); engine.step(now, 0); }
  assert.deepEqual(damage(events).map(event => [event.amount, event.shieldDamage, event.healthDamage, event.shieldBroken]), [
    [24, 24, 0, false], [24, 24, 0, false], [24, 2, 22, true], [24, 0, 24, false],
  ]);
  assert.deepEqual(shots(events).map(shot => shot.traces![0]!.shield), [true, true, true, false]);
  assert.deepEqual([a.ammoAR, b.health, b.shield, b.deaths], [26, 54, 0, 0]);
});

test('close shotgun pellets snapshot the shield before one aggregated damage event breaks it', () => {
  const { engine, a, b, events } = playing();
  Object.assign(a, { x: -28, y: 0, z: 12 }); Object.assign(b, { x: -28, y: 0, z: 7 });
  fire(engine, 'a', 3100, { slot: 2, ...aimAt(a, b) }); engine.step(3100, 0);
  const [shot] = shots(events); assert.ok(shot); checkTraces(shot);
  assert.ok(shot.traces!.every(trace => trace.kind === 'player' && trace.shield === true && trace.protected === false));
  assert.deepEqual(damage(events), [{ type: 'damage', playerId: 'b', attackerId: 'a', amount: 72, at: 3100, shieldDamage: 50, healthDamage: 22, shieldBroken: true }]);
  assert.deepEqual([a.ammoShotgun, b.health, b.shield], [5, 78, 0]);
});

test('damage metadata retains the existing rounding/cap and reports clamped overkill health loss', () => {
  for (const [health, shield, requested, amount, shieldDamage, healthDamage, shieldBroken] of [
    [100, 50, 0.5, 1, 1, 0, false],
    [100, 24, 24, 24, 24, 0, true],
    [7, 0, 24, 24, 0, 7, false],
    [7, 3, 999, 150, 3, 7, true],
  ] as const) {
    const { engine, a, b, events } = playing(); Object.assign(b, { health, shield, healingUntil: 9000 });
    engine.damage(b, a, requested, 3100);
    assert.deepEqual(damage(events), [{ type: 'damage', playerId: 'b', attackerId: 'a', amount, at: 3100, shieldDamage, healthDamage, shieldBroken }]);
    assert.equal(b.health, health - healthDamage); assert.equal(b.shield, shield - shieldDamage); assert.equal(b.healingUntil, 0);
    assert.equal(a.kills, healthDamage === health ? 1 : 0); assert.equal(b.deaths, a.kills);
    if (b.health === 0) assert.equal(b.respawnAt, 3100 + RULES.respawnMs);
  }
});

test('zero, negative, sub-rounding, protected, and already-dead damage still emit nothing', () => {
  for (const setup of [{ amount: 0 }, { amount: -40 }, { amount: 0.49 }, { amount: 24, protectedUntil: 3101 }, { amount: 24, health: 0 }]) {
    const { amount, ...state } = setup;
    const { engine, a, b, events } = playing(); Object.assign(b, { healingUntil: 9000, ...state });
    const before = { ...b }; engine.damage(b, a, amount, 3100);
    assert.deepEqual(b, before); assert.deepEqual(events, []); assert.equal(a.kills, 0);
  }
});

test('simultaneous accepted shots preserve aggregation, one kill award, and pre-resolution collision flags', () => {
  const credited: string[] = [];
  for (const order of [['a', 'b', 'c'], ['b', 'a', 'c']]) {
    const { engine, a, b, events } = playing(order); const c = engine.players.get('c')!;
    Object.assign(a, { x: -29, y: 0, z: 12 }); Object.assign(b, { x: -25.5, y: 0, z: 12 });
    Object.assign(c, { x: -28, y: 0, z: -2, health: 5, shield: 10 });
    fire(engine, 'a', 3100, aimAt(a, c)); fire(engine, 'b', 3100, aimAt(b, c)); engine.step(3100, 0);
    assert.equal(shots(events).length, 2);
    for (const shot of shots(events)) { checkTraces(shot); assert.equal(shot.hit, true); assert.equal(shot.traces![0]!.targetId, 'c'); assert.equal(shot.traces![0]!.shield, true); }
    assert.deepEqual(damage(events).map(event => [event.amount, event.shieldDamage, event.healthDamage, event.shieldBroken]), [[48, 10, 5, true]]);
    assert.deepEqual([c.health, c.shield, c.deaths, a.kills + b.kills, a.ammoAR, b.ammoAR], [0, 0, 1, 1, 29, 29]);
    assert.equal(events.filter(event => event.type === 'elimination').length, 1);
    credited.push(damage(events)[0]!.attackerId);
  }
  assert.equal(credited[0], credited[1], 'Presentation does not change the existing simultaneous contribution tie-break.');
});

test('rejected cadence and stale inputs cannot publish extra traces or change shot outcomes', () => {
  const { engine, a, b, events } = playing();
  Object.assign(a, { x: -28, y: 0, z: 12 }); Object.assign(b, { x: -28, y: 0, z: 7 });
  fire(engine, 'a', 3100, { slot: 2, ...aimAt(a, b) }); engine.step(3100, 0);
  fire(engine, 'a', 3200, { slot: 2, ...aimAt(a, b) }); engine.step(3200, 0); engine.step(4000, 0);
  assert.equal(shots(events).length, 1); checkTraces(shots(events)[0]!);
  assert.equal(damage(events).length, 1); assert.deepEqual([a.ammoShotgun, b.health, b.shield], [5, 78, 0]);
});
