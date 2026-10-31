import type { MoveEvents } from '../../shared/physics';
import type { InputFrame, Loadout, PlayerState, PublicPlayerState, WorldSnapshot } from '../../shared/protocol';
import { LocalWeapon, type WeaponEvent } from './LocalWeapon';
import { LocalPrediction, TICK_MS, vaultProgress } from './MovementPrediction';

/** The local player's predicted body and weapon. GameView feeds it every frame the page sends and every
 * snapshot it adopts; tests/client/server-parity.test.ts drives the same object against the real server.
 * Each sent frame is predicted one 1000/30 ms frame step after the one before it, which is exactly how the
 * server counts the player's own timers. */
export class LocalPlayer {
  readonly prediction = new LocalPrediction();
  readonly weapon: LocalWeapon;
  /** Frames sent since the body last stepped (the page was not live): each still runs a frame step later. */
  private unstepped = 0;
  private lastAck = 0;

  /** `loadout` until the first snapshot brings mine. */
  constructor(loadout?: Loadout) { this.weapon = new LocalWeapon(loadout); }

  /** One frame actually sent at wall-clock `wall` (ms). `live`: the server is simulating my frames now and the
   * newest snapshot is fresh, so the body steps too; `alive`: the server runs my weapon. `ads` is the sights'
   * blend for recoil. Returns the body's move events (null when it did not step) and the weapon's events. */
  send(frame: InputFrame, wall: number, live: boolean, alive: boolean, ads: number): { moved: MoveEvents | null; events: WeaponEvent[] } {
    // The server judges a new trigger press, the knife and a cook on the body before this frame's move.
    // A reference is enough: a move replaces or clears the vault, never edits it.
    const vaultBefore = this.prediction.movement.state.vault;
    const moved = this.prediction.record(frame, wall, live);
    this.unstepped = moved ? 0 : this.unstepped + 1;
    const state = this.prediction.movement.state, now = this.prediction.movement.time + this.unstepped * TICK_MS;
    const pressVault = moved ? vaultBefore : state.vault;
    const events = this.weapon.step(frame, {
      now, alive, sprinting: !!state.sprinting, dashing: !!state.dashing,
      vaultProgress: vaultProgress(state.vault, now), pressVaultProgress: vaultProgress(pressVault, now), vaultingBefore: !!pressVault, ads,
    });
    return { moved, events };
  }

  /** Adopt a snapshot: `local` is my public state in it and `self` my private one; `spawned` marks a new life,
   * a new round or the first snapshot. Returns whether the view should jump (see LocalPrediction.receive). */
  receive(snapshot: WorldSnapshot, local: PublicPlayerState, self: PlayerState | undefined, spawned: boolean, wall: number): boolean {
    const alive = local.health > 0 && local.connected;
    // A reconnect makes the server count my inputs again from 0. Every frame still held went down with
    // the old socket or was simulated before the drop, so the weapon and the body take the server's
    // state and replay none. (The server keeps my weapon slot, so this is not a new life.)
    const restarted = !spawned && local.lastInputSeq < this.lastAck;
    this.lastAck = local.lastInputSeq;
    // The server time my acknowledged input ran at: a queued input can run behind the tick.
    const ranAt = self?.lastInputTime ?? snapshot.serverTime;
    if (self) {
      if (spawned || restarted) this.weapon.reset(self, ranAt);
      else this.weapon.reconcile(self, local.lastInputSeq, ranAt);
    }
    this.unstepped = 0;
    return this.prediction.receive(self ? { ...local, ...self } : local, snapshot.serverTime, local.lastInputSeq,
      { playing: snapshot.phase === 'playing', alive, spawned, restarted }, wall);
  }
}
