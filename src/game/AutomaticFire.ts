import type { PlayerState, Vec3 } from '../../shared/protocol';
import { add, magnitude, normalize, PLAYER_HEIGHT, PLAYER_RADIUS, rayBox, raycastMap, scale, subtract } from '../../shared/physics';

/** Input assistance only: the normal server raycast still decides every hit.
 * Use displayed opponent positions and the actual camera ray, with a second
 * obstruction check from the muzzle so shoulder peeking cannot fire through cover. */
export function reticleTarget(origin: Vec3, direction: Vec3, muzzle: Vec3, targets: readonly PlayerState[], localId: string, now: number, range: number): string | null {
  let distance = raycastMap(origin, direction, range), selected: PlayerState | null = null;
  for (const target of targets) {
    if (target.id === localId || !target.connected || target.health <= 0) continue;
    const hit = rayBox(origin, direction,
      { x: target.x - PLAYER_RADIUS, y: target.y, z: target.z - PLAYER_RADIUS },
      { x: target.x + PLAYER_RADIUS, y: target.y + PLAYER_HEIGHT, z: target.z + PLAYER_RADIUS }, distance);
    if (hit < distance) { selected = target; distance = hit; }
  }
  if (!selected || selected.protectedUntil > now) return null;
  const aimPoint = add(origin, scale(direction, distance + 0.01));
  const barrel = subtract(aimPoint, muzzle), length = magnitude(barrel);
  if (raycastMap(muzzle, normalize(barrel), length) < length - 0.025) return null;
  return selected.id;
}

export class AutomaticFire {
  private target: string | null = null;
  private acquired = 0;
  update(target: string | null, now: number): boolean {
    if (target !== this.target) { this.target = target; this.acquired = now; }
    return !!target && now - this.acquired >= 100;
  }
  reset() { this.target = null; this.acquired = 0; }
}
