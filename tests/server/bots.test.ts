import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOT_SETTINGS, BotNavigation, FRAG_CLEARANCE, FRAG_COOK_MS, FRAG_COOKS_MS, FRAG_COOLDOWN_MS, FRAG_RANGE, FRAG_RELEASE_GRACE_MS, FRAG_SAFE_LANDING,
  FRAG_SIMULATIONS_PER_TICK, FragPlanner, fragLanding, planFrag, PracticeBots, PRACTICE_RIVALS, RECOVERED_HEALTH, RETREAT_HEALTH, SECONDARY_RANGE,
} from '../../server/bots.js';
import { OBSTACLES, SPAWNS } from '../../shared/map.js';
import {
  directionFromAngles, EYE_HEIGHT, eyePosition, grenadeLaunch, grenadePosition, GrenadeTrajectory, hitboxes, moveDefaults, movePlayer, normalize, PLAYER_RADIUS, POSTURE_HEIGHT,
  raycastMap, rayHitboxes, subtract,
} from '../../shared/physics.js';
import { RULES, type GameMode, type HitZone, type InputFrame, type PlayerState, type PracticeDifficulty, type StreakId, type Vec3 } from '../../shared/protocol.js';
import { botLoadout, damageAt, EXPLOSIVES, explosionDamage, fireIntervalMs, LOADOUT_PRESETS, STREAK_ORDER, weaponFor, WEAPONS } from '../../shared/weapons.js';

const DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
const TICK = 1000 / 30;
const horizontal = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

function makePlayer(id: string, patch: Partial<PlayerState> = {}): PlayerState {
  const loadout = patch.loadout ?? LOADOUT_PRESETS.assault, primary = WEAPONS[loadout.primary], secondary = WEAPONS[loadout.secondary];
  return {
    id, name: id, color: '#fff', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, ...moveDefaults(),
    health: RULES.health, slot: 1, weapon: loadout.primary, loadout, kills: 0, deaths: 0, assists: 0, score: 0, streak: 0,
    connected: true, respawnAt: 0, protectedUntil: 0, reloadingUntil: 0, cookingSince: 0, lastInputSeq: 0, aiming: false,
    mag: [primary.magazine, secondary.magazine], reserve: [primary.magazine * primary.reserveMags, secondary.magazine * secondary.reserveMags],
    frags: RULES.fragsPerLife, rewards: [], reloadSlot: 0, readyAt: 0, meleeUntil: 0, lastDamageAt: 0,
    ...patch,
  };
}
const rival = (index: number, patch: Partial<PlayerState> = {}) =>
  makePlayer(PRACTICE_RIVALS[index]!.id, { bot: true, loadout: botLoadout(PRACTICE_RIVALS[index]!.id, 'normal'), ...patch });
function penetrates(p: PlayerState): boolean {
  const height = POSTURE_HEIGHT[p.posture];
  return OBSTACLES.some(b => p.y < b.y + b.h / 2 - 0.01 && p.y + height > b.y - b.h / 2 + 0.01 &&
    p.x + PLAYER_RADIUS > b.x - b.w / 2 + 0.01 && p.x - PLAYER_RADIUS < b.x + b.w / 2 - 0.01 &&
    p.z + PLAYER_RADIUS > b.z - b.d / 2 + 0.01 && p.z - PLAYER_RADIUS < b.z + b.d / 2 - 0.01);
}
function clear(from: Vec3, to: Vec3): boolean {
  const delta = subtract(to, from), length = Math.hypot(delta.x, delta.y, delta.z);
  return raycastMap(from, normalize(delta), length) >= length - 0.01;
}
function zoneCentre(body: PlayerState, zone: HitZone): Vec3 {
  const box = hitboxes(body).find(b => b.zone === zone)!;
  return { x: body.x, y: (box.min.y + box.max.y) / 2, z: body.z };
}
/** Can `viewer`'s eyes see the chest or head of `body`? */
const sees = (viewer: PlayerState, body: PlayerState) => clear(eyePosition(viewer), zoneCentre(body, 'torso')) || clear(eyePosition(viewer), zoneCentre(body, 'head'));
/** Angle between a view and the line from the shooter's eye to a point. */
function aimError(shooter: PlayerState, frame: Pick<InputFrame, 'yaw' | 'pitch'>, target: Vec3): number {
  const view = directionFromAngles(frame.yaw, frame.pitch), want = normalize(subtract(target, eyePosition(shooter)));
  return Math.acos(Math.min(1, view.x * want.x + view.y * want.y + view.z * want.z));
}
const pitchTo = (shooter: PlayerState, target: Vec3) => { const eye = eyePosition(shooter); return Math.atan2(target.y - eye.y, horizontal(eye, target)); };
function assertFrame(frame: InputFrame, now: number, seq: number) {
  assert.equal(frame.seq, seq); assert.equal(frame.viewTime, now);
  for (const key of ['moveX', 'moveZ', 'yaw', 'pitch'] as const) assert.ok(Number.isFinite(frame[key]), `${key} must be finite`);
  assert.ok(Math.abs(frame.moveX) <= 1 && Math.abs(frame.moveZ) <= 1 && Math.abs(frame.pitch) <= 1.3, `stick ${frame.moveX}, ${frame.moveZ}`);
  for (const key of ['fire', 'aim', 'jump', 'sprint', 'reload', 'crouch', 'dash', 'melee', 'grenade'] as const) assert.equal(typeof frame[key], 'boolean', key);
  assert.ok(frame.slot === 1 || frame.slot === 2); assert.equal(frame.jump, false, 'Rivals never jump.');
  assert.ok(frame.streak === null || STREAK_ORDER.includes(frame.streak));
  if (frame.streakTarget) assert.ok(Math.abs(frame.streakTarget.x) < 30.9 && Math.abs(frame.streakTarget.z) < 22.9);
  else assert.notEqual(frame.streak, 'mortar');
}

type Cause = 'bullet' | 'melee' | 'frag';
/** A small stand-in for MatchEngine built only from the shared rules, so these tests exercise the
 * controller against the real physics and weapon table while the engine is rewritten alongside.
 * Thrown frags fly on the shared grenade simulation and burst like the engine's (thrower included). */
