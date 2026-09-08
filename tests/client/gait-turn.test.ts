import test from 'node:test';
import assert from 'node:assert/strict';
import { Bone, Euler, Group, Object3D, Quaternion, Vector3 } from 'three';
import { createGaitTurn, GaitDirection } from '../../src/game/GaitTurn';
import { readFile } from 'node:fs/promises';
import { AnimationMixer, BufferGeometry, Float32BufferAttribute, LoopOnce, MeshBasicMaterial, Skeleton, SkinnedMesh, Texture, Uint16BufferAttribute, type AnimationAction } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createLegContact } from '../../src/game/LegContact';
import { CharacterBlend, type BaseAnimationName } from '../../src/game/CharacterBlend';

test('a noisy joystick boundary does not chatter between forward and backward gait', () => {
  const direction = new GaitDirection();
  for (const speed of [2, 4, 6.5, 9]) {
    direction.update(0, 0);
    for (const ratio of [-.24, -.26, -.23, -.27, -.24, -.26]) assert.equal(direction.update(speed * ratio, speed), false);
    assert.equal(direction.update(-speed * .36, speed), true, 'Deliberate backward travel reverses the gait');
    for (const ratio of [-.24, -.26, -.23, -.27, -.24, -.26]) assert.equal(direction.update(speed * ratio, speed), true);
    assert.equal(direction.update(-speed * .14, speed), false, 'Returning toward forward travel exits the dead band');
    assert.equal(direction.update(-speed, speed), true);
    assert.equal(direction.update(0, 0), false, 'Stopping clears the previous travel direction');
    assert.equal(direction.update(0, speed), false, 'Pure strafing uses the forward cycle');
  }
});

for (const float32 of [false, true]) {
  test(`gait yaw preserves the floor plane and aiming under transformed rigs${float32 ? ' with Float32 keys' : ''}`, () => {
    const applyTurn = createGaitTurn();
    for (const radians of [-Math.PI / 2, -Math.PI / 4, 0, Math.PI / 4, Math.PI / 2]) {
      for (let phase = 0; phase < 24; phase++) {
        const root = new Group();
        root.position.set(2.4, .2, -8.7);
        root.quaternion.setFromEuler(new Euler(.12, phase * .23, -.07));
        root.scale.setScalar(.9);
        const rig = new Group();
        rig.quaternion.setFromEuler(new Euler(-Math.PI / 2, .08, 0));
        root.add(rig);
        const pelvis = new Bone();
        pelvis.position.set(.04, -.09, .97);
        pelvis.quaternion.setFromEuler(new Euler(.24 * Math.sin(phase), -.16, .13 * Math.cos(phase)));
        rig.add(pelvis);
        const upperSpine = new Bone();
        upperSpine.position.set(.01, .17, .01);
        upperSpine.quaternion.setFromEuler(new Euler(.19, -.23, .11));
        pelvis.add(upperSpine);
        const feet = [-1, 1].map(side => {
          const ankle = new Bone();
          ankle.position.set(side * .18, -.72, .24 * Math.sin(phase + side));
          ankle.quaternion.setFromEuler(new Euler(.3 * Math.cos(phase), .04, side * .12));
          pelvis.add(ankle);
          const sole = new Object3D();
          sole.position.set(side * .03, -.1, -.11);
          ankle.add(sole);
          return sole;
        });
        if (float32) root.traverse(object => object.quaternion.fromArray(object.quaternion.toArray().map(Math.fround)));
        const center = pelvis.getWorldPosition(new Vector3());
        const beforeFeet = feet.map(foot => foot.getWorldPosition(new Vector3()));
        const beforeUpper = upperSpine.getWorldQuaternion(new Quaternion()).normalize();
        const worldTurn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -radians);

        applyTurn(pelvis, upperSpine, radians);

        for (const [index, foot] of feet.entries()) {
          const after = foot.getWorldPosition(new Vector3());
          const expected = beforeFeet[index].clone().sub(center).applyQuaternion(worldTurn).add(center);
          assert.ok(Math.abs(after.y - beforeFeet[index].y) < 1e-6, 'Pelvic lean cannot turn horizontal travel into floor penetration');
          assert.ok(after.distanceTo(expected) < 1e-6, 'Each foot follows the same world-up yaw about the pelvis');
        }
        const afterUpper = upperSpine.getWorldQuaternion(new Quaternion()).normalize();
        assert.ok(afterUpper.angleTo(beforeUpper) < 1e-6, 'The animated upper-body orientation is preserved');
        for (const basis of [new Vector3(0, 0, -1), new Vector3(0, 1, 0)]) {
          assert.ok(basis.clone().applyQuaternion(afterUpper).distanceTo(basis.clone().applyQuaternion(beforeUpper)) < 1e-6, 'Aim and up vectors stay stable');
        }
      }
    }
  });
}

