import type { Phase } from '../../shared/protocol';

export interface PreparationContext {
  roomId: string;
  phase?: Phase;
  preparationId?: string;
  connected: boolean;
  assetsReady: boolean;
  blocked: boolean;
}
interface EngagementInput {
  readonly canEngage: boolean;
  readonly locked: boolean;
  requestPointerLock(): Promise<boolean>;
  subscribeReset(listener: () => void): () => void;
}
export interface ReadinessState { ready: boolean; pending: boolean; error: string }
const emptyState = (): ReadinessState => ({ ready: false, pending: false, error: '' });

/** Local engagement belongs to one preparation and one uninterrupted connection/focus session. */
export class PreparationReadiness {
  private state = emptyState();
  private identity = '';
  private generation = 0;
  private disposed = false;
  private unsubscribe: () => void;

  constructor(
    private input: EngagementInput,
    private context: () => PreparationContext,
    private send: (preparationId: string, ready: boolean) => void,
    private changed: (state: ReadinessState) => void,
  ) {
    this.unsubscribe = input.subscribeReset(() => this.invalidate(true));
    this.sync();
  }

  /** Call synchronously on connection changes, and when artwork/menu availability changes. */
  sync() {
    if (this.disposed) return;
    const current = this.context();
    const identity = current.phase === 'preparing' ? `${current.roomId}:${current.preparationId ?? ''}` : '';
    if (this.identity !== identity) {
      this.invalidate(false);
      this.identity = identity;
    } else if (!this.available(current)) this.invalidate(true);
  }

  async engage(touch: boolean) {
    this.sync();
    if (this.disposed || !this.available(this.context()) || this.state.ready || this.state.pending) return;
    const generation = this.generation;
    const identity = this.identity;
    this.publish({ ready: false, pending: true, error: '' });
    // Touch engagement is the button itself; it must never synthesize a fire/move gesture.
    const captured = touch || await this.input.requestPointerLock();
    this.sync();
    if (this.disposed || generation !== this.generation || identity !== this.identity || !this.available(this.context())) return;
    if (!captured || (!touch && !this.input.locked)) {
      this.publish({ ready: false, pending: false, error: 'Mouse capture did not start. Click Ready to play to try again.' });
      return;
    }
    this.publish({ ready: true, pending: false, error: '' });
    this.send(this.context().preparationId!, true);
  }

  private available(context: PreparationContext) {
    return context.phase === 'preparing' && !!context.preparationId && context.connected && context.assetsReady && !context.blocked && this.input.canEngage;
  }

  private invalidate(withdraw: boolean) {
    const context = this.context();
    const matches = this.identity === `${context.roomId}:${context.preparationId ?? ''}`;
    const acknowledged = this.state.ready;
    this.generation++;
    this.publish(emptyState());
    if (withdraw && acknowledged && matches && context.connected && context.phase === 'preparing' && context.preparationId) this.send(context.preparationId, false);
  }

  private publish(state: ReadinessState) {
    if (this.state.ready === state.ready && this.state.pending === state.pending && this.state.error === state.error) return;
    this.state = state;
    if (!this.disposed) this.changed(state);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidate(true);
    this.unsubscribe();
  }
}
