import assert from 'node:assert/strict';
import test from 'node:test';
import { RULES, type InputFrame, type Loadout, type PlayerState, type WeaponId } from '../../shared/protocol';
import { EXPLOSIVES, fireIntervalMs, LOADOUT_PRESETS, QUICK_HANDS_FACTOR, WEAPONS } from '../../shared/weapons';
import {
  aimProgress, DASH_SPRINT_TO_FIRE, LocalWeapon, RecoilRecovery, recoilKick, ServerTracers, shotCone, shotDirections, spawnFrags, spawnReserve,
  VAULT_FIRE_PROGRESS, type WeaponEvent, type WeaponStepContext,
} from '../../src/game/LocalWeapon';
import { directionFromAngles } from '../../shared/physics';

const TICK = 1000 / 30;
const plain: Loadout = { primary: 'kr5', secondary: 'sentry9', lethal: 'frag', perks: ['deep-pockets', 'quiet-step', 'second-wind'] };
const quick: Loadout = { ...plain, perks: ['quick-hands', 'quiet-step', 'second-wind'] };
const frame = (seq: number, changes: Partial<InputFrame> = {}): InputFrame => ({
  seq, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, fire: false, aim: false, jump: false, sprint: false, reload: false, slot: 1,
  crouch: false, dash: false, melee: false, grenade: false, streak: null, viewTime: 0, ...changes,
});
/** Unless a test says otherwise, the vault state before this tick's move is the same as after it. */
const context = (now: number, changes: Partial<WeaponStepContext> = {}): WeaponStepContext => {
  const vaultProgress = changes.vaultProgress ?? 1;
  return { now, alive: true, sprinting: false, dashing: false, vaultProgress, pressVaultProgress: vaultProgress, vaultingBefore: vaultProgress < 1, ads: 0, ...changes };
};
function self(loadout: Loadout, changes: Partial<PlayerState> = {}): PlayerState {
  const primary = WEAPONS[loadout.primary], secondary = WEAPONS[loadout.secondary];
  return {
    id: 'dad', name: 'Dad', color: '#fff', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, health: 100, slot: 1,
    weapon: loadout.primary, loadout, kills: 0, deaths: 0, assists: 0, score: 0, streak: 0, connected: true, respawnAt: 0,
    protectedUntil: 0, reloadingUntil: 0, posture: 'stand', vault: null, slideUntil: 0, cookingSince: 0, lastInputSeq: 0,
    mag: [primary.magazine, secondary.magazine], reserve: [spawnReserve(primary, loadout), spawnReserve(secondary, loadout)],
    frags: spawnFrags(loadout), rewards: [], reloadSlot: 0, readyAt: 0, meleeUntil: 0, stamina: 1, slideCooldownUntil: 0, lastDamageAt: 0,
    ...changes,
  };
}
function armed(loadout: Loadout, changes: Partial<PlayerState> = {}) {
  const weapon = new LocalWeapon(loadout);
  weapon.reset(self(loadout, changes), 0);
  return weapon;
}
interface Drive { seq: number; time: number; events: WeaponEvent[][] }
/** Steps once per 30 Hz tick from `start`; `script` returns the input changes for that tick. */
function drive(weapon: LocalWeapon, ticks: number, script: (tick: number) => Partial<InputFrame>, start = 10_000,
  ctx: (tick: number) => Partial<WeaponStepContext> = () => ({}), first = 1): Drive {
  const result: Drive = { seq: first, time: start, events: [] };
  for (let tick = 0; tick < ticks; tick++) {
    result.time = start + tick * TICK;
    result.events.push(weapon.step(frame(result.seq++, script(tick)), context(result.time, ctx(tick))));
  }
  return result;
}
const shotTicks = (run: Drive) => run.events.flatMap((events, tick) => events.some(event => event.type === 'shot') ? [tick] : []);

test('held automatic fire keeps the table rate at 30 Hz ticks over four seconds', () => {
  for (const id of ['kr5', 'hornet9'] as const) {
    const weapon = armed({ ...plain, primary: id });
    weapon.state.mag = [10_000, 12];
    const shots = shotTicks(drive(weapon, 120, () => ({ fire: true }))).length;
    const expected = WEAPONS[id].rpm * 4 / 60;
    assert.ok(Math.abs(shots - expected) <= 1, `${id}: ${shots} shots, expected ${expected} ±1`);
  }
});

