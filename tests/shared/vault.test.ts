import test from 'node:test';
import assert from 'node:assert/strict';
import { findVault, MOVE, POSTURE_HEIGHT, spaceFree, vaultFireProgress, type MoveState } from '../../shared/physics.js';
import type { VaultState } from '../../shared/protocol.js';
import { Driver, FACE, frame, player, speedOf, TICK_MS } from './support.js';

const at = (x: number, y: number, z: number, patch: Partial<MoveState> = {}) => player(x, z, { y, ...patch });
const vaultFrom = (state: MoveState, yaw: number, now = 0) => findVault(state, frame({ moveZ: 1, yaw }), now);
const forwardOf = (yaw: number) => ({ x: Math.sin(yaw), z: -Math.cos(yaw) });
interface Case { name: string; state: MoveState; yaw: number }

const positives: Case[] = [];
for (const side of [-1, 1]) {
  const house = side < 0 ? 'teal' : 'yellow';
  const toHouse = side < 0 ? FACE.west : FACE.east, toStreet = side < 0 ? FACE.east : FACE.west, outward = toHouse;
  // The front windows are the only downstairs windows: sill 0.95 m, opening z 1.0..4.7 at x ±10.
  for (const z of [1.5, 2.85, 4.2]) {
    positives.push({ name: `${house} front window from the street, z ${z}`, state: at(side * 9.3, 0, z), yaw: toHouse });
    positives.push({ name: `${house} front window from inside, z ${z}`, state: at(side * 10.7, 0, z), yaw: toStreet });
  }
  positives.push({ name: `${house} balcony back rail`, state: at(side * 25.4, 3.2, 4.4), yaw: outward });
  positives.push({ name: `${house} balcony side rail`, state: at(side * 24.1, 3.2, 5.2), yaw: FACE.south });
  positives.push({ name: `${house} side yard fence (1.64 m) from the yard`, state: at(side * 24.5, 0, -11.2), yaw: FACE.south });
  positives.push({ name: `${house} side yard fence (1.64 m) from the house`, state: at(side * 24.5, 0, -9.8), yaw: FACE.north });
  positives.push({ name: `${house} yard sandbags`, state: at(side * 25.6, 0, 8.6), yaw: outward });
}
positives.push(
  { name: 'west lane sandbags', state: at(-7, 0, -12), yaw: FACE.north },
  { name: 'east lane sandbags', state: at(7, 0, 12), yaw: FACE.south },
  { name: 'north centre sandbags', state: at(0.5, 0, -13.5), yaw: FACE.north },
  { name: 'south centre sandbags', state: at(0.6, 0, 13), yaw: FACE.south },
  { name: 'west lane barrier', state: at(-6.6, 0, 8.65), yaw: FACE.south },
  { name: 'east lane barrier', state: at(6.6, 0, -8.65), yaw: FACE.north },
  { name: 'left cargo crate, from the truck floor', state: at(1.7, 0.36, 4.32), yaw: FACE.north },
  { name: 'right cargo crate, from the truck floor', state: at(3.4, 0.36, 4.72), yaw: FACE.north },
  { name: 'mail crates', state: at(-4.8, 0, -15.35), yaw: FACE.north },
  { name: 'bus hood from the street', state: at(-2.4, 0, -11.45), yaw: FACE.south },
  { name: 'bus roof from the bus hood', state: at(-2.4, 1.45, -10), yaw: FACE.south },
);

