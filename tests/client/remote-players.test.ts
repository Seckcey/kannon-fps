import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import * as THREE from 'three';
import type { GameEvent, PublicPlayerState, WorldSnapshot } from '../../shared/protocol';
import { DEFAULT_LOADOUT, LOADOUT_PRESETS } from '../../shared/weapons';
import { CombatEffects, type ShotOptions } from '../../src/game/CombatEffects';
import { minimapBlips } from '../../src/game/HudFeed';
import {
  accentColor, crosshairEnemy, ENEMY_COLOR, footstepLoudness, FRIENDLY_COLOR, INTERPOLATION_DELAY_MS, interpolatePlayer, RemotePlayers, renderTime,
  type Buffered, type RemoteFrame,
} from '../../src/game/RemotePlayers';
import { createWeaponLibrary } from '../../src/game/WeaponModels';

const rival = (changes: Partial<PublicPlayerState> = {}): PublicPlayerState => ({
  id: 'rival', name: 'Rival', color: '#ffaa00', x: -8, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, health: 100, slot: 1, weapon: 'kr5',
  loadout: DEFAULT_LOADOUT, kills: 0, deaths: 0, assists: 0, score: 0, streak: 0, connected: true, respawnAt: 0, protectedUntil: 0,
  reloadingUntil: 0, posture: 'stand', vault: null, slideUntil: 0, cookingSince: 0, lastInputSeq: 0, ...changes,
});
const world = (serverTime: number, players: PublicPlayerState[]): WorldSnapshot => ({
  tick: serverTime, serverTime, phase: 'playing', timeRemaining: 100, mode: 'ffa', scoreLimit: 15, players, winnerIds: [], drones: [], recon: [], mortars: [],
});

test('team deathmatch paints friends blue and enemies red; free-for-all keeps each player colour', () => {
  assert.equal(accentColor({ color: '#123456', team: 'teal' }, 'teal', 'tdm'), FRIENDLY_COLOR);
  assert.equal(accentColor({ color: '#123456', team: 'gold' }, 'teal', 'tdm'), ENEMY_COLOR);
  assert.equal(accentColor({ color: '#123456', team: 'gold' }, 'teal', 'ffa'), '#123456');
  assert.equal(accentColor({ color: '#123456' }, undefined, 'tdm'), '#123456', 'Unassigned players keep their colour');
});

test('an enemy name shows only when the crosshair meets their hitboxes with a clear line of sight', () => {
  const eye = { x: -5, y: 1.6, z: 0 }, west = { x: -1, y: 0, z: 0 };
  assert.equal(crosshairEnemy(eye, west, [rival()], 'me', undefined, 'ffa'), 'rival');
  assert.equal(crosshairEnemy(eye, west, [rival({ x: -14 })], 'me', undefined, 'ffa'), null, 'The house wall hides a player inside');
  assert.equal(crosshairEnemy(eye, west, [rival({ z: 2 })], 'me', undefined, 'ffa'), null, 'Off the crosshair');
  assert.equal(crosshairEnemy(eye, west, [rival({ posture: 'crouch' })], 'me', undefined, 'ffa'), null, 'A crouched body sits below this ray');
  assert.equal(crosshairEnemy({ ...eye, y: 1 }, west, [rival({ posture: 'crouch' })], 'me', undefined, 'ffa'), 'rival');
  assert.equal(crosshairEnemy(eye, west, [rival({ health: 0 }), rival({ id: 'me' })], 'me', undefined, 'ffa'), null);
  const mate = rival({ id: 'mate', team: 'teal', x: -6.5 }), enemy = rival({ team: 'gold' });
  assert.equal(crosshairEnemy(eye, west, [mate, enemy], 'me', 'teal', 'tdm'), 'rival', 'Teammates are never the crosshair target and do not block it');
  assert.equal(crosshairEnemy(eye, west, [rival({ x: -200 })], 'me', undefined, 'ffa'), null, 'Out of range');
  assert.equal(crosshairEnemy(eye, west, [rival({ connected: false })], 'me', undefined, 'ffa'), 'rival', 'A living body left by a dropped connection can be named and hit');
});

