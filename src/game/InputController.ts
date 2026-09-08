import type { InputFrame, Slot } from '../../shared/protocol';

export interface InputSettings { sensitivity: number; invertY: boolean }
type Action = 'fire' | 'aim' | 'jump' | 'sprint' | 'reload';

/** One input vocabulary for keyboard/mouse and the accessible touch HUD. */
export class InputController {
  yaw = 0;
  pitch = 0;
  slot: Slot = 1;
  onLockChange?: (locked: boolean) => void;
  private canvas: HTMLCanvasElement | null = null;
  private sequence = 0;
  private keys = new Set<string>();
  private actions: Record<Action, boolean> = { fire: false, aim: false, jump: false, sprint: false, reload: false };
  private pulses = { fire: false, jump: false, reload: false };
  private touchX = 0;
  private touchZ = 0;
  private paused = false;
  private focused = document.hasFocus();
  private disposed = false;
  private resetListeners = new Set<() => void>();
  private touchActive = false;
  private settings: InputSettings = { sensitivity: 1, invertY: false };
  private abort = new AbortController();

  constructor(canvas?: HTMLCanvasElement, settings?: Partial<InputSettings>) {
    this.setSettings(settings ?? {});
    const options = { signal: this.abort.signal };
    window.addEventListener('keydown', this.keyDown, options);
    window.addEventListener('keyup', this.keyUp, options);
    window.addEventListener('mousemove', this.mouseMove, options);
    window.addEventListener('mouseup', this.mouseUp, options);
    window.addEventListener('blur', this.blur, options);
    window.addEventListener('focus', this.focus, options);
    document.addEventListener('visibilitychange', this.visibilityChange, options);
    document.addEventListener('pointerlockchange', this.lockChange, options);
    if (canvas) this.attach(canvas);
  }

  get locked() { return !!this.canvas && document.pointerLockElement === this.canvas; }
  get isTouch() { return this.touchActive || window.matchMedia('(pointer: coarse)').matches; }
  get isPaused() { return this.paused; }
  get acceptsInput() { return !this.disposed && !this.paused && this.focused && !document.hidden; }

  /** Touch UI must clear its captured pointers and toggles whenever controls are cancelled. */
  subscribeReset(listener: () => void) {
    this.resetListeners.add(listener);
    return () => { this.resetListeners.delete(listener); };
  }

  attach(canvas: HTMLCanvasElement) {
    if (this.canvas === canvas) return;
    this.canvas?.removeEventListener('mousedown', this.mouseDown);
    this.canvas?.removeEventListener('contextmenu', this.contextMenu);
    this.canvas = canvas;
    canvas.addEventListener('mousedown', this.mouseDown);
    canvas.addEventListener('contextmenu', this.contextMenu);
  }

  setSettings(settings: Partial<InputSettings>) {
    this.settings = { ...this.settings, ...settings };
    this.settings.sensitivity = Math.max(0.15, Math.min(3, this.settings.sensitivity));
  }

  setView(yaw: number, pitch = 0) { this.yaw = yaw; this.pitch = Math.max(-1.2, Math.min(1.2, pitch)); }
  /** Server spawn selection must apply even while a countdown/pause disables regular controls. */
  resetSpawnView(yaw: number, pitch = 0) { this.setView(yaw, pitch); this.slot = 1; }
  resumeSequence(lastInputSeq: number) { this.sequence = Math.max(this.sequence, lastInputSeq); }
  setSlot(slot: Slot) { if (this.acceptsInput) this.slot = slot; }
  setTouchMove(x: number, z: number) {
    if (!this.acceptsInput) return;
    this.touchActive = true;
    const scale = Math.max(1, Math.hypot(x, z));
    this.touchX = x / scale;
    this.touchZ = z / scale;
  }
  setTouchLook(dx: number, dy: number) {
    if (!this.acceptsInput) return;
    this.touchActive = true;
    this.look(dx, dy, 0.0042);
  }
  setAction(action: Action, value: boolean) {
    if (!this.acceptsInput) return;
    // Explicit HUD actions are valid on hybrid touch laptops as well as coarse-pointer phones.
    this.touchActive = true;
    if (value && !this.actions[action] && (action === 'fire' || action === 'jump' || action === 'reload')) this.pulses[action] = true;
    this.actions[action] = value;
  }
  cancelAction(action: Action) {
    this.actions[action] = false;
    if (action === 'fire' || action === 'jump' || action === 'reload') this.pulses[action] = false;
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    if (paused) { this.clear(); if (this.locked) document.exitPointerLock(); }
  }

