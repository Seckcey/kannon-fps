import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { GameView } from '../game/GameView';
import { HudStore } from '../game/hud';
import { VEHICLE_TEST_ASSETS } from '../game/assets';
import { InputController } from '../game/InputController';
import { EXPOSURE, FOG, HEMISPHERE, SUN_COLOR, SUN_INTENSITY } from '../game/Atmosphere';
import { movePlayer, moveDefaults } from '../../shared/physics';
import { DEFAULT_LOADOUT } from '../../shared/weapons';
import type { InputFrame, PlayerState, PublicPlayerState, WorldSnapshot } from '../../shared/protocol';
import '../styles.css';
import './review.css';

type Variant = 'current' | 'improved';
type Quality = 'auto' | 'high' | 'low';
type Vec = [number, number, number];
const views: Record<string, { label: string; player: Vec; yaw: number; pitch: number; camera?: Vec; target?: Vec }> = {
  'bus-close': { label: 'Bus · close detail', player: [-7, 0, -13], yaw: 2.65, pitch: -.04, camera: [-8.2, 3.1, -14.3], target: [-2.4, 1.5, -6.2] },
  'bus-gameplay': { label: 'Bus · player view', player: [-7, 0, -13], yaw: 2.65, pitch: -.025 },
  'bus-detail': { label: 'Bus · wheel and panel detail', player: [-7, 0, -13], yaw: 2.65, pitch: -.025, camera: [-6.1, 1.8, -10.6], target: [-3.0, 1.25, -8.0] },
  'south-close': { label: 'South car · close detail', player: [-7, 0, 20.7], yaw: .6, pitch: -.04, camera: [-7.5, 2.3, 19.3], target: [-3.9, .95, 16.2] },
  'south-gameplay': { label: 'South car · player view', player: [-7, 0, 20.7], yaw: .6, pitch: -.06 },
  'south-detail': { label: 'South car · wheel and panel detail', player: [-7, 0, 20.7], yaw: .6, pitch: -.06, camera: [-5.7, 1.25, 18.7], target: [-4.7, .68, 16.65] },
  'north-close': { label: 'North car · close detail', player: [0, 0, -12.5], yaw: .686, pitch: -.04, camera: [.2, 2.3, -14.2], target: [4, .95, -17.4] },
  'north-gameplay': { label: 'North car · player view', player: [0, 0, -12.5], yaw: .686, pitch: -.06 },
};
const params = new URLSearchParams(location.search);
const townMode = location.pathname.endsWith('/graphics-test.html');
if (townMode) Object.assign(views, {
  'street': { label: 'Main street · architecture', player: [0, 0, 17], yaw: 0, pitch: -.04, camera: [3.5, 3.8, 19.5], target: [-6, 2.2, -3] },
  'teal-front': { label: 'Teal house · siding and windows', player: [-5, 0, -9], yaw: -1, pitch: 0, camera: [-3.5, 3, -11.5], target: [-11, 3.3, -.5] },
  'yellow-front': { label: 'Yellow house · facade and garage', player: [5, 0, 16], yaw: 2, pitch: 0, camera: [4.2, 3.4, 18.8], target: [12, 3, 3.5] },
  'roof-detail': { label: 'Roof · ridge and gutter detail', player: [-7, 0, -13], yaw: 0, pitch: 0, camera: [-9, 7.6, -13.7], target: [-16, 6.8, -3.5] },
  'teal-room': { label: 'Teal house · ground floor', player: [-13, 0, 0], yaw: 0, pitch: 0, camera: [-10.7, 1.75, 4.8], target: [-16.4, 1.2, -3.1] },
  'yellow-upstairs': { label: 'Yellow house · upstairs', player: [13, 3.2, 1], yaw: 0, pitch: 0, camera: [14, 4.9, 4.8], target: [9.5, 4.6, -.2] },
  'yard': { label: 'Backyard · fence and trees', player: [-28, 0, -18.5], yaw: 1.57, pitch: -.04, camera: [-25.5, 2, -16], target: [-32.5, 2.4, -10] },
  'spawn-gameplay': { label: 'Spawn · player view', player: [-28, 0, -18.5], yaw: Math.PI/2, pitch: -.04 },
  // Kannon Town v3: the checkpoint, at standing eye height (1.62 m) like the first-person game.
  'checkpoint-north': { label: 'Checkpoint · from the north end', player: [-3, 0, -21], yaw: 2.8, pitch: -.03, camera: [-3, 1.62, -21], target: [2, 0.9, -9] },
  'checkpoint-south': { label: 'Checkpoint · from the south end', player: [-1, 0, 21], yaw: 0, pitch: -.03, camera: [-1.5, 1.62, 21], target: [1.5, 1.0, 6] },
  'truck': { label: 'Cargo truck · cab and canvas', player: [5.5, 0, -5.5], yaw: 2.8, pitch: -.03, camera: [6.2, 1.62, -6.2], target: [2.6, 1.4, 2.0] },
  'burnt-car': { label: 'Burnt-out car and ammo crates', player: [8.5, 0, -13], yaw: -2.4, pitch: -.05, camera: [8.5, 1.62, -12.5], target: [3.5, 0.7, -17.4] },
  'barrier': { label: 'Concrete barrier · east lane', player: [3, 0, -6], yaw: 2.4, pitch: -.1, camera: [3.2, 1.62, -6.2], target: [6.6, 0.5, -9.5] },
  'yard-sandbags': { label: 'Back yard · sandbag wall', player: [-21, 0, 12], yaw: -1.2, pitch: -.05, camera: [-21.5, 1.62, 12.5], target: [-26.6, 0.6, 8.6] },
  'teal-shadow': { label: 'Street · long shadows', player: [6, 0, 14], yaw: -.4, pitch: -.03, camera: [6.5, 1.62, 15], target: [-2, 1.2, -6] },
});
const original = params.get('original') === '1';
// ?graphics=v2 compares the refined town (Before) with Kannon Town v2 (After);
// ?graphics=v3 compares Kannon Town v2 (Before) with the v3 checkpoint at golden hour (After).
const v2 = townMode && params.get('graphics') === 'v2';
const v3 = townMode && params.get('graphics') === 'v3';
const phoneTier = params.get('tier') === 'phone';
const initialQuality: Quality = ['high', 'low', 'auto'].includes(params.get('quality') ?? '') ? params.get('quality') as Quality : 'high';
/** Real-time light for each side of a v3 comparison: v2 shipped with this exposure, fog and
 *  daylight; v3 uses the golden-hour values the bake was calibrated against. */