class Arena {
  readonly players: PlayerState[] = [];
  readonly frames = new Map<string, InputFrame[]>();
  readonly log = {
    shots: [] as Array<{ by: string; at: number; slot: number }>, kills: [] as Array<{ by: string; of: string; cause: Cause }>,
    hits: [] as Array<{ by: string; of: string; amount: number; cause: Cause }>,
    throws: [] as Array<{ by: string; at: number; yaw: number; pitch: number; cookedMs: number; eye: Vec3 }>, rewards: [] as Array<{ by: string; reward: StreakId; target?: { x: number; z: number } }>,
    melee: [] as Array<{ by: string; at: number }>, slides: 0, offTarget: 0,
    /** Every frag burst, with how far its thrower stood from it, and every cook with the cook's speed at that moment. */
    blasts: [] as Array<{ by: string; at: number; position: Vec3; ownerDistance: number }>, cooks: [] as Array<{ by: string; at: number; speed: number }>,
  };
  /** Frags in the air, each with the point where it will burst. */
  readonly grenades: Array<{ owner: PlayerState; trajectory: GrenadeTrajectory; thrownAt: number; explodeAt: number; burst: Vec3 }> = [];
  now = 6000;
  /** Frozen players never act or take damage (a fixed target). Pinned rivals decide and aim but stay put. */
  readonly frozen = new Set<string>();
  readonly pinned = new Set<string>();
  private readonly nextShot = new Map<string, number>();
  constructor(readonly bots: PracticeBots, readonly mode: GameMode = 'ffa', readonly combat = true) {}
  add(player: PlayerState) { this.players.push(player); return player; }
  last(id: string) { return this.frames.get(id)?.at(-1); }
  allies(a: PlayerState, b: PlayerState) { return this.mode === 'tdm' && !!a.team && a.team === b.team; }
  tick(dt = 1 / 30) {
    this.now += dt * 1000; const now = this.now, inputs = new Map<string, InputFrame>();
    for (const p of this.players) if (p.bot && p.connected && p.health > 0 && !this.frozen.has(p.id)) {
      const seq = (this.last(p.id)?.seq ?? 0) + 1, frame = this.bots.input(p, this.players, now, dt, seq, this.mode);
      assertFrame(frame, now, seq); inputs.set(p.id, frame);
    }
    const shots: Array<{ shooter: PlayerState; frame: InputFrame }> = [];
    for (const p of this.players) {
      if (p.health <= 0) { if (now >= p.respawnAt) this.respawn(p); continue; }
      const frame = inputs.get(p.id); if (!frame) continue;
      const previous = this.last(p.id); (this.frames.get(p.id) ?? this.frames.set(p.id, []).get(p.id)!).push(frame);
      this.apply(p, frame, previous, now, dt, shots);
    }
    for (const { shooter, frame } of shots) this.resolve(shooter, frame, now);
    this.explosives(now);
    for (const p of this.players) if (p.health > 0 && p.health < RULES.health && now - p.lastDamageAt >= RULES.regenDelayMs) p.health = Math.min(RULES.health, p.health + RULES.regenPerSecond * dt);
  }
  private explosives(now: number) {
    for (const p of this.players) if (p.health > 0 && p.cookingSince && now >= p.cookingSince + EXPLOSIVES.frag.fuseMs) { p.cookingSince = 0; this.burst(p, eyePosition(p), now); }
    for (let i = 0; i < this.grenades.length; i++) {
      const grenade = this.grenades[i]!;
      grenade.trajectory.advanceTo(Math.min(now, grenade.explodeAt) - grenade.thrownAt);
      if (now < grenade.explodeAt) continue;
      this.grenades.splice(i--, 1); this.burst(grenade.owner, grenade.trajectory.position, now);
    }
  }
  /** Engine rules: full damage near the blast fading to the edge, only with a clear line to the torso; the
   * thrower can be hurt, teammates cannot. */
  private burst(owner: PlayerState, position: Vec3, now: number) {
    this.log.blasts.push({ by: owner.id, at: now, position, ownerDistance: horizontal(owner, position) });
    const origin = { x: position.x, y: position.y + 0.1, z: position.z };
    for (const target of this.players) {
      if (target.health <= 0 || !target.connected || target.protectedUntil > now || (target !== owner && this.allies(owner, target))) continue;
      const torso = zoneCentre(target, 'torso'), distance = Math.hypot(torso.x - origin.x, torso.y - origin.y, torso.z - origin.z);
      if (distance <= EXPLOSIVES.frag.radius && clear(origin, torso)) this.damage(target, owner, Math.round(explosionDamage('frag', distance)), now, 'frag');
    }
  }
  run(ms: number, each?: () => void) { const end = this.now + ms; while (this.now < end - 1e-6) { this.tick(); each?.(); } }
  private apply(p: PlayerState, frame: InputFrame, previous: InputFrame | undefined, now: number, dt: number, shots: Array<{ shooter: PlayerState; frame: InputFrame }>) {
    if (frame.slot !== p.slot) { p.slot = frame.slot; p.weapon = weaponFor(p.loadout, p.slot).id; p.readyAt = now + weaponFor(p.loadout, p.slot).raiseMs; p.reloadingUntil = 0; p.reloadSlot = 0; }
    const spec = weaponFor(p.loadout, p.slot), i = p.slot - 1;
    if (p.reloadingUntil && now >= p.reloadingUntil) { const take = Math.min(spec.magazine - p.mag[i], p.reserve[i]); p.mag[i] += take; p.reserve[i] -= take; p.reloadingUntil = 0; p.reloadSlot = 0; }
    if (frame.reload && !p.reloadingUntil && p.mag[i] < spec.magazine && p.reserve[i] > 0) { p.reloadingUntil = now + (p.mag[i] ? spec.reloadMs : spec.emptyReloadMs); p.reloadSlot = p.slot; }
    p.aiming = frame.aim;
    const wasSliding = p.posture === 'slide', before = { x: p.x, y: p.y, z: p.z };
    movePlayer(p, frame, { now, dt, jumpPressed: frame.jump && !previous?.jump, crouchPressed: frame.crouch && !previous?.crouch, moveFactor: spec.moveFactor, adsFactor: spec.adsMoveFactor, canSprint: !p.cookingSince && now >= p.meleeUntil });
    if (this.pinned.has(p.id)) Object.assign(p, before, { vx: 0, vy: 0, vz: 0 });
    if (!wasSliding && p.posture === 'slide') this.log.slides++;
    if (frame.melee && !previous?.melee && now >= p.meleeUntil) {
      p.meleeUntil = now + RULES.meleeMs; this.log.melee.push({ by: p.id, at: now });
      const target = this.players.find(o => o !== p && o.health > 0 && !this.allies(p, o) && horizontal(o, p) <= RULES.meleeLungeRange);
      if (target) this.damage(target, p, RULES.meleeDamage, now, 'melee');
    }
    if (frame.grenade && !previous?.grenade && !p.cookingSince && p.frags > 0) { p.cookingSince = now; this.log.cooks.push({ by: p.id, at: now, speed: Math.hypot(p.vx, p.vz) }); }
    if (!frame.grenade && p.cookingSince) {
      p.frags--; this.log.throws.push({ by: p.id, at: now, yaw: frame.yaw, pitch: frame.pitch, cookedMs: now - p.cookingSince, eye: eyePosition(p) });
      const launch = grenadeLaunch(eyePosition(p), frame.yaw, frame.pitch, p, EXPLOSIVES.frag.throwSpeed, EXPLOSIVES.frag.throwLift), explodeAt = p.cookingSince + EXPLOSIVES.frag.fuseMs;
      this.grenades.push({ owner: p, trajectory: new GrenadeTrajectory(launch.from, launch.velocity), thrownAt: now, explodeAt, burst: grenadePosition(launch.from, launch.velocity, explodeAt - now) });
      p.cookingSince = 0;
    }
    if (frame.streak && frame.streak !== previous?.streak) {
      const index = p.rewards.indexOf(frame.streak);
      if (index >= 0) { p.rewards.splice(index, 1); this.log.rewards.push({ by: p.id, reward: frame.streak, ...(frame.streakTarget ? { target: frame.streakTarget } : {}) }); }
    }
    const ready = this.nextShot.get(p.id) ?? -Infinity;
    if (frame.fire && now >= p.readyAt && !p.cookingSince && now >= p.meleeUntil && p.mag[i] > 0 && !p.reloadingUntil && (spec.auto || !previous?.fire) && now >= ready) {
      this.nextShot.set(p.id, Math.max(ready, now - TICK) + fireIntervalMs(spec)); p.mag[i]--; p.protectedUntil = 0;
      this.log.shots.push({ by: p.id, at: now, slot: p.slot }); shots.push({ shooter: p, frame });
    }
  }
  private resolve(shooter: PlayerState, frame: InputFrame, now: number) {
    const spec = weaponFor(shooter.loadout, frame.slot), eye = eyePosition(shooter), direction = directionFromAngles(frame.yaw, frame.pitch);
    const enemies = this.players.filter(o => o !== shooter && o.health > 0 && o.connected && !this.allies(shooter, o));
    if (!enemies.some(o => aimError(shooter, frame, zoneCentre(o, 'torso')) < 0.35)) this.log.offTarget++;
    if (!this.combat) return;
    let best: { target: PlayerState; distance: number; zone: HitZone } | null = null;
    for (const target of enemies) {
      const hit = rayHitboxes(eye, direction, target, best?.distance ?? raycastMap(eye, direction, spec.maxRange));
      if (hit) best = { target, ...hit };
    }
    if (best && best.target.protectedUntil <= now) this.damage(best.target, shooter, Math.round(damageAt(spec, best.distance, best.zone)), now);
  }
  damage(target: PlayerState, attacker: PlayerState, amount: number, now: number, cause: Cause = 'bullet') {
    if (target.health <= 0 || amount <= 0 || this.frozen.has(target.id)) return;
    target.health = Math.max(0, target.health - amount); target.lastDamageAt = now; this.log.hits.push({ by: attacker.id, of: target.id, amount, cause });
    if (target.health <= 0) {
      target.deaths++; if (attacker !== target) attacker.kills++; target.respawnAt = now + RULES.respawnMs; target.vx = 0; target.vz = 0; target.cookingSince = 0;
      this.log.kills.push({ by: attacker.id, of: target.id, cause });
    }
  }
  private respawn(p: PlayerState) {
    const living = this.players.filter(o => o !== p && o.health > 0 && !this.allies(p, o));
    const spawn = [...SPAWNS].sort((a, b) => Math.min(...living.map(o => horizontal(o, b))) - Math.min(...living.map(o => horizontal(o, a))))[0]!;
    Object.assign(p, makePlayer(p.id, { x: spawn.x, y: 0, z: spawn.z, yaw: spawn.yaw, loadout: p.loadout, team: p.team, bot: p.bot, kills: p.kills, deaths: p.deaths, protectedUntil: this.now + RULES.protectionMs }));
    this.bots.forget(p.id); this.nextShot.delete(p.id);
  }
}
/** Turns the bot in place by applying only the view of each frame (no movement, no shots). */
function look(bots: PracticeBots, bot: PlayerState, others: PlayerState[], now: number, mode: GameMode = 'ffa', seq = 1) {
  const frame = bots.input(bot, others, now, 1 / 30, seq, mode); assertFrame(frame, now, seq);
  bot.yaw = frame.yaw; bot.pitch = frame.pitch;
  return frame;
}