test('press-to-fire weapons fire once per press and never faster than their minimum gap', () => {
  for (const [id, slot] of [['sentry9', 2], ['breaker12', 1], ['longbow', 1]] as const) {
    const loadout = { ...plain, primary: id === 'sentry9' ? 'kr5' as const : id };
    const weapon = armed(loadout, { slot });
    weapon.state.mag = [10_000, 10_000];
    const run = drive(weapon, 120, tick => ({ fire: tick % 2 === 0, slot }));
    const times = shotTicks(run).map(tick => tick * TICK);
    assert.ok(times.length >= 2, id);
    assert.equal(times[0], 0, `${id}: the first press fires immediately`);
    for (let i = 1; i < times.length; i++) assert.ok(times[i]! - times[i - 1]! >= fireIntervalMs(WEAPONS[id]) - 1e-6, `${id} gap`);
    const held = armed(loadout, { slot });
    assert.equal(shotTicks(drive(held, 60, () => ({ fire: true, slot }))).length, 1, `${id}: holding the trigger fires once`);
  }
  // As on the server: a semi-automatic press made while the new weapon raises fires once, as soon as it
  // is up, if the trigger stays down; a tap released before then is lost.
  const raise = Math.ceil(WEAPONS.sentry9.raiseMs / TICK);
  assert.deepEqual(shotTicks(drive(armed(plain), 30, () => ({ fire: true, slot: 2 }))), [raise], 'A held press fires once the pistol is up');
  assert.deepEqual(shotTicks(drive(armed(plain), 30, tick => ({ fire: tick < 3, slot: 2 }))), [], 'A tap released during the raise is lost');
});

test('each weapon keeps its own cadence: the pistol fires once raised after a bolt shot, and swapping back waits out the bolt', () => {
  const loadout: Loadout = { ...plain, primary: 'longbow' }, weapon = armed(loadout), start = 80_000;
  const interval = fireIntervalMs(WEAPONS.longbow), raise = WEAPONS.sentry9.raiseMs, longbowRaise = WEAPONS.longbow.raiseMs;
  assert.ok(weapon.step(frame(1, { fire: true }), context(start)).some(event => event.type === 'shot'));
  weapon.step(frame(2, { slot: 2 }), context(start + TICK));
  assert.ok(weapon.step(frame(3, { slot: 2, fire: true }), context(start + TICK + raise)).some(event => event.type === 'shot'),
    'The pistol does not wait for the Heron 7 bolt');
  weapon.step(frame(4, { slot: 1 }), context(start + 2 * TICK + raise));
  const back = start + 2 * TICK + raise + longbowRaise;
  assert.ok(back < start + interval, 'the scenario swaps back before the bolt is ready');
  assert.deepEqual(weapon.step(frame(5, { slot: 1, fire: true }), context(back)).filter(event => event.type === 'shot'), [], 'Swapping back cannot skip the bolt');
  assert.ok(weapon.step(frame(6, { slot: 1, fire: true }), context(start + interval)).some(event => event.type === 'shot'), 'The held press fires when the bolt is ready');
});

test('a fresh pull of an automatic waits a full interval for its second round', () => {
  const run = drive(armed(plain), 6, () => ({ fire: true }));
  assert.deepEqual(shotTicks(run).slice(0, 2), [0, Math.ceil(fireIntervalMs(WEAPONS.kr5) / TICK)]);
});

test('spawn magazines, spare rounds and frags follow the loadout and Deep Pockets', () => {
  assert.equal(spawnReserve(WEAPONS.kr5, plain), 30 * (4 + 2));
  assert.equal(spawnReserve(WEAPONS.kr5, quick), 30 * 4);
  assert.equal(spawnReserve(WEAPONS.breaker12, quick), 6 * 3);
  assert.equal(spawnFrags(plain), 2); assert.equal(spawnFrags(quick), 1);
  const weapon = armed(LOADOUT_PRESETS.close);
  assert.deepEqual(weapon.state.mag, [32, 12]); assert.deepEqual(weapon.state.reserve, [128, 48]); assert.equal(weapon.state.frags, 1);
});