function requireBone(model: Object3D, name: string): Bone {
  const bone = model.getObjectByName(name);
  assert.ok(bone instanceof Bone, `${name} exists in the exported rig`);
  return bone;
}

function rigidSoleSampler(model: Object3D) {
  const soles: Array<{ mesh: SkinnedMesh; index: number }> = [];
  model.traverse(object => {
    if (!(object instanceof SkinnedMesh)) return;
    const indices = object.geometry.getAttribute('skinIndex'), weights = object.geometry.getAttribute('skinWeight');
    for (let index = 0; index < indices.count; index++) for (let lane = 0; lane < 4; lane++) {
      if (weights.getComponent(index, lane) >= 1 - 1e-6 && /^foot_[lr]$/.test(object.skeleton.bones[indices.getComponent(index, lane)]?.name ?? '')) {
        soles.push({ mesh: object, index }); break;
      }
    }
  });
  const point = new Vector3();
  return {
    count: soles.length,
    minimum() {
      model.updateWorldMatrix(true, true);
      let minimum = Infinity;
      for (const { mesh, index } of soles) {
        mesh.getVertexPosition(index, point).applyMatrix4(mesh.matrixWorld);
        minimum = Math.min(minimum, point.y);
      }
      return minimum;
    },
  };
}

test('leg contact clears actual Scout crossfade soles without moving the actor, upper body or stretching legs', async () => {
  const bytes = await readFile(new URL('../../public/models/scout.glb', import.meta.url));
  const loader = new GLTFLoader();
  // Texture pixels do not participate in deformation. Keep the real skin,
  // inverse binds, animation tracks and Three's mixer without a browser or GPU.
  loader.register(() => ({ name: 'CPU_leg_contact_test', loadTexture: async () => new Texture() }));
  const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const actor = new Group(), parent = new Group();
  parent.add(actor); actor.add(gltf.scene);
  const contact = createLegContact(gltf.scene), sole = rigidSoleSampler(gltf.scene);
  assert.ok(sole.count > 2_000, 'Sample the actual exported rigid boot skin');
  const mixer = new AnimationMixer(gltf.scene);
  const bones: Bone[] = [];
  gltf.scene.traverse(object => { if (object instanceof Bone) bones.push(object); });
  assert.equal(bones.length, 18);
  const fixed = [parent, actor, gltf.scene, ...['root', 'pelvis', 'spine', 'chest'].map(name => requireBone(gltf.scene, name))];
  const chains = ['l', 'r'].map(side => ['thigh_', 'shin_', 'foot_'].map(prefix => requireBone(gltf.scene, prefix + side)));
  const transitions = [
    { from: 'Idle', to: 'Walk', time: .4, rate: 1 },
    { from: 'Walk', to: 'Run', time: .8, rate: 1 },
    { from: 'Run', to: 'Walk', time: .8, rate: 4 / 6.5 },
    { from: 'Walk', to: 'Idle', time: .17, rate: 1 },
  ];
  let penetratingFrames = 0;
  for (const transformed of [false, true]) {
    parent.position.set(transformed ? 7 : 0, transformed ? 1.5 : 0, transformed ? -5 : 0);
    parent.rotation.set(0, transformed ? .63 : 0, 0); parent.scale.setScalar(transformed ? 1.2 : 1);
    actor.position.set(transformed ? 2 : 0, transformed ? .7 : 0, transformed ? 1 : 0);
    actor.rotation.set(transformed ? .025 : 0, transformed ? -1.3 : 0, transformed ? -.018 : 0);
    actor.scale.setScalar(transformed ? .85 : 1);
    const floorY = actor.getWorldPosition(new Vector3()).y;
    for (const transition of transitions) {
      contact.restore(); mixer.stopAllAction();
      const from = mixer.clipAction(gltf.animations.find(clip => clip.name === transition.from)!).reset().setEffectiveWeight(1).setEffectiveTimeScale(1).play();
      mixer.update(transition.time);
      const to = mixer.clipAction(gltf.animations.find(clip => clip.name === transition.to)!).reset().setEffectiveWeight(1).setEffectiveTimeScale(transition.rate).play();
      from.crossFadeTo(to, .16, false);
      for (let frame = 0; frame < 20; frame++) {
        contact.restore(); mixer.update(1 / 120);
        const beforeMinimum = sole.minimum();
        if (beforeMinimum < floorY - .02) penetratingFrames++;
        const beforeFixed = fixed.map(object => object.matrixWorld.toArray());
        const beforeLocal = bones.map(bone => ({ position: bone.position.toArray(), scale: bone.scale.toArray(), quaternion: bone.quaternion.toArray() }));
        const beforeChains = chains.map(chain => {
          const [hip, knee, ankle] = chain.map(bone => bone.getWorldPosition(new Vector3()));
          return { upper: hip.distanceTo(knee), lower: knee.distanceTo(ankle), foot: chain[2].getWorldQuaternion(new Quaternion()).normalize() };
        });
        contact.apply(floorY);
        assert.ok(sole.minimum() >= floorY + .0059, `${transition.from}→${transition.to}, frame ${frame}: actual boots clear the support plane`);
        fixed.forEach((object, index) => assert.deepEqual(object.matrixWorld.toArray(), beforeFixed[index], 'The actor, pelvis and aiming body stay exactly in place'));
        bones.forEach((bone, index) => {
          assert.deepEqual(bone.position.toArray(), beforeLocal[index].position, 'No bone translation is used to conceal penetration');
          assert.deepEqual(bone.scale.toArray(), beforeLocal[index].scale, 'Body proportions are preserved');
        });
        chains.forEach((chain, index) => {
          const [hip, knee, ankle] = chain.map(bone => bone.getWorldPosition(new Vector3()));
          assert.ok(Math.abs(hip.distanceTo(knee) - beforeChains[index].upper) < 1e-6);
          assert.ok(Math.abs(knee.distanceTo(ankle) - beforeChains[index].lower) < 1e-6);
          assert.ok(chain[2].getWorldQuaternion(new Quaternion()).normalize().angleTo(beforeChains[index].foot) < 1e-6, 'Sole orientation is retained');
        });
        contact.restore(); contact.restore();
        bones.forEach((bone, index) => assert.deepEqual(bone.quaternion.toArray(), beforeLocal[index].quaternion, 'Restore returns exact exported quaternion components'));
        assert.ok(Math.abs(sole.minimum() - beforeMinimum) < 1e-9, 'Restore returns the original uncorrected skin, without accumulated IK');
      }
    }
  }
  assert.ok(penetratingFrames > 20, 'These transitions exercise the real regression, not only already-grounded poses');
  mixer.stopAllAction(); mixer.uncacheRoot(gltf.scene);
});