test('frames are complete v3 inputs stamped with the server time, and idle for a fallen or paused rival', () => {
  const bots = new PracticeBots('hard', 'frames');
  const bot = rival(0, { x: -28, z: 12 }), human = makePlayer('human', { x: -28, z: -2 });
  const arena = new Arena(bots); arena.add(bot); arena.add(human); arena.frozen.add(human.id);
  arena.run(4000);
  assert.ok(arena.log.shots.length > 0, 'The rival should engage the visible player.');
  arena.frames.get(bot.id)!.forEach((frame, index) => assert.equal(frame.seq, index + 1));
  for (const patch of [{ health: 0 }, { connected: false }] as const) {
    const frame = bots.input({ ...bot, ...patch }, [bot, human], arena.now + TICK, 1 / 30, 99, 'ffa');
    assertFrame(frame, arena.now + TICK, 99);
    assert.deepEqual([frame.moveX, frame.moveZ, frame.fire, frame.aim, frame.melee, frame.grenade, frame.streak], [0, 0, false, false, false, false, null]);
  }
});

test('team rivals never aim at or fire on teammates, and pick the enemy out of a group', () => {
  for (const [mode, team, engages] of [['tdm', 'teal', false], ['tdm', 'gold', true], ['ffa', 'teal', true]] as const) {
    const bots = new PracticeBots('hard', `teams-${mode}-${team}`);
    const bot = rival(0, { x: -28, z: 12, team: 'teal' }), other = makePlayer('human', { x: -28, z: -2, team });
    let fired = false, aimed = false;
    for (let tick = 0; tick < 120; tick++) { const frame = look(bots, bot, [bot, other], 6000 + tick * TICK, mode, tick + 1); fired ||= frame.fire; aimed ||= frame.aim; }
    assert.equal(fired, engages, `${mode} ${team}: firing`); assert.equal(aimed, engages, `${mode} ${team}: aiming`);
  }
  const bots = new PracticeBots('hard', 'teams-mixed');
  const bot = rival(0, { x: -28, z: 12, team: 'teal' }), friend = makePlayer('friend', { x: -27, z: 4, team: 'teal' }), enemy = makePlayer('enemy', { x: -28, z: -6, team: 'gold' });
  let last: InputFrame | undefined;
  for (let tick = 0; tick < 90; tick++) last = look(bots, bot, [bot, friend, enemy], 6000 + tick * TICK, 'tdm', tick + 1);
  assert.ok(aimError(bot, last!, zoneCentre(enemy, 'torso')) < 0.06, 'A closer teammate in plain view does not steal the aim.');
});