test('reloads take the table time, empty reloads take longer, Quick Hands is 25% faster, and rounds come from the reserve', () => {
  for (const [loadout, factor] of [[plain, 1], [quick, QUICK_HANDS_FACTOR]] as const) {
    const weapon = armed(loadout, { mag: [25, 12] }), reserve = weapon.state.reserve[0];
    const start = 20_000;
    const events = weapon.step(frame(1, { reload: true }), context(start));
    assert.deepEqual(events, [{ type: 'reload', weapon: 'kr5', empty: false }]);
    assert.equal(weapon.state.reloadingUntil, start + WEAPONS.kr5.reloadMs * factor);
    weapon.step(frame(2), context(start + WEAPONS.kr5.reloadMs * factor - 1));
    assert.equal(weapon.state.mag[0], 25, 'Still reloading one millisecond before the deadline');
    assert.ok(weapon.reloadProgress(start + WEAPONS.kr5.reloadMs * factor / 2) > 0.49);
    const done = weapon.step(frame(3), context(start + WEAPONS.kr5.reloadMs * factor));
    assert.ok(done.some(event => event.type === 'reloaded'));
    assert.equal(weapon.state.mag[0], 30); assert.equal(weapon.state.reserve[0], reserve - 5);
    assert.equal(weapon.reloadProgress(start + 99_999), -1);
    const empty = armed(loadout, { mag: [0, 12] });
    const auto = empty.step(frame(1, { fire: true }), context(start));
    assert.deepEqual(auto, [{ type: 'reload', weapon: 'kr5', empty: true }], 'Firing an empty magazine starts the longer reload');
    assert.equal(empty.state.reloadingUntil, start + WEAPONS.kr5.emptyReloadMs * factor);
  }
  const dry = armed(plain, { mag: [0, 12], reserve: [0, 48] });
  assert.deepEqual(dry.step(frame(1, { fire: true }), context(1_000)), [{ type: 'dry', weapon: 'kr5' }]);
  assert.deepEqual(dry.step(frame(2, { fire: true }), context(1_033)), [], 'The click repeats only on a new press');
});

test('the pump shotgun loads shell by shell and a trigger pull interrupts the reload once a shell is in', () => {
  const loadout: Loadout = { ...plain, primary: 'breaker12' }, spec = WEAPONS.breaker12;
  const weapon = armed(loadout, { mag: [3, 12] }), start = 30_000;
  weapon.step(frame(1, { reload: true }), context(start));
  assert.equal(weapon.state.reloadingUntil, start + spec.shellStartMs! + spec.perShellMs! * 3);
  const shells: number[] = [];
  for (let t = start + 1, seq = 2; t <= start + 2_000; t += 50, seq++) {
    if (weapon.step(frame(seq), context(t)).some(event => event.type === 'shell')) shells.push(t - start);
  }
  assert.deepEqual(shells.map(value => Math.floor(value / 50) * 50), [800, 1250, 1700]);
  assert.equal(weapon.state.mag[0], 6); assert.equal(weapon.state.reloadSlot, 0);
  const interrupted = armed(loadout, { mag: [3, 12] });
  interrupted.step(frame(1, { reload: true }), context(start));
  interrupted.step(frame(2), context(start + spec.shellStartMs! + spec.perShellMs! + 10));
  assert.equal(interrupted.state.mag[0], 4);
  const shot = interrupted.step(frame(3, { fire: true }), context(start + 900));
  assert.ok(shot.some(event => event.type === 'shot'), 'The shot goes out');
  assert.equal(interrupted.state.reloadSlot, 0); assert.equal(interrupted.state.mag[0], 3);
  // A pull that cannot fire yet (the pump is still cycling) leaves the reload running.
  const cycling = armed(loadout, { mag: [3, 12] });
  cycling.step(frame(1, { fire: true }), context(start));
  cycling.step(frame(2, { reload: true }), context(start + TICK));
  cycling.step(frame(3), context(start + TICK + spec.shellStartMs! + spec.perShellMs! + 10));
  assert.equal(cycling.state.mag[0], 3, 'a shell went in after the shot');
  assert.ok(start + TICK + spec.shellStartMs! + spec.perShellMs! + 20 < start + fireIntervalMs(spec), 'the scenario pulls before the pump is ready');
  assert.deepEqual(cycling.step(frame(4, { fire: true }), context(start + TICK + spec.shellStartMs! + spec.perShellMs! + 20)).filter(event => event.type === 'shot'), []);
  assert.equal(cycling.state.reloadSlot, 1, 'An early pull does not stop the reload');
});

