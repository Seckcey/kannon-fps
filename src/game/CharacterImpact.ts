import * as THREE from 'three';
import type { PublicPlayerState } from '../../shared/protocol';

/** A body hit, a headshot, or an explosion/knife: a brief, bounded warm flash (never gore). */
export type CharacterImpactKind = 'hit' | 'head' | 'blast';
type LifeState = Pick<PublicPlayerState, 'health' | 'connected' | 'protectedUntil'>;

export interface CharacterImpact {
  impact(kind: CharacterImpactKind): void;
  update(player: LifeState): void;
  dispose(): void;
}

const pulses = {
  hit: { color: new THREE.Color('#ffe0b5'), strength: 0.14, duration: 150 },
  head: { color: new THREE.Color('#fff2dc'), strength: 0.24, duration: 200 },
  blast: { color: new THREE.Color('#ffc58f'), strength: 0.32, duration: 290 },
} as const;
/** Body surfaces that pulse; accents, visors, lights and lenses keep their own look. */
const BODY_SURFACE = /^(ScoutSurface|OperatorSurface|Operator_Body|OperatorBody)$/;
const NEVER_PULSE = /PlayerAccent|Visor|StatusLight|Lens|Glass/i;

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
      if (disposed || !alive || !pulses[kind]) return;
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

/** The temporary procedural stand-in already owns its accent material. */
export function createAccentImpact(material: THREE.MeshStandardMaterial, now = () => performance.now()): CharacterImpact {
  return materialPulse([material], now, () => {});
}

/** Clone only the skinned body's packed PBR surface, never the cached weapon or accent materials.
 * The scout names it `ScoutSurface` on `scout_body`; an operator export without those names pulses
 * every non-accent standard material on its skinned meshes instead. */
export function createCharacterImpact(model: THREE.Object3D, now = () => performance.now()): CharacterImpact {
  const copies = new Map<THREE.MeshStandardMaterial, THREE.MeshStandardMaterial>();
  const bindings: { mesh: THREE.Mesh; original: THREE.Material | THREE.Material[]; assigned: THREE.Material | THREE.Material[] }[] = [];
  const body = model.getObjectByName('scout_body') ?? model.getObjectByName('operator_body');
  const named = (material: THREE.Material) => BODY_SURFACE.test(material.name);
  let hasNamedSurface = false;
  (body ?? model).traverse(object => {
    if (!(object instanceof THREE.SkinnedMesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) if (named(material)) hasNamedSurface = true;
  });
  const eligible = (material: THREE.Material): material is THREE.MeshStandardMaterial => material instanceof THREE.MeshStandardMaterial
    && (hasNamedSurface ? named(material) : !NEVER_PULSE.test(material.name));
  (body ?? model).traverse(object => {
    if (!(object instanceof THREE.SkinnedMesh) || !object.visible) return;
    const original = object.material;
    const materials = Array.isArray(original) ? original : [original];
    let changed = false;
    const replaced = materials.map(material => {
      if (!eligible(material)) return material;
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
