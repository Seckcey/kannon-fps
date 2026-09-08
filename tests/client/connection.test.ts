import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { ArenaConnection } from '../../src/lib/connection.js';
import type { ClientMessage, RoomSnapshot, ServerMessage } from '../../shared/protocol.js';

class SocketDouble {
  static OPEN = 1;
  static instances: SocketDouble[] = [];
  readyState = 0;
  closeRequested = false;
  sent: ClientMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { SocketDouble.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(message: ServerMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
  send(raw: string) { assert.equal(this.readyState, 1); this.sent.push(JSON.parse(raw)); }
  // Deliberately never emit close: a broken mobile transport may stay CLOSING.
  close() { this.closeRequested = true; this.readyState = 2; }
  disconnect(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
}

const room: RoomSnapshot = {
  id: 'private-room', code: '00000000000000000001', hostId: 'player', ranked: false,
  practice: false, phase: 'playing', expiresAt: 10_000_000,
  players: [{ id: 'player', name: 'Player', color: '#fff', connected: true }],
};

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  SocketDouble.instances = [];
  const windowEvents = new EventTarget();
  const documentEvents = Object.assign(new EventTarget(), { hidden: false });
  const network = { onLine: true };
  const globals = { WebSocket: SocketDouble, window: windowEvents, document: documentEvents, navigator: network, location: { protocol: 'https:', host: 'arena.test' } };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const connection = new ArenaConnection('test-player-key');
  t.after(() => {
    connection.dispose();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return {
    connection, network, windowEvents, documentEvents,
    get sockets() { return SocketDouble.instances; },
    async join() {
      const opening = connection.connect();
      const socket = SocketDouble.instances.at(-1)!;
      socket.open(); socket.receive({ type: 'welcome', playerId: 'player' });
      socket.receive({ type: 'room', room });
      await opening;
      return socket;
    },
  };
}

test('a silent open connection is retired and rejoins without waiting for a TCP close callback', async t => {
  const f = fixture(t); const old = await f.join();
  assert.equal(old.url, 'wss://arena.test/ws');
  t.mock.timers.tick(8000);
  assert.equal(f.connection.getSnapshot().status, 'reconnecting');
  assert.equal(old.closeRequested, true);
  assert.equal(f.connection.getSnapshot().room?.id, room.id);
  t.mock.timers.tick(500);
  assert.equal(f.sockets.length, 2);
  const next = f.sockets[1]!; next.open(); next.receive({ type: 'welcome', playerId: 'player' });
  assert.deepEqual(next.sent, [{ type: 'hello', token: 'test-player-key' }, { type: 'join', code: room.code }]);
  old.receive({ type: 'welcome', playerId: 'obsolete-player' });
  old.disconnect(4001);
  assert.equal(f.connection.getSnapshot().status, 'connected');
  assert.equal(f.connection.getSnapshot().playerId, 'player');
});

test('responsive heartbeat traffic keeps an idle lobby connected', async t => {
  const f = fixture(t); const socket = await f.join();
  for (let i = 0; i < 10; i++) {
    t.mock.timers.tick(2000);
    assert.equal(socket.sent.at(-1)?.type, 'ping');
    socket.receive({ type: 'pong', t: Date.now() - 40 });
  }
  assert.equal(f.connection.getSnapshot().latency, 40);
  assert.equal(f.connection.getSnapshot().status, 'connected');
  assert.equal(f.sockets.length, 1);
});

test('manual retry cancels the pending retry and never opens a competing socket', async t => {
  const f = fixture(t); const old = await f.join(); old.disconnect();
  const retry = f.connection.connect();
  const next = f.sockets[1]!; next.open(); next.receive({ type: 'welcome', playerId: 'player' });
  await retry; t.mock.timers.tick(500);
  assert.equal(f.sockets.length, 2);
  assert.equal(f.connection.getSnapshot().status, 'connected');
});

test('returning online recovers the reserved room without a manual retry', async t => {
  const f = fixture(t); const old = await f.join();
  f.network.onLine = false; f.windowEvents.dispatchEvent(new Event('offline'));
  assert.equal(old.closeRequested, true);
  t.mock.timers.tick(500);
  assert.equal(f.sockets.length, 1);
  f.network.onLine = true; f.windowEvents.dispatchEvent(new Event('online'));
  assert.equal(f.sockets.length, 2);
  const next = f.sockets[1]!; next.open(); next.receive({ type: 'welcome', playerId: 'player' });
  assert.equal(f.connection.getSnapshot().status, 'connected');
  assert.deepEqual(next.sent.at(-1), { type: 'join', code: room.code });
});

test('foreground return checks a transport that went silent while the page was suspended', async t => {
  const f = fixture(t); const old = await f.join();
  f.documentEvents.hidden = true;
  t.mock.timers.tick(20_000);
  assert.equal(old.closeRequested, false, 'Background timer throttling should not alone reconnect a hidden page.');
  f.documentEvents.hidden = false; f.documentEvents.dispatchEvent(new Event('visibilitychange'));
  assert.equal(old.closeRequested, false, 'Give the foreground liveness probe a chance to respond.');
  t.mock.timers.tick(1500);
  assert.equal(old.closeRequested, true);
  t.mock.timers.tick(1);
  assert.equal(f.sockets.length, 2);
  const next = f.sockets[1]!; next.open(); next.receive({ type: 'welcome', playerId: 'player' });
  assert.equal(f.connection.getSnapshot().status, 'connected');
});

test('a responsive foreground probe preserves the current socket and room host', async t => {
  const f = fixture(t); const socket = await f.join();
  f.documentEvents.hidden = true; t.mock.timers.tick(20_000);
  f.documentEvents.hidden = false; f.documentEvents.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(500); socket.receive({ type: 'pong', t: Date.now() - 30 });
  t.mock.timers.tick(2000);
  assert.equal(socket.closeRequested, false);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.connection.getSnapshot().room?.hostId, 'player');
});

test('leaving during reconnect prevents a delayed socket or online event from reopening the room', async t => {
  const f = fixture(t); const socket = await f.join(); socket.disconnect();
  f.connection.leave();
  t.mock.timers.tick(20_000); f.windowEvents.dispatchEvent(new Event('online'));
  socket.receive({ type: 'room', room });
  assert.equal(f.sockets.length, 1);
  assert.equal(f.connection.getSnapshot().room, null);
  assert.equal(f.connection.getSnapshot().status, 'offline');
});

test('leaving a connected room ignores queued room updates and allows a fresh explicit connection', async t => {
  const f = fixture(t); const socket = await f.join();
  f.connection.leave();
  assert.deepEqual(socket.sent.at(-1), { type: 'leave' });
  assert.equal(socket.closeRequested, true);
  socket.receive({ type: 'room', room });
  socket.receive({ type: 'event', event: { type: 'match-end', winnerIds: [], ranked: false, reason: 'Old round', at: Date.now() } });
  assert.equal(f.connection.getSnapshot().room, null);
  assert.deepEqual(f.connection.getSnapshot().events, []);
  const opening = f.connection.connect(); const next = f.sockets[1]!;
  next.open(); next.receive({ type: 'welcome', playerId: 'player' }); await opening;
  assert.deepEqual(next.sent, [{ type: 'hello', token: 'test-player-key' }]);
});

test('replacement closes do not reconnect and take over the other device', async t => {
  const f = fixture(t); const socket = await f.join(); socket.disconnect(4001);
  t.mock.timers.tick(20_000); f.windowEvents.dispatchEvent(new Event('online'));
  f.documentEvents.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.sockets.length, 1);
  assert.equal(f.connection.getSnapshot().room, null);
  assert.match(f.connection.getSnapshot().error, /another tab or device/);
});

test('authentication rejection preserves the explanation and never retries automatically', async t => {
  const f = fixture(t); const opening = f.connection.connect();
  const rejected = assert.rejects(opening, /not recognized/);
  const socket = f.sockets[0]!; socket.open();
  socket.receive({ type: 'error', code: 'AUTH_REQUIRED', message: 'Your player key was not recognized.' });
  socket.disconnect(1008); await rejected;
  f.windowEvents.dispatchEvent(new Event('online')); t.mock.timers.tick(20_000);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.connection.getSnapshot().status, 'offline');
  assert.equal(f.connection.getSnapshot().error, 'Your player key was not recognized.');
});

test('handshake timeout rejects promptly even when close never arrives, and dispose removes recovery listeners', async t => {
  const f = fixture(t); const opening = f.connection.connect();
  const rejected = assert.rejects(opening, /did not respond/);
  t.mock.timers.tick(10_000); await rejected;
  assert.equal(f.connection.getSnapshot().status, 'offline');
  assert.equal(f.sockets[0]!.closeRequested, true);
  f.connection.dispose();
  f.windowEvents.dispatchEvent(new Event('online')); f.windowEvents.dispatchEvent(new Event('pageshow'));
  t.mock.timers.tick(20_000);
  assert.equal(f.sockets.length, 1);
  await assert.rejects(f.connection.connect(), /closed/);
});
