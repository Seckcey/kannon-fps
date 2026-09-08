import { ARENA_HALF, OBSTACLES, SPAWNS } from '../shared/map.js';
import { cameraPosition, clamp, muzzlePosition, normalize, PLAYER_HEIGHT, PLAYER_RADIUS, raycastMap, subtract } from '../shared/physics.js';
import type { InputFrame, PlayerState, PracticeDifficulty, Profile, Vec3 } from '../shared/protocol.js';

export const PRACTICE_RIVALS: ReadonlyArray<Profile> = [
  { id: 'bot-scout', name: 'Scout (AI)', color: '#4abbb3' },
  { id: 'bot-moxie', name: 'Moxie (AI)', color: '#ee985d' },
  { id: 'bot-rook', name: 'Rook (AI)', color: '#9295dc' },
];
const DIFFICULTIES = {
  easy: { reaction: 1000, error: 0.10, turn: 2.5, range: 30, distance: 18, burst: 450, rest: 750 },
  normal: { reaction: 600, error: 0.052, turn: 3.8, range: 38, distance: 14, burst: 800, rest: 450 },
  hard: { reaction: 330, error: 0.024, turn: 5, range: 44, distance: 12, burst: 1100, rest: 300 },
} as const;
const horizontalDistance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
const angleDelta = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const point = (p: Vec3): Vec3 => ({ x: p.x, y: p.y, z: p.z });

interface Rectangle { minX: number; maxX: number; minZ: number; maxZ: number }
function intersectsSegment(a: Vec3, b: Vec3, box: Rectangle): boolean {
  let near = 0, far = 1;
  for (const [start, delta, min, max] of [[a.x, b.x - a.x, box.minX + 0.001, box.maxX - 0.001], [a.z, b.z - a.z, box.minZ + 0.001, box.maxZ - 0.001]]) {
    if (Math.abs(delta!) < 1e-9) { if (start! < min! || start! > max!) return false; }
    else { const low = (min! - start!) / delta!, high = (max! - start!) / delta!; near = Math.max(near, Math.min(low, high)); far = Math.min(far, Math.max(low, high)); }
  }
  return near <= far && far >= 0 && near <= 1;
}
/** Ground routes deliberately go around steps/platforms. Shots can still reach
 * elevated opponents. The graph is derived from the actual collision boxes,
 * including clearance for a whole player, and shared by all practice rooms. */
