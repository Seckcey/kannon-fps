import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import * as THREE from 'three';
import { moveDefaults, PLAYER_RADIUS } from '../../shared/physics';
import { OBSTACLES } from '../../shared/map';
import type { GameEvent, InputFrame, Loadout, PlayerState, PublicPlayerState, WorldSnapshot } from '../../shared/protocol';
import { LOADOUT_PRESETS, WEAPONS } from '../../shared/weapons';
import { CombatEffects, type ShotOptions } from '../../src/game/CombatEffects';
import { GameView } from '../../src/game/GameView';
import { LocalPlayer } from '../../src/game/LocalPlayer';
import { RecoilRecovery, ServerTracers, shotDirections, spawnFrags, spawnReserve, type LocalWeapon } from '../../src/game/LocalWeapon';
import { TICK_MS, type LocalPrediction } from '../../src/game/MovementPrediction';

// The real GameView methods on a receiver holding real prediction and weapon state, with every
// renderer-facing part replaced by a recorder (the full view needs WebGL).

type ShotEvent = Extract<GameEvent, { type: 'shot' }>;
interface Receiver {
  [key: string]: unknown;
  recordInput(frame: InputFrame): void;
  receiveSnapshot(snapshot: WorldSnapshot, now: number): void;
  shotEvent(event: ShotEvent, localId: string, now: number): void;
  pageVisibilityChanged(): void;
  precompileEffects(): void;
  connectBreakSounds(): void;
  prediction: LocalPrediction; weapon: LocalWeapon;
}
type Calls = Record<string, unknown[][]>;

const frame = (seq: number, changes: Partial<InputFrame> = {}): InputFrame => ({
  seq, moveX: 0, moveZ: 0, yaw: Math.PI / 2, pitch: 0, fire: false, aim: false, jump: false, sprint: false, reload: false, slot: 1,
  crouch: false, dash: false, melee: false, grenade: false, streak: null, viewTime: 0, ...changes,
});
function me(loadout: Loadout, changes: Partial<PlayerState> = {}): PlayerState {
  const primary = WEAPONS[loadout.primary], secondary = WEAPONS[loadout.secondary];
  return {
    id: 'me', name: 'Me', color: '#ffffff', x: -6, y: 0, z: 20, yaw: Math.PI / 2, pitch: 0, vx: 0, vy: 0, vz: 0, health: 100, slot: 1,
    weapon: loadout.primary, loadout, kills: 0, deaths: 0, assists: 0, score: 0, streak: 0, connected: true, respawnAt: 0, protectedUntil: 0,
    reloadingUntil: 0, ...moveDefaults(), cookingSince: 0, lastInputSeq: 0,
    mag: [primary.magazine, secondary.magazine], reserve: [spawnReserve(primary, loadout), spawnReserve(secondary, loadout)], frags: spawnFrags(loadout),
    rewards: [], reloadSlot: 0, readyAt: 0, meleeUntil: 0, lastDamageAt: 0, ...changes,
  };
}
function world(serverTime: number, self: PlayerState, changes: Partial<WorldSnapshot> = {}, others: PublicPlayerState[] = []): WorldSnapshot {
  const { mag: _mag, reserve: _reserve, frags: _frags, rewards: _rewards, reloadSlot: _reloadSlot, readyAt: _readyAt, meleeUntil: _meleeUntil,
    stamina: _stamina, slideCooldownUntil: _slideCooldownUntil, lastDamageAt: _lastDamageAt, ...pub } = self;
  return {
    tick: serverTime, serverTime, phase: 'playing', timeRemaining: 100, mode: 'ffa', scoreLimit: 15, players: [pub, ...others], winnerIds: [],
    drones: [], recon: [], mortars: [], self, roundId: 'round-1', ...changes,
  };
}

const documents = new WeakMap<TestContext, { hidden: boolean }>();
/** One page per test: `document.hidden` is all these methods read from it. */
function page(t: TestContext) {
  const existing = documents.get(t);
  if (existing) return existing;
  const document = { hidden: false }, previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); });
  documents.set(t, document);
  return document;
}

