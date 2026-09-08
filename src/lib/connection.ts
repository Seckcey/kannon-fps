import type { ClientMessage, GameEvent, RoomSnapshot, ServerMessage, WorldSnapshot } from '../../shared/protocol';

export interface ConnectionState {
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline';
  playerId: string;
  room: RoomSnapshot | null;
  snapshot: WorldSnapshot | null;
  events: GameEvent[];
  error: string;
  latency: number;
}
const initial: ConnectionState = { status: 'idle', playerId: '', room: null, snapshot: null, events: [], error: '', latency: 0 };

export class ArenaConnection {
  private state: ConnectionState = { ...initial };
  private listeners = new Set<() => void>();
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private attempts = 0;
  private closed = false;
  private roomCode = '';
  private opening: Promise<void> | null = null;
  private resolveOpen: (() => void) | null = null;
  private rejectOpen: ((error: Error) => void) | null = null;
  private welcomeTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private token: string) {}
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private update(patch: Partial<ConnectionState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(fn => fn());
  }
  clearError = () => this.update({ error: '' });
  connect = (): Promise<void> => {
    if (this.state.status === 'connected') return Promise.resolve();
    if (this.opening) return this.opening;
    this.closed = false;
    this.update({ status: this.roomCode ? 'reconnecting' : 'connecting', error: '' });
    this.opening = new Promise((resolve, reject) => { this.resolveOpen = resolve; this.rejectOpen = reject; });
    const promise = this.opening;
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    this.socket = socket;
    this.welcomeTimer = setTimeout(() => {
      if (this.socket === socket && this.state.status !== 'connected') {
        this.rejectOpen?.(new Error('The arena did not respond. Please try again.'));
        this.resetOpening(); socket.close();
      }
    }, 10000);
    socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', token: this.token } satisfies ClientMessage));
    socket.onmessage = message => {
      if (socket !== this.socket) return;
      let data: ServerMessage;
      try { data = JSON.parse(message.data); } catch { return; }
      switch (data.type) {
        case 'welcome': {
          this.attempts = 0;
          this.update({ status: 'connected', playerId: data.playerId, error: '' });
          this.resolveOpen?.(); this.resetOpening();
          if (this.roomCode) this.send({ type: 'join', code: this.roomCode });
          clearInterval(this.pingTimer);
          this.pingTimer = setInterval(() => this.send({ type: 'ping', t: Date.now() }), 2000);
          break;
        }
        case 'room': this.roomCode = data.room.code; this.update({ room: data.room, error: '' }); break;
        case 'snapshot': this.update({ snapshot: data.snapshot }); break;
        case 'event': this.update({ events: [...this.state.events.slice(-23), data.event] }); break;
        case 'pong': this.update({ latency: Math.max(0, Date.now() - data.t) }); break;
        case 'error':
          if (data.code === 'ROOM_EXPIRED' || data.code === 'ROOM_NOT_FOUND') {
            this.roomCode = '';
            this.update({ error: data.message, room: null, snapshot: null, events: [] });
          } else this.update({ error: data.message });
          if (this.opening) { this.rejectOpen?.(new Error(data.message)); this.resetOpening(); }
          break;
      }
    };
    socket.onclose = event => {
      if (socket !== this.socket || this.closed) return;
      clearInterval(this.pingTimer);
      this.rejectOpen?.(new Error('Connection closed. Please try again.')); this.resetOpening();
      if (event.code === 4001 || event.code === 1008) {
        this.roomCode = '';
        this.update({ status: 'offline', room: null, snapshot: null, events: [], error: event.code === 4001 ? 'This player opened the game on another tab or device. Use a different player to play together.' : this.state.error || 'The connection was stopped. Rejoin when you are ready.' });
        return;
      }
      this.update({ status: this.roomCode && this.attempts < 8 ? 'reconnecting' : 'offline' });
      if (this.roomCode && this.attempts < 8) {
        this.timer = setTimeout(() => { void this.connect().catch(() => {}); }, Math.min(5000, 500 * 2 ** this.attempts++));
      }
    };
    socket.onerror = () => { /* close handles retry; never surface token-bearing network details */ };
    return promise;
  };
  private resetOpening() {
    clearTimeout(this.welcomeTimer); this.opening = null; this.resolveOpen = null; this.rejectOpen = null;
  }
  send(message: ClientMessage) {
    if (this.socket?.readyState === WebSocket.OPEN && this.state.status === 'connected') this.socket.send(JSON.stringify(message));
  }
  leave() {
    this.roomCode = '';
    this.send({ type: 'leave' });
    this.update({ room: null, snapshot: null, events: [], error: '' });
  }
  dispose() {
    this.closed = true; clearTimeout(this.timer); clearInterval(this.pingTimer);
    this.rejectOpen?.(new Error('Connection closed.')); this.resetOpening();
    if (this.socket) { this.socket.onclose = null; this.socket.close(); }
    this.listeners.clear();
  }
}
