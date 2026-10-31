import * as THREE from 'three';
import type { GameEvent, InputFrame, Phase, PlayerState, PublicPlayerState, Vec3, WeaponId, WorldSnapshot } from '../../shared/protocol';
import { clamp, directionFromAngles, eyePosition, isPlayerGrounded, raycastMap, rayHitboxes, weaponMuzzle } from '../../shared/physics';
import { surfaceAt } from '../../shared/map';
import { hasPerk, WEAPONS } from '../../shared/weapons';
import { disposeCharacterResources } from './Character';
import { preloadCharacter } from './BlenderCharacter';
import type { InputController } from './InputController';
import { GameAudio } from './GameAudio';
import { createWorld, type ArenaWorld, type WorldArtwork } from './World';
import { EXPOSURE, FOG, HEMISPHERE, SKY_LIGHT_INTENSITY, SUN_COLOR, SUN_DIRECTION, SUN_INTENSITY } from './Atmosphere';
import type { ArenaPresentation } from './Presentation';
import { RenderQuality, scenePixelRatio } from './RenderQuality';
import { buildSunVisibility, type SunVisibilityGrid } from './SunVisibility';
import { renderTier, type RenderTier } from './RenderTiers';
import { CombatEffects } from './CombatEffects';
import { DeferredRespawns } from './DeferredRespawns';
import { LocalPrediction, vaultProgress } from './MovementPrediction';
import { AutomaticFire, reticleTarget } from './AutomaticFire';
import { ViewModel } from './ViewModel';
import { loadWeaponModels, type WeaponLibrary } from './WeaponModels';
import type { HudStore } from './hud';
import { blastFeedback, FirstPersonCamera, FirstPersonMotion, flinchKick, LandingFilter, verticalFov } from './FirstPersonCamera';
import { LocalWeapon, RecoilRecovery, shotDirections, type WeaponEvent } from './LocalWeapon';
import { isFriend, RemotePlayers, renderTime, type Buffered, type RemoteSounds } from './RemotePlayers';
import { crosshairGap, displayedHealth, dueWhistles, GrenadeTracker, HudFeed, nearMiss, shotMarker } from './HudFeed';

export interface GameSettings {
  sensitivity: number; adsSensitivity: number; volume: number; quality: 'auto' | 'high' | 'low'; invertY: boolean;
  /** Horizontal field of view in degrees (70..110). */
  fov: number; reduceMotion: boolean;
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
  /** Per-frame HUD feed for React; harnesses without a HUD may omit it. */
  hud?: HudStore;
  getSnapshot: () => WorldSnapshot | null;
  getPlayerId: () => string;
  onStats?: (stats: GameStats) => void;
  onAssetsReady?: () => void;
  getPreparationId?: () => string | undefined;
  onPreparationRendered?: (roundId: string) => void;
  onError?: (message: string) => void;
  settings?: Partial<GameSettings>;
}
type ShotEvent = Extract<GameEvent, { type: 'shot' }>;
const RELOAD_STEPS = [[0.25, 'mag-out'], [0.6, 'mag-in'], [0.85, 'bolt']] as const;

/** Live first-person view. Only the server awards hits, health, eliminations, and ratings; this
 * view predicts the local player's movement and weapon for instant feedback and reconciles to
 * every snapshot. */
