import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RULES, type DroneState, type Team, type Vec3 } from '../../../shared/protocol';
import type { EffectRandom } from './random';

/** Who is watching, so a drone's light reads as friend (blue) or foe (red). */
export interface DroneViewer { playerId: string; team?: Team }
/** Drones are drawn this far behind the newest snapshot, so there are two samples to blend between. */
export const DRONE_DELAY_MS = 100;
/** Past the newest snapshot a drone keeps going on its last heading for at most this long. */
export const DRONE_EXTRAPOLATION_MS = 150;
const SAMPLES = 4, ROTOR_REACH = 0.354, ROTOR_SPEED = 70;
const FRIEND = new THREE.Color('#4aa3ff'), FOE = new THREE.Color('#ff5a4f');
/** End of the gun barrel under the nose, in drone space (the model faces -Z). */
const GUN_TIP = new THREE.Vector3(0, -0.1, -0.43);

export interface DroneHooks {
  /** A damaged drone trails smoke from here (called about ten times a second). */
  smoke(position: THREE.Vector3): void;
  /** The beacon's glow this frame. */
  beacon(position: THREE.Vector3, color: THREE.Color, size: number, opacity: number): void;
}

interface Sample { t: number; x: number; y: number; z: number; yaw: number }
interface DroneParts {
  frame: THREE.BufferGeometry; frameMaterial: THREE.MeshStandardMaterial;
  blades: THREE.BufferGeometry; bladeMaterial: THREE.MeshStandardMaterial;
  disc: THREE.BufferGeometry; discMaterial: THREE.MeshBasicMaterial;
  beacon: THREE.BufferGeometry; friend: THREE.MeshBasicMaterial; foe: THREE.MeshBasicMaterial;
}

function colored(geometry: THREE.BufferGeometry, hex: string) {
  const color = new THREE.Color(hex), count = geometry.getAttribute('position').count, data = new Float32Array(count * 3);
  for (let index = 0; index < count; index++) { data[index * 3] = color.r; data[index * 3 + 1] = color.g; data[index * 3 + 2] = color.b; }
  geometry.setAttribute('color', new THREE.BufferAttribute(data, 3));
  return geometry;
}
const merged = (pieces: THREE.BufferGeometry[]) => {
  const result = mergeGeometries(pieces) ?? pieces[0].clone();
  for (const piece of pieces) piece.dispose();
  return result;
};
const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1]] as const;

/** An original quadcopter, about 1.1 m across (the drone hit box is 1.2 m): body, arms, motors, a gun pod
 * at the front, skids, four rotors with a blur disc, and a beacon at the back. */
function buildParts(): DroneParts {
  const frame = merged([
    colored(new THREE.BoxGeometry(0.34, 0.12, 0.46), '#2b2f32'),
    colored(new THREE.BoxGeometry(0.26, 0.05, 0.3).translate(0, 0.085, 0.02), '#3a3f43'),
    colored(new THREE.BoxGeometry(1, 0.035, 0.05).rotateY(Math.PI / 4), '#202326'),
    colored(new THREE.BoxGeometry(1, 0.035, 0.05).rotateY(-Math.PI / 4), '#202326'),
    ...corners.map(([x, z]) => colored(new THREE.CylinderGeometry(0.035, 0.04, 0.06, 10).translate(x * ROTOR_REACH, 0.035, z * ROTOR_REACH), '#17191b')),
    colored(new THREE.SphereGeometry(0.065, 12, 8).translate(0, -0.09, -0.2), '#141618'),
    colored(new THREE.CylinderGeometry(0.012, 0.012, 0.2, 8).rotateX(Math.PI / 2).translate(0, -0.1, -0.33), '#0f1011'),
    ...[-1, 1].map(side => colored(new THREE.BoxGeometry(0.03, 0.03, 0.5).translate(side * 0.13, -0.17, 0), '#25282a')),
    ...corners.map(([x, z]) => colored(new THREE.BoxGeometry(0.02, 0.1, 0.02).translate(x * 0.13, -0.11, z * 0.15), '#25282a')),
  ]);
  const blades = merged([new THREE.BoxGeometry(0.36, 0.006, 0.03), new THREE.BoxGeometry(0.03, 0.006, 0.36)]);
  return {
    frame, frameMaterial: new THREE.MeshStandardMaterial({ name: 'combat-drone', vertexColors: true, roughness: 0.55, metalness: 0.35 }),
    blades, bladeMaterial: new THREE.MeshStandardMaterial({ name: 'combat-drone-blades', color: '#1d1f21', roughness: 0.6, metalness: 0.2 }),
    disc: new THREE.CircleGeometry(0.19, 24).rotateX(-Math.PI / 2).translate(0, 0.004, 0),
    discMaterial: new THREE.MeshBasicMaterial({ name: 'combat-drone-rotor-blur', color: '#1c1d1f', transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }),
    beacon: new THREE.SphereGeometry(0.03, 8, 6),
    friend: new THREE.MeshBasicMaterial({ name: 'combat-drone-friend', color: FRIEND, toneMapped: false }),
    foe: new THREE.MeshBasicMaterial({ name: 'combat-drone-foe', color: FOE, toneMapped: false }),
  };
}

