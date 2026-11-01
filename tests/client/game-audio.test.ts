import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { SurfaceKind, Vec3, WeaponId } from '../../shared/protocol';
import { GameAudio, type GameAudioOptions, type ReloadStep } from '../../src/game/GameAudio.js';
import { bandEnergy, correlation, decayTime, energyOf, envelopeOf, logCentroid, lowShare, timeToPeak } from '../../src/game/audio/analysis.js';
import { ALL_SOUNDS, recipeFor, renderSound } from '../../src/game/audio/catalog.js';
import { createRng, hashSeed } from '../../src/game/audio/dsp.js';
import { GUN_DESIGNS, GUN_VOICES, renderGunCore, renderGunFar, type GunVoice } from '../../src/game/audio/guns.js';
import { MASTER_SCALE } from '../../src/game/audio/mixer.js';
import { REVERB_SECONDS, roomImpulse, streetImpulse } from '../../src/game/audio/reverb.js';
import { airCutoff, coveredAbove, falloffGain, nearFarMix, occlusion, relative } from '../../src/game/audio/spatial.js';
import { MAX_VOICES } from '../../src/game/audio/voices.js';

// ── A strict fake Web Audio implementation ───────────────────────────────────────────────────────
// Like browsers, parameters reject non-finite values and sources can start only once; every
// rejected write is recorded so tests can prove the engine never produced one.

type Target = FakeNode | Param;
class Param {
  private current: number;
  events: Array<{ kind: string; value: number; at: number }> = [];
  constructor(private readonly context: FakeContext, value = 0) { this.current = value; }
  get value() { return this.current; }
  set value(value: number) { this.check(value); this.current = value; }
  private check(...values: number[]) {
    if (values.every(Number.isFinite)) return;
    this.context.invalid.push(values.join(','));
    throw new TypeError('The provided value is non-finite.');
  }
  private record(kind: string, value: number, at: number) { this.events.push({ kind, value, at }); this.current = value; return this; }
  setValueAtTime(value: number, at: number) { this.check(value, at); return this.record('set', value, at); }
  linearRampToValueAtTime(value: number, at: number) { this.check(value, at); return this.record('linear', value, at); }
  exponentialRampToValueAtTime(value: number, at: number) {
    this.check(value, at);
    if (value === 0) { this.context.invalid.push('exponential to 0'); throw new RangeError('Exponential ramp to zero'); }
    return this.record('exponential', value, at);
  }
  setTargetAtTime(value: number, at: number, constant: number) { this.check(value, at, constant); return this.record('target', value, at); }
  cancelScheduledValues(at: number) { this.check(at); this.events.push({ kind: 'cancel', value: NaN, at }); return this; }
}
interface FakeBuffer { numberOfChannels: number; length: number; sampleRate: number; duration: number; getChannelData(channel: number): Float32Array }
class FakeNode {
  readonly connections = new Set<Target>();
  starts: number[] = []; stops: number[] = [];
  onended: (() => void) | null = null;
  buffer: FakeBuffer | null = null;
  type = ''; loop = false; loopStart = 0; loopEnd = 0; normalize = true;
  panningModel = 'equalpower'; distanceModel = 'inverse';
  refDistance = 1; maxDistance = 10000; rolloffFactor = 1; coneInnerAngle = 360; coneOuterAngle = 360; coneOuterGain = 0;
  readonly gain: Param; readonly frequency: Param; readonly Q: Param; readonly pan: Param; readonly playbackRate: Param; readonly detune: Param;
  readonly positionX: Param; readonly positionY: Param; readonly positionZ: Param;
  readonly threshold: Param; readonly knee: Param; readonly ratio: Param; readonly attack: Param; readonly release: Param;
  constructor(readonly kind: string, private readonly context: FakeContext) {
    const p = (value = 0) => new Param(context, value);
    this.gain = p(1); this.frequency = p(350); this.Q = p(1); this.pan = p(); this.playbackRate = p(1); this.detune = p();
    this.positionX = p(); this.positionY = p(); this.positionZ = p();
    this.threshold = p(-24); this.knee = p(30); this.ratio = p(12); this.attack = p(0.003); this.release = p(0.25);
  }
  connect(target: Target) { this.connections.add(target); return target; }
  disconnect() { this.connections.clear(); }
  start(when = 0) {
    if (this.starts.length) { this.context.invalid.push(`${this.kind} started twice`); throw new Error('InvalidStateError'); }
    if (!Number.isFinite(when)) { this.context.invalid.push('start NaN'); throw new TypeError('non-finite'); }
    this.starts.push(when);
  }
  stop(when = 0) {
    if (!this.starts.length) throw new Error('InvalidStateError: not started');
    this.stops.push(when);
  }
  setPosition(x: number, y: number, z: number) { this.positionX.value = x; this.positionY.value = y; this.positionZ.value = z; }
}
let allowed = false;
const contexts: FakeContext[] = [];
class FakeContext {
  state = 'suspended'; currentTime = 1; sampleRate = 48000; resumes = 0; suspends = 0; buffers = 0;
  /** Makes the next node of this kind fail to create, like a browser running out of resources. */
  failNext: string | null = null;
  readonly invalid: string[] = [];
  readonly nodes: FakeNode[] = [];
  readonly destination: FakeNode = new FakeNode('destination', this);
  constructor() { contexts.push(this); }
  private make(kind: string) {
    if (this.failNext === kind) { this.failNext = null; throw new Error(`Cannot create ${kind}`); }
    const node = new FakeNode(kind, this); this.nodes.push(node); return node;
  }
  createGain() { return this.make('gain'); }
  createBufferSource() { return this.make('source'); }
  createOscillator() { const node = this.make('oscillator'); node.type = 'sine'; return node; }
  createBiquadFilter() { const node = this.make('biquad'); node.type = 'lowpass'; return node; }
  createStereoPanner() { return this.make('stereo'); }
  createPanner() { return this.make('panner'); }
  createConvolver() { return this.make('convolver'); }
  createDynamicsCompressor() { return this.make('compressor'); }
  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    if (!(length >= 1) || !Number.isInteger(length) || !(sampleRate >= 8000 && sampleRate <= 96000) || channels < 1) {
      this.invalid.push(`buffer ${channels}x${length}@${sampleRate}`); throw new Error('NotSupportedError');
    }
    this.buffers++;
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: (c: number) => data[c] };
  }
  async resume() { this.resumes++; if (!allowed) throw new Error('A tap has not ended yet'); this.state = 'running'; }
  /** Like a browser, a suspended context stops its clock until it resumes. */
  async suspend() { this.suspends++; if (this.state !== 'closed') this.state = 'suspended'; }
  async close() { this.state = 'closed'; }
}

