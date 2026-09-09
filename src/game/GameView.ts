import * as THREE from 'three';
import type { GameEvent, InputFrame, PlayerState, WorldSnapshot } from '../../shared/protocol';
import { cameraPosition, directionFromAngles, isPlayerGrounded, raycastMap, supportHeight, type KinematicState } from '../../shared/physics';
import { createBlenderCharacter } from './BlenderCharacter';
import type { CharacterModel } from './Character';
import { disposeCharacterResources } from './Character';
import { InputController } from './InputController';
import { GameAudio } from './GameAudio';
import { createWorld, type ArenaWorld, type WorldArtwork } from './World';
import { SUN_DIRECTION, SKY_LIGHT_INTENSITY } from './Atmosphere';
import type { ArenaPresentation } from './Presentation';
import { RenderQuality, scenePixelRatio } from './RenderQuality';
import { CombatEffects } from './CombatEffects';
import { DeferredRespawns } from './DeferredRespawns';
import { MovementPrediction } from './MovementPrediction';
import { LocomotionVelocity } from './LocomotionVelocity';
import { AutomaticFire, reticleTarget } from './AutomaticFire';
import { muzzlePosition } from '../../shared/physics';

export interface GameSettings {
  sensitivity: number; volume: number; quality: 'auto' | 'high' | 'low'; invertY: boolean;
}
export interface GameStats { fps: number; locked: boolean; drawCalls: number }
export interface GameViewOptions {
  /** Explicit local harness hooks. Omitted in ordinary gameplay. */
  graphicsTest?: {
    artwork?: WorldArtwork;
    lockQuality?: boolean;
    beforeRender?: (scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer) => void;
    afterRender?: (renderer: THREE.WebGLRenderer, cpuSubmitMs: number, frameMs: number) => void;
  };
  input: InputController;
  getSnapshot: () => WorldSnapshot | null;
  getPlayerId: () => string;
  onStats?: (stats: GameStats) => void;
  onAssetsReady?: () => void;
  getPreparationId?: () => string | undefined;
  onPreparationRendered?: (roundId: string) => void;
  onError?: (message: string) => void;
  settings?: Partial<GameSettings>;
}
interface RenderPlayer {
  model: CharacterModel; label: HTMLDivElement; healthBar: HTMLDivElement; shieldBar: HTMLDivElement;
  shadow: THREE.Mesh; position: THREE.Vector3; locomotion: LocomotionVelocity;
}

