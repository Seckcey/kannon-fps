import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicPlayerState, WorldSnapshot } from '../../shared/protocol';
import { DEFAULT_LOADOUT, LOADOUT_PRESETS } from '../../shared/weapons';
import {
  accentColor, crosshairEnemy, ENEMY_COLOR, footstepLoudness, FRIENDLY_COLOR, INTERPOLATION_DELAY_MS, interpolatePlayer, renderTime, type Buffered,
} from '../../src/game/RemotePlayers';

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