test('once a shell is in, a pump reload no longer blocks the trigger, so Simple fire can interrupt it like a manual pull', () => {
  const loadout: Loadout = { ...plain, primary: 'breaker12' }, spec = WEAPONS.breaker12, start = 30_000;
  const weapon = armed(loadout, { mag: [0, 12] });
  const ready = (now: number) => weapon.fireReady({ now, sprinting: false, vaultProgress: 1 });
  assert.deepEqual(weapon.step(frame(1, { reload: true }), context(start)), [{ type: 'reload', weapon: 'breaker12', empty: true }]);
  const firstShell = start + spec.shellStartMs! + spec.perShellMs!;
  assert.equal(weapon.state.reloadingUntil, start + spec.shellStartMs! + spec.perShellMs! * 6, 'An empty pump takes 3 s to fill');
  assert.equal(ready(start + 400), false, 'No shell yet: the reload holds the trigger');
  assert.equal(ready(firstShell - 1), false);
  assert.equal(ready(firstShell), true, 'A shell due now goes in before the tick reads the trigger');
  let seq = 2, now = start;
  while (weapon.state.mag[0] === 0) { now += TICK; weapon.step(frame(seq++), context(now)); }
  assert.ok(now < start + 900 && weapon.state.reloadSlot === 1, 'The first shell is in about 0.8 s into the reload');
  assert.equal(ready(now), true, 'Only the interruptible reload stands in the way, so the trigger is ready');
  assert.ok(weapon.step(frame(seq++, { fire: true }), context(now + TICK)).some(event => event.type === 'shot'), 'and a pull fires');
  assert.equal(weapon.state.reloadSlot, 0);
  const stillBlocked = armed(loadout, { mag: [2, 12], readyAt: start + 5_000 });
  stillBlocked.step(frame(1, { reload: true }), context(start));
  assert.equal(stillBlocked.fireReady({ now: start + 100, sprinting: false, vaultProgress: 1 }), false, 'Other blocks still apply');
  const carbine = armed(plain, { mag: [10, 12] });
  carbine.step(frame(1, { reload: true }), context(start));
  assert.equal(carbine.fireReady({ now: start + 100, sprinting: false, vaultProgress: 1 }), false, 'A magazine reload is never interrupted');
});

test('a swap waits for the new weapon to raise (25% faster with Quick Hands) and cancels a reload', () => {
  for (const [loadout, factor] of [[plain, 1], [quick, QUICK_HANDS_FACTOR]] as const) {
    const weapon = armed(loadout, { mag: [20, 12] }), start = 40_000, raise = WEAPONS.sentry9.raiseMs * factor;
    weapon.step(frame(1, { reload: true }), context(start));
    const swap = weapon.step(frame(2, { slot: 2 }), context(start + 100));
    assert.deepEqual(swap, [{ type: 'swap', weapon: 'sentry9' }]);
    assert.equal(weapon.state.reloadSlot, 0, 'Swapping cancels the reload');
    assert.equal(weapon.state.readyAt, start + 100 + raise);
    assert.deepEqual(weapon.step(frame(3, { slot: 2, fire: true }), context(start + 100 + raise - 1)), []);
    weapon.step(frame(4, { slot: 2 }), context(start + 100 + raise));
    assert.ok(weapon.step(frame(5, { slot: 2, fire: true }), context(start + 100 + raise + 1)).some(event => event.type === 'shot'));
    assert.ok(weapon.raise(start + 100 + raise / 2) > 0.45 && weapon.raise(start + 100 + raise / 2) < 0.55);
  }
});

test('firing waits the sprint-to-fire time after a sprint and 1.4 times that after a dash', () => {
  for (const dashed of [false, true]) {
    const weapon = armed(plain);
    const run = drive(weapon, 30, tick => ({ fire: tick >= 5 }), 50_000, tick => ({ sprinting: tick < 5, dashing: dashed && tick < 5 }));
    const first = shotTicks(run)[0]!;
    const wait = WEAPONS.kr5.sprintToFireMs * (dashed ? DASH_SPRINT_TO_FIRE : 1);
    // Timed from the last tick spent sprinting (tick 4), as on the server.
    assert.equal(first, 4 + Math.ceil(wait / TICK), dashed ? 'after a dash' : 'after a sprint');
  }
  const sprinting = armed(plain);
  assert.equal(shotTicks(drive(sprinting, 10, tick => ({ fire: tick > 0 }), 0, () => ({ sprinting: true }))).length, 0, 'No shots while still sprinting');
});