function straightLeg(upper = .5, lower = .5) {
  const model = new Group(), thigh = new Bone(), shin = new Bone(), foot = new Bone();
  thigh.name = 'thigh_l'; shin.name = 'shin_l'; foot.name = 'foot_l';
  thigh.position.y = upper + lower; shin.position.y = -upper; foot.position.y = -lower;
  model.add(thigh); thigh.add(shin); shin.add(foot);
  const positions: number[] = [];
  for (const x of [-.07, .07]) for (const y of [-.04, .04]) for (const z of [-.15, .15]) positions.push(x, y, z);
  const geometry = new BufferGeometry(); geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(Array.from({ length: 8 }, () => [2, 0, 0, 0]).flat(), 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(Array.from({ length: 8 }, () => [1, 0, 0, 0]).flat(), 4));
  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial()); model.add(mesh); model.updateMatrixWorld(true);
  mesh.bind(new Skeleton([thigh, shin, foot]));
  return { model, thigh, shin, foot, contact: createLegContact(model), sole: rigidSoleSampler(model) };
}

test('straight-knee fallback bends without stretching and restores the exact original pose', () => {
  const rig = straightLeg(), bones = [rig.thigh, rig.shin, rig.foot];
  const before = bones.map(bone => bone.quaternion.toArray());
  assert.ok(rig.sole.minimum() < -.039);
  rig.contact.apply(0);
  assert.ok(rig.sole.minimum() >= .00599);
  const [hip, knee, ankle] = bones.map(bone => bone.getWorldPosition(new Vector3()));
  assert.ok(Math.abs(hip.distanceTo(knee) - .5) < 1e-8);
  assert.ok(Math.abs(knee.distanceTo(ankle) - .5) < 1e-8);
  assert.ok(Math.abs(knee.z) > .05, 'A collinear starting chain gets a stable nonzero bend direction');
  rig.contact.restore();
  bones.forEach((bone, index) => assert.deepEqual(bone.quaternion.toArray(), before[index]));
});

