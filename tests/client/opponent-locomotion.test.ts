import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlayerState, WorldSnapshot } from '../../shared/protocol';
import { GameView } from '../../src/game/GameView';
import { LocomotionVelocity } from '../../src/game/LocomotionVelocity';

const actor = (extra: Partial<PlayerState> = {}): PlayerState => ({
  id: 'opponent', name: 'Opponent', color: '#ffffff', x: 0, y: 0, z: 0,
  vx: 0, vy: 0, vz: -6.5, yaw: 0, pitch: 0, health: 100, shield: 50,
  slot: 1, ammoAR: 30, ammoShotgun: 6, heals: 2, kills: 0, deaths: 0,
  connected: true, respawnAt: 0, protectedUntil: 0, healingUntil: 0,
  reloadingUntil: 0, lastInputSeq: 1, ...extra,
});
type Buffered = { world: WorldSnapshot; received: number };
function buffer(rows: Array<[number, PlayerState | null]>): Buffered[] {
  return rows.map(([time, player], index) => ({ received: time,
    world: Object.freeze({ tick: index, serverTime: time, phase: 'playing' as const,
      timeRemaining: 100, winnerIds: [], players: player ? [Object.freeze(player)] : [] }),
  }));
}

// Exercise the actual renderer method without constructing a WebGL renderer or
// DOM. The receiver supplies only the snapshot buffer this method reads.
const interpolate = (GameView.prototype as unknown as {
  opponentState(this: { snapshotBuffer: Buffered[] }, player: PlayerState, now: number): PlayerState;
}).opponentState;
const render = (snapshots: Buffered[], player: PlayerState, now: number) => interpolate.call({ snapshotBuffer: snapshots }, player, now);
const speed = (value: { vx: number; vz: number }) => Math.hypot(value.vx, value.vz);

test('fresh snapshots crossing into a stopped interval preserve the last visible stride then settle', () => {
  const snapshots = buffer(Array.from({ length: 17 }, (_, index) => {
    const time = index * 50;
    return [time, actor({ z: -6.5 * Math.min(time, 150) / 1_000, vz: time >= 150 ? 0 : -6.5 })];
  }));
  const before = structuredClone(snapshots), gait = new LocomotionVelocity();
  const displayed = (now: number) => {
    const available = snapshots.filter(sample => sample.received <= now).slice(-12);
    return render(available, available.at(-1)!.world.players[0]!, now);
  };
  const first = displayed(150);
  gait.update(first, .016, 'remote');
  let last = first, velocity = { vx: 0, vz: 0 }, crossedStaticBoundary = false;
  // 16ms render frames deliberately straddle the 250ms interpolation boundary.
  // At262ms the selected150→200 interval is static, yet the actor still moved
  // 26mm since246ms. An interval-velocity cap would incorrectly force idle.
  for (let now = 166; now <= 790; now += 16) {
    const current = displayed(now), delta = current.z - last.z;
    velocity = { ...gait.update(current, .016, 'remote') };
    if (delta < -1e-9) assert.ok(velocity.vz < -.3, 'every advancing frame retains a moving gait');
    if (now === 262) {
      assert.ok(Math.abs(delta + .026) < 1e-12);
      assert.equal(current.vz, 0, 'latest authoritative input has stopped');
      assert.ok(speed(velocity) > 4, 'the first static interval must not erase preceding visible travel');
      crossedStaticBoundary = true;
    }
    last = current;
  }
  assert.equal(crossedStaticBoundary, true);
  assert.ok(Math.abs(last.z - first.z + .65) < 1e-12);
  assert.ok(speed(velocity) < .001, 'continuing stationary snapshots decay to idle');
  assert.deepEqual(snapshots, before);
});

test('a remote start waits for visible travel while fresh moving snapshots continue arriving', () => {
  const snapshots = buffer(Array.from({ length: 9 }, (_, index) => {
    const time = index * 50;
    return [time, actor({ z: -6.5 * Math.max(0, time - 100) / 1_000, vz: time > 100 ? -6.5 : 0 })];
  }));
  const before = structuredClone(snapshots), gait = new LocomotionVelocity();
  for (let now = 150; now <= 390; now += 16) {
    const available = snapshots.filter(sample => sample.received <= now);
    const displayed = render(available, available.at(-1)!.world.players[0]!, now);
    const velocity = gait.update(displayed, .016, 'remote');
    if (now <= 200) { assert.equal(Math.abs(displayed.z), 0); assert.equal(speed(velocity), 0); }
    else { assert.ok(displayed.z < 0); assert.ok(velocity.vz < 0); }
  }
  assert.deepEqual(snapshots, before);
});

test('same-position intervals stay idle despite nonzero raw wall-push velocity', () => {
  const snapshots = buffer([0, 50, 100, 150].map(time => [time, actor({ vx: 9, vz: 0 })]));
  const newest = snapshots.at(-1)!.world.players[0]!, gait = new LocomotionVelocity();
  for (let now = 150; now <= 300; now += 10) {
    const displayed = render(snapshots, newest, now);
    assert.equal(displayed.vx, 9); assert.equal(displayed.vz, 0);
    assert.equal(speed(gait.update(displayed, .01, 'remote')), 0);
  }
  assert.equal(newest.vx, 9);
});

test('interpolation boundaries remain finite and corrections retain the existing sprint-speed cap', () => {
  const snapshots = buffer([[100, actor({ x: 0, y: 1, yaw: .2, vz: 0 })], [150, actor({ x: 2, y: 1.4, yaw: .8, vz: 0 })]]);
  const newest = snapshots.at(-1)!.world.players[0]!, gait = new LocomotionVelocity();
  const early = render(snapshots, newest, 150);
  assert.equal(early.x, 0); assert.equal(early.vx, 0);
  assert.ok(Math.abs(render(snapshots, newest, 225).y - 1.2) < 1e-12, 'position height stays independent of heading');
  gait.update(render(snapshots, newest, 200), .01, 'remote');
  for (let now = 210; now <= 250; now += 10) {
    const displayed = render(snapshots, newest, now), velocity = gait.update(displayed, .01, 'remote');
    assert.equal(displayed.vx, 0, 'raw state remains untouched even during a visible correction');
    assert.ok(Number.isFinite(speed(velocity)) && speed(velocity) > 0 && speed(velocity) <= 9);
  }
  assert.equal(render(snapshots, newest, 260).x, 2, 'newest position is held after its endpoint');
});

test('missing, dead, invalid-time and teleport intervals preserve direct-state fallback without mutation', () => {
  const newest = actor({ x: 1, vz: 0 });
  const fixtures = [
    buffer([[100, newest]]),
    buffer([[0, null], [100, newest]]),
    buffer([[0, actor({ health: 0 })], [100, newest]]),
    buffer([[100, actor()], [100, newest]]),
    buffer([[0, actor({ x: NaN })], [100, newest]]),
    buffer([[NaN, actor()], [100, newest]]),
    buffer([[0, actor({ x: -10 })], [100, newest]]),
  ];
  for (const snapshots of fixtures) {
    const before = structuredClone(snapshots);
    assert.equal(render(snapshots, newest, 100), newest);
    assert.deepEqual(snapshots, before);
  }
  const gait = new LocomotionVelocity();
  gait.update(actor({ x: -10 }), .01, 'remote');
  const teleport = render(fixtures.at(-1)!, newest, 100);
  assert.equal(speed(gait.update(teleport, .01, 'remote')), 0, 'a teleport cannot become a running stride');
});
