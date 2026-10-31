import { movePlayer, moveDefaults, type MoveContext, type MoveEvents, type MoveState } from '../../shared/physics.js';
import { OBSTACLES, type MapObstacle } from '../../shared/map.js';
import type { InputFrame } from '../../shared/protocol.js';

/** Shared helpers for the physics suites. Not a test file itself. */
export const TICK_MS = 1000 / 30;
export const frame = (patch: Partial<InputFrame> = {}): InputFrame => ({
  seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, fire: false, aim: false, jump: false, sprint: false, reload: false, slot: 1,
  crouch: false, dash: false, melee: false, grenade: false, streak: null, viewTime: 0, ...patch,
});
export const context = (now: number, patch: Partial<MoveContext> = {}): MoveContext => ({
  now, dt: 1 / 30, jumpPressed: false, crouchPressed: false, moveFactor: 1, adsFactor: 0.52, canSprint: true, ...patch,
});
export const player = (x: number, z: number, patch: Partial<MoveState> = {}): MoveState => ({
  x, y: 0, z, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, ...moveDefaults(), ...patch,
});
export const speedOf = (state: { vx: number; vz: number }) => Math.hypot(state.vx, state.vz);
/** View yaw that faces a world direction. Forward is (sin yaw, 0, -cos yaw): north is -z, east is +x. */
export const FACE = { north: 0, east: Math.PI / 2, south: Math.PI, west: -Math.PI / 2 } as const;
/** Open street spots: a lane along z at x = -9 (clear from z -22 to 22) and a square around (-7, 0). */
export const LANE_X = -9;
export const OPEN = { x: -7, z: 0 } as const;

export interface Tick { input: InputFrame; ctx: MoveContext; events: MoveEvents; after: MoveState }

/** Drives one player like the server does: 30 Hz ticks, rising edges from the previous accepted input. */
export class Driver {
  now: number;
  previous: InputFrame = frame();
  readonly log: Tick[] = [];
  constructor(readonly state: MoveState, start = 0, readonly factors: Partial<MoveContext> = {}) { this.now = start; }
  step(patch: Partial<InputFrame> = {}, ctxPatch: Partial<MoveContext> = {}): MoveEvents {
    const input = frame({ seq: this.previous.seq + 1, ...patch });
    this.now += TICK_MS;
    const ctx = context(this.now, {
      jumpPressed: input.jump && !this.previous.jump, crouchPressed: input.crouch && !this.previous.crouch, ...this.factors, ...ctxPatch,
    });
    const events = movePlayer(this.state, input, ctx);
    this.previous = input;
    this.log.push({ input, ctx, events, after: clone(this.state) });
    return events;
  }
  steps(count: number, patch: Partial<InputFrame> = {}, ctxPatch: Partial<MoveContext> = {}): MoveEvents[] {
    const events: MoveEvents[] = [];
    for (let i = 0; i < count; i++) events.push(this.step(patch, ctxPatch));
    return events;
  }
  /** Steps until `done` holds after a tick (checked after each step); fails after `limit` ticks. */
  until(done: (state: MoveState, events: MoveEvents) => boolean, patch: Partial<InputFrame> | ((state: MoveState) => Partial<InputFrame>) = {}, limit = 300): MoveEvents {
    for (let i = 0; i < limit; i++) {
      const events = this.step(typeof patch === 'function' ? patch(this.state) : patch);
      if (done(this.state, events)) return events;
    }
    throw new Error(`condition not reached within ${limit} ticks; state ${JSON.stringify(this.state)}`);
  }
}

export function clone<T>(value: T): T { return structuredClone(value); }

/** Rounds like a snapshot: positions 3 decimals, angles 4, times whole milliseconds. */
export function snapshotOf(state: MoveState): MoveState {
  const r = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
  const copy = clone(state);
  for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'stamina'] as const) copy[key] = r(copy[key], 3);
  copy.yaw = r(copy.yaw, 4); copy.pitch = r(copy.pitch, 4);
  copy.slideUntil = Math.round(copy.slideUntil); copy.slideCooldownUntil = Math.round(copy.slideCooldownUntil);
  if (copy.vault) {
    const v = copy.vault;
    copy.vault = { ...v, fromX: r(v.fromX, 3), fromY: r(v.fromY, 3), fromZ: r(v.fromZ, 3), toX: r(v.toX, 3), toY: r(v.toY, 3), toZ: r(v.toZ, 3),
      start: Math.round(v.start), end: Math.round(v.end), exitSpeed: r(v.exitSpeed, 3), exitYaw: r(v.exitYaw, 4) };
  }
  return copy;
}

/** Small deterministic generator (mulberry32): the same seed always gives the same sequence in [0, 1). */
export function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs `body` with a temporary obstacle in the shared map, always removing it afterwards. */
export function withObstacle<T>(obstacle: Omit<MapObstacle, 'color'> & { color?: string }, body: () => T): T {
  const added: MapObstacle = { color: '#000000', ...obstacle };
  OBSTACLES.push(added);
  try { return body(); } finally {
    const index = OBSTACLES.lastIndexOf(added);
    if (index >= 0) OBSTACLES.splice(index, 1);
  }
}