test('degenerate and unreachable contact targets remain finite without changing segment lengths', () => {
  assert.doesNotThrow(() => { const absent = createLegContact(new Group()); absent.apply(0); absent.restore(); });
  for (const item of [
    { upper: 0, lower: .5, floor: 0, unchanged: true },
    { upper: .5, lower: 0, floor: 0, unchanged: true },
    { upper: .5, lower: .5, floor: .954, unchanged: true }, // Target ankle equals hip.
    { upper: .5, lower: .5, floor: Number.NaN, unchanged: true },
    { upper: .5, lower: .5, floor: Infinity, unchanged: true },
    { upper: .5, lower: .5, floor: 10, unchanged: false },
  ]) {
    const rig = straightLeg(item.upper, item.lower), bones = [rig.thigh, rig.shin, rig.foot];
    const before = bones.map(bone => bone.quaternion.toArray());
    rig.contact.apply(item.floor); rig.model.updateMatrixWorld(true);
    for (const bone of bones) assert.ok([...bone.quaternion.toArray(), ...bone.matrixWorld.elements].every(Number.isFinite));
    const [hip, knee, ankle] = bones.map(bone => bone.getWorldPosition(new Vector3()));
    assert.ok(Math.abs(hip.distanceTo(knee) - item.upper) < 1e-8);
    assert.ok(Math.abs(knee.distanceTo(ankle) - item.lower) < 1e-8);
    if (item.unchanged) bones.forEach((bone, index) => assert.deepEqual(bone.quaternion.toArray(), before[index]));
    else assert.ok(rig.sole.minimum() < item.floor, 'An unreachable request is bounded, not hidden by stretching the leg');
    rig.contact.restore();
    bones.forEach((bone, index) => assert.deepEqual(bone.quaternion.toArray(), before[index]));
  }
});