const defaultSettings: GameSettings = { sensitivity: 1, volume: 0.65, quality: 'auto', invertY: false };
const lerpAngle = (a: number, b: number, t: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

/** Live third-person view. Only the server awards hits, health, eliminations, and ratings. */
export class GameView {
  readonly canvas: HTMLCanvasElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(68, 1, 0.06, 700);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly world: ArenaWorld;
  private presentation: ArenaPresentation | null = null;
  private presentationRequest = 0;
  private readonly renderQuality = new RenderQuality();
  private graphicsConfigured = false;
  private environmentReady = false;
  private characterReady = false;
  private assetsAnnounced = false;
  private renderedPreparationId = '';
  private readonly audio: GameAudio;
  private readonly sun: THREE.DirectionalLight;
  private readonly players = new Map<string, RenderPlayer>();
  private readonly resizeObserver: ResizeObserver;
  private readonly labels = document.createElement('div');
  private readonly effects = new CombatEffects();
  private readonly automaticFire = new AutomaticFire();
  private readonly respawns = new DeferredRespawns();
  private localRespawnAt = 0;
  private readonly shadowGeometry = new THREE.PlaneGeometry(1.45, 1.45);
  private readonly shadowMaterial = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: 'varying vec2 vUv;void main(){float a=pow(max(0.,1.-length(vUv-.5)*2.),2.)*.32;gl_FragColor=vec4(.11,.15,.14,a);}',
  });
  private settings: GameSettings;
  private snapshot: WorldSnapshot | null = null;
  private snapshotBuffer: Array<{ world: WorldSnapshot; received: number }> = [];
  private pendingInputs: InputFrame[] = [];
  private prediction: KinematicState | null = null;
  private readonly movementPrediction = new MovementPrediction();
  private visualPosition = new THREE.Vector3();
  private lastJump = false;
  private acknowledgedJump = false;
  private lastAlive = false;
  private lastSlot = 1;
  private lastReloading = false;
  private lastFrame = performance.now();
  private elapsed = 0;
  private frames = 0;
  private statsTime = 0;
  private slowTime = 0;
  private resizePending = false;
  private raf = 0;
  private disposed = false;
  private lastProcessedTick = -1;
  private firstLocalSnapshot = true;
  private width = 1;
  private height = 1;

  constructor(private container: HTMLElement, private options: GameViewOptions) {
    this.settings = { ...defaultSettings, ...options.settings };
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.canvas = this.renderer.domElement;
    this.canvas.setAttribute('aria-label', 'Kannon Town live third-person arena. Click to capture mouse; Escape releases it.');
    this.canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline:none;';
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener('webglcontextlost', this.contextLost);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color('#b2d0d7');
    this.scene.fog = new THREE.Fog('#b2cbd0', 100, 460);
    this.scene.add(new THREE.HemisphereLight('#d9edff', '#8e7357', 1.05));
    this.sun = new THREE.DirectionalLight('#fff0d6', 3.8);
    this.sun.position.copy(SUN_DIRECTION).multiplyScalar(70);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -48; this.sun.shadow.camera.right = 48;
    this.sun.shadow.camera.top = 48; this.sun.shadow.camera.bottom = -48;
    this.sun.shadow.camera.near = 1; this.sun.shadow.camera.far = 155;
    this.sun.shadow.normalBias = 0.065; this.sun.shadow.bias = -0.00025;
    this.sun.shadow.radius = 2;
    this.scene.add(this.sun, this.sun.target);
    const experiment = import.meta.env.DEV && new URLSearchParams(location.search).get('vehicles') === 'improved';
    const artwork = options.graphicsTest?.artwork ?? (experiment ? { environmentUrl: '/models/environment-vehicle-test.glb', vehicles: [{ name: 'VehicleVariant_improved', url: '/models/vehicles-improved.glb', visible: true }] } : undefined);
    this.world = createWorld(this.renderer, () => { this.environmentReady = true; }, message => this.options.onError?.(message), artwork);
    this.scene.add(this.world.root);
    this.scene.environment = this.world.environment;
    this.scene.background = this.world.background;
    // The HDR sky carries much more energy than an ordinary color cube. Expose
    // its background separately so clear blue and cloud shapes do not wash out.
    this.scene.backgroundIntensity = this.world.environment ? 0.28 : 0.8;
    this.scene.environmentIntensity = SKY_LIGHT_INTENSITY;
    this.scene.add(this.effects.root);
    this.labels.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
    container.append(this.canvas, this.labels);
    options.input.attach(this.canvas);
    this.audio = new GameAudio(this.settings.volume);
    this.setSettings(this.settings);
    this.resizeObserver = new ResizeObserver(this.resize); this.resizeObserver.observe(container);
    document.addEventListener('visibilitychange', this.visibilityChange);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  setSettings(settings: Partial<GameSettings>) {
    const graphicsChanged = !this.graphicsConfigured || (settings.quality !== undefined && settings.quality !== this.settings.quality);
    this.settings = { ...this.settings, ...settings };
    this.options.input.setSettings(this.settings);
    this.audio?.setVolume(this.settings.volume);
    if (!graphicsChanged) return;
    this.graphicsConfigured = true;
    this.renderQuality.reset();
    const mobile = this.options.input.isTouch;
    this.renderer.shadowMap.enabled = this.settings.quality !== 'low';
    const enhanced = (this.settings.quality === 'high' || (this.settings.quality === 'auto' && !mobile)) && this.renderer.extensions.has('EXT_color_buffer_float');
    const request = ++this.presentationRequest;
    if (enhanced && this.presentation) this.presentation.enabled = true;
    else if (enhanced) {
      // Phones do not download the desktop postprocessing bundle. Direct
      // rendering remains usable while this optional effect becomes ready.
      void import('./Presentation').then(({ ArenaPresentation: Presentation }) => {
        if (this.disposed || request !== this.presentationRequest) return;
        this.presentation = new Presentation(this.renderer, this.scene, this.camera);
        this.presentation.resize(this.width, this.height);
      }).catch(() => { /* A failed optional enhancement leaves direct rendering available. */ });
    } else { this.presentation?.dispose(); this.presentation = null; }
    const shadowSize = this.settings.quality === 'high' ? 2048 : mobile ? 1024 : 2048;
    if (this.sun.shadow.mapSize.x !== shadowSize) {
      this.sun.shadow.map?.dispose(); this.sun.shadow.map = null;
      this.sun.shadow.mapSize.set(shadowSize, shadowSize); this.sun.shadow.needsUpdate = true;
    }
    this.slowTime = 0;
    this.resize();
  }

  /** Read-only evidence for the isolated comparison harness. */
  graphicsTestState() {
    return { postprocessing: !!this.presentation?.enabled, shadowSize: this.sun.shadow.mapSize.toArray(), qualityScale: this.renderQuality.scale };
  }

  /** Called once for each input actually sent to the server, at 30 Hz. */
  recordInput(frame: InputFrame) {
    this.pendingInputs.push({ ...frame });
    if (this.pendingInputs.length > 120) this.pendingInputs.splice(0, this.pendingInputs.length - 120);
  }

  handleEvent(event: GameEvent) {
    if (this.disposed) return;
    const localId = this.options.getPlayerId();
    const now = performance.now();
    const fresh = !this.snapshotBuffer.length || this.serverTime(now) - event.at <= 500;
    if (event.type === 'respawn') {
      if (event.playerId === localId) this.localRespawnAt = Math.max(this.localRespawnAt, event.at);
      if (!document.hidden && fresh) this.respawns.enqueue(event.playerId, event.at, now);
      return;
    }
    // A hidden tab must not collect old flashes, audio or per-shot GPU objects.
    if (document.hidden || !fresh) return;
    if (event.type === 'shot') {
      const entry = this.players.get(event.playerId);
      const from = new THREE.Vector3(event.from.x, event.from.y, event.from.z);
      const currentSlot = event.playerId === localId ? this.options.input.peek().slot : this.snapshot?.players.find(player => player.id === event.playerId)?.slot;
      const matchingWeapon = !!entry?.model.root.visible && currentSlot === event.slot;
      if (entry && matchingWeapon) { entry.model.recoil(); entry.model.muzzle.getWorldPosition(from); }
      this.effects.shot(event, from, matchingWeapon);
      const distance = event.playerId === localId ? 0 : from.distanceTo(this.visualPosition);
      const offset = from.clone().sub(this.visualPosition);
      const pan = (offset.x * Math.cos(this.options.input.yaw) + offset.z * Math.sin(this.options.input.yaw)) / Math.max(5, distance);
      this.audio.shot(event.slot, distance, pan);
      if (event.hit && event.playerId === localId) this.audio.hit(event.traces?.some(trace => trace.kind === 'player' && !trace.protected && trace.shield));
    } else if (event.type === 'damage') {
      const kind = event.shieldBroken ? 'break' : (event.shieldDamage ?? 0) > 0 ? 'shield' : 'armor';
      this.players.get(event.playerId)?.model.impact(kind);
      if (event.playerId === localId) this.audio.damage();
      if (event.shieldBroken && (event.playerId === localId || event.attackerId === localId)) this.audio.shieldBreak();
    } else if (event.type === 'elimination') {
      const entry = this.players.get(event.playerId);
      if (entry) this.effects.elimination(entry.position);
      if (event.attackerId === localId) this.audio.elimination();
    } else if (event.type === 'heal') {
      const entry = this.players.get(event.playerId);
      if (entry) this.effects.heal(entry.position);
      if (event.playerId === localId) this.audio.heal();
    }
  }

  private resize = () => {
    if (this.disposed) return;
    this.width = Math.max(1, this.container.clientWidth); this.height = Math.max(1, this.container.clientHeight);
    this.renderer.setPixelRatio(scenePixelRatio(this.width, this.height, window.devicePixelRatio || 1, this.options.input.isTouch, this.settings.quality, this.renderQuality.scale));
    this.renderer.setSize(this.width, this.height, false);
    this.presentation?.resize(this.width, this.height);
    this.camera.aspect = this.width / this.height; this.camera.updateProjectionMatrix();
  };

  prepareAutomaticFire(): boolean {
    const input = this.options.input, now = performance.now();
    const localId = this.options.getPlayerId();
    const local = this.snapshot?.players.find(p => p.id === localId);
    const fresh = !!this.snapshotBuffer.length && now - this.snapshotBuffer[this.snapshotBuffer.length - 1].received < 500;
    const time = this.serverTime(now);
    const eligible = this.assetsAnnounced && fresh && input.acceptsInput && input.isTouch && input.firingMode === 'simple'
      && this.snapshot?.phase === 'playing' && local && local.health > 0 && input.slot !== 3
      && local.reloadingUntil <= time && local.healingUntil <= time && !input.peek().reload;
    let target: string | null = null;
    if (eligible) {
      const targets = this.snapshot!.players.map(p => {
        const rendered = this.players.get(p.id)?.position;
        return rendered ? { ...p, x: rendered.x, y: rendered.y, z: rendered.z } : p;
      });
      target = reticleTarget(this.camera.position, this.camera.getWorldDirection(new THREE.Vector3()), muzzlePosition(this.visualPosition), targets, localId, time, input.slot === 1 ? 100 : 40);
    }
    input.setAutomaticFire(this.automaticFire.update(target, now));
    return !!target;
  }

  private checkAssetsReady() {
    const local = this.players.get(this.options.getPlayerId());
    if (!this.disposed && !this.assetsAnnounced && !document.hidden && this.environmentReady && this.characterReady
      && local && (this.snapshot?.phase !== 'preparing' || local.model.root.visible) && !this.renderer.getContext().isContextLost()) {
      this.assetsAnnounced = true;
      this.options.onAssetsReady?.();
    }
  }

  private checkPreparationRendered() {
    const preparationId = this.options.getPreparationId?.();
    if (!preparationId || this.disposed || !this.assetsAnnounced || document.hidden || this.renderer.getContext().isContextLost()
      || this.renderedPreparationId === preparationId || this.snapshot?.phase !== 'preparing' || this.snapshot.roundId !== preparationId) return;
    const localId = this.options.getPlayerId();
    const local = this.snapshot.players.find(player => player.id === localId);
    if (!local || local.health <= 0 || !local.connected || !this.players.get(localId)?.model.root.visible) return;
    this.renderedPreparationId = preparationId;
    this.options.onPreparationRendered?.(preparationId);
  }

  private contextLost = (event: Event) => {
    if (this.disposed) return;
    event.preventDefault(); this.options.input.setPaused(true);
    this.options.onError?.('Your graphics were interrupted. Rejoin the match to restore your view.');
  };

  private visibilityChange = () => {
    // Time spent in another app is not a slow GPU frame and must not lower graphics quality.
    this.lastFrame = performance.now();
    this.frames = 0; this.statsTime = 0; this.slowTime = 0;
    this.renderQuality.resetTiming();
    this.effects.clear(); this.respawns.clear();
    for (const entry of this.players.values()) entry.locomotion.reset();
  };

  private receiveSnapshot(snapshot: WorldSnapshot, now: number) {
    const roundReset = (snapshot.phase === 'preparing' && this.snapshot?.phase !== 'preparing')
      || (snapshot.phase === 'countdown' && this.snapshot?.phase !== 'countdown' && this.snapshot?.phase !== 'preparing')
      || (snapshot.phase === 'playing' && this.snapshot?.phase === 'finished');
    if (roundReset) {
      this.effects.clear(); this.respawns.clear(); this.localRespawnAt = 0;
      for (const entry of this.players.values()) entry.locomotion.reset();
    }
    // Events precede snapshots. Reset the camera only when this life is present,
    // including respawns received while rendering was suspended in another app.
    if (this.localRespawnAt && snapshot.serverTime >= this.localRespawnAt) {
      const respawned = snapshot.players.find(player => player.id === this.options.getPlayerId());
      if (respawned && respawned.health > 0 && respawned.connected) this.firstLocalSnapshot = true;
      this.localRespawnAt = 0;
    }
    this.snapshot = snapshot;
    this.lastProcessedTick = snapshot.tick;
    this.snapshotBuffer.push({ world: snapshot, received: now });
    if (this.snapshotBuffer.length > 12) this.snapshotBuffer.shift();
    const local = snapshot.players.find(player => player.id === this.options.getPlayerId());
    if (!local) return;
    this.options.input.resumeSequence(local.lastInputSeq);
    const acknowledged = this.pendingInputs.filter(frame => frame.seq <= local.lastInputSeq).at(-1);
    if (acknowledged) this.acknowledgedJump = acknowledged.jump;
    this.pendingInputs = this.pendingInputs.filter(frame => frame.seq > local.lastInputSeq);
    const alive = local.health > 0;
    if (this.firstLocalSnapshot || roundReset || (!this.lastAlive && alive)) {
      this.options.input.resetSpawnView(local.yaw, local.pitch);
      this.visualPosition.set(local.x, local.y, local.z);
      this.pendingInputs = [];
      this.acknowledgedJump = false;
      this.lastJump = this.options.input.peek().jump;
      this.firstLocalSnapshot = false;
    }
    this.lastAlive = alive;
    this.prediction = { x: local.x, y: local.y, z: local.z, vx: local.vx, vy: local.vy, vz: local.vz, yaw: local.yaw, pitch: local.pitch };
    this.movementPrediction.reset(local, snapshot.serverTime);
    if (snapshot.phase === 'playing' && alive) {
      let previousJump = this.acknowledgedJump;
      for (const frame of this.pendingInputs) { this.movementPrediction.step(this.prediction, frame, 1 / 30, !previousJump); previousJump = frame.jump; }
    }
    // Teleports and respawns should never drag a camera through the arena.
    if (this.visualPosition.distanceTo(new THREE.Vector3(this.prediction.x, this.prediction.y, this.prediction.z)) > 3.5) this.visualPosition.set(this.prediction.x, this.prediction.y, this.prediction.z);
  }

  private addPlayer(player: PlayerState): RenderPlayer {
    const local = player.id === this.options.getPlayerId();
    const model = createBlenderCharacter(player.color,
      local ? () => { this.characterReady = true; } : undefined,
      message => this.options.onError?.(message));
    this.scene.add(model.root);
    const label = document.createElement('div');
    label.style.cssText = 'position:absolute;left:0;top:0;transform:translate(-50%,-100%);color:#fff;font:700 11px system-ui,sans-serif;letter-spacing:.04em;text-shadow:0 1px 3px #183543;white-space:nowrap;will-change:left,top;';
    const name = document.createElement('div'); name.textContent = player.name;
    name.style.cssText = 'padding:3px 7px;background:#103543b3;border-radius:3px;';
    const track = document.createElement('div'); track.style.cssText = 'height:3px;background:#0d263b88;margin:2px 7px 0;border-radius:2px;overflow:hidden;';
    const healthBar = document.createElement('div'); healthBar.style.cssText = 'height:100%;background:#baf453;';
    const shieldTrack = document.createElement('div'); shieldTrack.style.cssText = 'height:2px;background:#0d263b88;margin:2px 7px 0;border-radius:2px;overflow:hidden;';
    const shieldBar = document.createElement('div'); shieldBar.style.cssText = 'height:100%;background:#73dfff;';
    shieldTrack.append(shieldBar); track.append(healthBar); label.append(name, shieldTrack, track); this.labels.append(label);
    const shadow = new THREE.Mesh(this.shadowGeometry, this.shadowMaterial); shadow.rotation.x = -Math.PI / 2; shadow.renderOrder = 1; this.scene.add(shadow);
    const entry = { model, label, healthBar, shieldBar, shadow, position: new THREE.Vector3(player.x, player.y, player.z), locomotion: new LocomotionVelocity() }; this.players.set(player.id, entry); return entry;
  }

  private opponentState(player: PlayerState, now: number): PlayerState {
    if (this.snapshotBuffer.length < 2) return player;
    const newest = this.snapshotBuffer[this.snapshotBuffer.length - 1];
    const target = newest.world.serverTime + Math.min(100, now - newest.received) - 100;
    let previous = this.snapshotBuffer[0].world; let next = newest.world;
    for (let i = 1; i < this.snapshotBuffer.length; i++) {
      if (this.snapshotBuffer[i].world.serverTime >= target) { previous = this.snapshotBuffer[i - 1].world; next = this.snapshotBuffer[i].world; break; }
    }
    const a = previous.players.find(item => item.id === player.id); const b = next.players.find(item => item.id === player.id);
    if (!a || !b || a.health <= 0 || b.health <= 0 || Math.hypot(a.x - b.x, a.z - b.z) > 5) return player;
    const interval = next.serverTime - previous.serverTime;
    if (interval <= 0 || ![target, interval, a.x, a.y, a.z, b.x, b.y, b.z].every(Number.isFinite)) return player;
    const blend = THREE.MathUtils.clamp((target - previous.serverTime) / interval, 0, 1);
    return { ...player, x: THREE.MathUtils.lerp(a.x, b.x, blend), y: THREE.MathUtils.lerp(a.y, b.y, blend), z: THREE.MathUtils.lerp(a.z, b.z, blend), yaw: lerpAngle(a.yaw, b.yaw, blend), pitch: THREE.MathUtils.lerp(a.pitch, b.pitch, blend) };
  }

  private frame = (now: number) => {
    if (this.disposed) return;
    // Changing the drawing buffer clears it. Apply adaptive sizes before drawing
    // the next frame, never after the completed frame is ready for the browser.
    if (this.resizePending) { this.resizePending = false; this.resize(); }
    const elapsedFrame = Math.max(0.001, (now - this.lastFrame) / 1000);
    const dt = Math.min(0.05, elapsedFrame); this.lastFrame = now;
    this.elapsed += dt; this.frames++; this.statsTime += elapsedFrame;
    const incoming = this.options.getSnapshot();
    if (incoming && (incoming.tick !== this.lastProcessedTick || incoming !== this.snapshot)) {
      this.receiveSnapshot(incoming, now);
      this.respawns.flush(incoming, now, player => {
        if (document.hidden) return;
        this.effects.respawn(player);
        if (player.id === this.options.getPlayerId()) this.audio.respawn();
      });
    }
    const localId = this.options.getPlayerId(); const input = this.options.input.peek();
    const localState = this.snapshot?.players.find(player => player.id === localId);
    if (this.prediction && localState) {
      const fresh = this.snapshotBuffer.length > 0 && now - this.snapshotBuffer[this.snapshotBuffer.length - 1].received < 500;
      const sprinting = this.snapshot?.phase === 'playing' && localState.health > 0 && fresh
        ? this.movementPrediction.step(this.prediction, input, dt, !this.lastJump) : false;
      this.lastJump = input.jump;
      this.visualPosition.lerp(new THREE.Vector3(this.prediction.x, this.prediction.y, this.prediction.z), 1 - Math.exp(-dt * 24));
      const position = cameraPosition(this.visualPosition, input.yaw, input.pitch, input.aim);
      this.camera.position.set(position.x, position.y, position.z);
      const direction = directionFromAngles(input.yaw, input.pitch);
      this.camera.lookAt(this.camera.position.x + direction.x, this.camera.position.y + direction.y, this.camera.position.z + direction.z);
      const fov = input.aim ? 57 : sprinting && Math.hypot(input.moveX, input.moveZ) > 0.1 ? 73 : 68;
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, fov, 1 - Math.exp(-dt * 9)); this.camera.updateProjectionMatrix();
      if (input.slot !== this.lastSlot) { this.audio.switchWeapon(); this.lastSlot = input.slot; }
      const reloading = localState.reloadingUntil > this.serverTime(now);
      if (reloading && !this.lastReloading) this.audio.reload(); this.lastReloading = reloading;
    } else {
      const orbit = this.elapsed * 0.025;
      this.camera.position.set(Math.sin(orbit) * 27, 15, Math.cos(orbit) * 27); this.camera.lookAt(0, 1.2, -3);
    }
    const time = this.serverTime(now);
    for (const state of this.snapshot?.players ?? []) {
      const entry = this.players.get(state.id) ?? this.addPlayer(state); const local = state.id === localId;
      let rendered = local && this.prediction ? { ...state, ...this.prediction, x: this.visualPosition.x, y: this.visualPosition.y, z: this.visualPosition.z, yaw: input.yaw, pitch: input.pitch, slot: input.slot } : this.opponentState(state, now);
      entry.position.set(rendered.x, rendered.y, rendered.z);
      entry.model.root.position.copy(entry.position); entry.model.root.rotation.y = -rendered.yaw;
      const velocity = entry.locomotion.update(rendered, elapsedFrame, local ? 'local' : 'remote');
      entry.model.update({ ...rendered, vx: velocity.vx, vz: velocity.vz }, dt, time, local, { aim: local ? input.aim : rendered.aiming ?? false, grounded: isPlayerGrounded(rendered) });
      if (local && this.camera.position.distanceTo(entry.position.clone().add(new THREE.Vector3(0, 1.35, 0))) < 0.8) entry.model.root.visible = false;
      entry.shadow.visible = state.health > 0 && state.connected;
      const shadowFloor = supportHeight(rendered);
      entry.shadow.position.set(rendered.x, shadowFloor + 0.018, rendered.z);
      entry.shadow.scale.setScalar(Math.max(0.5, 1 - (rendered.y - shadowFloor) * 0.16));
      if (local || state.health <= 0 || !state.connected) entry.label.style.display = 'none';
      else {
        const head = new THREE.Vector3(rendered.x, rendered.y + 2.2, rendered.z);
        const sight = new THREE.Vector3(rendered.x, rendered.y + 1.65, rendered.z);
        const ray = sight.sub(this.camera.position); const distance = ray.length(); ray.normalize();
        const wall = raycastMap(this.camera.position, ray, distance);
        const projected = head.project(this.camera);
        const visible = wall >= distance - 0.2 && projected.z > 0 && projected.z < 1 && Math.abs(projected.x) < 1.1 && Math.abs(projected.y) < 1.1;
        entry.label.style.display = visible ? 'block' : 'none';
        if (visible) { entry.label.style.left = `${(projected.x * 0.5 + 0.5) * this.width}px`; entry.label.style.top = `${(-projected.y * 0.5 + 0.5) * this.height}px`; entry.healthBar.style.width = `${rendered.health}%`; entry.shieldBar.style.width = `${Math.max(0, Math.min(100, rendered.shield * 2))}%`; }
      }
    }
    const currentIds = new Set(this.snapshot?.players.map(player => player.id) ?? []);
    for (const [id, entry] of this.players) if (!currentIds.has(id)) { this.scene.remove(entry.model.root, entry.shadow); entry.model.dispose(); entry.label.remove(); this.players.delete(id); }
    this.world.update(this.elapsed); this.effects.update(elapsedFrame, this.camera);
    this.options.graphicsTest?.beforeRender?.(this.scene, this.camera, this.renderer);
    this.renderer.info.reset();
    const submitStarted = this.options.graphicsTest ? performance.now() : 0;
    if (this.presentation?.enabled) this.presentation.render(dt);
    else this.renderer.render(this.scene, this.camera);
    this.options.graphicsTest?.afterRender?.(this.renderer, performance.now() - submitStarted, elapsedFrame * 1000);
    // Parsing and scene attachment alone do not prove that the player has a usable view.
    this.checkAssetsReady();
    this.checkPreparationRendered();
    if (this.statsTime >= 0.7) {
      const fps = Math.round(this.frames / this.statsTime);
      this.options.onStats?.({ fps, locked: this.options.input.locked, drawCalls: this.renderer.info.render.calls });
      if (!this.options.graphicsTest?.lockQuality && this.settings.quality === 'auto' && this.assetsAnnounced) {
        this.slowTime = fps < 38 ? this.slowTime + this.statsTime : Math.max(0, this.slowTime - this.statsTime);
        if (this.slowTime > 2.1 && this.presentation?.enabled) { this.presentation.enabled = false; this.slowTime = 0; this.renderQuality.resetTiming(); }
      }
      if (!this.options.graphicsTest?.lockQuality && this.assetsAnnounced && this.renderQuality.observe(fps, this.statsTime, this.settings.quality)) this.resizePending = true;
      this.statsTime = 0; this.frames = 0;
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  private serverTime(now: number) {
    const latest = this.snapshotBuffer[this.snapshotBuffer.length - 1]; return latest ? latest.world.serverTime + now - latest.received : Date.now();
  }

  dispose() {
    this.disposed = true; cancelAnimationFrame(this.raf); this.resizeObserver.disconnect(); this.audio.dispose();
    document.removeEventListener('visibilitychange', this.visibilityChange);
    for (const entry of this.players.values()) { entry.model.dispose(); entry.label.remove(); }
    this.players.clear(); this.world.dispose();
    this.effects.dispose(); this.respawns.dispose(); this.localRespawnAt = 0;
    disposeCharacterResources();
    const geometries = new Set<THREE.BufferGeometry>(); const materials = new Set<THREE.Material>();
    this.scene.traverse(object => { if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) { geometries.add(object.geometry); for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material); } });
    for (const geometry of geometries) geometry.dispose(); for (const material of materials) material.dispose();
    this.presentation?.dispose(); this.scene.environment = null;
    this.sun.shadow.map?.dispose(); this.renderer.dispose(); this.renderer.forceContextLoss();
    this.canvas.removeEventListener('webglcontextlost', this.contextLost);
    this.canvas.remove(); this.labels.remove(); this.pendingInputs = []; this.snapshotBuffer = [];
  }
}
