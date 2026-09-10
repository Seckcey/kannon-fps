import test from 'node:test';
import assert from 'node:assert/strict';
import { extractInvite, invitationMessage, shareInvitation } from '../../src/lib/storage.js';

const origin = 'https://kpop.8westventures.com';
function withBrowser(t: test.TestContext, clipboard?: { writeText: (value: string) => Promise<void> }) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard } });
  t.after(() => {
    previous ? Object.defineProperty(globalThis, 'location', previous) : Reflect.deleteProperty(globalThis, 'location');
    previousNavigator ? Object.defineProperty(globalThis, 'navigator', previousNavigator) : Reflect.deleteProperty(globalThis, 'navigator');
  });
}
const poster = () => Promise.resolve(new File(['jpeg'], 'kannon-arena-invite.jpg', { type: 'image/jpeg' }));

test('share message carries the room code and a link the join screen can read back', t => {
  withBrowser(t);
  const message = invitationMessage('ABCD');
  assert.match(message, /Room code ABCD/);
  assert.equal(extractInvite(message.split(' ').at(-1)!), 'ABCD');
});

test('native share sends the poster when the browser accepts files, and the link otherwise', async t => {
  withBrowser(t);
  const sent: ShareData[] = [];
  const withFiles = { canShare: (data: ShareData) => !!data.files?.length, share: async (data: ShareData) => { sent.push(data); } };
  assert.equal(await shareInvitation('ABCD', withFiles, poster), 'shared');
  assert.equal(sent[0]?.files?.length, 1);
  assert.equal(sent[0]?.url, `${origin}/#room=ABCD`);
  const linkOnly = { canShare: () => false, share: async (data: ShareData) => { sent.push(data); } };
  assert.equal(await shareInvitation('ABCD', linkOnly, poster), 'shared');
  assert.equal(sent[1]?.files, undefined);
  assert.equal(sent[1]?.text, invitationMessage('ABCD'));
});

test('a dismissed share sheet is reported as cancelled, not copied', async t => {
  let copied = '';
  withBrowser(t, { writeText: async value => { copied = value; } });
  const dismissed = { canShare: () => true, share: async () => { throw Object.assign(new Error('dismissed'), { name: 'AbortError' }); } };
  assert.equal(await shareInvitation('ABCD', dismissed, poster), 'cancelled');
  assert.equal(copied, '');
});

test('without native sharing the invitation link is copied', async t => {
  let copied = '';
  withBrowser(t, { writeText: async value => { copied = value; } });
  assert.equal(await shareInvitation('ABCD', {}, poster), 'copied');
  assert.equal(copied, `${origin}/#room=ABCD`);
  withBrowser(t, undefined);
  assert.equal(await shareInvitation('ABCD', {}, poster), false);
});