test('interrupted 50 ms blends keep the actual Scout pose continuous through stop, reverse, aim and jump', async () => {
  const bytes = await readFile(new URL('../../public/models/scout.glb', import.meta.url));
  const loader = new GLTFLoader();
  loader.register(() => ({ name: 'CPU_interrupted_blend_test', loadTexture: async () => new Texture() }));
  const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const model = gltf.scene, mixer = new AnimationMixer(model);
  const actions = new Map(gltf.animations.map(clip => [clip.name.toLowerCase(), mixer.clipAction(clip)]));
  const blend = new CharacterBlend(actions), contact = createLegContact(model), sole = rigidSoleSampler(model);
  const bones: Bone[] = []; model.traverse(object => { if (object instanceof Bone) bones.push(object); });
  const baseNames: BaseAnimationName[] = ['idle', 'walk', 'run', 'jump', 'aim'];
  const ankles = ['foot_l', 'foot_r'].map(name => requireBone(model, name));
  const sequence: Array<{ name: BaseAnimationName; rate: number; frames: number }> = [
    { name: 'idle', rate: 1, frames: 6 },
    { name: 'walk', rate: 1, frames: 6 },
    { name: 'idle', rate: 1, frames: 6 },
    { name: 'walk', rate: 1, frames: 6 },
    { name: 'run', rate: 1, frames: 6 },
    { name: 'walk', rate: 4 / 6.5, frames: 6 },
    { name: 'walk', rate: -1, frames: 6 },
    { name: 'aim', rate: 1, frames: 6 },
    { name: 'jump', rate: 1, frames: 6 },
    { name: 'idle', rate: 1, frames: 6 },
    { name: 'run', rate: 1, frames: 6 },
    { name: 'aim', rate: 1, frames: 6 },
    { name: 'idle', rate: 1, frames: 48 },
  ];
  // The complete runtime action map includes overlays. Merely selecting base
  // animations must not reset or disable an independently controlled weapon clip.
  const fire = actions.get('fire')!;
  fire.setEffectiveWeight(.37).setEffectiveTimeScale(1.23); fire.time = .03;
  blend.update('idle', 1, 0); mixer.update(0);
  let maxAnkleStep = 0, movedFrames = 0, previousAnkles: Vector3[] | undefined;
  for (let repeat = 0; repeat < 2; repeat++) for (const item of sequence) {
    contact.restore(); model.updateWorldMatrix(true, true);
    const beforeMatrices = bones.map(bone => bone.matrixWorld.toArray());
    const before = baseNames.map(name => ({ name, weight: actions.get(name)!.getEffectiveWeight(), time: actions.get(name)!.time }));
    const beforeFire = { time: fire.time, weight: fire.getEffectiveWeight(), rate: fire.getEffectiveTimeScale(), enabled: fire.enabled };
    blend.update(item.name, item.rate, 0); mixer.update(0); model.updateWorldMatrix(true, true);
    for (const entry of before) {
      assert.ok(Math.abs(actions.get(entry.name)!.getEffectiveWeight() - entry.weight) < 1e-12, 'An interruption starts at the current full weight vector');
      if (entry.weight > 0) assert.ok(Math.abs(actions.get(entry.name)!.time - entry.time) < 1e-8, 'Contributing actions retain their phase when retargeted');
    }
    bones.forEach((bone, index) => {
      const values = bone.matrixWorld.elements;
      assert.ok(values.every((value, component) => Math.abs(value - beforeMatrices[index][component]) < 1e-6), `${item.name}: zero-time target selection cannot teleport ${bone.name}`);
    });
    assert.deepEqual({ time: fire.time, weight: fire.getEffectiveWeight(), rate: fire.getEffectiveTimeScale(), enabled: fire.enabled }, beforeFire, 'The base blender does not own weapon overlays');
    for (let frame = 0; frame < item.frames; frame++) {
      contact.restore(); blend.update(item.name, item.rate, 1 / 120); mixer.update(1 / 120);
      if (item.name !== 'jump' && blend.transitionRemaining > 0) contact.apply(0);
      model.updateWorldMatrix(true, true);
      const weights = baseNames.map(name => actions.get(name)!.getEffectiveWeight());
      assert.ok(weights.every(weight => Number.isFinite(weight) && weight >= 0 && weight <= 1));
      assert.ok(Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 1) < 1e-10, 'Rapid interruptions preserve unit total base weight');
      assert.ok(bones.every(bone => bone.matrixWorld.elements.every(Number.isFinite)), 'Including transient upper-body poses');
      if (item.name !== 'jump') assert.ok(sole.minimum() >= -.001, 'Interrupted grounded blends still clear the floor');
      if (item.name === 'walk' || item.name === 'run') {
        const target = actions.get(item.name)!;
        for (const name of ['walk', 'run']) {
          const gait = actions.get(name)!;
          if (gait.getEffectiveWeight() <= 0) continue;
          assert.ok(Math.abs(gait.getEffectiveTimeScale() / gait.getClip().duration - item.rate / target.getClip().duration) < 1e-10, 'Contributing gaits share signed phase velocity');
          assert.ok(Math.abs(gait.time / gait.getClip().duration - target.time / target.getClip().duration) < 1e-6, 'Contributing gaits remain phase-aligned');
        }
      }
      const currentAnkles = ankles.map(bone => bone.getWorldPosition(new Vector3()));
      if (previousAnkles) for (let index = 0; index < ankles.length; index++) {
        const distance = currentAnkles[index].distanceTo(previousAnkles[index]);
        maxAnkleStep = Math.max(maxAnkleStep, distance); if (distance > .001) movedFrames++;
      }
      previousAnkles = currentAnkles;
    }
  }
  assert.ok(movedFrames > 100, 'A frozen Idle pose cannot pass the blend regression');
  assert.ok(maxAnkleStep < .16, `No abrupt 33 cm foot pop between 120 Hz samples: ${maxAnkleStep}`);
  assert.equal(blend.target, actions.get('idle'));
  assert.equal(blend.transitionRemaining, 0);
  for (const name of ['walk', 'run', 'jump', 'aim']) assert.equal(actions.get(name)!.enabled, false, 'Fully faded sources stop contributing');
  contact.restore(); mixer.stopAllAction(); mixer.uncacheRoot(model);
});