test('aim starts from the eyes and converges on the torso, or the head about a third of the time on Challenging', () => {
  for (const difficulty of DIFFICULTIES) for (const [botPosture, targetPosture] of [['stand', 'stand'], ['crouch', 'stand'], ['stand', 'crouch']] as const) {
    const bots = new PracticeBots(difficulty, `eye-${botPosture}-${targetPosture}`), settings = BOT_SETTINGS[difficulty];
    const bot = rival(0, { x: -28, z: 12, posture: botPosture }), target = makePlayer('human', { x: -28, z: -2, posture: targetPosture });
    const head = zoneCentre(target, 'head'), torso = zoneCentre(target, 'torso'), separation = pitchTo(bot, head) - pitchTo(bot, torso);
    let headShots = 0, shots = 0, offset = 0;
    for (let tick = 0; tick < 1800; tick++) {
      const frame = look(bots, bot, [bot, target], 6000 + tick * TICK, 'ffa', tick + 1);
      if (!frame.fire) continue;
      const toHead = aimError(bot, frame, head), toTorso = aimError(bot, frame, torso);
      assert.ok(Math.min(toHead, toTorso) <= settings.error * 1.2 + 0.05, `${difficulty} ${botPosture}/${targetPosture}: aim error ${Math.min(toHead, toTorso)}`);
      shots++; offset += frame.pitch - pitchTo(bot, torso); if (toHead < toTorso) headShots++;
    }
    assert.ok(shots > 10, `${difficulty}: the rival should fire`);
    if (difficulty === 'hard' && targetPosture === 'stand') assert.ok(headShots / shots > 0.12 && headShots / shots < 0.6, `head share ${headShots}/${shots}`);
    if (difficulty !== 'hard') assert.ok(Math.abs(offset / shots) < separation / 2, `${difficulty} aims for the torso (mean offset ${(offset / shots).toFixed(4)})`);
  }
});

test('unseen opponents cannot change decisions, and reaction time and accuracy are ordered by difficulty', () => {
  const a = new PracticeBots('hard', 'sight'), b = new PracticeBots('hard', 'sight');
  const botA = rival(0, { x: -28, z: 0, yaw: Math.PI / 2 }), botB = rival(0, { x: -28, z: 0, yaw: Math.PI / 2 });
  for (let tick = 0; tick < 60; tick++) {
    const fa = a.input(botA, [botA, makePlayer('human', { x: -11, z: 0 })], 6000 + tick * 100, 0.1, tick + 1, 'ffa');
    const fb = b.input(botB, [botB, makePlayer('human', { x: -11, z: 2 })], 6000 + tick * 100, 0.1, tick + 1, 'ffa');
    assert.deepEqual(fa, fb, 'Moving an unseen opponent behind the house wall must not reveal it.');
    assert.equal(fa.fire, false); assert.equal(fa.aim, false);
  }
  const results = DIFFICULTIES.map(difficulty => {
    const bots = new PracticeBots(difficulty, 'accuracy'), shooter = rival(0, { x: -28, z: 12 }), target = makePlayer('human', { x: -28, z: -8 });
    let firstShot = Infinity, misses = 0, shots = 0;
    for (let tick = 0; tick < 450; tick++) {
      const now = 6000 + tick * TICK, frame = look(bots, shooter, [shooter, target], now, 'ffa', tick + 1);
      if (!frame.fire) continue;
      firstShot = Math.min(firstShot, now - 6000); shots++;
      if (!rayHitboxes(eyePosition(shooter), directionFromAngles(frame.yaw, frame.pitch), target, 100)) misses++;
    }
    assert.ok(shots > 0 && firstShot >= BOT_SETTINGS[difficulty].reaction * 0.85 - TICK, `${difficulty} first shot ${firstShot}`);
    return { difficulty, firstShot, missRate: misses / shots };
  });
  assert.ok(results[0]!.firstShot > results[1]!.firstShot && results[1]!.firstShot > results[2]!.firstShot, JSON.stringify(results));
  assert.ok(results[0]!.missRate > results[1]!.missRate && results[1]!.missRate > results[2]!.missRate, JSON.stringify(results));
  assert.ok(results[2]!.missRate > 0, 'Even Challenging keeps some aim error.');
});

test('recoil a rival has not pulled down climbs through a burst, less on harder settings, and recovers after', () => {
  const kicks = DIFFICULTIES.map(difficulty => {
    // Two identical rivals; only the first sees its magazine drop, so the view difference is its recoil.
    const kicked = new PracticeBots(difficulty, 'recoil'), steady = new PracticeBots(difficulty, 'recoil');
    const a = rival(0, { x: -28, z: 12, mag: [1000, 12] }), b = rival(0, { x: -28, z: 12, mag: [1000, 12] }), target = makePlayer('human', { x: -28, z: -6 });
    let nextShot = 0, burst = 0, idle = 0, afterThree = 0, worst = 0, settled = 0;
    for (let tick = 0; tick < 450; tick++) {
      const now = 6000 + tick * TICK;
      const fa = kicked.input(a, [a, target], now, 1 / 30, tick + 1, 'ffa'), fb = steady.input(b, [b, target], now, 1 / 30, tick + 1, 'ffa');
      assert.equal(fa.fire, fb.fire, 'Recoil must not change decisions.');
      const kick = fa.pitch - fb.pitch;
      worst = Math.max(worst, Math.abs(kick));
      if (burst === 4 && !afterThree) afterThree = kick;
      if (idle >= 12) settled = Math.max(settled, Math.abs(kick));
      Object.assign(a, { yaw: fa.yaw, pitch: fa.pitch }); Object.assign(b, { yaw: fb.yaw, pitch: fb.pitch });
      if (fa.fire && now >= nextShot) { a.mag[0]--; nextShot = now + fireIntervalMs(WEAPONS.kr5); burst++; idle = 0; }
      else if (!fa.fire) { idle++; burst = 0; }
    }
    assert.ok(afterThree > 0.001, `${difficulty} climbs (${afterThree})`);
    assert.ok(worst < 0.08, `${difficulty} recoil stays bounded (${worst})`);
    assert.ok(settled < 0.002, `${difficulty} recovers between bursts (${settled})`);
    return afterThree;
  });
  assert.ok(kicks[0]! > kicks[1]! && kicks[1]! > kicks[2]!, kicks.join(' > '));
});

