import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Phase } from '../../shared/protocol';
import { GameView } from '../../src/game/GameView';

interface ReadinessView {
  disposed: boolean; assetsAnnounced: boolean; environmentReady: boolean; characterReady: boolean; weaponsReady: boolean;
  firstPersonFrame: boolean; renderedPreparationId: string;
  snapshot: { phase: Phase; roundId?: string; players: Array<{ id: string; health: number; connected: boolean }> };
  renderer: { getContext: () => { isContextLost: () => boolean } };
  options: { getPlayerId: () => string; onAssetsReady: () => void; getPreparationId?: () => string | undefined; onPreparationRendered?: (id: string) => void };
  checkAssetsReady(): void;
  checkPreparationRendered(): void;
}
/** The real GameView readiness methods on a receiver holding only the state they read. */
function view(fields: Omit<ReadinessView, 'checkAssetsReady' | 'checkPreparationRendered'>): ReadinessView {
  return Object.assign(Object.create(GameView.prototype) as ReadinessView, fields);
}
function hiddenDocument(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const document = { hidden: false };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); });
  return document;
}

test('first-render readiness waits for the town, operator model, weapons and a drawn first-person view; dead recovery can show results', t => {
  const document = hiddenDocument(t);
  let ready = 0, contextLost = false;
  const subject = view({
    disposed: false, assetsAnnounced: false, environmentReady: false, characterReady: false, weaponsReady: false,
    firstPersonFrame: false, renderedPreparationId: '', snapshot: { phase: 'preparing', players: [] },
    renderer: { getContext: () => ({ isContextLost: () => contextLost }) },
    options: { getPlayerId: () => 'local', onAssetsReady: () => { ready++; } },
  });
  subject.checkAssetsReady();
  subject.environmentReady = true; subject.checkAssetsReady();
  subject.characterReady = true; subject.checkAssetsReady();
  subject.weaponsReady = true; subject.checkAssetsReady();
  assert.equal(ready, 0, 'The local player must be in the snapshot');
  subject.snapshot.players.push({ id: 'local', health: 100, connected: true }); subject.checkAssetsReady();
  assert.equal(ready, 0, 'Preparation must draw the first-person view first.');
  subject.firstPersonFrame = true;
  document.hidden = true; subject.checkAssetsReady(); assert.equal(ready, 0);
  document.hidden = false; contextLost = true; subject.checkAssetsReady(); assert.equal(ready, 0);
  contextLost = false; subject.checkAssetsReady(); subject.checkAssetsReady(); assert.equal(ready, 1);
  subject.assetsAnnounced = false; subject.snapshot.phase = 'finished'; subject.firstPersonFrame = false;
  subject.checkAssetsReady(); assert.equal(ready, 2, 'Results after the round need no first-person view.');
  subject.assetsAnnounced = false; subject.snapshot.phase = 'playing'; subject.snapshot.players[0]!.health = 0; subject.checkAssetsReady();
  assert.equal(ready, 3, 'A reconnect during a respawn can show the arena while the local player is down.');
  subject.assetsAnnounced = false; subject.weaponsReady = false; subject.checkAssetsReady(); assert.equal(ready, 3, 'Weapons are required');
  subject.weaponsReady = true; subject.disposed = true; subject.checkAssetsReady(); assert.equal(ready, 3);
});

test('a rematch needs a newly rendered matching round with a living first-person view', t => {
  const document = hiddenDocument(t);
  let currentPreparation: string | undefined = 'new-round', contextLost = false;
  const rendered: string[] = [];
  const subject = view({
    disposed: false, assetsAnnounced: true, environmentReady: true, characterReady: true, weaponsReady: true, firstPersonFrame: true,
    renderedPreparationId: 'old-round',
    snapshot: { phase: 'finished', roundId: 'old-round', players: [{ id: 'local', health: 100, connected: true }] },
    renderer: { getContext: () => ({ isContextLost: () => contextLost }) },
    options: { getPlayerId: () => 'local', onAssetsReady: () => {}, getPreparationId: () => currentPreparation, onPreparationRendered: id => rendered.push(id) },
  });
  subject.checkPreparationRendered();
  subject.snapshot.phase = 'preparing'; subject.checkPreparationRendered();
  assert.deepEqual(rendered, [], 'Warm assets and an old preparing world cannot admit a new room nonce.');
  subject.snapshot.roundId = 'new-round'; subject.snapshot.players[0]!.health = 0; subject.checkPreparationRendered();
  subject.snapshot.players[0]!.health = 100; subject.snapshot.players[0]!.connected = false; subject.checkPreparationRendered();
  subject.snapshot.players[0]!.connected = true; subject.firstPersonFrame = false; subject.checkPreparationRendered();
  assert.deepEqual(rendered, []);
  subject.firstPersonFrame = true; document.hidden = true; subject.checkPreparationRendered();
  document.hidden = false; contextLost = true; subject.checkPreparationRendered();
  contextLost = false; subject.assetsAnnounced = false; subject.checkPreparationRendered(); assert.deepEqual(rendered, []);
  subject.assetsAnnounced = true; subject.checkPreparationRendered(); subject.checkPreparationRendered();
  assert.deepEqual(rendered, ['new-round']);
  currentPreparation = 'next-round'; subject.checkPreparationRendered(); assert.equal(rendered.length, 1);
  subject.snapshot.roundId = 'next-round'; subject.checkPreparationRendered();
  assert.deepEqual(rendered, ['new-round', 'next-round']);
  currentPreparation = undefined; subject.snapshot.roundId = 'obsolete-late-frame'; subject.checkPreparationRendered();
  currentPreparation = 'disposed-round'; subject.snapshot.roundId = currentPreparation; subject.disposed = true; subject.checkPreparationRendered();
  assert.equal(rendered.length, 2);
});
