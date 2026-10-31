import { ARENA_LIMITS, OBSTACLES, SPAWNS, STAIR_ROUTES } from '../shared/map.js';
import { PLAYER_HEIGHT, PLAYER_RADIUS, supportHeight } from '../shared/physics.js';
import type { Vec3 } from '../shared/protocol.js';

interface Rectangle { minX: number; maxX: number; minZ: number; maxZ: number }
interface Layer {
  height: number; supports: Rectangle[]; contactSupports: Rectangle[]; obstacles: Rectangle[];
  /** Blockers grown by the body radius plus 5 mm: what a straight move must stay out of. */
  physical: Rectangle[];
  /** The same blockers grown by 2 cm less than the body radius: where a body can never be without
   * overlapping the blocker. Judges moves for a body already resting against that blocker. */
  contact: Rectangle[];
  /** Blockers grown by exactly the body radius: a body centred strictly inside overlaps the blocker. */
  footprint: Rectangle[];
  stairs: boolean;
}
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
  /** Waypoints joined to the main network (the one patrols use); routes out of padding only head for these. */
  private readonly main: boolean[];
  /** The floor each waypoint stands on (every waypoint is walkable). */
  private readonly nodeLayers: Layer[];
  constructor() {
    const surfaces = OBSTACLES.filter(b => b.kind === 'step' || b.kind === 'platform');
    const heights = [...new Set([0, ...surfaces.map(b => +(b.y + b.h / 2).toFixed(5))])];
    for (const height of heights) {
      const own = surfaces.filter(b => Math.abs(b.y + b.h / 2 - height) < 0.001), stairs = height > 0 && own.every(b => b.kind === 'step');
      const blockers = OBSTACLES.filter(b => b.y + b.h / 2 > height + 0.02 && b.y - b.h / 2 < height + PLAYER_HEIGHT - 0.01);
      const supports = height === 0 ? [{ minX: -ARENA_LIMITS.x, maxX: ARENA_LIMITS.x, minZ: -ARENA_LIMITS.z, maxZ: ARENA_LIMITS.z }]
        : own.map(b => stairs ? { ...rect(b, PLAYER_RADIUS - 0.01), minX: b.x - b.w / 2, maxX: b.x + b.w / 2 } : rect(b));
      const contactSupports = height === 0 ? supports : own.map(b => rect(b, PLAYER_RADIUS - .005));
      this.layers.push({
        height, supports, contactSupports, stairs, obstacles: blockers.map(b => rect(b, margin)),
        physical: blockers.map(b => rect(b, PLAYER_RADIUS + 0.005)), contact: blockers.map(b => rect(b, PLAYER_RADIUS - 0.02)),
        footprint: blockers.map(b => rect(b, PLAYER_RADIUS)),
      });
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
    // A waypoint keeps the exact height of the floor it stands on: the first stair tread (0.32 m) is close
    // enough to the truck bed (0.36 m) to share its tolerance, but must not leave waypoints on the bed.
    for (const p of candidates) if (this.isWalkable(p) && Math.abs(this.layerAt(p)!.height - p.y) < 1e-6) unique.set(`${p.x.toFixed(4)}:${p.y.toFixed(4)}:${p.z.toFixed(4)}`, p);
    this.nodes = [...unique.values()];
    this.nodeLayers = this.nodes.map(p => this.layerAt(p)!);
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
    this.main = this.nodes.map((_, i) => reachable.has(i));
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
    return this.layerAt(b) === layer && this.span(layer, a, b);
  }
  /** clearSegment between a walkable point on `layer` and waypoint `i`, without re-checking what is already known. */
  private clearToNode(a: Vec3, layer: Layer, i: number): boolean {
    return this.nodeLayers[i] === layer && sameHeight(a, this.nodes[i]!) && this.span(layer, a, this.nodes[i]!);
  }
  private span(layer: Layer, a: Vec3, b: Vec3): boolean {
    return this.supports(layer, a, b) && !layer.obstacles.some(r => interval(a, b, r, 0.001));
  }
  /** A straight move out of the padding from `start` that never runs into a blocker. A body resting against a
   * wall sits inside that wall's padded rectangle, so for walls the start already touches only the wall itself
   * counts: sliding along it or stepping away is fine, pushing into it is not. */
  private leaves(layer: Layer, start: Vec3, to: Vec3): boolean {
    return !layer.physical.some((r, i) => interval(start, to, inside(start, r) ? layer.contact[i]! : r, 0.001));
  }
  /** For alleys and pockets narrower than the walking margin (beside the outside stairs, behind a counter), where
   * no waypoint is in a straight line: the shortest way out to walkable floor through places the body fits (it may
   * touch walls), found on a 10 cm grid within 6 m and straightened. Empty when there is none. */
  private stepOut(layer: Layer, start: Vec3): Vec3[] {
    const cell = 0.1, reach = 60, size = reach * 2 + 1, span = reach * cell + 0.5;
    const near = layer.footprint.filter(r => r.maxX > start.x - span && r.minX < start.x + span && r.maxZ > start.z - span && r.minZ < start.z + span);
    const at = (i: number): Vec3 => ({ x: start.x + (i % size - reach) * cell, y: start.y, z: start.z + (Math.floor(i / size) - reach) * cell });
    const open = (p: Vec3) => this.layerAt(p) === layer && !near.some(r => p.x > r.minX && p.x < r.maxX && p.z > r.minZ && p.z < r.maxZ);
    const clear = (a: Vec3, b: Vec3) => covered(a, b, layer.contactSupports) && !near.some(r => interval(a, b, r, 0.001));
    // Breadth-first over open cells: 0 unseen, 1 open and queued, 2 blocked.
    const origin = reach * size + reach, previous = new Int32Array(size * size), state = new Uint8Array(size * size), queue = [origin];
    previous[origin] = origin; state[origin] = 1;
    for (let head = 0; head < queue.length; head++) {
      const index = queue[head]!, p = index === origin ? start : at(index);
      if (index !== origin && this.isWalkable(p) && this.joins(p)) {
        const cells: Vec3[] = [];
        for (let i = index; i !== origin; i = previous[i]!) cells.push(at(i));
        cells.reverse();
        // Keep only the turns: from each kept point, the farthest cell still in a straight line the body fits along.
        const way: Vec3[] = [];
        let anchor = start;
        for (let i = 0; i < cells.length;) {
          let next = i;
          while (next + 1 < cells.length && clear(anchor, cells[next + 1]!)) next++;
          anchor = cells[next]!; way.push(anchor); i = next + 1;
        }
        return way;
      }
      const column = index % size, row = Math.floor(index / size);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        const c = column + dx, r = row + dz, neighbour = r * size + c;
        if (c < 0 || r < 0 || c >= size || r >= size || state[neighbour]) continue;
        state[neighbour] = open(at(neighbour)) ? 1 : 2;
        if (state[neighbour] === 1) { previous[neighbour] = index; queue.push(neighbour); }
      }
    }
    return [];
  }
  /** True when a straight, clear walk joins walkable `p` to the main network. */
  private joins(p: Vec3): boolean {
    const layer = this.layerAt(p)!;
    return this.nodes.some((_, i) => this.main[i] && this.clearToNode(p, layer, i));
  }
  /** The way out for a body inside the padding, or on walkable floor the network does not reach (the sill of a
   * balcony door): straight to the nearest network waypoint it can reach without pushing into a wall, else a
   * short way out found on a grid. */
  private leave(layer: Layer, start: Vec3, requested: Vec3, depth: number): Vec3[] {
    if (depth > 3) return [];
    const exits = this.nodes.filter((p, i) => this.main[i] && this.nodeLayers[i] === layer && this.leaves(layer, start, p) && covered(start, p, layer.contactSupports))
      .sort((a, b) => distance(start, a) - distance(start, b));
    if (exits[0]) return [exits[0], ...this.route(exits[0], requested, depth + 1)];
    const way = this.stepOut(layer, start);
    return way.length ? [...way, ...this.route(way[way.length - 1]!, requested, depth + 1)] : [];
  }
  /** Unit direction back toward walkable floor for a body pressed into an obstacle's padding or standing off
   * the floor graph: straight out of every padded obstacle it is in, else toward the nearest waypoint on its floor. */
  escapeDirection(p: Vec3): { x: number; z: number } | null {
    const layer = this.layerAt({ ...p, y: supportHeight(p) });
    if (!layer) return null;
    let x = 0, z = 0;
    for (const r of layer.obstacles) {
      if (p.x <= r.minX || p.x >= r.maxX || p.z <= r.minZ || p.z >= r.maxZ) continue;
      const ways: Array<readonly [number, number, number]> = [[p.x - r.minX, -1, 0], [r.maxX - p.x, 1, 0], [p.z - r.minZ, 0, -1], [r.maxZ - p.z, 0, 1]];
      const [, wx, wz] = ways.reduce((a, b) => (b[0] < a[0] ? b : a));
      x += wx; z += wz;
    }
    if (Math.hypot(x, z) < 1e-6) {
      let nearest: Vec3 | null = null;
      for (let i = 0; i < this.nodes.length; i++) {
        const node = this.nodes[i]!;
        if (this.main[i] && this.nodeLayers[i] === layer && (!nearest || distance(p, node) < distance(p, nearest))) nearest = node;
      }
      if (!nearest) return null;
      x = nearest.x - p.x; z = nearest.z - p.z;
    }
    const length = Math.hypot(x, z);
    return length > 1e-6 ? { x: x / length, z: z / length } : null;
  }
  requiresAscent(from: Vec3, observed: Vec3): boolean {
    const target = { ...observed, y: supportHeight(observed) }, layer = this.layerAt(target);
    return !!layer && layer.height > 0 && !sameHeight(from, target);
  }
  findPath(start: Vec3, requested: Vec3): Vec3[] { return this.route(start, requested, 0); }
  private route(start: Vec3, requested: Vec3, depth: number): Vec3[] {
    const grounded = { ...start, y: supportHeight(start) }, layer = this.layerAt(grounded);
    if (!layer) return [];
    if (!sameHeight(start, grounded)) return depth > 3 ? [] : [grounded, ...this.route(grounded, requested, depth + 1)];
    if (!this.isWalkable(start)) return this.leave(layer, start, requested, depth);
    const desired = { ...requested, y: supportHeight(requested) };
    const targetLayer = this.layerAt(desired) ?? this.layers[0]!;
    const choices = this.nodes.filter((_, i) => this.nodeLayers[i] === targetLayer);
    const goal = this.isWalkable(desired) ? desired : choices.sort((a, b) => distance(a, requested) - distance(b, requested))[0];
    if (!goal) return [];
    if (this.clearSegment(start, goal)) return [{ ...goal }];
    // The start and the goal are both walkable and every waypoint is, so each link needs only the floor and line checks.
    const startLayer = this.layerAt(start)!, goalLayer = this.layerAt(goal)!;
    const count = this.nodes.length, end = count + 1, points = [...this.nodes, start, goal];
    const links = this.edges.map(list => [...list]); links.push([], []);
    for (let i = 0; i < count; i++) {
      if (this.clearToNode(start, startLayer, i)) links[count]!.push({ to: i, cost: distance(start, points[i]!) });
      if (this.nodeLayers[i] === goalLayer && sameHeight(points[i]!, goal) && this.span(goalLayer, points[i]!, goal)) links[i]!.push({ to: end, cost: distance(points[i]!, goal) });
    }
    // Walkable, but not joined to the main network (a door sill the network does not cross): step off it first.
    if (!links[count]!.some(edge => this.main[edge.to])) return this.leave(layer, start, requested, depth);
    const costs = new Float64Array(count + 2).fill(Infinity), previous = new Int32Array(count + 2).fill(-1), visited = new Uint8Array(count + 2);
    const toGoal = Float64Array.from(points, p => distance(p, goal));
    costs[count] = 0;
    for (let n = 0; n < count + 2; n++) {
      let current = -1, best = Infinity;
      for (let i = 0; i < count + 2; i++) { const score = costs[i]! + toGoal[i]!; if (!visited[i] && score < best) { current = i; best = score; } }
      if (current < 0) return [];
      if (current === end) { const path: Vec3[] = []; for (let i = end; i !== count; i = previous[i]!) { if (i < 0) return []; path.push({ ...points[i]! }); } return this.simplify(start, path.reverse()); }
      visited[current] = 1;
      for (const edge of links[current]!) { const cost = costs[current]! + edge.cost; if (cost < costs[edge.to]!) { costs[edge.to] = cost; previous[edge.to] = current; } }
    }
    return [];
  }
}
