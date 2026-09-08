import * as THREE from 'three';

export interface LegContact {
  /** Remove last frame's procedural rotations before AnimationMixer evaluates. */
  restore(): void;
  /** Constrain boots during a grounded crossfade; floorY is the actor's support plane. */
  apply(floorY: number): void;
}

interface Leg {
  thigh: THREE.Bone;
  shin: THREE.Bone;
  foot: THREE.Bone;
  sole: Float64Array;
  thighBase: THREE.Quaternion;
  shinBase: THREE.Quaternion;
  footBase: THREE.Quaternion;
  bend: THREE.Vector3;
  corrected: boolean;
}

/** Two-bone contact correction for blended poses, without moving the actor or pelvis.
 * Sole points come from rigidly weighted exported geometry, not an approximate
 * ankle offset. Production skins use attached binding, so foot.matrixWorld maps
 * these bind-local points directly to their actual rendered world positions.
 */
export function createLegContact(model: THREE.Object3D): LegContact {
  const legs: Leg[] = [];
  const point = new THREE.Vector3();
  for (const side of ['l', 'r']) {
    const thigh = model.getObjectByName(`thigh_${side}`);
    const shin = model.getObjectByName(`shin_${side}`);
    const foot = model.getObjectByName(`foot_${side}`);
    if (!(thigh instanceof THREE.Bone) || !(shin instanceof THREE.Bone) || !(foot instanceof THREE.Bone)) continue;
    const points: number[] = [], unique = new Set<string>();
    model.traverse(object => {
      if (!(object instanceof THREE.SkinnedMesh) || object.bindMode !== THREE.AttachedBindMode) return;
      const joint = object.skeleton.bones.indexOf(foot);
      if (joint < 0) return;
      const positions = object.geometry.attributes.position;
      const indices = object.geometry.attributes.skinIndex;
      const weights = object.geometry.attributes.skinWeight;
      if (!positions || !indices || !weights) return;
      for (let index = 0; index < positions.count; index++) {
        let rigid = false;
        for (let lane = 0; lane < 4; lane++) {
          if (indices.getComponent(index, lane) === joint && weights.getComponent(index, lane) >= 1 - 1e-6) rigid = true;
        }
        if (!rigid) continue;
        point.fromBufferAttribute(positions, index).applyMatrix4(object.bindMatrix).applyMatrix4(object.skeleton.boneInverses[joint]!);
        // UV seams and split normals duplicate vertices. Deduplicate once at load.
        const key = `${Math.round(point.x * 1e7)},${Math.round(point.y * 1e7)},${Math.round(point.z * 1e7)}`;
        if (unique.has(key)) continue;
        unique.add(key); points.push(point.x, point.y, point.z);
      }
    });
    if (!points.length) continue;
    legs.push({ thigh, shin, foot, sole: new Float64Array(points), thighBase: new THREE.Quaternion(),
      shinBase: new THREE.Quaternion(), footBase: new THREE.Quaternion(), bend: new THREE.Vector3(0, 0, -1), corrected: false });
  }

  // Reused scratch state: no per-frame arrays, vectors, quaternions or closures.
  const hip = new THREE.Vector3(), knee = new THREE.Vector3(), ankle = new THREE.Vector3();
  const target = new THREE.Vector3(), axis = new THREE.Vector3(), pole = new THREE.Vector3();
  const targetKnee = new THREE.Vector3(), from = new THREE.Vector3(), to = new THREE.Vector3();
  const parentRotation = new THREE.Quaternion(), desiredRotation = new THREE.Quaternion();
  const delta = new THREE.Quaternion(), footRotation = new THREE.Quaternion();

  function orient(bone: THREE.Bone, start: THREE.Vector3, end: THREE.Vector3): void {
    from.copy(start).normalize(); to.copy(end).normalize();
    bone.getWorldQuaternion(desiredRotation).normalize();
    delta.setFromUnitVectors(from, to).multiply(desiredRotation);
    bone.parent!.getWorldQuaternion(parentRotation).normalize().invert();
    bone.quaternion.copy(parentRotation.multiply(delta)).normalize();
    bone.updateWorldMatrix(false, true);
  }

  return {
    restore() {
      for (const leg of legs) {
        if (!leg.corrected) continue;
        leg.thigh.quaternion.copy(leg.thighBase);
        leg.shin.quaternion.copy(leg.shinBase);
        leg.foot.quaternion.copy(leg.footBase);
        leg.corrected = false;
      }
    },
    apply(floorY) {
      if (!Number.isFinite(floorY)) return;
      model.updateWorldMatrix(true, true);
      for (const leg of legs) {
        const matrix = leg.foot.matrixWorld.elements;
        let minimum = Infinity;
        for (let index = 0; index < leg.sole.length; index += 3) {
          minimum = Math.min(minimum, matrix[1]! * leg.sole[index]! + matrix[5]! * leg.sole[index + 1]! + matrix[9]! * leg.sole[index + 2]! + matrix[13]!);
        }
        const lift = floorY + .006 - minimum;
        if (!(lift > 1e-6)) continue;
        leg.thigh.getWorldPosition(hip); leg.shin.getWorldPosition(knee); leg.foot.getWorldPosition(ankle);
        const upperLength = hip.distanceTo(knee), lowerLength = knee.distanceTo(ankle);
        if (!(upperLength > 1e-6 && lowerLength > 1e-6)) continue;
        target.copy(ankle); target.y += lift;
        axis.copy(target).sub(hip);
        const targetDistance = axis.length();
        if (!(targetDistance > 1e-6)) continue;
        axis.divideScalar(targetDistance);
        const distance = THREE.MathUtils.clamp(targetDistance, Math.abs(upperLength - lowerLength) + 1e-6, upperLength + lowerLength - 1e-6);
        target.copy(hip).addScaledVector(axis, distance);
        pole.copy(knee).sub(hip); pole.addScaledVector(axis, -pole.dot(axis));
        if (pole.lengthSq() < 1e-10) {
          pole.copy(leg.bend).addScaledVector(axis, -leg.bend.dot(axis));
          if (pole.lengthSq() < 1e-10) {
            pole.set(1, 0, 0); pole.addScaledVector(axis, -pole.dot(axis));
          }
        }
        pole.normalize(); leg.bend.copy(pole);
        const along = (upperLength * upperLength - lowerLength * lowerLength + distance * distance) / (2 * distance);
        targetKnee.copy(hip).addScaledVector(axis, along).addScaledVector(pole, Math.sqrt(Math.max(0, upperLength * upperLength - along * along)));
        leg.thighBase.copy(leg.thigh.quaternion); leg.shinBase.copy(leg.shin.quaternion); leg.footBase.copy(leg.foot.quaternion);
        leg.corrected = true;
        leg.foot.getWorldQuaternion(footRotation).normalize();
        orient(leg.thigh, from.copy(knee).sub(hip), to.copy(targetKnee).sub(hip));
        leg.shin.getWorldPosition(knee); leg.foot.getWorldPosition(ankle);
        orient(leg.shin, from.copy(ankle).sub(knee), to.copy(target).sub(knee));
        leg.foot.parent!.getWorldQuaternion(parentRotation).normalize().invert();
        leg.foot.quaternion.copy(parentRotation.multiply(footRotation)).normalize();
        leg.foot.updateWorldMatrix(false, true);
      }
    },
  };
}