function fixture(t: TestContext, { routing = true, options = { warmup: false } as GameAudioOptions } = {}) {
  const window = new EventTarget();
  const document = { hidden: false };
  const session = { type: 'auto' };
  contexts.length = 0; allowed = false;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window, document, navigator: routing ? { audioSession: session } : {}, AudioContext: FakeContext })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const audio = new GameAudio(.5, options);
  t.after(() => {
    audio.dispose();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { audio, contexts, session, document, window, allow: () => { allowed = true; },
    gesture: async (type: string) => { window.dispatchEvent(new Event(type)); await Promise.resolve(); await Promise.resolve(); } };
}
async function unlocked(t: TestContext, options: GameAudioOptions = { warmup: false }) {
  const f = fixture(t, { routing: false, options });
  f.allow(); await f.gesture('click');
  const context = f.contexts[0];
  assert.equal(context.state, 'running');
  f.audio.setListener(EAR, 0, 0, false);
  return { ...f, context, master: context.nodes[0] };
}
/** True when sound can flow from `node` to `target` through node connections. */
function reaches(node: FakeNode, target: FakeNode): boolean {
  const seen = new Set<FakeNode>(), queue = [node];
  while (queue.length) {
    const next = queue.pop()!;
    if (next === target) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const c of next.connections) if (c instanceof FakeNode) queue.push(c);
  }
  return false;
}
const created = (context: FakeContext, from: number) => context.nodes.slice(from);
const sourcesOf = (nodes: FakeNode[]) => nodes.filter(node => node.kind === 'source' || node.kind === 'oscillator');
/** Plays every started source to its end (the browser would fire `ended`). */
function endAll(context: FakeContext) {
  for (const node of sourcesOf(context.nodes)) if (node.starts.length && node.onended) node.onended();
}

const EAR: Vec3 = { x: 0, y: 1.6, z: -12 };
const near = (dx: number, dz: number, y = 1.5): Vec3 => ({ x: EAR.x + dx, y, z: EAR.z + dz });
const WEAPONS_ALL: readonly WeaponId[] = ['kr5', 'hornet9', 'breaker12', 'longbow', 'sentry9'];
const SURFACES_ALL: readonly SurfaceKind[] = ['asphalt', 'concrete', 'wood', 'grass', 'metal', 'fabric', 'glass', 'sandbag'];

/** Every public sound method with ordinary arguments. */
function everySound(audio: GameAudio): Array<[string, () => void]> {
  const calls: Array<[string, () => void]> = [];
  for (const weapon of [...WEAPONS_ALL, 'drone' as const]) {
    calls.push([`${weapon} local shot`, () => audio.shot(weapon, EAR, true)]);
    calls.push([`${weapon} remote shot`, () => audio.shot(weapon, near(6, -8), false)]);
  }
  for (const surface of [...SURFACES_ALL, 'flesh' as const]) calls.push([`${surface} impact`, () => audio.impact(surface, near(3, -5))]);
  for (const surface of SURFACES_ALL) {
    calls.push([`${surface} own step`, () => audio.footstep(surface, near(0, 0, 0), true, 1)]);
    calls.push([`${surface} enemy step`, () => audio.footstep(surface, near(-4, 3, 0), false, 0.8)]);
  }
  for (const weapon of WEAPONS_ALL) for (const step of ['mag-out', 'mag-in', 'bolt', 'shell', 'pump'] as ReloadStep[]) calls.push([`${weapon} ${step}`, () => audio.reloadStep(weapon, step)]);
  calls.push(
    ['flyby', () => audio.flyby(near(0.6, -1))],
    ['own landing', () => audio.land(near(0, 0, 0), true, 0.8)], ['enemy landing', () => audio.land(near(5, 2, 0), false, 1)],
    ['own slide', () => audio.slide(near(0, 0, 0), true)], ['enemy slide', () => audio.slide(near(5, 0, 0), false)],
    ['own vault', () => audio.vault(true)], ['enemy vault', () => audio.vault(false, near(4, 1, 0))],
    ['aim in', () => audio.aim(true)], ['aim out', () => audio.aim(false)], ['swap', () => audio.swap()], ['dry fire', () => audio.dryFire()],
    ['knife miss', () => audio.melee(false)], ['knife hit', () => audio.melee(true)], ['enemy knife', () => audio.melee(true, near(2, 0, 0))],
    ['hit marker', () => audio.hitMarker('hit')], ['head marker', () => audio.hitMarker('head')], ['kill marker', () => audio.hitMarker('kill')],
    ['damage', () => audio.damage(30)], ['grenade bounce', () => audio.grenadeBounce(near(3, -4, 0.1), 9)], ['pin', () => audio.grenadePin()],
    ['frag', () => audio.explosion(near(12, -10, 0), 'frag')], ['mortar', () => audio.explosion(near(-15, 10, 0), 'mortar')],
    ['drone down', () => audio.explosion(near(10, 5, 9), 'drone')], ['whistle', () => audio.mortarWhistle(near(8, -6, 0))],
    ['recon earned', () => audio.streak('earned', 'recon')], ['mortar used', () => audio.streak('used', 'mortar')], ['drone earned', () => audio.streak('earned', 'drone')],
    ['medal', () => audio.medal()], ['respawn', () => audio.respawn()], ['tick', () => audio.countdown(false)], ['go', () => audio.countdown(true)],
  );
  return calls;
}