test('a vault blocks fire until 70%, and cooking or knifing block it until they end', () => {
  const vault = armed(plain);
  assert.deepEqual(vault.step(frame(1, { fire: true }), context(1_000, { vaultProgress: VAULT_FIRE_PROGRESS - 0.01 })), []);
  assert.ok(vault.step(frame(2, { fire: true }), context(1_033, { vaultProgress: VAULT_FIRE_PROGRESS })).some(event => event.type === 'shot'));
  const cook = armed(plain), start = 60_000;
  assert.deepEqual(cook.step(frame(1, { grenade: true }), context(start)), [{ type: 'cook' }]);
  assert.equal(cook.state.frags, spawnFrags(plain) - 1, 'The frag leaves the belt when the cook starts');
  assert.equal(cook.cook(start + EXPLOSIVES.frag.fuseMs / 2), 0.5);
  assert.deepEqual(cook.step(frame(2, { grenade: true, fire: true }), context(start + 33)), []);
  assert.deepEqual(cook.step(frame(3, { fire: false }), context(start + 66)), [{ type: 'throw', inHand: false }]);
  assert.equal(cook.state.frags, spawnFrags(plain) - 1); assert.equal(cook.cook(start + 70), -1);
  const held = armed(plain);
  held.step(frame(1, { grenade: true }), context(start));
  assert.deepEqual(held.step(frame(2, { grenade: true }), context(start + EXPLOSIVES.frag.fuseMs)), [{ type: 'throw', inHand: true }], 'The fuse runs out in hand');
  const knife = armed(plain);
  assert.deepEqual(knife.step(frame(1, { melee: true }), context(start)), [{ type: 'melee' }]);
  assert.equal(knife.state.meleeUntil, start + RULES.meleeMs);
  assert.deepEqual(knife.step(frame(2, { fire: true }), context(start + RULES.meleeMs - 1)), []);
  assert.deepEqual(knife.step(frame(3, { melee: true }), context(start + 100)), [], 'Holding the knife key does not swing again');
  assert.ok(knife.step(frame(4, { fire: true }), context(start + RULES.meleeMs)).some(event => event.type === 'shot'));
  const dead = armed(plain);
  assert.deepEqual(dead.step(frame(1, { fire: true }), context(1_000, { alive: false })), []);
});

test('recoil climbs repeatably from the first shot to the sustained kick, drifts by the pattern and shrinks while aimed', () => {
  const spec = WEAPONS.kr5, r = spec.recoil;
  assert.deepEqual(recoilKick(spec, 0, 0), { yaw: r.horizontal * r.pattern[0]!, pitch: r.vertical[0] });
  assert.ok(Math.abs(recoilKick(spec, r.ramp, 0).pitch - r.vertical[1]) < 1e-12);
  assert.ok(Math.abs(recoilKick(spec, 40, 0).pitch - r.vertical[1]) < 1e-12);
  for (let shot = 1; shot <= r.ramp; shot++) assert.ok(recoilKick(spec, shot, 0).pitch >= recoilKick(spec, shot - 1, 0).pitch);
  assert.equal(recoilKick(spec, r.pattern.length + 2, 0).yaw, recoilKick(spec, 2, 0).yaw, 'The drift pattern repeats');
  const aimed = recoilKick(spec, 3, 1), hip = recoilKick(spec, 3, 0);
  assert.ok(Math.abs(aimed.pitch - hip.pitch * r.adsFactor) < 1e-12); assert.ok(Math.abs(aimed.yaw - hip.yaw * r.adsFactor) < 1e-12);
  const weapon = armed(plain);
  const kicks = drive(weapon, 12, () => ({ fire: true })).events.flat().flatMap(event => event.type === 'shot' ? [event] : []);
  assert.deepEqual(kicks.map(event => event.burst), kicks.map((_, index) => index), 'Each shot of a pull counts up the burst');
  assert.deepEqual(kicks.map(event => event.kick), kicks.map((_, index) => recoilKick(spec, index, 0)));
});

test('recovery returns its share of the climb after release but never pulls below where the burst began', () => {
  const recovery = new RecoilRecovery();
  let pitch = 0.1;
  for (let i = 0; i < 3; i++) { recovery.kick({ yaw: 0.002, pitch: 0.01 }, pitch); pitch += 0.01; }
  recovery.release(0.6);
  let returned = 0, yaw = 0;
  for (let i = 0; i < 120; i++) { const step = recovery.update(1 / 60, pitch); pitch += step.pitch; returned -= step.pitch; yaw += step.yaw; }
  assert.ok(Math.abs(returned - 0.018) < 1e-4, `returned ${returned}`); assert.ok(Math.abs(yaw + 0.0036) < 1e-4);
  assert.equal(recovery.pending, 0);
  const compensated = new RecoilRecovery();
  compensated.kick({ yaw: 0, pitch: 0.03 }, 0.2); compensated.release(0.9);
  const step = compensated.update(1, 0.19);
  assert.equal(step.pitch, -0, 'A player who already pulled below the start is left alone');
});

