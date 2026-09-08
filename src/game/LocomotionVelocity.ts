import type { PlayerState } from '../../shared/protocol';
import { SPRINT_SPEED } from '../../shared/physics';

type MotionSample = Pick<PlayerState, 'x' | 'y' | 'z' | 'vx' | 'vz' | 'health' | 'connected' | 'protectedUntil'>;

/** Character motion follows visible travel after collision and interpolation.
 * This owns presentation state only; it never changes physics or snapshots.
 */
export class LocomotionVelocity {
  private sampled = false;
  private x = 0;
  private y = 0;
  private z = 0;
  private protection = 0;
  private readonly velocity = { vx: 0, vz: 0 };

  reset(): void {
    this.sampled = false;
    this.velocity.vx = 0;
    this.velocity.vz = 0;
  }

  update(player: MotionSample, elapsed: number, source: 'local' | 'remote' = 'local'): Readonly<{ vx: number; vz: number }> {
    if (![player.x, player.y, player.z, player.vx, player.vz, player.health, player.protectedUntil, elapsed].every(Number.isFinite)
      || elapsed <= 0 || !player.connected || player.health <= 0) {
      this.reset();
      return this.velocity;
    }
    const dx = player.x - this.x, dz = player.z - this.z;
    const reset = !this.sampled || elapsed > .25 || player.protectedUntil > this.protection
      || Math.hypot(dx, player.y - this.y, dz) > 3.5;
    this.sampled = true;
    this.x = player.x; this.y = player.y; this.z = player.z;
    this.protection = player.protectedUntil;
    // Local input can stop animation immediately. Remote input and interpolation
    // intervals can advance ahead of the last visible displacement, so remote
    // gait uses measured travel with only the global movement-speed ceiling.
    const speedLimit = source === 'remote' ? SPRINT_SPEED : Math.min(SPRINT_SPEED, Math.hypot(player.vx, player.vz));
    if (reset || speedLimit < .001) {
      this.velocity.vx = 0; this.velocity.vz = 0;
      return this.velocity;
    }
    let vx = dx / elapsed, vz = dz / elapsed;
    const distanceSpeed = Math.hypot(vx, vz);
    // Reconciliation must not turn a positional correction into an animation
    // faster than local input permits or the remote player's maximum speed.
    if (distanceSpeed > speedLimit) {
      vx *= speedLimit / distanceSpeed;
      vz *= speedLimit / distanceSpeed;
    }
    // A short decay absorbs snapshot/interpolation noise and lets a wall stop
    // settle into idle, instead of indefinitely running against solid cover.
    const blend = 1 - Math.exp(-elapsed * 18);
    this.velocity.vx += (vx - this.velocity.vx) * blend;
    this.velocity.vz += (vz - this.velocity.vz) * blend;
    const smoothedSpeed = Math.hypot(this.velocity.vx, this.velocity.vz);
    if (smoothedSpeed > speedLimit) {
      this.velocity.vx *= speedLimit / smoothedSpeed;
      this.velocity.vz *= speedLimit / smoothedSpeed;
    }
    return this.velocity;
  }
}