export class GameView {
  readonly canvas: HTMLCanvasElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(60, 1, 0.05, 700);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly world: ArenaWorld;
  private presentation: ArenaPresentation | null = null;
  private presentationRequest = 0;
  private overlayAttached = false;
  private readonly renderQuality = new RenderQuality();
  private graphicsConfigured = false;
  private environmentReady = false;
  private characterReady = false;
  private weaponsReady = false;
  /** The last rendered frame showed the living local player's first-person view. */
  private firstPersonFrame = false;
  private assetsAnnounced = false;
  private renderedPreparationId = '';
  private readonly audio: GameAudio;
  private readonly sun: THREE.DirectionalLight;
  /** Where the collision map shades the sun, so characters match the baked world. */
  private readonly sunVisibility: SunVisibilityGrid = buildSunVisibility(raycastMap);
  private tier: RenderTier = renderTier('auto', false, false);
  private readonly resizeObserver: ResizeObserver;
  private readonly labels = document.createElement('div');
  private effects: CombatEffects;
  private readonly automaticFire = new AutomaticFire();
  private readonly respawns = new DeferredRespawns();
  private readonly viewModel: ViewModel;
  private worldWeapons: WeaponLibrary | null = null;
  private readonly remotes: RemotePlayers;
  private readonly fpCamera = new FirstPersonCamera();
  private readonly motion = new FirstPersonMotion();
  private readonly prediction = new LocalPrediction();
  private readonly landings = new LandingFilter();
  /** Strongest landing predicted since the last frame (0..1), shown on the next frame. */
  private landing = 0;
  private readonly weapon = new LocalWeapon();
  private readonly recoil = new RecoilRecovery();
  private readonly hudFeed: HudFeed;
  private readonly grenades = new GrenadeTracker();
  private readonly whistled = new Set<string>();
  private settings: GameSettings;
  private snapshot: WorldSnapshot | null = null;
  private snapshotBuffer: Buffered[] = [];
  private localRespawnAt = 0;
  private lastAlive = false;
  private lastPhase: Phase | null = null;
  private countdownMark = 0;
  private lastView = { yaw: 0, pitch: 0 };
  private reloadMark = -1;
  private killer: string | null = null;
  private flash = 0;
  private lowHealthLevel = -1;
  private indoors = false;
  private indoorsCheckedAt = 0;
  private readonly scratch = new THREE.Vector3();
  /** Other players' movement sounds, positioned in 3D. */
  private readonly remoteSounds: RemoteSounds = {
    footstep: (surface, position, loudness) => this.audio.footstep(surface, position, false, loudness),
    land: (position, intensity) => this.audio.land(position, false, intensity),
    slide: position => this.audio.slide(position, false),
    vault: position => { if (Math.hypot(position.x - this.camera.position.x, position.y - this.camera.position.y, position.z - this.camera.position.z) < 12) this.audio.vault(false); },
  };
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
    this.settings = { sensitivity: 1, adsSensitivity: 1, volume: 0.65, quality: 'auto', invertY: false, fov: options.input.isTouch ? 80 : 90, reduceMotion: false, ...options.settings };
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.canvas = this.renderer.domElement;
    this.canvas.setAttribute('aria-label', 'Kannon Town first-person arena. Click to capture mouse; Escape releases it.');
    this.canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline:none;';
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener('webglcontextlost', this.contextLost);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = EXPOSURE;
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color(FOG.color);
    this.scene.fog = new THREE.Fog(FOG.color, FOG.near, FOG.far);
    this.scene.add(new THREE.HemisphereLight(HEMISPHERE.sky, HEMISPHERE.ground, HEMISPHERE.intensity));
    this.sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
    this.sun.position.copy(SUN_DIRECTION).multiplyScalar(70);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    // A tight box follows the local player each frame; see followShadow.
    this.sun.shadow.camera.near = 1; this.sun.shadow.camera.far = 120;
    this.sun.shadow.normalBias = 0.065; this.sun.shadow.bias = -0.00025;
    this.sun.shadow.radius = 2;
    this.scene.add(this.sun, this.sun.target);
    const baseline = import.meta.env?.DEV && new URLSearchParams(location.search).get('graphics') === 'current';
    const artwork = options.graphicsTest?.artwork ?? (baseline ? { environmentUrl: '/models/environment.glb?v=kannon-town-v1' } : undefined);
    this.tier = renderTier(this.settings.quality, options.input.isTouch, this.renderer.extensions.has('EXT_color_buffer_float'));
    this.world = createWorld(this.renderer, this.tier.textureTier, () => {
      this.world.prepareReflections(this.scene); this.effects.setBreakables(this.world.breakables);
      this.viewModel.scene.environment = this.world.environment; this.environmentReady = true;
    }, message => this.options.onError?.(message), artwork);
    this.scene.add(this.world.root);
    this.scene.environment = this.world.environment;
    this.scene.background = this.world.background;
    // The HDR sky carries much more energy than an ordinary color cube. Expose
    // its background separately so clear blue and cloud shapes do not wash out.
    this.scene.backgroundIntensity = this.world.environment ? 0.28 : 0.8;
    this.scene.environmentIntensity = SKY_LIGHT_INTENSITY;
    this.effects = new CombatEffects({ quality: this.tier.effects });
    this.scene.add(this.effects.root);
    this.labels.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
    container.append(this.canvas, this.labels);
    options.input.attach(this.canvas);
    this.audio = new GameAudio(this.settings.volume);
    this.hudFeed = new HudFeed(options.hud ?? null);
    this.remotes = new RemotePlayers(this.scene, this.labels, message => this.options.onError?.(message));
    this.viewModel = new ViewModel(this.renderer);
    // A missing weapons file falls back to stand-ins inside the library; never block the round on it.
    this.viewModel.ready.catch(() => {}).finally(() => { this.weaponsReady = true; });
    loadWeaponModels(this.renderer).then(library => { if (this.disposed) library.dispose(); else this.worldWeapons = library; }).catch(() => {});
    preloadCharacter().then(() => { this.characterReady = true; }).catch(() => {
      if (!this.disposed) this.options.onError?.('A player model could not load. Check your connection and rejoin the match.');
    });
    this.setSettings(this.settings);
    this.resizeObserver = new ResizeObserver(this.resize); this.resizeObserver.observe(container);
    document.addEventListener('visibilitychange', this.visibilityChange);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  async testSound() {
    await this.audio.unlock();
    this.audio.hitMarker('hit');
  }

