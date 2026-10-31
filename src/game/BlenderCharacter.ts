import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { WEAPONS } from '../../shared/weapons';
import { createCharacter, POSTURE_DROP, type CharacterModel } from './Character';
import { ARENA_ASSETS, getArenaAssetBuffer } from './assets';
import { createGaitTurn, GaitDirection } from './GaitTurn';
import { createLegContact, type LegContact } from './LegContact';
import { CharacterBlend, type BaseAnimationName } from './CharacterBlend';
import { createCharacterImpact, type CharacterImpact } from './CharacterImpact';
import { applySunVisibility } from './SunVisibility';
import { ktx2Loader } from './Ktx2';

let assetPromise: Promise<GLTF> | null = null;
const loadOperator = () => assetPromise ??= getArenaAssetBuffer(ARENA_ASSETS.character).then(buffer => {
  const resourcePath = new URL('.', new URL(ARENA_ASSETS.character, document.baseURI)).href;
  // Parse the bytes accepted by warmup; a second download could fail after joining.
  return new GLTFLoader().setKTX2Loader(ktx2Loader()).parseAsync(buffer, resourcePath);
}).catch(error => { assetPromise = null; throw error; });
/** Parse the shared operator model once; first-person views have no local body to wait for. */
export function preloadCharacter(): Promise<void> { return loadOperator().then(() => undefined); }

/** Weapons and props baked into older character exports; the world weapon replaces them. */
const LEGACY_PROPS = /^(weapon_ar|weapon_shotgun|healing_item)/i;
const UPPER_BODY = /(?:^|\[)(?:chest|neck|head|upper_arm_[lr]|forearm_[lr]|hand_[lr])(?:\]|\.)/i;

/** Uses the exported Blender rig and animation clips; the small fallback only covers loading.
 * Crouch, slide and vault use their clips when present, otherwise a procedural pelvis drop with
 * the feet held on the floor by the two-bone leg contact. */
