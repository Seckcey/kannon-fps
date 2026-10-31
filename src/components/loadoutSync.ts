import type { Loadout } from '../../shared/protocol';

export interface LoadoutSyncOptions {
  /** Quiet time after the last change before it is sent, in milliseconds. */
  delayMs?: number;
  /** Shortest gap between two settled sends, well inside the server's allowance (20 in 10 seconds). */
  spacingMs?: number;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/**
 * Sends the player's chosen loadout to the server without flooding it while they browse classes and
 * perks. Menu changes go out once the player settles; closing the picker sends a waiting change at once;
 * joining a room or reconnecting always sends the current choice. The last choice is never dropped.
 */
export class LoadoutSync {
  private pending: Loadout | null = null;
  private lastSent = '';
  private lastSentAt = -Infinity;
  private timer: unknown = null;
  private readonly delayMs: number;
  private readonly spacingMs: number;
  private readonly now: () => number;
  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  constructor(private readonly send: (loadout: Loadout) => void, options: LoadoutSyncOptions = {}) {
    this.delayMs = options.delayMs ?? 300;
    this.spacingMs = options.spacingMs ?? 600;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    this.clearTimer = options.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  /** A menu changed the choice: send it once the player has settled on one. */
  change(loadout: Loadout) {
    this.pending = loadout;
    this.stopTimer();
    const now = this.now(), at = Math.max(now + this.delayMs, this.lastSentAt + this.spacingMs);
    this.timer = this.setTimer(() => { this.timer = null; this.flush(); }, at - now);
  }
  /** The picker closed or the match started: a waiting change goes out now. */
  flush() {
    const loadout = this.pending;
    this.stopTimer(); this.pending = null;
    if (loadout && JSON.stringify(loadout) !== this.lastSent) this.deliver(loadout);
  }
  /** A room was joined or the connection came back: the server gets the current choice now. */
  sendNow(loadout: Loadout) {
    this.stopTimer(); this.pending = null;
    this.deliver(loadout);
  }
  /** The connection went away; reconnecting sends the current choice anyway. */
  cancel() { this.stopTimer(); this.pending = null; }
  dispose() { this.cancel(); }

  private deliver(loadout: Loadout) {
    this.lastSent = JSON.stringify(loadout); this.lastSentAt = this.now();
    this.send(loadout);
  }
  private stopTimer() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
}