function view(t: TestContext, loadout: Loadout = LOADOUT_PRESETS.assault, fields: Record<string, unknown> = {}) {
  const document = page(t);
  const calls: Calls = {};
  const record = (name: string, result?: (...args: unknown[]) => unknown) => (...args: unknown[]) => { (calls[name] ??= []).push(args); return result?.(...args); };
  const local = new LocalPlayer(loadout);
  const receiver = Object.assign(Object.create(GameView.prototype) as Receiver, {
    disposed: false, snapshot: null, snapshotBuffer: [], lastProcessedTick: -1, firstLocalSnapshot: true, localRespawnAt: 0,
    lastAlive: false, killer: null, landing: 0, lastFrame: 0, frames: 0, statsTime: 0, slowTime: 0,
    scratch: new THREE.Vector3(), camera: new THREE.PerspectiveCamera(), heldGrenades: new Map(), whistled: new Set(),
    local, prediction: local.prediction, weapon: local.weapon, recoil: new RecoilRecovery(), serverTracers: new ServerTracers(),
    tier: { postprocessing: false },
    options: {
      getPlayerId: () => 'me',
      input: { pitch: 0, resumeSequence: record('resumeSequence'), setRewards: record('setRewards'), resetSpawnView: record('resetSpawnView'), addViewKick: record('addViewKick') },
    },
    effects: {
      clear: record('effects.clear'), clearTransient: record('effects.clearTransient'), setDrones: record('effects.setDrones'), grenade: record('effects.grenade'),
      shot: record('effects.shot'), localShot: record('effects.localShot'), precompile: record('effects.precompile', () => Promise.resolve()),
    },
    respawns: { clear: record('respawns.clear') },
    remotes: { entries: new Map(), resetMotion: record('remotes.resetMotion'), rendered: () => undefined, presentShot: record('remotes.presentShot', () => new THREE.Vector3()) },
    hudFeed: { reset: record('hudFeed.reset'), marker: record('hudFeed.marker'), ping: record('hudFeed.ping') },
    grenades: { clear: () => [] },
    audio: {
      drone: record('audio.drone'), suspend: record('audio.suspend'), resume: record('audio.resume'), impact: record('audio.impact'),
      shot: record('audio.shot'), hitMarker: record('audio.hitMarker'), flyby: record('audio.flyby'), reloadStep: record('audio.reloadStep'),
      swap: record('audio.swap'), dryFire: record('audio.dryFire'), grenadePin: record('audio.grenadePin'),
    },
    viewModel: { fire: record('viewModel.fire'), melee: record('viewModel.melee'), throwGrenade: record('viewModel.throwGrenade'), muzzleWorld: (_camera: unknown, target: THREE.Vector3) => target.set(0, 1.5, 0) },
    fpCamera: { snap: record('fpCamera.snap') }, motion: { ads: 0, reset: record('motion.reset') }, landings: { reset: record('landings.reset'), tick: () => 0 },
    renderQuality: { resetTiming: record('renderQuality.resetTiming') },
    ...fields,
  });
  /** Adopts a snapshot the way a frame does. It is stamped as received a minute from now, so it stays
   * fresh (inputs are simulated) however slowly the test runs. */
  const receive = (snapshot: WorldSnapshot) => receiver.receiveSnapshot(snapshot, performance.now() + 60_000);
  return { view: receiver, calls, document, receive, count: (name: string) => calls[name]?.length ?? 0 };
}
const optionsOf = (calls: Calls, index = -1) => calls['effects.shot']!.at(index)![2] as ShotOptions;