test('a wounded rival backs off out of sight, tops up its magazine, and returns once health refills', () => {
  const bots = new PracticeBots('normal', 'retreat'), arena = new Arena(bots, 'ffa', false);
  const bot = arena.add(rival(0, { x: 0, z: -20, yaw: Math.PI, health: RETREAT_HEALTH - 5, mag: [11, 12] }));
  const enemy = arena.add(makePlayer('human', { x: 0, z: -5 })); arena.frozen.add(enemy.id);
  assert.ok(sees(bot, enemy) && sees(enemy, bot));
  let hiddenAt = -1, firedWhileRetreating = false, reloaded = false;
  // Keep health from refilling during this phase.
  arena.run(6000, () => {
    const frame = arena.last(bot.id)!;
    if (hiddenAt < 0 && frame.fire && horizontal(bot, enemy) > 7) firedWhileRetreating = true;
    if (hiddenAt < 0 && !sees(enemy, bot) && Math.hypot(bot.vx, bot.vz) < 0.2) hiddenAt = arena.now;
    if (frame.reload) reloaded = true;
    bot.lastDamageAt = arena.now;
  });
  assert.ok(hiddenAt > 0, `The rival should reach cover; ended at ${JSON.stringify({ x: bot.x, z: bot.z })}`);
  assert.equal(firedWhileRetreating, false, 'Retreat means running, not trading shots.');
  assert.ok(reloaded, 'Waiting in cover is a chance to reload.');
  const hold = { x: bot.x, y: bot.y, z: bot.z };
  arena.run(1500, () => { bot.lastDamageAt = arena.now; });
  assert.ok(horizontal(bot, hold) < 1 && !sees(enemy, bot), 'The rival stays in cover while hurt.');
  bot.health = RECOVERED_HEALTH + 5; arena.run(8000);
  assert.ok(horizontal(bot, hold) > 2 || arena.log.shots.some(s => s.by === bot.id), 'With health back the rival rejoins the fight.');
  // Up close a wounded rival fights back instead of turning its back.
  const duel = new Arena(new PracticeBots('hard', 'retreat-close'), 'ffa', false);
  const hurt = duel.add(rival(0, { x: -28, z: 12, health: 30 })), near = duel.add(makePlayer('human', { x: -28, z: 7 })); duel.frozen.add(near.id);
  duel.run(2000, () => { hurt.lastDamageAt = duel.now; });
  assert.ok(duel.log.shots.some(s => s.by === hurt.id));
});

test('loadout weapons: pistol for close fights on an empty primary, rifle and reload otherwise, taps for semi-automatics', () => {
  const near = (distance: number, mag: [number, number]) => {
    const bots = new PracticeBots('hard', `slot-${distance}-${mag.join('-')}`);
    const bot = rival(0, { x: -28, z: 12, mag }), human = makePlayer('human', { x: -28, z: 12 - distance });
    return Array.from({ length: 20 }, (_, tick) => look(bots, bot, [bot, human], 6000 + tick * TICK, 'ffa', tick + 1));
  };
  assert.ok(near(SECONDARY_RANGE - 4, [0, 12]).some(f => f.slot === 2), 'Swap to the pistol when the primary is empty up close.');
  const far = near(SECONDARY_RANGE + 8, [0, 12]);
  assert.ok(far.every(f => f.slot === 1) && far.some(f => f.reload), 'Farther away, reload the primary instead.');
  assert.ok(near(6, [20, 12]).every(f => f.slot === 1 && !f.reload), 'A loaded primary is kept and not reloaded mid-fight.');
  // Hidden: back to the primary, and reloads are separate presses.
  const bots = new PracticeBots('normal', 'hidden-reload'), bot = rival(0, { x: -28, z: 0, yaw: Math.PI / 2, mag: [9, 3], slot: 2, weapon: 'sentry9' });
  const frames: InputFrame[] = [];
  for (let tick = 0; tick < 12; tick++) {
    const frame = look(bots, bot, [bot], 6000 + tick * TICK, 'ffa', tick + 1); frames.push(frame);
    if (frame.slot !== bot.slot) Object.assign(bot, { slot: frame.slot, weapon: weaponFor(bot.loadout, frame.slot).id });
  }
  assert.ok(frames.some(f => f.slot === 1) && frames.some(f => f.reload));
  for (let i = 1; i < frames.length; i++) assert.ok(!(frames[i]!.reload && frames[i - 1]!.reload), 'Reload is pressed, not held.');
  for (const [loadout, slot, z] of [[LOADOUT_PRESETS.marksman, 1, -4], [LOADOUT_PRESETS.assault, 2, 6]] as const) {
    const arena = new Arena(new PracticeBots('hard', `tap-${slot}`), 'ffa', false);
    const shooter = arena.add(rival(2, { x: -28, z: 12, loadout, slot, weapon: weaponFor(loadout, slot).id, mag: [WEAPONS[loadout.primary].magazine, 12] }));
    const target = arena.add(makePlayer('human', { x: -28, z })); arena.frozen.add(target.id); arena.pinned.add(shooter.id);
    arena.run(6000);
    const spec = weaponFor(loadout, slot), frames = arena.frames.get(shooter.id)!, shots = arena.log.shots.filter(s => s.by === shooter.id && s.slot === slot);
    assert.ok(shots.length >= 2, `${spec.name} should fire`);
    for (let i = 1; i < frames.length; i++) if (frames[i]!.slot === slot && frames[i - 1]!.slot === slot) assert.ok(!(frames[i]!.fire && frames[i - 1]!.fire), `${spec.name} must be tapped`);
    for (let i = 1; i < shots.length; i++) assert.ok(shots[i]!.at - shots[i - 1]!.at >= fireIntervalMs(spec) - TICK - 1e-6);
  }
});

test('a rival knifes an opponent within reach after reacting, once per swing', () => {
  const arena = new Arena(new PracticeBots('normal', 'knife'), 'ffa', false);
  const bot = arena.add(rival(0, { x: -28, z: 12 })), human = arena.add(makePlayer('human', { x: -28, z: 10.9 })); arena.frozen.add(human.id);
  arena.run(2000);
  const frames = arena.frames.get(bot.id)!;
  assert.ok(arena.log.melee.length >= 1, 'A knife swing within 1.6 m.');
  assert.ok(arena.log.melee[0]!.at - 6000 >= BOT_SETTINGS.normal.reaction * 0.85 - TICK, 'Knifing waits for the reaction time too.');
  for (let i = 1; i < frames.length; i++) assert.ok(!(frames[i]!.melee && frames[i - 1]!.melee));
  for (let i = 1; i < arena.log.melee.length; i++) assert.ok(arena.log.melee[i]!.at - arena.log.melee[i - 1]!.at >= RULES.meleeMs);
});

