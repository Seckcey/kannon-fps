import { randomUUID } from 'node:crypto';
import { PracticeBots } from './bots.js';
import { SPAWNS } from '../shared/map.js';
import { add, cameraPosition, clamp, directionFromAngles, movePlayer, muzzlePosition, normalize, PLAYER_HEIGHT, PLAYER_RADIUS, rayBox, raycastMap, scale, subtract } from '../shared/physics.js';
import { RULES, type GameEvent, type InputFrame, type Phase, type PlayerState, type PracticeDifficulty, type Profile, type ShotTrace, type Vec3, type WorldSnapshot } from '../shared/protocol.js';

export function idleInput(seq = 0): InputFrame { return { seq, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, fire: false, aim: false, jump: false, sprint: false, reload: false, slot: 1 }; }
export function sanitizeInput(value: unknown): InputFrame | null {
  if (!value || typeof value !== 'object') return null;
  const i = value as Record<string, unknown>;
  if (!['seq', 'moveX', 'moveZ', 'yaw', 'pitch'].every((key) => typeof i[key] === 'number' && Number.isFinite(i[key]))) return null;
  if (!Number.isInteger(i.seq) || (i.seq as number) < 0 || (i.seq as number) > 2147483647 || ![1, 2, 3].includes(i.slot as number)) return null;
  if (!['fire', 'aim', 'jump', 'sprint', 'reload'].every((key) => typeof i[key] === 'boolean')) return null;
  return { seq: i.seq as number, moveX: clamp(i.moveX as number, -1, 1), moveZ: clamp(i.moveZ as number, -1, 1), yaw: ((i.yaw as number) % (Math.PI * 2)), pitch: clamp(i.pitch as number, -1.3, 1.3), fire: i.fire as boolean, aim: i.aim as boolean, jump: i.jump as boolean, sprint: i.sprint as boolean, reload: i.reload as boolean, slot: i.slot as 1 | 2 | 3 };
}
type PressAction = 'fire' | 'jump' | 'reload';
interface PendingPress { input: InputFrame; receivedAt: number }
interface Runtime {
  input: InputFrame; receivedAt: number; lastFire: number; jumpDown: boolean; fireDown: boolean;
  reloadSlot: 1 | 2 | null; presses: Partial<Record<PressAction, PendingPress>>;
}
interface ShotResult {
  attacker: PlayerState; event: Extract<GameEvent, { type: 'shot' }>;
  damage: Array<{ target: PlayerState; amount: number }>;
}
export interface EngineOptions {
  practice?: boolean; practiceDifficulty?: PracticeDifficulty; now?: number;
  /** Optional reproducible simulation seed. Never accepted by the wire protocol. */
  practiceSeed?: string;
  onEvent?: (event: GameEvent) => void; onFinish?: (reason: string) => void;
}
export class MatchEngine {
  id = randomUUID(); phase: Phase = 'waiting'; tick = 0; startedAt = 0; countdownUntil = 0; endedAt = 0;
  winnerIds: string[] = []; readonly players = new Map<string, PlayerState>(); readonly runtime = new Map<string, Runtime>();
  readonly practice: boolean; private readonly onEvent: (event: GameEvent) => void; private readonly onFinish: (reason: string) => void;
  private readonly bots: PracticeBots | null;
  private readonly practiceSeed: string | undefined;
  private resolvingShots = false;
  constructor(options: EngineOptions = {}) { this.practice = options.practice ?? false; this.practiceSeed = options.practiceSeed; this.bots = this.practice ? new PracticeBots(options.practiceDifficulty ?? 'normal', this.practiceSeed ?? this.id) : null; this.onEvent = options.onEvent ?? (() => {}); this.onFinish = options.onFinish ?? (() => {}); }
  addPlayer(profile: Profile, now = Date.now(), bot = false): PlayerState {
    if (bot && !this.practice) throw new Error('AI rivals are available only in practice.');
    const existing = this.players.get(profile.id);
    if (existing) {
      existing.connected = true; existing.name = profile.name; existing.lastInputSeq = 0; existing.aiming = false;
      const rt = this.runtime.get(profile.id)!; rt.input = { ...idleInput(), yaw: existing.yaw, pitch: existing.pitch, slot: existing.slot }; rt.receivedAt = 0; rt.jumpDown = false; rt.fireDown = false; rt.presses = {};
      return existing;
    }
    const state: PlayerState = { ...profile, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, health: RULES.health, shield: RULES.shield, slot: 1, ammoAR: RULES.arMagazine, ammoShotgun: RULES.shotgunMagazine, heals: RULES.healCharges, kills: 0, deaths: 0, connected: true, respawnAt: 0, protectedUntil: 0, healingUntil: 0, reloadingUntil: 0, lastInputSeq: 0, aiming: false, ...(bot ? { bot: true } : {}) };
    this.players.set(profile.id, state); this.runtime.set(profile.id, { input: idleInput(), receivedAt: 0, lastFire: -Infinity, jumpDown: false, fireDown: false, reloadSlot: null, presses: {} });
    this.respawn(state, now, false); return state;
  }
  removePlayer(id: string) { this.players.delete(id); this.runtime.delete(id); this.bots?.forget(id); }
  setConnected(id: string, connected: boolean) {
    const player = this.players.get(id);
    if (!player) return;
    player.connected = connected;
    if (!connected) {
      const rt = this.runtime.get(id)!;
      rt.input = { ...idleInput(rt.input.seq), yaw: player.yaw, pitch: player.pitch, slot: player.slot };
      rt.receivedAt = 0; rt.presses = {}; rt.jumpDown = false; rt.fireDown = false; rt.reloadSlot = null;
      player.vx = 0; player.vy = 0; player.vz = 0; player.healingUntil = 0; player.reloadingUntil = 0; player.aiming = false;
    }
  }
  acceptInput(id: string, input: InputFrame, now = Date.now()): boolean {
    const runtime = this.runtime.get(id); if (!runtime || input.seq <= runtime.input.seq) return false;
    // Network frames may arrive in a batch between simulation ticks. Preserve one
    // rising edge per action, with the view/weapon at that press, while coalescing
    // continuous movement. This bounded latch cannot create extra shots per tick.
    for (const action of ['fire', 'jump', 'reload'] as const) {
      if (input[action] && !runtime.input[action] && !runtime.presses[action]) runtime.presses[action] = { input: { ...input }, receivedAt: now };
    }
    runtime.input = input; runtime.receivedAt = now; return true;
  }
  start(now = Date.now()): void {
    if (this.phase !== 'waiting' && this.phase !== 'finished') throw new Error('This match has already started.');
    if (!this.practice && [...this.players.values()].filter((p) => !p.bot && p.connected).length < 2) throw new Error('Invite at least one friend before starting.');
    this.id = randomUUID(); this.phase = 'countdown'; this.countdownUntil = now + RULES.countdownMs; this.startedAt = 0; this.endedAt = 0; this.winnerIds = []; this.tick = 0;
    this.bots?.reset(this.practiceSeed ?? this.id);
    for (const player of this.players.values()) { player.kills = 0; player.deaths = 0; this.respawn(player, this.countdownUntil, false); }
  }
  finish(reason: string, now = Date.now(), abandoned = false): void {
    if (this.phase === 'finished') return;
    this.phase = 'finished'; this.endedAt = now;
    const eligible = [...this.players.values()].filter((p) => this.practice || !p.bot);
    const maxKills = Math.max(0, ...eligible.map((p) => p.kills));
    this.winnerIds = abandoned ? [] : eligible.filter((p) => p.kills === maxKills).map((p) => p.id);
    this.onFinish(reason);
  }
  step(now: number, dt: number): void {
    this.tick++;
    if (this.phase === 'countdown' && now >= this.countdownUntil) { this.phase = 'playing'; this.startedAt = now; }
    if (this.phase !== 'playing') return;
    if (now - this.startedAt >= RULES.matchSeconds * 1000) { this.finish('Time is up.', now); return; }
    const botsActive = this.practice && [...this.players.values()].some(p => !p.bot && p.connected);
    if (this.bots) {
      if (!botsActive) this.bots.reset();
      // Plan against a common state before any player moves, retaining the same
      // simultaneous-shot fairness as human versus human matches.
      const observed = [...this.players.values()];
      for (const player of observed) if (player.bot && player.connected && player.health > 0) {
        const rt = this.runtime.get(player.id)!;
        if (botsActive) this.acceptInput(player.id, this.bots.input(player, observed, now, dt, rt.input.seq + 1), now);
        else {
          rt.input = { ...idleInput(rt.input.seq), yaw: player.yaw, pitch: player.pitch, slot: player.slot }; rt.receivedAt = 0; rt.presses = {}; rt.fireDown = false; rt.jumpDown = false; rt.reloadSlot = null;
          player.vx = 0; player.vy = 0; player.vz = 0; player.aiming = false; player.healingUntil = 0; player.reloadingUntil = 0;
        }
      }
    }
    const shots: Array<{ player: PlayerState; input: InputFrame }> = [];
    for (const player of this.players.values()) {
      if (player.bot && !botsActive) continue;
      if (player.health <= 0) { if (now >= player.respawnAt && player.connected) this.respawn(player, now); continue; }
      if (!player.connected) continue;
      const rt = this.runtime.get(player.id)!;
      const input = now - rt.receivedAt <= 300 ? rt.input : { ...idleInput(rt.input.seq), yaw: player.yaw, pitch: player.pitch, slot: player.slot };
      const takePress = (action: PressAction): InputFrame | undefined => {
        const press = rt.presses[action]; delete rt.presses[action];
        return press && now - press.receivedAt <= 300 ? press.input : undefined;
      };
      const firePress = takePress('fire'); const jumpPress = takePress('jump'); const reloadPress = takePress('reload');
      const fireInput = firePress ?? (input.fire ? input : undefined);
      // Switching away cancels a reload, but a queued shot from that weapon must
      // not become valid merely because a later frame switched weapons.
      const priorReloadUntil = player.reloadingUntil; const priorReloadSlot = rt.reloadSlot;
      player.lastInputSeq = input.seq;
      if (input.slot !== player.slot) { player.slot = input.slot; player.healingUntil = 0; player.reloadingUntil = 0; rt.reloadSlot = null; }
      player.aiming = input.aim && player.slot !== 3;
      movePlayer(player, { ...input, jump: input.jump || !!jumpPress, sprint: input.sprint && !player.healingUntil && !player.reloadingUntil }, dt, !!jumpPress || !rt.jumpDown);
      rt.jumpDown = input.jump;
      if (fireInput && fireInput.slot !== 3) { player.protectedUntil = 0; player.healingUntil = 0; }
      if (player.healingUntil && now >= player.healingUntil) {
        const amount = Math.min(RULES.healAmount, RULES.health - player.health); player.health += amount; player.healingUntil = 0;
        this.onEvent({ type: 'heal', playerId: player.id, amount, at: now });
      }
      if (player.reloadingUntil && now >= player.reloadingUntil) {
        if (rt.reloadSlot === 1) player.ammoAR = RULES.arMagazine;
        if (rt.reloadSlot === 2) player.ammoShotgun = RULES.shotgunMagazine;
        player.reloadingUntil = 0; rt.reloadSlot = null;
      }
      if (fireInput?.slot === 3 && player.slot === 3 && (firePress || !rt.fireDown) && !player.healingUntil && player.heals > 0 && player.health < RULES.health) {
        player.heals--; player.healingUntil = now + RULES.healMs; player.reloadingUntil = 0; rt.reloadSlot = null;
      }
      if ((input.reload || reloadPress?.slot === player.slot) && player.slot !== 3 && !player.reloadingUntil) this.reload(player, rt, now);
      if (fireInput && fireInput.slot !== 3 && !(player.reloadingUntil && rt.reloadSlot === fireInput.slot) && !(priorReloadUntil > now && priorReloadSlot === fireInput.slot)) {
        const ammo = fireInput.slot === 1 ? player.ammoAR : player.ammoShotgun;
        const cadence = fireInput.slot === 1 ? RULES.arCadenceMs : RULES.shotgunCadenceMs;
        if (ammo === 0) { if (player.slot === fireInput.slot) this.reload(player, rt, now); }
        else if (now - rt.lastFire >= cadence) {
          rt.lastFire = now; if (fireInput.slot === 1) player.ammoAR--; else player.ammoShotgun--;
          shots.push({ player, input: fireInput });
        }
      }
      rt.fireDown = input.fire;
    }
    // Every player moves and every valid shot is accepted before tracing. Damage
    // is applied only after all traces, so map insertion/join order cannot stop
    // the other player from firing a valid shot in the same simulation tick.
    const results = shots.map(({ player, input }) => this.traceShot(player, input, now));
    this.resolveShots(results, now);
  }
  private reload(player: PlayerState, rt: Runtime, now: number) {
    const slot = player.slot;
    if (slot === 3 || (slot === 1 && player.ammoAR === RULES.arMagazine) || (slot === 2 && player.ammoShotgun === RULES.shotgunMagazine)) return;
    rt.reloadSlot = slot; player.reloadingUntil = now + (slot === 1 ? RULES.arReloadMs : RULES.shotgunReloadMs); player.healingUntil = 0;
  }
  private respawn(player: PlayerState, now: number, announce = true) {
    const opponents = [...this.players.values()].filter((p) => p.id !== player.id && p.health > 0 && p.connected);
    const spawn = [...SPAWNS].sort((a, b) => {
      const score = (p: Vec3) => opponents.length ? Math.min(...opponents.map((other) => Math.hypot(other.x - p.x, other.z - p.z))) : 0;
      return score(b) - score(a);
    })[0]!;
    Object.assign(player, { x: spawn.x, y: spawn.y, z: spawn.z, yaw: spawn.yaw, pitch: 0, vx: 0, vy: 0, vz: 0, health: RULES.health, shield: RULES.shield, slot: 1, ammoAR: RULES.arMagazine, ammoShotgun: RULES.shotgunMagazine, heals: RULES.healCharges, respawnAt: 0, protectedUntil: now + RULES.protectionMs, healingUntil: 0, reloadingUntil: 0, aiming: false });
    if (player.bot) this.bots?.forget(player.id);
    const rt = this.runtime.get(player.id)!; rt.reloadSlot = null; rt.lastFire = -Infinity; rt.fireDown = false; rt.jumpDown = false; rt.presses = {};
    rt.input = { ...idleInput(rt.input.seq), yaw: player.yaw, pitch: 0 }; rt.receivedAt = 0;
    if (announce) this.onEvent({ type: 'respawn', playerId: player.id, at: now });
  }
  private trace(origin: Vec3, direction: Vec3, shooterId: string, now: number, limit: number): { to: Vec3; target?: PlayerState; distance: number; kind: ShotTrace['kind'] } {
    const worldDistance = raycastMap(origin, direction, limit);
    let distance = worldDistance; let target: PlayerState | undefined;
    for (const player of this.players.values()) {
      if (player.id === shooterId || player.health <= 0 || !player.connected) continue;
      const hit = rayBox(origin, direction, { x: player.x - PLAYER_RADIUS, y: player.y, z: player.z - PLAYER_RADIUS }, { x: player.x + PLAYER_RADIUS, y: player.y + PLAYER_HEIGHT, z: player.z + PLAYER_RADIUS }, distance);
      if (hit < distance) { distance = hit; target = player; }
    }
    return { to: add(origin, scale(direction, distance)), target, distance, kind: target ? 'player' : worldDistance < limit ? 'world' : 'range' };
  }
  private traceShot(player: PlayerState, input: InputFrame, now: number): ShotResult {
    const slot = input.slot as 1 | 2;
    const eye = cameraPosition(player, input.yaw, input.pitch, input.aim);
    const viewDirection = directionFromAngles(input.yaw, input.pitch);
    const viewHit = this.trace(eye, viewDirection, player.id, now, slot === 1 ? 100 : 40);
    const muzzle = muzzlePosition(player); const toAim = normalize(subtract(viewHit.to, muzzle));
    const offsets = slot === 1 ? [[0, 0]] : [[0, 0], [-0.03, 0], [0.03, 0], [0, -0.03], [0, 0.03], [-0.021, -0.021], [0.021, -0.021], [-0.021, 0.021], [0.021, 0.021]];
    const damage = new Map<string, { target: PlayerState; amount: number }>(); let displayTo = viewHit.to; let didHit = false;
    const traces: ShotTrace[] = [];
    for (const [horizontal, vertical] of offsets) {
      const direction = normalize({ x: toAim.x + Math.cos(input.yaw) * horizontal!, y: toAim.y + vertical!, z: toAim.z + Math.sin(input.yaw) * horizontal! });
      const hit = this.trace(muzzle, direction, player.id, now, slot === 1 ? 100 : 40);
      traces.push({ to: hit.to, kind: hit.kind, ...(hit.target ? { targetId: hit.target.id, shield: hit.target.shield > 0, protected: hit.target.protectedUntil > now } : {}) });
      if (horizontal === 0 && vertical === 0) displayTo = hit.to;
      if (hit.target && hit.target.protectedUntil <= now) {
        didHit = true; const amount = slot === 1 ? RULES.arDamage : 8 * clamp(1 - Math.max(0, hit.distance - 10) / 35, 0.2, 1);
        const existing = damage.get(hit.target.id); damage.set(hit.target.id, { target: hit.target, amount: (existing?.amount ?? 0) + amount });
      }
    }
    return {
      attacker: player, event: { type: 'shot', playerId: player.id, slot, from: muzzle, to: displayTo, hit: didHit, at: now, traces },
      damage: [...damage.values()].map(({ target, amount }) => ({ target, amount: Math.round(amount) })),
    };
  }
  private resolveShots(results: ShotResult[], now: number) {
    const targets = new Map<string, { target: PlayerState; contributors: Array<{ attacker: PlayerState; amount: number }> }>();
    for (const result of results) {
      this.onEvent(result.event);
      for (const hit of result.damage) {
        const entry = targets.get(hit.target.id) ?? { target: hit.target, contributors: [] };
        entry.contributors.push({ attacker: result.attacker, amount: hit.amount }); targets.set(hit.target.id, entry);
      }
    }
    // Equal simultaneous contributions use a per-tick hash rather than join
    // order; the highest damage contribution receives elimination credit.
    const tieBreak = (targetId: string, attackerId: string) => {
      let hash = 2166136261;
      for (const character of `${this.tick}:${targetId}:${attackerId}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
      return hash >>> 0;
    };
    this.resolvingShots = true;
    try {
      for (const { target, contributors } of targets.values()) {
        contributors.sort((a, b) => b.amount - a.amount || tieBreak(target.id, a.attacker.id) - tieBreak(target.id, b.attacker.id) || a.attacker.id.localeCompare(b.attacker.id));
        this.damage(target, contributors[0]!.attacker, contributors.reduce((total, hit) => total + hit.amount, 0), now);
      }
    } finally { this.resolvingShots = false; }
    if ([...this.players.values()].some((player) => player.kills >= RULES.scoreLimit)) this.finish('Elimination limit reached.', now);
  }
  damage(target: PlayerState, attacker: PlayerState, amount: number, now: number): void {
    if (target.health <= 0 || target.protectedUntil > now) return;
    amount = clamp(Math.round(amount), 0, 150); if (!amount) return;
    target.healingUntil = 0;
    const previousHealth = target.health;
    const shieldDamage = Math.min(target.shield, amount); target.shield -= shieldDamage; target.health = Math.max(0, target.health - (amount - shieldDamage));
    this.onEvent({ type: 'damage', playerId: target.id, attackerId: attacker.id, amount, at: now, shieldDamage, healthDamage: previousHealth - target.health, shieldBroken: shieldDamage > 0 && target.shield === 0 });
    if (target.health <= 0) {
      target.deaths++; attacker.kills++; target.respawnAt = now + RULES.respawnMs; target.reloadingUntil = 0; target.vx = 0; target.vz = 0; target.aiming = false;
      this.onEvent({ type: 'elimination', playerId: target.id, attackerId: attacker.id, at: now });
      if (attacker.kills >= RULES.scoreLimit && !this.resolvingShots) this.finish('Elimination limit reached.', now);
    }
  }
  snapshot(now = Date.now()): WorldSnapshot {
    return { tick: this.tick, serverTime: now, phase: this.phase, timeRemaining: this.phase === 'countdown' ? Math.max(0, (this.countdownUntil - now) / 1000) : this.phase === 'playing' ? Math.max(0, RULES.matchSeconds - (now - this.startedAt) / 1000) : this.phase === 'waiting' ? RULES.matchSeconds : 0, players: [...this.players.values()].map((p) => ({ ...p })), winnerIds: [...this.winnerIds] };
  }
}