test('after a reconnect restarts the server count at 0, the body and the ammo take the server state and nothing replays', t => {
  const { view: subject, receive } = view(t);
  receive(world(10_000, me(LOADOUT_PRESETS.assault)));
  for (let seq = 1; seq <= 5; seq++) subject.recordInput(frame(seq, { moveZ: 1, fire: true }));
  // The server has all five: its state is the prediction's, and it reports input 5.
  const acknowledged = { x: subject.prediction.movement.state.x, mag: subject.weapon.state.mag[0] };
  receive(world(10_167, me(LOADOUT_PRESETS.assault, { x: acknowledged.x, mag: [acknowledged.mag, 12], lastInputSeq: 5 })));
  // Firing and walking into a socket that has silently died: two seconds of frames the server never gets.
  for (let seq = 6; seq <= 65; seq++) subject.recordInput(frame(seq, { moveZ: 1, fire: true }));
  assert.ok(subject.weapon.state.mag[0] < 10, `The prediction emptied most of the magazine (${subject.weapon.state.mag[0]})`);
  assert.ok(subject.prediction.movement.state.x > acknowledged.x + 3, 'and walked on down the street');
  // Back in: the server froze me where it last had me and counts my inputs from 0 again.
  receive(world(14_000, me(LOADOUT_PRESETS.assault, { x: acknowledged.x, mag: [22, 12], lastInputSeq: 0 })));
  assert.equal(subject.weapon.state.mag[0], 22, 'The server ammo, not a replay of 60 stale frames');
  assert.ok(Math.abs(subject.prediction.movement.state.x - acknowledged.x) < 1e-9, 'The body stays where the server froze it');
  assert.equal(subject.prediction.pending.length, 0, 'No stale frame is in flight');
  assert.equal(subject.weapon.state.slot, 1);
  // New frames on the new socket are in flight until the server reports them.
  subject.recordInput(frame(66, { moveZ: 1 })); subject.recordInput(frame(67, { moveZ: 1 }));
  receive(world(14_033, me(LOADOUT_PRESETS.assault, { x: acknowledged.x, mag: [22, 12], lastInputSeq: 0 })));
  assert.deepEqual(subject.prediction.pending.map(input => input.seq), [66, 67], 'A second report of 0 is not another restart');
  receive(world(14_100, me(LOADOUT_PRESETS.assault, { x: acknowledged.x, mag: [22, 12], lastInputSeq: 66 })));
  assert.deepEqual(subject.prediction.pending.map(input => input.seq), [67]);
});

test('a round that turned over while the page was hidden clears the old round\'s marks and starts a new life', t => {
  const { view: subject, receive, count } = view(t);
  receive(world(10_000, me(LOADOUT_PRESETS.assault), { roundId: 'round-1' }));
  receive(world(10_033, me(LOADOUT_PRESETS.assault), { roundId: 'round-1' }));
  assert.equal(count('effects.clear'), 0);
  const spawns = count('resetSpawnView');
  // The next snapshot this page sees is already the next round's play.
  receive(world(90_000, me(LOADOUT_PRESETS.assault, { x: 20, lastInputSeq: 400 }), { roundId: 'round-2' }));
  assert.equal(count('effects.clear'), 1, 'Bullet holes, scorches and broken glass from the old round are cleared');
  assert.equal(count('hudFeed.reset'), 1);
  assert.equal(count('resetSpawnView'), spawns + 1, 'The new round starts a new life');
});

test('switching apps keeps bullet holes and scorches, drops flying particles, and pauses the sound until the page is back', t => {
  const effects = new CombatEffects({ quality: 'desktop' });
  t.after(() => effects.dispose());
  const { view: subject, document, calls, count } = view(t, LOADOUT_PRESETS.assault, { effects });
  effects.bulletHole({ x: -9.75, y: 1.2, z: 0 }, { x: 1, y: 0, z: 0 }, 'concrete');
  effects.explosion({ x: 0, y: 0.1, z: 6 }, 'frag');
  assert.ok(effects.stats().decals === 1 && effects.stats().scorches === 1 && effects.stats().dust > 0);
  document.hidden = true; subject.pageVisibilityChanged();
  assert.equal(count('audio.suspend'), 1, 'Nothing plays on in the background');
  document.hidden = false; subject.pageVisibilityChanged();
  assert.equal(count('audio.resume'), 1, 'and the sound comes back with the page');
  const stats = effects.stats();
  assert.equal(stats.decals, 1, 'The bullet hole is still there'); assert.equal(stats.scorches, 1, 'and the scorch');
  assert.equal(stats.dust, 0, 'Particles in flight are gone');
  assert.equal(count('renderQuality.resetTiming'), 2);
  assert.equal(count('effects.clear'), 0, 'The fresh-round reset is not used for an app switch');
  assert.equal(count('audio.suspend'), 1, 'Showing the page does not pause the sound again');
});