/** The rival sees an opponent through the teal garage, then the opponent steps behind the house wall. */
function fragTrial(difficulty: PracticeDifficulty, seed: string) {
  const arena = new Arena(new PracticeBots(difficulty, seed), 'ffa', false);
  const bot = arena.add(rival(0, { x: -28, z: 12 })), enemy = arena.add(makePlayer('human', { x: -9, z: 7 }));
  arena.frozen.add(enemy.id); arena.pinned.add(bot.id);
  const seenAt = { x: enemy.x, y: 0, z: enemy.z };
  assert.ok(sees(bot, enemy));
  arena.run(1500);
  Object.assign(enemy, { z: 5.5 }); assert.ok(!sees(bot, enemy));
  arena.run(2500);
  return { arena, bot, seenAt };
}
test('frags go at an opponent who ducks behind cover, at each difficulty\'s rate, and land where it was seen', () => {
  const trials = 80;
  const rates = DIFFICULTIES.map(difficulty => {
    let throws = 0;
    for (let i = 0; i < trials; i++) {
      const { arena, bot, seenAt } = fragTrial(difficulty, `frag-${i}`);
      assert.ok(arena.log.throws.length <= 1);
      for (const thrown of arena.log.throws) {
        throws++;
        const longest = Math.max(...FRAG_COOKS_MS) + FRAG_RELEASE_GRACE_MS + TICK;
        assert.ok(thrown.cookedMs >= FRAG_COOK_MS - TICK && thrown.cookedMs <= longest && longest < EXPLOSIVES.frag.fuseMs - 500, `cooked ${thrown.cookedMs}`);
        // Checked with the shared grenade physics, not the rival's own planner.
        const launch = grenadeLaunch(thrown.eye, thrown.yaw, thrown.pitch, { vx: 0, vz: 0 }, EXPLOSIVES.frag.throwSpeed, EXPLOSIVES.frag.throwLift);
        const landing = grenadePosition(launch.from, launch.velocity, EXPLOSIVES.frag.fuseMs - thrown.cookedMs);
        assert.ok(horizontal(landing, fragLanding(thrown.eye, thrown.yaw, thrown.pitch, EXPLOSIVES.frag.fuseMs - thrown.cookedMs)) < 1e-6, 'The planner predicts the shared trajectory exactly.');
        assert.ok(horizontal(landing, seenAt) < 3.5, `landed ${horizontal(landing, seenAt).toFixed(2)} m away`);
        assert.ok(horizontal(landing, bot) > EXPLOSIVES.frag.radius, 'Never at its own feet.');
      }
    }
    return throws / trials;
  });
  assert.equal(rates[0], 0, 'Relaxed rivals never throw frags.');
  assert.ok(rates[1]! > 0.03 && rates[1]! < 0.32, `Balanced rate ${rates[1]}`);
  assert.ok(rates[2]! > rates[1]! && rates[2]! < 0.55, `Challenging rate ${rates[2]}`);
  // Closer than the minimum or beyond the maximum is not a frag opportunity.
  for (const [x, z] of [[-28, 12 - FRAG_RANGE.min + 2], [0, 8]] as const) {
    for (let i = 0; i < 20; i++) {
      const arena = new Arena(new PracticeBots('hard', `range-${x}-${i}`), 'ffa', false);
      const bot = arena.add(rival(0, { x: -28, z: 12, yaw: Math.atan2(x + 28, -(z - 12)) })), enemy = arena.add(makePlayer('human', { x, z }));
      arena.frozen.add(enemy.id); arena.pinned.add(bot.id);
      assert.ok(sees(bot, enemy));
      arena.run(1200); enemy.connected = false; arena.run(2000);
      assert.equal(arena.log.throws.length, 0, `distance ${horizontal(bot, enemy).toFixed(1)}`);
    }
  }
});

test('frag use stays bounded by the cooldown when an opponent keeps ducking in and out', () => {
  for (const difficulty of ['normal', 'hard'] as const) {
    const arena = new Arena(new PracticeBots(difficulty, 'flicker'), 'ffa', false);
    const bot = arena.add(rival(0, { x: -28, z: 12, frags: 99 })), enemy = arena.add(makePlayer('human', { x: -9, z: 7 }));
    arena.frozen.add(enemy.id); arena.pinned.add(bot.id);
    for (let step = 0; step < 120; step++) { enemy.z = step % 2 ? 5.5 : 7; arena.run(600); }
    const throws = arena.log.throws.map(t => t.at);
    for (let i = 1; i < throws.length; i++) assert.ok(throws[i]! - throws[i - 1]! >= FRAG_COOLDOWN_MS - TICK, `${difficulty} throws too often`);
    assert.ok(throws.length >= 1 && throws.length <= 72_000 / FRAG_COOLDOWN_MS + 1, `${difficulty}: ${throws.length} throws`);
  }
});

test('a rival stops before planning a frag, lets go only of one that bursts clear of itself, and waits out the blast', t => {
  let throws = 0;
  for (const difficulty of ['normal', 'hard'] as const) for (let i = 0; i < 30; i++) {
    // Not pinned: the rival is closing in when the opponent ducks behind the house wall, then may chase.
    const arena = new Arena(new PracticeBots(difficulty, `own-frag-${i}`), 'ffa', false);
    const bot = arena.add(rival(0, { x: -28, z: 12, frags: 3 })), enemy = arena.add(makePlayer('human', { x: -9, z: 7 }));
    arena.frozen.add(enemy.id);
    arena.run(1200 + (i % 4) * 300); enemy.z = 5.5;
    // While one of its frags is in the air, the rival stays outside the blast of where it will burst.
    arena.run(9000, () => {
      for (const grenade of arena.grenades) if (grenade.owner === bot) {
        assert.ok(horizontal(bot, grenade.burst) > EXPLOSIVES.frag.radius || Math.abs(bot.y - grenade.burst.y) > 2.5,
          `${difficulty} ${i}: ${horizontal(bot, grenade.burst).toFixed(2)} m from its own live frag`);
      }
    });
    for (const cook of arena.log.cooks.filter(c => c.by === bot.id)) assert.ok(cook.speed <= 0.1, `cooked while moving at ${cook.speed.toFixed(2)} m/s`);
    for (const blast of arena.log.blasts.filter(b => b.by === bot.id)) {
      throws++;
      assert.ok(blast.ownerDistance > EXPLOSIVES.frag.radius, `${difficulty} ${i}: burst ${blast.ownerDistance.toFixed(2)} m from its thrower`);
    }
    assert.deepEqual(arena.log.hits.filter(h => h.of === bot.id), [], `${difficulty} ${i}: the rival hurt itself`);
  }
  t.diagnostic(`${throws} frags thrown by moving rivals`);
  assert.ok(throws >= 6, `Only ${throws} throws: the scenario no longer exercises frags.`);
  // The check before letting go uses the shared simulation from the real eye, view and remaining fuse.
  const eye = { x: -28, y: EYE_HEIGHT.stand, z: 12 }, flight = EXPLOSIVES.frag.fuseMs - FRAG_COOK_MS;
  const launch = grenadeLaunch(eye, 1.2, 0.4, { vx: 2, vz: -1 }, EXPLOSIVES.frag.throwSpeed, EXPLOSIVES.frag.throwLift);
  assert.ok(horizontal(fragLanding(eye, 1.2, 0.4, flight, { vx: 2, vz: -1 }), grenadePosition(launch.from, launch.velocity, flight)) < 1e-9);
  assert.ok(FRAG_SAFE_LANDING > EXPLOSIVES.frag.radius && FRAG_CLEARANCE > EXPLOSIVES.frag.radius);
});

