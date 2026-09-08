import assert from 'node:assert/strict';
import test from 'node:test';
import type { Phase } from '../../shared/protocol';
import { GameView } from '../../src/game/GameView';

interface ReadinessView {
  disposed: boolean; assetsAnnounced: boolean; environmentReady: boolean; characterReady: boolean;
  snapshot: { phase: Phase };
  players: Map<string, { model: { root: { visible: boolean } } }>;
  renderer: { getContext: () => { isContextLost: () => boolean } };
  options: { getPlayerId: () => string; onAssetsReady: () => void };
}
const afterRender = (GameView.prototype as unknown as { checkAssetsReady(this: ReadinessView): void }).checkAssetsReady;
interface PreparationView extends ReadinessView {
  renderedPreparationId: string;
  snapshot: { phase: Phase; roundId?: string; players: Array<{ id: string; health: number; connected: boolean }> };
  options: ReadinessView['options'] & { getPreparationId: () => string | undefined; onPreparationRendered: (id: string) => void };
}
const afterPreparedFrame = (GameView.prototype as unknown as { checkPreparationRendered(this: PreparationView): void }).checkPreparationRendered;

test('first-render readiness waits for parsed environment and local model; dead recovery can show results', t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const document = { hidden: false };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); });
  let ready = 0, contextLost = false;
  const view: ReadinessView = {
    disposed: false, assetsAnnounced: false, environmentReady: false, characterReady: false,
    snapshot: { phase: 'preparing' }, players: new Map(),
    renderer: { getContext: () => ({ isContextLost: () => contextLost }) },
    options: { getPlayerId: () => 'local', onAssetsReady: () => { ready++; } },
  };
  afterRender.call(view);
  view.environmentReady = true; afterRender.call(view);
  view.characterReady = true; afterRender.call(view);
  assert.equal(ready, 0);
  view.players.set('local', { model: { root: { visible: false } } }); afterRender.call(view);
  assert.equal(ready, 0, 'Preparation must render the visible local scout.');
  view.players.get('local')!.model.root.visible = true;
  document.hidden = true; afterRender.call(view); assert.equal(ready, 0);
  document.hidden = false; contextLost = true; afterRender.call(view); assert.equal(ready, 0);
  contextLost = false; afterRender.call(view); afterRender.call(view); assert.equal(ready, 1);
  view.assetsAnnounced = false; view.snapshot.phase = 'finished'; view.players.get('local')!.model.root.visible = false;
  afterRender.call(view); assert.equal(ready, 2, 'An intentionally hidden dead scout must not obscure recovered results forever.');
  view.assetsAnnounced = false; view.snapshot.phase = 'playing'; afterRender.call(view);
  assert.equal(ready, 3, 'A reconnect during a respawn can show the arena while the local scout is dead.');
  view.assetsAnnounced = false; view.disposed = true; afterRender.call(view); assert.equal(ready, 3);
});

test('a rematch needs a newly rendered matching round with a living visible local scout', t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const document = { hidden: false };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); });
  let currentPreparation: string | undefined = 'new-round', contextLost = false;
  const rendered: string[] = [];
  const view: PreparationView = {
    disposed: false, assetsAnnounced: true, environmentReady: true, characterReady: true, renderedPreparationId: 'old-round',
    snapshot: { phase: 'finished', roundId: 'old-round', players: [{ id: 'local', health: 100, connected: true }] },
    players: new Map([['local', { model: { root: { visible: true } } }]]),
    renderer: { getContext: () => ({ isContextLost: () => contextLost }) },
    options: { getPlayerId: () => 'local', onAssetsReady: () => {}, getPreparationId: () => currentPreparation, onPreparationRendered: id => rendered.push(id) },
  };
  afterPreparedFrame.call(view);
  view.snapshot.phase = 'preparing'; afterPreparedFrame.call(view);
  assert.deepEqual(rendered, [], 'Warm assets and an old preparing world cannot admit a new room nonce.');
  view.snapshot.roundId = 'new-round'; view.snapshot.players[0]!.health = 0; afterPreparedFrame.call(view);
  view.snapshot.players[0]!.health = 100; view.snapshot.players[0]!.connected = false; afterPreparedFrame.call(view);
  view.snapshot.players[0]!.connected = true; view.players.get('local')!.model.root.visible = false; afterPreparedFrame.call(view);
  assert.deepEqual(rendered, []);
  view.players.get('local')!.model.root.visible = true; document.hidden = true; afterPreparedFrame.call(view);
  document.hidden = false; contextLost = true; afterPreparedFrame.call(view);
  contextLost = false; view.assetsAnnounced = false; afterPreparedFrame.call(view); assert.deepEqual(rendered, []);
  view.assetsAnnounced = true; afterPreparedFrame.call(view); afterPreparedFrame.call(view);
  assert.deepEqual(rendered, ['new-round']);
  currentPreparation = 'next-round'; afterPreparedFrame.call(view); assert.equal(rendered.length, 1);
  view.snapshot.roundId = 'next-round'; afterPreparedFrame.call(view);
  assert.deepEqual(rendered, ['new-round', 'next-round']);
  currentPreparation = undefined; view.snapshot.roundId = 'obsolete-late-frame'; afterPreparedFrame.call(view);
  currentPreparation = 'disposed-round'; view.snapshot.roundId = currentPreparation; view.disposed = true; afterPreparedFrame.call(view);
  assert.equal(rendered.length, 2);
});