const negatives: Case[] = [
  { name: 'teal front wall beside the door', state: at(-9.3, 0, -4.5), yaw: FACE.west },
  { name: 'yellow front wall beside the door', state: at(9.3, 0, -4.5), yaw: FACE.east },
  { name: 'window frame edge (body would not fit)', state: at(-9.3, 0, 1.2), yaw: FACE.west },
  { name: 'teal house north wall', state: at(-16, 0, -6.7), yaw: FACE.south },
  { name: 'bus side from the street', state: at(-4.5, 0, -5), yaw: FACE.east },
  { name: 'truck cab from the street', state: at(2.65, 0, -0.7), yaw: FACE.south },
  { name: 'teal shed (2.6 m)', state: at(-25.3, 0, 16), yaw: FACE.west },
  { name: 'north boundary fence (2.6 m)', state: at(0, 0, -22.3), yaw: FACE.north },
  { name: 'south boundary fence (2.6 m)', state: at(-12, 0, 22.3), yaw: FACE.south },
  { name: 'yellow back yard fence (2.6 m)', state: at(30.3, 0, 0), yaw: FACE.east },
  { name: 'teal back yard fence (2.6 m)', state: at(-30.3, 0, -5), yaw: FACE.west },
  { name: 'truck side wall from a crate, under the truck roof', state: at(1.7, 1.16, 3.3), yaw: FACE.west },
  { name: 'truck front wall from a crate, under the truck roof', state: at(1.7, 1.16, 3.3), yaw: FACE.north },
  { name: 'truck side wall from the cargo floor', state: at(1.5, 0.36, 7), yaw: FACE.west },
  // A jump does not stretch the 2.1 m limit: the rise counts from the floor below.
  { name: 'shed at the top of a jump', state: at(-25.3, 0.9, 16), yaw: FACE.west },
  { name: 'boundary fence at the top of a jump', state: at(0, 0.9, -22.3), yaw: FACE.north },
  { name: 'truck cab at the top of a jump', state: at(2.65, 0.9, -0.7), yaw: FACE.south },
];

test('every listed vault spot starts a vault that lands somewhere the body fits', () => {
  for (const { name, state, yaw } of positives) {
    assert.ok(spaceFree(state, POSTURE_HEIGHT.stand), `${name}: start position is valid`);
    const vault = vaultFrom(state, yaw, 1000);
    assert.ok(vault, `${name}: vault expected`);
    const forward = forwardOf(yaw);
    const travel = (vault.toX - vault.fromX) * forward.x + (vault.toZ - vault.fromZ) * forward.z;
    assert.ok(travel > 0.3, `${name}: moves forward (${travel.toFixed(2)} m)`);
    const climb = vault.toY - vault.fromY;
    assert.ok(climb >= MOVE.vaultMin - 1e-9 && climb <= MOVE.vaultMax + 0.03, `${name}: climb ${climb.toFixed(2)} m`);
    assert.ok(spaceFree({ x: vault.toX, y: vault.toY, z: vault.toZ }, POSTURE_HEIGHT.vault), `${name}: destination fits`);
    assert.equal(vault.start, 1000);
    // 0.25 s + 0.15 s per metre climbed (an over-vault ends 2 cm above the top: 3 ms).
    const timing = vault.end - vault.start - (MOVE.vaultBaseMs + MOVE.vaultPerMeterMs * climb);
    assert.ok(timing <= 1e-6 && timing > -3.1, `${name}: timing off by ${timing} ms`);
    assert.equal(vault.exitYaw, yaw);
  }
});

test('walls, 2.6 m fences and spots under the truck roof cannot be vaulted', () => {
  for (const { name, state, yaw } of negatives) {
    assert.ok(spaceFree(state, POSTURE_HEIGHT.stand), `${name}: start position is valid`);
    assert.equal(vaultFrom(state, yaw), null, name);
  }
});

test('vaults need forward input and are not started while already vaulting', () => {
  const sill = at(-9.3, 0, 2.85);
  assert.equal(findVault(sill, frame({ moveZ: 0, yaw: FACE.west }), 0), null);
  assert.equal(findVault(sill, frame({ moveZ: 0.2, yaw: FACE.west }), 0), null);
  assert.equal(findVault({ ...sill, posture: 'vault' }, frame({ moveZ: 1, yaw: FACE.west }), 0), null);
  assert.equal(findVault(sill, frame({ moveZ: 1, yaw: Number.NaN }), 0), null);
  assert.ok(findVault(sill, frame({ moveZ: 1, yaw: FACE.west }), 0));
});