class DroneSlot {
  id = ''; active = false; seen = false; friendly = false; health: number = RULES.droneHealth;
  readonly samples: Sample[] = Array.from({ length: SAMPLES }, () => ({ t: 0, x: 0, y: 0, z: 0, yaw: 0 }));
  count = 0; spin = 0; blink = 0; smokeTimer = 0; roll = 0; pitch = 0;
  readonly rotors: THREE.Object3D[] = [];
  readonly light = new THREE.Vector3();
  constructor(readonly model: THREE.Group, readonly beacon: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>) {}
}

const pose = { x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0, turn: 0 };
/** Blends the two samples around `time`, or carries on briefly past the newest one. */
function samplePose(slot: DroneSlot, time: number) {
  const samples = slot.samples, count = slot.count, first = samples[0];
  if (count === 1 || time <= first.t) {
    pose.x = first.x; pose.y = first.y; pose.z = first.z; pose.yaw = first.yaw; pose.vx = pose.vz = pose.turn = 0;
    return;
  }
  let index = 1;
  while (index < count - 1 && samples[index].t < time) index++;
  const a = samples[index - 1], b = samples[index], span = Math.max(1, b.t - a.t);
  let blend = (time - a.t) / span;
  if (blend > 1) blend = 1 + Math.min(time - b.t, DRONE_EXTRAPOLATION_MS) / span;
  const turn = Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw)), seconds = span / 1000;
  pose.x = a.x + (b.x - a.x) * blend; pose.y = a.y + (b.y - a.y) * blend; pose.z = a.z + (b.z - a.z) * blend;
  pose.yaw = a.yaw + turn * blend;
  pose.vx = (b.x - a.x) / seconds; pose.vz = (b.z - a.z) / seconds; pose.turn = turn / seconds;
}

/** Attack drones from snapshots: pooled models, drawn a little in the past and blended between
 * snapshots so they glide at any frame rate, banking into their orbit with spinning rotors. */
export class DroneFleet {
  readonly root = new THREE.Group();
  private readonly slots: DroneSlot[] = [];
  private parts: DroneParts | null = null;
  private clock = 0;
  private clockValid = false;

  constructor(readonly capacity: number, private readonly random: EffectRandom) { this.root.name = 'combat-drones'; }

  get active() { let count = 0; for (const slot of this.slots) if (slot.active) count++; return count; }

  set(drones: readonly DroneState[] | null | undefined, serverTime: number, viewer?: DroneViewer) {
    if (!Number.isFinite(serverTime)) return;
    // The clock never runs backwards for a late packet, and snaps after a long gap.
    if (!this.clockValid || Math.abs(serverTime - this.clock) > 1000) { this.clock = serverTime; this.clockValid = true; }
    else if (serverTime > this.clock) this.clock = serverTime;
    const slots = this.slots;
    for (let index = 0; index < slots.length; index++) slots[index].seen = false;
    if (Array.isArray(drones)) {
      for (let index = 0; index < drones.length; index++) {
        const drone = drones[index];
        if (!drone || typeof drone.id !== 'string' || !(Number.isFinite(drone.x) && Number.isFinite(drone.y) && Number.isFinite(drone.z) && Number.isFinite(drone.yaw))) continue;
        const slot = this.acquire(drone.id);
        if (!slot) continue;
        slot.seen = true;
        slot.health = Number.isFinite(drone.health) ? drone.health : RULES.droneHealth;
        slot.friendly = !!viewer && (drone.ownerId === viewer.playerId || (!!drone.team && drone.team === viewer.team));
        slot.beacon.material = slot.friendly ? this.parts!.friend : this.parts!.foe;
        this.record(slot, serverTime, drone);
      }
    }
    for (let index = 0; index < slots.length; index++) if (slots[index].active && !slots[index].seen) this.release(slots[index]);
  }

  private record(slot: DroneSlot, time: number, drone: DroneState) {
    const samples = slot.samples, count = slot.count;
    if (count && time < samples[count - 1].t) return;
    let sample: Sample;
    if (count && time === samples[count - 1].t) sample = samples[count - 1];
    else if (count < SAMPLES) sample = samples[slot.count++];
    else { sample = samples.shift()!; samples.push(sample); }
    sample.t = time; sample.x = drone.x; sample.y = drone.y; sample.z = drone.z; sample.yaw = drone.yaw;
  }

  private acquire(id: string): DroneSlot | null {
    let free: DroneSlot | null = null;
    for (let index = 0; index < this.slots.length; index++) {
      const slot = this.slots[index];
      if (slot.active && slot.id === id) return slot;
      if (!slot.active && !free) free = slot;
    }
    if (!free && this.slots.length < this.capacity) free = this.create();
    if (!free) return null;
    free.id = id; free.active = true; free.count = 0; free.smokeTimer = 0; free.roll = free.pitch = 0;
    free.spin = this.random.range(0, Math.PI * 2); free.blink = this.random.next();
    return free;
  }

