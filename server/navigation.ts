import { ARENA_LIMITS, OBSTACLES, SPAWNS, STAIR_ROUTES } from '../shared/map.js';
import { PLAYER_HEIGHT, PLAYER_RADIUS, supportHeight } from '../shared/physics.js';
import type { Vec3 } from '../shared/protocol.js';

interface Rectangle { minX: number; maxX: number; minZ: number; maxZ: number }
interface Layer { height: number; supports: Rectangle[]; contactSupports: Rectangle[]; obstacles: Rectangle[]; physical: Rectangle[]; stairs: boolean }
const margin = PLAYER_RADIUS + 0.12;
const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
const sameHeight = (a: Vec3, b: Vec3) => Math.abs(a.y - b.y) < 0.06;
const inside = (p: Vec3, r: Rectangle) => p.x >= r.minX - 1e-5 && p.x <= r.maxX + 1e-5 && p.z >= r.minZ - 1e-5 && p.z <= r.maxZ + 1e-5;
const rect = (b: typeof OBSTACLES[number], pad = 0): Rectangle => ({ minX: b.x - b.w / 2 - pad, maxX: b.x + b.w / 2 + pad, minZ: b.z - b.d / 2 - pad, maxZ: b.z + b.d / 2 + pad });
function interval(a: Vec3, b: Vec3, r: Rectangle, inset = 0): [number, number] | null {
  let lo = 0, hi = 1;
  for (const [v, delta, min, max] of [[a.x, b.x - a.x, r.minX + inset, r.maxX - inset], [a.z, b.z - a.z, r.minZ + inset, r.maxZ - inset]]) {
    if (Math.abs(delta!) < 1e-8) { if (v! < min! - 1e-7 || v! > max! + 1e-7) return null; }
    else { const near = (min! - v!) / delta!, far = (max! - v!) / delta!; lo = Math.max(lo, Math.min(near, far)); hi = Math.min(hi, Math.max(near, far)); }
  }
  return lo <= hi ? [lo, hi] : null;
}
/** A union test keeps routes on joined floor slabs without inventing a floor
 * across a stairwell or balcony edge. Explicit stair chains change elevation. */