export class BotNavigation {
  private readonly obstacles: Rectangle[];
  private readonly physicalObstacles: Rectangle[];
  readonly nodes: Vec3[];
  private readonly edges: Array<Array<{ to: number; cost: number }>>;
  constructor() {
    const margin = PLAYER_RADIUS + 0.3;
    this.obstacles = OBSTACLES.filter(b => b.y - b.h / 2 < PLAYER_HEIGHT && b.y + b.h / 2 > 0.01)
      .map(b => ({ minX: b.x - b.w / 2 - margin, maxX: b.x + b.w / 2 + margin, minZ: b.z - b.d / 2 - margin, maxZ: b.z + b.d / 2 + margin }));
    this.physicalObstacles = this.obstacles.map(b => ({ minX: b.minX + 0.29, maxX: b.maxX - 0.29, minZ: b.minZ + 0.29, maxZ: b.maxZ - 0.29 }));
    const candidates: Vec3[] = [...SPAWNS.map(point), { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -23 }, { x: -11, y: 0, z: 10 }, { x: 11, y: 0, z: -10 }];
    for (const box of this.obstacles) for (const x of [box.minX, box.maxX]) for (const z of [box.minZ, box.maxZ]) candidates.push({ x, y: 0, z });
    this.nodes = candidates.filter((p, i) => this.isWalkable(p) && candidates.findIndex(q => horizontalDistance(p, q) < 0.01) === i);
    this.edges = this.nodes.map(() => []);
    for (let a = 0; a < this.nodes.length; a++) for (let b = a + 1; b < this.nodes.length; b++) {
      if (!this.clearSegment(this.nodes[a]!, this.nodes[b]!)) continue;
      const cost = horizontalDistance(this.nodes[a]!, this.nodes[b]!);
      this.edges[a]!.push({ to: b, cost }); this.edges[b]!.push({ to: a, cost });
    }
  }
  isWalkable(p: Vec3): boolean {
    return Math.abs(p.x) <= ARENA_HALF - PLAYER_RADIUS && Math.abs(p.z) <= ARENA_HALF - PLAYER_RADIUS &&
      !this.obstacles.some(b => p.x > b.minX + 0.001 && p.x < b.maxX - 0.001 && p.z > b.minZ + 0.001 && p.z < b.maxZ - 0.001);
  }
  clearSegment(a: Vec3, b: Vec3): boolean {
    if (!this.isWalkable(a) || !this.isWalkable(b)) return false;
    return !this.obstacles.some(box => intersectsSegment(a, b, box));
  }
  /** A bounded visibility-graph search; no per-tick grid allocation or path search. */
  findPath(start: Vec3, requestedGoal: Vec3): Vec3[] {
    if (!this.isWalkable(start)) {
      // Steering can enter the extra navigation margin while the actual body
      // remains clear. Walk out of that padding before searching, never teleport
      // or cut through the smaller physical collider to recover a route.
      const exits = this.obstacles.flatMap(b => [
        { x: b.minX, y: 0, z: start.z }, { x: b.maxX, y: 0, z: start.z },
        { x: start.x, y: 0, z: b.minZ }, { x: start.x, y: 0, z: b.maxZ },
      ]).filter(p => this.isWalkable(p) && !this.physicalObstacles.some(b => intersectsSegment(start, p, b)))
        .sort((a, b) => horizontalDistance(start, a) - horizontalDistance(start, b));
      const exit = exits[0];
      return exit ? [exit, ...this.findPath(exit, requestedGoal)] : [];
    }
    const goal = this.isWalkable(requestedGoal) ? { ...requestedGoal, y: 0 } : this.nodes.reduce((best, p) => horizontalDistance(p, requestedGoal) < horizontalDistance(best, requestedGoal) ? p : best);
    if (this.clearSegment(start, goal)) return [point(goal)];
    const count = this.nodes.length, end = count + 1;
    const points = [...this.nodes, start, goal];
    const links = this.edges.map(edges => [...edges]); links.push([], []);
    for (let i = 0; i < count; i++) {
      if (this.clearSegment(start, points[i]!)) links[count]!.push({ to: i, cost: horizontalDistance(start, points[i]!) });
      if (this.clearSegment(points[i]!, goal)) links[i]!.push({ to: end, cost: horizontalDistance(points[i]!, goal) });
    }
    const costs = new Float64Array(count + 2).fill(Infinity), visited = new Uint8Array(count + 2), previous = new Int16Array(count + 2).fill(-1);
    costs[count] = 0;
    for (let iteration = 0; iteration < count + 2; iteration++) {
      let current = -1, best = Infinity;
      for (let i = 0; i < count + 2; i++) { const estimate = costs[i]! + horizontalDistance(points[i]!, goal); if (!visited[i] && estimate < best) { best = estimate; current = i; } }
      if (current < 0) return [];
      if (current === end) {
        const route: Vec3[] = [];
        for (let i = end; i !== count; i = previous[i]!) { if (i < 0) return []; route.push(point(points[i]!)); }
        return route.reverse();
      }
      visited[current] = 1;
      for (const edge of links[current]!) { const cost = costs[current]! + edge.cost; if (cost < costs[edge.to]!) { costs[edge.to] = cost; previous[edge.to] = current; } }
    }
    return [];
  }
}
let navigation: BotNavigation | undefined;
const getNavigation = () => navigation ??= new BotNavigation();

function sees(from: Vec3, target: Vec3): boolean {
  const eye = muzzlePosition(from), body = { x: target.x, y: target.y + 1.2, z: target.z };
  const delta = subtract(body, eye), distance = Math.hypot(delta.x, delta.y, delta.z);
  return raycastMap(eye, normalize(delta), distance) >= distance - 0.01;
}
function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (const character of seed) state = Math.imul(state ^ character.charCodeAt(0), 16777619);
  return () => { state += 0x6D2B79F5; let value = Math.imul(state ^ state >>> 15, state | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4294967296; };
}
interface Brain {
  random: () => number; nextSense: number; targetId: string | null; visible: boolean;
  lastSeen: Vec3 | null; seenAt: number; reactAt: number; burstUntil: number; restUntil: number;
  yawError: number; pitchError: number; nextError: number; strafe: number; nextStrafe: number;
  patrol: Vec3 | null; retreat: Vec3 | null; route: Vec3[]; routeGoal: Vec3 | null; nextRoute: number;
}

/** Server-side perception and ordinary input generation. Decisions never mutate
 * players or apply damage; MatchEngine owns every physical/combat outcome. */
