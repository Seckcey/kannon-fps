import * as THREE from 'three';
import type { GameEvent, GameMode, Posture, PublicPlayerState, SurfaceKind, Team, Vec3, WeaponId, WorldSnapshot } from '../../shared/protocol';
import { isPlayerGrounded, rayHitboxes, raycastMap, supportHeight } from '../../shared/physics';
import { surfaceAt } from '../../shared/map';
import { hasPerk, WEAPONS } from '../../shared/weapons';
import type { CombatEffects } from './CombatEffects';
import { createBlenderCharacter } from './BlenderCharacter';
import type { CharacterModel } from './Character';
import type { CharacterImpactKind } from './CharacterImpact';
import { LocomotionVelocity } from './LocomotionVelocity';
import { LandingFilter, Stride, stepLength } from './FirstPersonCamera';
import type { SunVisibilityGrid } from './SunVisibility';
import type { WeaponInstance, WeaponLibrary } from './WeaponModels';

export interface Buffered { world: WorldSnapshot; received: number }
/** Other players are drawn this far in the past so two snapshots always surround them. */
export const INTERPOLATION_DELAY_MS = 100;
export const FRIENDLY_COLOR = '#4aa3ff';
export const ENEMY_COLOR = '#ff5a4f';
const HEARING_METERS = 40;
const lerpAngle = (a: number, b: number, t: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

/** Server time at which other players are drawn now; frames carry it as `viewTime`. */
export function renderTime(buffer: readonly Buffered[], now: number): number | null {
  const newest = buffer[buffer.length - 1];
  if (!newest) return null;
  return newest.world.serverTime + Math.min(INTERPOLATION_DELAY_MS, now - newest.received) - INTERPOLATION_DELAY_MS;
}

/** A player between the two snapshots around the render time. Missing, dead, teleporting or
 * malformed intervals return the given state itself, unchanged. */
export function interpolatePlayer<T extends PublicPlayerState>(buffer: readonly Buffered[], player: T, now: number): T {
  if (buffer.length < 2) return player;
  const target = renderTime(buffer, now)!;
  let previous = buffer[0]!.world; let next = buffer[buffer.length - 1]!.world;
  for (let i = 1; i < buffer.length; i++) {
    if (buffer[i]!.world.serverTime >= target) { previous = buffer[i - 1]!.world; next = buffer[i]!.world; break; }
  }
  const a = previous.players.find(item => item.id === player.id); const b = next.players.find(item => item.id === player.id);
  if (!a || !b || a.health <= 0 || b.health <= 0 || Math.hypot(a.x - b.x, a.z - b.z) > 5) return player;
  const interval = next.serverTime - previous.serverTime;
  if (interval <= 0 || ![target, interval, a.x, a.y, a.z, b.x, b.y, b.z].every(Number.isFinite)) return player;
  const blend = THREE.MathUtils.clamp((target - previous.serverTime) / interval, 0, 1);
  const pose = blend < 0.5 ? a : b;
  return { ...player, x: THREE.MathUtils.lerp(a.x, b.x, blend), y: THREE.MathUtils.lerp(a.y, b.y, blend), z: THREE.MathUtils.lerp(a.z, b.z, blend),
    yaw: lerpAngle(a.yaw, b.yaw, blend), pitch: THREE.MathUtils.lerp(a.pitch, b.pitch, blend), posture: pose.posture ?? player.posture };
}

/** Team deathmatch shows blue friends and red enemies; free-for-all keeps each player's colour. */
export function accentColor(player: { color: string; team?: Team }, localTeam: Team | undefined, mode: GameMode): string {
  if (mode !== 'tdm' || !localTeam || !player.team) return player.color;
  return player.team === localTeam ? FRIENDLY_COLOR : ENEMY_COLOR;
}
export const isFriend = (player: { team?: Team }, localTeam: Team | undefined, mode: GameMode) => mode === 'tdm' && !!localTeam && player.team === localTeam;

/** The enemy whose hitboxes the crosshair ray meets first with a clear line of sight. */
export function crosshairEnemy(origin: Vec3, direction: Vec3, players: Iterable<Pick<PublicPlayerState, 'id' | 'x' | 'y' | 'z' | 'posture' | 'health' | 'connected'> & { team?: Team }>,
  localId: string, localTeam: Team | undefined, mode: GameMode, range = 120): string | null {
  let best: { id: string; distance: number } | null = null;
  for (const player of players) {
    if (player.id === localId || player.health <= 0 || !player.connected || isFriend(player, localTeam, mode)) continue;
    const hit = rayHitboxes(origin, direction, { x: player.x, y: player.y, z: player.z, posture: player.posture ?? 'stand' }, best?.distance ?? range);
    if (hit && hit.distance < (best?.distance ?? range)) best = { id: player.id, distance: hit.distance };
  }
  if (!best || raycastMap(origin, direction, best.distance) < best.distance - 0.05) return null;
  return best.id;
}

/** Footstep loudness heard by others: Quiet Step at 0.3, and quieter when crouched or aiming. */
export function footstepLoudness(player: Pick<PublicPlayerState, 'posture' | 'loadout' | 'sprinting' | 'dashing' | 'aiming'>): number {
  const quiet = player.loadout && hasPerk(player.loadout, 'quiet-step') ? 0.3 : 1;
  const gait = player.posture === 'crouch' ? 0.45 : player.dashing ? 1.15 : player.sprinting ? 1 : player.aiming ? 0.6 : 0.75;
  return quiet * gait;
}

export interface RemoteSounds {
  footstep(surface: SurfaceKind, position: Vec3, loudness: number): void;
  land(position: Vec3, intensity: number): void;
  slide(position: Vec3): void;
  vault(position: Vec3): void;
}
export interface RemoteFrame {
  /** performance.now() and the server time of the newest snapshot extrapolated to now. */
  now: number; serverNow: number;
  /** Seconds since the previous frame: unclamped (`elapsed`) and clamped (`dt`). */
  elapsed: number; dt: number;
  localId: string; localTeam?: Team; mode: GameMode;
  camera: THREE.PerspectiveCamera; width: number; height: number;
  buffer: readonly Buffered[]; players: readonly PublicPlayerState[];
  library: WeaponLibrary | null; sunVisibility: SunVisibilityGrid | null;
  sounds: RemoteSounds | null;
}
interface RemoteEntry {
  model: CharacterModel; label: HTMLDivElement; shadow: THREE.Mesh;
  position: THREE.Vector3; locomotion: LocomotionVelocity; stride: Stride;
  weapon: WeaponInstance | null; weaponId: WeaponId | null;
  state: PublicPlayerState; posture: Posture; landing: LandingFilter; shots: number;
}

/** Other players as full operator bodies: interpolated, team-coloured, armed and labelled.
 * Friendly names always show; an enemy name shows only under the crosshair. No health bars. */
export class RemotePlayers {
  readonly entries = new Map<string, RemoteEntry>();
  private readonly shadowGeometry = new THREE.PlaneGeometry(1.45, 1.45);
  private readonly shadowMaterial = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: 'varying vec2 vUv;void main(){float a=pow(max(0.,1.-length(vUv-.5)*2.),2.)*.32;gl_FragColor=vec4(.08,.09,.08,a);}',
  });
  private readonly direction = new THREE.Vector3();
  private readonly projected = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  private disposed = false;

  constructor(private readonly scene: THREE.Scene, private readonly labels: HTMLElement, private readonly onError?: (message: string) => void,
    private readonly onReady?: () => void) {}

  rendered(id: string): PublicPlayerState | undefined { return this.entries.get(id)?.state; }
  position(id: string): THREE.Vector3 | undefined { return this.entries.get(id)?.position; }
  /** World-space muzzle of the player's drawn weapon. */
  muzzle(id: string, target: THREE.Vector3): boolean {
    const entry = this.entries.get(id);
    if (!entry?.model.root.visible) return false;
    (entry.weapon?.anchors.muzzle ?? entry.model.muzzle).getWorldPosition(target);
    return true;
  }
  eject(id: string, target: THREE.Vector3): boolean {
    const entry = this.entries.get(id);
    if (!entry?.weapon || !entry.model.root.visible) return false;
    entry.weapon.anchors.eject.getWorldPosition(target);
    return true;
  }
  recoil(id: string) { this.entries.get(id)?.model.recoil(); }
  impact(id: string, kind: CharacterImpactKind) { this.entries.get(id)?.model.impact(kind); }
  /** Tracers on the first shot of a stream and every third round after it. */
  nextTracer(id: string, pellets: boolean): boolean {
    const entry = this.entries.get(id);
    if (!entry) return true;
    return pellets || entry.shots++ % 3 === 0;
  }
  resetMotion() { for (const entry of this.entries.values()) { entry.locomotion.reset(); entry.shots = 0; entry.landing.reset(); } }
  /** Another player's confirmed shot from their drawn weapon: body recoil, muzzle-side effects with a
   * tracer on the first and every third round (every pellet for shotguns), and a shell when close.
   * Returns the muzzle used, for positioned sound. */
  presentShot(event: Extract<GameEvent, { type: 'shot' }>, effects: Pick<CombatEffects, 'shot' | 'shell'>, listener: THREE.Vector3): THREE.Vector3 {
    const muzzle = new THREE.Vector3();
    if (!this.muzzle(event.playerId, muzzle)) muzzle.set(event.from.x, event.from.y, event.from.z);
    this.recoil(event.playerId);
    const pellets = event.weapon !== 'drone' && (WEAPONS[event.weapon]?.pellets ?? 1) > 1;
    effects.shot(event, muzzle, { local: false, tracer: this.nextTracer(event.playerId, pellets) });
    const shooter = this.rendered(event.playerId);
    if (shooter && event.weapon !== 'drone' && muzzle.distanceTo(listener) < 25 && this.eject(event.playerId, this.scratch)) {
      effects.shell(this.scratch.clone(), new THREE.Vector3(Math.cos(shooter.yaw) * 1.6, 1.4, Math.sin(shooter.yaw) * 1.6), event.weapon);
    }
    return muzzle;
  }

  update(frame: RemoteFrame) {
    if (this.disposed) return;
    const present = new Set<string>();
    frame.camera.getWorldDirection(this.direction);
    const target = crosshairEnemy(frame.camera.position, this.direction, frame.players.map(player => this.entries.get(player.id)?.state ?? player),
      frame.localId, frame.localTeam, frame.mode);
    for (const state of frame.players) {
      if (state.id === frame.localId) continue;
      present.add(state.id);
      const entry = this.entries.get(state.id) ?? this.add(state);
      const rendered = interpolatePlayer(frame.buffer, state, frame.now);
      entry.state = rendered;
      entry.position.set(rendered.x, rendered.y, rendered.z);
      entry.model.root.position.copy(entry.position); entry.model.root.rotation.y = -rendered.yaw;
      entry.model.setAccent(accentColor(state, frame.localTeam, frame.mode));
      this.arm(entry, rendered.weapon, frame.library);
      const velocity = entry.locomotion.update(rendered, frame.elapsed, 'remote');
      const grounded = isPlayerGrounded(rendered);
      entry.model.update({ ...rendered, vx: velocity.vx, vz: velocity.vz }, frame.dt, frame.serverNow, false, { aim: rendered.aiming ?? false, grounded });
      this.sound(entry, rendered, velocity, grounded, frame);
      const alive = rendered.health > 0 && rendered.connected;
      entry.shadow.visible = alive;
      const floor = supportHeight(rendered);
      entry.shadow.position.set(rendered.x, floor + 0.018, rendered.z);
      entry.shadow.scale.setScalar(Math.max(0.5, 1 - (rendered.y - floor) * 0.16));
      if (frame.sunVisibility) entry.model.sunVisibility.value = frame.sunVisibility.sample(rendered.x, rendered.z, rendered.y);
      this.label(entry, rendered, alive && (isFriend(state, frame.localTeam, frame.mode) || target === state.id), frame);
    }
    for (const [id, entry] of this.entries) if (!present.has(id)) this.remove(id, entry);
  }

  private add(player: PublicPlayerState): RemoteEntry {
    const model = createBlenderCharacter(player.color, this.onReady, message => this.onError?.(message));
    this.scene.add(model.root);
    const label = document.createElement('div');
    label.style.cssText = 'position:absolute;left:0;top:0;transform:translate(-50%,-100%);color:#fff;font:700 11px system-ui,sans-serif;letter-spacing:.04em;text-shadow:0 1px 3px #0b0d0c;white-space:nowrap;will-change:left,top;padding:2px 7px;border-radius:3px;display:none;';
    label.textContent = player.name;
    this.labels.append(label);
    const shadow = new THREE.Mesh(this.shadowGeometry, this.shadowMaterial); shadow.rotation.x = -Math.PI / 2; shadow.renderOrder = 1; this.scene.add(shadow);
    const entry: RemoteEntry = {
      model, label, shadow, position: new THREE.Vector3(player.x, player.y, player.z), locomotion: new LocomotionVelocity(), stride: new Stride(),
      weapon: null, weaponId: null, state: player, posture: player.posture ?? 'stand', landing: new LandingFilter(), shots: 0,
    };
    this.entries.set(player.id, entry);
    return entry;
  }

  /** The drawn weapon follows the player's equipped weapon, with its grip on the hand socket. */
  private arm(entry: RemoteEntry, weapon: WeaponId, library: WeaponLibrary | null) {
    if (!library || entry.weaponId === weapon || !weapon) return;
    entry.weapon?.root.removeFromParent();
    try {
      const instance = library.weapon(weapon, 'world');
      instance.root.updateMatrixWorld(true);
      const grip = instance.root.worldToLocal(instance.anchors.gripRight.getWorldPosition(this.scratch));
      instance.root.position.sub(grip);
      instance.root.traverse(object => { if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; } });
      entry.model.weaponSocket.add(instance.root);
      entry.weapon = instance; entry.weaponId = weapon;
    } catch { entry.weapon = null; entry.weaponId = weapon; }
  }

  private sound(entry: RemoteEntry, rendered: PublicPlayerState, velocity: { vx: number; vz: number }, grounded: boolean, frame: RemoteFrame) {
    const posture = rendered.posture ?? 'stand';
    const near = !!frame.sounds && entry.position.distanceTo(frame.camera.position) < HEARING_METERS && rendered.health > 0 && rendered.connected;
    if (posture !== entry.posture && near) {
      if (posture === 'slide') frame.sounds!.slide(rendered);
      if (posture === 'vault') frame.sounds!.vault(rendered);
    }
    entry.posture = posture;
    // Jumps, vault drops and real falls thump; running down stairs does not.
    const landed = entry.landing.observe(grounded, rendered.vy, posture);
    if (landed > 0 && near) frame.sounds!.land(rendered, landed);
    const speed = Math.hypot(velocity.vx, velocity.vz);
    const step = entry.stride.update(speed, Math.min(0.1, frame.elapsed), stepLength(posture, !!rendered.sprinting, !!rendered.dashing), grounded && posture !== 'slide' && posture !== 'vault');
    if (step && near) frame.sounds!.footstep(surfaceAt(rendered), { x: rendered.x, y: rendered.y, z: rendered.z }, footstepLoudness(rendered));
  }

  private label(entry: RemoteEntry, rendered: PublicPlayerState, wanted: boolean, frame: RemoteFrame) {
    if (!wanted) { if (entry.label.style.display !== 'none') entry.label.style.display = 'none'; return; }
    const friend = isFriend(rendered, frame.localTeam, frame.mode);
    const projected = this.projected.set(rendered.x, rendered.y + (rendered.posture === 'stand' ? 2.05 : 1.5), rendered.z).project(frame.camera);
    const visible = projected.z > -1 && projected.z < 1 && Math.abs(projected.x) < 1.1 && Math.abs(projected.y) < 1.1;
    entry.label.style.display = visible ? 'block' : 'none';
    if (!visible) return;
    const accent = accentColor(rendered, frame.localTeam, frame.mode);
    entry.label.style.background = friend ? '#0e2436b8' : '#2a1412b8';
    entry.label.style.borderBottom = `2px solid ${accent}`;
    entry.label.style.left = `${(projected.x * 0.5 + 0.5) * frame.width}px`;
    entry.label.style.top = `${(-projected.y * 0.5 + 0.5) * frame.height}px`;
  }

  private remove(id: string, entry: RemoteEntry) {
    entry.weapon?.root.removeFromParent();
    this.scene.remove(entry.model.root, entry.shadow); entry.model.dispose(); entry.label.remove(); this.entries.delete(id);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const [id, entry] of this.entries) this.remove(id, entry);
    this.shadowGeometry.dispose(); this.shadowMaterial.dispose();
  }
}
