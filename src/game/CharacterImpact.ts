import * as THREE from 'three';
import type { PlayerState } from '../../shared/protocol';

export type CharacterImpactKind = 'shield' | 'armor' | 'break';
type LifeState = Pick<PlayerState, 'health' | 'connected' | 'protectedUntil'>;

export interface CharacterImpact {
  impact(kind: CharacterImpactKind): void;
  update(player: LifeState): void;
  dispose(): void;
}

const pulses = {
  shield: { color: new THREE.Color('#78dfff'), strength: 0.20, duration: 180 },
  armor: { color: new THREE.Color('#ffe0b5'), strength: 0.14, duration: 150 },
  break: { color: new THREE.Color('#d0faff'), strength: 0.34, duration: 290 },
} as const;

/** Changes emission only. Absolute time also expires a pulse after a suspended tab. */
function materialPulse(materials: THREE.MeshStandardMaterial[], now: () => number, release: () => void): CharacterImpact {
  const surfaces = materials.map(material => ({
    material, emissive: material.emissive.clone(), intensity: material.emissiveIntensity,
  }));
  let active: typeof pulses[CharacterImpactKind] | null = null;
  let started = 0;
  let alive = true;
  let protectedUntil: number | undefined;
  let disposed = false;

  const clear = () => {
    if (!active) return;
    for (const surface of surfaces) {
      surface.material.emissive.copy(surface.emissive);
      surface.material.emissiveIntensity = surface.intensity;
    }
    active = null;
  };
  const paint = (strength: number) => {
    if (!active) return;
    for (const surface of surfaces) {
      // Preserve the original radiance even when its stored intensity is zero.
      surface.material.emissive.copy(surface.emissive).multiplyScalar(surface.intensity);
      surface.material.emissive.r += active.color.r * strength;
      surface.material.emissive.g += active.color.g * strength;
      surface.material.emissive.b += active.color.b * strength;
      surface.material.emissiveIntensity = 1;
    }
  };

  return {
    impact(kind) {
      if (disposed || !alive) return;
      const time = now();
      if (!Number.isFinite(time)) { clear(); return; }
      // A new accepted hit replaces the pulse; repeated hits cannot accumulate brightness.
      active = pulses[kind]; started = time;
      paint(active.strength);
    },
    update(player) {
      if (disposed) return;
      alive = player.health > 0 && player.connected;
      // The new spawn's protection timestamp also catches a skipped dead snapshot.
      if (!alive || (protectedUntil !== undefined && player.protectedUntil > protectedUntil)) clear();
      protectedUntil = player.protectedUntil;
      if (!active) return;
      const elapsed = now() - started;
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= active.duration) { clear(); return; }
      const remaining = 1 - elapsed / active.duration;
      paint(active.strength * remaining * remaining);
    },
    dispose() {
      if (disposed) return;
      clear(); disposed = true;
      release(); surfaces.length = 0;
    },
  };
}

/** The temporary procedural scout already owns its accent material. */
export function createAccentImpact(material: THREE.MeshStandardMaterial, now = () => performance.now()): CharacterImpact {
  return materialPulse([material], now, () => {});
}

/** Clone only the skinned body's packed PBR surface, never the cached weapon or accent materials. */
export function createCharacterImpact(model: THREE.Object3D, now = () => performance.now()): CharacterImpact {
  const copies = new Map<THREE.MeshStandardMaterial, THREE.MeshStandardMaterial>();
  const bindings: { mesh: THREE.Mesh; original: THREE.Material | THREE.Material[]; assigned: THREE.Material | THREE.Material[] }[] = [];
  model.getObjectByName('scout_body')?.traverse(object => {
    if (!(object instanceof THREE.SkinnedMesh)) return;
    const original = object.material;
    const materials = Array.isArray(original) ? original : [original];
    let changed = false;
    const replaced = materials.map(material => {
      if (!(material instanceof THREE.MeshStandardMaterial) || material.name !== 'ScoutSurface') return material;
      let copy = copies.get(material);
      if (!copy) {
        copy = material.clone();
        // Keep dark fabric and armor details in the pulse. The exported body's
        // zero emission makes this invisible at rest; bind once before first render
        // so accepted hits never change shader defines or texture/UV transforms.
        copy.emissiveMap = material.emissiveMap ?? material.map;
        copies.set(material, copy);
      }
      changed = true;
      return copy;
    });
    if (!changed) return;
    const assigned = Array.isArray(original) ? replaced : replaced[0];
    object.material = assigned;
    bindings.push({ mesh: object, original, assigned });
  });
  return materialPulse([...copies.values()], now, () => {
    for (const { mesh, original, assigned } of bindings) if (mesh.material === assigned) mesh.material = original;
    for (const material of copies.values()) material.dispose();
    bindings.length = 0; copies.clear();
  });
}
