import { LoopOnce, type AnimationAction } from 'three';

export type BaseAnimationName = 'idle' | 'walk' | 'run' | 'jump' | 'aim';

interface BaseAction {
  name: BaseAnimationName;
  action: AnimationAction;
  weight: number;
  fromWeight: number;
  gait: boolean;
  donor?: boolean;
}

const BASE_NAMES: readonly BaseAnimationName[] = ['idle', 'walk', 'run', 'jump', 'aim'];

/** Owns the five base poses; additive weapon actions remain independent.
 * Call update before AnimationMixer.update. Interruptions start from the current
 * weight vector, so a partially faded pose never jumps back to full strength.
 */
export class CharacterBlend {
  private readonly actions: BaseAction[] = [];
  private readonly duration: number;
  private selected: BaseAction | null = null;
  private jumpDonor: BaseAction | null = null;
  private remaining = 0;

  constructor(actions: ReadonlyMap<string, AnimationAction>, transitionSeconds = .16) {
    this.duration = Number.isFinite(transitionSeconds) ? Math.max(0, transitionSeconds) : .16;
    for (const name of BASE_NAMES) {
      const action = actions.get(name);
      if (!action) continue;
      const weight = action.isScheduled() && action.enabled ? action.getEffectiveWeight() : 0;
      this.actions.push({ name, action, weight, fromWeight: weight, gait: name === 'walk' || name === 'run' });
      if (!this.selected || name === 'idle') this.selected = this.actions[this.actions.length - 1]!;
    }
    if (!this.selected) return;
    this.captureWeights();
    for (const entry of this.actions) {
      entry.action.stopFading().stopWarping();
      entry.action.enabled = entry.weight > 0 || entry === this.selected;
      entry.action.setEffectiveWeight(entry.weight);
      if (entry.weight > 0) entry.action.play();
    }
  }

  get target(): AnimationAction | null { return this.selected?.action ?? null; }
  get transitionRemaining(): number { return this.remaining; }

  update(name: BaseAnimationName, playbackRate: number, dt: number): void {
    if (!this.selected) return;
    let next = this.selected;
    for (const entry of this.actions) if (entry.name === name && !entry.donor) { next = entry; break; }
    if (next !== this.selected) {
      this.captureWeights();
      if (next.name === 'jump' && next.weight > 0 && next.action.paused && next.action.time >= next.action.getClip().duration) {
        this.holdCompletedJump(next);
      }
      // All surviving gait actions share a phase. An incoming gait can inherit
      // it, but an action already contributing must keep its existing time.
      let phaseSource: BaseAction | null = null;
      if (next.gait && next.weight === 0) {
        for (const entry of this.actions) {
          if (entry.gait && entry.weight > 0 && (!phaseSource || entry.weight > phaseSource.weight)) phaseSource = entry;
        }
      }
      if (next.weight === 0) {
        next.action.reset().setEffectiveWeight(0).play();
        if (phaseSource) next.action.time = phaseSource.action.time / phaseSource.action.getClip().duration * next.action.getClip().duration;
      }
      this.selected = next;
      this.remaining = this.duration;
    }

    const rate = Number.isFinite(playbackRate) ? playbackRate : 1;
    if (this.selected.gait) {
      const targetDuration = this.selected.action.getClip().duration;
      const phase = targetDuration > 0 ? this.selected.action.time / targetDuration : 0;
      for (const entry of this.actions) {
        if (!entry.gait || (entry.weight === 0 && entry.fromWeight === 0 && entry !== this.selected)) continue;
        const duration = entry.action.getClip().duration;
        entry.action.time = phase * duration;
        entry.action.paused = false;
        entry.action.setEffectiveTimeScale(targetDuration > 0 ? rate * duration / targetDuration : rate);
      }
    } else this.selected.action.setEffectiveTimeScale(rate);

    this.remaining = Math.max(0, this.remaining - (Number.isFinite(dt) ? Math.max(0, dt) : 0));
    const progress = this.duration > 0 ? 1 - this.remaining / this.duration : 1;
    for (const entry of this.actions) {
      entry.weight = entry.fromWeight * (1 - progress) + (entry === this.selected ? progress : 0);
      entry.action.enabled = entry.weight > 0 || entry === this.selected;
      entry.action.setEffectiveWeight(entry.weight);
      // Disabling a completed source keeps its bindings available without
      // restoring an unrelated original pose over this frame's procedural work.
      if (entry.weight > 0 && !entry.action.isScheduled()) entry.action.play();
    }
  }

  private captureWeights(): void {
    let total = 0;
    for (const entry of this.actions) {
      entry.weight = entry.action.isScheduled() && entry.action.enabled ? Math.max(0, entry.action.getEffectiveWeight()) : 0;
      total += entry.weight;
    }
    for (const entry of this.actions) {
      entry.weight = total > 0 ? entry.weight / total : entry === this.selected ? 1 : 0;
      entry.fromWeight = entry.weight;
    }
  }

  private holdCompletedJump(jump: BaseAction): void {
    // One bounded extra action holds the exact outgoing completed pose while
    // the original one-shot restarts. Reuse it for every later jump replay.
    if (!this.jumpDonor) {
      const clip = jump.action.getClip().clone();
      clip.name = 'JumpCompletedPose';
      const action = jump.action.getMixer().clipAction(clip).setLoop(LoopOnce, 1);
      action.clampWhenFinished = true;
      this.jumpDonor = { name: 'jump', action, weight: 0, fromWeight: 0, gait: false, donor: true };
      this.actions.push(this.jumpDonor);
    }
    const donor = this.jumpDonor;
    donor.weight += jump.weight;
    donor.fromWeight += jump.fromWeight;
    donor.action.reset().setEffectiveWeight(donor.weight).play();
    donor.action.time = jump.action.time;
    donor.action.paused = true;
    jump.weight = 0;
    jump.fromWeight = 0;
    jump.action.setEffectiveWeight(0);
  }
}