// ── iPhone unlock flow (unchanged behaviour) ─────────────────────────────────────────────────────

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

test('supported phone routing uses media playback and disposal restores the previous route and removes gestures', async t => {
  const f = fixture(t); f.allow(); await f.gesture('keydown');
  assert.equal(f.session.type, 'playback');
  f.audio.dispose();
  assert.equal(f.session.type, 'auto'); assert.equal(f.contexts[0].state, 'closed');
  await f.gesture('touchend'); await f.gesture('pointerup'); await f.gesture('click');
  assert.equal(f.contexts.length, 1);
  const count = f.contexts[0].nodes.length;
  f.audio.hitMarker('hit'); f.audio.shot('kr5', EAR, true);
  assert.equal(f.contexts[0].nodes.length, count);
});

test('muted or hidden games do not take over the phone audio route; routing errors still allow sound', async t => {
  const f = fixture(t); f.allow(); f.document.hidden = true;
  await f.gesture('touchend'); assert.equal(f.contexts.length, 0);
  f.document.hidden = false; f.audio.setVolume(0);
  await f.gesture('touchend'); assert.equal(f.session.type, 'auto');
  f.audio.setVolume(.5);
  Object.defineProperty(f.session, 'type', { configurable: true, get: () => 'auto', set() { throw new Error('Unsupported route'); } });
  await f.gesture('click');
  f.audio.hitMarker('hit');
  assert.equal(f.contexts[0].state, 'running'); assert.ok(f.contexts[0].nodes.some(node => node.starts.length));
});

test('a hidden page pauses every sound, and showing it again carries on where it left off', async t => {
  const f = await unlocked(t), { context, audio } = f;
  audio.lowHealth(1); audio.ambience(true); audio.drone({ x: 10, y: 11, z: -12 });
  for (let i = 0; i < 10; i++) { context.currentTime += 0.016; audio.setListener(EAR, 0, 0, false); }
  const loops = context.nodes.filter(node => (node.loop || node.kind === 'oscillator') && node.starts.length && !node.stops.length);
  assert.ok(loops.length >= 3, 'the heartbeat, the wind and the drone hum are playing');
  f.document.hidden = true;
  audio.suspend();
  assert.equal(context.state, 'suspended', 'nothing plays on in the background, and the context clock stops with it');
  const before = context.nodes.length;
  audio.hitMarker('hit'); audio.shot('kr5', near(10, -5), false); audio.setListener(EAR, 0, 0, false);
  assert.equal(context.nodes.length, before, 'no sound is started while paused');
  audio.suspend(); assert.equal(context.suspends, 1, 'pausing again is harmless');
  audio.resume(); assert.equal(context.state, 'suspended', 'a hidden page stays paused');
  f.document.hidden = false;
  audio.resume(); await Promise.resolve();
  assert.equal(context.state, 'running', 'showing the page resumes the sound');
  assert.ok(loops.every(node => !node.stops.length), 'the loops resume where they were instead of starting over');
  audio.dispose(); audio.suspend(); audio.resume();
  assert.equal(context.suspends, 1, 'a closed context is left alone');
});

test('showing the page before the first tap does not start the sound or take over the phone audio route', async t => {
  const f = fixture(t); f.allow();
  f.audio.suspend(); f.audio.resume();
  assert.equal(f.contexts.length, 0, 'Browsers want a tap or click first');
  assert.equal(f.session.type, 'auto');
  await f.gesture('touchend');
  assert.equal(f.contexts[0]!.state, 'running', 'The first tap still starts it');
});

// ── The contract surface ─────────────────────────────────────────────────────────────────────────

