// GameScreen logic that runs outside React (input pacing, the Tab key, respawn detection), so the Node
// tests can drive it.
import type { InputFrame } from '../../shared/protocol';

/** Input frames per second. The server moves a player one 1/30 s step for each frame, and the local
 * prediction moves one step for each frame sent. */
export const INPUT_HZ = 30;
/** A timer that wakes late catches up at most this many frames at once. */
export const MAX_FRAMES_PER_WAKE = 2;

/**
 * Paces input frames at exactly 30 a second, on a fixed wall-clock grid. Browsers run
 * setInterval(…, 1000 / 30) every 33 ms, which is 30.3 frames a second: the extra frames moved the
 * predicted body faster than the server, and it was pulled back every couple of seconds.
 * A late timer sends the frames it owes, at most two at once; frames missed in a longer stall (a slow
 * frame, a tab in the background) are skipped, never sent as a burst.
 */
export class InputPacer {
  private origin: number | null = null;
  /** Grid frames already handed out (sent or skipped). */
  private taken = 0;
  constructor(private readonly interval = 1000 / INPUT_HZ, private readonly most = MAX_FRAMES_PER_WAKE) {}

  /** How many frames to send now (wall-clock ms, such as performance.now()). */
  take(now: number): number {
    if (this.origin === null) { this.origin = now; this.taken = 1; return 1; }
    const due = Math.floor((now - this.origin) / this.interval + 1e-6) + 1;
    const owed = due - this.taken;
    if (owed <= 0) return 0;
    this.taken = due;
    return Math.min(owed, this.most);
  }

  /** Milliseconds until the next frame is due, rounded up so a timer never wakes before it. */
  wait(now: number): number {
    if (this.origin === null) return 0;
    return Math.max(0, Math.ceil(this.origin + this.taken * this.interval - now));
  }
}

/** What sending needs from the game view. */
export interface InputView {
  /** False while dead and until the new life's spawn view is applied: frames sent then would carry the
   * death-time view and weapon into the new life. */
  readonly inputLive: boolean;
  /** The touch trigger assist for the frame about to be built; true while it is on a target. */
  prepareAutomaticFire(): boolean;
  /** Moves the local prediction one step for a frame that was sent. */
  recordInput(frame: InputFrame): void;
}

/**
 * Sends `count` frames: each is built once (`next`, which consumes one sequence number), sent once and
 * recorded once, so the prediction moves exactly one step per frame the server receives. Nothing is
 * built or sent while the view is not live. Returns whether the trigger assist is on a target.
 */
export function sendInputFrames(count: number, view: InputView, next: () => InputFrame, send: (frame: InputFrame) => void): boolean {
  // While dead the assist has no target, which also clears the target it held before.
  if (!view.inputLive) return count > 0 && view.prepareAutomaticFire();
  let onTarget = false;
  for (let i = 0; i < count; i++) {
    // Once per frame: a semi-automatic weapon pulls its trigger on alternate frames.
    onTarget = view.prepareAutomaticFire();
    const frame = next();
    send(frame);
    view.recordInput(frame);
  }
  return onTarget;
}

/**
 * Desktop standings while Tab is held. With a menu open, Tab is left to the browser so keyboard players
 * can move between the menu's controls. The key-up never arrives when focus leaves the page mid-press,
 * so leaving the window or switching apps closes the standings too. Returns a function that removes the
 * listeners.
 */
export function holdTabForScores(win: EventTarget, doc: EventTarget, menuOpen: () => boolean, show: (open: boolean) => void): () => void {
  const isTab = (event: Event) => (event as KeyboardEvent).code === 'Tab';
  const down = (event: Event) => { if (!isTab(event) || menuOpen()) return; event.preventDefault(); show(true); };
  const up = (event: Event) => { if (isTab(event)) show(false); };
  const close = () => show(false);
  win.addEventListener('keydown', down); win.addEventListener('keyup', up); win.addEventListener('blur', close);
  doc.addEventListener('visibilitychange', close);
  return () => {
    win.removeEventListener('keydown', down); win.removeEventListener('keyup', up); win.removeEventListener('blur', close);
    doc.removeEventListener('visibilitychange', close);
  };
}

/** Notices the moment the local player is back in after waiting to respawn. */
export class RespawnWatch {
  private dead = false;
  /** Feed the local player's health from each snapshot (undefined while there is none); true once, on
   * the respawn. */
  respawned(health: number | undefined): boolean {
    if (health === undefined) return false;
    const back = this.dead && health > 0;
    this.dead = health <= 0;
    return back;
  }
}
