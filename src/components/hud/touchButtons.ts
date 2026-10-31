import type { InputFrame, StreakId } from '../../../shared/protocol';
import { STREAKS } from '../../../shared/weapons';
import type { HudFrame } from '../../game/hud';
import type { IconName } from '../Icon';
import { STREAK_ICONS } from '../labels';
import type { Rect, TouchLayout } from './touchLayout';

/** Buttons that stay on (toggle) or stay pressed while held (hold), per the player's settings. */
export type Latch = 'aim' | 'crouch' | 'sprint';
export const LATCHES: readonly Latch[] = ['aim', 'crouch', 'sprint'];
export type LatchMode = 'hold' | 'toggle';
export interface TouchButtonSettings { aimMode: LatchMode; crouchMode: LatchMode; sprintMode: LatchMode | 'auto'; firingMode: 'simple' | 'advanced' }
/** Roles TouchGestures handles itself (press on contact, release on lift). */
export type GestureRole = 'fire' | 'fire-left' | 'jump' | 'reload' | 'grenade' | 'melee';

/** The InputController members the touch buttons use. */
export interface TouchButtonInput {
  readonly acceptsInput: boolean;
  setAction(action: Latch, value: boolean): void;
  cancelAction(action: Latch): void;
  toggle(action: Latch): boolean;
  swapWeapon(): void;
  useStreak(reward: StreakId): void;
}
/** The parts of pointer and click events the handlers read, so they work without a DOM in tests. */
export interface ButtonPointerEvent { button: number; pointerId: number; preventDefault(): void; currentTarget: { setPointerCapture?(pointerId: number): void } | null }
export interface ButtonClickEvent { detail: number }
export interface ButtonHandlers {
  onPointerDown(event: ButtonPointerEvent): void;
  onPointerUp?(): void; onPointerCancel?(): void; onLostPointerCapture?(): void;
  onClick(event: ButtonClickEvent): void;
}

export function latchMode(action: Latch, settings: Pick<TouchButtonSettings, 'aimMode' | 'crouchMode' | 'sprintMode'>): LatchMode {
  return action === 'aim' ? settings.aimMode : action === 'crouch' ? settings.crouchMode : settings.sprintMode === 'toggle' ? 'toggle' : 'hold';
}

/**
 * Aim, Crouch and Sprint. Both modes act on finger contact, so they work while other fingers hold the
 * stick or Fire. Toggle mode flips once per tap and ignores the browser's delayed click, which would flip
 * it straight back; a keyboard or switch click (detail 0) still toggles. Hold mode presses on contact
 * and releases on lift; a cancelled touch cancels. `changed` runs after each action so the button redraws.
 */
export function latchHandlers(input: TouchButtonInput, action: Latch, mode: LatchMode, changed: () => void = () => {}): ButtonHandlers {
  const press = () => {
    if (!input.acceptsInput) return;
    if (mode === 'toggle') input.toggle(action); else input.setAction(action, true);
    changed();
  };
  // Releasing something that is not held does nothing, so a lift after a cancel is harmless.
  const release = (cancelled: boolean) => {
    if (mode === 'toggle') return;
    if (cancelled) input.cancelAction(action); else input.setAction(action, false);
    changed();
  };
  return {
    onPointerDown(event) {
      if (event.button !== 0) return;
      event.preventDefault();
      if (mode === 'hold') { try { event.currentTarget?.setPointerCapture?.(event.pointerId); } catch { /* The lift still reaches the button. */ } }
      press();
    },
    onPointerUp: () => release(false),
    onPointerCancel: () => release(true),
    onLostPointerCapture: () => release(false),
    onClick(event) { if (event.detail === 0 && mode === 'toggle') press(); },
  };
}

/** Swap and reward buttons act once on finger contact; the delayed click is ignored (it would swap back). */
export function tapHandlers(input: Pick<TouchButtonInput, 'acceptsInput'>, run: () => void, changed: () => void = () => {}): ButtonHandlers {
  const act = () => { if (input.acceptsInput) { run(); changed(); } };
  return {
    onPointerDown(event) { if (event.button !== 0) return; event.preventDefault(); act(); },
    onClick(event) { if (event.detail === 0) act(); },
  };
}

/** When the touch controls go away (death, menus, leaving), nothing they pressed may stay held. */
export function releaseLatches(input: Pick<TouchButtonInput, 'cancelAction'>) {
  for (const action of LATCHES) input.cancelAction(action);
}

export interface TouchButtonState { aim: boolean; crouch: boolean; sprint: boolean; motion: '' | 'sprint' | 'dash' }
/**
 * What the buttons show: what the controller is sending now (`InputController.peek()`) and what the game
 * shows. A latch the game ends by itself (aim dropped by a swap or sprint, crouch ended by a jump or
 * slide) goes dark with it; a slide keeps Crouch lit until it ends.
 */
