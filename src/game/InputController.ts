import type { InputFrame, Slot, StreakId } from '../../shared/protocol';

export type AimMode = 'hold' | 'toggle';
export type SprintMode = 'hold' | 'toggle' | 'auto';
export interface InputSettings {
  sensitivity: number;
  /** Look-speed multiplier while aimed down sights (0.3..2). Zoom is compensated separately. */
  adsSensitivity: number;
  invertY: boolean; firingMode: 'simple' | 'advanced'; gyroscope: boolean; gyroSensitivity: number;
  aimMode: AimMode; crouchMode: AimMode; sprintMode: SprintMode;
}
export type InputAction = 'fire' | 'aim' | 'jump' | 'sprint' | 'reload' | 'crouch' | 'melee' | 'grenade';
/** On-screen controls carry `data-touch="<role>"`; see TouchGestures. */
export type TouchRole = 'move' | 'look' | 'fire' | 'fire-left' | 'jump' | 'reload' | 'grenade' | 'melee';
type Toggleable = 'aim' | 'crouch' | 'sprint';
type Pulse = 'fire' | 'jump' | 'reload' | 'crouch' | 'melee' | 'grenade';

/** Looking further up or down than this is clamped, including recoil and flinch. */
export const PITCH_LIMIT = 1.3;
/** Two sprint presses (or two full stick pushes) this close together engage the dash. */
export const DOUBLE_TAP_MS = 300;
const AUTO_SPRINT_ENGAGE = 0.95, AUTO_SPRINT_HOLD = 0.75, WHEEL_REPEAT_MS = 140;
const ACTIONS: readonly InputAction[] = ['fire', 'aim', 'jump', 'sprint', 'reload', 'crouch', 'melee', 'grenade'];
const PULSES: readonly Pulse[] = ['fire', 'jump', 'reload', 'crouch', 'melee', 'grenade'];
const forwardish = (x: number, z: number) => z > 0.3 && Math.abs(x) <= z * 1.2;
const finitePoint = (value: { x: number; z: number } | null | undefined): value is { x: number; z: number } =>
  !!value && Number.isFinite(value.x) && Number.isFinite(value.z);

/** One input vocabulary for keyboard/mouse and the accessible touch HUD. Physical presses and
 * releases go through `setAction`; aim, crouch and sprint follow their hold/toggle settings.
 * `toggle` flips a latched state directly (touch buttons) and returns the new state. */
export class InputController {
  yaw = 0;
  pitch = 0;
  slot: Slot = 1;
  onLockChange?: (locked: boolean) => void;
  private canvas: HTMLCanvasElement | null = null;
  private sequence = 0;
  private keys = new Set<string>();
  private actions: Record<InputAction, boolean> = { fire: false, aim: false, jump: false, sprint: false, reload: false, crouch: false, melee: false, grenade: false };
  private latched: Record<Toggleable, boolean> = { aim: false, crouch: false, sprint: false };
  /** Short taps survive release until the next network frame. */
  private pulses: Record<Pulse, boolean> = { fire: false, jump: false, reload: false, crouch: false, melee: false, grenade: false };
  private crouchLatchedThisFrame = false;
  private lastSprintPress = -Infinity;
  private holdDash = false;
  private toggleDash = false;
  private autoSprint = false;
  private autoDash = false;
  private lastAutoPush = -Infinity;
  private wasForward = false;
  private touchX = 0;
  private touchZ = 0;
  private automaticFire = false;
  private fireAim = false;
  private fireBlocked = false;
  private aimZoom = 1;
  private aimed = false;
  private rewards: StreakId[] = [];
  private streakPulse: StreakId | null = null;
  private streakTarget: { x: number; z: number } | null = null;
  private targeting = false;
  private releasingForTargeting = false;
  private viewTime = 0;
  private lastWheel = -Infinity;
  private paused = false;
  private gameplayBlocked = false;
  private pendingLock: { finish: (locked: boolean) => void } | null = null;
  private focused = document.hasFocus();
  private disposed = false;
  private resetListeners = new Set<() => void>();
  private touchActive = false;
  private settings: InputSettings = {
    sensitivity: 1, adsSensitivity: 1, invertY: false, firingMode: 'simple', gyroscope: false, gyroSensitivity: 1,
    aimMode: 'hold', crouchMode: 'toggle', sprintMode: 'hold',
  };
  private abort = new AbortController();
  private readonly clock: () => number;

