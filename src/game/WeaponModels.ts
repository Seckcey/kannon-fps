import * as THREE from 'three';
import type { WeaponId } from '../../shared/protocol';

/** Named points on a weapon model (contract with scripts/blender/generate_weapons.py).
 * Units are metres; the weapon points along -Z with +Y up. */
export interface WeaponAnchors {
  /** Right palm on the grip; the right arm's origin sits here. */
  gripRight: THREE.Object3D;
  /** Left hand support point on the handguard (or on the right hand for the pistol). */
  gripLeft: THREE.Object3D;
  muzzle: THREE.Object3D;
  /** A point on the optical axis; aiming puts the eye on the line through it along -Z. */
  sight: THREE.Object3D;
  eject: THREE.Object3D;
  /** Moving parts for reloads and actions, when the model has them. */
  magazine: THREE.Object3D | null;
  action: THREE.Object3D | null;
}
export interface WeaponInstance { id: WeaponId; root: THREE.Object3D; anchors: WeaponAnchors }
export interface WeaponLibrary {
  /** A new clone. `purpose` lets first-person copies skip shadows and third-person copies use cheaper materials. */
  weapon(id: WeaponId, purpose: 'view' | 'world'): WeaponInstance;
  knife(): THREE.Object3D;
  frag(): THREE.Object3D;
  /** Gloved forearms; each origin is the palm grip point, the forearm extends toward +Z. */
  arms(): { left: THREE.Object3D; right: THREE.Object3D };
  /** True when the exported GLB supplied the models; false for procedural stand-ins. */
  readonly fromAsset: boolean;
  dispose(): void;
}

/** Contract stub: procedural stand-ins until the weapons GLB loader replaces this body. */
export function loadWeaponModels(_renderer: THREE.WebGLRenderer): Promise<WeaponLibrary> {
  const metal = new THREE.MeshStandardMaterial({ color: '#2b2d2f', roughness: 0.45, metalness: 0.8 });
  const glove = new THREE.MeshStandardMaterial({ color: '#3b3a33', roughness: 0.9 });
  const point = (parent: THREE.Object3D, name: string, x: number, y: number, z: number) => {
    const node = new THREE.Object3D(); node.name = name; node.position.set(x, y, z); parent.add(node); return node;
  };
  const library: WeaponLibrary = {
    fromAsset: false,
    weapon(id) {
      const root = new THREE.Group(); root.name = `weapon_${id}`;
      const length = id === 'longbow' ? 1.1 : id === 'sentry9' ? 0.22 : id === 'hornet9' ? 0.55 : 0.8;
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, length), metal); body.position.z = -length / 2 + 0.12; root.add(body);
      return { id, root, anchors: {
        gripRight: point(root, 'grip_r', 0, -0.06, 0), gripLeft: point(root, 'grip_l', 0, -0.04, id === 'sentry9' ? 0.02 : -0.3),
        muzzle: point(root, 'muzzle', 0, 0.02, -length + 0.12), sight: point(root, 'sight', 0, 0.09, -0.1),
        eject: point(root, 'eject', 0.04, 0.03, -0.05), magazine: null, action: null,
      } };
    },
    knife() { return new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, 0.25), metal); },
    frag() { return new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), metal); },
    arms() {
      const arm = () => { const g = new THREE.Group(); const m = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.4), glove); m.position.z = 0.2; g.add(m); return g; };
      return { left: arm(), right: arm() };
    },
    dispose() { metal.dispose(); glove.dispose(); },
  };
  return Promise.resolve(library);
}