test('every sound starts a rendered buffer that reaches the speakers, and volume zero mutes', async t => {
  const f = await unlocked(t), { context, master, audio } = f;
  assert.ok(master.connections.has(context.destination));
  assert.equal(master.gain.value, .5 * MASTER_SCALE);
  for (const [name, play] of everySound(audio)) {
    context.currentTime += 1;
    const before = context.nodes.length;
    play();
    const sources = sourcesOf(created(context, before)).filter(node => node.starts.length === 1);
    assert.ok(sources.length, `${name} starts a sound`);
    assert.ok(sources.every(node => node.buffer && node.buffer.length > 0 && node.buffer.getChannelData(0).some(v => v !== 0)), `${name} plays rendered audio`);
    assert.ok(sources.some(node => reaches(node, master)), `${name} reaches the speakers`);
  }
  assert.deepEqual(context.invalid, []);
  audio.setVolume(0); assert.equal(master.gain.value, 0);
  const before = context.nodes.length;
  audio.shot('kr5', EAR, true); audio.hitMarker('kill'); audio.explosion(near(3, 3, 0), 'frag'); audio.footstep('wood', near(2, 2, 0), false, 1);
  assert.equal(context.nodes.length, before, 'a muted game creates no sounds');
  audio.setVolume(.75); assert.equal(master.gain.value, .75 * MASTER_SCALE);
  audio.setVolume(Number.NaN); assert.equal(master.gain.value, .75 * MASTER_SCALE);
});

test('every method is safe before unlocking, with nonsense input, and after disposal', async t => {
  const f = fixture(t, { routing: false });
  const bad = { x: Number.NaN, y: Infinity, z: 0 } as Vec3;
  const nonsense = (audio: GameAudio): Array<() => void> => [
    () => audio.setListener(bad, Number.NaN, Number.NaN, true), () => audio.setVolume(Number.NaN),
    () => audio.shot('nope' as WeaponId, bad, false), () => audio.shot('kr5', undefined as unknown as Vec3, false), () => audio.shot('longbow', bad, true),
    () => audio.impact('lava' as SurfaceKind, bad), () => audio.impact('wood', null as unknown as Vec3), () => audio.flyby(bad),
    () => audio.footstep('ice' as SurfaceKind, bad, false, Number.NaN), () => audio.footstep('wood', EAR, true, Infinity), () => audio.footstep('grass', near(1, 1, 0), false, -3),
    () => audio.land(bad, true, Number.NaN), () => audio.land(EAR, false, 1e9), () => audio.slide(bad, true), () => audio.slide(bad, false),
    () => audio.vault(false, bad), () => audio.vault(false), () => audio.reloadStep('nope' as WeaponId, 'mag-in'), () => audio.reloadStep('kr5', 'jam' as ReloadStep),
    () => audio.aim(true), () => audio.swap(), () => audio.dryFire(), () => audio.melee(true, bad), () => audio.hitMarker('crit' as 'hit'),
    () => audio.damage(Number.NaN), () => audio.damage(-50), () => audio.damage(1e6), () => audio.lowHealth(Number.NaN), () => audio.lowHealth(7), () => audio.lowHealth(-1),
    () => audio.grenadeBounce(bad, 5), () => audio.grenadeBounce(EAR, Number.NaN), () => audio.grenadePin(), () => audio.explosion(bad, 'frag'),
    () => audio.explosion(near(1, 1, 0), 'nuke' as 'frag'), () => audio.mortarWhistle(bad), () => audio.drone(bad), () => audio.drone(near(1, 1, 9)), () => audio.drone(null),
    () => audio.streak('earned', 'nuke' as 'recon'), () => audio.streak('weird' as 'used', 'drone'), () => audio.medal(), () => audio.respawn(),
    () => audio.countdown(true), () => audio.ambience(true), () => audio.ambience(false), () => audio.setListener(EAR, 0, 0, false),
  ];
  for (const call of [...nonsense(f.audio), ...everySound(f.audio).map(([, call]) => call)]) assert.doesNotThrow(call);
  assert.equal(f.contexts.length, 0, 'nothing creates audio before a gesture');
  f.allow(); await f.gesture('click');
  const context = f.contexts[0];
  for (const call of nonsense(f.audio)) { context.currentTime += 0.3; assert.doesNotThrow(call); }
  assert.deepEqual(context.invalid, [], 'no non-finite value or invalid buffer ever reaches Web Audio');
  f.audio.dispose();
  const count = context.nodes.length;
  for (const call of [...nonsense(f.audio), ...everySound(f.audio).map(([, call]) => call)]) assert.doesNotThrow(call);
  assert.doesNotThrow(() => f.audio.dispose());
  assert.equal(context.nodes.length, count, 'a disposed engine creates nothing');
});

test('finished sounds disconnect every node they created', async t => {
  const { context, audio } = await unlocked(t);
  const base = context.nodes.length;
  for (const [, play] of everySound(audio)) { context.currentTime += 0.2; play(); }
  const nodes = created(context, base);
  assert.ok(nodes.length > 100 && nodes.some(node => node.connections.size));
  assert.ok(audio.voiceCount > 0 && audio.voiceCount <= MAX_VOICES);
  endAll(context);
  assert.deepEqual(nodes.filter(node => node.connections.size).map(node => node.kind), []);
  assert.equal(audio.voiceCount, 0);
});

test('a sound that fails half-way through building releases what it made and does not count', async t => {
  const { context, audio } = await unlocked(t);
  const before = context.nodes.length;
  context.failNext = 'biquad';
  assert.doesNotThrow(() => audio.shot('longbow', near(20, -8), false));
  const made = created(context, before);
  assert.ok(made.some(node => node.kind === 'source' && node.starts.length === 1), 'it got as far as starting sources');
  assert.ok(made.every(node => node.connections.size === 0), 'every node it made is disconnected');
  assert.ok(sourcesOf(made).every(node => node.stops.length === 1), 'and its sources are stopped');
  assert.equal(audio.voiceCount, 0);
  audio.shot('longbow', near(20, -8), false);
  assert.equal(audio.voiceCount, 1, 'the next sound plays normally');
});