export class PracticeBots {
  private readonly brains = new Map<string, Brain>();
  constructor(readonly difficulty: PracticeDifficulty = 'normal', private seed = 'practice') {}
  reset(seed = this.seed) { this.seed = seed; this.brains.clear(); }
  forget(id: string) { this.brains.delete(id); }
  input(player: PlayerState, opponents: readonly PlayerState[], now: number, dt: number, seq: number): InputFrame {
    let brain = this.brains.get(player.id);
    if (!brain) {
      const random = seededRandom(`${this.seed}:${player.id}`);
      brain = { random, nextSense: 0, targetId: null, visible: false, lastSeen: null, seenAt: -Infinity, reactAt: Infinity, burstUntil: 0, restUntil: 0,
        yawError: 0, pitchError: 0, nextError: 0, strafe: random() < 0.5 ? -1 : 1, nextStrafe: 0, patrol: null, retreat: null, route: [], routeGoal: null, nextRoute: 0 };
      this.brains.set(player.id, brain);
    }
    const settings = DIFFICULTIES[this.difficulty], nav = getNavigation();
    const input: InputFrame = { seq, moveX: 0, moveZ: 0, yaw: player.yaw, pitch: player.pitch, fire: false, aim: false, jump: false, sprint: false, reload: false, slot: 1 };
    if (!player.connected || player.health <= 0) return input;
    if (now >= brain.nextSense) {
      brain.nextSense = now + 100;
      const visible = opponents.filter(p => p.id !== player.id && p.connected && p.health > 0 && p.protectedUntil <= now && horizontalDistance(player, p) <= settings.range &&
        (horizontalDistance(player, p) < 5 || Math.abs(angleDelta(Math.atan2(p.x - player.x, -(p.z - player.z)), player.yaw)) < 1.9) && sees(player, p));
      visible.sort((a, b) => horizontalDistance(player, a) * (a.id === brain!.targetId ? 0.75 : 1) - horizontalDistance(player, b) * (b.id === brain!.targetId ? 0.75 : 1) || a.id.localeCompare(b.id));
      const target = visible[0];
      if (target) {
        if (!brain.visible || brain.targetId !== target.id) { brain.reactAt = now + settings.reaction * (0.85 + brain.random() * 0.3); brain.burstUntil = 0; brain.restUntil = brain.reactAt; }
        brain.targetId = target.id; brain.lastSeen = point(target); brain.seenAt = now;
      }
      brain.visible = !!target;
    }
    // A target's coordinates are sampled only when seen. Lost sight provides a
    // short investigation of the last observed location, never wall tracking.
    const target = brain.lastSeen, visible = brain.visible && !!target;
    const distance = target ? horizontalDistance(player, target) : Infinity;
    const wounded = player.health <= 40 && player.heals > 0;
    let goal: Vec3 | null = null;
    if (visible && wounded && distance > 7) {
      if (!brain.retreat || horizontalDistance(player, brain.retreat) < 1) {
        brain.retreat = nav.nodes.filter(p => horizontalDistance(player, p) >= 3 && horizontalDistance(player, p) <= 18 && !sees(target!, p))
          .sort((a, b) => horizontalDistance(player, a) - horizontalDistance(player, b))[0] ?? null;
      }
      goal = brain.retreat;
    } else brain.retreat = null;
    if (!goal && visible && distance > settings.distance + 2) goal = target;
    if (!visible) {
      if (target && now - brain.seenAt < 2200 && horizontalDistance(player, target) > 1) goal = target;
      else {
        if (!brain.patrol || horizontalDistance(player, brain.patrol) < 1.2) {
          const choices = nav.nodes.filter(p => horizontalDistance(player, p) > 8 && Math.abs(p.x) < 28 && Math.abs(p.z) < 28);
          brain.patrol = choices[Math.floor(brain.random() * choices.length)] ?? nav.nodes[0]!;
        }
        goal = brain.patrol;
      }
    }
    let worldX = 0, worldZ = 0;
    if (goal) {
      if (now >= brain.nextRoute && (!brain.routeGoal || horizontalDistance(goal, brain.routeGoal) > 2 || !brain.route.length)) {
        brain.route = nav.findPath(player, goal); brain.routeGoal = point(goal); brain.nextRoute = now + 600;
      }
      while (brain.route.length && horizontalDistance(player, brain.route[0]!) < 0.18 && nav.isWalkable(player) &&
        (brain.route.length === 1 || nav.clearSegment(player, brain.route[1]!))) brain.route.shift();
      const next = brain.route[0];
      if (next) { const length = horizontalDistance(player, next), amount = Math.min(1, length / Math.max(0.1, 9 * clamp(dt, 0, 0.1))); worldX = (next.x - player.x) / length * amount; worldZ = (next.z - player.z) / length * amount; }
    } else if (visible) {
      brain.route = []; brain.routeGoal = null;
      if (now >= brain.nextStrafe) { brain.strafe *= -1; brain.nextStrafe = now + 1300 + brain.random() * 1500; }
      const dx = (target!.x - player.x) / Math.max(0.01, distance), dz = (target!.z - player.z) / Math.max(0.01, distance);
      const advance = distance < 6 ? -0.65 : 0;
      worldX = dx * advance - dz * brain.strafe * 0.8; worldZ = dz * advance + dx * brain.strafe * 0.8;
      if (!nav.clearSegment(player, { x: player.x + worldX, y: 0, z: player.z + worldZ })) {
        brain.strafe *= -1; worldX = -worldX; worldZ = -worldZ;
        if (!nav.clearSegment(player, { x: player.x + worldX, y: 0, z: player.z + worldZ })) { worldX = 0; worldZ = 0; }
      }
    }
    const keepHealing = player.healingUntil > now && !(visible && distance < 7);
    const beginHealing = !visible && player.health <= 55 && player.heals > 0;
    input.slot = keepHealing || beginHealing ? 3 : player.reloadingUntil > now ? player.slot : visible && distance < 9 ? 2 : 1;
    // Release fire while switching to healing. Otherwise an AR burst that was
    // held on the prior tick would swallow the healing item's required press.
    if (input.slot === 3) { input.fire = player.slot === 3 && !player.healingUntil; worldX *= 0.4; worldZ *= 0.4; }
    else {
      const ammo = input.slot === 1 ? player.ammoAR : player.ammoShotgun;
      input.reload = !player.reloadingUntil && (ammo === 0 || (!visible && ammo < (input.slot === 1 ? 18 : 4)));
    }
    let desiredYaw = input.yaw, desiredPitch = 0;
    input.aim = visible && input.slot !== 3;
    if (visible) {
      if (now >= brain.nextError) {
        brain.yawError = (brain.random() * 2 - 1) * settings.error;
        brain.pitchError = (brain.random() * 2 - 1) * settings.error * 0.6; brain.nextError = now + 230 + brain.random() * 170;
      }
      // Aim at the sampled torso through the same clipped shoulder camera as a
      // player. Deliberate aim error and bounded turning follow this correction.
      desiredYaw = Math.atan2(target!.x - player.x, -(target!.z - player.z));
      for (let i = 0; i < 4; i++) {
        const eye = cameraPosition(player, desiredYaw, desiredPitch, input.aim);
        desiredYaw = Math.atan2(target!.x - eye.x, -(target!.z - eye.z));
        desiredPitch = Math.atan2(target!.y + 1.15 - eye.y, Math.hypot(target!.x - eye.x, target!.z - eye.z));
      }
      desiredYaw += brain.yawError; desiredPitch += brain.pitchError;
    } else if (Math.hypot(worldX, worldZ) > 0.01) desiredYaw = Math.atan2(worldX, -worldZ);
    const turn = settings.turn * clamp(dt, 0, 0.1);
    input.yaw = player.yaw + clamp(angleDelta(desiredYaw, player.yaw), -turn, turn);
    input.pitch = clamp(player.pitch + clamp(desiredPitch - player.pitch, -turn, turn), -1.3, 1.3);
    input.moveX = worldX * Math.cos(input.yaw) + worldZ * Math.sin(input.yaw);
    input.moveZ = worldX * Math.sin(input.yaw) - worldZ * Math.cos(input.yaw);
    input.sprint = !visible && input.slot !== 3 && !player.reloadingUntil;
    if (visible && input.slot !== 3 && now >= brain.reactAt && !player.reloadingUntil && !input.reload) {
      if (now >= brain.restUntil && now >= brain.burstUntil) { brain.burstUntil = now + settings.burst; brain.restUntil = brain.burstUntil + settings.rest; }
      input.fire = now < brain.burstUntil && Math.abs(angleDelta(desiredYaw, input.yaw)) < 0.15 && Math.abs(desiredPitch - input.pitch) < 0.15;
    }
    return input;
  }
}
