import type { InputController } from './InputController';

type MotionConstructor = typeof DeviceMotionEvent & { requestPermission?: () => Promise<string> };
export async function requestGyroscope(): Promise<boolean> {
  if (!window.isSecureContext || typeof window.DeviceMotionEvent === 'undefined') return false;
  const motion = window.DeviceMotionEvent as MotionConstructor;
  try { return motion.requestPermission ? await motion.requestPermission() === 'granted' : true; }
  catch { return false; }
}

/** Rotation rates avoid compass wrap and calibration jumps. Reproject device
 * axes into the current screen orientation; clip stale/invalid sample intervals. */
export function gyroDelta(beta: number | null, gamma: number | null, interval: number, angle: number) {
  if (beta === null || gamma === null || ![beta, gamma, interval, angle].every(Number.isFinite) || interval <= 0 || interval > 100) return { yaw: 0, pitch: 0 };
  const radians = Math.PI / 180, orientation = angle * radians;
  const dt = Math.min(interval, 33.34) / 1000;
  const b = Math.max(-400, Math.min(400, beta)), g = Math.max(-400, Math.min(400, gamma));
  return { yaw: -(g * Math.cos(orientation) + b * Math.sin(orientation)) * radians * dt,
    pitch: (b * Math.cos(orientation) - g * Math.sin(orientation)) * radians * dt };
}
export class GyroscopeInput {
  private abort = new AbortController();
  constructor(input: InputController) {
    window.addEventListener('devicemotion', event => {
      if (!event.rotationRate) return;
      const angle = screen.orientation?.angle ?? (window as Window & { orientation?: number }).orientation ?? 0;
      const delta = gyroDelta(event.rotationRate.beta, event.rotationRate.gamma, event.interval, angle);
      input.applyGyroscope(delta.yaw, delta.pitch);
    }, { signal: this.abort.signal });
  }
  dispose() { this.abort.abort(); }
}