/** The real RemotePlayers with just enough page: name tags need elements, and the operator model is
 * not downloaded in a test, so each body is the plain stand-in shown while it loads. */
function stage(t: TestContext) {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    document: { createElement: () => ({ style: {} as Record<string, string>, textContent: '', remove() {} }) },
    fetch: async () => { throw new Error('No downloads in tests'); },
  };
  for (const [key, value] of Object.entries(globals)) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value }); }
  const remotes = new RemotePlayers(new THREE.Scene(), { append() {} } as unknown as HTMLElement);
  // Disposed in the test body, so the refused download finds the bodies already gone and stays quiet.
  t.after(() => { for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 700);
  const frame = (players: PublicPlayerState[], changes: Partial<RemoteFrame> = {}): RemoteFrame => ({
    now: 1_000, serverNow: 1_000, elapsed: 1 / 60, dt: 1 / 60, localId: 'me', mode: 'ffa', camera, width: 800, height: 450,
    buffer: [], players, library: null, sunVisibility: null, sounds: null, ...changes,
  });
  return { remotes, frame };
}
/** Visible as drawn: the object and every parent up to the root. */
function drawn(object: THREE.Object3D) {
  for (let current: THREE.Object3D | null = object; current; current = current.parent) if (!current.visible) return false;
  return true;
}

test('a living player whose connection dropped stays drawn where they stood, with a shadow, and on the minimap', t => {
  const { remotes, frame } = stage(t);
  remotes.update(frame([rival({ connected: false }), rival({ id: 'gone', x: 6, health: 0 })]));
  const offline = remotes.entries.get('rival')!, dead = remotes.entries.get('gone')!;
  const body = (entry: typeof offline) => { const meshes: THREE.Mesh[] = []; entry.model.root.traverse(object => { if (object instanceof THREE.Mesh) meshes.push(object); }); return meshes; };
  assert.ok(body(offline).some(drawn), 'The frozen body is drawn, so the others can see and finish it');
  assert.equal(offline.shadow.visible, true);
  assert.ok(!body(dead).some(drawn), 'An eliminated player is still hidden'); assert.equal(dead.shadow.visible, false);
  remotes.dispose();
  const blips = minimapBlips({
    localId: 'me', localTeam: 'teal', mode: 'tdm', now: 1_000, recon: [], drones: [], mortars: [], grenades: [], pings: new Map(),
    players: [rival({ id: 'mate', team: 'teal', connected: false }), rival({ id: 'down', team: 'teal', health: 0 })],
  });
  assert.deepEqual(blips.map(blip => blip.kind), ['friend'], 'A dropped teammate stays on the minimap where the body is');
});

test('another player\'s shot carries the watcher\'s id, so a hit on me makes no puff at my own lens', t => {
  const { remotes } = stage(t);
  const options: Array<ShotOptions | undefined> = [];
  const shot: Extract<GameEvent, { type: 'shot' }> = {
    type: 'shot', playerId: 'rival', weapon: 'kr5', from: { x: -12, y: 1.45, z: 0 }, hit: true, at: 1_000,
    // The server hit my rewound body about a metre from where my predicted eye is drawn.
    traces: [{ to: { x: -0.9, y: 1.1, z: 0.2 }, kind: 'player', targetId: 'me', zone: 'torso' }],
  };
  remotes.presentShot(shot, { shot: (_event, _muzzle, value) => { options.push(value); }, shell: () => {} }, new THREE.Vector3(), 'me');
  assert.equal(options[0]?.viewerId, 'me');
  const camera = new THREE.PerspectiveCamera(); camera.position.set(0, 1.62, 0); camera.lookAt(-12, 1.45, 0); camera.updateMatrixWorld();
  const puffs = (viewer?: string) => {
    const effects = new CombatEffects({ quality: 'desktop' });
    effects.update(0, camera);
    remotes.presentShot(shot, effects, camera.position, viewer);
    const dust = effects.stats().dust;
    effects.dispose();
    return dust;
  };
  const watched = puffs('me'), anonymous = puffs();
  assert.ok(anonymous > watched, `Without the id the hit makes puffs in front of my face (${anonymous} against ${watched})`);
  remotes.dispose();
});