test('sounds whose end event never arrives are still released once overdue', async t => {
  const { context, audio } = await unlocked(t);
  const base = context.nodes.length;
  audio.shot('kr5', near(5, -10), false); audio.footstep('wood', near(2, 1, 0), false, 1);
  assert.equal(audio.voiceCount, 2);
  context.currentTime += 5;
  audio.setListener(EAR, 0, 0, false);
  assert.equal(audio.voiceCount, 0);
  assert.ok(created(context, base).every(node => node.connections.size === 0));
});

test('the 32-voice cap steals the oldest sound and never drops an important sound for a lesser one', async t => {
  const { context, audio } = await unlocked(t);
  const shots: FakeNode[][] = [];
  for (let i = 0; i < 40; i++) {
    context.currentTime += 0.001;
    const before = context.nodes.length;
    audio.shot('kr5', near(4, -6), false);
    shots.push(sourcesOf(created(context, before)));
  }
  assert.equal(audio.voiceCount, MAX_VOICES);
  shots.slice(0, 8).forEach((sources, i) => assert.ok(sources.every(s => s.stops.length === 1), `shot ${i} was stolen`));
  shots.slice(8).forEach((sources, i) => assert.ok(sources.every(s => s.stops.length === 0), `shot ${i + 8} keeps playing`));
  const stolenGain = [...shots[0][0].connections][0] as FakeNode;
  assert.equal(stolenGain.kind, 'gain');
  assert.ok(stolenGain.gain.events.some(e => e.kind === 'linear' && e.value === 0), 'stolen sounds fade instead of clicking');
  endAll(context);
  assert.equal(audio.voiceCount, 0);
  assert.ok(shots.flat().every(source => source.connections.size === 0));

  for (let i = 0; i < 40; i++) { context.currentTime += 0.001; audio.shot('sentry9', EAR, true); }
  assert.equal(audio.voiceCount, MAX_VOICES);
  const before = context.nodes.length;
  audio.footstep('wood', near(2, 2, 0), false, 1);
  assert.equal(context.nodes.length, before, 'a footstep does not cut off the player\'s own gunfire');
  audio.hitMarker('kill');
  assert.ok(context.nodes.length > before, 'a kill marker always plays');
  assert.equal(audio.voiceCount, MAX_VOICES);
  assert.deepEqual(context.invalid, []);
});

test('distant shots arrive at the speed of sound, darker, wetter and panned to their side', async t => {
  const { context, audio } = await unlocked(t);
  context.currentTime = 10;
  let before = context.nodes.length;
  audio.shot('kr5', near(1, -1), false);
  const close = created(context, before);
  before = context.nodes.length;
  const target = near(30, 0), distance = Math.hypot(target.x - EAR.x, target.y - EAR.y, target.z - EAR.z);
  audio.shot('kr5', target, false);
  const far = created(context, before);
  const farSources = sourcesOf(far);
  assert.equal(farSources.length, 2, 'the far boom joins the close shot with range');
  for (const source of farSources) assert.ok(Math.abs(source.starts[0] - (10 + distance / 343)) < 1e-6, 'sound takes 87 ms to travel 30 m');
  assert.ok(sourcesOf(close).every(s => s.starts[0] < 10.01));
  const cutoff = (nodes: FakeNode[]) => nodes.find(node => node.kind === 'biquad')?.frequency.value ?? 20000;
  assert.ok(cutoff(far) < 12000 && cutoff(far) < cutoff(close), 'distance takes the highs away');
  const panner = far.find(node => node.kind === 'panner')!;
  assert.equal(panner.panningModel, 'HRTF');
  assert.ok(panner.positionX.value > 0.99 && Math.abs(panner.positionZ.value) < 0.01, 'a shot to the right is placed to the right');
  const dryGain = (nodes: FakeNode[]) => sourcesOf(nodes)[0] && nodes.find(node => node.kind === 'gain')!.gain.value;
  assert.ok(dryGain(far)! < dryGain(close)! * 0.5);
  // A send's gain is the reverb level relative to the direct sound.
  const wet = (nodes: FakeNode[]) => nodes.filter(node => node.kind === 'gain' && [...node.connections].some(c => c instanceof FakeNode && [...c.connections].some(d => d instanceof FakeNode && d.kind === 'convolver')))
    .reduce((sum, node) => sum + node.gain.value, 0);
  assert.ok(wet(close) > 0 && wet(far) > wet(close) * 2, 'distant shots are wetter relative to their direct sound');
});

test('phones pan with equal power and darken sounds from behind; desktops use HRTF', async t => {
  const f = await unlocked(t, { quality: 'phone', warmup: false }), { context, audio } = f;
  assert.equal(audio.quality, 'phone');
  let before = context.nodes.length;
  audio.shot('hornet9', near(-20, 0), false);
  let nodes = created(context, before);
  assert.ok(!nodes.some(node => node.kind === 'panner'));
  assert.ok(nodes.find(node => node.kind === 'stereo')!.pan.value < -0.5, 'a shot to the left pans left');
  const tone = (yaw: number) => {
    audio.setListener(EAR, yaw, 0, false);
    const from = context.nodes.length;
    audio.footstep('concrete', near(0, 6, 0), false, 1);
    return created(context, from).find(node => node.kind === 'biquad')!.frequency.value;
  };
  assert.ok(tone(0) < tone(Math.PI) * 0.8, 'steps behind are duller than the same steps ahead');
  audio.setListener(EAR, 0, 0, false);
  before = context.nodes.length;
  audio.shot('kr5', EAR, true);
  nodes = created(context, before);
  assert.ok(!nodes.some(node => node.kind === 'stereo' || node.kind === 'panner'), 'your own gun is not panned');
});