test('a Heron 7 shot from the hip draws no tracer along the crosshair; the server\'s shot event draws where it really went', t => {
  const marksman = LOADOUT_PRESETS.marksman;
  const { view: subject, calls, receive, count } = view(t, marksman);
  receive(world(10_000, me(marksman)));
  subject.recordInput(frame(1, { fire: true }));
  assert.equal(count('viewModel.fire'), 1, 'The shot itself is predicted at once');
  assert.equal(count('effects.shot'), 0, 'but its tracer is not: the server rolls it inside the hip cone');
  const confirmed: ShotEvent = {
    type: 'shot', playerId: 'me', weapon: 'longbow', from: { x: -6, y: 1.5, z: 20 }, hit: false, at: 10_033, seq: 1,
    traces: [{ to: { x: 14, y: 2.1, z: 21.3 }, kind: 'world', normal: { x: -1, y: 0, z: 0 }, surface: 'concrete' }],
  };
  subject.shotEvent(confirmed, 'me', performance.now());
  assert.deepEqual(optionsOf(calls), { local: true, tracer: true, viewerId: 'me' }, 'The tracer comes from the real end points');
  subject.shotEvent({ ...confirmed, at: 11_500, seq: 40 }, 'me', performance.now());
  assert.equal(optionsOf(calls).tracer, false, 'Only for the shot that left it to the server');
});

test('fully scoped, the Heron 7 tracer is drawn at once along the crosshair, and the server\'s event adds no second one', t => {
  const marksman = LOADOUT_PRESETS.marksman;
  const { view: subject, calls, receive, count } = view(t, marksman);
  receive(world(10_000, me(marksman)));
  // Cool Head: the scope is fully up after 0.8 x 420 ms, about ten ticks.
  for (let seq = 1; seq <= 12; seq++) subject.recordInput(frame(seq, { aim: true }));
  subject.recordInput(frame(13, { aim: true, fire: true }));
  assert.equal(count('effects.shot'), 1);
  const [predicted, , options] = calls['effects.shot']![0]! as [ShotEvent, unknown, ShotOptions];
  assert.deepEqual(options, { local: true, tracer: true, viewerId: 'me' });
  const eye = predicted.from, end = predicted.traces[0]!.to, along = new THREE.Vector3(end.x - eye.x, end.y - eye.y, end.z - eye.z).normalize();
  assert.ok(along.x > 0.9999, 'Straight down the crosshair (east)');
  subject.shotEvent({ ...predicted, playerId: 'me', at: 10_000 + 13 * TICK_MS, seq: 13 }, 'me', performance.now());
  assert.equal(optionsOf(calls).tracer, false);
});

test('a shotgun pellet tracer part-way into aiming is the pattern the server fires at that aim progress', t => {
  const close: Loadout = { ...LOADOUT_PRESETS.assault, primary: 'breaker12' };
  const { view: subject, calls, receive } = view(t, close);
  receive(world(10_000, me(close)));
  for (let seq = 1; seq <= 4; seq++) subject.recordInput(frame(seq, { aim: true }));
  subject.recordInput(frame(5, { aim: true, fire: true }));
  const [predicted] = calls['effects.shot']!.at(-1)! as [ShotEvent];
  const aim = 4 * TICK_MS / WEAPONS.breaker12.adsMs, expected = shotDirections(WEAPONS.breaker12, Math.PI / 2, 0, aim);
  assert.equal(predicted.traces.length, WEAPONS.breaker12.pellets);
  predicted.traces.forEach((trace, index) => {
    const direction = new THREE.Vector3(trace.to.x - predicted.from.x, trace.to.y - predicted.from.y, trace.to.z - predicted.from.z).normalize();
    assert.ok(direction.distanceTo(new THREE.Vector3(expected[index]!.x, expected[index]!.y, expected[index]!.z)) < 1e-9, `pellet ${index}`);
  });
});

test('the predicted tracer stops at a body left by a dropped connection, which the server can still hit', t => {
  const rival: PublicPlayerState = { ...me(LOADOUT_PRESETS.assault), id: 'rival', name: 'Rival', x: 2, connected: false };
  const { view: subject, calls, receive } = view(t, LOADOUT_PRESETS.assault, {
    remotes: { entries: new Map([['rival', { state: rival }]]), resetMotion: () => {}, rendered: () => undefined },
  });
  receive(world(10_000, me(LOADOUT_PRESETS.assault)));
  subject.recordInput(frame(1, { fire: true }));
  const [predicted] = calls['effects.shot']!.at(-1)! as [ShotEvent];
  assert.ok(predicted.traces[0]!.to.x < 2, `The streak ends on the frozen body (x ${predicted.traces[0]!.to.x.toFixed(2)})`);
});

