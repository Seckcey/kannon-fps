import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { GameView } from '../game/GameView';
import { InputController } from '../game/InputController';
import { TouchControls } from '../components/TouchControls';
import { movePlayer } from '../../shared/physics';
import type { PlayerState, WorldSnapshot } from '../../shared/protocol';
import '../styles.css';
import './review.css';

type Variant = 'current' | 'improved';
type Quality = 'auto' | 'high' | 'low';
type Vec = [number, number, number];
const views: Record<string, { label: string; player: Vec; yaw: number; pitch: number; camera?: Vec; target?: Vec }> = {
  'bus-close': { label: 'Bus · close detail', player: [-7, 0, -13], yaw: 2.65, pitch: -.04, camera: [-8.2, 3.1, -14.3], target: [-2.4, 1.5, -6.2] },
  'bus-gameplay': { label: 'Bus · third person', player: [-7, 0, -13], yaw: 2.65, pitch: -.025 },
  'bus-detail': { label: 'Bus · wheel and panel detail', player: [-7, 0, -13], yaw: 2.65, pitch: -.025, camera: [-6.1, 1.8, -10.6], target: [-3.0, 1.25, -8.0] },
  'south-close': { label: 'South car · close detail', player: [-7, 0, 20.7], yaw: .6, pitch: -.04, camera: [-7.5, 2.3, 19.3], target: [-3.9, .95, 16.2] },
  'south-gameplay': { label: 'South car · third person', player: [-7, 0, 20.7], yaw: .6, pitch: -.06 },
  'south-detail': { label: 'South car · wheel and panel detail', player: [-7, 0, 20.7], yaw: .6, pitch: -.06, camera: [-5.7, 1.25, 18.7], target: [-4.7, .68, 16.65] },
  'north-close': { label: 'North car · close detail', player: [0, 0, -12.5], yaw: .686, pitch: -.04, camera: [.2, 2.3, -14.2], target: [4, .95, -17.4] },
  'north-gameplay': { label: 'North car · third person', player: [0, 0, -12.5], yaw: .686, pitch: -.06 },
};
const params = new URLSearchParams(location.search);
const original = params.get('original') === '1';
const initialQuality: Quality = ['high', 'low', 'auto'].includes(params.get('quality') ?? '') ? params.get('quality') as Quality : 'high';
type TestApi = {
  ready: boolean; selectView: (name: string) => void; setVariant: (variant: Variant) => void;
  setQuality: (quality: Quality) => void; walk: () => void;
  info: () => Record<string, unknown>; sample: (ms: number) => Promise<Record<string, unknown>>;
};
declare global { interface Window { vehicleTest: TestApi } }
const percentile = (values: number[], p: number) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] : null;

