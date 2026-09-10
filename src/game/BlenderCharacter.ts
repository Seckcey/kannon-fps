import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { RULES, type PlayerState, type Slot } from '../../shared/protocol';
import { createCharacter, type CharacterModel } from './Character';
import { ARENA_ASSETS, getArenaAssetBuffer } from './assets';
import { createGaitTurn, GaitDirection } from './GaitTurn';
import { createLegContact, type LegContact } from './LegContact';
import { CharacterBlend } from './CharacterBlend';
import { createCharacterImpact, type CharacterImpact } from './CharacterImpact';
import { applySunVisibility } from './SunVisibility';

let assetPromise: Promise<GLTF> | null = null;
const loadScout = () => assetPromise ??= getArenaAssetBuffer(ARENA_ASSETS.character).then(buffer => {
  const resourcePath = new URL('.', new URL(ARENA_ASSETS.character, document.baseURI)).href;
  // Parse the bytes accepted by warmup; a second download could fail after joining.
  return new GLTFLoader().parseAsync(buffer, resourcePath);
}).catch(error => { assetPromise = null; throw error; });

/** Uses the exported Blender rig and animation clips; the small fallback only covers loading. */
export function createBlenderCharacter(color: string, onReady?: () => void, onError?: (message: string) => void): CharacterModel {
  const root = new THREE.Group();
  const fallback = createCharacter(color); root.add(fallback.root);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0.23, 1.25, -1.1); root.add(muzzle);
  let model: THREE.Object3D | null = null;
  let mixer: THREE.AnimationMixer | null = null;
  let blend: CharacterBlend | null = null;
  let legContact: LegContact | null = null;
  let impactEffect: CharacterImpact | null = null;
  let overlayAction: THREE.AnimationAction | null = null;
  let disposed = false;
  let kick = 0;
  let spine: THREE.Bone | null = null;
  let pelvis: THREE.Bone | null = null;
  let lowerSpine: THREE.Bone | null = null;
  let gaitTurn = 0;
  let overlayDeadline = 0;
  let activeSlot: Slot = 1;
  const spineBase = new THREE.Quaternion();
  const pelvisBase = new THREE.Quaternion();
  const lowerSpineBase = new THREE.Quaternion();
  const offset = new THREE.Quaternion();
  const pitchAxis = new THREE.Vector3(1, 0, 0);
  const turnGait = createGaitTurn();
  const gaitDirection = new GaitDirection();
  let muzzleSource: THREE.Object3D | null = null;
  let shotgunMuzzle: THREE.Object3D | null = null;
  const actions = new Map<string, THREE.AnimationAction>();
  const weapons = new Map<Slot, THREE.Object3D[]>();
  const clonedMaterials: THREE.Material[] = [];
  const materialCopies = new Map<THREE.Material, THREE.Material>();
  // Every material is copied per character so the sun can be scaled by where this player stands.
  const sunVisibility = fallback.sunVisibility;
  let sharedSkeleton: THREE.Skeleton | null = null;
  const protectedMaterial = new THREE.MeshBasicMaterial({ color: '#85edff', transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false });
  const protection = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), protectedMaterial);
  protection.position.y = 0.98; protection.scale.set(0.75, 1.08, 0.75); protection.visible = false; root.add(protection);
  const v = new THREE.Vector3();

  void loadScout().then(gltf => {
    if (disposed) return;
    model = clone(gltf.scene);
    model.traverse(object => {
      // SkeletonUtils clones a skin for every material primitive. All scout meshes
      // use one exported rig, so share its bone palette within each player instance.
      if (object instanceof THREE.SkinnedMesh) {
        if (!sharedSkeleton) sharedSkeleton = object.skeleton;
        else if (object.skeleton.bones.every((bone, index) => bone === sharedSkeleton!.bones[index])) object.skeleton = sharedSkeleton;
      }
      if (object instanceof THREE.Mesh) {
        object.castShadow = true; object.receiveShadow = true;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        const recolored = materials.map(material => {
          const existing = materialCopies.get(material); if (existing) return existing;
          const copy = material.clone();
          if (/PlayerAccent/i.test(material.name) && copy instanceof THREE.MeshStandardMaterial) copy.color.set(color);
          applySunVisibility(copy, sunVisibility);
          clonedMaterials.push(copy); materialCopies.set(material, copy); return copy;
        });
        object.material = Array.isArray(object.material) ? recolored : recolored[0];
      }
      if (object instanceof THREE.Bone && /^(chest|spine_02|spine2)$/i.test(object.name)) spine = object;
      if (object instanceof THREE.Bone && object.name === 'pelvis') pelvis = object;
      if (object instanceof THREE.Bone && object.name === 'spine') lowerSpine = object;
      for (const [slot, name] of [[1, 'weapon_ar'], [2, 'weapon_shotgun'], [3, 'healing_item']] as const) {
        if (object.name.toLowerCase().startsWith(name)) { const group = weapons.get(slot) ?? []; group.push(object); weapons.set(slot, group); }
      }
      if (/^muzzle$/i.test(object.name)) muzzleSource = object;
      if (object.name === 'muzzle_shotgun') shotgunMuzzle = object;
    });
    impactEffect = createCharacterImpact(model);
    root.add(model);
    root.remove(fallback.root); fallback.dispose();
    mixer = new THREE.AnimationMixer(model);
    for (const clip of gltf.animations) {
      const name = clip.name.replace(/.*\|/, '');
      // Keep locomotion alive while reloading/healing. These actions affect upper-body bones only.
      const upperBody = ['fire', 'reload', 'heal'].includes(name.toLowerCase());
      const playable = upperBody ? new THREE.AnimationClip(clip.name, clip.duration, clip.tracks.filter(track => /(?:^|\[)(?:chest|neck|head|upper_arm_[lr]|forearm_[lr]|hand_[lr])(?:\]|\.)/i.test(track.name)).map(track => track.clone())) : clip;
      // The authored first frame is the tactical rest pose. Add its deltas to the
      // locomotion pose so neither the arms nor the moving legs are half-blended away.
      if (upperBody) THREE.AnimationUtils.makeClipAdditive(playable, 0, playable, 30);
      const action = mixer.clipAction(playable);
      if (upperBody || name === 'Jump') { action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; }
      actions.set(name.toLowerCase(), action);
    }
    (actions.get('idle') ?? actions.values().next().value)?.play();
    mixer.update(0);
    blend = new CharacterBlend(actions);
    legContact = createLegContact(model);
    if (spine) spineBase.copy((spine as THREE.Bone).quaternion);
    if (pelvis) pelvisBase.copy((pelvis as THREE.Bone).quaternion);
    if (lowerSpine) lowerSpineBase.copy((lowerSpine as THREE.Bone).quaternion);
    model.userData.asset = 'Blender ScoutRig';
    model.userData.clips = Array.from(actions.keys());
    onReady?.();
  }).catch(error => {
    if (disposed) return;
    console.error('The Blender scout model could not be loaded.', error);
    onError?.('Your character model could not load. Check your connection and rejoin the match.');
  });

  return {
    root, muzzle, sunVisibility,
    impact(kind) {
      if (disposed) return;
      if (impactEffect) impactEffect.impact(kind);
      else fallback.impact(kind);
    },
    recoil() {
      kick = 1;
      fallback.recoil();
      const fire = actions.get('fire');
      if (fire && !overlayAction) { fire.reset().setEffectiveTimeScale(activeSlot === 2 ? 0.8 : 1.5).setEffectiveWeight(activeSlot === 2 ? 1.5 : 1).play(); }
    },
    update(player: PlayerState, dt: number, time: number, local: boolean, motion) {
      if (disposed) return;
      root.visible = player.health > 0 && player.connected;
      if (!model || !mixer) { fallback.update(player, dt, time, local); return; }
      impactEffect?.update(player);
      // Every locomotion clip is authored in place. Network prediction moves the outer root.
      const speed = Math.hypot(player.vx, player.vz);
      const grounded = motion?.grounded ?? Math.abs(player.vy) < 0.01;
      const animation = !grounded ? 'jump' : speed > 7.2 ? 'run' : speed > 0.3 ? 'walk' : motion?.aim ? 'aim' : 'idle';
      const forward = player.vx * Math.sin(player.yaw) - player.vz * Math.cos(player.yaw);
      const lateral = player.vx * Math.cos(player.yaw) + player.vz * Math.sin(player.yaw);
      const backwards = gaitDirection.update(forward, speed);
      // The exported cycles are retimed for 6.5/9 m/s. Slower touch/aim movement
      // must slow the feet proportionally instead of retaining the old rate floor.
      const gaitRate = (backwards ? -1 : 1) * THREE.MathUtils.clamp(speed / (animation === 'run' ? 9 : 6.5), 0.01, 1.55);
      blend?.update(animation, animation === 'walk' || animation === 'run' ? gaitRate : 1, dt);
      const nextOverlay = player.healingUntil > time ? actions.get('heal') : player.reloadingUntil > time ? actions.get('reload') : undefined;
      const deadline = nextOverlay === actions.get('heal') ? player.healingUntil : nextOverlay ? player.reloadingUntil : 0;
      if (nextOverlay !== (overlayAction ?? undefined) || deadline !== overlayDeadline) {
        overlayAction?.fadeOut(0.12);
        if (nextOverlay) {
          const milliseconds = nextOverlay === actions.get('heal') ? RULES.healMs : player.slot === 2 ? RULES.shotgunReloadMs : RULES.arReloadMs;
          nextOverlay.reset().setEffectiveWeight(1).setEffectiveTimeScale(nextOverlay.getClip().duration / (milliseconds / 1000)).fadeIn(0.12).play();
          nextOverlay.time = nextOverlay.getClip().duration * THREE.MathUtils.clamp(1 - (deadline - time) / milliseconds, 0, 1);
          actions.get('fire')?.stop();
        }
        overlayAction = nextOverlay ?? null;
        overlayDeadline = deadline;
      }
      if (spine) spine.quaternion.copy(spineBase);
      if (pelvis) pelvis.quaternion.copy(pelvisBase);
      if (lowerSpine) lowerSpine.quaternion.copy(lowerSpineBase);
      legContact?.restore();
      mixer.update(dt);
      const targetTurn = speed > 0.3 && grounded ? THREE.MathUtils.clamp(Math.atan2(backwards ? -lateral : lateral, backwards ? -forward : forward), -Math.PI / 2, Math.PI / 2) : 0;
      gaitTurn = THREE.MathUtils.damp(gaitTurn, targetTurn, 10, dt);
      if (pelvis) pelvisBase.copy(pelvis.quaternion);
      if (lowerSpine) lowerSpineBase.copy(lowerSpine.quaternion);
      if (pelvis && lowerSpine) turnGait(pelvis, lowerSpine, gaitTurn);
      // Rotation blending can straighten the legs before the pelvis rises.
      // Constrain just the leg joints during grounded fades; never lift the actor.
      if (grounded && blend && blend.transitionRemaining > 0) legContact?.apply(player.y);
      if (spine) {
        spineBase.copy(spine.quaternion);
        spine.quaternion.multiply(offset.setFromAxisAngle(pitchAxis, player.pitch * 0.78 + kick * 0.018));
      }
      kick *= Math.exp(-dt * 15);
      activeSlot = player.slot;
      for (const [slot, objects] of weapons) for (const object of objects) object.visible = slot === player.slot;
      protection.visible = player.protectedUntil > time;
      protectedMaterial.opacity = local ? 0.025 : 0.10 + Math.sin(time * 0.006) * 0.02;
      const activeMuzzle = player.slot === 2 ? shotgunMuzzle ?? muzzleSource : muzzleSource;
      if (activeMuzzle) { activeMuzzle.getWorldPosition(v); root.worldToLocal(v); muzzle.position.copy(v); }
    },
    dispose() {
      if (disposed) return;
      disposed = true; mixer?.stopAllAction();
      impactEffect?.dispose(); impactEffect = null;
      if (model) mixer?.uncacheRoot(model);
      else fallback.dispose();
      for (const material of clonedMaterials) material.dispose();
      materialCopies.clear(); sharedSkeleton?.dispose();
      protection.geometry.dispose(); protectedMaterial.dispose();
      root.removeFromParent();
    },
  };
}
