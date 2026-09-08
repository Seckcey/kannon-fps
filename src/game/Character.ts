import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { PlayerState, Slot } from '../../shared/protocol';

const geometryCache = new Map<string, THREE.BufferGeometry>();
function rounded(w: number, h: number, d: number, radius = 0.035) {
  const key = `${w}:${h}:${d}:${radius}`;
  if (!geometryCache.has(key)) geometryCache.set(key, new RoundedBoxGeometry(w, h, d, 2, Math.min(radius, w / 3, h / 3, d / 3)));
  return geometryCache.get(key)!;
}
const sphere = new THREE.SphereGeometry(1, 16, 12);
const cylinder = new THREE.CylinderGeometry(1, 1, 1, 12);
const dark = new THREE.MeshStandardMaterial({ color: '#233a45', roughness: 0.72, metalness: 0.2 });
const rubber = new THREE.MeshStandardMaterial({ color: '#142731', roughness: 0.94 });
const armor = new THREE.MeshStandardMaterial({ color: '#e9e1c7', roughness: 0.56, metalness: 0.18 });
const steel = new THREE.MeshStandardMaterial({ color: '#627983', roughness: 0.45, metalness: 0.6 });
const visor = new THREE.MeshStandardMaterial({ color: '#093b48', emissive: '#076c80', emissiveIntensity: 0.23, metalness: 0.75, roughness: 0.17 });
const light = new THREE.MeshStandardMaterial({ color: '#aaffeb', emissive: '#41ffcb', emissiveIntensity: 1.5, roughness: 0.25 });

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

export interface CharacterModel {
  root: THREE.Group;
  update(player: PlayerState, dt: number, time: number, local: boolean, motion?: { aim: boolean; grounded: boolean }): void;
  muzzle: THREE.Object3D;
  recoil(): void;
  dispose(): void;
}