test('walls muffle sounds, and sounds made indoors ring in the room reverb', async t => {
  const { context, audio } = await unlocked(t);
  const street: Vec3 = { x: -5, y: 1.6, z: -4.7 };
  audio.setListener(street, -Math.PI / 2, 0, false);
  const convolvers = context.nodes.filter(node => node.kind === 'convolver');
  const roomSend = context.nodes.find(node => node.connections.has(convolvers[0]))!;
  const play = (at: Vec3) => { const from = context.nodes.length; audio.shot('kr5', at, false); return created(context, from); };
  const inside = play({ x: -14, y: 1.5, z: -4.7 }), open = play({ x: -5, y: 1.5, z: -13.7 });
  const cutoff = (nodes: FakeNode[]) => nodes.find(node => node.kind === 'biquad')?.frequency.value ?? 20000;
  const level = (nodes: FakeNode[]) => nodes.find(node => node.kind === 'gain')!.gain.value;
  assert.ok(cutoff(inside) < cutoff(open) * 0.5, 'a wall takes away most of the highs');
  assert.ok(level(inside) < level(open) * 0.75, 'a wall makes it quieter');
  assert.ok(inside.some(node => node.connections.has(roomSend)), 'a shot inside the house rings in the room');
  assert.ok(!open.some(node => node.connections.has(roomSend)), 'a shot in the street does not');
  context.currentTime += 1;
  audio.setListener({ x: -14, y: 1.6, z: -2 }, 0, 0, true);
  const before = context.nodes.length;
  audio.shot('kr5', EAR, true);
  assert.ok(created(context, before).some(node => node.connections.has(roomSend)), 'your own shots indoors use the room');
});

test('low health muffles the world and brings in a heartbeat that quickens; damage dips the hearing', async t => {
  const { context, audio } = await unlocked(t);
  const ui = context.nodes[2], world = context.nodes[3], hurt = context.nodes[4], health = context.nodes[5];
  assert.ok([hurt, health].every(node => node.kind === 'biquad') && world.connections.has(hurt));
  let before = context.nodes.length;
  audio.lowHealth(0.8);
  const heart = created(context, before).find(node => node.kind === 'source')!;
  assert.ok(heart.loop && heart.starts.length === 1 && reaches(heart, ui), 'the heartbeat plays on the cue bus, unmuffled');
  assert.ok(health.frequency.value < 2000 && world.gain.value < 0.8);
  const slow = heart.loopEnd;
  before = context.nodes.length;
  for (let i = 0; i < 100; i++) { context.currentTime += 0.016; audio.lowHealth(1); audio.setListener(EAR, 0, 0, false); }
  assert.equal(context.nodes.length, before, 'calling every frame creates nothing new');
  assert.ok(heart.loopEnd < slow, 'the heart beats faster closer to elimination');
  audio.lowHealth(0);
  assert.equal(heart.stops.length, 1);
  assert.equal(health.frequency.value, 20000);
  endAll(context);
  assert.equal(heart.connections.size, 0);
  context.currentTime += 1;
  audio.damage(45);
  assert.ok(hurt.frequency.events.some(e => e.kind === 'target' && e.value < 2600), 'a hit dulls the world for a moment');
  assert.equal(hurt.frequency.events.at(-1)!.value, 20000, 'and hearing recovers');
});

test('the drone hum follows the drone and stops cleanly', async t => {
  const { context, audio } = await unlocked(t);
  let before = context.nodes.length;
  audio.drone({ x: 10, y: 11, z: -12 });
  const hum = created(context, before);
  const oscillators = hum.filter(node => node.kind === 'oscillator');
  assert.ok(oscillators.length >= 2 && oscillators.every(o => o.starts.length === 1));
  const panner = hum.find(node => node.kind === 'panner')!;
  before = context.nodes.length;
  for (let i = 0; i < 30; i++) { context.currentTime += 0.05; audio.drone({ x: 10 - i, y: 11, z: -12 }); }
  assert.equal(context.nodes.length, before, 'following the drone creates nothing new');
  assert.ok(panner.positionX.events.at(-1)!.value < 0, 'it moved to the left');
  audio.drone(null);
  assert.ok(oscillators.every(o => o.stops.length === 1));
  endAll(context);
  assert.ok(hum.every(node => node.connections.size === 0));
});