  private create() {
    const parts = (this.parts ??= buildParts());
    const model = new THREE.Group();
    model.name = 'drone'; model.visible = false;
    const frame = new THREE.Mesh(parts.frame, parts.frameMaterial);
    frame.name = 'drone-frame';
    model.add(frame);
    const beacon = new THREE.Mesh(parts.beacon, parts.foe);
    beacon.name = 'drone-beacon'; beacon.position.set(0, 0.11, 0.2);
    const slot = new DroneSlot(model, beacon);
    for (const [x, z] of corners) {
      const rotor = new THREE.Group();
      rotor.name = 'drone-rotor'; rotor.position.set(x * ROTOR_REACH, 0.07, z * ROTOR_REACH);
      rotor.add(new THREE.Mesh(parts.blades, parts.bladeMaterial), new THREE.Mesh(parts.disc, parts.discMaterial));
      model.add(rotor); slot.rotors.push(rotor);
    }
    model.add(beacon);
    this.root.add(model);
    this.slots.push(slot);
    return slot;
  }

  /** The drawn gun tip of the drone nearest `point` (within 3 m). Drone shot events carry no drone id,
   * so this keeps their muzzle flash on the drone the player can see. */
  muzzleNear(point: Vec3, target: THREE.Vector3): boolean {
    let best: DroneSlot | null = null, closest = 9;
    for (let index = 0; index < this.slots.length; index++) {
      const slot = this.slots[index], at = slot.model.position;
      if (!slot.active || !slot.model.visible) continue;
      const distance = (at.x - point.x) ** 2 + (at.y - point.y) ** 2 + (at.z - point.z) ** 2;
      if (distance < closest) { closest = distance; best = slot; }
    }
    if (!best) return false;
    best.model.updateWorldMatrix(true, false);
    target.copy(GUN_TIP).applyMatrix4(best.model.matrixWorld);
    return true;
  }

  /** Builds the shared parts and one hidden pooled model, so shaders can be compiled before a drone flies. */
  prepare() { if (!this.slots.length && this.capacity > 0) this.create(); }

  private release(slot: DroneSlot) { slot.active = false; slot.id = ''; slot.count = 0; slot.model.visible = false; }

  update(dt: number, hooks: DroneHooks) {
    if (this.clockValid) this.clock += dt * 1000;
    const time = this.clock - DRONE_DELAY_MS, ease = 1 - Math.exp(-dt * 4);
    for (let index = 0; index < this.slots.length; index++) {
      const slot = this.slots[index];
      if (!slot.active || !slot.count) continue;
      samplePose(slot, time);
      const model = slot.model, speed = Math.hypot(pose.vx, pose.vz);
      model.visible = true;
      model.position.set(pose.x, pose.y, pose.z);
      // Nose down with speed and bank into the turn, eased so snapshot steps never jolt.
      slot.pitch += (Math.min(0.22, speed * 0.025) - slot.pitch) * ease;
      slot.roll += (Math.max(-0.35, Math.min(0.35, -pose.turn * speed * 0.06)) - slot.roll) * ease;
      model.rotation.set(-slot.pitch, -pose.yaw, slot.roll, 'YXZ');
      slot.spin = (slot.spin + dt * ROTOR_SPEED) % (Math.PI * 2);
      for (let rotor = 0; rotor < slot.rotors.length; rotor++) slot.rotors[rotor].rotation.y = rotor % 2 ? -slot.spin : slot.spin;
      slot.blink = (slot.blink + dt) % 1;
      const lit = slot.blink < 0.14;
      slot.beacon.visible = lit;
      slot.beacon.getWorldPosition(slot.light);
      hooks.beacon(slot.light, slot.friendly ? FRIEND : FOE, lit ? 0.55 : 0.2, lit ? 0.95 : 0.35);
      if (slot.health <= RULES.droneHealth / 2) {
        slot.smokeTimer -= dt;
        for (let puffs = 0; slot.smokeTimer <= 0 && puffs < 3; puffs++) { slot.smokeTimer += 0.1; hooks.smoke(model.position); }
        if (slot.smokeTimer <= 0) slot.smokeTimer = 0.1;
      }
    }
  }

  clear() { for (const slot of this.slots) this.release(slot); this.clockValid = false; }

  dispose() {
    this.clear();
    const parts = this.parts;
    if (parts) {
      for (const geometry of [parts.frame, parts.blades, parts.disc, parts.beacon]) geometry.dispose();
      for (const material of [parts.frameMaterial, parts.bladeMaterial, parts.discMaterial, parts.friend, parts.foe]) material.dispose();
    }
    this.parts = null;
    this.slots.length = 0;
    this.root.clear();
    this.root.removeFromParent();
  }
}
