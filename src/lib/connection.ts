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
const HEARTBEAT_MS = 2000;
const SILENT_CONNECTION_MS = 8000;

export class ArenaConnection {
  private state: ConnectionState = { ...initial };
  private listeners = new Set<() => void>();
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private probeTimer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private closed = false;
  private disposed = false;
  private lastMessageAt = 0;
  private roomCode = '';
  private opening: Promise<void> | null = null;
  private resolveOpen: (() => void) | null = null;
  private rejectOpen: ((error: Error) => void) | null = null;
  private welcomeTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private token: string) {
    window.addEventListener('online', this.resumeConnection);
    window.addEventListener('offline', this.networkOffline);
    window.addEventListener('pageshow', this.resumeConnection);
    document.addEventListener('visibilitychange', this.resumeConnection);
  }
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private update(patch: Partial<ConnectionState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(fn => fn());
  }
  clearError = () => this.update({ error: '' });
  connect = (): Promise<void> => {
    if (this.disposed) return Promise.reject(new Error('This connection has been closed.'));
    if (this.state.status === 'connected') return Promise.resolve();
    if (this.opening) return this.opening;
    clearTimeout(this.timer); this.timer = undefined;
    this.closed = false;
    this.update({ status: this.roomCode ? 'reconnecting' : 'connecting', error: '' });
    if (navigator.onLine === false) {
      this.update({ status: this.roomCode ? 'reconnecting' : 'offline' });
      return Promise.reject(new Error('You are offline. Check your connection and try again.'));
    }
    this.opening = new Promise((resolve, reject) => { this.resolveOpen = resolve; this.rejectOpen = reject; });
    const promise = this.opening;
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    this.socket = socket;
    this.lastMessageAt = Date.now();
    this.welcomeTimer = setTimeout(() => {
      if (this.socket === socket && this.state.status !== 'connected') {
        this.connectionLost(socket, 1006, 'The arena did not respond. Please try again.');
      }
    }, 10000);
    socket.onopen = () => { if (socket === this.socket && !this.closed) socket.send(JSON.stringify({ type: 'hello', token: this.token, readyProtocol: 1 } satisfies ClientMessage)); };
    socket.onmessage = message => {
      if (socket !== this.socket) return;
      let data: ServerMessage;
      try { data = JSON.parse(message.data); } catch { return; }
      if (!data || typeof data.type !== 'string') return;
      this.lastMessageAt = Date.now();
      clearTimeout(this.probeTimer); this.probeTimer = undefined;
      switch (data.type) {
        case 'welcome': {
          this.attempts = 0;
          this.update({ status: 'connected', playerId: data.playerId, error: '' });
          this.resolveOpen?.(); this.resetOpening();
          if (this.roomCode) this.send({ type: 'join', code: this.roomCode });
          clearInterval(this.pingTimer);
          this.pingTimer = setInterval(() => {
            if (document.hidden) return;
            if (!this.probeTimer && Date.now() - this.lastMessageAt >= SILENT_CONNECTION_MS) this.connectionLost(socket);
            else this.send({ type: 'ping', t: Date.now() });
          }, HEARTBEAT_MS);
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
    socket.onclose = event => this.connectionLost(socket, event.code);
    socket.onerror = () => { /* close handles retry; never surface token-bearing network details */ };
    return promise;
  };
  private connectionLost(socket: WebSocket, code = 1006, message = 'Connection closed. Please try again.', immediate = false) {
    if (socket !== this.socket || this.closed) return;
    // A dead TCP connection may take minutes to emit close. Retire it now so late
    // callbacks cannot overwrite a newer authenticated connection.
    this.socket = null;
    clearInterval(this.pingTimer); clearTimeout(this.timer); clearTimeout(this.probeTimer); this.probeTimer = undefined;
    this.rejectOpen?.(new Error(message)); this.resetOpening();
    socket.close();
    if (code === 4001 || code === 1008) {
      this.roomCode = '';
      this.update({ status: 'offline', room: null, snapshot: null, events: [], error: code === 4001 ? 'This player opened the game on another tab or device. Use a different player to play together.' : this.state.error || 'The connection was stopped. Rejoin when you are ready.' });
      return;
    }
    const retry = !!this.roomCode && this.attempts < 8;
    this.update({ status: retry ? 'reconnecting' : 'offline' });
    if (retry) {
      const delay = immediate ? 0 : Math.min(5000, 500 * 2 ** this.attempts);
      this.attempts++;
      this.timer = setTimeout(() => { this.timer = undefined; void this.connect().catch(() => {}); }, delay);
    }
  }
  private networkOffline = () => { if (this.socket) this.connectionLost(this.socket); };
  private resumeConnection = () => {
    if (this.disposed || this.closed || document.hidden || navigator.onLine === false) return;
    if (this.socket && this.state.status === 'connected') {
      this.send({ type: 'ping', t: Date.now() });
      if (!this.probeTimer && Date.now() - this.lastMessageAt >= SILENT_CONNECTION_MS) {
        const socket = this.socket;
        // Let queued snapshots or the probe reply arrive after browser suspension.
        // Replacing a healthy connection immediately would needlessly transfer host.
        this.probeTimer = setTimeout(() => {
          this.probeTimer = undefined;
          this.connectionLost(socket, 1006, undefined, true);
        }, 1500);
      }
    } else if (this.roomCode && !this.opening) {
      this.attempts = 0;
      void this.connect().catch(() => {});
    }
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
    clearTimeout(this.timer); this.timer = undefined;
    this.closed = true;
    this.rejectOpen?.(new Error('You left the room.')); this.resetOpening();
    clearInterval(this.pingTimer); clearTimeout(this.probeTimer); this.probeTimer = undefined;
    // Also retire connected sockets: already queued room updates must not pull
    // someone back into a match after they deliberately returned to the menu.
    const socket = this.socket; this.socket = null; socket?.close();
    this.update({ status: 'offline', room: null, snapshot: null, events: [], error: '' });
  }
  dispose() {
    this.disposed = true; this.closed = true; clearTimeout(this.timer); clearInterval(this.pingTimer); clearTimeout(this.probeTimer);
    window.removeEventListener('online', this.resumeConnection);
    window.removeEventListener('offline', this.networkOffline);
    window.removeEventListener('pageshow', this.resumeConnection);
    document.removeEventListener('visibilitychange', this.resumeConnection);
    this.rejectOpen?.(new Error('Connection closed.')); this.resetOpening();
    if (this.socket) { const socket = this.socket; this.socket = null; socket.onclose = null; socket.close(); }
    this.listeners.clear();
  }
}