test('vault timing is 0.25 s plus 0.15 s per metre and keeps momentum', () => {
  const still = vaultFrom(at(-9.3, 0, 2.85), FACE.west, 0)!;
  assert.ok(Math.abs(still.end - still.start - (MOVE.vaultBaseMs + MOVE.vaultPerMeterMs * 0.95)) < 1e-6);
  assert.equal(still.exitSpeed, MOVE.vaultMinExitSpeed, 'standing start exits at the minimum');
  const running = vaultFrom(at(-9.3, 0, 2.85, { vx: -6.9 }), FACE.west, 0)!;
  assert.ok(Math.abs(running.exitSpeed - 6.9 * 0.95) < 1e-9, 'sprinting start keeps 95%');
  const dashing = vaultFrom(at(-9.3, 0, 2.85, { vx: -12 }), FACE.west, 0)!;
  assert.equal(dashing.exitSpeed, MOVE.dash, 'capped at dash speed');
});

test('a sprint through the front window vaults inside and keeps going', () => {
  const run = new Driver(at(-8, 0, 1.6));
  const forward = { moveZ: 1, yaw: FACE.west, sprint: true };
  run.until(state => state.x <= -9.44 + 0.6, forward, 30);
  const start = run.step({ ...forward, jump: true });
  assert.equal(start.vaultStarted, true);
  assert.equal(run.state.posture, 'vault');
  const end = run.until((_, events) => events.vaultEnded, forward, 30);
  assert.equal(end.vaultEnded, true);
  assert.ok(run.state.x < -10.14 - 0.42, 'inside the house');
  assert.equal(run.state.posture, 'stand');
  assert.ok(Math.abs(speedOf(run.state) - 6.9 * 0.95) < 1e-6 && run.state.vx < 0, 'momentum kept toward the house');
  run.until((_, events) => events.landedSpeed > 0, forward, 30);
  assert.equal(run.state.y, 0);
});

test('holding jump in the air mantles a ledge in reach', () => {
  // Jump early toward the 1.4 m mail crates and keep jump held: the mantle starts in the air.
  const run = new Driver(at(-4.8, 0, -14));
  run.steps(4, { moveZ: 1, yaw: FACE.north });
  const jump = run.step({ moveZ: 1, yaw: FACE.north, jump: true });
  assert.equal(jump.jumped, true, 'too far for a vault: an ordinary jump');
  const vault = run.until((_, events) => events.vaultStarted, { moveZ: 1, yaw: FACE.north, jump: true }, 15);
  assert.equal(vault.vaultStarted, true);
  run.until((_, events) => events.vaultEnded, { moveZ: 1, yaw: FACE.north, jump: true }, 30);
  assert.ok(Math.abs(run.state.y - 1.4) < 1e-9, 'standing on the crates');
  // Without holding jump the same approach just bumps into the crates.
  const tap = new Driver(at(-4.8, 0, -14));
  tap.steps(4, { moveZ: 1, yaw: FACE.north });
  tap.step({ moveZ: 1, yaw: FACE.north, jump: true });
  const events = tap.steps(25, { moveZ: 1, yaw: FACE.north });
  assert.ok(!events.some(e => e.vaultStarted));
  assert.equal(tap.state.y, 0);
});

test('a jump next to a 2.6 m wall never mantles it', () => {
  const run = new Driver(at(-25.3, 0, 16));
  run.step({ moveZ: 1, yaw: FACE.west, jump: true });
  const events = run.steps(25, { moveZ: 1, yaw: FACE.west, jump: true });
  assert.ok(!events.some(e => e.vaultStarted));
  assert.equal(run.state.y, 0);
});

