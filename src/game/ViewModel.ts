import * as THREE from 'three';
import type { Posture, WeaponId } from '../../shared/protocol';
import { QUICK_HANDS_FACTOR, WEAPONS } from '../../shared/weapons';
import { FALLBACK_WEAPON, WEAPON_IDS, createWeaponLibrary, findNode, isWeaponId, loadWeaponModels, type WeaponInstance, type WeaponLibrary } from './WeaponModels';
import { HANDLING, type HandlingSpec, type PoseSpec } from './viewmodel/handling';
import { PoseSpring, Spring, approach, clamp, clamp01, easeInOutSine, finite, lerp, seededRandom, smoothstep } from './viewmodel/spring';
import {
  BOLT_CYCLE, COOK_POSE, KNIFE_MOVE, PUMP_CYCLE, SHELL_PICKUP, SHELL_RETURN, SHELL_SEAT, THROW_MOVE, THROW_RELEASE, VAULT_MOVE,
  boltCycle, boltDuration, crossedEvents, emptySample, pumpDuration, pumpTravel, reloadChoreography, sampleChoreography, sampleTrack, shellCycle,
  type ChoreoEventKind, type Choreography, type HandMove, type HandTarget,
} from './viewmodel/choreography';
import { CasingEjector, DroppedMagazines, MuzzleFlash, MuzzleSmoke } from './viewmodel/effects';
import { MUZZLE_LIGHT_LEAD, ViewModelLighting } from './viewmodel/lighting';

/** Everything the first-person arms and weapon react to, sampled each frame by GameView. */
export interface ViewModelState {
  weapon: WeaponId;
  /** Aim-down-sights blend 0..1. */
  ads: number;
  /** Sprint pose blend 0..1; `dash` raises the weapon into the faster-sprint pose. */
  sprint: number; dash: boolean;
  posture: Posture;
  /** Horizontal speed (m/s) and whether the feet are on the ground, for bob and landing. */
  speed: number; grounded: boolean;
  /** View rotation since the previous frame (radians), for sway. Positive yaw turned right, positive pitch looked up. */
  lookDelta: { yaw: number; pitch: number };
  /** Reload progress 0..1 or -1; `reloadEmpty` selects the longer empty reload choreography.
   * For the shotgun this is progress through the whole reload (start plus every shell). */
  reload: number; reloadEmpty: boolean;
  /** Weapon raise 0 (lowered, after swap/spawn) .. 1 (ready). */
  raise: number;
  /** Retract near walls 0..1. */
  wallBlock: number;
  /** Grenade cook 0..1, or -1. */
  cook: number;
  /** Fully scoped: hide the weapon. */
  scoped: boolean;
  reduceMotion: boolean;
  /** Optional: velocity relative to the view (m/s): + right, + up, + forward. Adds strafe lean and jump float. */
  velocity?: { right: number; up: number; forward: number };
  /** Optional: dash stamina 0..1; a tired dash gets a heavier, sloppier stride. */
  stamina?: number;
  /** Optional: the magazine is empty, so the pistol slide locks back. */
  magEmpty?: boolean;
  /** Optional but recommended: shells this shotgun reload loads. With it the shells follow `reload`
   * exactly; without it the count is read from how fast `reload` moves. */
  reloadShells?: number;
}

export interface ViewModelOptions {
  /** Use this library instead of loading the weapons GLB (tests, tools). The view model disposes it. */
  library?: WeaponLibrary | Promise<WeaponLibrary>;
  /** 'phone' keeps fewer smoke puffs and casings alive. */
  effects?: 'phone' | 'desktop';
  /** Short point-light flash on the gun when it fires. */
  muzzleLight?: boolean;
}

interface Rest { position: THREE.Vector3; quaternion: THREE.Quaternion }
interface Rig {
  id: WeaponId;
  instance: WeaponInstance;
  handling: HandlingSpec;
  /** Anchor points in the root's own frame. */
  grip: THREE.Vector3; sight: THREE.Vector3;
  magRest: Rest | null; actionRest: Rest | null;
  /** Hand target on the magazine and the action, in their own frames. */
  magHold: THREE.Vector3; knob: THREE.Vector3;
  load: THREE.Object3D | null;
  /** Shell-by-shell reload timing at the normal pace, from the weapon table, and the most shells one reload loads. */
  shellStartMs: number; perShellMs: number; shellCapacity: number;
}
interface Offset { x: number; y: number; z: number; rx: number; ry: number; rz: number }
const zeroOffset = (): Offset => ({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 });
const addOffset = (target: Offset, x: number, y: number, z: number, rx: number, ry: number, rz: number, k = 1) => {
  target.x += x * k; target.y += y * k; target.z += z * k; target.rx += rx * k; target.ry += ry * k; target.rz += rz * k;
};

const HOLSTER_SECONDS = 0.16;
/** `cycleTime` value while no pump or bolt cycle is playing. */
const IDLE = -10;
const EQUIP_SECONDS = 0.3;
/** Share of a game-driven raise spent putting the old weapon away. */
const SWAP_SHARE = 0.3;
/** Shotgun reload paces the server can run: normal, and faster with Quick Hands. */
const SHELL_PACES: readonly number[] = [1, QUICK_HANDS_FACTOR];
/** Shoulders (camera space) and arm segment lengths for the elbow solve. */
const SHOULDER = { right: new THREE.Vector3(0.23, -0.22, 0.1), left: new THREE.Vector3(-0.2, -0.25, 0.1) } as const;
/** Elbows point out and down: the right one well out to the side, so the forearm crosses the lower right. */
const POLE = { right: new THREE.Vector3(0.95, -0.3, 0.05).normalize(), left: new THREE.Vector3(-0.8, -0.6, 0.05).normalize() } as const;
const UPPER_ARM = 0.31, FOREARM = 0.3;
const POUCH = new THREE.Vector3(-0.2, -0.56, -0.24);
const POUCH_TURN = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.9, 0.3, 0.5, 'YXZ'));
const FORWARD = new THREE.Vector3(0, 0, 1);
const LOWERED: Offset = { x: 0.035, y: -0.3, z: 0.1, rx: -0.9, ry: -0.15, rz: -0.35 };
const WALL: Offset = { x: -0.01, y: -0.035, z: 0.1, rx: -0.4, ry: 0.3, rz: 0.3 };
const CROUCH: Offset = { x: -0.008, y: -0.012, z: 0.008, rx: 0, ry: 0, rz: 0.05 };
const SLIDE: Offset = { x: -0.012, y: -0.024, z: 0.012, rx: -0.04, ry: 0, rz: 0.24 };

/** First-person arms and weapon, drawn over the world with cleared depth in the same field of view.
 *
 * Motion is layered: a hip / aim / sprint / dash base pose, deliberate moves (reload, knife, grenade,
 * vault, swap, wall retract), then spring-driven secondary motion (look sway, stride bob, breathing,
 * recoil, landing). Every spring uses an exact solution, so it behaves the same at any frame rate. */
