import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { GameAudio } from '../../src/game/GameAudio.js';

function fixture(t: TestContext, routing = true) {
  const window = new EventTarget();
  const document = { hidden: false };
  const session = { type: 'auto' };
  const contexts: Context[] = [];
  let allowed = false;
  class Param {
    value = 0;
    setValueAtTime(value: number) { this.value = value; }
    linearRampToValueAtTime(value: number) { this.value = value; }
    exponentialRampToValueAtTime(value: number) { this.value = value; }
    setTargetAtTime(value: number) { this.value = value; }
  }
  class Node {
    gain = new Param(); frequency = new Param(); pan = new Param();
    connections: Node[] = []; starts = 0; stops = 0;
    connect(other: Node) { this.connections.push(other); }
    disconnect() { this.connections = []; }
    start() { this.starts++; }
    stop() { this.stops++; }
  }
  class Context {
    state = 'suspended'; currentTime = 1; sampleRate = 48000;
    destination = new Node(); nodes: Node[] = []; resumes = 0;
    constructor() { contexts.push(this); }
    createGain() { const node = new Node(); this.nodes.push(node); return node; }
    createBuffer() { return { getChannelData: () => new Float32Array(48000) }; }
    createBufferSource() { return this.createGain(); }
    createBiquadFilter() { return this.createGain(); }
    createStereoPanner() { return this.createGain(); }
    createOscillator() { return this.createGain(); }
    async resume() { this.resumes++; if (!allowed) throw new Error('A tap has not ended yet'); this.state = 'running'; }
    async close() { this.state = 'closed'; }
  }
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window, document, navigator: routing ? { audioSession: session } : {}, AudioContext: Context })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const audio = new GameAudio(.5);
  t.after(() => {
    audio.dispose();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { audio, contexts, session, document, window, allow: () => { allowed = true; },
    gesture: async (type: string) => { window.dispatchEvent(new Event(type)); await Promise.resolve(); } };
}

test('audio starts on touch release after a rejected press and recovers an interrupted context', async t => {
  const f = fixture(t);
  assert.equal(f.contexts.length, 0);
  await f.gesture('pointerdown');
  assert.equal(f.contexts[0].state, 'suspended');
  f.allow(); await f.gesture('touchend');
  assert.equal(f.contexts.length, 1); assert.equal(f.contexts[0].state, 'running');
  f.contexts[0].state = 'interrupted';
  await f.gesture('pointerup');
  assert.equal(f.contexts[0].state, 'running'); assert.equal(f.contexts[0].resumes, 3);
});

test('shots and hit feedback reach the output along with other effects, and volume still mutes them', async t => {
  const f = fixture(t, false); f.allow(); await f.gesture('click');
  const context = f.contexts[0], master = context.nodes[0];
  assert.equal(master.connections[0], context.destination); assert.equal(master.gain.value, .16);
  for (const effect of [() => f.audio.shot(1), () => f.audio.shot(2, 10, -1), () => f.audio.hit(), () => f.audio.hit(true),
    () => f.audio.shieldBreak(), () => f.audio.damage(), () => f.audio.elimination(), () => f.audio.heal(),
    () => f.audio.respawn(), () => f.audio.reload(), () => f.audio.switchWeapon()]) {
    const count = context.nodes.length;
    effect();
    const nodes = context.nodes.slice(count);
    assert.ok(nodes.some(node => node.starts === 1 && node.stops === 1));
    assert.ok(nodes.some(node => node.connections.includes(master)));
  }
  f.audio.setVolume(0); assert.equal(master.gain.value, 0);
  f.audio.setVolume(.75); assert.equal(master.gain.value, .24);
});

test('supported phone routing uses media playback and disposal restores the previous route and removes gestures', async t => {
  const f = fixture(t); f.allow(); await f.gesture('keydown');
  assert.equal(f.session.type, 'playback');
  f.audio.dispose();
  assert.equal(f.session.type, 'auto'); assert.equal(f.contexts[0].state, 'closed');
  await f.gesture('touchend'); await f.gesture('pointerup'); await f.gesture('click');
  assert.equal(f.contexts.length, 1);
  const count = f.contexts[0].nodes.length;
  f.audio.hit(); assert.equal(f.contexts[0].nodes.length, count);
});

test('muted or hidden games do not take over the phone audio route; routing errors still allow sound', async t => {
  const f = fixture(t); f.allow(); f.document.hidden = true;
  await f.gesture('touchend'); assert.equal(f.contexts.length, 0);
  f.document.hidden = false; f.audio.setVolume(0);
  await f.gesture('touchend'); assert.equal(f.session.type, 'auto');
  f.audio.setVolume(.5);
  Object.defineProperty(f.session, 'type', { configurable: true, get: () => 'auto', set() { throw new Error('Unsupported route'); } });
  await f.gesture('click');
  f.audio.hit();
  assert.equal(f.contexts[0].state, 'running'); assert.ok(f.contexts[0].nodes.some(node => node.starts));
});