test('moving sideways steers the crossing point up to 0.25 m', () => {
  const vaultWith = (moveX: number) => {
    const run = new Driver(at(-7, 0, -12));
    run.step({ moveZ: 1, moveX, yaw: FACE.north, jump: true });
    run.until((_, events) => events.vaultEnded, { moveZ: 1, moveX, yaw: FACE.north }, 30);
    return run.state;
  };
  const straight = vaultWith(0), right = vaultWith(1), left = vaultWith(-1);
  assert.ok(Math.abs(right.x - straight.x - MOVE.vaultSteer) < 1e-6, `right ${right.x - straight.x}`);
  assert.ok(Math.abs(left.x - straight.x + MOVE.vaultSteer) < 1e-6, `left ${left.x - straight.x}`);
  assert.ok(Math.abs(right.z - straight.z) < 1e-6 && Math.abs(right.y - straight.y) < 1e-9);
});

test('steering stops where the shifted landing would not fit', () => {
  // Inside the truck, steering left off the crate would push the body into the cargo wall.
  const run = new Driver(at(1.6, 0.36, 4.32));
  run.step({ moveZ: 1, moveX: -1, yaw: FACE.north, jump: true });
  assert.equal(run.state.posture, 'vault');
  run.until((_, events) => events.vaultEnded, { moveZ: 1, moveX: -1, yaw: FACE.north }, 30);
  assert.ok(spaceFree(run.state, POSTURE_HEIGHT.vault), 'never ends inside the wall');
  assert.ok(run.state.x >= 1.02 + 0.42 - 1e-9);
  assert.ok(run.state.x < 1.6 - 0.05, 'steered as far as it fits');
});

test('pressing crouch in the first 40% cancels back to the start with zero velocity', () => {
  const run = new Driver(at(-7, 0, -12, { vz: -3 }));
  run.step({ moveZ: 1, yaw: FACE.north, jump: true });
  const vault = run.state.vault!;
  run.steps(2, { moveZ: 1, yaw: FACE.north });
  assert.ok((run.now + TICK_MS - vault.start) / (vault.end - vault.start) < MOVE.vaultCancelWindow);
  const cancel = run.step({ moveZ: 1, yaw: FACE.north, crouch: true });
  assert.equal(cancel.vaultCancelled, true); assert.equal(cancel.vaultEnded, true);
  assert.equal(run.state.vault, null);
  assert.deepEqual({ x: run.state.x, y: run.state.y, z: run.state.z }, { x: vault.fromX, y: vault.fromY, z: vault.fromZ });
  assert.deepEqual({ vx: run.state.vx, vy: run.state.vy, vz: run.state.vz }, { vx: 0, vy: 0, vz: 0 });
  assert.equal(run.state.posture, 'crouch');
  // Later in the vault a crouch press does not cancel.
  const late = new Driver(at(-7, 0, -12));
  late.step({ moveZ: 1, yaw: FACE.north, jump: true });
  late.steps(6, { moveZ: 1, yaw: FACE.north });
  const lateVault = late.state.vault!;
  assert.ok((late.now + TICK_MS - lateVault.start) / (lateVault.end - lateVault.start) > MOVE.vaultCancelWindow);
  const pressed = late.step({ moveZ: 1, yaw: FACE.north, crouch: true });
  assert.equal(pressed.vaultCancelled, false);
  assert.ok(late.state.vault, 'still vaulting');
  late.until((_, events) => events.vaultEnded, { moveZ: 1, yaw: FACE.north, crouch: true }, 30);
  assert.equal(late.state.posture, 'crouch', 'too slow to slide; crouched on top');
});

