import * as THREE from 'three';
import type { GameEvent, InputFrame, PlayerState, WorldSnapshot } from '../../shared/protocol';
import { cameraPosition, directionFromAngles, movePlayer, raycastMap, type KinematicState } from '../../shared/physics';
import { createBlenderCharacter } from './BlenderCharacter';
import type { CharacterModel } from './Character';
import { disposeCharacterResources } from './Character';
import { InputController } from './InputController';
import { GameAudio } from './GameAudio';
import { createWorld, type ArenaWorld } from './World';

export interface GameSettings {
  sensitivity: number; volume: number; quality: 'auto' | 'high' | 'low'; invertY: boolean;
}
export interface GameStats { fps: number; locked: boolean; drawCalls: number }
export interface GameViewOptions {
  input: InputController;
  getSnapshot: () => WorldSnapshot | null;
  getPlayerId: () => string;
  onStats?: (stats: GameStats) => void;
  onAssetsReady?: () => void;
  onError?: (message: string) => void;
  settings?: Partial<GameSettings>;
}
interface RenderPlayer {
  model: CharacterModel; label: HTMLDivElement; healthBar: HTMLDivElement;
  shadow: THREE.Mesh; position: THREE.Vector3;
}
interface Particle { position: THREE.Vector3; velocity: THREE.Vector3; color: THREE.Color; life: number; maxLife: number }
interface Trail { mesh: THREE.Line; age: number; material: THREE.LineBasicMaterial }

