import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import WebSocket from 'ws';
import { createGameServer } from '../../server/app.js';
import type { ClientMessage, Profile, ServerMessage } from '../../shared/protocol.js';

export interface Identity { token: string; profile: Profile }
type MessageOf<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

export class Peer {
  readonly messages: ServerMessage[] = [];
  private readonly listeners = new Set<() => void>();
  private failure: Error | undefined;
  constructor(readonly socket: WebSocket) {
    socket.on('message', raw => {
      try {
        this.messages.push(JSON.parse(raw.toString()) as ServerMessage);
        for (const notify of this.listeners) notify();
      } catch (error) { this.failure = error as Error; }
    });
    socket.on('error', error => { this.failure = error; for (const notify of this.listeners) notify(); });
  }
  mark() { return this.messages.length; }
  send(message: ClientMessage) { this.socket.send(JSON.stringify(message)); }
  async wait<T extends ServerMessage['type']>(type: T, predicate: (message: MessageOf<T>) => boolean = () => true, after = 0, timeoutMs = 6_000): Promise<MessageOf<T>> {
    return new Promise((resolve, reject) => {
      const finish = (message?: MessageOf<T>, error?: Error) => {
        clearTimeout(timeout); this.listeners.delete(inspect);
        error ? reject(error) : resolve(message!);
      };
      const inspect = () => {
        if (this.failure) return finish(undefined, this.failure);
        const found = this.messages.slice(after).find((message): message is MessageOf<T> => message.type === type && predicate(message as MessageOf<T>));
        if (found) finish(found);
      };
      const timeout = setTimeout(() => finish(undefined, new Error(`Timed out waiting for ${type}; recent messages: ${this.messages.slice(-5).map(message => message.type).join(', ')}`)), timeoutMs);
      this.listeners.add(inspect); inspect();
    });
  }
  async command<T extends ServerMessage['type']>(message: ClientMessage, type: T, predicate?: (message: MessageOf<T>) => boolean) {
    const after = this.mark(); this.send(message); return this.wait(type, predicate, after);
  }
  close() { this.socket.terminate(); }
}

/** Existing transport suites explicitly finish the real readiness handshake. */
export async function startReady(host: Peer, players: Peer[], type: 'start' | 'rematch' = 'start') {
  const preparing = await host.command({ type }, 'room', message => message.room.phase === 'preparing');
  assert.ok(preparing.room.preparation);
  const mark = host.mark();
  for (const player of players) player.send({ type: 'ready', preparationId: preparing.room.preparation.id, ready: true });
  return host.wait('room', message => message.room.phase === 'countdown', mark);
}

export async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'kannon-acceptance-'));
  const dbPath = join(directory, 'players.sqlite');
  let app = createGameServer({ host: '127.0.0.1', port: 0, dbPath, staticDir: join(directory, 'no-client') });
  let address = await app.listen();
  let base = `http://127.0.0.1:${address.port}`;
  const peers: Peer[] = [];
  t.after(async () => {
    for (const peer of peers) peer.close();
    await app.close();
    const resolved = join(tmpdir(), 'kannon-acceptance-');
    assert.ok(directory.startsWith(resolved), 'Only the generated temporary acceptance directory may be removed.');
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get base() { return base; },
    async restart() {
      for (const peer of peers) peer.close();
      await app.close();
      app = createGameServer({ host: '127.0.0.1', port: 0, dbPath, staticDir: join(directory, 'no-client') });
      address = await app.listen(); base = `http://127.0.0.1:${address.port}`;
    },
    async request(path: string, options: { method?: string; token?: string; body?: unknown; origin?: string } = {}) {
      return fetch(`${base}${path}`, {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        headers: {
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.origin ? { origin: options.origin } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(5_000),
      });
    },
    async profile(name: string): Promise<Identity> {
      const response = await this.request('/api/profile', { body: { name } });
      assert.ok(response.ok, `Create ${name}: ${response.status}`);
      return response.json() as Promise<Identity>;
    },
    async connect(token?: string) {
      const socket = new WebSocket(base.replace(/^http/, 'ws') + '/ws', { origin: base });
      const peer = new Peer(socket); peers.push(peer);
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      if (token) await peer.command({ type: 'hello', token, readyProtocol: 1 }, 'welcome');
      return peer;
    },
  };
}