export function createBlenderCharacter(color: string, onReady?: () => void, onError?: (message: string) => void): CharacterModel {
  const root = new THREE.Group();
  const fallback = createCharacter(color); root.add(fallback.root);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0.23, 1.25, -1.1); root.add(muzzle);
  // One stable socket: world weapons attach once and follow it from the stand-in to the rig.
  const weaponSocket = new THREE.Group(); weaponSocket.name = 'world-weapon-socket'; fallback.weaponSocket.add(weaponSocket);
  let accentColor = color;
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
  let drop = 0;
  let lean = 0;
  let kickRate = 1.5;
  let kickWeight = 1;
  const spineBase = new THREE.Quaternion();
  const pelvisBase = new THREE.Quaternion();
  const pelvisPosition = new THREE.Vector3();
  const lowerSpineBase = new THREE.Quaternion();
  const offset = new THREE.Quaternion();
  const pitchAxis = new THREE.Vector3(1, 0, 0);
  const turnGait = createGaitTurn();
  const gaitDirection = new GaitDirection();
  let muzzleSource: THREE.Object3D | null = null;
  const actions = new Map<string, THREE.AnimationAction>();
  const accents: THREE.MeshStandardMaterial[] = [];
  const clonedMaterials: THREE.Material[] = [];
  const materialCopies = new Map<THREE.Material, THREE.Material>();
  // Every material is copied per character so the sun can be scaled by where this player stands.
  const sunVisibility = fallback.sunVisibility;
  let sharedSkeleton: THREE.Skeleton | null = null;
  const protectedMaterial = new THREE.MeshBasicMaterial({ color: '#d8e6ea', transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false });
  const protection = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), protectedMaterial);
  protection.position.y = 0.98; protection.scale.set(0.75, 1.08, 0.75); protection.visible = false; root.add(protection);
  const v = new THREE.Vector3();

  void loadOperator().then(gltf => {
    if (disposed) return;
    model = clone(gltf.scene);
    let socket: THREE.Object3D | null = null, hand: THREE.Object3D | null = null;
    model.traverse(object => {
      // SkeletonUtils clones a skin for every material primitive. All operator meshes
      // use one exported rig, so share its bone palette within each player instance.
      if (object instanceof THREE.SkinnedMesh) {
        if (!sharedSkeleton) sharedSkeleton = object.skeleton;
        else if (object.skeleton.bones.every((bone, index) => bone === sharedSkeleton!.bones[index])) object.skeleton = sharedSkeleton;
      }
      if (LEGACY_PROPS.test(object.name)) { object.visible = false; return; }
      if (object instanceof THREE.Mesh) {
        object.castShadow = true; object.receiveShadow = true;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        const recolored = materials.map(material => {
          const existing = materialCopies.get(material); if (existing) return existing;
          const copy = material.clone();
          if (/PlayerAccent/i.test(material.name) && copy instanceof THREE.MeshStandardMaterial) { copy.color.set(accentColor); accents.push(copy); }
          applySunVisibility(copy, sunVisibility);
          clonedMaterials.push(copy); materialCopies.set(material, copy); return copy;
        });
        object.material = Array.isArray(object.material) ? recolored : recolored[0];
      }
      if (object instanceof THREE.Bone && /^(chest|spine_02|spine2)$/i.test(object.name)) spine = object;
      if (object instanceof THREE.Bone && object.name === 'pelvis') pelvis = object;
      if (object instanceof THREE.Bone && object.name === 'spine') lowerSpine = object;
      if (object.name === 'weapon_socket') socket = object;
      if (object.name === 'hand_r') hand = object;
      if (/^muzzle$/i.test(object.name)) muzzleSource = object;
    });
    impactEffect = createCharacterImpact(model);
    root.add(model);
    root.remove(fallback.root);
    // The operator's socket, else the right hand oriented like the exported muzzle (barrel along -Z).
    const target = socket ?? hand;
    if (target) {
      weaponSocket.position.set(0, 0, 0); weaponSocket.quaternion.identity();
      if (!socket && muzzleSource && (muzzleSource as THREE.Object3D).parent === hand) weaponSocket.quaternion.copy((muzzleSource as THREE.Object3D).quaternion);
      (target as THREE.Object3D).add(weaponSocket);
    } else { weaponSocket.position.set(0.23, 1.2, -0.4); root.add(weaponSocket); }
    fallback.dispose();
    mixer = new THREE.AnimationMixer(model);
    for (const clip of gltf.animations) {
      const name = clip.name.replace(/.*\|/, '');
      // Keep locomotion alive while reloading. These actions affect upper-body bones only.
      const upperBody = ['fire', 'reload'].includes(name.toLowerCase());
      if (name.toLowerCase() === 'heal') continue;
      const playable = upperBody ? new THREE.AnimationClip(clip.name, clip.duration, clip.tracks.filter(track => UPPER_BODY.test(track.name)).map(track => track.clone())) : clip;
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
    if (pelvis) { pelvisBase.copy((pelvis as THREE.Bone).quaternion); pelvisPosition.copy((pelvis as THREE.Bone).position); }
    if (lowerSpine) lowerSpineBase.copy((lowerSpine as THREE.Bone).quaternion);
    model.userData.asset = 'Blender OperatorRig';
    model.userData.clips = Array.from(actions.keys());
    onReady?.();
  }).catch(error => {
    if (disposed) return;
    console.error('The operator model could not be loaded.', error);
    onError?.('A player model could not load. Check your connection and rejoin the match.');
  });

  return {
    root, muzzle, weaponSocket, sunVisibility,
    setAccent(next) {
      if (disposed || next === accentColor) return;
      accentColor = next; fallback.setAccent(next);
      for (const material of accents) material.color.set(next);
    },
    impact(kind) {
      if (disposed) return;
      if (impactEffect) impactEffect.impact(kind);
      else fallback.impact(kind);
    },
    recoil() {
      kick = 1;
      fallback.recoil();
      const fire = actions.get('fire');
      if (fire && !overlayAction) { fire.reset().setEffectiveTimeScale(kickRate).setEffectiveWeight(kickWeight).play(); }
    },
    update(player, dt, time, local, motion) {
      if (disposed) return;
      // A living player whose connection dropped stays in the world as a frozen body others can hit.
      root.visible = player.health > 0;
      const spec = WEAPONS[player.weapon] ?? WEAPONS.kr5;
      kickRate = spec.kind === 'pistol' ? 0.8 : spec.kind === 'sniper' || spec.kind === 'shotgun' ? 0.9 : 1.5;
      kickWeight = spec.kind === 'pistol' ? 0.7 : spec.kind === 'shotgun' || spec.kind === 'sniper' ? 1.5 : 1;
      if (!model || !mixer) { fallback.update(player, dt, time, local, motion); return; }
      impactEffect?.update(player);
      // Every locomotion clip is authored in place. Network prediction moves the outer root.
      const speed = Math.hypot(player.vx, player.vz);
      const grounded = motion?.grounded ?? Math.abs(player.vy) < 0.01;
      const posture = player.posture ?? 'stand';
      const clip = (name: BaseAnimationName) => !!blend?.has(name);
      let animation: BaseAnimationName;
      if (posture === 'slide') animation = clip('slide') ? 'slide' : 'idle';
      else if (posture === 'vault' || !grounded) animation = 'jump';
      else if (posture === 'crouch') animation = speed > 0.3 ? (clip('crouchwalk') ? 'crouchwalk' : 'walk') : clip('crouch') ? 'crouch' : 'idle';
      else animation = speed > 5.6 ? 'run' : speed > 0.3 ? 'walk' : motion?.aim ? 'aim' : 'idle';
      const procedural = (posture === 'crouch' && !clip(speed > 0.3 ? 'crouchwalk' : 'crouch')) || (posture === 'slide' && !clip('slide')) || posture === 'vault';
      const forward = player.vx * Math.sin(player.yaw) - player.vz * Math.cos(player.yaw);
      const lateral = player.vx * Math.cos(player.yaw) + player.vz * Math.sin(player.yaw);
      const backwards = gaitDirection.update(forward, speed);
      // The exported cycles are retimed for 6.5/9 m/s. Slower touch/aim/crouch movement
      // slows the feet proportionally instead of retaining the old rate floor.
      const gaitRate = (backwards ? -1 : 1) * THREE.MathUtils.clamp(speed / (animation === 'run' ? 9 : animation === 'crouchwalk' ? 2.6 : 6.5), 0.01, 1.55);
      blend?.update(animation, animation === 'walk' || animation === 'run' || animation === 'crouchwalk' ? gaitRate : 1, dt);
      const reloading = player.reloadingUntil > time;
      const nextOverlay = reloading ? actions.get('reload') : undefined;
      const deadline = nextOverlay ? player.reloadingUntil : 0;
      if (nextOverlay !== (overlayAction ?? undefined) || deadline !== overlayDeadline) {
        overlayAction?.fadeOut(0.12);
        if (nextOverlay) {
          const milliseconds = spec.reloadMs > 0 ? spec.reloadMs : Math.max(500, deadline - time);
          nextOverlay.reset().setEffectiveWeight(1).setEffectiveTimeScale(nextOverlay.getClip().duration / (milliseconds / 1000)).fadeIn(0.12).play();
          nextOverlay.time = nextOverlay.getClip().duration * THREE.MathUtils.clamp(1 - (deadline - time) / milliseconds, 0, 1);
          actions.get('fire')?.stop();
        }
        overlayAction = nextOverlay ?? null;
        overlayDeadline = deadline;
      }
      if (spine) spine.quaternion.copy(spineBase);
      if (pelvis) { pelvis.quaternion.copy(pelvisBase); pelvis.position.copy(pelvisPosition); }
      if (lowerSpine) lowerSpine.quaternion.copy(lowerSpineBase);
      legContact?.restore();
      mixer.update(dt);
      const targetTurn = speed > 0.3 && grounded && posture !== 'slide' ? THREE.MathUtils.clamp(Math.atan2(backwards ? -lateral : lateral, backwards ? -forward : forward), -Math.PI / 2, Math.PI / 2) : 0;
      gaitTurn = THREE.MathUtils.damp(gaitTurn, targetTurn, 10, dt);
      if (pelvis) { pelvisBase.copy(pelvis.quaternion); pelvisPosition.copy(pelvis.position); }
      if (lowerSpine) lowerSpineBase.copy(lowerSpine.quaternion);
      if (pelvis && lowerSpine) turnGait(pelvis, lowerSpine, gaitTurn);
      drop = THREE.MathUtils.damp(drop, procedural ? POSTURE_DROP[posture] : 0, 14, dt);
      lean = THREE.MathUtils.damp(lean, procedural ? (posture === 'slide' ? -0.55 : posture === 'crouch' ? 0.22 : 0.35) : 0, 12, dt);
      if (pelvis && drop > 1e-3) {
        // The rig's pelvis is in model space with Y up; the parent root scale is 1.
        (pelvis as THREE.Bone).position.y -= drop;
        if (lowerSpine) (lowerSpine as THREE.Bone).quaternion.multiply(offset.setFromAxisAngle(pitchAxis, lean));
      }
      // Rotation blending can straighten the legs before the pelvis rises, and a procedural
      // crouch lowers it: constrain just the leg joints so the boots stay on the floor.
      if (grounded && blend && (blend.transitionRemaining > 0 || drop > 1e-3)) legContact?.apply(player.y);
      if (spine) {
        spineBase.copy(spine.quaternion);
        spine.quaternion.multiply(offset.setFromAxisAngle(pitchAxis, player.pitch * 0.78 + kick * 0.018));
      }
      kick *= Math.exp(-dt * 15);
      protection.visible = player.protectedUntil > time;
      protectedMaterial.opacity = local ? 0.02 : 0.05 + Math.sin(time * 0.006) * 0.015;
      if (muzzleSource) { (muzzleSource as THREE.Object3D).getWorldPosition(v); root.worldToLocal(v); muzzle.position.copy(v); }
    },
    dispose() {
      if (disposed) return;
      disposed = true; mixer?.stopAllAction();
      impactEffect?.dispose(); impactEffect = null;
      if (model) mixer?.uncacheRoot(model);
      else fallback.dispose();
      weaponSocket.removeFromParent();
      for (const material of clonedMaterials) material.dispose();
      materialCopies.clear(); sharedSkeleton?.dispose();
      protection.geometry.dispose(); protectedMaterial.dispose();
      root.removeFromParent();
    },
  };
}
