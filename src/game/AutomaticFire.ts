import type { GameMode, PublicPlayerState, Team, Vec3 } from '../../shared/protocol';
import { add, magnitude, normalize, rayHitboxes, raycastMap, scale, subtract } from '../../shared/physics';

export type ReticleCandidate = Pick<PublicPlayerState, 'id' | 'x' | 'y' | 'z' | 'posture' | 'health' | 'protectedUntil'> & { team?: Team };

/** Input assistance only: the normal server trace still decides every hit.
 * Uses displayed opponent positions, their posture hitboxes and the actual eye ray, with a
 * second obstruction check from the weapon muzzle so a lowered barrel cannot fire through cover.
 * Teammates are not targets (bullets pass through them). A living player whose connection dropped
 * is: the body stays where it stood and can still be hit. */
export function reticleTarget(origin: Vec3, direction: Vec3, muzzle: Vec3, targets: readonly ReticleCandidate[], localId: string, now: number, range: number,
  team?: { mode: GameMode; team?: Team }): string | null {
  let distance = raycastMap(origin, direction, range), selected: ReticleCandidate | null = null;
  for (const target of targets) {
    if (target.id === localId || target.health <= 0) continue;
    if (team?.mode === 'tdm' && team.team && target.team === team.team) continue;
    const hit = rayHitboxes(origin, direction, { x: target.x, y: target.y, z: target.z, posture: target.posture ?? 'stand' }, distance);
    if (hit && hit.distance < distance) { selected = target; distance = hit.distance; }
  }
  if (!selected || selected.protectedUntil > now) return null;
  const aimPoint = add(origin, scale(direction, distance + 0.01));
  const barrel = subtract(aimPoint, muzzle), length = magnitude(barrel);
  if (length > 1e-6 && raycastMap(muzzle, normalize(barrel), length) < length - 0.025) return null;
  return selected.id;
}

/** Simple-mode trigger: fires after the reticle has rested on one target for 100 ms. Semi-automatic
 * weapons fire once per press, so their trigger is pulsed on alternate network frames. */
export class AutomaticFire {
  private target: string | null = null;
  private acquired = 0;
  private pulse = false;
  update(target: string | null, now: number, semiAutomatic = false): boolean {
    if (target !== this.target) { this.target = target; this.acquired = now; this.pulse = false; }
    const engaged = !!target && now - this.acquired >= 100;
    if (!engaged) { this.pulse = false; return false; }
    if (!semiAutomatic) return true;
    this.pulse = !this.pulse;
    return this.pulse;
  }
  reset() { this.target = null; this.acquired = 0; this.pulse = false; }
}