test('shots travel along the crosshair; shotgun pellets keep their fixed pattern around it, tighter when aimed', () => {
  const yaw = 0.7, pitch = -0.1, forward = directionFromAngles(yaw, pitch);
  assert.deepEqual(shotDirections(WEAPONS.kr5, yaw, pitch, 0), [forward]);
  const hip = shotDirections(WEAPONS.breaker12, yaw, pitch, 0), aimed = shotDirections(WEAPONS.breaker12, yaw, pitch, 1);
  assert.equal(hip.length, WEAPONS.breaker12.pellets);
  const angle = (a: { x: number; y: number; z: number }) => Math.acos(Math.min(1, a.x * forward.x + a.y * forward.y + a.z * forward.z));
  assert.ok(angle(hip[0]!) < 1e-7, 'The centre pellet goes where the crosshair points');
  for (const direction of hip) assert.ok(Math.abs(Math.hypot(direction.x, direction.y, direction.z) - 1) < 1e-12);
  assert.ok(Math.abs(angle(hip[1]!) - Math.atan(0.55 * WEAPONS.breaker12.pelletSpread!.hip)) < 1e-9);
  assert.ok(Math.abs(angle(aimed[1]!) - Math.atan(0.55 * WEAPONS.breaker12.pelletSpread!.ads)) < 1e-9);
  assert.ok(angle(aimed[5]!) < angle(hip[5]!), 'Aiming tightens the pattern');
  assert.ok(Math.abs(hip[1]!.y - forward.y) < 1e-3 && Math.abs(hip[3]!.y - forward.y) > 0.01, 'The pattern is laid out in the view, sideways and up');
});

test('a pellet pattern part-way into aiming narrows by the aim progress, as the server blends it', () => {
  const yaw = -0.4, pitch = 0.05, forward = directionFromAngles(yaw, pitch), spread = WEAPONS.breaker12.pelletSpread!;
  const angle = (a: { x: number; y: number; z: number }) => Math.acos(Math.min(1, a.x * forward.x + a.y * forward.y + a.z * forward.z));
  for (const aim of [0.25, 0.5, 0.8]) {
    const pellets = shotDirections(WEAPONS.breaker12, yaw, pitch, aim), cone = spread.hip + (spread.ads - spread.hip) * aim;
    assert.ok(Math.abs(angle(pellets[1]!) - Math.atan(0.55 * cone)) < 1e-9, `aim ${aim}: not the hip or the aimed pattern, but the blend`);
  }
  assert.deepEqual(shotDirections(WEAPONS.breaker12, yaw, pitch, 7), shotDirections(WEAPONS.breaker12, yaw, pitch, 1), 'Progress is clamped');
  assert.deepEqual(shotDirections(WEAPONS.breaker12, yaw, pitch, NaN), shotDirections(WEAPONS.breaker12, yaw, pitch, 0));
});