export function touchButtonState(intent: Pick<InputFrame, 'aim' | 'crouch' | 'sprint'> | null, frame: Pick<HudFrame, 'posture' | 'sprinting' | 'dashing'> | null): TouchButtonState {
  const motion = frame?.dashing ? 'dash' : frame?.sprinting ? 'sprint' : '';
  return {
    aim: !!intent?.aim,
    crouch: !!intent?.crouch || frame?.posture === 'crouch' || frame?.posture === 'slide',
    sprint: !!intent?.sprint || motion !== '',
    motion,
  };
}
/** A primitive form of the state for useSyncExternalStore. */
export const encodeButtonState = (state: TouchButtonState) => `${Number(state.aim)}${Number(state.crouch)}${Number(state.sprint)}${state.motion}`;
export const decodeButtonState = (key: string): TouchButtonState =>
  ({ aim: key[0] === '1', crouch: key[1] === '1', sprint: key[2] === '1', motion: key.slice(3) === 'dash' ? 'dash' : key.slice(3) === 'sprint' ? 'sprint' : '' });

export interface ButtonSpec {
  id: string; label: string; icon: IconName;
  /** Where the button goes; undefined hides it. */
  rect: Rect | undefined;
  /** A TouchGestures role (data-touch), for buttons held by a finger. */
  touch?: GestureRole;
  ariaLabel?: string;
  /** Lit: toggled on, held, or the game is doing it. */
  active?: boolean;
  /** Latching buttons report their on/off state to assistive tech. */
  pressed?: boolean;
  handlers?: ButtonHandlers;
}
const REWARD_LABELS: Record<StreakId, string> = { recon: 'Recon', mortar: 'Mortar', drone: 'Drone' };

/** Every first-person touch button with its place, role or handlers. The stick and look pad are separate. */
export function touchButtonSpecs({ input, settings, layout, rewards, state, changed = () => {} }: {
  input: TouchButtonInput; settings: TouchButtonSettings; layout: TouchLayout; rewards: readonly StreakId[];
  state: TouchButtonState; changed?: () => void;
}): ButtonSpec[] {
  const { buttons } = layout;
  const latch = (action: Latch): Pick<ButtonSpec, 'active' | 'pressed' | 'handlers'> =>
    ({ active: state[action], pressed: state[action], handlers: latchHandlers(input, action, latchMode(action, settings), changed) });
  const specs: ButtonSpec[] = [
    { id: 'fire', label: 'Fire', icon: 'target', rect: buttons.fire, touch: 'fire', ariaLabel: settings.firingMode === 'advanced' ? 'Fire. Hold and drag to aim.' : 'Fire' },
    { id: 'fire-left', label: 'Fire', icon: 'target', rect: buttons.fireLeft, touch: 'fire-left', ariaLabel: 'Fire, left thumb' },
    { id: 'aim', label: 'Aim', icon: 'aim', rect: buttons.aim, ...latch('aim') },
    { id: 'crouch', label: state.motion ? 'Slide' : 'Crouch', icon: 'crouch', rect: buttons.crouch, ariaLabel: 'Crouch. While sprinting, slide.', ...latch('crouch') },
    { id: 'jump', label: 'Jump', icon: 'jump', rect: buttons.jump, touch: 'jump', ariaLabel: 'Jump or vault' },
    { id: 'reload', label: 'Reload', icon: 'reload', rect: buttons.reload, touch: 'reload' },
    { id: 'grenade', label: 'Grenade', icon: 'grenade', rect: buttons.grenade, touch: 'grenade', ariaLabel: 'Grenade. Hold to cook, release to throw.' },
    { id: 'knife', label: 'Knife', icon: 'knife', rect: buttons.knife, touch: 'melee' },
    { id: 'swap', label: 'Swap', icon: 'swap', rect: buttons.swap, ariaLabel: 'Swap weapons', handlers: tapHandlers(input, () => input.swapWeapon(), changed) },
  ];
  if (settings.sprintMode !== 'auto' && buttons.sprint) specs.push({ id: 'sprint', label: 'Sprint', icon: 'sprint', rect: buttons.sprint, ...latch('sprint') });
  rewards.slice(0, layout.rewards.length).forEach((reward, index) => specs.push({
    id: 'reward', label: REWARD_LABELS[reward], icon: STREAK_ICONS[reward], rect: layout.rewards[index],
    ariaLabel: `Use ${STREAKS[reward].name}`, handlers: tapHandlers(input, () => input.useStreak(reward), changed),
  }));
  return specs;
}