const LIGHT = {
  current: { exposure: 1.0, fog: { color: '#b2cbd0', near: 100, far: 460 }, sun: { color: '#fff4e4', intensity: 3.3 }, hemisphere: { sky: '#d9edff', ground: '#8e7357', intensity: 0.8 } },
  improved: { exposure: EXPOSURE, fog: FOG, sun: { color: SUN_COLOR, intensity: SUN_INTENSITY }, hemisphere: HEMISPHERE },
} as const;
type TestApi = {
  ready: boolean; selectView: (name: string) => void; setVariant: (variant: Variant) => void;
  setQuality: (quality: Quality) => void; walk: () => void;
  info: () => Record<string, unknown>; sample: (ms: number) => Promise<Record<string, unknown>>;
};
declare global { interface Window { vehicleTest: TestApi } }
const percentile = (values: number[], p: number) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] : null;
const publicState = ({ mag: _mag, reserve: _reserve, frags: _frags, rewards: _rewards, reloadSlot: _reloadSlot, readyAt: _readyAt, meleeUntil: _meleeUntil, stamina: _stamina, slideCooldownUntil: _slideCooldown, lastDamageAt: _lastDamage, ...rest }: PlayerState): PublicPlayerState => rest;

function Review() {
  const container = useRef<HTMLDivElement>(null);
  const api = useRef<TestApi | null>(null);
  const [input] = useState(() => new InputController(undefined, { firingMode: 'advanced' }));
  const [variant, setVariant] = useState<Variant>('improved');
  const [selected, setSelected] = useState(townMode ? (v3 ? 'checkpoint-north' : 'street') : 'bus-close');
  const [walking, setWalking] = useState(false);
  const [quality, setQuality] = useState<Quality>(initialQuality);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [stats, setStats] = useState({ fps: 0, drawCalls: 0 });
  const [measuring, setMeasuring] = useState(false);
  const [result, setResult] = useState('');
  useEffect(() => {
    if (!container.current) return;
    let activeView = townMode ? (v3 ? 'checkpoint-north' : 'street') : 'bus-close', activeVariant: Variant = 'improved', activeQuality = initialQuality, free = false;
    let scene: THREE.Scene | undefined, camera: THREE.PerspectiveCamera | undefined, renderer: THREE.WebGLRenderer | undefined;
    let seq = 0, lastJump = false, lastCrouch = false, sampleActive = false, sampleInterrupted = false, gpuDisjointEvents = 0;
    const changedSurface = () => { if (sampleActive) sampleInterrupted = true; };
    document.addEventListener('visibilitychange', changedSurface);
    window.addEventListener('resize', changedSurface);
    window.addEventListener('orientationchange', changedSurface);
    const requireIdle = () => { if (sampleActive) throw new Error('Wait for the current measurement to finish.'); };
    const frames: number[] = [], cpu: number[] = [], gpu: number[] = [];
    const player: PlayerState = {
      id: 'vehicle-review', name: 'Graphics review', color: '#64bdda', x: -7, y: 0, z: -13, yaw: 2.65, pitch: -.04, vx: 0, vy: 0, vz: 0,
      health: 100, slot: 1, weapon: DEFAULT_LOADOUT.primary, loadout: DEFAULT_LOADOUT, kills: 0, deaths: 0, assists: 0, score: 0, streak: 0,
      connected: true, respawnAt: 0, protectedUntil: 0, reloadingUntil: 0, cookingSince: 0, lastInputSeq: 0,
      mag: [30, 12], reserve: [120, 48], frags: 1, rewards: [], reloadSlot: 0, readyAt: 0, meleeUntil: 0, lastDamageAt: 0,
      ...moveDefaults(),
    };
    const snapshotOf = (tick: number, phase: WorldSnapshot['phase']): WorldSnapshot => ({
      tick, serverTime: Date.now(), phase, timeRemaining: 300, mode: 'ffa', scoreLimit: 15,
      players: [publicState(player)], self: { ...player }, winnerIds: [], drones: [], recon: [], mortars: [],
    });
    let snapshot = snapshotOf(0, 'waiting');
    input.setPaused(true);
    let gl: WebGL2RenderingContext | undefined;
    let timerExt: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
    let query: WebGLQuery | null = null;
    const pending: Array<{ query: WebGLQuery; measured: boolean }> = [];
    const hud = new HudStore();
    const applyLight = (s: THREE.Scene, r: THREE.WebGLRenderer) => {
      // Each side of a v3 comparison is shown under the real-time light it was made for.
      const light = LIGHT[activeVariant];
      r.toneMappingExposure = light.exposure;
      if (s.fog instanceof THREE.Fog) { s.fog.color.set(light.fog.color); s.fog.near = light.fog.near; s.fog.far = light.fog.far; }
      for (const object of s.children) {
        if (object instanceof THREE.DirectionalLight) { object.color.set(light.sun.color); object.intensity = light.sun.intensity; }
        if (object instanceof THREE.HemisphereLight) { object.color.set(light.hemisphere.sky); object.groundColor.set(light.hemisphere.ground); object.intensity = light.hemisphere.intensity; }
      }
    };
    const townUrls = v3
      ? { before: phoneTier ? VEHICLE_TEST_ASSETS.townV2Phone : VEHICLE_TEST_ASSETS.townV2, after: phoneTier ? VEHICLE_TEST_ASSETS.townV3Phone : VEHICLE_TEST_ASSETS.townV3 }
      : v2 ? { before: VEHICLE_TEST_ASSETS.refinedTown, after: phoneTier ? VEHICLE_TEST_ASSETS.townV2Phone : VEHICLE_TEST_ASSETS.townV2 }
      : townMode ? { before: VEHICLE_TEST_ASSETS.originalTown, after: VEHICLE_TEST_ASSETS.refinedTown } : null;
    const options = {
      input, hud, getSnapshot: () => snapshot, getPlayerId: () => player.id,
      settings: { quality: initialQuality, volume: 0 }, onStats: setStats,
      onAssetsReady: () => { window.vehicleTest.ready = true; setReady(true); }, onError: setError,
      graphicsTest: {
        lockQuality: true,
        artwork: original ? { environmentUrl: VEHICLE_TEST_ASSETS.originalTown } : townUrls ? { environmentUrl: townUrls.before, environmentVisible: false, vehicles: [
          { name: 'TownVariant_improved', url: townUrls.after, visible: true },
        ] } : { environmentUrl: '/models/environment-vehicle-test.glb', vehicles: [
          { name: 'VehicleVariant_current', url: '/models/vehicles-current.glb', visible: false },
          { name: 'VehicleVariant_improved', url: '/models/vehicles-improved.glb', visible: true },
        ] },
        beforeRender(s: THREE.Scene, c: THREE.PerspectiveCamera, r: THREE.WebGLRenderer) {
          scene = s; camera = c; renderer = r;
          if (v3) applyLight(s, r);
          const preset = views[activeView];
          if (!free && preset.camera) {
            c.position.fromArray(preset.camera); c.lookAt(new THREE.Vector3().fromArray(preset.target!)); c.fov = 68; c.updateProjectionMatrix();
          }
          // The actual character stays visible in normal player-view captures.
          for (const obj of s.children) if (obj instanceof THREE.Group && obj !== s.getObjectByName('VehicleTestTown')) {
            let skinned = false; obj.traverse(child => { if (child instanceof THREE.SkinnedMesh) skinned = true; });
            if (skinned && !free && preset.camera) obj.visible = false;
          }
          s.getObjectByName('VehicleVariant_current')?.traverse(obj => { if (obj.name === 'VehicleVariant_current') obj.visible = activeVariant === 'current'; });
          s.getObjectByName('VehicleVariant_improved')?.traverse(obj => { if (obj.name === 'VehicleVariant_improved') obj.visible = activeVariant === 'improved'; });
          if (townMode) {
            const baseline = s.getObjectByName('VehicleTestTown'), candidate = s.getObjectByName('TownVariant_improved');
            if (baseline) baseline.visible = activeVariant === 'current';
            if (candidate) candidate.visible = activeVariant === 'improved';
          }
          if (!gl) { gl = r.getContext() as WebGL2RenderingContext; timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2'); }
          if (timerExt) {
            const disjoint = gl.getParameter(timerExt.GPU_DISJOINT_EXT);
            if (disjoint && sampleActive) gpuDisjointEvents++;
            for (let i = pending.length - 1; i >= 0; i--) {
              const p = pending[i];
              if (disjoint || gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE)) {
                if (!disjoint && sampleActive && p.measured) gpu.push(gl.getQueryParameter(p.query, gl.QUERY_RESULT) / 1e6);
                gl.deleteQuery(p.query); pending.splice(i, 1);
              }
            }
            if (pending.length < 8 && sampleActive) { query = gl.createQuery(); gl.beginQuery(timerExt.TIME_ELAPSED_EXT, query!); }
          }
        },
        afterRender(_r: THREE.WebGLRenderer, submitMs: number, frameMs: number) {
          if (query && gl && timerExt) { gl.endQuery(timerExt.TIME_ELAPSED_EXT); pending.push({ query, measured: sampleActive }); query = null; }
          if (sampleActive) { frames.push(frameMs); cpu.push(submitMs); }
        },
      },
    };
    // A variable, not a literal: GameView's option list grows with the first-person overhaul.
    const view = new GameView(container.current, options);
    const selectView = (name: string) => {
      requireIdle();
      if (!views[name]) throw new Error(`Unknown view: ${name}`);
      activeView = name; free = false; setSelected(name); setWalking(false); input.setPaused(true);
      const preset = views[name];
      [player.x, player.y, player.z] = preset.player; player.yaw = preset.yaw; player.pitch = preset.pitch;
      player.vx = player.vy = player.vz = 0; input.setView(preset.yaw, preset.pitch);
    };
    const info = () => {
      const debug = gl?.getExtension('WEBGL_debug_renderer_info');
      return { ready: window.vehicleTest.ready, variant: original ? 'original-unsplit' : activeVariant, view: activeView, walking: free,
        quality: activeQuality, qualityLocked: true, ...view.graphicsTestState(), gpu: debug ? gl!.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
        viewport: [container.current!.clientWidth, container.current!.clientHeight], devicePixelRatio,
        canvas: renderer ? [renderer.domElement.width, renderer.domElement.height] : null, pixelRatio: renderer?.getPixelRatio(),
        camera: camera ? { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), fov: camera.fov, projection: camera.projectionMatrix.toArray() } : null,
        lighting: { exposure: renderer?.toneMappingExposure, toneMapping: renderer?.toneMapping, sun: scene?.children.find(o => o instanceof THREE.DirectionalLight)?.intensity, hemisphere: scene?.children.find(o => o instanceof THREE.HemisphereLight)?.intensity, environment: scene?.environmentIntensity, shadows: renderer?.shadowMap.enabled, streetReflection: scene?.userData.streetReflection },
        drawCalls: renderer?.info.render.calls, triangles: renderer?.info.render.triangles, memory: renderer?.info.memory,
        gpuTimerAvailable: !!timerExt, player: { ...player },
        resources: performance.getEntriesByType('resource').filter(e => e.name.includes('/models/')).map(e => { const r = e as PerformanceResourceTiming; return { name: new URL(r.name).pathname, transferSize: r.transferSize, encodedBodySize: r.encodedBodySize, decodedBodySize: r.decodedBodySize, durationMs: r.duration }; }),
      };
    };
    // Development-only handle for probing draw composition from the browser console.
    (window as unknown as { kannonScene?: () => THREE.Scene | undefined }).kannonScene = () => scene;
    const testApi: TestApi = { ready: false, selectView, info,
      setVariant(v) { requireIdle(); if (original && v !== 'current') throw new Error('Original scene has no candidate'); activeVariant = v; setVariant(v); },
      setQuality(q) { requireIdle(); activeQuality = q; setQuality(q); view.setSettings({ quality: q }); },
      walk() { requireIdle(); free = true; setWalking(true); input.setPaused(false); if (!input.isTouch) void input.requestPointerLock(); },
      async sample(ms) {
        if (sampleActive) throw new Error('A sample is already running');
        if (!this.ready || document.hidden || free) throw new Error('Use a visible, ready fixed view for measurement.');
        frames.length = cpu.length = gpu.length = 0; for (const p of pending) p.measured = false;
        sampleActive = true; sampleInterrupted = false; gpuDisjointEvents = 0; setMeasuring(true); const start = performance.now();
        const sampleConfiguration = () => {
          const { viewport, canvas, pixelRatio, devicePixelRatio, camera, lighting } = info();
          return JSON.stringify({ ...view.graphicsTestState(), viewport, canvas, pixelRatio, devicePixelRatio, camera, lighting });
        };
        const startGraphics = sampleConfiguration();
        try { await new Promise(resolve => setTimeout(resolve, ms)); }
        finally { sampleActive = false; setMeasuring(false); }
        if (sampleInterrupted || startGraphics !== sampleConfiguration()) throw new Error('Measurement discarded: visibility, window size, camera or graphics changed. Keep this view open and measure again.');
        if (gpuDisjointEvents) gpu.length = 0;
        return { ...info(), elapsedMs: performance.now() - start, sampleFrames: frames.length,
          fps: frames.length * 1000 / frames.reduce((sum, n) => sum + n, 0),
          frameMs: { p50: percentile(frames, .5), p95: percentile(frames, .95), p99: percentile(frames, .99), over33Percent: frames.filter(n => n > 33.333).length / frames.length * 100 },
          cpuSubmitMs: { p50: percentile(cpu, .5), p95: percentile(cpu, .95) },
          gpuMs: { samples: gpu.length, disjointEvents: gpuDisjointEvents, p50: percentile(gpu, .5), p95: percentile(gpu, .95) },
        };
      },
    };
    api.current = window.vehicleTest = testApi;
    const timer = setInterval(() => {
      const frame: InputFrame = input.current();
      if (free) {
        // Same shared movement as the server: walk, sprint, crouch, slide, jump and vault.
        movePlayer(player, frame, { now: Date.now(), dt: 1 / 30, jumpPressed: frame.jump && !lastJump, crouchPressed: !!frame.crouch && !lastCrouch, moveFactor: 1, adsFactor: 1, canSprint: true });
        player.slot = frame.slot; lastJump = frame.jump; lastCrouch = !!frame.crouch; view.recordInput(frame);
      }
      player.lastInputSeq = frame.seq;
      snapshot = snapshotOf(++seq, free ? 'playing' : 'waiting');
    }, 1000 / 30);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', changedSurface); window.removeEventListener('resize', changedSurface); window.removeEventListener('orientationchange', changedSurface); view.dispose(); input.dispose(); hud.clear(); for (const p of pending) gl?.deleteQuery(p.query); };
  }, [input]);
  return <main className={`vehicle-review ${walking ? 'walking' : ''}`}>
    <div className="review-canvas" ref={container}/>
    <header className="review-toolbar">
      <div className="review-title"><strong>Kannon Arena <span>{townMode ? 'Town graphics' : 'Vehicle test'}</span></strong><small>Local Three.js gameplay renderer · review only</small></div>
      <div className="review-switch" aria-label="Version">
        <button disabled={!ready || original || measuring} aria-pressed={variant === 'current'} onClick={() => api.current?.setVariant('current')}>Before</button>
        <button disabled={!ready || original || measuring} aria-pressed={variant === 'improved'} onClick={() => api.current?.setVariant('improved')}>After</button>
      </div>
      <label>View<select disabled={measuring} value={selected} onChange={e => api.current?.selectView(e.target.value)}>{Object.entries(views).map(([id, v]) => <option key={id} value={id}>{v.label}</option>)}</select></label>
      <label>Graphics<select disabled={measuring} value={quality} onChange={e => api.current?.setQuality(e.target.value as Quality)}><option value="high">High · fixed</option><option value="auto">Auto · fixed</option><option value="low">Low · fixed</option></select></label>
      <button disabled={!ready || measuring} onClick={() => walking ? api.current?.selectView(selected) : api.current?.walk()}>{walking ? 'Return to fixed view' : 'Walk around'}</button>
      <a href={`/?graphics=${variant === 'improved' ? 'improved' : 'current'}`}>Full practice match ↗</a>
    </header>
    <div className="review-caption"><b>{original ? 'ORIGINAL UNSPLIT' : variant === 'improved' ? 'AFTER' : 'BEFORE'}</b><span>{walking ? 'Walk-around · combat is in Full practice match' : views[selected].label}</span><small>{quality.toUpperCase()} · fixed quality · {stats.fps} FPS · {stats.drawCalls} draws</small><small className="portrait-note">Landscape shows more of each scene.</small></div>
    {(!ready || error) && <div className="review-loading" role="status">{error || 'Loading both versions and the game renderer…'}</div>}
    {walking && <div className="review-reticle">+</div>}
    <footer className="review-footer"><span>{walking ? 'WASD · mouse to look · Space to jump · C to crouch · Esc releases the mouse. Combat is in Full practice match.' : 'Switch Before / After without moving the camera. Player views keep the normal game camera.'}</span>
      <button disabled={!ready || measuring || walking} onClick={async () => { setResult('Measuring 20 seconds…'); try { const r = await api.current!.sample(20000); setResult(`${Number(r.fps).toFixed(1)} FPS · p95 ${(r.frameMs as { p95: number }).p95.toFixed(1)} ms`); } catch (e) { setResult(e instanceof Error ? e.message : 'Measurement failed.'); } }}>{measuring ? 'Measuring…' : 'Measure 20 s'}</button><output>{result}</output>
    </footer>
  </main>;
}
if (import.meta.env.DEV) {
  const reactRoot = createRoot(document.getElementById('root')!); reactRoot.render(<Review/>);
  import.meta.hot?.dispose(() => reactRoot.unmount());
}
else document.body.textContent = 'This graphics review is local only.';