test('the ambience bed drifts, schedules far-off fights from the frame clock and stops cleanly', async t => {
  const { context, audio } = await unlocked(t);
  const before = context.nodes.length;
  audio.ambience(true);
  const wind = created(context, before).find(node => node.kind === 'source' && node.loop)!;
  assert.ok(wind && wind.starts.length === 1);
  for (let i = 0; i < 400; i++) { context.currentTime += 0.5; audio.setListener(EAR, 0, 0, i % 50 > 40); }
  const later = created(context, before);
  assert.ok(sourcesOf(later).filter(node => node.starts.length).length > 10, 'distant gunfire and artillery play over three minutes');
  assert.ok(later.some(node => node.kind === 'oscillator'), 'a helicopter crosses now and then');
  assert.ok(audio.voiceCount <= MAX_VOICES);
  audio.ambience(false);
  assert.equal(wind.stops.length, 1);
  endAll(context);
  assert.equal(wind.connections.size, 0);
  assert.deepEqual(context.invalid, []);
});

test('dispose closes the context, releases every node and stops warming up sounds', async t => {
  const f = await unlocked(t, { warmup: true }), { context, audio } = f;
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.ok(context.buffers > 3, 'common sounds render between frames after unlocking');
  audio.drone(near(5, 5, 10)); audio.lowHealth(0.6); audio.ambience(true);
  for (const [, play] of everySound(audio).slice(0, 20)) play();
  audio.dispose();
  assert.equal(context.state, 'closed');
  assert.deepEqual(context.nodes.filter(node => node.connections.size).map(node => node.kind), []);
  const buffers = context.buffers;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(context.buffers, buffers, 'no rendering after disposal');
});

// ── Sound design, checked by the numbers ─────────────────────────────────────────────────────────

const RATE = 48000;
const rateFor = (key: Parameters<typeof recipeFor>[0]) => recipeFor(key).half ? RATE / 2 : RATE;

test('every catalogued sound renders finite, bounded audio that is not silent and ends without a click', () => {
  const loops = new Set(['wind', 'noise']);
  for (const key of ALL_SOUNDS) {
    const rate = rateFor(key), data = renderSound(key, rate, 0);
    let peak = 0;
    for (const v of data) { assert.ok(Number.isFinite(v), `${key} is finite`); peak = Math.max(peak, Math.abs(v)); }
    assert.ok(peak <= 1 && peak >= 0.05, `${key} peak ${peak}`);
    assert.ok(data.length / rate <= 4.01, `${key} is short`);
    if (!loops.has(key)) assert.ok(Math.abs(data[data.length - 1]) < 1e-3, `${key} ends at silence`);
  }
});

test('sounds are identical per variant and different between variants', () => {
  for (const key of ['gun:kr5', 'step:wood', 'impact:concrete', 'explosion:frag'] as const) {
    assert.deepEqual(renderSound(key, RATE, 1), renderSound(key, RATE, 1));
    assert.ok(Math.abs(correlation(renderSound(key, RATE, 0), renderSound(key, RATE, 1))) < 0.9, `${key} variants differ`);
  }
});

const gun = (voice: GunVoice) => renderGunCore(voice, RATE, createRng(hashSeed(`test:${voice}`)));
const loudness = (voice: GunVoice) => { const data = gun(voice).slice(0, RATE * 0.06); return Math.sqrt(bandEnergy(data, RATE, 200, 10000) / data.length) * GUN_DESIGNS[voice].level; };

test('every gun lands hard: the crack leads, and the weight reaches phone speakers too', () => {
  for (const voice of GUN_VOICES) {
    const data = gun(voice), total = energyOf(data), envelope = envelopeOf(data, RATE, 0.004);
    assert.ok(timeToPeak(data, RATE) < 0.025, `${voice} peaks inside its blast`);
    assert.ok(envelope[0] >= Math.max(...envelope) * 0.87, `${voice} starts at full force: the first 4 ms are its loudest`);
    if (voice === 'drone') continue;
    assert.ok(bandEnergy(data, RATE, 150, 500) / total > 0.05, `${voice} has body where small speakers play`);
    assert.ok(lowShare(data, RATE) > 0.08, `${voice} has a low thump`);
  }
  for (const heavy of ['breaker12', 'longbow'] as const) {
    assert.ok(lowShare(gun(heavy), RATE) > 0.35, `${heavy} is heavy`);
    for (const light of ['hornet9', 'sentry9', 'drone'] as const) assert.ok(loudness(heavy) > loudness(light), `${heavy} is louder than ${light}`);
  }
  assert.ok(loudness('kr5') > loudness('hornet9') && loudness('kr5') > loudness('drone'));
});

test('each weapon has its own voice: brightness, weight and length all differ', () => {
  const features = new Map(GUN_VOICES.map(voice => {
    const data = gun(voice);
    return [voice, { bright: logCentroid(data, RATE), low: lowShare(data, RATE), long: decayTime(data, RATE, 60), crack: bandEnergy(data, RATE, 2000, 8000) / energyOf(data) }];
  }));
  const f = (voice: GunVoice) => features.get(voice)!;
  // Darkest to brightest; the Heron 7 sits between the shotgun and the carbine.
  const order: GunVoice[] = ['breaker12', 'kr5', 'hornet9', 'sentry9', 'drone'];
  order.slice(1).forEach((voice, i) => assert.ok(f(voice).bright > f(order[i]).bright * 1.2, `${voice} is brighter than ${order[i]}`));
  assert.ok(f('longbow').bright > f('breaker12').bright && f('longbow').bright * 1.1 < f('kr5').bright, 'the Heron 7 is darker than the carbine');
  assert.ok(f('longbow').long > f('breaker12').long && f('breaker12').long > f('kr5').long && f('kr5').long > f('hornet9').long);
  assert.ok(f('longbow').crack > f('breaker12').crack * 1.4, 'the rifle cracks, the shotgun booms');
  // No two guns sit close together in (brightness, weight, length, crack).
  for (const a of GUN_VOICES) for (const b of GUN_VOICES) {
    if (a >= b) continue;
    const d = Math.hypot(Math.log2(f(a).bright / f(b).bright), 4 * (f(a).low - f(b).low), 4 * (f(a).long - f(b).long), 4 * (f(a).crack - f(b).crack));
    assert.ok(d > 0.35, `${a} and ${b} differ (${d.toFixed(2)})`);
  }
  // Automatic weapons must leave a gap before the next round (750 / 900 rpm).
  for (const [voice, interval] of [['kr5', 0.08], ['hornet9', 0.0667]] as const) {
    const env = envelopeOf(gun(voice), RATE, 0.004), at = Math.floor(interval / 0.004) - 1;
    assert.ok(env[at] < env[0] * 0.2, `${voice} drops 14 dB before the next shot`);
  }
});