  constructor(canvas?: HTMLCanvasElement, settings?: Partial<InputSettings>, options: { clock?: () => number } = {}) {
    this.clock = options.clock ?? (() => performance.now());
    this.setSettings(settings ?? {});
    const listen = { signal: this.abort.signal };
    window.addEventListener('keydown', this.keyDown, listen);
    window.addEventListener('keyup', this.keyUp, listen);
    window.addEventListener('mousemove', this.mouseMove, listen);
    window.addEventListener('mouseup', this.mouseUp, listen);
    window.addEventListener('blur', this.blur, listen);
    window.addEventListener('focus', this.focus, listen);
    window.addEventListener('pagehide', this.clearEvent, listen);
    window.addEventListener('orientationchange', this.clearEvent, listen);
    document.addEventListener('visibilitychange', this.visibilityChange, listen);
    document.addEventListener('pointerlockchange', this.lockChange, listen);
    document.addEventListener('pointerlockerror', this.lockError, listen);
    if (canvas) this.attach(canvas);
  }

  get locked() { return !!this.canvas && document.pointerLockElement === this.canvas; }
  get isTouch() { return this.touchActive || window.matchMedia('(pointer: coarse)').matches; }
  get isPaused() { return this.paused; }
  get canEngage() { return !this.disposed && !this.paused && this.focused && !document.hidden; }
  get acceptsInput() { return this.canEngage && !this.gameplayBlocked; }
  get firingMode() { return this.settings.firingMode; }
  /** The player picked the mortar and must choose a spot on the HUD map (Escape cancels). */
  get mortarTargeting() { return this.targeting; }
  /** Latched toggle states, for touch buttons that show whether they are on. */
  get toggled(): Readonly<Record<Toggleable, boolean>> { return this.latched; }

  /** Touch UI must clear its captured pointers and toggles whenever controls are cancelled. */
  subscribeReset(listener: () => void) {
    this.resetListeners.add(listener);
    return () => { this.resetListeners.delete(listener); };
  }

  attach(canvas: HTMLCanvasElement) {
    if (this.canvas === canvas) return;
    this.canvas?.removeEventListener('mousedown', this.mouseDown);
    this.canvas?.removeEventListener('contextmenu', this.contextMenu);
    this.canvas?.removeEventListener('wheel', this.wheel);
    this.canvas = canvas;
    canvas.addEventListener('mousedown', this.mouseDown);
    canvas.addEventListener('contextmenu', this.contextMenu);
    canvas.addEventListener('wheel', this.wheel, { passive: false });
  }

  setSettings(settings: Partial<InputSettings>) {
    const previous = this.settings;
    if (settings.firingMode && settings.firingMode !== previous.firingMode) this.clear();
    const next = { ...previous, ...settings };
    next.sensitivity = Number.isFinite(next.sensitivity) ? Math.max(0.15, Math.min(3, next.sensitivity)) : 1;
    next.adsSensitivity = Number.isFinite(next.adsSensitivity) ? Math.max(0.3, Math.min(2, next.adsSensitivity)) : 1;
    next.gyroSensitivity = Number.isFinite(next.gyroSensitivity) ? Math.max(.2, Math.min(2.5, next.gyroSensitivity)) : 1;
    if (next.aimMode !== 'hold' && next.aimMode !== 'toggle') next.aimMode = previous.aimMode;
    if (next.crouchMode !== 'hold' && next.crouchMode !== 'toggle') next.crouchMode = previous.crouchMode;
    if (next.sprintMode !== 'hold' && next.sprintMode !== 'toggle' && next.sprintMode !== 'auto') next.sprintMode = previous.sprintMode;
    // Switching away from a toggle mode must not leave its latch stuck on.
    if (next.aimMode !== previous.aimMode) this.latched.aim = false;
    if (next.crouchMode !== previous.crouchMode) this.latched.crouch = false;
    if (next.sprintMode !== previous.sprintMode) { this.latched.sprint = false; this.toggleDash = false; }
    this.settings = next;
  }

