import test from 'node:test';
import assert from 'node:assert/strict';
import { TickSchedule } from '../../server/app.js';

const TICK = 1000 / 30;

/** Fires the schedule's timer the way a real one does, `late` ms after each requested wait, for `seconds`. */
function run(schedule: TickSchedule, start: number, seconds: number, late: (wake: number) => number) {
  const ticks: number[] = [];
  let wall = start;
  for (let wake = 0; wall < start + seconds * 1000; wake++) { wall += schedule.wait(wall) + late(wake); ticks.push(...schedule.due(wall)); }
  return { ticks, wall };
}

test('ticks keep an exact 30 Hz schedule however late the timer fires', () => {
  // Node's own lateness (0-3 ms), and Windows' 15.6 ms timer grain (a 33 ms wait becomes 46.8 ms).
  const models: Array<[string, (wake: number) => number]> = [
    ['on time', () => 0], ['0-3 ms late', wake => (wake * 7919 % 31) / 10], ['15.6 ms grain', wake => (wake % 3 ? 13.8 : 0)],
  ];
  for (const [name, late] of models) {
    const { ticks, wall } = run(new TickSchedule(1000), 1000, 10, late);
    for (let i = 1; i < ticks.length; i++) assert.ok(Math.abs(ticks[i]! - ticks[i - 1]! - TICK) < 1e-6, `${name}: tick ${i} came ${ticks[i]! - ticks[i - 1]!} ms after the one before`);
    assert.ok(Math.abs(ticks.length - (wall - 1000) / TICK) <= 1, `${name}: ${ticks.length} ticks in ${wall - 1000} ms`);
    // setInterval(…, 1000 / 30) would run every 33 ms plus lateness: 30.1-30.3 ticks a second, more ticks than frames.
    assert.ok(ticks.length <= 301, `${name}: no more than 30 a second`);
  }
});

test('after a long pause, or a wall clock that jumps, the schedule starts afresh instead of racing or stalling', () => {
  const schedule = new TickSchedule(1000);
  assert.deepEqual(schedule.due(1000 + TICK / 2), []);
  assert.equal(schedule.due(1000 + TICK).length, 1);
  // Two ticks late (a slow tick): both still run, on their own times.
  const late = schedule.due(1000 + 3 * TICK + 5);
  assert.equal(late.length, 2); assert.ok(Math.abs(late[1]! - (1000 + 3 * TICK)) < 1e-6);
  // A second's pause (a suspended laptop, a long garbage collection): one tick now, then on from there.
  const resumed = schedule.due(3000);
  assert.deepEqual(resumed, [3000]);
  assert.equal(schedule.wait(3000), Math.ceil(TICK));
  // The wall clock set back five seconds: the next tick is not five seconds away.
  assert.deepEqual(schedule.due(-2000), [-2000]);
  assert.ok(schedule.wait(-2000) <= Math.ceil(TICK));
});
