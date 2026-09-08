import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { PlayerState, Slot } from '../../shared/protocol';
import { createCharacter, type CharacterModel } from './Character';

let assetPromise: Promise<GLTF> | null = null;
const loadScout = () => assetPromise ??= new GLTFLoader().loadAsync('/models/scout.glb').catch(error => { assetPromise = null; throw error; });

/** Uses the exported Blender rig and animation clips; the small fallback only covers loading. */
export function createBlenderCharacter(color: string, onReady?: () => void, onError?: (message: string) => void): CharacterModel {
  const root = new THREE.Group();
  const fallback = createCharacter(color); root.add(fallback.root);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0.23, 1.25, -1.1); root.add(muzzle);
  let model: THREE.Object3D | null = null;
  let mixer: THREE.AnimationMixer | null = null;
  let currentAction: THREE.AnimationAction | null = null;
  let overlayAction: THREE.AnimationAction | null = null;
  let disposed = false;
  let kick = 0;
  let spine: THREE.Bone | null = null;
  let spineBase = new THREE.Quaternion();
  let muzzleSource: THREE.Object3D | null = null;
  const actions = new Map<string, THREE.AnimationAction>();
  const weapons = new Map<Slot, THREE.Object3D[]>();
  const clonedMaterials: THREE.Material[] = [];
  const protectedMaterial = new THREE.MeshBasicMaterial({ color: '#85edff', transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false });
  const protection = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), protectedMaterial);
  protection.position.y = 0.98; protection.scale.set(0.75, 1.08, 0.75); protection.visible = false; root.add(protection);
  const v = new THREE.Vector3();

  void loadScout().then(gltf => {
    if (disposed) return;
    model = clone(gltf.scene);
    model.traverse(object => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = true; object.receiveShadow = true;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        const recolored = materials.map(material => {
          if (/PlayerAccent/i.test(material.name)) {
            const copy = material.clone();
            if (copy instanceof THREE.MeshStandardMaterial) copy.color.set(color);
            clonedMaterials.push(copy); return copy;
          }
          return material;
        });
        object.material = Array.isArray(object.material) ? recolored : recolored[0];
      }
      if (object instanceof THREE.Bone && /^(chest|spine_02|spine2)$/i.test(object.name)) spine = object;
      for (const [slot, name] of [[1, 'weapon_ar'], [2, 'weapon_shotgun'], [3, 'healing_item']] as const) {
        if (object.name.toLowerCase().startsWith(name)) { const group = weapons.get(slot) ?? []; group.push(object); weapons.set(slot, group); }
      }
      if (/^muzzle$/i.test(object.name)) muzzleSource = object;
    });
    root.add(model);
    root.remove(fallback.root); fallback.dispose();
    mixer = new THREE.AnimationMixer(model);
    for (const clip of gltf.animations) {
      const name = clip.name.replace(/.*\|/, '');
      // Keep locomotion alive while reloading/healing. These actions affect upper-body bones only.
      const upperBody = ['fire', 'reload', 'heal'].includes(name.toLowerCase());
      const playable = upperBody ? new THREE.AnimationClip(clip.name, clip.duration, clip.tracks.filter(track => /(?:^|\[)(?:chest|neck|head|upper_arm_[lr]|forearm_[lr]|hand_[lr])(?:\]|\.)/i.test(track.name))) : clip;
      const action = mixer.clipAction(playable);
      if (name === 'Fire') action.setLoop(THREE.LoopOnce, 1);
      actions.set(name.toLowerCase(), action);
    }
    currentAction = actions.get('idle') ?? actions.values().next().value ?? null;
    currentAction?.play();
    model.userData.asset = 'Blender ScoutRig';
    model.userData.clips = Array.from(actions.keys());
    onReady?.();
  }).catch(error => {
    if (disposed) return;
    console.error('The Blender scout model could not be loaded.', error);
    onError?.('Your character model could not load. Check your connection and rejoin the match.');
  });

  return {
    root, muzzle,
    recoil() {
      kick = 1;
      fallback.recoil();
      const fire = actions.get('fire');
      if (fire && !overlayAction) { fire.reset().setEffectiveWeight(0.72).play(); }
    },
    update(player: PlayerState, dt: number, time: number, local: boolean) {
      root.visible = player.health > 0 && player.connected;
      if (!model || !mixer) { fallback.update(player, dt, time, local); return; }
      // Every locomotion clip is authored in place. Network prediction moves the outer root.
      const speed = Math.hypot(player.vx, player.vz);
      const animation = Math.abs(player.vy) > 0.8 ? 'jump' : speed > 7.2 ? 'run' : speed > 0.3 ? 'walk' : 'aim';
      const next = actions.get(animation) ?? actions.get('idle');
      if (next && next !== currentAction) {
        next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
        currentAction?.crossFadeTo(next, 0.16, false); currentAction = next;
      }
      if (currentAction && (animation === 'walk' || animation === 'run')) currentAction.timeScale = THREE.MathUtils.clamp(speed / (animation === 'run' ? 9 : 6.5), 0.65, 1.3);
      const nextOverlay = player.healingUntil > time ? actions.get('heal') : player.reloadingUntil > time ? actions.get('reload') : undefined;
      if (nextOverlay !== (overlayAction ?? undefined)) {
        overlayAction?.fadeOut(0.12);
        nextOverlay?.reset().setEffectiveWeight(1).fadeIn(0.12).play();
        overlayAction = nextOverlay ?? null;
      }
      if (spine) spine.quaternion.copy(spineBase);
      mixer.update(dt);
      if (spine) {
        spineBase = spine.quaternion.clone();
        spine.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), player.pitch * 0.68 + kick * 0.035));
      }
      kick *= Math.exp(-dt * 15);
      for (const [slot, objects] of weapons) for (const object of objects) object.visible = slot === player.slot;
      protection.visible = player.protectedUntil > time;
      protectedMaterial.opacity = local ? 0.025 : 0.10 + Math.sin(time * 0.006) * 0.02;
      if (muzzleSource) { muzzleSource.getWorldPosition(v); root.worldToLocal(v); muzzle.position.copy(v); }
    },
    dispose() {
      disposed = true; mixer?.stopAllAction();
      if (model) mixer?.uncacheRoot(model);
      else fallback.dispose();
      for (const material of clonedMaterials) material.dispose();
      protection.geometry.dispose(); protectedMaterial.dispose();
      root.removeFromParent();
    },
  };
}