const defaultSettings: GameSettings = { sensitivity: 1, volume: 0.65, quality: 'auto', invertY: false };
const lerpAngle = (a: number, b: number, t: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

/** Live third-person view. Only the server awards hits, health, eliminations, and ratings. */
export class GameView {
  readonly canvas: HTMLCanvasElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(68, 1, 0.06, 700);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly world: ArenaWorld;
  private readonly audio: GameAudio;
  private readonly sun: THREE.DirectionalLight;
  private readonly players = new Map<string, RenderPlayer>();
  private readonly resizeObserver: ResizeObserver;
  private readonly labels = document.createElement('div');
  private readonly particles: Particle[] = [];
  private readonly trails: Trail[] = [];
  private readonly particleGeometry = new THREE.BufferGeometry();
  private readonly particlePositions = new Float32Array(256 * 3);
  private readonly particleColors = new Float32Array(256 * 3);
  private readonly particleMaterial = new THREE.PointsMaterial({ size: 0.09, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending });
  private readonly particleMesh: THREE.Points;
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
    this.canvas.setAttribute('aria-label', 'Sunbreak Courtyard live third-person arena. Click to capture mouse; Escape releases it.');
    this.canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline:none;';
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener('webglcontextlost', this.contextLost);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color('#95c6d5');
    this.scene.fog = new THREE.Fog('#b6d4d3', 100, 430);
    this.scene.add(new THREE.HemisphereLight('#daf2ff', '#bea27b', 1.45));
    this.sun = new THREE.DirectionalLight('#fff0cc', 3.2);
    this.sun.position.set(-24, 42, 16);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -41; this.sun.shadow.camera.right = 41;
    this.sun.shadow.camera.top = 41; this.sun.shadow.camera.bottom = -41;
    this.sun.shadow.camera.near = 1; this.sun.shadow.camera.far = 110;
    this.sun.shadow.normalBias = 0.035; this.sun.shadow.bias = -0.00015;
    this.sun.shadow.radius = 2;
    this.scene.add(this.sun, this.sun.target);
    this.world = createWorld(this.renderer); this.scene.add(this.world.root);
    this.particleGeometry.setAttribute('position', new THREE.BufferAttribute(this.particlePositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.particleGeometry.setAttribute('color', new THREE.BufferAttribute(this.particleColors, 3).setUsage(THREE.DynamicDrawUsage));
    this.particleGeometry.setDrawRange(0, 0);
    this.particleMesh = new THREE.Points(this.particleGeometry, this.particleMaterial); this.particleMesh.frustumCulled = false; this.scene.add(this.particleMesh);
    this.labels.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
    container.append(this.canvas, this.labels);
    options.input.attach(this.canvas);
    this.audio = new GameAudio(this.settings.volume);
    this.setSettings(this.settings);
    this.resizeObserver = new ResizeObserver(this.resize); this.resizeObserver.observe(container);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  setSettings(settings: Partial<GameSettings>) {
    this.settings = { ...this.settings, ...settings };
    this.options.input.setSettings(this.settings);
    this.audio?.setVolume(this.settings.volume);
    const mobile = this.options.input.isTouch;
    const ratio = this.settings.quality === 'high' ? 1.75 : this.settings.quality === 'low' ? 1 : mobile ? 1.25 : 1.5;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, ratio));
    this.renderer.shadowMap.enabled = this.settings.quality !== 'low';
    const shadowSize = this.settings.quality === 'high' ? 2048 : mobile ? 1024 : 2048;
    if (this.sun.shadow.mapSize.x !== shadowSize) {
      this.sun.shadow.map?.dispose(); this.sun.shadow.map = null;
      this.sun.shadow.mapSize.set(shadowSize, shadowSize); this.sun.shadow.needsUpdate = true;
    }
    this.slowTime = 0;
    this.resize();
  }

  /** Called once for each input actually sent to the server, at 30 Hz. */
  recordInput(frame: InputFrame) {
    this.pendingInputs.push({ ...frame });
    if (this.pendingInputs.length > 120) this.pendingInputs.splice(0, this.pendingInputs.length - 120);
  }

  handleEvent(event: GameEvent) {
    if (this.disposed) return;
    const localId = this.options.getPlayerId();
    if (event.type === 'shot') {
      const entry = this.players.get(event.playerId);
      entry?.model.recoil();
      const from = new THREE.Vector3(event.from.x, event.from.y, event.from.z);
      if (entry?.model.root.visible) entry.model.muzzle.getWorldPosition(from);
      const to = new THREE.Vector3(event.to.x, event.to.y, event.to.z);
      const material = new THREE.LineBasicMaterial({ color: event.slot === 2 ? '#ffc87b' : '#ffedab', transparent: true, opacity: 0.92, depthWrite: false });
      const mesh = new THREE.Line(new THREE.BufferGeometry().setFromPoints([from, to]), material);
      this.trails.push({ mesh, age: 0, material }); this.scene.add(mesh);
      this.burst(from, '#ffe7a3', 7, 1.4, 0.09);
      this.burst(to, event.hit ? '#73e8f3' : '#efd9ae', event.hit ? 12 : 5, 2.4, 0.24);
      const distance = event.playerId === localId ? 0 : from.distanceTo(this.visualPosition);
      const offset = from.clone().sub(this.visualPosition);
      const pan = (offset.x * Math.cos(this.options.input.yaw) + offset.z * Math.sin(this.options.input.yaw)) / Math.max(5, distance);
      this.audio.shot(event.slot, distance, pan);
      if (event.hit && event.playerId === localId) this.audio.hit();
    } else if (event.type === 'damage' && event.playerId === localId) this.audio.damage();
    else if (event.type === 'elimination') {
      const entry = this.players.get(event.playerId);
      if (entry) this.burst(entry.position.clone().add(new THREE.Vector3(0, 0.9, 0)), '#76eced', 38, 3.5, 0.65);
      if (event.attackerId === localId) this.audio.elimination();
    } else if (event.type === 'heal' || event.type === 'respawn') {
      const entry = this.players.get(event.playerId);
      if (entry) this.burst(entry.position.clone().add(new THREE.Vector3(0, 0.8, 0)), event.type === 'heal' ? '#8affc1' : '#9fefff', 22, 1.5, 0.8);
      if (event.playerId === localId) {
        if (event.type === 'heal') this.audio.heal();
        else { this.audio.respawn(); this.firstLocalSnapshot = true; }
      }
    }
  }

  private resize = () => {
    if (this.disposed) return;
    this.width = Math.max(1, this.container.clientWidth); this.height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height; this.camera.updateProjectionMatrix();
  };

  private contextLost = (event: Event) => {
    if (this.disposed) return;
    event.preventDefault(); this.options.input.setPaused(true);
    this.options.onError?.('Your graphics were interrupted. Rejoin the match to restore your view.');
  };

  private receiveSnapshot(snapshot: WorldSnapshot, now: number) {
    const roundReset = (snapshot.phase === 'countdown' && this.snapshot?.phase !== 'countdown') || (snapshot.phase === 'playing' && this.snapshot?.phase === 'finished');
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
    if (snapshot.phase === 'playing' && alive) {
      let previousJump = this.acknowledgedJump;
      for (const frame of this.pendingInputs) { movePlayer(this.prediction, frame, 1 / 30, !previousJump); previousJump = frame.jump; }
    }
    // Teleports and respawns should never drag a camera through the arena.
    if (this.visualPosition.distanceTo(new THREE.Vector3(this.prediction.x, this.prediction.y, this.prediction.z)) > 3.5) this.visualPosition.set(this.prediction.x, this.prediction.y, this.prediction.z);
  }

  private addPlayer(player: PlayerState): RenderPlayer {
    const local = player.id === this.options.getPlayerId();
    const model = createBlenderCharacter(player.color,
      local ? () => this.options.onAssetsReady?.() : undefined,
      message => this.options.onError?.(message));
    this.scene.add(model.root);
    const label = document.createElement('div');
    label.style.cssText = 'position:absolute;left:0;top:0;transform:translate(-50%,-100%);color:#fff;font:700 11px system-ui,sans-serif;letter-spacing:.04em;text-shadow:0 1px 3px #183543;white-space:nowrap;will-change:left,top;';
    const name = document.createElement('div'); name.textContent = player.name;
    name.style.cssText = 'padding:3px 7px;background:#103543b3;border-radius:3px;';
    const track = document.createElement('div'); track.style.cssText = 'height:3px;background:#0d263b88;margin:2px 7px 0;border-radius:2px;overflow:hidden;';
    const healthBar = document.createElement('div'); healthBar.style.cssText = 'height:100%;background:#baf453;';
    track.append(healthBar); label.append(name, track); this.labels.append(label);
    const shadow = new THREE.Mesh(this.shadowGeometry, this.shadowMaterial); shadow.rotation.x = -Math.PI / 2; shadow.renderOrder = 1; this.scene.add(shadow);
    const entry = { model, label, healthBar, shadow, position: new THREE.Vector3(player.x, player.y, player.z) }; this.players.set(player.id, entry); return entry;
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
    const blend = THREE.MathUtils.clamp((target - previous.serverTime) / Math.max(1, next.serverTime - previous.serverTime), 0, 1);
    return { ...player, x: THREE.MathUtils.lerp(a.x, b.x, blend), y: THREE.MathUtils.lerp(a.y, b.y, blend), z: THREE.MathUtils.lerp(a.z, b.z, blend), yaw: lerpAngle(a.yaw, b.yaw, blend), pitch: THREE.MathUtils.lerp(a.pitch, b.pitch, blend) };
  }

  private frame = (now: number) => {
    if (this.disposed) return;
    const elapsedFrame = Math.max(0.001, (now - this.lastFrame) / 1000);
    const dt = Math.min(0.05, elapsedFrame); this.lastFrame = now;
    this.elapsed += dt; this.frames++; this.statsTime += elapsedFrame;
    const incoming = this.options.getSnapshot();
    if (incoming && (incoming.tick !== this.lastProcessedTick || incoming !== this.snapshot)) this.receiveSnapshot(incoming, now);
    const localId = this.options.getPlayerId(); const input = this.options.input.peek();
    const localState = this.snapshot?.players.find(player => player.id === localId);
    if (this.prediction && localState) {
      const fresh = this.snapshotBuffer.length > 0 && now - this.snapshotBuffer[this.snapshotBuffer.length - 1].received < 500;
      if (this.snapshot?.phase === 'playing' && localState.health > 0 && fresh) movePlayer(this.prediction, input, dt, !this.lastJump);
      this.lastJump = input.jump;
      this.visualPosition.lerp(new THREE.Vector3(this.prediction.x, this.prediction.y, this.prediction.z), 1 - Math.exp(-dt * 24));
      const position = cameraPosition(this.visualPosition, input.yaw, input.pitch, input.aim);
      this.camera.position.set(position.x, Math.max(0.12, position.y), position.z);
      const direction = directionFromAngles(input.yaw, input.pitch);
      this.camera.lookAt(this.camera.position.x + direction.x, this.camera.position.y + direction.y, this.camera.position.z + direction.z);
      const fov = input.aim ? 57 : input.sprint && Math.hypot(input.moveX, input.moveZ) > 0.1 ? 73 : 68;
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
      entry.model.update(rendered, dt, time, local);
      if (local && this.camera.position.distanceTo(entry.position.clone().add(new THREE.Vector3(0, 1.35, 0))) < 0.8) entry.model.root.visible = false;
      entry.shadow.visible = state.health > 0 && state.connected;
      entry.shadow.position.set(rendered.x, rendered.y + 0.018, rendered.z);
      entry.shadow.scale.setScalar(Math.max(0.5, 1 - rendered.y * 0.065));
      if (local || state.health <= 0 || !state.connected) entry.label.style.display = 'none';
      else {
        const head = new THREE.Vector3(rendered.x, rendered.y + 2.2, rendered.z);
        const sight = new THREE.Vector3(rendered.x, rendered.y + 1.65, rendered.z);
        const ray = sight.sub(this.camera.position); const distance = ray.length(); ray.normalize();
        const wall = raycastMap(this.camera.position, ray, distance);
        const projected = head.project(this.camera);
        const visible = wall >= distance - 0.2 && projected.z > 0 && projected.z < 1 && Math.abs(projected.x) < 1.1 && Math.abs(projected.y) < 1.1;
        entry.label.style.display = visible ? 'block' : 'none';
        if (visible) { entry.label.style.left = `${(projected.x * 0.5 + 0.5) * this.width}px`; entry.label.style.top = `${(-projected.y * 0.5 + 0.5) * this.height}px`; entry.healthBar.style.width = `${rendered.health}%`; }
      }
    }
    const currentIds = new Set(this.snapshot?.players.map(player => player.id) ?? []);
    for (const [id, entry] of this.players) if (!currentIds.has(id)) { this.scene.remove(entry.model.root, entry.shadow); entry.model.dispose(); entry.label.remove(); this.players.delete(id); }
    this.world.update(this.elapsed); this.updateEffects(dt);
    this.renderer.render(this.scene, this.camera);
    if (this.statsTime >= 0.7) {
      const fps = Math.round(this.frames / this.statsTime);
      this.options.onStats?.({ fps, locked: this.options.input.locked, drawCalls: this.renderer.info.render.calls });
      if (this.settings.quality === 'auto') {
        this.slowTime = fps < 38 ? this.slowTime + this.statsTime : Math.max(0, this.slowTime - this.statsTime);
        if (this.slowTime > 3 && this.renderer.getPixelRatio() > 1) { this.renderer.setPixelRatio(1); this.resize(); this.slowTime = 0; }
        else if (this.slowTime > 4 && this.renderer.shadowMap.enabled) { this.renderer.shadowMap.enabled = false; this.slowTime = 0; }
      }
      this.statsTime = 0; this.frames = 0;
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  private serverTime(now: number) {
    const latest = this.snapshotBuffer[this.snapshotBuffer.length - 1]; return latest ? latest.world.serverTime + now - latest.received : Date.now();
  }
  private burst(position: THREE.Vector3, color: string, count: number, speed: number, life: number) {
    for (let i = 0; i < count && this.particles.length < 256; i++) this.particles.push({
      position: position.clone(), velocity: new THREE.Vector3((Math.random() - 0.5) * speed, Math.random() * speed, (Math.random() - 0.5) * speed),
      color: new THREE.Color(color), life: life * (0.6 + Math.random() * 0.4), maxLife: life,
    });
  }
  private updateEffects(dt: number) {
    for (let i = this.trails.length - 1; i >= 0; i--) {
      const trail = this.trails[i]; trail.age += dt; trail.material.opacity = Math.max(0, 1 - trail.age / 0.10);
      if (trail.age >= 0.10) { this.scene.remove(trail.mesh); trail.mesh.geometry.dispose(); trail.material.dispose(); this.trails.splice(i, 1); }
    }
    for (let i = this.particles.length - 1; i >= 0; i--) { const particle = this.particles[i]; particle.life -= dt; if (particle.life <= 0) this.particles.splice(i, 1); else { particle.position.addScaledVector(particle.velocity, dt); particle.velocity.y -= dt * 3.4; } }
    for (let i = 0; i < this.particles.length; i++) {
      const particle = this.particles[i]; const fade = Math.max(0.08, particle.life / particle.maxLife);
      this.particlePositions.set([particle.position.x, particle.position.y, particle.position.z], i * 3);
      this.particleColors.set([particle.color.r * fade, particle.color.g * fade, particle.color.b * fade], i * 3);
    }
    this.particleGeometry.setDrawRange(0, this.particles.length);
    this.particleGeometry.getAttribute('position').needsUpdate = true; this.particleGeometry.getAttribute('color').needsUpdate = true;
  }

  dispose() {
    this.disposed = true; cancelAnimationFrame(this.raf); this.resizeObserver.disconnect(); this.audio.dispose();
    for (const entry of this.players.values()) { entry.model.dispose(); entry.label.remove(); }
    this.players.clear(); this.world.dispose();
    disposeCharacterResources();
    const geometries = new Set<THREE.BufferGeometry>(); const materials = new Set<THREE.Material>();
    this.scene.traverse(object => { if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) { geometries.add(object.geometry); for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material); } });
    for (const geometry of geometries) geometry.dispose(); for (const material of materials) material.dispose();
    this.sun.shadow.map?.dispose(); this.renderer.dispose(); this.renderer.forceContextLoss();
    this.canvas.removeEventListener('webglcontextlost', this.contextLost);
    this.canvas.remove(); this.labels.remove(); this.pendingInputs = []; this.snapshotBuffer = []; this.particles.length = 0; this.trails.length = 0;
  }
}