  setSettings(settings: Partial<GameSettings>) {
    const graphicsChanged = !this.graphicsConfigured || (settings.quality !== undefined && settings.quality !== this.settings.quality);
    this.settings = { ...this.settings, ...settings };
    this.settings.fov = clamp(Number.isFinite(this.settings.fov) ? this.settings.fov : 90, 60, 120);
    this.options.input.setSettings(this.settings);
    this.audio?.setVolume(this.settings.volume);
    if (!graphicsChanged) return;
    this.graphicsConfigured = true;
    this.renderQuality.reset();
    const previous = this.tier;
    this.tier = renderTier(this.settings.quality, this.options.input.isTouch, this.renderer.extensions.has('EXT_color_buffer_float'));
    if (previous.effects !== this.tier.effects && this.effects) {
      this.effects.dispose(); this.effects = new CombatEffects({ quality: this.tier.effects }); this.scene.add(this.effects.root);
      if (this.environmentReady) this.effects.setBreakables(this.world.breakables);
    }
    // Every tier draws character shadows; the environment's own light is baked.
    this.renderer.shadowMap.enabled = true;
    const request = ++this.presentationRequest;
    if (this.tier.postprocessing && this.presentation) this.presentation.enabled = true;
    else if (this.tier.postprocessing) {
      // Phones do not download the desktop postprocessing bundle. Direct
      // rendering remains usable while this optional effect becomes ready.
      void import('./Presentation').then(({ ArenaPresentation: Presentation }) => {
        if (this.disposed || request !== this.presentationRequest) return;
        this.presentation = new Presentation(this.renderer, this.scene, this.camera, { bloom: this.tier.bloom, depthOfField: this.tier.depthOfField });
        this.overlayAttached = false;
        this.presentation.resize(this.width, this.height);
      }).catch(() => { /* A failed optional enhancement leaves direct rendering available. */ });
    } else { this.presentation?.dispose(); this.presentation = null; this.overlayAttached = false; }
    if (this.sun.shadow.mapSize.x !== this.tier.shadowMapSize) {
      this.sun.shadow.map?.dispose(); this.sun.shadow.map = null;
      this.sun.shadow.mapSize.set(this.tier.shadowMapSize, this.tier.shadowMapSize); this.sun.shadow.needsUpdate = true;
    }
    this.world.setGrassDensity(this.tier.grassDensity);
    const extent = this.tier.shadowHalfExtent;
    this.sun.shadow.camera.left = -extent; this.sun.shadow.camera.right = extent;
    this.sun.shadow.camera.top = extent; this.sun.shadow.camera.bottom = -extent;
    this.sun.shadow.camera.updateProjectionMatrix();
    this.slowTime = 0;
    this.resize();
  }