  requestPointerLock() {
    if (!this.canvas || !this.acceptsInput || this.isTouch || this.locked) return;
    try {
      const request = this.canvas.requestPointerLock();
      if (request && typeof request.catch === 'function') void request.catch(() => { this.onLockChange?.(false); });
    } catch { this.onLockChange?.(false); }
  }

  /** Networking consumes one sequence number. Rendering should call peek instead. */
  current(): InputFrame {
    const frame = { ...this.peek(), seq: ++this.sequence };
    this.pulses.fire = false; this.pulses.jump = false; this.pulses.reload = false;
    return frame;
  }

  peek(): InputFrame {
    const enabled = this.acceptsInput && (this.locked || this.touchActive);
    const mx = enabled ? this.touchX + Number(this.keys.has('KeyD') || this.keys.has('ArrowRight')) - Number(this.keys.has('KeyA') || this.keys.has('ArrowLeft')) : 0;
    const mz = enabled ? this.touchZ + Number(this.keys.has('KeyW') || this.keys.has('ArrowUp')) - Number(this.keys.has('KeyS') || this.keys.has('ArrowDown')) : 0;
    const scale = Math.max(1, Math.hypot(mx, mz));
    return {
      seq: this.sequence, moveX: mx / scale, moveZ: mz / scale, yaw: this.yaw, pitch: this.pitch, slot: this.slot,
      fire: enabled && (this.actions.fire || this.pulses.fire), aim: enabled && this.actions.aim,
      jump: enabled && (this.actions.jump || this.pulses.jump || this.keys.has('Space')),
      sprint: enabled && (this.actions.sprint || this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')),
      reload: enabled && (this.actions.reload || this.pulses.reload || this.keys.has('KeyR')),
    };
  }

  private look(dx: number, dy: number, scale: number) {
    // Positive yaw is clockwise toward +X, and positive pitch looks upward.
    this.yaw += dx * scale * this.settings.sensitivity;
    this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch - dy * scale * this.settings.sensitivity * (this.settings.invertY ? -1 : 1)));
  }
  private keyDown = (event: KeyboardEvent) => {
    if (event.code === 'Escape') {
      if (this.locked) document.exitPointerLock();
      this.clear();
      return;
    }
    if (!this.acceptsInput || !this.locked || (event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))) return;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(event.code)) event.preventDefault();
    if (event.code === 'Digit1') this.slot = 1;
    if (event.code === 'Digit2') this.slot = 2;
    if (event.code === 'Digit3') this.slot = 3;
    if (event.code === 'Space' && !event.repeat) this.pulses.jump = true;
    if (event.code === 'KeyR' && !event.repeat) this.pulses.reload = true;
    this.keys.add(event.code);
  };
  private keyUp = (event: KeyboardEvent) => { this.keys.delete(event.code); };
  private mouseMove = (event: MouseEvent) => { if (this.locked && this.acceptsInput) this.look(event.movementX, event.movementY, 0.0021); };
  private mouseDown = (event: MouseEvent) => {
    if (!this.acceptsInput) return;
    if (!this.locked) { if (event.button === 0) this.requestPointerLock(); return; }
    if (event.button === 0) { this.actions.fire = true; this.pulses.fire = true; }
    if (event.button === 2) this.actions.aim = true;
  };
  private mouseUp = (event: MouseEvent) => { if (event.button === 0) this.actions.fire = false; if (event.button === 2) this.actions.aim = false; };
  private contextMenu = (event: Event) => { event.preventDefault(); };
  private blur = () => { this.focused = false; this.clear(); };
  private focus = () => { this.focused = true; this.clear(); };
  private visibilityChange = () => { this.focused = document.hasFocus(); this.clear(); };
  private lockChange = () => { if (!this.locked) this.clear(); this.onLockChange?.(this.locked); };
  private clear = () => {
    this.keys.clear(); this.touchX = 0; this.touchZ = 0;
    this.pulses.fire = false; this.pulses.jump = false; this.pulses.reload = false;
    for (const action of Object.keys(this.actions) as Action[]) this.actions[action] = false;
    for (const listener of [...this.resetListeners]) listener();
  };

  dispose() {
    this.disposed = true;
    this.resetListeners.clear();
    if (this.locked) document.exitPointerLock();
    this.abort.abort();
    this.canvas?.removeEventListener('mousedown', this.mouseDown);
    this.canvas?.removeEventListener('contextmenu', this.contextMenu);
    this.clear(); this.canvas = null;
  }
}
