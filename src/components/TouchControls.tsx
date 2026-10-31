import { useEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { StreakId } from '../../shared/protocol';
import { STREAKS } from '../../shared/weapons';
import { HudStore } from '../game/hud';
import type { InputController } from '../game/InputController';
import { TouchGestures } from '../game/TouchGestures';
import type { Settings } from '../lib/storage';
import { Icon, type IconName } from './Icon';
import { STREAK_ICONS } from './labels';
import { useHudValue, useSafeArea, useViewport } from './hud/hooks';
import { rectStyle, touchLayout, type Rect, type TouchLayout } from './hud/touchLayout';

type Latch = 'aim' | 'crouch' | 'sprint';
type TouchSettings = Pick<Settings, 'aimMode' | 'crouchMode' | 'sprintMode' | 'firingMode'>;
const RELEASED: Record<Latch, boolean> = { aim: false, crouch: false, sprint: false };
const REWARD_LABELS: Record<StreakId, string> = { recon: 'Recon', mortar: 'Mortar', drone: 'Drone' };
const NO_HUD = new HudStore();
const NO_REWARDS: readonly StreakId[] = [];

/** First-person touch controls. Gesture roles (`data-touch`) belong to TouchGestures; latching buttons,
 * Swap and rewards are handled here on pointer contact so they work while other fingers are down.
 * Only `input` is required, so harness pages can mount the controls on their own. */
export function TouchControls({ input, hud = NO_HUD, settings, layout: sharedLayout, rewards = NO_REWARDS }: {
  input: InputController; hud?: HudStore; settings?: TouchSettings;
  /** From touchLayout(), shared with the HUD so the status panel fits between the thumbs. Computed here when omitted. */
  layout?: TouchLayout; rewards?: readonly StreakId[];
  /** @deprecated First person has no healing slot; ignored. */
  healingSlot?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null), knob = useRef<HTMLDivElement>(null);
  const viewport = useViewport(), safe = useSafeArea();
  const controls: TouchSettings = settings ?? { aimMode: 'toggle', crouchMode: 'toggle', sprintMode: 'auto', firingMode: input.firingMode };
  const layout = sharedLayout ?? touchLayout({ ...viewport, safe, sprintButton: controls.sprintMode !== 'auto', rewards: rewards.length });
  const motion = useHudValue(hud, frame => !frame ? '' : frame.dashing ? 'dash' : frame.sprinting ? 'sprint' : '');
  const [latched, setLatched] = useState(RELEASED);
  useEffect(() => {
    if (!root.current) return;
    const gestures = new TouchGestures(root.current, input, (x, y) => { if (knob.current) knob.current.style.transform = `translate(${x}px, ${y}px)`; });
    const reset = input.subscribeReset(() => setLatched(RELEASED));
    return () => { reset(); gestures.dispose(); for (const action of ['aim', 'crouch', 'sprint'] as const) input.cancelAction(action); };
  }, [input]);
  const modeOf = (action: Latch) => action === 'aim' ? controls.aimMode : action === 'crouch' ? controls.crouchMode : controls.sprintMode === 'toggle' ? 'toggle' : 'hold';

  const latch = (action: Latch) => {
    const toggles = modeOf(action) === 'toggle';
    const press = () => {
      if (!input.acceptsInput) return;
      if (toggles) { const next = input.toggle(action); setLatched(state => ({ ...state, [action]: next })); }
      else { input.setAction(action, true); setLatched(state => ({ ...state, [action]: true })); }
    };
    const release = (cancelled: boolean) => () => {
      if (toggles) return;
      if (cancelled) input.cancelAction(action); else input.setAction(action, false);
      setLatched(state => ({ ...state, [action]: false }));
    };
    return {
      'aria-pressed': latched[action],
      onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        if (!toggles) { try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Release still arrives on the button. */ } }
        press();
      },
      onPointerUp: release(false), onPointerCancel: release(true), onLostPointerCapture: release(false),
      // Keyboard and switch access: a click without a pointer contact.
      onClick: (event: ReactMouseEvent) => { if (event.detail === 0 && toggles) press(); },
    };
  };
  const tap = (run: () => void) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => { if (event.button !== 0) return; event.preventDefault(); if (input.acceptsInput) run(); },
    onClick: (event: ReactMouseEvent) => { if (event.detail === 0 && input.acceptsInput) run(); },
  });
  const { buttons } = layout;
  const sized = (rect: Rect | undefined): CSSProperties => rect ? { ...rectStyle(rect), ['--size' as string]: `${rect.w}px` } : { display: 'none' };
  return <div ref={root} className="touch-controls touch-v3" style={{ ['--touch-scale' as string]: layout.scale } as CSSProperties}>
    <div className="look-pad" data-touch="look" aria-label="Drag to look" style={rectStyle(layout.look)}/>
    <div className={`touch-stick ${motion}`} data-touch="move" aria-label="Movement stick. Push it all the way forward to sprint." style={sized(layout.stick)}>
      <div className="stick-ring"/>{controls.sprintMode === 'auto' && <div className="stick-sprint"><Icon name="sprint" size={16}/></div>}<div ref={knob} className="stick-knob"/>
    </div>
    <TouchButton id="fire" label="Fire" icon="target" style={sized(buttons.fire)} touch="fire" ariaLabel={controls.firingMode === 'advanced' ? 'Fire. Hold and drag to aim.' : 'Fire'}/>
    <TouchButton id="fire-left" label="Fire" icon="target" style={sized(buttons.fireLeft)} touch="fire-left" ariaLabel="Fire, left thumb"/>
    <TouchButton id="aim" label="Aim" icon="aim" style={sized(buttons.aim)} active={latched.aim} {...latch('aim')}/>
    <TouchButton id="crouch" label={motion ? 'Slide' : 'Crouch'} icon="crouch" style={sized(buttons.crouch)} active={latched.crouch} ariaLabel="Crouch. While sprinting, slide." {...latch('crouch')}/>
    <TouchButton id="jump" label="Jump" icon="jump" style={sized(buttons.jump)} touch="jump" ariaLabel="Jump or vault"/>
    <TouchButton id="reload" label="Reload" icon="reload" style={sized(buttons.reload)} touch="reload"/>
    <TouchButton id="grenade" label="Grenade" icon="grenade" style={sized(buttons.grenade)} touch="grenade" ariaLabel="Grenade. Hold to cook, release to throw."/>
    <TouchButton id="knife" label="Knife" icon="knife" style={sized(buttons.knife)} touch="melee"/>
    <TouchButton id="swap" label="Swap" icon="swap" style={sized(buttons.swap)} ariaLabel="Swap weapons" {...tap(() => input.swapWeapon())}/>
    {buttons.sprint && <TouchButton id="sprint" label="Sprint" icon="sprint" style={sized(buttons.sprint)} active={latched.sprint || motion !== ''} {...latch('sprint')}/>}
    {rewards.map((reward, index) => <TouchButton key={`${reward}-${index}`} id="reward" label={REWARD_LABELS[reward]} icon={STREAK_ICONS[reward]} style={sized(layout.rewards[index])}
      ariaLabel={`Use ${STREAKS[reward].name}`} {...tap(() => input.useStreak(reward))}/>)}
  </div>;
}

function TouchButton({ id, label, icon, style, touch, active, ariaLabel, ...handlers }: {
  id: string; label: string; icon: IconName; style: CSSProperties; touch?: string; active?: boolean; ariaLabel?: string;
} & Partial<Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'onPointerDown' | 'onPointerUp' | 'onPointerCancel' | 'onLostPointerCapture' | 'onClick' | 'aria-pressed'>>) {
  return <button type="button" className={`touch-btn touch-${id} ${active ? 'active' : ''}`} data-touch={touch} aria-label={ariaLabel ?? label} style={style} {...handlers}>
    <Icon name={icon} size={id === 'fire' ? 30 : 20}/><span>{label}</span>
  </button>;
}
