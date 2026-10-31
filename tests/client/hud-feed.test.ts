import assert from 'node:assert/strict';
import test from 'node:test';
import type { GameEvent, Loadout, PublicPlayerState, ShotTrace } from '../../shared/protocol';
import { LOADOUT_PRESETS, WEAPONS } from '../../shared/weapons';
import { HudStore } from '../../src/game/hud';
import {
  ARC_MS, crosshairGap, displayedHealth, dueWhistles, GrenadeTracker, HUD_INTERVAL_MS, HudFeed, MARKER_MS, minimapBlips, nearMiss, PING_MS, reconActive,
  relativeAngle, shotMarker, WHISTLE_LEAD_MS, type HudBase,
} from '../../src/game/HudFeed';
import { grenadePosition } from '../../shared/physics';

type Shot = Extract<GameEvent, { type: 'shot' }>;
const near = (actual: number, expected: number, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected}`);
const shot = (traces: ShotTrace[], playerId = 'me', weapon: Shot['weapon'] = 'kr5'): Shot => ({ type: 'shot', playerId, weapon, from: { x: 0, y: 1.6, z: 0 }, traces, hit: true, at: 1 });
const person = (id: string, changes: Partial<PublicPlayerState> = {}) => ({ id, x: 1, z: 2, yaw: 0.5, health: 100, connected: true, loadout: LOADOUT_PRESETS.close as Loadout, ...changes });
const hudBase = (time: number, changes: Partial<HudBase> = {}): HudBase => ({
  time, weapon: 'kr5', slot: 1, mag: 30, reserve: 120, frags: 1, reload: -1, ads: 0, scoped: false, sprinting: false, dashing: false,
  stamina: 1, posture: 'stand', health: 100, crosshair: 9, cook: -1, blocked: false, view: { x: 0, z: 0, yaw: 0 }, rewards: [], mortarTargeting: false, ...changes,
});
const context = { localId: 'me', mode: 'ffa' as const, now: 10_000, players: [], recon: [], drones: [], mortars: [] };

test('angles are measured from straight ahead, positive to the right, for any view yaw', () => {
  const view = { x: 0, z: 0, yaw: 0 };
  near(relativeAngle(view, { x: 0, z: -5 }), 0);
  near(relativeAngle(view, { x: 5, z: 0 }), Math.PI / 2);
  near(relativeAngle(view, { x: -5, z: 0 }), -Math.PI / 2);
  near(Math.abs(relativeAngle(view, { x: 0, z: 5 })), Math.PI);
  const east = { x: 10, z: 10, yaw: Math.PI / 2 };
  near(relativeAngle(east, { x: 20, z: 10 }), 0);
  near(relativeAngle(east, { x: 10, z: 20 }), Math.PI / 2, 1e-9);
});

test('hit markers come from the local player\'s own confirmed traces: a blast is a head hit only when head pellets did the most damage, protection and misses do not count', () => {
  assert.equal(shotMarker(shot([{ to: { x: 0, y: 1, z: -5 }, kind: 'player', targetId: 'rival', zone: 'torso' }]), 'me'), 'hit');
  assert.equal(shotMarker(shot([{ to: { x: 0, y: 1.6, z: -5 }, kind: 'player', targetId: 'rival', zone: 'head' }]), 'me'), 'head');
  const legs = { to: { x: 0, y: 0.5, z: -5 }, kind: 'player' as const, targetId: 'rival', zone: 'legs' as const };
  const head = { to: { x: 0, y: 1.6, z: -5 }, kind: 'player' as const, targetId: 'rival', zone: 'head' as const };
  assert.equal(shotMarker(shot([legs, head], 'me', 'breaker12'), 'me'), 'hit', 'A tie is not a headshot, as on the server');
  assert.equal(shotMarker(shot([legs, head, head], 'me', 'breaker12'), 'me'), 'head');
  assert.equal(shotMarker(shot([head, { ...legs, targetId: 'other' }, { ...legs, targetId: 'other' }], 'me', 'breaker12'), 'me'), 'head', 'Each target is judged on its own pellets');
  assert.equal(shotMarker(shot([{ to: { x: 0, y: 1, z: -5 }, kind: 'player', targetId: 'rival', zone: 'head', protected: true }]), 'me'), null);
  assert.equal(shotMarker(shot([{ to: { x: 0, y: 1, z: -5 }, kind: 'world', surface: 'wood', normal: { x: 0, y: 0, z: 1 } }]), 'me'), null);
  assert.equal(shotMarker(shot([{ to: { x: 0, y: 8, z: -5 }, kind: 'drone', targetId: 'drone-1' }]), 'me'), 'hit');
  assert.equal(shotMarker(shot([{ to: { x: 0, y: 1, z: -5 }, kind: 'player', targetId: 'me', zone: 'head' }], 'rival'), 'me'), null, 'Being hit is not a hit marker');
  assert.equal(shotMarker(shot([{ to: { x: 0, y: 1, z: -5 }, kind: 'player', targetId: 'rival', zone: 'head' }], 'me', 'drone'), 'me'), null, 'My drone is not my trigger');
});

test('published frames carry fresh markers and damage arcs that follow the view as it turns', () => {
  const store = new HudStore(), feed = new HudFeed(store);
  feed.marker('head', 1_000); feed.marker('kill', 1_100);
  feed.damage({ x: 10, y: 1, z: 0 }, 34, 1_000);
  let frame = feed.publish(hudBase(1_200), context, [])!;
  assert.deepEqual(frame.hitMarkers.map(marker => marker.kind), ['head', 'kill']);
  assert.notEqual(frame.hitMarkers[0]!.id, frame.hitMarkers[1]!.id);
  near(frame.damageArcs[0]!.angle, Math.PI / 2); assert.equal(frame.damageArcs[0]!.amount, 34);
  assert.equal(store.getSnapshot(), frame);
  frame = feed.publish(hudBase(1_300, { view: { x: 0, z: 0, yaw: Math.PI / 2 } }), context, [])!;
  near(frame.damageArcs[0]!.angle, 0, 1e-9);
  frame = feed.publish(hudBase(1_000 + MARKER_MS + 50), context, [])!;
  assert.deepEqual(frame.hitMarkers.map(marker => marker.kind), ['kill']);
  frame = feed.publish(hudBase(1_000 + ARC_MS + 1), context, [])!;
  assert.equal(frame.damageArcs.length, 0); assert.equal(frame.hitMarkers.length, 0);
  feed.damage({ x: NaN, y: 0, z: 0 }, 10, 5_000);
  assert.equal(feed.publish(hudBase(5_100), context, [])!.damageArcs.length, 0, 'Malformed sources are ignored');
});

test('frames are published at most about 30 times a second and dispose clears the HUD', () => {
  const store = new HudStore(), feed = new HudFeed(store);
  let published = 0;
  store.subscribe(() => { published++; });
  for (let time = 0; time < 1_000; time += 1000 / 144) feed.publish(hudBase(time), context, []);
  assert.ok(published <= 31 && published >= 28, `${published} frames in one second`);
  assert.equal(feed.publish(hudBase(2_000), context, []) !== null, true);
  assert.equal(feed.publish(hudBase(2_000 + HUD_INTERVAL_MS / 2), context, []), null);
  assert.notEqual(feed.publish(hudBase(2_000 + HUD_INTERVAL_MS / 2), context, [], true), null, 'A forced frame goes out');
  feed.dispose();
  assert.equal(store.getSnapshot(), null);
});

test('grenade warnings point at live grenades within ten metres', () => {
  const feed = new HudFeed(null);
  const frame = feed.publish(hudBase(100), context, [{ id: 'near', x: 0, z: -4 }, { id: 'far', x: 0, z: -40 }])!;
  assert.deepEqual(frame.grenades, [{ id: 'near', angle: 0, distance: 4 }]);
  assert.deepEqual(frame.blips.filter(blip => blip.kind === 'grenade').length, 2);
});

test('the minimap shows teammates, swept enemies without Low Profile, two-second firing pings, drones and mortar targets', () => {
  const team = { localId: 'me', localTeam: 'teal' as const, mode: 'tdm' as const, now: 10_000, recon: [], drones: [], mortars: [], grenades: [], pings: new Map() };
  const players = [
    person('me', { team: 'teal' }), person('friend', { team: 'teal' }), person('enemy', { team: 'gold', x: 5 }),
    person('quiet', { team: 'gold', x: 6, loadout: LOADOUT_PRESETS.assault }), person('down', { team: 'gold', health: 0 }),
  ];
  let blips = minimapBlips({ ...team, players });
  assert.deepEqual(blips.map(blip => blip.kind), ['friend'], 'Only teammates without a sweep');
  const sweep = [{ ownerId: 'friend', team: 'teal' as const, until: 15_000 }];
  assert.equal(reconActive(sweep, 'me', 'teal', 'tdm', 10_000), true);
  blips = minimapBlips({ ...team, players, recon: sweep });
  assert.deepEqual(blips.map(blip => blip.kind).sort(), ['enemy', 'friend'], 'Low Profile hides from the sweep');
  assert.equal(reconActive([{ ownerId: 'enemy', team: 'gold', until: 15_000 }], 'me', 'teal', 'tdm', 10_000), false, 'An enemy sweep shows me nothing');
  assert.equal(reconActive(sweep, 'me', 'teal', 'tdm', 15_000), false, 'Sweeps expire');
  const pings = new Map([['enemy', { x: 5, z: 2, at: 9_000 }], ['old', { x: 1, z: 1, at: 10_000 - PING_MS }]]);
  blips = minimapBlips({ ...team, players, pings });
  const ping = blips.find(blip => blip.kind === 'ping')!;
  near(ping.fade, 0.5); assert.equal(blips.filter(blip => blip.kind === 'ping').length, 1, 'Pings last two seconds');
  blips = minimapBlips({ ...team, players, pings, recon: sweep });
  assert.equal(blips.filter(blip => blip.kind === 'ping').length, 0, 'A swept enemy is not shown twice');
  blips = minimapBlips({
    ...team, players: [],
    drones: [{ id: 'd', ownerId: 'enemy', x: 3, y: 11, z: 3, yaw: 1, health: 200, until: 20_000 }, { id: 'gone', ownerId: 'enemy', x: 0, y: 11, z: 0, yaw: 0, health: 0, until: 20_000 }],
    mortars: [{ id: 'm', ownerId: 'enemy', x: -4, z: 6, impacts: [12_000, 12_700, 13_400] }, { id: 'done', ownerId: 'enemy', x: 0, z: 0, impacts: [1_000] }],
  });
  assert.deepEqual(blips.map(blip => blip.kind), ['drone', 'mortar']);
  const ffa = minimapBlips({ ...team, mode: 'ffa', localTeam: undefined, players });
  assert.equal(ffa.length, 0, 'Free-for-all has no teammates');
});

test('displayed health predicts the regeneration after the delay (sooner with Second Wind) and the crosshair follows the weapon', () => {
  near(displayedHealth(40, 1_000, 2_000, 4_999, false), 40);
  near(displayedHealth(40, 1_000, 2_000, 5_500, false), 40 + 25);
  near(displayedHealth(40, 1_000, 2_000, 4_500, true), 40 + 50);
  near(displayedHealth(40, 1_000, 6_000, 6_400, false), 40 + 20, 1e-9);
  assert.equal(displayedHealth(90, 0, 0, 60_000, false), 100);
  assert.equal(displayedHealth(0, 0, 0, 60_000, false), 0);
  const fov = 58.7, height = 900;
  assert.equal(crosshairGap(WEAPONS.kr5, 0, fov, height, true), 0, 'Hidden while sprinting');
  assert.equal(crosshairGap(WEAPONS.kr5, 0.6, fov, height, false), 0, 'Hidden while aimed');
  assert.ok(crosshairGap(WEAPONS.breaker12, 0, fov, height, false) > crosshairGap(WEAPONS.kr5, 0, fov, height, false) * 3, 'The shotgun ring shows its pellet cone');
  assert.ok(crosshairGap(WEAPONS.longbow, 0, fov, height, false) > crosshairGap(WEAPONS.breaker12, 0, fov, height, false), 'The rifle hip cone is widest');
});

test('grenades replay the shared trajectory from their throw, report bounces once and leave after exploding', () => {
  const tracker = new GrenadeTracker(), from = { x: 0, y: 1.6, z: 0 }, velocity = { x: 0, y: 4, z: -12 };
  const throwAt = 10_000, explodeAt = 13_400;
  const event = { type: 'grenade' as const, id: 'g1', playerId: 'rival', from, velocity, explodeAt, at: throwAt };
  assert.equal(tracker.add(event, 10_050), true);
  assert.equal(tracker.add(event, 10_050), false, 'A repeated event is tracked once');
  assert.equal(tracker.add({ ...event, id: 'late' }, explodeAt + 1), false, 'An exploded grenade is not drawn');
  assert.equal(tracker.add({ ...event, id: 'bad', velocity: { ...velocity, y: NaN } }, 10_050), false);
  let bounces = 0;
  for (let time = 10_050; time <= 12_000; time += 50) {
    const step = tracker.advance(time);
    bounces += step.bounces.length;
    const expected = grenadePosition(from, velocity, time - throwAt), [drawn] = tracker.positions;
    assert.ok(Math.hypot(drawn!.x - expected.x, drawn!.y - expected.y, drawn!.z - expected.z) < 1e-9, `at ${time}`);
  }
  assert.ok(bounces >= 1, 'It bounced at least once');
  assert.equal(tracker.advance(12_000).bounces.length, 0, 'Bounces are not reported again');
  assert.deepEqual(tracker.advance(explodeAt + 400).expired, ['g1']);
  assert.deepEqual(tracker.positions, []);
  tracker.add({ ...event, id: 'g2' }, 10_050);
  assert.equal(tracker.remove('g2'), true); assert.equal(tracker.remove('g2'), false);
  tracker.add({ ...event, id: 'g3' }, 10_050); assert.deepEqual(tracker.clear(), ['g3']);
});

test('each mortar shell whistles once, a moment before it lands', () => {
  const whistled = new Set<string>();
  const mortars = [{ id: 'm', ownerId: 'rival', x: 3, z: -4, impacts: [20_000, 20_700] }];
  assert.deepEqual(dueWhistles(mortars, 20_000 - WHISTLE_LEAD_MS - 1, whistled), []);
  assert.deepEqual(dueWhistles(mortars, 20_000 - WHISTLE_LEAD_MS, whistled), [{ x: 3, y: 0, z: -4 }]);
  assert.deepEqual(dueWhistles(mortars, 19_500, whistled), [{ x: 3, y: 0, z: -4 }], 'The second shell starts its own whistle');
  assert.deepEqual(dueWhistles(mortars, 19_600, whistled), []);
  assert.deepEqual(dueWhistles([{ ...mortars[0]!, id: 'late' }], 21_000, whistled), [], 'A shell that already landed is silent');
});

test('a near miss cracks past the listener; hits, misses far away and the listener\'s own shots do not', () => {
  const eye = { x: 0, y: 1.6, z: 0 };
  const shotFrom = (to: { x: number; y: number; z: number }, changes: Partial<Shot> = {}): Shot => ({ ...shot([{ to, kind: 'world' }], 'rival'), from: { x: 0, y: 1.6, z: 30 }, ...changes });
  const pass = nearMiss(shotFrom({ x: 1, y: 1.6, z: -30 }), eye, 'me');
  assert.ok(pass && Math.abs(pass.z) < 0.1 && Math.abs(pass.x - 0.5) < 0.05, 'Closest point beside the head');
  assert.equal(nearMiss(shotFrom({ x: 6, y: 1.6, z: -30 }), eye, 'me'), null, 'Too far to hear');
  assert.equal(nearMiss(shotFrom({ x: 0.5, y: 1.6, z: 10 }), eye, 'me'), null, 'Stopped short of the listener');
  assert.equal(nearMiss(shotFrom({ x: 0, y: 1.6, z: 0 }, { traces: [{ to: eye, kind: 'player', targetId: 'me', zone: 'head' }] }), eye, 'me'), null);
  assert.equal(nearMiss(shotFrom({ x: 1, y: 1.6, z: -30 }, { playerId: 'me' }), eye, 'me'), null);
});