/** Original articulated scout armor, with separate joints rather than a rigid placeholder. */
export function createCharacter(color: string): CharacterModel {
  const accent = new THREE.MeshStandardMaterial({ color, roughness: 0.48, metalness: 0.25 });
  const root = new THREE.Group();
  const hips = new THREE.Group(); hips.position.y = 0.88; root.add(hips);
  box(hips, dark, [0.43, 0.24, 0.29], [0, 0.03, 0]);
  box(hips, armor, [0.48, 0.105, 0.35], [0, 0.095, 0]);
  box(hips, steel, [0.095, 0.09, 0.035], [0, 0.1, -0.185], 0.01);
  for (const side of [-1, 1]) box(hips, armor, [0.13, 0.21, 0.18], [side * 0.26, 0, 0.025]);
  const legs: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const leg = new THREE.Group(); leg.position.set(side * 0.14, 0.86, 0); root.add(leg); legs.push(leg);
    ball(leg, rubber, [0.105, 0.12, 0.105], [0, -0.04, 0]);
    box(leg, dark, [0.19, 0.34, 0.21], [0, -0.22, 0]);
    box(leg, armor, [0.195, 0.25, 0.085], [0, -0.2, -0.105]);
    box(leg, accent, [0.205, 0.12, 0.11], [0, -0.405, -0.09]);
    ball(leg, rubber, [0.1, 0.10, 0.10], [0, -0.42, 0]);
    box(leg, dark, [0.17, 0.29, 0.19], [0, -0.59, 0.025]);
    box(leg, armor, [0.17, 0.22, 0.075], [0, -0.58, -0.075]);
    box(leg, rubber, [0.22, 0.155, 0.34], [0, -0.775, -0.035]);
    box(leg, armor, [0.21, 0.065, 0.15], [0, -0.73, -0.13]);
    box(leg, steel, [0.23, 0.035, 0.345], [0, -0.835, -0.035], 0.008);
  }
  const torso = new THREE.Group(); torso.position.y = 1.2; root.add(torso);
  box(torso, dark, [0.49, 0.47, 0.31], [0, 0, 0]);
  box(torso, armor, [0.5, 0.30, 0.09], [0, 0.075, -0.18]);
  box(torso, armor, [0.34, 0.12, 0.075], [0, -0.13, -0.17]);
  box(torso, accent, [0.22, 0.052, 0.016], [-0.105, 0.125, -0.232], 0.006);
  box(torso, dark, [0.115, 0.085, 0.016], [0.145, 0.04, -0.235], 0.008);
  box(torso, light, [0.06, 0.018, 0.012], [0.145, 0.052, -0.248], 0.003);
  // Layered service pack and visible straps are important from the player's camera.
  box(torso, dark, [0.38, 0.46, 0.17], [0, 0.015, 0.205]);
  box(torso, armor, [0.35, 0.4, 0.09], [0, 0.025, 0.285]);
  box(torso, steel, [0.23, 0.245, 0.025], [0, 0.02, 0.343]);
  box(torso, accent, [0.23, 0.038, 0.014], [0, 0.11, 0.363], 0.005);
  for (const side of [-1, 1]) {
    box(torso, dark, [0.045, 0.43, 0.025], [side * 0.14, 0.04, 0.35], 0.008);
    box(torso, armor, [0.075, 0.07, 0.036], [side * 0.14, -0.07, 0.366], 0.008);
    const shoulder = ball(torso, accent, [0.185, 0.17, 0.195], [side * 0.305, 0.14, -0.015]);
    shoulder.rotation.z = -side * 0.25;
    box(torso, armor, [0.14, 0.06, 0.205], [side * 0.34, 0.065, -0.02]);
  }
  const arms = new THREE.Group(); torso.add(arms);
  tube(arms, dark, 0.082, new THREE.Vector3(0.30, 0.085, -0.04), new THREE.Vector3(0.31, -0.17, -0.20));
  tube(arms, armor, 0.094, new THREE.Vector3(0.31, -0.17, -0.20), new THREE.Vector3(0.235, -0.025, -0.40));
  ball(arms, accent, [0.105, 0.09, 0.11], [0.31, -0.17, -0.2]);
  tube(arms, dark, 0.082, new THREE.Vector3(-0.30, 0.085, -0.04), new THREE.Vector3(-0.27, -0.19, -0.22));
  tube(arms, armor, 0.092, new THREE.Vector3(-0.27, -0.19, -0.22), new THREE.Vector3(0.18, -0.045, -0.59));
  ball(arms, accent, [0.105, 0.09, 0.11], [-0.27, -0.19, -0.22]);
  ball(arms, rubber, [0.082, 0.08, 0.105], [0.23, -0.02, -0.41]);
  ball(arms, rubber, [0.085, 0.08, 0.105], [0.17, -0.045, -0.59]);
  const head = new THREE.Group(); head.position.set(0, 1.58, 0); root.add(head);
  ball(head, rubber, [0.13, 0.12, 0.13], [0, -0.14, 0]);
  ball(head, armor, [0.245, 0.242, 0.235], [0, 0, 0]);
  box(head, dark, [0.39, 0.155, 0.10], [0, -0.035, -0.205]);
  box(head, visor, [0.35, 0.112, 0.055], [0, -0.021, -0.26], 0.022);
  box(head, armor, [0.32, 0.063, 0.11], [0, -0.13, -0.205]);
  box(head, accent, [0.075, 0.03, 0.28], [0, 0.223, -0.025], 0.007);
  box(head, steel, [0.20, 0.07, 0.025], [0, 0.05, 0.231], 0.012);
  box(head, light, [0.105, 0.015, 0.012], [0, 0.05, 0.253], 0.003);
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(cylinder, dark); ear.rotation.z = Math.PI / 2;
    ear.position.set(side * 0.236, -0.025, 0.006); ear.scale.set(0.092, 0.045, 0.092); head.add(ear);
    const cap = new THREE.Mesh(cylinder, accent); cap.rotation.z = Math.PI / 2;
    cap.position.set(side * 0.265, -0.025, 0.006); cap.scale.set(0.065, 0.014, 0.065); head.add(cap);
  }
  const weaponMount = new THREE.Group(); weaponMount.position.set(0.23, -0.005, -0.37); arms.add(weaponMount);
  const weapons = new Map<Slot, THREE.Group>();
  for (const slot of [1, 2] as const) {
    const gun = new THREE.Group(); weapons.set(slot, gun); weaponMount.add(gun);
    box(gun, rubber, [0.10, 0.14, 0.16], [0, -0.08, 0.015]);
    box(gun, dark, [0.13, 0.15, slot === 1 ? 0.45 : 0.34], [0, 0, -0.16]);
    box(gun, armor, [0.145, 0.075, 0.24], [0, 0.005, -0.14]);
    box(gun, accent, [0.15, 0.026, 0.18], [0, 0.05, -0.11], 0.006);
    box(gun, dark, [0.09, 0.11, 0.23], [0, 0.015, 0.13]);
    box(gun, steel, [0.15, 0.17, 0.05], [0, 0.015, 0.265]);
    tube(gun, steel, slot === 1 ? 0.024 : 0.042, new THREE.Vector3(0, 0.022, -0.35), new THREE.Vector3(0, 0.022, -0.72));
    box(gun, rubber, [0.105, 0.09, 0.19], [0, -0.02, -0.40]);
    if (slot === 1) {
      const magazine = box(gun, dark, [0.07, 0.2, 0.10], [0, -0.13, -0.15]); magazine.rotation.x = -0.14;
      box(gun, dark, [0.055, 0.065, 0.12], [0, 0.115, -0.10], 0.01);
      box(gun, visor, [0.043, 0.028, 0.02], [0, 0.13, -0.037], 0.004);
    } else tube(gun, dark, 0.029, new THREE.Vector3(0, -0.06, -0.32), new THREE.Vector3(0, -0.06, -0.64));
  }
  const med = new THREE.Group(); weapons.set(3, med); weaponMount.add(med);
  box(med, armor, [0.20, 0.25, 0.14], [0, 0, -0.08]);
  box(med, light, [0.04, 0.145, 0.014], [0, 0, -0.159], 0.006);
  box(med, light, [0.12, 0.04, 0.014], [0, 0, -0.16], 0.006);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.022, -0.735); weaponMount.add(muzzle);
  const protectionMaterial = new THREE.MeshBasicMaterial({ color: '#70eafa', transparent: true, opacity: 0.11, side: THREE.DoubleSide, depthWrite: false });
  const protection = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), protectionMaterial);
  protection.position.y = 0.97; protection.scale.set(0.75, 1.07, 0.75); root.add(protection);
  let kick = 0; let cycle = Math.random() * Math.PI * 2;
  return {
    root, muzzle,
    recoil() { kick = 1; },
    update(player, dt, time, local) {
      const speed = Math.hypot(player.vx, player.vz);
      const moving = Math.min(speed / 6.5, 1.35);
      cycle += dt * speed * 1.75;
      kick *= Math.exp(-dt * 16);
      const grounded = Math.abs(player.vy) < 0.5;
      legs[0].rotation.x = Math.sin(cycle) * 0.52 * moving * (grounded ? 1 : 0.15);
      legs[1].rotation.x = -legs[0].rotation.x;
      hips.rotation.z = Math.cos(cycle) * 0.035 * moving;
      torso.position.y = 1.2 + (grounded ? Math.abs(Math.sin(cycle)) * 0.018 * moving : 0);
      torso.rotation.x = player.pitch * 0.15 - moving * 0.025;
      arms.rotation.x = player.pitch * 0.82 + kick * 0.10;
      head.rotation.x = player.pitch * 0.7;
      head.rotation.z = Math.cos(cycle) * 0.009 * moving;
      weaponMount.position.z = -0.37 + kick * 0.09;
      if (player.healingUntil > time) { arms.rotation.x += Math.sin(time * 0.006) * 0.045; med.rotation.y = Math.sin(time * 0.003) * 0.12; }
      if (player.reloadingUntil > time) { arms.rotation.z = -0.22 + Math.sin(time * 0.006) * 0.08; } else arms.rotation.z *= Math.exp(-dt * 10);
      for (const [slot, weapon] of weapons) weapon.visible = slot === player.slot;
      protection.visible = player.protectedUntil > time && player.health > 0;
      protectionMaterial.opacity = (local ? 0.035 : 0.11) + Math.sin(time * 0.005) * 0.018;
      root.visible = player.health > 0 && player.connected;
    },
    dispose() { accent.dispose(); protection.geometry.dispose(); protectionMaterial.dispose(); },
  };
}

export function disposeCharacterResources() {
  for (const geometry of geometryCache.values()) geometry.dispose(); geometryCache.clear();
  // Materials/geometries are module-shared and will be re-uploaded by Three if another view starts.
  for (const material of [dark, rubber, armor, steel, visor, light]) material.dispose();
  sphere.dispose(); cylinder.dispose();
}