test('a jump with a knife, fire or cook on the frame that starts a vault does what the server does: it happens', t => {
  const barrier = OBSTACLES.find(box => box.id === 'west-lane-barrier')!;
  const facing = { x: barrier.x, z: barrier.z - barrier.d / 2 - PLAYER_RADIUS - 0.3, yaw: Math.PI };
  const presses = [[{ melee: true }, 'viewModel.melee'], [{ fire: true }, 'viewModel.fire'], [{ grenade: true }, 'audio.grenadePin']] as const;
  for (const [changes, outcome] of presses) {
    const { view: subject, receive, count } = view(t), press = Object.keys(changes)[0];
    receive(world(10_000, me(LOADOUT_PRESETS.assault, facing)));
    subject.recordInput(frame(1, { moveZ: 1, yaw: Math.PI, jump: true, ...changes }));
    assert.ok(subject.prediction.movement.state.vault, `${press}: the jump starts a vault on this tick`);
    assert.equal(count(outcome), 1, `${press}: the press is not refused, because the body only started vaulting during the move`);
  }
});

test('another player\'s shot is drawn with my id, so their hits on me stay off my own lens', t => {
  const { view: subject, calls, receive } = view(t);
  receive(world(10_000, me(LOADOUT_PRESETS.assault)));
  subject.shotEvent({ type: 'shot', playerId: 'rival', weapon: 'kr5', from: { x: 6, y: 1.5, z: 20 }, hit: true, at: 10_000,
    traces: [{ to: { x: -6, y: 0.8, z: 20 }, kind: 'player', targetId: 'me', zone: 'legs' }] }, 'me', performance.now());
  assert.equal(calls['remotes.presentShot']![0]![3], 'me');
});

test('desktop tiers with the presentation build the effect shaders for its float target too, then put the target back', t => {
  const targets: Array<THREE.WebGLRenderTarget | null> = [];
  let current: THREE.WebGLRenderTarget | null = null, disposed = 0;
  const renderer = { getRenderTarget: () => current, setRenderTarget: (target: THREE.WebGLRenderTarget | null) => { current = target; } };
  const effects = { precompile: (bound: typeof renderer) => { targets.push(bound.getRenderTarget()); return Promise.resolve(); } };
  const dispose = THREE.WebGLRenderTarget.prototype.dispose;
  THREE.WebGLRenderTarget.prototype.dispose = function (this: THREE.WebGLRenderTarget) { disposed++; return dispose.call(this); };
  t.after(() => { THREE.WebGLRenderTarget.prototype.dispose = dispose; });
  const desktop = view(t, LOADOUT_PRESETS.assault, { renderer, effects, tier: { postprocessing: true } }).view;
  desktop.precompileEffects();
  assert.equal(targets.length, 2, 'One build for the canvas and one for the presentation\'s target');
  assert.equal(targets[0], null);
  assert.ok(targets[1] instanceof THREE.WebGLRenderTarget, 'Linear output with no tone mapping: a different program');
  assert.equal(current, null, 'The canvas is the target again afterwards'); assert.equal(disposed, 1);
  targets.length = 0;
  view(t, LOADOUT_PRESETS.assault, { renderer, effects, tier: { postprocessing: false } }).view.precompileEffects();
  assert.deepEqual(targets, [null], 'Phones draw straight to the canvas');
});

test('breaking a pane or a pot makes its own sound where it breaks', t => {
  const effects = new CombatEffects({ quality: 'desktop' });
  t.after(() => effects.dispose());
  const { view: subject, calls } = view(t, LOADOUT_PRESETS.assault, { effects });
  subject.connectBreakSounds();
  effects.onBreak?.('glass', { x: 9.75, y: 5, z: 0 });
  effects.onBreak?.('pot', { x: -3, y: 0.4, z: 8 });
  assert.deepEqual(calls['audio.impact'], [['glass', { x: 9.75, y: 5, z: 0 }], ['concrete', { x: -3, y: 0.4, z: 8 }]]);
});
