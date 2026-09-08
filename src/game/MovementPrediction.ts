import { movePlayer, type KinematicState } from '../../shared/physics';
import type { InputFrame, PlayerState, Slot } from '../../shared/protocol';

/** Movement restrictions confirmed by the latest authoritative snapshot.
 * Replay advances from that snapshot's server time, not the wall clock at which
 * old inputs happen to be replayed. New reload/heal starts remain server-owned.
 * The existing one-step-per-pending-input replay is an estimate: the server can
 * coalesce inputs, and its exact future arrival/tick assignment is not known.
 */
export class MovementPrediction {
  private time = 0;
  private slot: Slot = 1;
  private healingUntil = 0;
  private reloadingUntil = 0;

  reset(player: Pick<PlayerState, 'slot' | 'healingUntil' | 'reloadingUntil'>, serverTime: number): void {
    this.time = serverTime;
    this.slot = player.slot;
    this.healingUntil = player.healingUntil;
    this.reloadingUntil = player.reloadingUntil;
  }

  /** Returns the effective sprint state for camera presentation. */
  step(state: KinematicState, input: InputFrame, dt: number, canJump = true): boolean {
    const seconds = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
    this.time += seconds * 1_000;
    // The server cancels either action on a slot change before moving. Keep
    // this state across replay inputs so switching back cannot restore a lock.
    if (input.slot !== this.slot) {
      this.slot = input.slot;
      this.healingUntil = this.reloadingUntil = 0;
    }
    const sprint = input.sprint && !this.healingUntil && !this.reloadingUntil;
    movePlayer(state, { ...input, sprint }, seconds, canJump);
    // MatchEngine moves first, then completes timed actions. The first step
    // reaching/passing the deadline is still limited; the following step is not.
    if (this.healingUntil && this.time >= this.healingUntil) this.healingUntil = 0;
    if (this.reloadingUntil && this.time >= this.reloadingUntil) this.reloadingUntil = 0;
    return sprint && !input.aim;
  }
}