function covered(a: Vec3, b: Vec3, supports: Rectangle[]) {
  const spans = supports.map(r => interval(a, b, r)).filter((r): r is [number, number] => !!r).sort((x, y) => x[0] - y[0]);
  let reach = 0;
  for (const span of spans) { if (span[0] > reach + 1e-5) return false; reach = Math.max(reach, span[1]); if (reach >= 1 - 1e-5) return true; }
  return false;
}
export class BotNavigation {
  private layers: Layer[] = [];
  readonly nodes: Vec3[];
  readonly patrolPoints: Vec3[];
  private edges: Array<Array<{ to: number; cost: number }>>;
  constructor() {
    const surfaces = OBSTACLES.filter(b => b.kind === 'step' || b.kind === 'platform');
    const heights = [...new Set([0, ...surfaces.map(b => +(b.y + b.h / 2).toFixed(5))])];
    for (const height of heights) {
      const own = surfaces.filter(b => Math.abs(b.y + b.h / 2 - height) < 0.001), stairs = height > 0 && own.every(b => b.kind === 'step');
      const blockers = OBSTACLES.filter(b => b.y + b.h / 2 > height + 0.02 && b.y - b.h / 2 < height + PLAYER_HEIGHT - 0.01);
      const supports = height === 0 ? [{ minX: -ARENA_LIMITS.x, maxX: ARENA_LIMITS.x, minZ: -ARENA_LIMITS.z, maxZ: ARENA_LIMITS.z }]
        : own.map(b => stairs ? { ...rect(b, PLAYER_RADIUS - 0.01), minX: b.x - b.w / 2, maxX: b.x + b.w / 2 } : rect(b));
      const contactSupports = height === 0 ? supports : own.map(b => rect(b, PLAYER_RADIUS - .005));
      this.layers.push({ height, supports, contactSupports, stairs, obstacles: blockers.map(b => rect(b, margin)), physical: blockers.map(b => rect(b, PLAYER_RADIUS + 0.005)) });
    }
    const candidates: Vec3[] = SPAWNS.map(p => ({ ...p }));
    for (const layer of this.layers) {
      for (const r of [...layer.supports, ...layer.obstacles]) {
        for (const x of [r.minX, r.maxX, (r.minX + r.maxX) / 2]) for (const z of [r.minZ, r.maxZ, (r.minZ + r.maxZ) / 2]) candidates.push({ x, y: layer.height, z });
        if (!layer.stairs) for (const x of [r.minX + margin, r.maxX - margin]) for (const z of [r.minZ + margin, r.maxZ - margin]) candidates.push({ x, y: layer.height, z });
      }
    }
    const chains: Vec3[][] = [];
    for (const route of STAIR_ROUTES) {
      const chain = [{ ...route.approach }], steps = route.steps.map(id => OBSTACLES.find(b => b.id === id)!);
      const landing = OBSTACLES.find(b => b.id === route.landing)!;
      if (!landing || steps.some(s => !s)) throw new Error(`Missing stair geometry: ${route.id}`);
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!, next = steps[i + 1] ?? landing, height = step.y + step.h / 2;
        if (height - (i ? steps[i - 1]!.y + steps[i - 1]!.h / 2 : 0) > 0.45) throw new Error(`Stair rise exceeds player step: ${route.id}`);
        const minZ = step.z - step.d / 2 - PLAYER_RADIUS + 0.04;
        const maxZ = next.z - next.d / 2 - margin - 0.04;
        if (minZ > maxZ) throw new Error(`Stair tread lacks clearance: ${route.id}`);
        chain.push({ x: step.x, y: height, z: (minZ + maxZ) / 2 });
      }
      chain.push({ ...route.exit }); chains.push(chain); candidates.push(...chain);
    }
    const unique = new Map<string, Vec3>();
    for (const p of candidates) if (this.isWalkable(p)) unique.set(`${p.x.toFixed(4)}:${p.y.toFixed(4)}:${p.z.toFixed(4)}`, p);
    this.nodes = [...unique.values()];
    this.edges = this.nodes.map(() => []);
    for (let a = 0; a < this.nodes.length; a++) for (let b = a + 1; b < this.nodes.length; b++) {
      if (this.clearSegment(this.nodes[a]!, this.nodes[b]!)) this.link(a, b);
    }
    for (const chain of chains) {
      const indices = chain.map(p => this.nodes.findIndex(q => distance(p, q) < 0.001 && sameHeight(p, q)));
      if (indices.includes(-1)) throw new Error(`Stair route is obstructed: ${JSON.stringify(chain[indices.indexOf(-1)])}`);
      for (let i = 1; i < indices.length; i++) this.link(indices[i - 1]!, indices[i]!);
    }
    const reachable = new Set<number>([0]), pending = [0];
    for (let i = 0; i < pending.length; i++) for (const edge of this.edges[pending[i]!]!) {
      if (!reachable.has(edge.to)) { reachable.add(edge.to); pending.push(edge.to); }
    }
    this.patrolPoints = this.nodes.filter((p, i) => reachable.has(i) && !this.layerAt(p)!.stairs && Math.abs(p.x) < 29 && Math.abs(p.z) < 22);
  }
  private link(a: number, b: number) {
    const cost = distance(this.nodes[a]!, this.nodes[b]!) + Math.abs(this.nodes[a]!.y - this.nodes[b]!.y);
    this.edges[a]!.push({ to: b, cost }); this.edges[b]!.push({ to: a, cost });
  }
  private layerAt(p: Vec3) { return this.layers.find(l => Math.abs(l.height - p.y) < 0.06 && l.contactSupports.some(r => inside(p, r))); }
  private simplify(start: Vec3, path: Vec3[]) {
    const result: Vec3[] = [];
    let anchor = start;
    for (let i = 0; i < path.length;) {
      let next = i;
      // Only skip within one continuous floor. Keep every elevation change.
      while (next + 1 < path.length && this.clearSegment(anchor, path[next + 1]!)) next++;
      anchor = path[next]!; result.push(anchor); i = next + 1;
    }
    return result;
  }
  private supports(layer: Layer, a: Vec3, b = a, padding = margin) {
    const offsets = layer.stairs ? [[-padding, 0], [padding, 0]] : [[-padding, -padding], [-padding, padding], [padding, -padding], [padding, padding]];
    return offsets.every(([x, z]) => covered({ x: a.x + x!, y: a.y, z: a.z + z! }, { x: b.x + x!, y: b.y, z: b.z + z! }, layer.supports));
  }
  isWalkable(p: Vec3): boolean {
    const layer = this.layerAt(p);
    return !!layer && this.supports(layer, p) && !layer.obstacles.some(r => p.x > r.minX + 0.001 && p.x < r.maxX - 0.001 && p.z > r.minZ + 0.001 && p.z < r.maxZ - 0.001);
  }
  clearSegment(a: Vec3, b: Vec3): boolean {
    if (!sameHeight(a, b) || !this.isWalkable(a) || !this.isWalkable(b)) return false;
    const layer = this.layerAt(a)!;
    return this.layerAt(b) === layer && this.supports(layer, a, b) && !layer.obstacles.some(r => interval(a, b, r, 0.001));
  }
  requiresAscent(from: Vec3, observed: Vec3): boolean {
    const target = { ...observed, y: supportHeight(observed) }, layer = this.layerAt(target);
    return !!layer && layer.height > 0 && !sameHeight(from, target);
  }
  findPath(start: Vec3, requested: Vec3): Vec3[] {
    const grounded = { ...start, y: supportHeight(start) }, layer = this.layerAt(grounded);
    if (!layer) return [];
    if (!sameHeight(start, grounded)) return [grounded, ...this.findPath(grounded, requested)];
    if (!this.isWalkable(start)) {
      const exits = this.nodes.filter(p => this.layerAt(p) === layer && !layer.physical.some(r => interval(start, p, r, 0.001)) && covered(start, p, layer.contactSupports))
        .sort((a, b) => distance(start, a) - distance(start, b));
      const exit = exits[0]; return exit ? [exit, ...this.findPath(exit, requested)] : [];
    }
    const desired = { ...requested, y: supportHeight(requested) };
    const targetLayer = this.layerAt(desired) ?? this.layers[0]!;
    const choices = this.nodes.filter(p => this.layerAt(p) === targetLayer);
    const goal = this.isWalkable(desired) ? desired : choices.sort((a, b) => distance(a, requested) - distance(b, requested))[0];
    if (!goal) return [];
    if (this.clearSegment(start, goal)) return [{ ...goal }];
    const count = this.nodes.length, end = count + 1, points = [...this.nodes, start, goal];
    const links = this.edges.map(list => [...list]); links.push([], []);
    for (let i = 0; i < count; i++) {
      if (this.clearSegment(start, points[i]!)) links[count]!.push({ to: i, cost: distance(start, points[i]!) });
      if (this.clearSegment(points[i]!, goal)) links[i]!.push({ to: end, cost: distance(points[i]!, goal) });
    }
    const costs = new Float64Array(count + 2).fill(Infinity), previous = new Int32Array(count + 2).fill(-1), visited = new Uint8Array(count + 2);
    costs[count] = 0;
    for (let n = 0; n < count + 2; n++) {
      let current = -1, best = Infinity;
      for (let i = 0; i < count + 2; i++) { const score = costs[i]! + distance(points[i]!, goal); if (!visited[i] && score < best) { current = i; best = score; } }
      if (current < 0) return [];
      if (current === end) { const path: Vec3[] = []; for (let i = end; i !== count; i = previous[i]!) { if (i < 0) return []; path.push({ ...points[i]! }); } return this.simplify(start, path.reverse()); }
      visited[current] = 1;
      for (const edge of links[current]!) { const cost = costs[current]! + edge.cost; if (cost < costs[edge.to]!) { costs[edge.to] = cost; previous[edge.to] = current; } }
    }
    return [];
  }
}