test('vaultFireProgress is 1 when not vaulting and passes 0.7 at 70% of the vault', () => {
  const vault: VaultState = { fromX: 0, fromY: 0, fromZ: 0, toX: 0, toY: 1, toZ: -1, start: 1000, end: 1400, exitSpeed: 3.5, exitYaw: 0 };
  assert.equal(vaultFireProgress({ vault: null }, 5000), 1);
  assert.equal(vaultFireProgress({ vault }, 900), 0);
  assert.equal(vaultFireProgress({ vault }, 1000), 0);
  assert.equal(vaultFireProgress({ vault }, 1200), 0.5);
  assert.ok(Math.abs(vaultFireProgress({ vault }, 1280) - MOVE.vaultFireAt) < 1e-9);
  assert.equal(vaultFireProgress({ vault }, 1400), 1);
  assert.equal(vaultFireProgress({ vault }, 9000), 1);
  assert.equal(vaultFireProgress({ vault }, Number.NaN), 0, 'unknown time blocks firing');
  assert.equal(vaultFireProgress({ vault: { ...vault, end: 1000 } }, 1000), 1, 'zero-length vault');
  // Through a real vault the progress rises steadily and reaches 1 when it ends.
  const run = new Driver(at(-7, 0, -12));
  run.step({ moveZ: 1, yaw: FACE.north, jump: true });
  let last = vaultFireProgress(run.state, run.now), sawFireable = false;
  while (run.state.vault) {
    const events = run.step({ moveZ: 1, yaw: FACE.north });
    const progress = vaultFireProgress(run.state, run.now);
    assert.ok(progress >= last); last = progress;
    if (run.state.vault && progress >= MOVE.vaultFireAt) sawFireable = true;
    if (events.vaultEnded) assert.equal(progress, 1);
  }
  assert.ok(sawFireable, 'firing opens before the vault ends');
});

test('holding crouch through a fast mantle chains into a slide', () => {
  const run = new Driver(at(-4.8, 0, -10));
  const forward = { moveZ: 1, yaw: FACE.north, sprint: true };
  run.until(state => state.z <= -15.48 + 0.6, forward, 40);
  assert.equal(run.step({ ...forward, jump: true }).vaultStarted, true);
  const vault = run.state.vault!;
  run.until(() => (run.now + TICK_MS - vault.start) / (vault.end - vault.start) > MOVE.vaultCancelWindow, forward, 20);
  const end = run.until((_, events) => events.vaultEnded, { ...forward, crouch: true }, 30);
  assert.equal(end.slideStarted, true);
  assert.equal(run.state.posture, 'slide');
  assert.ok(Math.abs(run.state.y - 1.4) < 1e-9);
});

test('a jump press during a slide vaults cover in reach', () => {
  const run = new Driver(at(-7, 0, -4));
  run.steps(30, { moveZ: 1, yaw: FACE.north, sprint: true });
  assert.equal(run.step({ moveZ: 1, yaw: FACE.north, sprint: true, crouch: true }).slideStarted, true);
  run.until(state => state.z <= -12.13 + 0.6, { moveZ: 1, yaw: FACE.north, crouch: true }, 30);
  assert.equal(run.state.posture, 'slide');
  const events = run.step({ moveZ: 1, yaw: FACE.north, crouch: true, jump: true });
  assert.equal(events.vaultStarted, true); assert.equal(events.slideEnded, true);
  assert.equal(run.state.posture, 'vault');
});

test('vaulting thin cover lands on the far side', () => {
  const run = new Driver(at(-6.6, 0, 7.6));
  run.until(state => state.z >= 9.2 - 0.42 - 0.5, { moveZ: 1, yaw: FACE.south }, 30);
  assert.equal(run.step({ moveZ: 1, yaw: FACE.south, jump: true }).vaultStarted, true);
  run.until((_, events) => events.vaultEnded, { moveZ: 1, yaw: FACE.south }, 30);
  run.until((_, events) => events.landedSpeed > 0 || run.state.y === 0, { moveZ: 1, yaw: FACE.south }, 30);
  assert.ok(run.state.z > 9.8 + 0.42, 'beyond the barrier');
  assert.equal(run.state.y, 0);
});