test('shot events carry the aim progress the server will use: timed from the tick aim went down, faster with Cool Head', () => {
  for (const [loadout, factor] of [[{ ...plain, primary: 'longbow' as const }, 1], [{ ...LOADOUT_PRESETS.marksman }, 0.8]] as const) {
    const spec = WEAPONS.longbow, aimTime = spec.adsMs * factor;
    for (const aimTicks of [0, 3, 6, 9, 20]) {
      const weapon = armed(loadout), start = 90_000;
      // Aim goes down on tick 0 and the trigger is pressed `aimTicks` ticks later.
      const run = drive(weapon, aimTicks + 1, tick => ({ aim: true, fire: tick === aimTicks }), start);
      const shot = run.events.flat().find(event => event.type === 'shot');
      assert.ok(shot && shot.type === 'shot', `${aimTicks} ticks: the press fires`);
      const expected = Math.min(1, aimTicks * TICK / aimTime);
      assert.ok(Math.abs(shot.aim - expected) < 1e-9, `${loadout.perks.join(',')}, ${aimTicks} ticks: aim ${shot.aim} vs ${expected}`);
      assert.equal(shot.at, start + aimTicks * TICK, 'The shot is stamped with its predicted tick time');
      assert.ok(Math.abs(aimProgress(spec, loadout, start, true, start + aimTicks * TICK) - expected) < 1e-9);
    }
  }
  const marksman = { ...plain, primary: 'longbow' as const };
  const hip = drive(armed(marksman), 1, () => ({ fire: true })).events.flat().find(event => event.type === 'shot');
  assert.ok(hip?.type === 'shot' && hip.aim === 0, 'From the hip');
  // Letting go of aim starts the clock again.
  const reaimed = drive(armed(marksman), 12, tick => ({ aim: tick < 6 || tick >= 9, fire: tick === 11 })).events.flat().find(event => event.type === 'shot');
  assert.ok(reaimed?.type === 'shot' && Math.abs(reaimed.aim - 2 * TICK / WEAPONS.longbow.adsMs) < 1e-9, 'Aim restarts when it goes down again');
  assert.equal(aimProgress(WEAPONS.longbow, marksman, 1_000, false, 5_000), 0, 'A frame that is not aiming is a hip shot');
  assert.equal(aimProgress(WEAPONS.longbow, marksman, null, true, 5_000), 0);
});

test('the aim start survives reconciliation, so replayed shots keep their aim progress', () => {
  const loadout = { ...plain, primary: 'longbow' as const }, weapon = armed(loadout), start = 95_000;
  drive(weapon, 4, () => ({ aim: true }), start);
  // The server has processed the first two aimed inputs; the rest are still in flight.
  weapon.reconcile(self(loadout), 2, start + TICK);
  const shot = weapon.step(frame(5, { aim: true, fire: true }), context(start + 4 * TICK)).find(event => event.type === 'shot');
  assert.ok(shot?.type === 'shot' && Math.abs(shot.aim - 4 * TICK / WEAPONS.longbow.adsMs) < 1e-9);
  const dead = armed(loadout);
  dead.step(frame(1, { aim: true }), context(start));
  dead.step(frame(2, { aim: true }), context(start + TICK, { alive: false }));
  const respawned = dead.step(frame(3, { aim: true, fire: true }), context(start + 2 * TICK)).find(event => event.type === 'shot');
  assert.ok(respawned?.type === 'shot' && respawned.aim === 0, 'A life that ended released the aim, as on the server');
});

test('only the Heron 7 rolls a random cone: wide from the hip, none once fully scoped; shotguns and the rest have none', () => {
  assert.equal(shotCone(WEAPONS.longbow, 0), WEAPONS.longbow.hipSpread);
  assert.ok(Math.abs(shotCone(WEAPONS.longbow, 0.5) - WEAPONS.longbow.hipSpread / 2) < 1e-12);
  assert.equal(shotCone(WEAPONS.longbow, 1), 0, 'Fully scoped, the round goes exactly down the crosshair');
  assert.ok(shotCone(WEAPONS.longbow, 0.999) > 0);
  for (const id of ['kr5', 'hornet9', 'breaker12', 'sentry9'] as const) for (const aim of [0, 0.5, 1]) assert.equal(shotCone(WEAPONS[id], aim), 0, id);
  assert.equal(shotCone(WEAPONS.longbow, NaN), WEAPONS.longbow.hipSpread);
});

test('a shot whose tracer is left to the server is matched to its confirmation by weapon and the frame that fired it', () => {
  const tracers = new ServerTracers();
  assert.equal(tracers.take('longbow', 100), false, 'Nothing expected: the tracer was already drawn');
  tracers.expect('longbow', 100);
  assert.equal(tracers.take('kr5', 100), false, 'Another weapon is not that shot');
  assert.equal(tracers.take('longbow', 100), true);
  assert.equal(tracers.take('longbow', 100), false, 'Each expected shot is drawn once');
  // The first predicted round never went off on the server; the second did.
  tracers.expect('longbow', 200); tracers.expect('longbow', 238);
  assert.equal(tracers.take('longbow', 238), true, 'A shot the server never fired falls away');
  assert.equal(tracers.take('longbow', 238), false);
  tracers.expect('longbow', 300);
  assert.equal(tracers.take('longbow', 299), false, 'A confirmation from an earlier frame is not it');
  assert.equal(tracers.take('longbow', undefined), false, 'nor one with no frame');
  assert.equal(tracers.take('longbow', 300), true);
  tracers.expect('longbow', 400); tracers.clear();
  assert.equal(tracers.take('longbow', 400), false);
});

