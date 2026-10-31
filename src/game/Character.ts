import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Posture, PublicPlayerState } from '../../shared/protocol';
import { createAccentImpact, type CharacterImpactKind } from './CharacterImpact';

const geometryCache = new Map<string, THREE.BufferGeometry>();
function rounded(w: number, h: number, d: number, radius = 0.035) {
  const key = `${w}:${h}:${d}:${radius}`;
  if (!geometryCache.has(key)) geometryCache.set(key, new RoundedBoxGeometry(w, h, d, 2, Math.min(radius, w / 3, h / 3, d / 3)));
  return geometryCache.get(key)!;
}
const sphere = new THREE.SphereGeometry(1, 16, 12);
const cylinder = new THREE.CylinderGeometry(1, 1, 1, 12);
const dark = new THREE.MeshStandardMaterial({ color: '#2b2f2a', roughness: 0.82, metalness: 0.1 });
const rubber = new THREE.MeshStandardMaterial({ color: '#1b1d1a', roughness: 0.94 });
const armor = new THREE.MeshStandardMaterial({ color: '#4b4e40', roughness: 0.7, metalness: 0.12 });
const steel = new THREE.MeshStandardMaterial({ color: '#3f4447', roughness: 0.5, metalness: 0.6 });
const visor = new THREE.MeshStandardMaterial({ color: '#15191b', roughness: 0.35, metalness: 0.4 });

function box(parent: THREE.Object3D, material: THREE.Material, dimensions: number[], position: number[], radius?: number) {
  const mesh = new THREE.Mesh(rounded(dimensions[0], dimensions[1], dimensions[2], radius), material);
  mesh.position.set(position[0], position[1], position[2]);
  mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
}
function ball(parent: THREE.Object3D, material: THREE.Material, scale: number[], position: number[]) {
  const mesh = new THREE.Mesh(sphere, material); mesh.scale.set(scale[0], scale[1], scale[2]);
  mesh.position.set(position[0], position[1], position[2]); mesh.castShadow = true; parent.add(mesh); return mesh;
}
function tube(parent: THREE.Object3D, material: THREE.Material, radius: number, start: THREE.Vector3, end: THREE.Vector3) {
  const mesh = new THREE.Mesh(cylinder, material);
  const difference = end.clone().sub(start); mesh.position.copy(start).addScaledVector(difference, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), difference.clone().normalize());
  mesh.scale.set(radius, difference.length(), radius); mesh.castShadow = true; parent.add(mesh); return mesh;
}

/** Everything a drawn character reads from a snapshot. */
export type CharacterPose = Pick<PublicPlayerState, 'x' | 'y' | 'z' | 'vx' | 'vy' | 'vz' | 'yaw' | 'pitch' | 'health' | 'connected'
  | 'protectedUntil' | 'reloadingUntil' | 'posture' | 'weapon' | 'slot'> & Partial<Pick<PublicPlayerState, 'vault' | 'aiming' | 'sprinting'>>;
export interface CharacterMotion { aim: boolean; grounded: boolean }
export interface CharacterModel {
  root: THREE.Group;
  update(player: CharacterPose, dt: number, time: number, local: boolean, motion?: CharacterMotion): void;
  /** Fallback muzzle point when no world weapon is attached. */
  muzzle: THREE.Object3D;
  /** World weapons attach here: the operator's `weapon_socket`, otherwise the right hand. */
  weaponSocket: THREE.Object3D;
  /** Direct-sun scale for this character, sampled from the sun-visibility grid each frame. */
  sunVisibility: { value: number };
  /** Team or player colour on the accent material (armband, patches). */
  setAccent(color: string): void;
  recoil(): void;
  impact(kind: CharacterImpactKind): void;
  dispose(): void;
}
/** How far the body sinks for a posture; the collision heights are 1.8 / 1.25 / 1.0 / 1.25 m. */
export const POSTURE_DROP: Readonly<Record<Posture, number>> = { stand: 0, crouch: 0.42, slide: 0.62, vault: 0.3 };

