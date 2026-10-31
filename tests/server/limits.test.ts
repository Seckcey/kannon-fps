import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createGameServer } from '../../server/app.js';
import { fixture, frame, startReady } from '../acceptance/helpers.js';
import { RULES } from '../../shared/protocol.js';

test('a phone flushing a 3.5 s stall of frames stays in its match, while a real flood is still cut off', async t => {
  const originalNow = Date.now; let offset = 0; Date.now = () => originalNow() + offset;
  t.after(() => { Date.now = originalNow; });
  const f = await fixture(t), identity = await f.profile('Phone in a tunnel'), phone = await f.connect(identity.token);
  await phone.command({ type: 'create', ranked: false, practice: true }, 'room', message => message.room.players.length === 4);
  await startReady(phone, [phone]);
  offset += RULES.countdownMs + 20;
  await phone.wait('snapshot', message => message.snapshot.phase === 'playing');
  // About 105 frames queued at 30 a second plus heartbeat pings, all delivered at once when the link recovers.
  const mark = phone.mark();
  for (let seq = 1; seq <= 105; seq++) { phone.send({ type: 'input', input: frame(seq, { moveZ: 1, yaw: 1 }) }); if (seq % 60 === 0) phone.send({ type: 'ping', t: seq }); }
  const caughtUp = await phone.wait('snapshot', message => message.snapshot.players.some(player => player.id === identity.profile.id && player.lastInputSeq === 105), mark);
  assert.equal(caughtUp.snapshot.phase, 'playing'); assert.equal(phone.socket.readyState, WebSocket.OPEN, 'The backlog does not end the connection.');
  // A page that keeps hammering the socket still gets the same close as before.
  const closed = new Promise<number>(resolve => phone.socket.once('close', code => resolve(code)));
  for (let i = 0; i < 1000; i++) phone.send({ type: 'ping', t: i });
  assert.equal(await closed, 1008);
});

test('behind a trusted proxy each visitor has their own rate limit; without the setting the header is ignored', async t => {
  const junk = (base: string, visitor: string) => fetch(`${base}/api/profile`, { method: 'POST', headers: { 'content-type': 'text/plain', 'cf-connecting-ip': visitor }, body: 'x', signal: AbortSignal.timeout(5_000) });
  for (const trusted of [true, false]) {
    const app = createGameServer({ host: '127.0.0.1', port: 0, dbPath: ':memory:', ...(trusted ? { trustedClientIpHeader: 'CF-Connecting-IP' } : {}) });
    const base = `http://127.0.0.1:${(await app.listen()).port}`;
    try {
      // Twenty junk sign-ups from one household (all arriving from the tunnel's loopback address).
      for (let i = 0; i < 20; i++) assert.equal((await junk(base, '203.0.113.7')).status, 415);
      assert.equal((await junk(base, '203.0.113.7')).status, 429, 'The noisy visitor is limited.');
      assert.equal((await junk(base, '198.51.100.20')).status, trusted ? 415 : 429, trusted ? 'Another household is not.' : 'Without the setting everyone shares the loopback bucket.');
      if (trusted) {
        // A value that is not an address cannot mint fresh buckets: it counts against the socket address.
        for (let i = 0; i < 20; i++) assert.equal((await junk(base, `not-an-address-${i}`)).status, 415);
        assert.equal((await junk(base, 'not-an-address-20')).status, 429);
      }
    } finally { await app.close(); }
  }
});
