import type { PlayerState, WorldSnapshot } from '../../shared/protocol';

interface RespawnEvent {
  at: number;
  receivedNow: number;
  pending: boolean;
}

/** Wait for the authoritative alive snapshot before placing respawn feedback.
 * Eight slots also retain consumed timestamps, preventing duplicate delivery
 * without accumulating a history as players enter and leave the room.
 */
export class DeferredRespawns {
  private readonly events = new Map<string, RespawnEvent>();
  private disposed = false;

  enqueue(playerId: string, at: number, receivedNow: number): void {
    if (this.disposed || !playerId || !Number.isFinite(at) || !Number.isFinite(receivedNow)) return;
    const previous = this.events.get(playerId);
    if (previous && previous.at >= at) return;
    this.events.delete(playerId);
    if (this.events.size >= 8) this.events.delete(this.events.keys().next().value!);
    this.events.set(playerId, { at, receivedNow, pending: true });
  }

  flush(snapshot: WorldSnapshot, now: number, emit: (player: PlayerState) => void): void {
    if (this.disposed || !Number.isFinite(now)) return;
    if (snapshot.phase !== 'playing') { this.clear(); return; }
    // Snapshot the bounded entries so an emit callback may safely clear, dispose
    // or enqueue work without replaying it within this same flush.
    for (const [id, event] of Array.from(this.events)) {
      if (this.disposed || this.events.get(id) !== event || !event.pending) continue;
      if (now - event.receivedNow >= 1_000) { event.pending = false; continue; }
      if (!Number.isFinite(snapshot.serverTime) || snapshot.serverTime < event.at) continue;
      event.pending = false;
      const player = snapshot.players.find(candidate => candidate.id === id);
      if (player?.connected && player.health > 0) emit(player);
    }
  }

  clear(): void { this.events.clear(); }

  dispose(): void { this.disposed = true; this.clear(); }
}