test('a quality change switches the shadows of guns already in hand, not only the next one drawn', t => {
  const { remotes, frame } = stage(t);
  const library = createWeaponLibrary(null);
  const casting = (id: string) => {
    const meshes: THREE.Mesh[] = [];
    remotes.entries.get(id)!.weapon!.root.traverse(object => { if (object instanceof THREE.Mesh) meshes.push(object); });
    assert.ok(meshes.length > 0);
    return meshes.filter(mesh => mesh.castShadow).length / meshes.length;
  };
  remotes.update(frame([rival(), rival({ id: 'marksman', x: 6, weapon: 'longbow' })], { library, weaponShadows: true }));
  assert.equal(casting('rival'), 1); assert.equal(casting('marksman'), 1);
  // Desktop switched to Low (the phone tier): nobody swapped weapons.
  for (let i = 0; i < 3; i++) remotes.update(frame([rival(), rival({ id: 'marksman', x: 6, weapon: 'longbow' })], { library, weaponShadows: false }));
  assert.equal(casting('rival'), 0, 'The carbine in hand stops casting'); assert.equal(casting('marksman'), 0);
  remotes.update(frame([rival(), rival({ id: 'marksman', x: 6, weapon: 'longbow' }), rival({ id: 'late', x: 3 })], { library, weaponShadows: false }));
  assert.equal(casting('late'), 0, 'A gun drawn later follows the setting too');
  remotes.update(frame([rival(), rival({ id: 'marksman', x: 6, weapon: 'longbow' }), rival({ id: 'late', x: 3 })], { library, weaponShadows: true }));
  assert.equal(casting('rival'), 1, 'and back on with High'); assert.equal(casting('late'), 1);
  remotes.dispose(); library.dispose();
});

test('footsteps others hear: Quiet Step is 0.3 as loud, crouching is quieter and dashing louder', () => {
  const close = LOADOUT_PRESETS.close, assault = LOADOUT_PRESETS.assault;
  const walk = footstepLoudness({ posture: 'stand', loadout: assault });
  assert.equal(footstepLoudness({ posture: 'stand', loadout: close }), walk * 0.3);
  assert.ok(footstepLoudness({ posture: 'crouch', loadout: assault }) < walk);
  assert.ok(footstepLoudness({ posture: 'stand', loadout: assault, dashing: true }) > footstepLoudness({ posture: 'stand', loadout: assault, sprinting: true }));
});

test('other players are drawn 100 ms in the past between the surrounding snapshots, posture included', () => {
  const buffer: Buffered[] = [
    { world: world(1_000, [rival({ x: 0 })]), received: 5_000 },
    { world: world(1_066, [rival({ x: 1, posture: 'crouch' })]), received: 5_066 },
  ];
  assert.equal(renderTime(buffer, 5_066), 1_066 - INTERPOLATION_DELAY_MS);
  assert.equal(renderTime(buffer, 5_200), 1_066, 'The render time never runs past the newest snapshot');
  assert.equal(renderTime([], 10), null);
  const latest = buffer[1]!.world.players[0]!;
  const early = interpolatePlayer(buffer, latest, 5_066 + 50);
  assert.ok(Math.abs(early.x - (1_016 - 1_000) / 66) < 1e-9); assert.equal(early.posture, 'stand', 'Posture follows the nearer snapshot');
  const late = interpolatePlayer(buffer, latest, 5_066 + 90);
  assert.equal(late.posture, 'crouch');
  assert.equal(interpolatePlayer(buffer.slice(1), latest, 5_100), latest, 'One snapshot draws the latest state directly');
});
