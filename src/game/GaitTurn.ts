import { Quaternion, Vector3, type Bone } from 'three';

/** A small directional dead band keeps joystick noise from reversing a gait. */
export class GaitDirection {
  private backwards = false;

  update(forward: number, speed: number): boolean {
    if (speed <= .3) this.backwards = false;
    else if (forward < -speed * .35) this.backwards = true;
    else if (forward > -speed * .15) this.backwards = false;
    return this.backwards;
  }
}

/** Turn the legs toward travel while preserving the animated upper-body aim.
 * Captured pelvic lean means a bone's local Y is not necessarily world up. */
export function createGaitTurn() {
  const worldUp = new Vector3(0, 1, 0);
  const axis = new Vector3();
  const parentRotation = new Quaternion();
  const upperWorldRotation = new Quaternion();
  const turn = new Quaternion();

  return (pelvis: Bone, upperSpine: Bone, radians: number) => {
    upperSpine.getWorldQuaternion(upperWorldRotation).normalize();
    if (pelvis.parent) pelvis.parent.getWorldQuaternion(parentRotation).normalize().invert();
    else parentRotation.identity();
    axis.copy(worldUp).applyQuaternion(parentRotation);
    pelvis.quaternion.premultiply(turn.setFromAxisAngle(axis, -radians));

    // The parent now contains the turn. Re-express the original world aim in
    // that frame; normalization also handles Float32 animation-key precision.
    if (upperSpine.parent) upperSpine.parent.getWorldQuaternion(parentRotation).normalize().invert();
    else parentRotation.identity();
    upperSpine.quaternion.copy(parentRotation).multiply(upperWorldRotation).normalize();
  };
}