test('a new trigger press, the knife and a cook are judged on the body before the move; the held trigger after it', () => {
  // The press that starts a vault: the server sees no vault yet, although the moved body is at 0%.
  const starting = { vaultProgress: 0, pressVaultProgress: 1, vaultingBefore: false };
  assert.ok(armed(plain).step(frame(1, { fire: true }), context(1_000, starting)).some(event => event.type === 'shot'), 'The jump-and-fire press shoots');
  assert.deepEqual(armed(plain).step(frame(1, { melee: true }), context(1_000, starting)), [{ type: 'melee' }], 'The jump-and-knife press swings');
  assert.deepEqual(armed(plain).step(frame(1, { grenade: true }), context(1_000, starting)), [{ type: 'cook' }], 'The jump-and-cook press cooks');
  // The tick a vault ends: the server still sees the vault, although the moved body is clear of it.
  const ending = { vaultProgress: 1, pressVaultProgress: 1, vaultingBefore: true };
  assert.deepEqual(armed(plain).step(frame(1, { melee: true }), context(1_000, ending)), [], 'No knife while the body starts the tick vaulting');
  const cook = armed(plain);
  assert.deepEqual(cook.step(frame(1, { grenade: true }), context(1_000, ending)), [], 'No cook either');
  assert.equal(cook.state.frags, spawnFrags(plain));
  assert.ok(armed(plain).step(frame(1, { fire: true }), context(1_000, ending)).some(event => event.type === 'shot'), 'A press at the end of the vault fires');
  // Early in a vault on both sides, a held carbine trigger waits for 70% of the moved body's vault.
  const held = armed(plain), early = { vaultProgress: 0.5, pressVaultProgress: 0.4, vaultingBefore: true };
  assert.deepEqual(held.step(frame(1, { fire: true }), context(1_000, early)), []);
  assert.deepEqual(held.step(frame(2, { fire: true }), context(1_033, { ...early, vaultProgress: 0.69, pressVaultProgress: 0.6 })), []);
  assert.ok(held.step(frame(3, { fire: true }), context(1_066, { ...early, vaultProgress: 0.75, pressVaultProgress: 0.69 })).some(event => event.type === 'shot'),
    'The held trigger fires once the moved body is 70% through');
});

test('the server state wins once acknowledged and the inputs still in flight replay silently', () => {
  const weapon = armed(plain), start = 70_000;
  const run = drive(weapon, 6, () => ({ fire: true }), start);
  const shotsAfter = (seq: number) => run.events.slice(seq).flat().filter(event => event.type === 'shot').length;
  const predictedMag = weapon.state.mag[0];
  assert.equal(predictedMag, 30 - shotsAfter(0));
  // The server fired one shot fewer by input 3 and returned a magazine for an elimination.
  const serverMag = 30 - (run.events.slice(0, 3).flat().filter(event => event.type === 'shot').length - 1);
  weapon.reconcile(self(plain, { mag: [serverMag, 12], reserve: [210, 72], lastInputSeq: 3 }), 3, start + 3 * TICK);
  assert.equal(weapon.state.mag[0], serverMag - shotsAfter(3), 'Acknowledged ammo comes from the server, later shots stay predicted');
  assert.equal(weapon.state.reserve[0], 210);
  const before = structuredClone(weapon.state);
  weapon.reconcile(self(plain, { mag: [serverMag, 12], reserve: [210, 72] }), 3, start + 3 * TICK);
  assert.deepEqual(weapon.state, before, 'Reconciling twice with the same snapshot changes nothing');
  weapon.reconcile(self(plain, { mag: [12, 12], reserve: [210, 72], reloadSlot: 1, reloadingUntil: start + 9_000 }), 6, start + 6 * TICK);
  assert.equal(weapon.state.reloadSlot, 1); assert.equal(weapon.state.reloadingUntil, start + 9_000);
  assert.ok(weapon.reloadProgress(start + 9_000 - WEAPONS.kr5.reloadMs / 2) > 0.45);
  weapon.reconcile(self(plain, { slot: 2, weapon: 'sentry9' as WeaponId }), 6, start + 7 * TICK);
  assert.equal(weapon.weapon, 'sentry9'); assert.equal(weapon.state.reloadSlot, 0);
});