  setView(yaw: number, pitch = 0) { this.yaw = yaw; this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch)); }
  /** Server spawn selection must apply even while a countdown/pause disables regular controls. */
  resetSpawnView(yaw: number, pitch = 0) {
    this.setView(yaw, pitch); this.slot = 1;
    this.latched.aim = false; this.latched.crouch = false; this.latched.sprint = false; this.toggleDash = false;
  }
  resumeSequence(lastInputSeq: number) { this.sequence = Math.max(this.sequence, lastInputSeq); }
  setSlot(slot: Slot) {
    if (!this.acceptsInput || (slot !== 1 && slot !== 2) || slot === this.slot) return;
    this.slot = slot; this.latched.aim = false;
  }
  /** Mouse wheel, Q and the touch swap button: primary and secondary trade places. */
  swapWeapon() { this.setSlot(this.slot === 1 ? 2 : 1); }

  setTouchMove(x: number, z: number) {
    // Releases are accepted even during a concurrent pause or death transition.
    if (x === 0 && z === 0) { this.touchX = 0; this.touchZ = 0; this.movementChanged(); return; }
    if (!this.acceptsInput) return;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    this.touchActive = true;
    const scale = Math.max(1, Math.hypot(x, z));
    this.touchX = x / scale;
    this.touchZ = z / scale;
    this.movementChanged();
  }
  setTouchLook(dx: number, dy: number) {
    if (!this.acceptsInput) return;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.touchActive = true;
    this.look(dx, dy, 0.0042);
  }
  /** A physical press (true) or release (false) of an on-screen or keyboard control. */
  setAction(action: InputAction, value: boolean) {
    if (!this.acceptsInput || !ACTIONS.includes(action)) return;
    // Explicit HUD actions are valid on hybrid touch laptops as well as coarse-pointer phones.
    this.touchActive = true;
    this.press(action, value);
  }
  cancelAction(action: InputAction) {
    if (!ACTIONS.includes(action)) return;
    this.actions[action] = false;
    if ((PULSES as readonly string[]).includes(action)) this.pulses[action as Pulse] = false;
    if (action === 'sprint') this.holdDash = false;
  }
  /** Flip a latched aim, crouch or sprint (touch buttons). Returns whether it is now on.
   * A second sprint toggle within DOUBLE_TAP_MS of switching it on engages the dash instead. */
  toggle(action: Toggleable): boolean {
    if (!this.acceptsInput) return this.latched[action];
    this.touchActive = true;
    if (action === 'sprint') this.sprintToggle(this.clock());
    else this.flip(action);
    return this.latched[action];
  }

  /** Uses an earned reward. The mortar first asks for a spot on the HUD map. */
  useStreak(reward: StreakId) {
    if (!this.acceptsInput || (reward !== 'recon' && reward !== 'mortar' && reward !== 'drone')) return;
    if (reward !== 'mortar') { this.streakPulse = reward; this.streakTarget = null; this.cancelTargeting(); return; }
    this.targeting = true;
    // The map needs a free cursor; keep targeting across this deliberate release.
    if (this.locked) { this.releasingForTargeting = true; document.exitPointerLock(); }
  }
  /** The mortar target picked on the HUD map, or null to cancel targeting. */
  setStreakTarget(target: { x: number; z: number } | null) {
    if (!finitePoint(target)) { this.cancelTargeting(); return; }
    if (!this.acceptsInput) return;
    this.streakPulse = 'mortar'; this.streakTarget = { x: target.x, z: target.z };
    this.targeting = false;
  }
  /** Earned, unused rewards from the latest snapshot, oldest first; key 4 uses the first. */
  setRewards(rewards: readonly StreakId[]) {
    this.rewards = [...rewards];
    if (this.targeting && !this.rewards.includes('mortar')) this.cancelTargeting();
  }
  /** Server time of the world being drawn; every frame carries it for lag compensation. */
  setViewTime(ms: number) { if (Number.isFinite(ms)) this.viewTime = Math.round(ms); }
  /** Recoil and flinch move the actual view, so the server traces exactly what the player saw. */
  addViewKick(yaw: number, pitch: number) {
    if (this.disposed || !Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
    this.yaw += yaw;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + pitch));
  }
  /** The weapon is lowered against a wall (or otherwise cannot fire); fire is withheld. */
  setFireBlocked(blocked: boolean) { this.fireBlocked = blocked; }
  /** Zoom divisor and aimed state for look speed: aiming applies adsSensitivity, zoom slows the view to match. */
  setAimZoom(zoom: number, aimed: boolean) {
    this.aimZoom = Number.isFinite(zoom) && zoom >= 1 ? zoom : 1;
    this.aimed = aimed;
  }

  setAutomaticFire(value: boolean) {
    this.automaticFire = value && this.acceptsInput && this.isTouch && this.settings.firingMode === 'simple';
  }
  setFireAim(value: boolean) { this.fireAim = value && this.acceptsInput; }
  applyGyroscope(yaw: number, pitch: number) {
    if (!this.acceptsInput || !this.settings.gyroscope || !Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
    this.touchActive = true;
    const scale = this.settings.gyroSensitivity * this.lookMultiplier();
    this.yaw += yaw * scale;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + pitch * scale * (this.settings.invertY ? -1 : 1)));
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    if (paused) { this.clear(); if (this.locked) document.exitPointerLock(); }
  }

  /** Preparation/countdown can retain the mouse, but neither held nor queued actions cross the boundary. */
  setGameplayBlocked(blocked: boolean) {
    if (this.gameplayBlocked === blocked) return;
    this.gameplayBlocked = blocked;
    this.clear();
  }

  /** Must be called in a user gesture. A fulfilled browser request alone is not capture confirmation. */
  requestPointerLock(): Promise<boolean> {
    if (!this.canvas || !this.canEngage) return Promise.resolve(false);
    if (this.locked) return Promise.resolve(true);
    this.pendingLock?.finish(false);
    return new Promise(resolve => {
      const timer = setTimeout(() => pending.finish(false), 2500);
      const pending = { finish: (locked: boolean) => {
        if (this.pendingLock !== pending) return;
        this.pendingLock = null;
        clearTimeout(timer);
        resolve(locked);
      } };
      this.pendingLock = pending;
      try {
        const request = this.canvas!.requestPointerLock();
        if (request && typeof request.catch === 'function') void request.catch(() => pending.finish(false));
      } catch { pending.finish(false); }
    });
  }

  /** Networking consumes one sequence number. Rendering should call peek instead. */
  current(): InputFrame {
    const frame = { ...this.peek(), seq: ++this.sequence };
    for (const pulse of PULSES) this.pulses[pulse] = false;
    // Standing up to sprint releases a crouch toggle once the press itself (a slide) was sent.
    const sprinting = frame.sprint && !frame.aim && !frame.fire && !frame.grenade && forwardish(frame.moveX, frame.moveZ);
    if (sprinting && frame.crouch && !this.crouchLatchedThisFrame) this.latched.crouch = false;
    this.crouchLatchedThisFrame = false;
    this.streakPulse = null; this.streakTarget = null;
    return frame;
  }

  peek(): InputFrame {
    const enabled = this.acceptsInput && (this.locked || this.touchActive);
    const { x: mx, z: mz } = this.movement(enabled);
    const fire = enabled && !this.fireBlocked && (this.actions.fire || this.pulses.fire || this.automaticFire);
    const aim = enabled && (this.actions.aim || this.latched.aim || (this.fireAim && this.slot === 1));
    const sprint = enabled && this.sprintWanted();
    const frame: InputFrame = {
      seq: this.sequence, moveX: mx, moveZ: mz, yaw: this.yaw, pitch: this.pitch, slot: this.slot,
      fire, aim,
      jump: enabled && (this.actions.jump || this.pulses.jump || this.keys.has('Space')),
      sprint,
      reload: enabled && (this.actions.reload || this.pulses.reload || this.keys.has('KeyR')),
      crouch: enabled && (this.latched.crouch || this.pulses.crouch || (this.settings.crouchMode === 'hold' && (this.actions.crouch || this.keys.has('KeyC')))),
      dash: sprint && (this.holdDash || this.toggleDash || (this.settings.sprintMode === 'auto' && this.autoDash)),
      melee: enabled && (this.actions.melee || this.pulses.melee || this.keys.has('KeyV')),
      grenade: enabled && (this.actions.grenade || this.pulses.grenade || this.keys.has('KeyG')),
      // A mortar spot is picked with a free cursor, so rewards do not need pointer capture.
      streak: this.acceptsInput ? this.streakPulse : null,
      viewTime: this.viewTime,
    };
    if (frame.streak === 'mortar' && this.streakTarget) frame.streakTarget = { ...this.streakTarget };
    return frame;
  }

  private movement(enabled: boolean) {
    if (!enabled) return { x: 0, z: 0 };
    const mx = this.touchX + Number(this.keys.has('KeyD') || this.keys.has('ArrowRight')) - Number(this.keys.has('KeyA') || this.keys.has('ArrowLeft'));
    const mz = this.touchZ + Number(this.keys.has('KeyW') || this.keys.has('ArrowUp')) - Number(this.keys.has('KeyS') || this.keys.has('ArrowDown'));
    const scale = Math.max(1, Math.hypot(mx, mz));
    return { x: mx / scale, z: mz / scale };
  }
  private sprintHeld() { return this.actions.sprint || this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'); }
  private sprintWanted() {
    const mode = this.settings.sprintMode;
    // In toggle mode a held key does nothing by itself; only presses toggle.
    if (mode === 'toggle') return this.latched.sprint;
    if (mode === 'auto') return this.sprintHeld() || this.latched.sprint || (this.autoSprint && !this.latched.aim && !this.actions.aim);
    return this.sprintHeld() || this.latched.sprint;
  }
  private lookMultiplier() { return (this.aimed ? this.settings.adsSensitivity : 1) / this.aimZoom; }

  private press(action: InputAction, value: boolean) {
    const rising = value && !this.actions[action];
    const falling = !value && this.actions[action];
    this.actions[action] = value;
    // A toggled crouch is its own latch; only a hold-mode tap needs a pulse to reach the server.
    if (rising && (PULSES as readonly string[]).includes(action) && !(action === 'crouch' && this.settings.crouchMode === 'toggle')) this.pulses[action as Pulse] = true;
    if (action === 'aim' && rising) {
      if (this.settings.aimMode === 'toggle') { this.actions.aim = false; this.flip('aim'); }
      this.endToggledSprint();
    }
    if (action === 'crouch' && rising) {
      if (this.settings.crouchMode === 'toggle') { this.actions.crouch = false; this.flip('crouch'); }
      // Sliding (or crouching) ends a toggled sprint; the slide itself starts from the previous tick's sprint.
      this.endToggledSprint();
    }
    if (action === 'sprint') {
      if (rising) {
        if (this.settings.sprintMode === 'toggle') { this.actions.sprint = false; this.sprintToggle(this.clock()); }
        else this.sprintPress(this.clock());
      }
      if (falling && !this.sprintHeld()) this.holdDash = false;
    }
    if (action === 'jump' && rising) this.latched.crouch = false;
    if (action === 'fire' && rising) this.endToggledSprint();
  }
  private flip(action: Toggleable) {
    this.latched[action] = !this.latched[action];
    if (action === 'crouch' && this.latched.crouch) this.crouchLatchedThisFrame = true;
    if (action === 'aim' && this.latched.aim) this.endToggledSprint();
  }
  /** Hold mode: the second of two presses within DOUBLE_TAP_MS dashes while it is held. */
  private sprintPress(now: number) {
    this.holdDash = now - this.lastSprintPress <= DOUBLE_TAP_MS;
    this.lastSprintPress = now;
    this.latched.aim = false;
  }
  private sprintToggle(now: number) {
    if (!this.latched.sprint) { this.latched.sprint = true; this.toggleDash = false; this.latched.aim = false; }
    else if (now - this.lastSprintPress <= DOUBLE_TAP_MS) this.toggleDash = true;
    else { this.latched.sprint = false; this.toggleDash = false; }
    this.lastSprintPress = now;
  }
  private endToggledSprint() { this.latched.sprint = false; this.toggleDash = false; }
  /** Auto sprint: the stick (or W) at the top edge sprints; a second push within DOUBLE_TAP_MS dashes.
   * A toggled sprint ends when forward movement stops. */
  private movementChanged() {
    const { x, z } = this.movement(true), now = this.clock();
    const engaged = z >= (this.autoSprint ? AUTO_SPRINT_HOLD : AUTO_SPRINT_ENGAGE) && forwardish(x, z);
    if (engaged && !this.autoSprint) { this.autoDash = now - this.lastAutoPush <= DOUBLE_TAP_MS; this.lastAutoPush = now; }
    if (!engaged) this.autoDash = false;
    this.autoSprint = engaged;
    const forward = forwardish(x, z);
    if (this.wasForward && !forward) this.endToggledSprint();
    this.wasForward = forward;
  }
  private cancelTargeting() { this.targeting = false; }

  private look(dx: number, dy: number, scale: number) {
    // Positive yaw is clockwise toward +X, and positive pitch looks upward.
    const speed = scale * this.settings.sensitivity * this.lookMultiplier();
    this.yaw += dx * speed;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - dy * speed * (this.settings.invertY ? -1 : 1)));
  }
  private keyDown = (event: KeyboardEvent) => {
    if (event.code === 'Escape') {
      if (this.targeting) { this.cancelTargeting(); return; }
      if (this.locked) document.exitPointerLock();
      this.clear();
      return;
    }
    if (!this.acceptsInput || !this.locked || (event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))) return;
    // An OS repeat after countdown/focus reset is still the old physical gesture.
    if (event.repeat && !this.keys.has(event.code)) return;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(event.code)) event.preventDefault();
    if (!event.repeat) {
      if (event.code === 'Digit1') this.setSlot(1);
      if (event.code === 'Digit2') this.setSlot(2);
      if (event.code === 'KeyQ') this.swapWeapon();
      if (event.code === 'Digit4' && this.rewards.length) this.useStreak(this.rewards[0]!);
      const action = event.code === 'Space' ? 'jump' : event.code === 'KeyR' ? 'reload' : event.code === 'KeyC' ? 'crouch'
        : event.code === 'KeyV' ? 'melee' : event.code === 'KeyG' ? 'grenade' : event.code === 'ShiftLeft' || event.code === 'ShiftRight' ? 'sprint' : null;
      if (action && !this.keys.has(event.code)) this.keyPress(action);
    }
    this.keys.add(event.code);
    if (/^(KeyW|KeyA|KeyS|KeyD|Arrow(Up|Down|Left|Right))$/.test(event.code)) this.movementChanged();
  };
  /** Keyboard presses share the touch semantics without marking the device as touch. */
  private keyPress(action: InputAction) {
    if (action === 'sprint') { if (this.sprintHeld()) return; this.press('sprint', true); this.actions.sprint = false; return; }
    const held = this.actions[action];
    this.press(action, true);
    this.actions[action] = held;
  }
  private keyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
    if ((event.code === 'ShiftLeft' || event.code === 'ShiftRight') && !this.sprintHeld()) this.holdDash = false;
    if (/^(KeyW|KeyA|KeyS|KeyD|Arrow(Up|Down|Left|Right))$/.test(event.code)) this.movementChanged();
  };
  private mouseMove = (event: MouseEvent) => { if (this.locked && this.acceptsInput) this.look(event.movementX, event.movementY, 0.0021); };
  private mouseDown = (event: MouseEvent) => {
    if (!this.acceptsInput) return;
    if (!this.locked) { if (event.button === 0) void this.requestPointerLock(); return; }
    if (event.button === 0) this.press('fire', true);
    if (event.button === 2) this.press('aim', true);
  };
  private mouseUp = (event: MouseEvent) => {
    if (event.button === 0) this.actions.fire = false;
    if (event.button === 2) this.actions.aim = false;
  };
  private wheel = (event: WheelEvent) => {
    if (!this.locked || !this.acceptsInput) return;
    event.preventDefault();
    const now = this.clock();
    // Trackpads report one gesture as many wheel events.
    if (Math.abs(event.deltaY) < 1 || now - this.lastWheel < WHEEL_REPEAT_MS) { this.lastWheel = now; return; }
    this.lastWheel = now;
    this.swapWeapon();
  };
  private contextMenu = (event: Event) => { event.preventDefault(); };
  private blur = () => { this.focused = false; this.clear(); };
  private focus = () => { this.focused = true; this.clear(); };
  private visibilityChange = () => { this.focused = document.hasFocus(); this.clear(); };
  private lockChange = () => {
    if (this.locked && !this.canEngage) document.exitPointerLock();
    if (!this.locked) {
      const keepTargeting = this.releasingForTargeting && this.targeting;
      this.releasingForTargeting = false;
      this.clear(keepTargeting);
    } else {
      // Returning to the game cancels an unfinished mortar pick.
      this.cancelTargeting();
      this.pendingLock?.finish(true);
    }
    this.onLockChange?.(this.locked);
  };
  private lockError = () => { this.releasingForTargeting = false; this.pendingLock?.finish(false); this.onLockChange?.(false); };
  private clearEvent = () => this.clear();
  private clear(keepTargeting = false) {
    this.pendingLock?.finish(false);
    this.keys.clear(); this.touchX = 0; this.touchZ = 0;
    this.automaticFire = false; this.fireAim = false;
    for (const pulse of PULSES) this.pulses[pulse] = false;
    for (const action of ACTIONS) this.actions[action] = false;
    this.latched.aim = false; this.latched.crouch = false; this.latched.sprint = false;
    this.holdDash = false; this.toggleDash = false; this.autoSprint = false; this.autoDash = false; this.wasForward = false;
    this.crouchLatchedThisFrame = false;
    this.streakPulse = null; this.streakTarget = null;
    if (!keepTargeting) this.targeting = false;
    for (const listener of [...this.resetListeners]) listener();
  }

  dispose() {
    this.disposed = true;
    this.resetListeners.clear();
    if (this.locked) document.exitPointerLock();
    this.abort.abort();
    this.canvas?.removeEventListener('mousedown', this.mouseDown);
    this.canvas?.removeEventListener('contextmenu', this.contextMenu);
    this.canvas?.removeEventListener('wheel', this.wheel);
    this.clear(); this.canvas = null;
  }
}