test('frag planning spreads over frames: no rival frame runs more than a few grenade simulations', t => {
  const advance = GrenadeTrajectory.prototype.advanceTo, input = PracticeBots.prototype.input;
  const runs = new Set<object>();
  let inside = false, worst = 0;
  t.mock.method(GrenadeTrajectory.prototype, 'advanceTo', function (this: GrenadeTrajectory, elapsedMs: number) { if (inside) runs.add(this); return advance.call(this, elapsedMs); });
  t.mock.method(PracticeBots.prototype, 'input', function (this: PracticeBots, ...args: Parameters<PracticeBots['input']>) {
    inside = true; runs.clear();
    try { return input.apply(this, args); } finally { inside = false; worst = Math.max(worst, runs.size); }
  });
  let throws = 0;
  for (let i = 0; i < 30; i++) throws += fragTrial('hard', `budget-${i}`).arena.log.throws.length;
  t.diagnostic(`${throws} throws; at most ${worst} grenade simulations in one frame`);
  assert.ok(throws >= 4, `throws ${throws}`);
  assert.ok(worst >= 1 && worst <= FRAG_SIMULATIONS_PER_TICK, `A single frame ran ${worst} grenade simulations.`);
  // The whole search is bounded, and spreading it over frames picks the same throw as running it at once.
  for (const [eye, target] of [[{ x: -28, y: EYE_HEIGHT.stand, z: 12 }, { x: -9, y: 0, z: 7 }], [{ x: 0, y: EYE_HEIGHT.stand, z: -20 }, { x: 13, y: 0, z: -2 }], [{ x: 20, y: EYE_HEIGHT.stand, z: 18 }, { x: 4, y: 0, z: 9 }]] as const) {
    const planner = new FragPlanner(eye, target);
    let frames = 0;
    while (!planner.step(FRAG_SIMULATIONS_PER_TICK)) frames++;
    assert.ok(planner.simulations <= 64 && frames <= Math.ceil(64 / FRAG_SIMULATIONS_PER_TICK), `${planner.simulations} simulations over ${frames} frames`);
    assert.deepEqual(planner.result, planFrag(eye, target));
    if (planner.result) assert.ok(horizontal(planner.result.landing, eye) >= FRAG_SAFE_LANDING);
  }
});

test('a rival boxed in a doorway keeps moving through a fight instead of standing still', () => {
  // The teal front door: the jambs leave no room to side-step, so the rival backs off through the door instead.
  for (const difficulty of DIFFICULTIES) {
    const arena = new Arena(new PracticeBots(difficulty, `door-${difficulty}`), 'ffa', false);
    const bot = arena.add(rival(0, { x: -10, z: -2.25, yaw: Math.PI / 2 })), enemy = arena.add(makePlayer('human', { x: -6, z: -2.25 }));
    arena.frozen.add(enemy.id);
    assert.ok(sees(bot, enemy));
    let still = 0, longest = 0, last = { x: bot.x, z: bot.z }, fought = 0;
    arena.run(8000, () => {
      assert.ok(!penetrates(bot), `clipped at ${JSON.stringify({ x: bot.x, z: bot.z })}`);
      if (arena.last(bot.id)!.aim) fought++;
      still = Math.hypot(bot.x - last.x, bot.z - last.z) < 0.005 ? still + 1 : 0; longest = Math.max(longest, still); last = { x: bot.x, z: bot.z };
    });
    assert.ok(fought > 30 * 3, `${difficulty}: the rival should fight (${fought} aimed frames)`);
    assert.ok(longest < 30 * 1.5, `${difficulty}: stood still for ${(longest / 30).toFixed(1)} s`);
  }
});

test('a rival pressed against a wall with no route planned steps back out instead of freezing', t => {
  t.mock.method(BotNavigation.prototype, 'findPath', () => []);
  const nav = new BotNavigation(), sandbags = OBSTACLES.find(b => b.id === 'west-lane-sandbags')!;
  for (const [side, yaw] of [[-1, 0], [1, Math.PI]] as const) {
    const arena = new Arena(new PracticeBots('normal', `no-route-${side}`), 'ffa', false);
    // Resting against the sandbags at exact contact, as the physics leaves a body that walked into them.
    const bot = arena.add(rival(0, { x: sandbags.x, z: sandbags.z + side * (sandbags.d / 2 + PLAYER_RADIUS), yaw }));
    assert.equal(nav.isWalkable(bot), false);
    let freedAt = -1;
    arena.run(2000, () => { assert.ok(!penetrates(bot)); if (freedAt < 0 && nav.isWalkable(bot)) freedAt = arena.now; });
    assert.ok(freedAt > 0 && freedAt - 6000 < 1000, `still pressed against the sandbags at ${JSON.stringify({ x: bot.x, z: bot.z })}`);
  }
});

test('rewards: Recon Sweep and Attack Drone at once, Mortar Strike on a recently seen opponent', () => {
  const bots = new PracticeBots('normal', 'rewards'), arena = new Arena(bots, 'ffa', false);
  const bot = arena.add(rival(0, { x: -28, z: 0, yaw: Math.PI / 2, rewards: ['mortar', 'drone', 'recon'] }));
  arena.run(3000);
  assert.deepEqual(arena.log.rewards.map(r => r.reward), ['drone', 'recon'], 'Mortar waits for a target.');
  assert.deepEqual(bot.rewards, ['mortar']);
  const frames = arena.frames.get(bot.id)!;
  for (let i = 1; i < frames.length; i++) assert.ok(!(frames[i]!.streak && frames[i - 1]!.streak), 'Rewards are pressed once.');
  // An opponent seen at range becomes the mortar target.
  const enemy = arena.add(makePlayer('human', { x: -9, z: 7 })); arena.frozen.add(enemy.id);
  Object.assign(bot, { x: -28, y: 0, z: 12, yaw: Math.PI / 2, vx: 0, vz: 0 }); bots.forget(bot.id); arena.pinned.add(bot.id);
  arena.run(800); enemy.z = 5.5; arena.run(2500);
  const mortar = arena.log.rewards.find(r => r.reward === 'mortar');
  assert.ok(mortar?.target && Math.hypot(mortar.target.x + 9, mortar.target.z - 7) < 1, JSON.stringify(mortar));
});