export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.01, 10);
  readonly ready: Promise<void>;
  private library: WeaponLibrary | null = null;
  private current: Rig | null = null;
  private readonly rigs = new Map<WeaponId, Rig>();
  private disposed = false;
  private readonly lighting: ViewModelLighting;
  private readonly flash = new MuzzleFlash();
  private readonly smoke: MuzzleSmoke;
  private readonly casings: CasingEjector;
  private readonly drops = new DroppedMagazines();
  private readonly casingMaterials: THREE.Material[] = [];
  private readonly random = seededRandom(0x5eed);
  /** Render settings the shaders were already compiled for (see `prepareShaders`). */
  private readonly compiledFor: Array<{ target: number; toneMapping: number; colorSpace: string; environment: THREE.Texture | null; flashLight: boolean }> = [];
  private worldCamera: THREE.Camera | null = null;
  private worldScene: THREE.Scene | null = null;

  // Arms and props.
  private armLeft: THREE.Object3D | null = null;
  private armRight: THREE.Object3D | null = null;
  private forearmLeft: THREE.Object3D | null = null;
  private forearmRight: THREE.Object3D | null = null;
  private holdLeft: THREE.Object3D | null = null;
  private knifeProp: THREE.Object3D | null = null;
  private fragProp: THREE.Object3D | null = null;
  private shellProp: THREE.Mesh | null = null;

  // Clock and smoothed inputs.
  private clock = 0;
  private readonly sprintWeight = new Spring(3.6, 1);
  private readonly dashWeight = new Spring(2.6, 1);
  private readonly crouchWeight = new Spring(3, 1);
  private readonly slideWeight = new Spring(3.5, 1);
  private readonly wallWeight = new Spring(4, 1);
  private readonly cookWeight = new Spring(3.5, 1);
  private readonly reloadWeight = new Spring(3.8, 1);
  private adsVisual = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private reduceMotion = false;

  // Secondary motion.
  private readonly sway = new PoseSpring(3, 0.62);
  private readonly recoil = new PoseSpring(7.5, 0.42);
  private readonly heatSpring = new Spring(2, 1);
  private readonly landing = new PoseSpring(3.2, 0.45);
  private readonly strafe = new PoseSpring(2.6, 0.85);
  private heat = 0;
  private bobPhase = 0;
  private bobAmount = 0;
  private breathPhase = 0;
  private wasGrounded = true;
  private airTime = 0;
  private lastLandAt = -10;
  private lastPosture: Posture = 'stand';

  // Weapon handling state.
  private holstering = false;
  private holsterProgress = 0;
  private equipProgress = 1;
  private raiseVisual = 1;
  private holsterFrom = 1;
  private raiseDriven = false;
  private shotIndex = 0;
  private lastShotAt = -10;
  private cycleTime = IDLE;
  private slideTime = -1;
  private pendingEject = false;
  private meleeTime = -1;
  private throwTime = -1;
  private vaultTime = -1;
  private wasCooking = false;
  private lastThrowAt = -10;
  /** Cook pose weight when the throw began, so a throw without a cook eases in. */
  private throwFrom = 1;
  private lastVaultAt = -10;

  // Reload state.
  private reloadProgress = -1;
  private reloadLast = 0;
  private reloadEmpty = false;
  private reloadChoreo: Choreography | null = null;
  /** Shotgun: frame clock (s) since the reload was first seen, the shells it loads (0 = not known
   * yet), whether that count is settled, and where the reload stands in normal-pace ms. */
  private shotgunClock = 0;
  private shotgunShells = 0;
  private shotgunLocked = false;
  private shotgunMs = 0;
  /** Running sums for a least-squares line through (clock, progress) at the frames where progress
   * moved; its slope is the reload's pace. `last` is the previous frame's progress. */
  private readonly paceFit = { n: 0, t: 0, p: 0, tt: 0, tp: 0, last: -1 };
  /** Index of the last shell seated in this reload (-1 = none yet). */
  private shellSeated = -1;
  private readonly onReloadEvent = (kind: ChoreoEventKind) => { if (this.current) this.reloadEvent(kind, this.current); };
  private readonly sample = emptySample();
  private readonly shell = { reach: 0, shellInHand: false, insert: 0 };
  private readonly bolt = { act: 0, lift: 0, hand: 0 };

  // Scratch values (no allocation per frame).
  private readonly offset = zeroOffset();
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly v3 = new THREE.Vector3();
  private readonly v4 = new THREE.Vector3();
  private readonly v5 = new THREE.Vector3();
  private readonly q1 = new THREE.Quaternion();
  private readonly q2 = new THREE.Quaternion();
  private readonly q3 = new THREE.Quaternion();
  private readonly q4 = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly rootPosition = new THREE.Vector3();
  private readonly rootQuaternion = new THREE.Quaternion();
  private readonly poseA = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  private readonly poseB = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  private readonly gravity = new THREE.Vector3(0, -9.8, 0);
  private readonly cameraQuaternion = new THREE.Quaternion();
  private readonly flashPosition = new THREE.Vector3();
  private readonly drift = (point: THREE.Vector3, velocity: THREE.Vector3) => this.anchorToWorld(point, velocity);
  private frameDt = 0;
  private frameVelocity: { right: number; up: number; forward: number } | null = null;

  constructor(renderer: THREE.WebGLRenderer, options: ViewModelOptions = {}) {
    this.scene.name = 'viewmodel';
    this.camera.name = 'viewmodel-camera';
    const phone = options.effects === 'phone';
    this.lighting = new ViewModelLighting(this.scene, options.muzzleLight ?? true);
    this.scene.onBeforeRender = (drawing: THREE.WebGLRenderer, _scene: THREE.Scene, camera: THREE.Camera) => this.prepareShaders(drawing, camera);
    this.smoke = new MuzzleSmoke(phone ? 10 : 24);
    const brass = new THREE.MeshStandardMaterial({ color: '#b8893e', metalness: 0.95, roughness: 0.3 });
    const hull = new THREE.MeshStandardMaterial({ color: '#8e1d18', metalness: 0, roughness: 0.55 });
    this.casingMaterials.push(brass, hull);
    this.casings = new CasingEjector(phone ? 6 : 12, brass, hull);
    this.scene.add(this.smoke.mesh, this.casings.group, this.drops.group);
    const source = options.library ?? loadWeaponModels(renderer);
    this.ready = Promise.resolve(source).then(library => {
      if (this.disposed) { library.dispose(); return; }
      this.attachLibrary(library);
    }, error => {
      // The arms and weapon are always on screen: never leave the player without them.
      console.warn('The first-person weapon could not be prepared; using built-in stand-ins.', error);
      if (!this.disposed) this.attachLibrary(createWeaponLibrary(null));
    });
  }

  /** The weapon currently shown, once the library is ready. */
  get weapon(): WeaponId | null { return this.current?.id ?? null; }
  /** The current weapon's model and anchors (for effects and tests). */
  get instance(): WeaponInstance | null { return this.current?.instance ?? null; }
  get arms(): { left: THREE.Object3D | null; right: THREE.Object3D | null } { return { left: this.armLeft, right: this.armRight }; }
  /** Props shown during moves: the knife, the grenade and the loose shotgun shell. */
  get props(): { knife: THREE.Object3D | null; frag: THREE.Object3D | null; shell: THREE.Object3D | null } { return { knife: this.knifeProp, frag: this.fragProp, shell: this.shellProp }; }
  /** Muzzle effects, exposed for tests and tuning. */
  get effects(): { flash: MuzzleFlash; smoke: MuzzleSmoke; casings: CasingEjector; drops: DroppedMagazines } { return { flash: this.flash, smoke: this.smoke, casings: this.casings, drops: this.drops }; }
  get sunDirection(): THREE.Vector3 { return this.lighting.sunDirection; }
  /** Shells pushed into the tube so far in the current (or last) shotgun reload; for tests and tuning. */
  get shellsSeated(): number { return this.shellSeated + 1; }

  /** Vertical field of view (degrees) and aspect follow the world camera. */
  setProjection(fov: number, aspect: number) { this.camera.fov = fov; this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }

  /** Light the weapon like the world: the sun and sky follow `camera`'s rotation every frame and the
   * reflections come from `scene.environment`. Pass null to fall back to a fixed camera-relative rig. */
  setWorld(camera: THREE.Camera | null, scene: THREE.Scene | null = null): void { this.worldCamera = camera; this.worldScene = scene; }
  /** 0 in full shade .. 1 in direct sun, from the same grid that shades the characters. */
  setSunVisibility(value: number): void { this.lighting.setSunVisibility(value); }
  /** Turning the muzzle light off removes it from the scene (one shader recompile), so phones never pay for it. */
  setQuality(quality: { muzzleLight?: boolean }): void { if (quality.muzzleLight !== undefined) this.lighting.setFlashEnabled(quality.muzzleLight); }

  update(state: ViewModelState, dt: number, _time: number) {
    if (this.disposed) return;
    // The reload clock keeps real frame time (a hitch must not skew the shotgun's pace); motion is clamped.
    const frame = clamp(finite(dt, 0), 0, 1);
    dt = Math.min(frame, 0.1);
    this.clock += dt;
    this.frameDt = dt;
    const velocity = state.velocity;
    this.frameVelocity = velocity && Number.isFinite(velocity.right) && Number.isFinite(velocity.up) && Number.isFinite(velocity.forward) ? velocity : null;
    this.syncLighting(dt);
    if (!this.library) return;
    this.updateWeapon(state, dt);
    const rig = this.current;
    if (!rig) return;
    this.reduceMotion = !!state.reduceMotion;
    const ads = clamp01(finite(state.ads, 0));
    const lookYaw = finite(state.lookDelta?.yaw, 0), lookPitch = finite(state.lookDelta?.pitch, 0);
    this.updateWeights(state, dt);
    this.updateReload(state, rig, dt, frame);
    this.updateMoves(dt);
    const busy = Math.max(clamp01(this.reloadWeight.value), this.moveEnvelope(KNIFE_MOVE, this.meleeTime), clamp01(this.cookWeight.value),
      this.throwTime >= 0 ? 1 : 0, this.moveEnvelope(VAULT_MOVE, this.vaultTime) * 0.6);
    this.adsVisual = easeInOutSine(ads) * (1 - busy) * (1 - clamp01(this.wallWeight.value));
    this.updateSecondary(state, rig, dt, lookYaw, lookPitch);
    this.composePose(state, rig, ads);
    this.updateParts(state, rig);
    this.placeArms(rig);
    this.updateProps(rig);
    this.updateEffects(rig, dt, lookYaw, lookPitch);
    // Fully scoped, the HUD draws the scope: nothing of the viewmodel may show through its lens.
    const visible = !state.scoped;
    rig.instance.root.visible = visible;
    if (this.armLeft) this.armLeft.visible = visible;
    if (this.armRight) this.armRight.visible = visible;
    this.casings.group.visible = visible; this.drops.group.visible = visible;
    this.smoke.mesh.visible &&= visible;
    if (this.shellProp) this.shellProp.visible &&= visible;
    if (!visible) this.flash.group.visible = false;
  }

  /** A predicted shot from the local player: kick, flash, smoke, casing and the action. */
  fire() {
    const rig = this.current;
    if (!rig || this.disposed) return;
    const spec = WEAPONS[rig.id], kick = rig.handling.kick;
    this.shotIndex = this.clock - this.lastShotAt > 0.35 ? 0 : this.shotIndex + 1;
    this.lastShotAt = this.clock;
    const visual = spec.recoil.visual * (this.reduceMotion ? 0.7 : 1);
    const pattern = spec.recoil.pattern;
    const side = pattern.length ? pattern[this.shotIndex % pattern.length]! : 0;
    const jitter = this.random() - 0.5;
    const rotation = lerp(1, kick.adsRotation, this.adsVisual), back = lerp(1, kick.adsBack, this.adsVisual);
    this.recoil.z.impulse(kick.back * visual * back);
    this.recoil.y.impulse(kick.up * visual * rotation);
    this.recoil.x.impulse(-0.12 * visual * side * rotation);
    this.recoil.pitch.impulse(kick.pitch * visual * rotation);
    this.recoil.roll.impulse(kick.roll * visual * rotation * (side * 0.8 + jitter * 0.5));
    this.recoil.yaw.impulse(kick.yaw * visual * rotation * (side * 0.6 + jitter * 0.6));
    this.heat = Math.min(1.5, this.heat + 0.12 * visual);
    this.flash.fire(rig.handling.flash, this.random);
    const anchors = rig.instance.anchors;
    anchors.muzzle.updateWorldMatrix(true, false);
    this.v1.setFromMatrixPosition(anchors.muzzle.matrixWorld);
    this.v2.set(0, 0, -1).applyQuaternion(rig.instance.root.quaternion);
    this.v3.set(0, 1, 0);
    const shotgun = rig.handling.reload === 'shotgun';
    this.smoke.emit(this.v1, this.v2, this.v3, shotgun ? 4 : rig.id === 'longbow' ? 4 : 2, shotgun ? 1.5 : 1, this.random);
    switch (rig.handling.action) {
      case 'slide': this.slideTime = 0; this.eject(rig); break;
      case 'pump': case 'bolt': this.cycleTime = -rig.handling.cycleDelay; this.pendingEject = true; break;
      default: this.eject(rig);
    }
  }

  /** Quick knife swing (the knife comes up in the left hand). */
  melee() { if (this.meleeTime < 0 || this.meleeTime > KNIFE_MOVE.duration * 0.75) this.meleeTime = 0; }
  /** Release the cooked grenade. */
  throwGrenade() {
    if (this.clock - this.lastThrowAt < 0.2) return;
    this.lastThrowAt = this.clock; this.throwTime = 0; this.throwFrom = clamp01(this.cookWeight.value); this.cookWeight.reset(0);
  }
  /** Landing jolt; `intensity` 0..1 (1 is a hard landing from about head height). */
  land(intensity: number) {
    const strength = clamp(finite(intensity, 0), 0, 1.5);
    const recent = this.clock - this.lastLandAt < 0.15;
    this.lastLandAt = this.clock;
    // An automatic landing may already have played this frame; only add what it lacked.
    const k = recent ? Math.max(0, strength - this.autoLandStrength) : strength;
    this.autoLandStrength = recent ? Math.max(this.autoLandStrength, strength) : strength;
    this.applyLanding(k);
  }
  /** Vault: the left hand plants while the weapon tucks. */
  vault() { if (this.clock - this.lastVaultAt > 0.3) { this.vaultTime = 0; this.lastVaultAt = this.clock; } }

  /** World-space muzzle for tracers, mapped from viewmodel space through the world camera. */
  muzzleWorld(worldCamera: THREE.Camera, target: THREE.Vector3): THREE.Vector3 {
    return this.anchorWorld(this.current?.instance.anchors.muzzle ?? null, worldCamera, target);
  }
  /** World-space ejection port, for effects that want to continue a casing in the world. */
  ejectWorld(worldCamera: THREE.Camera, target: THREE.Vector3): THREE.Vector3 {
    return this.anchorWorld(this.current?.instance.anchors.eject ?? null, worldCamera, target);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.drops.dispose(); this.flash.dispose(); this.smoke.dispose(); this.casings.dispose(); this.lighting.dispose();
    for (const material of this.casingMaterials) material.dispose();
    this.shellProp?.geometry.dispose(); (this.shellProp?.material as THREE.Material | undefined)?.dispose();
    for (const rig of this.rigs.values()) rig.instance.root.removeFromParent();
    this.rigs.clear(); this.current = null;
    for (const object of [this.armLeft, this.armRight, this.knifeProp, this.fragProp, this.shellProp]) object?.removeFromParent();
    this.scene.environment = null;
    this.library?.dispose(); this.library = null;
  }

  // ---------------------------------------------------------------------------------------------

  private autoLandStrength = 0;

  private attachLibrary(library: WeaponLibrary) {
    this.library = library;
    const arms = library.arms();
    this.armLeft = arms.left; this.armRight = arms.right;
    this.armLeft.name ||= 'arm_left'; this.armRight.name ||= 'arm_right';
    this.forearmLeft = findNode(this.armLeft, 'forearm'); this.forearmRight = findNode(this.armRight, 'forearm');
    this.holdLeft = findNode(this.armLeft, 'hold') ?? this.armLeft;
    this.scene.add(this.armLeft, this.armRight);
    this.knifeProp = library.knife(); this.fragProp = library.frag();
    this.knifeProp.visible = false; this.fragProp.visible = false;
    this.holdLeft.add(this.knifeProp, this.fragProp);
    const shellGeometry = new THREE.CylinderGeometry(0.0105, 0.0105, 0.068, 12);
    shellGeometry.rotateX(-Math.PI / 2);
    this.shellProp = new THREE.Mesh(shellGeometry, new THREE.MeshStandardMaterial({ color: '#8e1d18', roughness: 0.55 }));
    this.shellProp.name = 'loading-shell'; this.shellProp.visible = false;
    this.scene.add(this.shellProp);
    // Every weapon waits hidden in the scene (clones share geometry and materials), so the first
    // draw prepares all their shaders and a first swap never stalls.
    for (const id of WEAPON_IDS) this.rig(id);
  }

  private rig(id: WeaponId): Rig {
    let rig = this.rigs.get(id);
    if (rig) return rig;
    const instance = this.library!.weapon(id, 'view');
    const root = instance.root;
    root.position.set(0, 0, 0); root.quaternion.identity(); root.updateMatrixWorld(true);
    const local = (node: THREE.Object3D) => node.getWorldPosition(new THREE.Vector3());
    const rest = (node: THREE.Object3D | null): Rest | null => node ? { position: node.position.clone(), quaternion: node.quaternion.clone() } : null;
    const magazine = instance.anchors.magazine, action = instance.anchors.action;
    const knobNode = action ? findNode(action, 'knob') : null;
    const spec = WEAPONS[id];
    rig = {
      id, instance, handling: HANDLING[id],
      grip: local(instance.anchors.gripRight), sight: local(instance.anchors.sight),
      magRest: rest(magazine), actionRest: rest(action),
      magHold: magazine ? holdPoint(magazine) : new THREE.Vector3(),
      knob: knobNode ? knobNode.position.clone() : action ? actionHandle(action, HANDLING[id].action) : new THREE.Vector3(),
      load: findNode(root, 'load'),
      // The weapon table is the single source shared with the server; a weapon without shell timing
      // (never shotgun-style today) would load everything in one step.
      shellStartMs: Math.max(0, spec.shellStartMs ?? 0), perShellMs: Math.max(1, spec.perShellMs ?? spec.reloadMs),
      shellCapacity: Math.max(1, spec.magazine),
    };
    root.visible = false;
    this.scene.add(root);
    this.rigs.set(id, rig);
    return rig;
  }

  private equip(id: WeaponId) {
    if (this.current) { this.current.instance.root.visible = false; this.resetParts(this.current); }
    const rig = this.rig(id);
    this.current = rig;
    rig.instance.root.visible = true;
    rig.instance.anchors.muzzle.add(this.flash.group);
    this.flash.clear();
    const h = rig.handling;
    this.recoil.tune(h.kick.hz, h.kick.damping, h.kick.hz * 0.85, h.kick.damping);
    this.sway.tune(h.swayHz, 0.62, h.swayHz, 0.6);
    this.equipProgress = this.raiseDriven ? 1 : 0;
    this.cycleTime = IDLE; this.slideTime = -1; this.pendingEject = false;
    this.reloadProgress = -1; this.reloadChoreo = null; this.reloadWeight.reset(0);
    this.shotIndex = 0;
  }

  private resetParts(rig: Rig) {
    const { magazine, action } = rig.instance.anchors;
    if (magazine && rig.magRest) { magazine.position.copy(rig.magRest.position); magazine.quaternion.copy(rig.magRest.quaternion); magazine.visible = true; }
    if (action && rig.actionRest) { action.position.copy(rig.actionRest.position); action.quaternion.copy(rig.actionRest.quaternion); }
  }

  /** Swaps put the old weapon away, then bring the new one up. When the game drives `raise` through
   * the swap (0 -> 1 over the weapon's raise time), the first part of it lowers the old weapon and the
   * rest raises the new one, so the gun is up exactly when the server lets it fire. Otherwise fixed
   * timings are used. */
  private updateWeapon(state: ViewModelState, dt: number) {
    // Only real weapon ids: an unknown or inherited name (`toString`) keeps the weapon in hand.
    const wanted = isWeaponId(state.weapon) ? state.weapon : this.current?.id ?? FALLBACK_WEAPON;
    const raise = clamp01(finite(state.raise, 1));
    if (!this.current) { this.equip(wanted); return; }
    if (this.current.id !== wanted) {
      if (!this.holstering) {
        this.holstering = true; this.holsterFrom = this.raiseVisual;
        this.holsterProgress = this.raiseVisual < 0.25 ? 1 : 0;
        this.raiseDriven = false;
      }
      if (raise < 0.95) this.raiseDriven = true;
      // A stalled `raise` can never hold the old weapon up for long.
      this.holsterProgress = this.raiseDriven
        ? Math.max(this.holsterProgress + dt / HOLSTER_SECONDS * 0.25, raise / SWAP_SHARE)
        : this.holsterProgress + dt / HOLSTER_SECONDS;
      if (this.holsterProgress >= 1) { this.holstering = false; this.equip(wanted); }
    } else if (this.holstering) {
      // Swapped back before the old weapon was away: raise it again from where it is.
      this.holstering = false; this.raiseDriven = false; this.equipProgress = 1 - this.holsterProgress;
    }
    if (!this.holstering) this.equipProgress = Math.min(1, this.equipProgress + dt / EQUIP_SECONDS);
    if (this.holstering) this.raiseVisual = (1 - smoothstep(this.holsterProgress)) * this.holsterFrom;
    else if (this.raiseDriven && raise < 1) this.raiseVisual = smoothstep((raise - SWAP_SHARE) / (1 - SWAP_SHARE));
    else { this.raiseDriven = false; this.raiseVisual = Math.min(smoothstep(raise), smoothstep(this.equipProgress)); }
  }

  private updateWeights(state: ViewModelState, dt: number) {
    const ads = clamp01(finite(state.ads, 0));
    this.sprintWeight.update(clamp01(finite(state.sprint, 0)) * (1 - ads), dt);
    this.dashWeight.update(state.dash ? 1 : 0, dt);
    this.crouchWeight.update(state.posture === 'crouch' ? 1 : 0, dt);
    this.slideWeight.update(state.posture === 'slide' ? 1 : 0, dt);
    this.wallWeight.update(clamp01(finite(state.wallBlock, 0)), dt);
    const cooking = finite(state.cook, -1) >= 0;
    this.cookWeight.update(cooking && this.throwTime < 0 ? 1 : 0, dt);
    if (this.wasCooking && !cooking && this.clock - this.lastThrowAt > 0.2) this.throwGrenade();
    this.wasCooking = cooking;
    if (state.posture !== this.lastPosture) {
      if (state.posture === 'crouch' && this.lastPosture === 'stand') this.landing.y.impulse(-0.12);
      if (state.posture === 'stand' && this.lastPosture === 'crouch') this.landing.y.impulse(0.08);
      if (state.posture === 'slide') { this.landing.y.impulse(-0.22); this.landing.roll.impulse(0.4); }
      if (state.posture === 'vault') this.vault();
      this.lastPosture = state.posture;
    }
  }

  /** `frame` is the unclamped frame time, used only for the shotgun's pace. */
  private updateReload(state: ViewModelState, rig: Rig, dt: number, frame: number) {
    const progress = finite(state.reload, -1);
    const reloading = progress >= 0;
    const style = rig.handling.reload;
    if (reloading) {
      const t = clamp01(progress);
      const restarted = this.reloadProgress >= 0 && t < this.reloadProgress - 0.5;
      const fresh = this.reloadProgress < 0 || restarted || !this.reloadChoreo;
      if (fresh) {
        this.reloadEmpty = !!state.reloadEmpty;
        this.reloadChoreo = reloadChoreography(style, this.reloadEmpty);
        this.reloadLast = t;
        this.shotgunClock = 0; this.shotgunShells = 0; this.shotgunLocked = false; this.shotgunMs = 0;
        this.paceFit.n = this.paceFit.t = this.paceFit.p = this.paceFit.tt = this.paceFit.tp = 0; this.paceFit.last = -1;
        this.shellSeated = -1;
        this.cycleTime = IDLE; this.pendingEject = false;
      }
      if (style !== 'shotgun') crossedEvents(this.reloadChoreo!, this.reloadLast, t, this.onReloadEvent);
      this.reloadLast = t;
      this.reloadProgress = t;
      // The first frame only anchors the pace: its time passed before the reload was seen.
      if (style === 'shotgun') this.trackShotgun(state, t, fresh ? 0 : frame, rig);
    } else if (this.reloadProgress >= 0) {
      // Finished or interrupted: keep the last pose while it blends away.
      if (style === 'shotgun' && this.reloadEmpty && this.reloadLast > 0.2) { this.cycleTime = 0; this.pendingEject = false; }
      this.reloadProgress = -1;
    }
    this.reloadWeight.update(reloading ? 1 : 0, dt);
    if (this.reloadWeight.value < 1e-3 && !reloading) { this.reloadWeight.reset(0); this.reloadChoreo = null; }
  }

  /** The shotgun loads like the server: a start of `shellStartMs`, then one shell every `perShellMs`
   * (both shorter with Quick Hands). Progress runs over the whole reload, so once the shell count is
   * known, progress alone says where the reload stands, at any pace and frame rate. Without
   * `reloadShells`, the count comes from the pace of progress: a least-squares line through the
   * frames where progress moved since the reload was first seen (a late or offset start cancels out,
   * frame jitter averages away, and progress that arrives in steps is timed by when each step lands).
   * The count settles when the hand starts carrying the first shell up; until then the hand waits at
   * the pouch, so a corrected count never shows as a jump. */
  private trackShotgun(state: ViewModelState, progress: number, frame: number, rig: Rig) {
    const startMs = rig.shellStartMs, perMs = rig.perShellMs;
    this.shotgunClock += frame;
    const known = finite(state.reloadShells, 0);
    const fit = this.paceFit, moved = progress !== fit.last;
    fit.last = progress;
    if (known >= 1) {
      this.shotgunShells = Math.min(rig.shellCapacity, Math.round(known));
      this.shotgunLocked = true;
    } else if (!this.shotgunLocked && moved && progress < 1) {
      const t = this.shotgunClock;
      fit.n++; fit.t += t; fit.p += progress; fit.tt += t * t; fit.tp += t * progress;
      const spread = fit.n * fit.tt - fit.t * fit.t;
      const pace = fit.n >= 2 && spread > 1e-12 ? (fit.n * fit.tp - fit.t * fit.p) / spread : 0;
      if (pace > 1e-6) this.shotgunShells = matchShellCount(1000 / pace, rig);
    }
    const shells = this.shotgunShells || provisionalShells(rig);
    this.shotgunMs = progress * (startMs + perMs * shells);
    if (this.shotgunShells && this.shotgunMs >= startMs + SHELL_PICKUP * perMs) this.shotgunLocked = true;
    const into = this.shotgunMs - startMs;
    if (into < 0) return;
    const index = Math.min(shells - 1, Math.floor(into / perMs)), u = (into - index * perMs) / perMs;
    if (u >= SHELL_SEAT && index > this.shellSeated) { this.shellSeated = index; this.reloadEvent('shellIn', rig); }
  }

  private reloadEvent(kind: ChoreoEventKind, rig: Rig) {
    const r = this.random() - 0.5;
    switch (kind) {
      case 'magOut': this.recoil.y.impulse(-0.08); this.recoil.roll.impulse(0.25 * r); break;
      case 'magDrop': {
        this.recoil.y.impulse(-0.06);
        const magazine = rig.instance.anchors.magazine;
        if (magazine) this.drops.drop(magazine, this.v4.set(-0.15, -1.1, 0.12), 4 + this.random() * 3);
        break;
      }
      case 'magIn': this.recoil.y.impulse(0.32); this.recoil.pitch.impulse(0.7); this.recoil.roll.impulse(0.5 * r); break;
      case 'charge': this.recoil.z.impulse(-0.35); this.recoil.pitch.impulse(-0.5); this.recoil.roll.impulse(0.4 * r); break;
      case 'boltOpen': case 'boltClose': this.recoil.z.impulse(kind === 'boltClose' ? -0.2 : 0.15); this.recoil.roll.impulse(0.3 * r); break;
      case 'shellIn': this.recoil.y.impulse(0.12); this.recoil.pitch.impulse(0.25); this.recoil.z.impulse(-0.06); break;
      case 'ready': this.recoil.pitch.impulse(-0.2); break;
    }
  }

  private updateMoves(dt: number) {
    if (this.meleeTime >= 0) { this.meleeTime += dt; if (this.meleeTime > KNIFE_MOVE.duration) this.meleeTime = -1; }
    if (this.throwTime >= 0) { this.throwTime += dt; if (this.throwTime > THROW_MOVE.duration) this.throwTime = -1; }
    if (this.vaultTime >= 0) { this.vaultTime += dt; if (this.vaultTime > VAULT_MOVE.duration) this.vaultTime = -1; }
    if (this.slideTime >= 0) { this.slideTime += dt; if (this.slideTime > 0.09) this.slideTime = -1; }
    const rig = this.current;
    if (this.cycleTime > IDLE && rig) {
      const duration = rig.handling.action === 'bolt' ? boltDuration() : pumpDuration();
      const before = this.cycleTime;
      this.cycleTime += dt;
      const eject = rig.handling.action === 'bolt' ? BOLT_CYCLE.eject : PUMP_CYCLE.eject;
      if (this.pendingEject && before < eject && this.cycleTime >= eject) { this.pendingEject = false; this.eject(rig); }
      if (this.cycleTime > duration) { this.cycleTime = IDLE; this.pendingEject = false; }
    }
  }

  private moveEnvelope(move: HandMove, time: number): number {
    if (time < 0) return 0;
    return clamp01(sampleTrack(move.hw, time / move.duration));
  }

  private updateSecondary(state: ViewModelState, rig: Rig, dt: number, lookYaw: number, lookPitch: number) {
    const h = rig.handling;
    const motion = this.reduceMotion ? 0.4 : 1;
    // Look sway: the weapon lags behind the turn, banks into it, and settles with a little overshoot.
    const inverseDt = dt > 1 / 500 ? 1 / dt : 0;
    this.lookYaw = approach(this.lookYaw, clamp(lookYaw * inverseDt, -12, 12), 30, dt);
    this.lookPitch = approach(this.lookPitch, clamp(lookPitch * inverseDt, -12, 12), 30, dt);
    const swing = h.sway * motion * (1 + 0.5 * clamp01(this.sprintWeight.value));
    this.sway.yaw.update(clamp(0.0175 * this.lookYaw * swing, -0.085, 0.085), dt);
    this.sway.pitch.update(clamp(-0.015 * this.lookPitch * swing, -0.07, 0.07), dt);
    this.sway.roll.update(clamp(-0.02 * this.lookYaw * swing, -0.1, 0.1), dt);
    this.sway.x.update(clamp(-0.0035 * this.lookYaw * swing, -0.02, 0.02), dt);
    this.sway.y.update(clamp(-0.003 * this.lookPitch * swing, -0.016, 0.016), dt);
    this.sway.z.update(0, dt);
    // Stride bob, faster with speed; amplitude eases in and out.
    const grounded = state.grounded !== false;
    const speed = Math.max(0, finite(state.speed, 0));
    const bobbing = grounded && state.posture !== 'slide' && state.posture !== 'vault';
    this.bobAmount = approach(this.bobAmount, bobbing ? clamp(speed / 5, 0, 1.8) : 0, 7, dt);
    // Phases wrap at their period so long sessions never lose sine precision.
    if (grounded) this.bobPhase = (this.bobPhase + 2 * Math.PI * (0.9 + 0.17 * speed) * dt) % (2 * Math.PI);
    this.breathPhase = (this.breathPhase + 2 * Math.PI * 0.21 * dt) % (4 * Math.PI);
    // Jumping and landing.
    if (this.wasGrounded && !grounded) { this.landing.y.impulse(-0.16); this.landing.pitch.impulse(-0.3); this.airTime = 0; }
    if (!grounded) this.airTime += dt;
    if (!this.wasGrounded && grounded) {
      if (this.clock - this.lastLandAt > 0.15) {
        const strength = clamp((this.airTime - 0.12) / 0.7, 0, 1);
        this.lastLandAt = this.clock; this.autoLandStrength = strength;
        this.applyLanding(strength);
      }
    }
    this.wasGrounded = grounded;
    const up = this.frameVelocity?.up ?? 0;
    this.landing.y.update(grounded ? 0 : clamp(-up * 0.0022, -0.014, 0.014) + (this.frameVelocity ? 0 : 0.004 * clamp01(this.airTime * 4)), dt);
    this.landing.pitch.update(grounded ? 0 : clamp(up * 0.004, -0.03, 0.03), dt);
    this.landing.x.update(0, dt); this.landing.z.update(0, dt); this.landing.yaw.update(0, dt); this.landing.roll.update(0, dt);
    // Strafe lean from the optional velocity.
    const right = this.frameVelocity?.right ?? 0, forward = this.frameVelocity?.forward ?? 0;
    this.strafe.roll.update(clamp(-0.012 * right, -0.07, 0.07) * motion, dt);
    this.strafe.x.update(clamp(-0.0025 * right, -0.015, 0.015) * motion, dt);
    this.strafe.z.update(clamp(0.0015 * forward, -0.01, 0.012) * motion, dt);
    this.strafe.y.update(0, dt); this.strafe.pitch.update(0, dt); this.strafe.yaw.update(0, dt);
    // Recoil springs and the slow drift that builds during a long burst.
    this.recoil.settle(dt);
    this.heat = approach(this.heat, 0, this.clock - this.lastShotAt > 0.12 ? 6 : 0.4, dt);
    this.heatSpring.update(this.heat, dt);
  }

  private applyLanding(strength: number) {
    if (!(strength > 0)) return;
    const k = strength * (this.reduceMotion ? 0.4 : 1);
    this.landing.y.impulse(-0.55 * k); this.landing.pitch.impulse(-1.5 * k);
    this.landing.roll.impulse((this.random() - 0.5) * 0.9 * k); this.landing.z.impulse(0.12 * k);
  }

  private composePose(state: ViewModelState, rig: Rig, ads: number) {
    const h = rig.handling, root = rig.instance.root;
    const adsV = this.adsVisual;
    // Base pose: hip -> aim, then -> sprint / dash.
    poseRoot(h.hip, rig.grip, this.poseA.position, this.poseA.quaternion, this.euler, this.v1);
    this.rootPosition.set(0, 0, -h.adsEye).sub(rig.sight);
    this.rootPosition.lerpVectors(this.poseA.position, this.rootPosition, adsV);
    this.rootQuaternion.copy(this.poseA.quaternion).slerp(this.q1.identity(), adsV);
    const sprint = clamp01(this.sprintWeight.value) * (1 - adsV);
    if (sprint > 1e-4) {
      poseRoot(h.sprint, rig.grip, this.poseA.position, this.poseA.quaternion, this.euler, this.v1);
      poseRoot(h.dash, rig.grip, this.poseB.position, this.poseB.quaternion, this.euler, this.v1);
      const dash = clamp01(this.dashWeight.value);
      this.poseA.position.lerp(this.poseB.position, dash); this.poseA.quaternion.slerp(this.poseB.quaternion, dash);
      this.rootPosition.lerp(this.poseA.position, sprint); this.rootQuaternion.slerp(this.poseA.quaternion, sprint);
    }
    // Deliberate moves and posture layers.
    const o = this.offset;
    o.x = o.y = o.z = o.rx = o.ry = o.rz = 0;
    const reloadW = clamp01(this.reloadWeight.value);
    if (this.reloadChoreo && reloadW > 1e-4) {
      sampleChoreography(this.reloadChoreo, this.reloadLast, this.sample);
      addOffset(o, this.sample.px, this.sample.py, this.sample.pz, this.sample.rx, this.sample.ry, this.sample.rz, reloadW);
    }
    if (this.cycleTime >= 0) {
      if (h.action === 'pump') { const act = pumpTravel(this.cycleTime); addOffset(o, 0, -0.008 * act, 0.006 * act, -0.02 * act, 0, 0.03 * act); }
      else if (h.action === 'bolt') { boltCycle(this.cycleTime, this.bolt); addOffset(o, -0.012 * this.bolt.hand, 0.004 * this.bolt.hand, 0, 0.03 * this.bolt.hand, -0.03 * this.bolt.hand, -0.13 * this.bolt.hand); }
    }
    this.addMove(KNIFE_MOVE, this.meleeTime);
    this.addMove(THROW_MOVE, this.throwTime, this.throwBlend());
    this.addMove(VAULT_MOVE, this.vaultTime);
    const cook = clamp01(this.cookWeight.value);
    if (cook > 1e-4) addOffset(o, COOK_POSE.px, COOK_POSE.py, COOK_POSE.pz, COOK_POSE.rx, COOK_POSE.ry, COOK_POSE.rz, cook);
    const wall = clamp01(this.wallWeight.value);
    if (wall > 1e-4) addOffset(o, WALL.x, WALL.y, WALL.z, WALL.rx, WALL.ry, WALL.rz, wall);
    const lowered = 1 - this.raiseVisual;
    if (lowered > 1e-4) addOffset(o, LOWERED.x, LOWERED.y, LOWERED.z, LOWERED.rx, LOWERED.ry, LOWERED.rz, lowered);
    addOffset(o, CROUCH.x, CROUCH.y, CROUCH.z, CROUCH.rx, CROUCH.ry, CROUCH.rz, clamp01(this.crouchWeight.value) * (1 - adsV));
    addOffset(o, SLIDE.x, SLIDE.y, SLIDE.z, SLIDE.rx, SLIDE.ry, SLIDE.rz, clamp01(this.slideWeight.value) * (1 - 0.6 * adsV));
    // The sight travels on a slight arc while it comes up to the eye.
    const arc = Math.sin(Math.PI * ads) * (1 - clamp01(this.reloadWeight.value));
    addOffset(o, -0.004 * arc, -0.012 * arc, 0, 0, 0, 0.06 * arc);
    // Secondary motion, quieted while aiming.
    const swayRotation = lerp(1, 0.3, adsV), swayMove = lerp(1, 0.35, adsV);
    addOffset(o, this.sway.x.value * swayMove, this.sway.y.value * swayMove, 0, this.sway.pitch.value * swayRotation, this.sway.yaw.value * swayRotation, this.sway.roll.value * swayRotation);
    this.addBob(state, h, adsV);
    const breath = lerp(1, 0.02, adsV) * (this.reduceMotion ? 0 : 1) * (1 - 0.7 * clamp01(this.bobAmount)) * (1 - clamp01(this.sprintWeight.value));
    const b = this.breathPhase;
    addOffset(o, 0.0008 * Math.sin(b * 0.5), 0.0016 * Math.sin(b), 0, 0.0028 * Math.sin(b + 0.7), 0.0012 * Math.sin(b * 0.5 + 1.3), 0, breath);
    const land = lerp(1, 0.45, adsV);
    addOffset(o, this.landing.x.value, this.landing.y.value, this.landing.z.value, this.landing.pitch.value, this.landing.yaw.value, this.landing.roll.value, land);
    const lean = lerp(1, 0.25, adsV);
    addOffset(o, this.strafe.x.value, this.strafe.y.value, this.strafe.z.value, this.strafe.pitch.value, this.strafe.yaw.value, this.strafe.roll.value, lean);
    const heat = this.heatSpring.value * lerp(1, 0.4, adsV);
    addOffset(o, this.recoil.x.value, this.recoil.y.value - 0.002 * heat, this.recoil.z.value + 0.008 * heat, this.recoil.pitch.value + 0.012 * heat, this.recoil.yaw.value, this.recoil.roll.value);
    // Apply the offsets as a rotation about the pivot behind the grip plus a translation.
    const pivot = this.v2.copy(rig.grip).add(this.v3.set(h.pivot[0], h.pivot[1], h.pivot[2])).applyQuaternion(this.rootQuaternion).add(this.rootPosition);
    this.q2.setFromEuler(this.euler.set(o.rx, o.ry, o.rz, 'YXZ'));
    root.position.copy(this.rootPosition).sub(pivot).applyQuaternion(this.q2).add(pivot);
    root.position.x += o.x; root.position.y += o.y; root.position.z += o.z;
    root.quaternion.copy(this.q2).multiply(this.rootQuaternion);
  }

  private addMove(move: HandMove, time: number, weight = 1) {
    if (time < 0) return;
    const t = time / move.duration, o = this.offset;
    addOffset(o, sampleTrack(move.px, t), sampleTrack(move.py, t), sampleTrack(move.pz, t), sampleTrack(move.rx, t), sampleTrack(move.ry, t), sampleTrack(move.rz, t), weight);
  }
  private throwBlend(): number { return this.throwTime < 0 ? 0 : lerp(this.throwFrom, 1, smoothstep(this.throwTime / 0.12)); }

  private addBob(state: ViewModelState, h: HandlingSpec, adsV: number) {
    const amount = this.bobAmount * h.bob * lerp(1, 0.12, adsV) * (state.posture === 'crouch' ? 0.6 : 1) * (this.reduceMotion ? 0.2 : 1);
    if (amount < 1e-5) return;
    const phase = this.bobPhase, sprint = clamp01(this.sprintWeight.value), dash = clamp01(this.dashWeight.value) * sprint;
    const stamina = clamp01(finite(state.stamina, 1));
    const tired = state.dash ? clamp01((0.35 - stamina) / 0.35) : 0;
    const walk = 1 - sprint;
    const s1 = Math.sin(phase), c2 = Math.cos(2 * phase), s1b = Math.sin(phase + 0.4);
    const x = 0.0055 * s1 * walk + 0.016 * s1 * (sprint - dash) + 0.012 * s1 * dash;
    const y = 0.0055 * c2 * walk + 0.014 * c2 * (sprint - dash) + 0.022 * c2 * dash - 0.01 * tired;
    const rx = 0.005 * c2 * walk + 0.03 * c2 * (sprint - dash) + 0.045 * c2 * dash;
    const ry = 0.006 * s1 * walk + 0.05 * s1b * (sprint - dash) + 0.035 * s1b * dash;
    const rz = 0.012 * s1 * walk + 0.045 * s1 * (sprint - dash) + 0.06 * s1 * dash;
    addOffset(this.offset, x, y, 0, rx, ry, rz, amount * (1 + 0.6 * tired));
  }

  private updateParts(state: ViewModelState, rig: Rig) {
    const { magazine, action } = rig.instance.anchors;
    const reloadW = clamp01(this.reloadWeight.value);
    const choreographed = !!this.reloadChoreo && reloadW > 1e-4;
    const s = this.sample;
    if (magazine && rig.magRest) {
      if (choreographed && rig.handling.reload !== 'shotgun') {
        magazine.position.copy(this.v1.set(0, s.magY * reloadW, s.magZ * reloadW).applyQuaternion(rig.magRest.quaternion).add(rig.magRest.position));
        magazine.quaternion.copy(rig.magRest.quaternion).multiply(this.q1.setFromAxisAngle(this.v2.set(1, 0, 0), s.magRx * reloadW));
        magazine.visible = reloadW < 0.5 || s.magVisible;
      } else {
        magazine.position.copy(rig.magRest.position); magazine.quaternion.copy(rig.magRest.quaternion); magazine.visible = true;
      }
    }
    if (action && rig.actionRest) {
      let travel = 0, lift = 0;
      if (choreographed && rig.handling.reload !== 'shotgun') { travel = s.act * reloadW; lift = s.lift * reloadW; }
      if (this.cycleTime >= 0) {
        if (rig.handling.action === 'pump') travel = Math.max(travel, pumpTravel(this.cycleTime));
        else if (rig.handling.action === 'bolt') { boltCycle(this.cycleTime, this.bolt); travel = Math.max(travel, this.bolt.act); lift = Math.max(lift, this.bolt.lift); }
      }
      if (this.slideTime >= 0) travel = Math.max(travel, this.slideTime < 0.025 ? smoothstep(this.slideTime / 0.025) : 1 - smoothstep((this.slideTime - 0.025) / 0.065));
      if (rig.handling.action === 'slide' && state.magEmpty && !choreographed) travel = 1;
      action.position.copy(rig.actionRest.position);
      action.position.z += travel * rig.handling.actionTravel;
      action.quaternion.copy(rig.actionRest.quaternion);
      if (lift > 0) action.quaternion.multiply(this.q1.setFromAxisAngle(this.v2.set(0, 0, 1), lift * 1.05));
    }
  }

  /** Camera-space point and rotation for a hand target. */
  private resolveTarget(rig: Rig, target: HandTarget, side: 'left' | 'right', position: THREE.Vector3, rotation: THREE.Quaternion) {
    const anchors = rig.instance.anchors, root = rig.instance.root;
    rotation.copy(root.quaternion);
    switch (target) {
      case 'grip': {
        const grip = side === 'left' ? anchors.gripLeft : anchors.gripRight;
        position.setFromMatrixPosition(grip.matrixWorld);
        // Each arm is modelled holding its grip in that anchor's own frame (palm at the origin), so the
        // hand turns with the anchor, not only the weapon; otherwise the fists sit 20-55 degrees off.
        grip.getWorldQuaternion(rotation);
        if (side === 'left' && rig.handling.action === 'pump' && anchors.action && rig.actionRest) {
          position.add(this.v4.set(0, 0, anchors.action.position.z - rig.actionRest.position.z).applyQuaternion(root.quaternion));
        }
        return;
      }
      case 'mag': if (anchors.magazine) { position.copy(rig.magHold).applyMatrix4(anchors.magazine.matrixWorld); return; } break;
      case 'action': if (anchors.action) { position.copy(rig.knob).applyMatrix4(anchors.action.matrixWorld); return; } break;
      case 'load':
        if (rig.load) { position.setFromMatrixPosition(rig.load.matrixWorld); return; }
        position.setFromMatrixPosition(anchors.eject.matrixWorld).add(this.v4.set(-0.02, -0.045, 0).applyQuaternion(root.quaternion));
        return;
      case 'pouch': position.copy(POUCH); rotation.copy(POUCH_TURN); return;
    }
    position.setFromMatrixPosition((side === 'left' ? anchors.gripLeft : anchors.gripRight).matrixWorld);
  }

  private placeArms(rig: Rig) {
    const left = this.armLeft, right = this.armRight;
    if (!left || !right) return;
    rig.instance.root.updateMatrixWorld(true);
    const reloadW = clamp01(this.reloadWeight.value);
    const choreographed = !!this.reloadChoreo && reloadW > 1e-4;
    // Right hand: on the grip, except while working the bolt.
    let rightAway = 0;
    if (choreographed && rig.handling.reload === 'bolt') {
      this.blendHand(rig, 'right', this.sample.right.from, this.sample.right.to, this.sample.right.mix, right.position, right.quaternion);
      this.resolveTarget(rig, 'grip', 'right', this.v1, this.q1);
      right.position.lerpVectors(this.v1, right.position, reloadW); right.quaternion.slerpQuaternions(this.q1, right.quaternion, reloadW);
    } else {
      this.resolveTarget(rig, 'grip', 'right', right.position, right.quaternion);
    }
    if (this.cycleTime >= 0 && rig.handling.action === 'bolt') {
      boltCycle(this.cycleTime, this.bolt);
      rightAway = this.bolt.hand;
      if (rightAway > 0) {
        this.resolveTarget(rig, 'action', 'right', this.v1, this.q1);
        right.position.lerp(this.v1, rightAway);
      }
    }
    // Left hand: timed moves first, then the reload, then the dash swing, otherwise the grip.
    this.resolveTarget(rig, 'grip', 'left', this.v1, this.q1);
    left.position.copy(this.v1); left.quaternion.copy(this.q1);
    if (choreographed) {
      if (rig.handling.reload === 'shotgun') this.shotgunHand(rig, left.position, left.quaternion);
      else this.blendHand(rig, 'left', this.sample.left.from, this.sample.left.to, this.sample.left.mix, left.position, left.quaternion);
      left.position.lerpVectors(this.v1, left.position, reloadW); left.quaternion.slerpQuaternions(this.q1, left.quaternion, reloadW);
    }
    const cook = clamp01(this.cookWeight.value);
    if (cook > 1e-4) this.handToward(left, COOK_POSE.hx, COOK_POSE.hy, COOK_POSE.hz, COOK_POSE.hrx, COOK_POSE.hry, COOK_POSE.hrz, cook);
    this.moveHand(left, VAULT_MOVE, this.vaultTime, 1);
    this.moveHand(left, THROW_MOVE, this.throwTime, this.throwBlend());
    this.moveHand(left, KNIFE_MOVE, this.meleeTime, 1);
    const dash = clamp01(this.dashWeight.value) * clamp01(this.sprintWeight.value) * (1 - reloadW);
    if (dash > 1e-4 && this.meleeTime < 0 && this.throwTime < 0 && cook < 1e-3) {
      const swing = Math.sin(this.bobPhase);
      this.handToward(left, -0.17 + 0.03 * swing, -0.5 + 0.06 * Math.cos(this.bobPhase * 2), -0.32 - 0.1 * swing, -0.6, 0.2, 0.3, dash);
    }
    left.updateMatrixWorld(true); right.updateMatrixWorld(true);
    this.aimForearm(left, this.forearmLeft, 'left');
    this.aimForearm(right, this.forearmRight, 'right');
  }

  private blendHand(rig: Rig, side: 'left' | 'right', from: HandTarget, to: HandTarget, mix: number, position: THREE.Vector3, rotation: THREE.Quaternion) {
    this.resolveTarget(rig, from, side, position, rotation);
    if (mix <= 0 || from === to) return;
    this.resolveTarget(rig, to, side, this.v3, this.q3);
    position.lerp(this.v3, mix); rotation.slerp(this.q3, mix);
  }

  /** Shotgun, driven by the reload position from `trackShotgun`: the hand drops to the shell pouch
   * during the start, then for each shell carries one up into the loading port; after the last shell
   * it goes back to the pump. `position` and `rotation` arrive holding the pump grip. */
  private shotgunHand(rig: Rig, position: THREE.Vector3, rotation: THREE.Quaternion) {
    const startMs = rig.shellStartMs, perMs = rig.perShellMs, ms = this.shotgunMs;
    this.resolveTarget(rig, 'pouch', 'left', this.v3, this.q3);
    if (ms < startMs) {
      const k = smoothstep(ms / Math.max(1, startMs * 0.8));
      position.lerp(this.v3, k); rotation.slerp(this.q3, k);
      this.shell.reach = 0; this.shell.shellInHand = false; this.shell.insert = 0;
      return;
    }
    const shells = this.shotgunShells || provisionalShells(rig);
    const index = Math.min(shells - 1, Math.floor((ms - startMs) / perMs));
    const u = clamp01((ms - startMs - index * perMs) / perMs);
    shellCycle(u, this.shell);
    this.v5.copy(position); this.q4.copy(rotation);
    this.resolveTarget(rig, 'load', 'left', position, rotation);
    if (index >= shells - 1 && u >= SHELL_RETURN) {
      const back = smoothstep((u - SHELL_RETURN) / (1 - SHELL_RETURN));
      position.lerp(this.v5, back); rotation.slerp(this.q4, back);
    } else {
      position.lerpVectors(this.v3, position, this.shell.reach); rotation.slerpQuaternions(this.q3, rotation, this.shell.reach);
    }
  }

  /** A timed move's pull on the left hand. */
  private moveHand(arm: THREE.Object3D, move: HandMove, time: number, blend: number) {
    if (time < 0) return;
    const t = time / move.duration, w = clamp01(sampleTrack(move.hw, t)) * blend;
    if (w > 1e-4) this.handToward(arm, sampleTrack(move.hx, t), sampleTrack(move.hy, t), sampleTrack(move.hz, t), sampleTrack(move.hrx, t), sampleTrack(move.hry, t), sampleTrack(move.hrz, t), w);
  }

  private handToward(arm: THREE.Object3D, x: number, y: number, z: number, rx: number, ry: number, rz: number, weight: number) {
    arm.position.lerp(this.v4.set(x, y, z), weight);
    arm.quaternion.slerp(this.q3.setFromEuler(this.euler.set(rx, ry, rz, 'YXZ')), weight);
  }

  /** Point the forearm from the wrist toward an elbow solved from a fixed shoulder (two-bone IK). */
  private aimForearm(arm: THREE.Object3D, forearm: THREE.Object3D | null, side: 'left' | 'right') {
    if (!forearm) return;
    const wrist = this.v1.copy(forearm.position).applyMatrix4(arm.matrixWorld);
    const shoulder = SHOULDER[side], pole = POLE[side];
    const reach = this.v2.subVectors(wrist, shoulder);
    const distance = clamp(reach.length(), Math.abs(UPPER_ARM - FOREARM) + 1e-3, UPPER_ARM + FOREARM - 1e-3);
    const along = reach.normalize();
    const x = (UPPER_ARM * UPPER_ARM - FOREARM * FOREARM + distance * distance) / (2 * distance);
    const height = Math.sqrt(Math.max(0, UPPER_ARM * UPPER_ARM - x * x));
    const bend = this.v3.copy(pole).addScaledVector(along, -pole.dot(along));
    if (bend.lengthSq() < 1e-8) bend.set(0, -1, 0);
    bend.normalize();
    const elbow = this.v4.copy(shoulder).addScaledVector(along, x).addScaledVector(bend, height);
    const direction = elbow.sub(wrist).normalize().applyQuaternion(this.q1.copy(arm.quaternion).invert());
    // Never fold the wrist more than ~65 degrees; past that the hand turns instead.
    const angle = FORWARD.angleTo(direction);
    forearm.quaternion.setFromUnitVectors(FORWARD, direction);
    if (angle > 1.15) forearm.quaternion.slerp(this.q2.identity(), 1 - 1.15 / angle);
  }

  private updateProps(rig: Rig) {
    const knife = this.knifeProp, frag = this.fragProp, shell = this.shellProp;
    if (knife) {
      const t = this.meleeTime / KNIFE_MOVE.duration;
      knife.visible = this.meleeTime >= 0 && sampleTrack(KNIFE_MOVE.hw, t) > 0.05;
      knife.rotation.set(0, 0, 0);
    }
    if (frag) {
      const throwing = this.throwTime >= 0, released = throwing && this.throwTime / THROW_MOVE.duration >= THROW_RELEASE;
      frag.visible = (clamp01(this.cookWeight.value) > 0.05 || throwing) && !released;
    }
    if (shell) {
      const loading = rig.handling.reload === 'shotgun' && !!this.reloadChoreo && clamp01(this.reloadWeight.value) > 0.5 && this.shell.shellInHand && this.reloadProgress >= 0;
      shell.visible = loading;
      if (loading && this.holdLeft) {
        this.holdLeft.updateWorldMatrix(true, false);
        this.v1.setFromMatrixPosition(this.holdLeft.matrixWorld);
        if (this.shell.insert > 0) { this.resolveTarget(rig, 'load', 'left', this.v2, this.q1); this.v1.lerp(this.v2, this.shell.insert); }
        shell.position.copy(this.v1);
        shell.quaternion.copy(rig.instance.root.quaternion);
      }
    }
  }

  private eject(rig: Rig) {
    const anchors = rig.instance.anchors, root = rig.instance.root;
    anchors.eject.updateWorldMatrix(true, false);
    this.v1.setFromMatrixPosition(anchors.eject.matrixWorld);
    const r = this.random;
    const hull = rig.handling.shell === 'hull';
    this.v2.set(1.5 + r() * 0.7, 0.9 + r() * 0.6, 0.35 + r() * 0.35);
    if (hull) this.v2.set(1.1 + r() * 0.5, 0.6 + r() * 0.4, 0.2 + r() * 0.2);
    this.v2.applyQuaternion(root.quaternion);
    this.casings.eject(rig.handling.shell, this.v1, this.v2, root.quaternion, r);
  }

  private updateEffects(rig: Rig, dt: number, lookYaw: number, lookPitch: number) {
    this.pendingLook.yaw = lookYaw; this.pendingLook.pitch = lookPitch;
    this.flash.update(dt);
    const worldDown = this.worldCamera ? this.v3.set(0, -9.8, 0).applyQuaternion(this.q1.copy(this.cameraQuaternion).invert()) : this.v3.set(0, -9.8, 0);
    this.gravity.copy(worldDown);
    this.smoke.update(dt, this.adsVisual, this.drift);
    this.casings.update(dt, this.gravity, this.drift);
    this.drops.update(dt, this.gravity, this.drift);
    let light = 0;
    if (this.lighting.flashEnabled && this.flash.active) {
      light = this.flash.intensity * rig.handling.flash;
      // Burn in the flame ahead of the muzzle, not back on the hands.
      rig.instance.anchors.muzzle.updateWorldMatrix(true, false);
      this.flashPosition.setFromMatrixPosition(rig.instance.anchors.muzzle.matrixWorld)
        .addScaledVector(this.v2.set(0, 0, -1).applyQuaternion(rig.instance.root.quaternion), MUZZLE_LIGHT_LEAD);
    }
    this.lighting.update(0, light, light > 0 ? this.flashPosition : null);
  }
  private readonly pendingLook = { yaw: 0, pitch: 0 };

  /** Keep a camera-space point roughly fixed in the world: undo this frame's turn and own motion. */
  private anchorToWorld(point: THREE.Vector3, velocity: THREE.Vector3) {
    const yaw = this.pendingLook.yaw, pitch = this.pendingLook.pitch;
    if (yaw || pitch) {
      this.q2.setFromEuler(this.euler.set(-pitch, yaw, 0, 'XYZ'));
      point.applyQuaternion(this.q2); velocity.applyQuaternion(this.q2);
    }
    const v = this.frameVelocity;
    if (v) { point.x -= v.right * this.frameDt; point.y -= v.up * this.frameDt; point.z += v.forward * this.frameDt; }
  }

  /** Compiles every viewmodel shader the first time the scene is drawn with new render settings
   * (target, tone mapping, sky, muzzle light), including the flash, smoke, casings and props that
   * start hidden. Otherwise the first shot, knife or grenade of a match would stall while they
   * compile. It runs from the scene's own before-render hook, so it compiles exactly the variants
   * the real pass (screen or post-processing target) uses; later frames only compare a few values. */
  private prepareShaders(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
    if (this.disposed || !this.library || !this.current || typeof renderer?.compile !== 'function') return;
    const current = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
    const target = current === null ? 0 : (current as { isXRRenderTarget?: boolean }).isXRRenderTarget ? 2 : 1;
    const toneMapping = renderer.toneMapping, colorSpace = renderer.outputColorSpace;
    const environment = this.scene.environment, flashLight = this.lighting.flashEnabled;
    for (let i = 0; i < this.compiledFor.length; i++) {
      const seen = this.compiledFor[i]!;
      if (seen.target === target && seen.toneMapping === toneMapping && seen.colorSpace === colorSpace && seen.environment === environment && seen.flashLight === flashLight) return;
    }
    if (this.compiledFor.length >= 8) this.compiledFor.length = 0;
    this.compiledFor.push({ target, toneMapping, colorSpace, environment, flashLight });
    try { renderer.compile(this.scene, camera); }
    catch (error) { console.warn('The first-person shaders could not be prepared early; they will compile on first use.', error); }
  }

  private syncLighting(dt: number) {
    const camera = this.worldCamera;
    if (camera) {
      camera.updateMatrixWorld();
      camera.matrixWorld.decompose(this.v1, this.cameraQuaternion, this.v2);
      this.lighting.follow(this.cameraQuaternion);
    }
    const world = this.worldScene;
    if (world) {
      this.scene.environment = world.environment;
      this.scene.environmentIntensity = world.environmentIntensity;
    }
    this.lighting.update(dt, 0, null);
  }

  private anchorWorld(anchor: THREE.Object3D | null, worldCamera: THREE.Camera, target: THREE.Vector3): THREE.Vector3 {
    worldCamera.updateMatrixWorld();
    if (!anchor) return target.setFromMatrixPosition(worldCamera.matrixWorld);
    anchor.updateWorldMatrix(true, false);
    target.setFromMatrixPosition(anchor.matrixWorld);
    // If the two projections differ, keep the same pixel and distance rather than the same vector.
    if (worldCamera instanceof THREE.PerspectiveCamera && (Math.abs(worldCamera.fov - this.camera.fov) > 1e-3 || Math.abs(worldCamera.aspect - this.camera.aspect) > 1e-3)) {
      const distance = target.length();
      this.camera.updateProjectionMatrix(); worldCamera.updateProjectionMatrix();
      target.applyMatrix4(this.camera.projectionMatrix);
      target.set(target.x, target.y, 0.5).applyMatrix4(worldCamera.projectionMatrixInverse).normalize().multiplyScalar(distance);
    }
    return target.applyMatrix4(worldCamera.matrixWorld);
  }
}