test('a completed Scout jump replays after a 50 ms landing without a pose jump or accumulating held actions', async () => {
  const bytes = await readFile(new URL('../../public/models/scout.glb', import.meta.url));
  const loader = new GLTFLoader();
  loader.register(() => ({ name: 'CPU_completed_jump_test', loadTexture: async () => new Texture() }));
  const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const model = gltf.scene, mixer = new AnimationMixer(model);
  // Observe action allocation through the public mixer method. This also catches
  // a replay implementation that leaves hidden held poses contributing forever.
  const allocated = new Set<AnimationAction>(), clipAction = mixer.clipAction.bind(mixer);
  mixer.clipAction = ((...args: Parameters<AnimationMixer['clipAction']>) => {
    const action = clipAction(...args);
    if (action) allocated.add(action);
    return action;
  }) as AnimationMixer['clipAction'];
  const actions = new Map(gltf.animations.map(clip => [clip.name.toLowerCase(), mixer.clipAction(clip)]));
  const originalActions = new Set(allocated), jump = actions.get('jump')!;
  jump.setLoop(LoopOnce, 1); jump.clampWhenFinished = true;
  const blend = new CharacterBlend(actions);
  const bones: Bone[] = []; model.traverse(object => { if (object instanceof Bone) bones.push(object); });
  assert.equal(bones.length, 18);
  const advance = (name: BaseAnimationName, frames: number) => {
    for (let frame = 0; frame < frames; frame++) {
      blend.update(name, 1, 1 / 120); mixer.update(1 / 120);
      const weights = [...allocated].filter(action => action.isScheduled() && action.enabled).map(action => action.getEffectiveWeight());
      assert.ok(weights.every(weight => Number.isFinite(weight) && weight >= 0 && weight <= 1));
      assert.ok(Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 1) < 1e-10, 'Held and replayed poses preserve unit total weight');
    }
  };
  blend.update('idle', 1, 0); mixer.update(0);
  for (let replay = 0; replay < 3; replay++) {
    advance('jump', Math.ceil(jump.getClip().duration * 120) + 24);
    assert.equal(jump.paused, true, 'Use the actual completed, clamped one-shot state');
    assert.equal(jump.time, jump.getClip().duration);
    advance('idle', 6);
    assert.ok(jump.getEffectiveWeight() > .5, 'The completed pose still contributes after a short landing');
    model.updateWorldMatrix(true, true);
    const before = bones.map(bone => bone.matrixWorld.toArray());

    blend.update('jump', 1, 0); mixer.update(0); model.updateWorldMatrix(true, true);

    bones.forEach((bone, index) => assert.ok(bone.matrixWorld.elements.every((value, component) => Math.abs(value - before[index][component]) < 1e-6), `Replay cannot teleport ${bone.name}`));
    assert.equal(blend.target, jump);
    assert.equal(jump.paused, false, 'A new jump must leave the completed paused state');
    assert.equal(jump.time, 0, 'The new one-shot begins at its authored start');
    advance('jump', 6);
    assert.ok(jump.time > .04 && jump.time < .06, 'Playback actually advances through the new jump');
    assert.ok(jump.getEffectiveWeight() > 0, 'The new motion becomes visible');
    advance('jump', 18);
    const heldActions = [...allocated].filter(action => !originalActions.has(action));
    assert.equal(heldActions.length, 1, 'Repeated land/jump cycles reuse one bounded held-pose action');
    assert.equal(heldActions[0].getEffectiveWeight(), 0, 'The completed pose fully leaves the blend');
    assert.equal(heldActions[0].enabled, false);
    assert.equal(jump.getEffectiveWeight(), 1);
    assert.equal(jump.paused, false);
  }
  mixer.stopAllAction(); mixer.uncacheRoot(model);
});