test('a Recon Sweep steers the search toward opponents the minimap shows, but not Low Profile ones', t => {
  for (const [perks, expected] of [[LOADOUT_PRESETS.close.perks, true], [LOADOUT_PRESETS.marksman.perks, false]] as const) {
    const goals: Vec3[] = [], original = BotNavigation.prototype.findPath;
    const mock = t.mock.method(BotNavigation.prototype, 'findPath', function (this: BotNavigation, start: Vec3, goal: Vec3) { goals.push({ ...goal }); return original.call(this, start, goal); });
    const arena = new Arena(new PracticeBots('normal', `radar-${expected}`), 'ffa', false);
    arena.add(rival(0, { x: -28, z: 0, yaw: Math.PI / 2, rewards: ['recon'] }));
    const hidden = arena.add(makePlayer('human', { x: 24, z: -15, loadout: { ...LOADOUT_PRESETS.close, perks: [...perks] } })); arena.frozen.add(hidden.id);
    arena.run(2500);
    assert.equal(goals.some(goal => horizontal(goal, hidden) < 0.01), expected, `perks ${perks.join(',')}`);
    mock.mock.restore();
  }
});

test('Balanced and Challenging rivals dash on long quiet routes; only Challenging rivals slide into fights', () => {
  for (const difficulty of DIFFICULTIES) {
    const arena = new Arena(new PracticeBots(difficulty, `dash-${difficulty}`), 'tdm', false);
    for (let i = 0; i < 3; i++) arena.add(rival(i, { x: SPAWNS[i]!.x, z: SPAWNS[i]!.z, yaw: SPAWNS[i]!.yaw, team: 'teal' }));
    arena.run(60_000);
    const dashes = [...arena.frames.values()].flat().filter(f => f.dash).length;
    if (difficulty === 'easy') assert.equal(dashes, 0); else assert.ok(dashes > 30, `${difficulty} dashed ${dashes} frames`);
  }
  const slides = DIFFICULTIES.map(difficulty => {
    let count = 0;
    for (let round = 0; round < 3; round++) {
      const arena = new Arena(new PracticeBots(difficulty, `slide-${round}`), 'ffa', true);
      for (let i = 0; i < 3; i++) arena.add(rival(i, { x: SPAWNS[i]!.x, z: SPAWNS[i]!.z, yaw: SPAWNS[i]!.yaw }));
      arena.run(60_000); count += arena.log.slides;
    }
    return count;
  });
  assert.deepEqual(slides.slice(0, 2), [0, 0]); assert.ok(slides[2]! > 0, `Challenging slides ${slides[2]}`);
});

test('team rivals roam the whole town, use the stairs and never clip or stall', () => {
  const arena = new Arena(new PracticeBots('normal', 'roam'), 'tdm', false);
  const rivals = [0, 1, 2].map(i => arena.add(rival(i, { x: SPAWNS[i]!.x, z: SPAWNS[i]!.z, yaw: SPAWNS[i]!.yaw, team: 'gold' })));
  const travel = rivals.map(() => 0), stalled = rivals.map(() => 0), longest = rivals.map(() => 0), last = rivals.map(p => ({ x: p.x, y: p.y, z: p.z }));
  let upstairs = 0;
  arena.run(180_000, () => rivals.forEach((p, i) => {
    assert.ok(!penetrates(p), `${p.id} clipped into geometry at ${JSON.stringify({ x: p.x, y: p.y, z: p.z })}`);
    const moved = horizontal(p, last[i]!); travel[i]! += moved;
    stalled[i] = moved < 0.005 ? stalled[i]! + 1 : 0; longest[i] = Math.max(longest[i]!, stalled[i]!);
    if (p.y > 3) upstairs++;
    last[i] = { x: p.x, y: p.y, z: p.z };
  }));
  assert.ok(travel.every(d => d > 300), `travel ${travel.map(Math.round).join('/')}`);
  assert.ok(longest.every(n => n < 30 * 10), `longest stall ${longest.map(n => (n / 30).toFixed(1)).join('/')}s`);
  assert.ok(upstairs > 30 * 10, 'Some patrols should cover the upper floors.');
});

test('three rivals play full rounds at every difficulty under the shared rules without errors', t => {
  for (const mode of ['ffa', 'tdm'] as const) for (const difficulty of DIFFICULTIES) {
    const arena = new Arena(new PracticeBots(difficulty, `round-${mode}-${difficulty}`), mode, true);
    const human = arena.add(makePlayer('human', { x: SPAWNS[0]!.x, z: SPAWNS[0]!.z, team: 'teal' }));
    const rivals = [0, 1, 2].map(i => arena.add(rival(i, {
      x: SPAWNS[i + 1]!.x, z: SPAWNS[i + 1]!.z, yaw: SPAWNS[i + 1]!.yaw, team: i === 0 ? 'teal' : 'gold', loadout: botLoadout(PRACTICE_RIVALS[i]!.id, difficulty),
    })));
    const started = performance.now();
    arena.run(120_000, () => { for (const p of rivals) if (p.health > 0) assert.ok(!penetrates(p), `${p.id} clipped at ${JSON.stringify({ x: p.x, y: p.y, z: p.z })}`); });
    const elapsed = performance.now() - started, kills = arena.log.kills;
    const fragKills = kills.filter(k => k.cause === 'frag' && k.by !== k.of).length;
    t.diagnostic(`${mode} ${difficulty}: ${elapsed.toFixed(0)} ms; ${arena.log.shots.length} shots (${arena.log.offTarget} off target); ${kills.length} eliminations; ${arena.log.throws.length} frags (${fragKills} eliminations); ${arena.log.slides} slides; ${arena.log.melee.length} knife swings`);
    assert.ok(elapsed < 15_000);
    assert.deepEqual(arena.log.hits.filter(h => h.cause === 'frag' && h.by === h.of), [], 'Rivals never hurt themselves with their own frags.');
    assert.ok(arena.log.hits.some(h => h.of === human.id), 'Practice must challenge the player.');
    if (mode === 'ffa') assert.ok(kills.some(k => k.by !== human.id && k.of !== human.id), 'Rivals compete with each other too.');
    assert.ok(arena.log.offTarget <= arena.log.shots.length * 0.03, 'Shots point at an enemy, never only at a teammate.');
    for (const id of rivals.map(p => p.id)) {
      const throws = arena.log.throws.filter(x => x.by === id);
      assert.ok(throws.length <= 120_000 / FRAG_COOLDOWN_MS + 1);
      if (difficulty === 'easy') assert.equal(throws.length, 0);
    }
  }
});