/** The shell count (at either pace) whose reload length is closest to `totalMs`. */
function matchShellCount(totalMs: number, rig: Rig): number {
  let best = 1, error = Infinity;
  for (let p = 0; p < SHELL_PACES.length; p++) {
    for (let shells = 1; shells <= rig.shellCapacity; shells++) {
      const miss = Math.abs(Math.log(totalMs / (SHELL_PACES[p]! * (rig.shellStartMs + rig.perShellMs * shells))));
      if (miss < error) { error = miss; best = shells; }
    }
  }
  return best;
}
/** Used only until the reload has moved far enough to read its pace (normally one frame). */
const provisionalShells = (rig: Rig) => Math.ceil(rig.shellCapacity / 2);

/** Root transform for a pose that puts the right grip at `pose.grip`. */
function poseRoot(pose: PoseSpec, grip: THREE.Vector3, position: THREE.Vector3, quaternion: THREE.Quaternion, euler: THREE.Euler, scratch: THREE.Vector3) {
  quaternion.setFromEuler(euler.set(pose.rotation[0], pose.rotation[1], pose.rotation[2], 'YXZ'));
  position.set(pose.grip[0], pose.grip[1], pose.grip[2]).sub(scratch.copy(grip).applyQuaternion(quaternion));
}

/** Where a hand grips the magazine, in the magazine's own frame: the middle of its visible body. */
function holdPoint(magazine: THREE.Object3D): THREE.Vector3 {
  const box = localBounds(magazine);
  if (box.isEmpty()) return new THREE.Vector3(0, -0.06, 0);
  const center = box.getCenter(new THREE.Vector3());
  return center.setY(THREE.MathUtils.lerp(box.max.y, box.min.y, 0.62));
}
/** The handle of the moving part: the bolt knob (furthest right), otherwise the part's middle. */
function actionHandle(action: THREE.Object3D, style: HandlingSpec['action']): THREE.Vector3 {
  const box = localBounds(action);
  if (box.isEmpty()) return new THREE.Vector3();
  const center = box.getCenter(new THREE.Vector3());
  if (style === 'bolt') return new THREE.Vector3(box.max.x - 0.008, box.min.y + 0.012, center.z);
  if (style === 'slide') return new THREE.Vector3(center.x, box.max.y, box.max.z - 0.02);
  return center;
}
function localBounds(node: THREE.Object3D): THREE.Box3 {
  node.updateWorldMatrix(true, true);
  const inverse = new THREE.Matrix4().copy(node.matrixWorld).invert();
  const box = new THREE.Box3(), part = new THREE.Box3(), matrix = new THREE.Matrix4();
  node.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.computeBoundingBox();
    part.copy(object.geometry.boundingBox!).applyMatrix4(matrix.multiplyMatrices(inverse, object.matrixWorld));
    box.union(part);
  });
  return box;
}