function Review() {
  const container = useRef<HTMLDivElement>(null);
  const api = useRef<TestApi | null>(null);
  const [input] = useState(() => new InputController(undefined, { firingMode: 'advanced' }));
  const [variant, setVariant] = useState<Variant>('improved');
  const [selected, setSelected] = useState('bus-close');
  const [walking, setWalking] = useState(false);
  const [quality, setQuality] = useState<Quality>(initialQuality);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [stats, setStats] = useState({ fps: 0, drawCalls: 0 });
  const [measuring, setMeasuring] = useState(false);
  const [result, setResult] = useState('');
  useEffect(() => {
    if (!container.current) return;
    let activeView = 'bus-close', activeVariant: Variant = 'improved', activeQuality = initialQuality, free = false;
    let scene: THREE.Scene | undefined, camera: THREE.PerspectiveCamera | undefined, renderer: THREE.WebGLRenderer | undefined;
    let seq = 0, lastJump = false, sampleActive = false, sampleInterrupted = false, gpuDisjointEvents = 0;
    const changedSurface = () => { if (sampleActive) sampleInterrupted = true; };
    document.addEventListener('visibilitychange', changedSurface);
    window.addEventListener('resize', changedSurface);
    window.addEventListener('orientationchange', changedSurface);
    const requireIdle = () => { if (sampleActive) throw new Error('Wait for the current measurement to finish.'); };
    const frames: number[] = [], cpu: number[] = [], gpu: number[] = [];
    const player: PlayerState = { id: 'vehicle-review', name: 'Graphics review', color: '#64bdda', x: -7, y: 0, z: -13, yaw: 2.65, pitch: -.04, vx: 0, vy: 0, vz: 0, health: 100, shield: 50, slot: 1, ammoAR: 30, ammoShotgun: 6, heals: 2, kills: 0, deaths: 0, connected: true, respawnAt: 0, protectedUntil: 0, healingUntil: 0, reloadingUntil: 0, lastInputSeq: 0 };
    let snapshot: WorldSnapshot = { tick: 0, serverTime: Date.now(), phase: 'waiting', timeRemaining: 300, players: [{ ...player }], winnerIds: [] };
    input.setPaused(true);
    let gl: WebGL2RenderingContext | undefined;
    let timerExt: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
    let query: WebGLQuery | null = null;
    const pending: Array<{ query: WebGLQuery; measured: boolean }> = [];
    const view = new GameView(container.current, {
      input, getSnapshot: () => snapshot, getPlayerId: () => player.id,
      settings: { quality: initialQuality, volume: 0 }, onStats: setStats,
      onAssetsReady: () => { window.vehicleTest.ready = true; setReady(true); }, onError: setError,
      graphicsTest: {
        lockQuality: true,
        artwork: original ? undefined : { environmentUrl: '/models/environment-vehicle-test.glb', vehicles: [
          { name: 'VehicleVariant_current', url: '/models/vehicles-current.glb', visible: false },
          { name: 'VehicleVariant_improved', url: '/models/vehicles-improved.glb', visible: true },
        ] },
        beforeRender(s, c, r) {
          scene = s; camera = c; renderer = r;
          const preset = views[activeView];
          if (!free && preset.camera) {
            c.position.fromArray(preset.camera); c.lookAt(new THREE.Vector3().fromArray(preset.target!)); c.fov = 68; c.updateProjectionMatrix();
          }
          // The actual Scout stays visible in normal third-person captures.
          for (const obj of s.children) if (obj instanceof THREE.Group && obj !== s.getObjectByName('VehicleTestTown')) {
            let skinned = false; obj.traverse(child => { if (child instanceof THREE.SkinnedMesh) skinned = true; });
            if (skinned && !free && preset.camera) obj.visible = false;
          }
          s.getObjectByName('VehicleVariant_current')?.traverse(obj => { if (obj.name === 'VehicleVariant_current') obj.visible = activeVariant === 'current'; });
          s.getObjectByName('VehicleVariant_improved')?.traverse(obj => { if (obj.name === 'VehicleVariant_improved') obj.visible = activeVariant === 'improved'; });
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
        afterRender(_r, submitMs, frameMs) {
          if (query && gl && timerExt) { gl.endQuery(timerExt.TIME_ELAPSED_EXT); pending.push({ query, measured: sampleActive }); query = null; }
          if (sampleActive) { frames.push(frameMs); cpu.push(submitMs); }
        },
      },
    });
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
        lighting: { exposure: renderer?.toneMappingExposure, toneMapping: renderer?.toneMapping, sun: 3.8, hemisphere: 1.05, environment: scene?.environmentIntensity, shadows: renderer?.shadowMap.enabled },
        drawCalls: renderer?.info.render.calls, triangles: renderer?.info.render.triangles, memory: renderer?.info.memory,
        gpuTimerAvailable: !!timerExt, player: { ...player },
        resources: performance.getEntriesByType('resource').filter(e => e.name.includes('/models/')).map(e => { const r = e as PerformanceResourceTiming; return { name: new URL(r.name).pathname, transferSize: r.transferSize, encodedBodySize: r.encodedBodySize, decodedBodySize: r.decodedBodySize, durationMs: r.duration }; }),
      };
    };
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
      const frame = input.current();
      if (free) { movePlayer(player, frame, 1 / 30, !lastJump); player.slot = frame.slot; lastJump = frame.jump; view.recordInput(frame); }
      player.lastInputSeq = frame.seq;
      snapshot = { ...snapshot, tick: ++seq, serverTime: Date.now(), phase: free ? 'playing' : 'waiting', players: [{ ...player }] };
    }, 1000 / 30);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', changedSurface); window.removeEventListener('resize', changedSurface); window.removeEventListener('orientationchange', changedSurface); view.dispose(); input.dispose(); for (const p of pending) gl?.deleteQuery(p.query); };
  }, [input]);
  return <main className={`vehicle-review ${walking ? 'walking' : ''}`}>
    <div className="review-canvas" ref={container}/>
    <header className="review-toolbar">
      <div className="review-title"><strong>Kannon Arena <span>Vehicle test</span></strong><small>Local Three.js gameplay renderer · review only</small></div>
      <div className="review-switch" aria-label="Vehicle version">
        <button disabled={!ready || original || measuring} aria-pressed={variant === 'current'} onClick={() => api.current?.setVariant('current')}>Before</button>
        <button disabled={!ready || original || measuring} aria-pressed={variant === 'improved'} onClick={() => api.current?.setVariant('improved')}>After</button>
      </div>
      <label>View<select disabled={measuring} value={selected} onChange={e => api.current?.selectView(e.target.value)}>{Object.entries(views).map(([id, v]) => <option key={id} value={id}>{v.label}</option>)}</select></label>
      <label>Graphics<select disabled={measuring} value={quality} onChange={e => api.current?.setQuality(e.target.value as Quality)}><option value="high">High · fixed</option><option value="auto">Auto · fixed</option><option value="low">Low · fixed</option></select></label>
      <button disabled={!ready || measuring} onClick={() => walking ? api.current?.selectView(selected) : api.current?.walk()}>{walking ? 'Return to fixed view' : 'Walk around'}</button>
      <a href={`/?vehicles=${variant === 'improved' ? 'improved' : 'current'}`}>Full practice match ↗</a>
    </header>
    <div className="review-caption"><b>{original ? 'ORIGINAL UNSPLIT' : variant === 'improved' ? 'AFTER' : 'BEFORE'}</b><span>{walking ? 'Walk-around · combat is in Full practice match' : views[selected].label}</span><small>{quality.toUpperCase()} · fixed quality · {stats.fps} FPS · {stats.drawCalls} draws</small><small className="portrait-note">Landscape shows more of each vehicle.</small></div>
    {(!ready || error) && <div className="review-loading" role="status">{error || 'Loading both vehicle sets and the game renderer…'}</div>}
    {walking && input.isTouch && <TouchControls input={input} healingSlot={false}/>}
    {walking && <div className="review-reticle">+</div>}
    <footer className="review-footer"><span>{walking ? 'WASD / joystick · mouse / drag to look · Space to jump · Esc releases mouse. Combat is in Full practice match.' : 'Switch Before / After without moving the camera. Third-person views retain the normal gameplay camera.'}</span>
      <button disabled={!ready || measuring || walking} onClick={async () => { setResult('Measuring 20 seconds…'); try { const r = await api.current!.sample(20000); setResult(`${Number(r.fps).toFixed(1)} FPS · p95 ${(r.frameMs as { p95: number }).p95.toFixed(1)} ms`); } catch (e) { setResult(e instanceof Error ? e.message : 'Measurement failed.'); } }}>{measuring ? 'Measuring…' : 'Measure 20 s'}</button><output>{result}</output>
    </footer>
  </main>;
}
if (import.meta.env.DEV) {
  const reactRoot = createRoot(document.getElementById('root')!); reactRoot.render(<Review/>);
  import.meta.hot?.dispose(() => reactRoot.unmount());
}
else document.body.textContent = 'This vehicle graphics experiment is local review only.';