  /** Read-only evidence for the isolated comparison harness. */
  graphicsTestState() {
    let meshes = 0, casting = 0, lightmapped = 0;
    this.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh) || !object.visible) return;
      meshes++;
      if (object.castShadow) casting++;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (materials.some(material => (material as THREE.MeshStandardMaterial).lightMap)) lightmapped++;
    });
    const roots: Record<string, { visible: boolean; meshes: number; triangles: number; casting: number }> = {};
    this.world.root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      let named: THREE.Object3D | null = object, effective = true;
      for (let current: THREE.Object3D | null = object; current; current = current.parent) { if (!current.visible) effective = false; if (current.name && current.parent && !current.parent.name) named = current; }
      const key = named?.name || 'unnamed';
      const entry = roots[key] ??= { visible: effective, meshes: 0, triangles: 0, casting: 0 };
      entry.meshes++; entry.casting += object.castShadow ? 1 : 0;
      const index = object.geometry.index; entry.triangles += (index ? index.count : object.geometry.attributes.position?.count ?? 0) / 3;
    });
    return { postprocessing: !!this.presentation?.enabled, shadowSize: this.sun.shadow.mapSize.toArray(), qualityScale: this.renderQuality.scale, tier: this.tier.name, meshes, casting, lightmapped, roots };
  }

  /** Called once for each input actually sent to the server, at 30 Hz. The local body moves one
   * server tick per sent input, exactly as the server will move it (frames only draw between
   * ticks), and the weapon predicts its shots on the same tick. */
  recordInput(frame: InputFrame) {
    if (this.disposed) return;
    const wall = performance.now();
    const latest = this.snapshotBuffer[this.snapshotBuffer.length - 1];
    const moved = this.prediction.record(frame, wall, !!latest && wall - latest.received < 500 && this.localPlaying());
    const state = this.prediction.movement.state;
    if (moved) this.landing = Math.max(this.landing, this.landings.tick(moved, isPlayerGrounded(state), state.posture));
    const now = moved ? this.prediction.movement.time : this.serverTime(wall) + this.prediction.clockLead;
    const events = this.weapon.step(frame, {
      now, alive: this.localPlaying(), sprinting: !!state.sprinting, dashing: !!state.dashing,
      vaultProgress: vaultProgress(state.vault, now), ads: this.motion.ads,
    });
    for (const event of events) this.weaponEvent(event, frame);
    if (!frame.fire) this.recoil.release(this.weapon.spec.recoil.recovery);
  }

  /** The server simulates this player's inputs: alive in live play with the predictor running. */
  private localPlaying() {
    const local = this.localState();
    return !!local && this.prediction.active && this.snapshot?.phase === 'playing' && local.health > 0 && local.connected;
  }
  private localState(): PublicPlayerState | undefined {
    const id = this.options.getPlayerId();
    return this.snapshot?.players.find(player => player.id === id);
  }
  private self(): PlayerState | undefined {
    const self = this.snapshot?.self;
    return self && self.id === this.options.getPlayerId() ? self : undefined;
  }

  private weaponEvent(event: WeaponEvent, frame: InputFrame) {
    if (document.hidden) return;
    const eye = eyePosition(this.prediction.movement.state);
    switch (event.type) {
      case 'shot': {
        this.viewModel.fire();
        this.audio.shot(event.weapon, eye, true);
        this.recoil.kick(event.kick, this.options.input.pitch);
        this.options.input.addViewKick(event.kick.yaw, event.kick.pitch);
        if (WEAPONS[event.weapon].pellets > 1 || event.burst % 3 === 0) this.localTracer(frame, event.weapon, eye);
        break;
      }
      case 'shell': this.audio.reloadStep(event.weapon, 'shell'); break;
      case 'reloaded': if (event.empty && WEAPONS[event.weapon].perShellMs) this.audio.reloadStep(event.weapon, 'pump'); break;
      case 'swap': this.audio.swap(); break;
      case 'dry': this.audio.dryFire(); break;
      case 'melee': this.viewModel.melee(); break;
      case 'cook': this.audio.grenadePin(); break;
      case 'throw': this.viewModel.throwGrenade(); break;
      case 'reload': this.reloadMark = 0; break;
    }
  }

  /** The predicted shot's streak to whatever the crosshair (or each fixed pellet) meets; the
   * server's own shot event later draws the impacts. */
  private localTracer(frame: InputFrame, weapon: WeaponId, eye: Vec3) {
    const spec = WEAPONS[weapon], local = this.localState();
    const traces = shotDirections(spec, frame.yaw, frame.pitch, frame.aim).map(direction => {
      let distance = raycastMap(eye, direction, spec.maxRange);
      for (const { state } of this.remotes.entries.values()) {
        if (state.health <= 0 || !state.connected || (local && this.snapshot && isFriend(state, local.team, this.snapshot.mode))) continue;
        const hit = rayHitboxes(eye, direction, state, distance);
        if (hit && hit.distance < distance) distance = hit.distance;
      }
      return { to: { x: eye.x + direction.x * distance, y: eye.y + direction.y * distance, z: eye.z + direction.z * distance }, kind: 'range' as const };
    });
    const event: ShotEvent = { type: 'shot', playerId: this.options.getPlayerId(), weapon, from: eye, traces, hit: false, at: this.serverTime(performance.now()) };
    this.effects.shot(event, this.viewModel.muzzleWorld(this.camera, this.scratch), { local: true, tracer: true });
  }

  handleEvent(event: GameEvent) {
    if (this.disposed) return;
    const localId = this.options.getPlayerId();
    const now = performance.now(), serverNow = this.serverTime(now);
    const fresh = !this.snapshotBuffer.length || serverNow - event.at <= 500;
    if (event.type === 'respawn') {
      if (event.playerId === localId) this.localRespawnAt = Math.max(this.localRespawnAt, event.at);
      if (!document.hidden && fresh) this.respawns.enqueue(event.playerId, event.at, now);
      return;
    }
    // A grenade still in flight matters even when its throw event is a little old.
    if (event.type === 'grenade') { if (!document.hidden) this.grenades.add(event, serverNow); return; }
    // A hidden tab must not collect old flashes, audio or per-shot GPU objects.
    if (document.hidden || !fresh) return;
    if (event.type === 'shot') this.shotEvent(event, localId, now);
    else if (event.type === 'damage') {
      if (event.playerId === localId) {
        this.hudFeed.damage(event.from, event.amount, now);
        this.audio.damage(event.amount);
        const self = this.self(), kick = flinchKick(event.amount, !!self && hasPerk(self.loadout, 'steady-aim'));
        this.options.input.addViewKick(kick.yaw, kick.pitch);
      } else {
        this.remotes.impact(event.playerId, event.zone === 'head' ? 'head' : event.cause === 'bullet' ? 'hit' : 'blast');
        if (event.attackerId === localId && event.cause !== 'bullet') { this.hudFeed.marker('hit', now); this.audio.hitMarker('hit'); }
      }
    } else if (event.type === 'elimination') {
      const position = event.playerId === localId ? this.prediction.movement.state : this.remotes.position(event.playerId);
      if (position) this.effects.elimination(position);
      if (event.attackerId === localId && event.playerId !== localId) { this.hudFeed.marker('kill', now); this.audio.hitMarker('kill'); }
      if (event.playerId === localId) this.killer = event.attackerId !== localId ? event.attackerId : null;
    } else if (event.type === 'melee') {
      if (event.playerId === localId) this.audio.melee(!!event.targetId);
      else if (event.targetId === localId) this.audio.melee(true);
    } else if (event.type === 'explosion') {
      this.effects.explosion(event.position, event.cause);
      this.audio.explosion(event.position, event.cause);
      if (this.grenades.remove(event.id)) this.effects.grenade(event.id, null);
      const eye = this.camera.position, distance = eye.distanceTo(this.scratch.set(event.position.x, event.position.y, event.position.z));
      const blast = blastFeedback(distance, event.cause, raycastMap(eye, this.scratch.sub(eye).normalize(), distance) >= distance - 0.3);
      this.fpCamera.shake(blast.shake); this.flash = Math.max(this.flash, blast.flash);
    } else if (event.type === 'streak') {
      if (event.playerId === localId && event.action !== 'ended') this.audio.streak(event.action, event.reward);
    } else if (event.type === 'medal' && event.playerId === localId) this.audio.medal();
  }

  private shotEvent(event: ShotEvent, localId: string, now: number) {
    if (event.weapon === 'drone') {
      this.effects.shot(event, event.from, { local: false, tracer: true });
      this.audio.shot('drone', event.from, false);
    } else if (event.playerId === localId) {
      // Muzzle, sound, recoil and tracer were predicted when the input was sent.
      this.effects.shot(event, this.viewModel.muzzleWorld(this.camera, this.scratch), { local: true, tracer: false });
      const kind = shotMarker(event, localId);
      if (kind) { this.hudFeed.marker(kind, now); this.audio.hitMarker(kind); }
    } else {
      this.audio.shot(event.weapon, this.remotes.presentShot(event, this.effects, this.camera.position), false);
      const shooter = this.remotes.rendered(event.playerId), local = this.localState();
      // Unsuppressed fire pings the minimap unless the shooter runs Low Profile.
      if (shooter && !(local && this.snapshot && isFriend(shooter, local.team, this.snapshot.mode)) && !(shooter.loadout && hasPerk(shooter.loadout, 'low-profile'))) {
        this.hudFeed.ping(event.playerId, event.from, event.at);
      }
    }
    const crack = this.localPlaying() ? nearMiss(event, this.camera.position, localId) : null;
    if (crack) this.audio.flyby(crack);
    let surfaced = false, flesh = false;
    for (const trace of event.traces) {
      if (trace.kind === 'world' && trace.normal && trace.surface) {
        this.effects.bulletHole(trace.to, trace.normal, trace.surface);
        if (!surfaced) { this.audio.impact(trace.surface, trace.to); surfaced = true; }
      } else if (trace.kind === 'player' && !trace.protected && !flesh) { this.audio.impact('flesh', trace.to); flesh = true; }
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

  /** Simple touch fire: shoot while the crosshair rests on a visible enemy's hitboxes. Returns true
   * while it is firing at a target. */
  prepareAutomaticFire(): boolean {
    const input = this.options.input, now = performance.now();
    const localId = this.options.getPlayerId(), local = this.localState(), snapshot = this.snapshot;
    const fresh = !!this.snapshotBuffer.length && now - this.snapshotBuffer[this.snapshotBuffer.length - 1]!.received < 500;
    const time = this.serverTime(now), predicted = time + this.prediction.clockLead, spec = this.weapon.spec, state = this.prediction.movement.state;
    const tracking = this.assetsAnnounced && fresh && input.acceptsInput && input.isTouch && input.firingMode === 'simple'
      && snapshot?.phase === 'playing' && !!local && local.health > 0;
    let target: string | null = null;
    if (tracking) {
      const eye = eyePosition(state), direction = directionFromAngles(input.yaw, input.pitch);
      const targets = [...this.remotes.entries.values()].map(entry => entry.state);
      target = reticleTarget(eye, direction, weaponMuzzle(eye, input.yaw, input.pitch), targets, localId, time,
        spec.kind === 'shotgun' ? 22 : spec.maxRange, { mode: snapshot!.mode, team: local!.team });
    }
    // The reticle keeps its target through a reload, raise or wall block, so fire resumes the moment
    // a pull would shoot (a pump reload counts as ready once a shell is in).
    const ready = !this.motion.fireBlocked && !input.peek().reload
      && this.weapon.fireReady({ now: predicted, sprinting: false, vaultProgress: vaultProgress(state.vault, predicted) });
    const firing = this.automaticFire.update(target, now, !spec.auto) && ready;
    input.setAutomaticFire(firing);
    return !!target && ready;
  }

  private checkAssetsReady() {
    const local = this.localState();
    if (!this.disposed && !this.assetsAnnounced && !document.hidden && this.environmentReady && this.characterReady && this.weaponsReady
      && local && (this.snapshot?.phase !== 'preparing' || this.firstPersonFrame) && !this.renderer.getContext().isContextLost()) {
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
    if (!local || local.health <= 0 || !local.connected || !this.firstPersonFrame) return;
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
    this.effects.clear(); this.respawns.clear(); this.remotes.resetMotion();
    for (const id of this.grenades.clear()) this.effects.grenade(id, null);
  };

  private receiveSnapshot(snapshot: WorldSnapshot, now: number) {
    const roundReset = (snapshot.phase === 'preparing' && this.snapshot?.phase !== 'preparing')
      || (snapshot.phase === 'countdown' && this.snapshot?.phase !== 'countdown' && this.snapshot?.phase !== 'preparing')
      || (snapshot.phase === 'playing' && this.snapshot?.phase === 'finished');
    if (roundReset) {
      this.effects.clear(); this.respawns.clear(); this.localRespawnAt = 0; this.remotes.resetMotion(); this.hudFeed.reset();
      for (const id of this.grenades.clear()) this.effects.grenade(id, null);
      this.whistled.clear();
    }
    const localId = this.options.getPlayerId(), input = this.options.input;
    // Events precede snapshots. Reset the camera only when this life is present,
    // including respawns received while rendering was suspended in another app.
    if (this.localRespawnAt && snapshot.serverTime >= this.localRespawnAt) {
      const respawned = snapshot.players.find(player => player.id === localId);
      if (respawned && respawned.health > 0 && respawned.connected) this.firstLocalSnapshot = true;
      this.localRespawnAt = 0;
    }
    this.snapshot = snapshot;
    this.lastProcessedTick = snapshot.tick;
    this.snapshotBuffer.push({ world: snapshot, received: now });
    if (this.snapshotBuffer.length > 12) this.snapshotBuffer.shift();
    this.effects.setDrones(snapshot.drones ?? [], snapshot.serverTime);
    this.droneSound(snapshot);
    const local = snapshot.players.find(player => player.id === localId);
    if (!local) { this.prediction.active = false; return; }
    const self = snapshot.self?.id === localId ? snapshot.self : undefined;
    input.resumeSequence(local.lastInputSeq);
    if (self) input.setRewards(self.rewards ?? []);
    const alive = local.health > 0 && local.connected;
    const spawned = this.firstLocalSnapshot || roundReset || (!this.lastAlive && alive);
    if (spawned) {
      input.resetSpawnView(local.yaw, local.pitch);
      this.firstLocalSnapshot = false; this.killer = null; this.recoil.reset();
      if (self) this.weapon.reset(self, snapshot.serverTime);
    } else if (self) this.weapon.reconcile(self, local.lastInputSeq, snapshot.serverTime);
    this.lastAlive = alive;
    const snapped = this.prediction.receive(self ? { ...local, ...self } : local, snapshot.serverTime, local.lastInputSeq,
      { playing: snapshot.phase === 'playing', alive, spawned }, now);
    // Teleports and respawns should never drag a camera through the arena.
    const state = this.prediction.movement.state;
    if (snapped) { this.fpCamera.snap(state, state.posture); this.motion.reset(state.posture); this.landings.reset(); this.landing = 0; }
  }

  private droneSound(snapshot: WorldSnapshot) {
    let nearest: Vec3 | null = null, best = Infinity;
    for (const drone of snapshot.drones ?? []) {
      const distance = Math.hypot(drone.x - this.camera.position.x, drone.z - this.camera.position.z);
      if (drone.health > 0 && drone.until > snapshot.serverTime && distance < best) { best = distance; nearest = { x: drone.x, y: drone.y, z: drone.z }; }
    }
    this.audio.drone(nearest);
  }

  private phaseCues(snapshot: WorldSnapshot) {
    if (snapshot.phase === 'countdown') {
      const second = Math.ceil(snapshot.timeRemaining);
      if (second !== this.countdownMark && second >= 1 && second <= 3) this.audio.countdown(false);
      this.countdownMark = second;
    } else this.countdownMark = 0;
    if (snapshot.phase === 'playing' && this.lastPhase === 'countdown') this.audio.countdown(true);
    if (snapshot.phase !== this.lastPhase) this.audio.ambience(snapshot.phase === 'playing' || snapshot.phase === 'countdown' || snapshot.phase === 'preparing');
    this.lastPhase = snapshot.phase;
  }

  /** Centre the character shadow box on the player, snapped to shadow-map texels so the
   *  shadow edges do not shimmer as the box moves. */
  private followShadow(center: Vec3) {
    const texel = (2 * this.tier.shadowHalfExtent) / this.sun.shadow.mapSize.x;
    const snapped = this.scratch.set(center.x, center.y, center.z).divideScalar(texel).round().multiplyScalar(texel);
    this.sun.target.position.copy(snapped);
    this.sun.position.copy(snapped).addScaledVector(SUN_DIRECTION, 70);
    this.sun.target.updateMatrixWorld();
  }

  private frame = (now: number) => {
    if (this.disposed) return;
    // Changing the drawing buffer clears it. Apply adaptive sizes before drawing
    // the next frame, never after the completed frame is ready for the browser.
    if (this.resizePending) { this.resizePending = false; this.resize(); }
    const elapsedFrame = Math.max(0.001, (now - this.lastFrame) / 1000);
    const dt = Math.min(0.05, elapsedFrame); this.lastFrame = now;
    this.elapsed += dt; this.frames++; this.statsTime += elapsedFrame;
    const localId = this.options.getPlayerId();
    const incoming = this.options.getSnapshot();
    if (incoming && (incoming.tick !== this.lastProcessedTick || incoming !== this.snapshot)) {
      this.receiveSnapshot(incoming, now);
      this.respawns.flush(incoming, now, player => {
        if (document.hidden) return;
        this.effects.respawn(player);
        if (player.id === localId) this.audio.respawn();
      });
      this.phaseCues(incoming);
    }
    const controller = this.options.input, input = controller.peek(), snapshot = this.snapshot;
    const local = this.localState(), self = this.self(), motion = this.motion, prediction = this.prediction;
    const serverNow = this.serverTime(now), predictedNow = serverNow + prediction.clockLead;
    const alive = !!local && local.health > 0 && local.connected;
    const firstPerson = !!snapshot && prediction.active && alive && snapshot.phase !== 'finished';
    // The body only moves with sent inputs (recordInput); a frame draws it between the last two ticks.
    prediction.settle(dt);
    const state = prediction.movement.state, spec = this.weapon.spec, feet = prediction.feet(now);
    const speed = Math.hypot(state.vx, state.vz), grounded = isPlayerGrounded(state);
    const progress = this.weapon.reloadProgress(predictedNow);
    const landed = firstPerson ? this.landing : 0;
    this.landing = 0;
    let focus = 200;
    if (firstPerson) {
      focus = raycastMap({ x: feet.x, y: feet.y + this.fpCamera.eyeOffset, z: feet.z }, directionFromAngles(input.yaw, input.pitch), 200);
      const moved = motion.update({
        dt, posture: state.posture, sprinting: !!state.sprinting, wallDistance: focus,
        aimWanted: input.aim && !this.weapon.cooking && predictedNow >= this.weapon.state.meleeUntil,
        adsMs: spec.adsMs, steadyAim: !!self && hasPerk(self.loadout, 'steady-aim'),
      });
      if (landed > 0) { this.fpCamera.land(landed, this.settings.reduceMotion); this.viewModel.land(landed); this.audio.land(feet, true, landed); }
      if (moved.slide) this.audio.slide(feet, true);
      if (moved.vault) { this.audio.vault(true); this.viewModel.vault(); }
      if (moved.aim !== null) this.audio.aim(moved.aim);
      const result = this.fpCamera.update(this.camera, {
        dt, feet, posture: state.posture, grounded, speed, vx: state.vx, vz: state.vz, yaw: input.yaw, pitch: input.pitch,
        fov: this.settings.fov, aspect: this.width / this.height, ads: motion.ads, adsZoom: spec.adsZoom, sprint: motion.sprint,
        sprinting: !!state.sprinting, dashing: !!state.dashing, vault: state.vault ? vaultProgress(state.vault, prediction.movement.time) : -1, reduceMotion: this.settings.reduceMotion,
      });
      if (result.footstep) this.audio.footstep(surfaceAt(feet), feet, true, state.posture === 'crouch' ? 0.45 : state.dashing ? 1.15 : state.sprinting ? 1 : 0.75);
      controller.setAimZoom(1 + (spec.adsZoom - 1) * motion.ads, motion.ads > 0.5);
      const back = this.recoil.update(dt, controller.pitch);
      if (back.yaw || back.pitch) controller.addViewKick(back.yaw, back.pitch);
      if (progress >= 0 && !spec.perShellMs) for (const [mark, step] of RELOAD_STEPS) if (this.reloadMark < mark && progress >= mark) this.audio.reloadStep(spec.id, step);
    } else {
      motion.leave();
      controller.setAimZoom(1, false);
      if (local && !alive && prediction.active && snapshot?.phase === 'playing') {
        this.fpCamera.updateDeath(this.camera, dt, this.killer ? this.remotes.position(this.killer) ?? null : null, this.settings.reduceMotion);
      } else {
        const orbit = this.elapsed * 0.025;
        this.camera.position.set(Math.sin(orbit) * 27, 15, Math.cos(orbit) * 27); this.camera.lookAt(0, 1.2, -3);
        const fov = verticalFov(this.settings.fov, this.width / this.height);
        if (Math.abs(this.camera.fov - fov) > 1e-3) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
      }
    }
    controller.setFireBlocked(motion.fireBlocked);
    this.reloadMark = progress;
    this.camera.updateMatrixWorld();
    this.remotes.update({
      now, serverNow, elapsed: elapsedFrame, dt, localId, localTeam: local?.team, mode: snapshot?.mode ?? 'ffa',
      camera: this.camera, width: this.width, height: this.height, buffer: this.snapshotBuffer, players: snapshot?.players ?? [],
      library: this.worldWeapons, sunVisibility: this.sunVisibility, sounds: document.hidden ? null : this.remoteSounds,
    });
    const viewTime = renderTime(this.snapshotBuffer, now) ?? serverNow;
    controller.setViewTime(viewTime);
    const lookDelta = { yaw: input.yaw - this.lastView.yaw, pitch: input.pitch - this.lastView.pitch };
    this.lastView = { yaw: input.yaw, pitch: input.pitch };
    const scoped = spec.scoped && motion.ads >= 0.9;
    const showViewModel = firstPerson && this.weaponsReady && !this.options.graphicsTest;
    if (showViewModel) {
      this.viewModel.setProjection(this.camera.fov, this.camera.aspect);
      this.viewModel.update({
        weapon: spec.id, ads: motion.ads, sprint: motion.sprint, dash: !!state.dashing, posture: state.posture, speed, grounded, lookDelta,
        reload: progress, reloadEmpty: this.weapon.state.reloadEmpty, raise: this.weapon.raise(predictedNow), wallBlock: motion.wallBlock,
        cook: this.weapon.cook(predictedNow), scoped, reduceMotion: this.settings.reduceMotion,
      }, dt, this.elapsed);
    }
    this.viewModel.scene.visible = showViewModel;
    this.updateWorldObjects(serverNow);
    const health = self && alive ? displayedHealth(self.health, self.lastDamageAt, snapshot!.serverTime, serverNow, hasPerk(self.loadout, 'second-wind')) : Math.max(0, local?.health ?? 0);
    const lowHealth = alive ? clamp((60 - health) / 45, 0, 1) : 0;
    this.flash = Math.max(0, this.flash - dt * 2);
    const level = Math.round(lowHealth * 20) / 20;
    if (level !== this.lowHealthLevel) { this.lowHealthLevel = level; this.audio.lowHealth(level); }
    if (now - this.indoorsCheckedAt > 250) { this.indoorsCheckedAt = now; this.indoors = raycastMap(this.camera.position, { x: 0, y: 1, z: 0 }, 12) < 12; }
    this.audio.setListener(this.camera.position, input.yaw, input.pitch, this.indoors);
    if (local && snapshot) {
      const hidden = !alive || !!state.sprinting || state.posture === 'vault' || scoped || !firstPerson;
      const slot = this.weapon.state.slot;
      this.hudFeed.publish({
        time: now, weapon: spec.id, slot, mag: this.weapon.state.mag[slot - 1], reserve: this.weapon.state.reserve[slot - 1], frags: this.weapon.state.frags,
        reload: progress, ads: motion.ads, scoped, sprinting: !!state.sprinting, dashing: !!state.dashing, stamina: state.stamina, posture: state.posture, health,
        crosshair: crosshairGap(spec, motion.ads, this.camera.fov, this.height, hidden), cook: this.weapon.cook(predictedNow),
        blocked: motion.fireBlocked || !this.weapon.fireReady({ now: predictedNow, sprinting: false, vaultProgress: vaultProgress(state.vault, predictedNow) }),
        view: { x: feet.x, z: feet.z, yaw: input.yaw }, rewards: self?.rewards ?? [], mortarTargeting: controller.mortarTargeting,
      }, {
        localId, localTeam: local.team, mode: snapshot.mode, now: viewTime, players: [...this.remotes.entries.values()].map(entry => entry.state),
        recon: snapshot.recon ?? [], drones: snapshot.drones ?? [], mortars: snapshot.mortars ?? [],
      }, this.grenades.positions);
    }
    this.followShadow(firstPerson ? feet : this.camera.position);
    this.world.update(this.elapsed); this.effects.update(elapsedFrame, this.camera);
    this.options.graphicsTest?.beforeRender?.(this.scene, this.camera, this.renderer);
    this.renderer.info.reset();
    const submitStarted = this.options.graphicsTest ? performance.now() : 0;
    const presentation = this.presentation?.enabled ? this.presentation : null;
    if (presentation) {
      presentation.setAim(motion.ads, focus);
      presentation.setCondition(lowHealth, this.flash);
      if (presentation.drawsOverlay && !this.overlayAttached) { presentation.setOverlay(this.viewModel.scene, this.viewModel.camera); this.overlayAttached = true; }
      presentation.render(dt);
      if (!presentation.drawsOverlay && showViewModel) this.renderViewModel();
    } else {
      this.renderer.render(this.scene, this.camera);
      if (showViewModel) this.renderViewModel();
    }
    this.firstPersonFrame = firstPerson;
    this.options.graphicsTest?.afterRender?.(this.renderer, performance.now() - submitStarted, elapsedFrame * 1000);
    // Parsing and scene attachment alone do not prove that the player has a usable view.
    this.checkAssetsReady();
    this.checkPreparationRendered();
    if (this.statsTime >= 0.7) {
      const fps = Math.round(this.frames / this.statsTime);
      this.options.onStats?.({ fps, locked: controller.locked, drawCalls: this.renderer.info.render.calls });
      if (!this.options.graphicsTest?.lockQuality && this.settings.quality === 'auto' && this.assetsAnnounced) {
        this.slowTime = fps < 38 ? this.slowTime + this.statsTime : Math.max(0, this.slowTime - this.statsTime);
        if (this.slowTime > 2.1 && this.presentation?.enabled) { this.presentation.enabled = false; this.slowTime = 0; this.renderQuality.resetTiming(); }
      }
      if (!this.options.graphicsTest?.lockQuality && this.assetsAnnounced && this.renderQuality.observe(fps, this.statsTime, this.settings.quality)) this.resizePending = true;
      this.statsTime = 0; this.frames = 0;
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  /** The viewmodel shares the world's field of view and draws over it with cleared depth. */
  private renderViewModel() {
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.viewModel.scene, this.viewModel.camera);
    this.renderer.autoClear = true;
  }

  /** Grenades follow the shared deterministic trajectory; mortar shells whistle before landing. */
  private updateWorldObjects(serverNow: number) {
    const { bounces, expired } = this.grenades.advance(serverNow);
    for (const id of expired) this.effects.grenade(id, null);
    for (const grenade of this.grenades.positions) this.effects.grenade(grenade.id, grenade);
    const whistles = dueWhistles(this.snapshot?.mortars ?? [], serverNow, this.whistled);
    if (document.hidden) return;
    for (const bounce of bounces) this.audio.grenadeBounce(bounce.position, bounce.impact);
    for (const position of whistles) this.audio.mortarWhistle(position);
  }

  private serverTime(now: number) {
    const latest = this.snapshotBuffer[this.snapshotBuffer.length - 1]; return latest ? latest.world.serverTime + now - latest.received : Date.now();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; cancelAnimationFrame(this.raf); this.resizeObserver.disconnect(); this.audio.dispose();
    document.removeEventListener('visibilitychange', this.visibilityChange);
    this.options.input.setFireBlocked(false); this.options.input.setAimZoom(1, false);
    this.remotes.dispose(); this.world.dispose();
    this.effects.dispose(); this.respawns.dispose(); this.localRespawnAt = 0;
    this.viewModel.dispose(); this.worldWeapons?.dispose(); this.worldWeapons = null;
    this.hudFeed.dispose(); this.grenades.clear();
    disposeCharacterResources();
    const geometries = new Set<THREE.BufferGeometry>(); const materials = new Set<THREE.Material>();
    this.scene.traverse(object => { if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) { geometries.add(object.geometry); for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material); } });
    for (const geometry of geometries) geometry.dispose(); for (const material of materials) material.dispose();
    this.presentation?.dispose(); this.scene.environment = null;
    this.sun.shadow.map?.dispose(); this.renderer.dispose(); this.renderer.forceContextLoss();
    this.canvas.removeEventListener('webglcontextlost', this.contextLost);
    this.canvas.remove(); this.labels.remove(); this.prediction.pending = []; this.snapshotBuffer = [];
  }
}