test('the distant layer is a darker, longer boom than the close shot', () => {
  for (const voice of GUN_VOICES) {
    const close = gun(voice), far = renderGunFar(voice, RATE, createRng(9));
    assert.ok(logCentroid(far, RATE) < logCentroid(close, RATE), `${voice} far is darker`);
    assert.ok(decayTime(far, RATE, 40) > decayTime(close, RATE, 40), `${voice} far rolls on longer`);
  }
});

test('rooms are short and dense; the street answers with slapback echoes and a longer tail', () => {
  for (const tier of ['phone', 'desktop'] as const) {
    const lengths = REVERB_SECONDS[tier];
    const room = roomImpulse(RATE, lengths.room, createRng(1)), street = streetImpulse(RATE, lengths.street, createRng(2));
    for (const ir of [room.left, room.right, street.left, street.right]) assert.ok(Math.abs(energyOf(ir) - 1) < 1e-3, 'unit energy');
    assert.ok(Math.abs(correlation(room.left, room.right)) < 0.3 && Math.abs(correlation(street.left, street.right)) < 0.3, 'stereo sides differ');
    assert.ok(energyOf(room.left, 0, RATE * 0.035) > 0.25, 'a room answers at once');
    assert.ok(energyOf(street.left, 0, RATE * 0.035) < 0.01, 'the street is quiet until the first echo');
    const env = envelopeOf(street.left, RATE, 0.002), gap = [...env.slice(10, 20)].sort((a, b) => a - b)[5];
    assert.ok(Math.max(...env.slice(21, 34)) > gap * 20, 'the first house front slaps back between 42 and 68 ms');
    assert.ok(decayTime(street.left, RATE, 40) > decayTime(room.left, RATE, 40), 'outdoors rings on longer');
    assert.ok(logCentroid(street.left, RATE) < 3500 && logCentroid(room.left, RATE) < 4500, 'reverbs are darker than the dry sound');
  }
  assert.ok(REVERB_SECONDS.phone.room < REVERB_SECONDS.desktop.room && REVERB_SECONDS.phone.street < REVERB_SECONDS.desktop.street);
});

test('spatial helpers: direction, distance, air, walls and roofs', () => {
  const ear = { x: 0, y: 0, z: 0, yaw: 0, indoors: false };
  assert.deepEqual(Object.values(relative(ear, { x: 5, y: 0, z: 0 })).map(v => Math.round(v) + 0), [5, 0, 0, 5]);
  assert.equal(Math.round(relative(ear, { x: 0, y: 0, z: -5 }).ahead), 5);
  assert.equal(Math.round(relative({ ...ear, yaw: Math.PI / 2 }, { x: 5, y: 0, z: 0 }).ahead), 5);
  for (const kind of ['gun', 'step', 'explosion'] as const) {
    let previous = Infinity;
    for (let d = 0; d < 60; d += 2) { const g = falloffGain(kind, d); assert.ok(g <= previous && g >= 0); previous = g; }
  }
  assert.equal(falloffGain('step', 30), 0, 'footsteps fade out within 28 m');
  assert.ok(falloffGain('gun', 70) >= 0.05, 'gunfire carries across the whole town');
  assert.equal(airCutoff('gun', 0), 20000);
  assert.ok(airCutoff('gun', 30) < 11000 && airCutoff('gun', 60) < 6000);
  assert.deepEqual(nearFarMix(5), { near: 1, far: 0 });
  assert.ok(nearFarMix(60).near <= 0.35 && nearFarMix(60).far > 0.85);
  assert.ok(occlusion({ x: -5, y: 1.6, z: -4.7 }, { x: -14, y: 1.5, z: -4.7 }) > 0.6, 'the teal house front wall blocks sound');
  assert.equal(occlusion({ x: -8, y: 1.5, z: -12 }, { x: 8, y: 1.5, z: -12 }), 0, 'the open street does not');
  assert.equal(occlusion({ x: -10, y: 1.5, z: -4.7 }, { x: -5, y: 1.5, z: -4.7 }), 0, 'standing inside a wall face does not block your own line');
  assert.ok(coveredAbove({ x: -14, y: 0, z: -4 }) && coveredAbove({ x: 2.65, y: 0.36, z: 6.3 }), 'house rooms and the truck box are indoors');
  assert.ok(!coveredAbove({ x: 0, y: 0, z: -12 }) && !coveredAbove({ x: -14, y: 6.42, z: -4 }), 'the street and the roof top are outdoors');
});