/** Plain tactical stand-in shown only while the operator model loads. */
export function createCharacter(color: string): CharacterModel {
  const accent = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1 });
  const impactEffect = createAccentImpact(accent);
  const sunVisibility = { value: 1 };
  let disposed = false;
  const root = new THREE.Group();
  const body = new THREE.Group(); root.add(body);
  const hips = new THREE.Group(); hips.position.y = 0.88; body.add(hips);
  box(hips, dark, [0.43, 0.24, 0.29], [0, 0.03, 0]);
  box(hips, armor, [0.46, 0.08, 0.33], [0, 0.11, 0]);
  const legs: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const leg = new THREE.Group(); leg.position.set(side * 0.14, 0.86, 0); root.add(leg); legs.push(leg);
    box(leg, dark, [0.19, 0.42, 0.21], [0, -0.22, 0]);
    box(leg, armor, [0.2, 0.12, 0.1], [0, -0.43, -0.09]);
    box(leg, dark, [0.17, 0.33, 0.19], [0, -0.6, 0.02]);
    box(leg, rubber, [0.2, 0.14, 0.32], [0, -0.79, -0.04]);
  }
  const torso = new THREE.Group(); torso.position.y = 1.2; body.add(torso);
  box(torso, dark, [0.47, 0.47, 0.29], [0, 0, 0]);
  box(torso, armor, [0.5, 0.38, 0.12], [0, 0.02, -0.17]);
  box(torso, armor, [0.48, 0.38, 0.1], [0, 0.02, 0.17]);
  box(torso, accent, [0.12, 0.08, 0.02], [-0.16, 0.12, -0.235], 0.006);
  for (const side of [-1, 1]) {
    const shoulder = ball(torso, dark, [0.15, 0.14, 0.16], [side * 0.29, 0.14, -0.01]);
    shoulder.rotation.z = -side * 0.25;
    box(torso, accent, [0.04, 0.09, 0.12], [side * 0.34, 0.06, -0.01], 0.008);
  }
  const arms = new THREE.Group(); torso.add(arms);
  tube(arms, dark, 0.07, new THREE.Vector3(0.29, 0.085, -0.04), new THREE.Vector3(0.3, -0.17, -0.2));
  tube(arms, dark, 0.065, new THREE.Vector3(0.3, -0.17, -0.2), new THREE.Vector3(0.23, -0.03, -0.4));
  tube(arms, dark, 0.07, new THREE.Vector3(-0.29, 0.085, -0.04), new THREE.Vector3(-0.26, -0.19, -0.22));
  tube(arms, dark, 0.065, new THREE.Vector3(-0.26, -0.19, -0.22), new THREE.Vector3(0.17, -0.05, -0.58));
  ball(arms, rubber, [0.07, 0.07, 0.09], [0.23, -0.02, -0.41]);
  ball(arms, rubber, [0.07, 0.07, 0.09], [0.17, -0.045, -0.59]);
  const head = new THREE.Group(); head.position.set(0, 1.58, 0); body.add(head);
  ball(head, rubber, [0.12, 0.12, 0.12], [0, -0.13, 0]);
  ball(head, armor, [0.2, 0.17, 0.21], [0, 0.04, 0.01]);
  box(head, visor, [0.2, 0.06, 0.05], [0, -0.01, -0.17], 0.02);
  box(head, steel, [0.08, 0.04, 0.05], [0, 0.17, -0.12], 0.01);
  const weaponSocket = new THREE.Group(); weaponSocket.name = 'weapon_socket'; weaponSocket.position.set(0.23, -0.02, -0.41); arms.add(weaponSocket);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.03, -0.65); weaponSocket.add(muzzle);
  const protectionMaterial = new THREE.MeshBasicMaterial({ color: '#d8e6ea', transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false });
  const protection = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), protectionMaterial);
  protection.position.y = 0.97; protection.scale.set(0.75, 1.07, 0.75); root.add(protection);
  let kick = 0; let cycle = Math.random() * Math.PI * 2;
  return {
    root, muzzle, weaponSocket, sunVisibility,
    setAccent(next) { if (!disposed) accent.color.set(next); },
    recoil() { kick = 1; },
    impact(kind) { impactEffect.impact(kind); },
    update(player, dt, time) {
      if (disposed) return;
      impactEffect.update(player);
      const speed = Math.hypot(player.vx, player.vz);
      const moving = Math.min(speed / 6.5, 1.35);
      cycle += dt * speed * 1.75;
      kick *= Math.exp(-dt * 16);
      const grounded = Math.abs(player.vy) < 0.5;
      const drop = POSTURE_DROP[player.posture] ?? 0;
      legs[0].rotation.x = Math.sin(cycle) * 0.52 * moving * (grounded ? 1 : 0.15) - drop * 1.1;
      legs[1].rotation.x = player.posture === 'slide' ? -1.2 : -Math.sin(cycle) * 0.52 * moving * (grounded ? 1 : 0.15) - drop * 0.6;
      for (const leg of legs) leg.position.y = 0.86 - drop;
      body.position.y = -drop;
      hips.rotation.z = Math.cos(cycle) * 0.035 * moving;
      torso.rotation.x = player.pitch * 0.15 - moving * 0.025 + (player.posture === 'slide' ? -0.45 : player.posture === 'crouch' ? 0.2 : 0);
      arms.rotation.x = player.pitch * 0.82 + kick * 0.10;
      head.rotation.x = player.pitch * 0.7;
      weaponSocket.position.z = -0.41 + kick * 0.06;
      if (player.reloadingUntil > time) { arms.rotation.z = -0.22 + Math.sin(time * 0.006) * 0.08; } else arms.rotation.z *= Math.exp(-dt * 10);
      protection.visible = player.protectedUntil > time && player.health > 0;
      root.visible = player.health > 0 && player.connected;
    },
    dispose() {
      if (disposed) return;
      disposed = true; impactEffect.dispose();
      accent.dispose(); protection.geometry.dispose(); protectionMaterial.dispose();
    },
  };
}

export function disposeCharacterResources() {
  for (const geometry of geometryCache.values()) geometry.dispose(); geometryCache.clear();
  // Materials/geometries are module-shared and will be re-uploaded by Three if another view starts.
  for (const material of [dark, rubber, armor, steel, visor]) material.dispose();
  sphere.dispose(); cylinder.dispose();
}
