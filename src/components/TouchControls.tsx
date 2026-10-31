import { useEffect, useReducer, useRef, type CSSProperties } from 'react';
import type { StreakId } from '../../shared/protocol';
import { HudStore } from '../game/hud';
import type { InputController } from '../game/InputController';
import { TouchGestures } from '../game/TouchGestures';
import type { Settings } from '../lib/storage';
import { Icon } from './Icon';
import { useHudValue, useSafeArea, useViewport } from './hud/hooks';
import { decodeButtonState, encodeButtonState, releaseLatches, touchButtonSpecs, touchButtonState, type ButtonSpec } from './hud/touchButtons';
import { rectStyle, touchLayout, type Rect, type TouchLayout } from './hud/touchLayout';

type TouchSettings = Pick<Settings, 'aimMode' | 'crouchMode' | 'sprintMode' | 'firingMode'>;
const NO_HUD = new HudStore();
const NO_REWARDS: readonly StreakId[] = [];

/** First-person touch controls. Gesture roles (`data-touch`) belong to TouchGestures; latching buttons,
 * Swap and rewards are handled here on finger contact so they work while other fingers are down.
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
  // Our own presses redraw at once; everything else (a swap dropping aim, a jump ending crouch) shows
  // on the next HUD frame, because the highlights read the controller and the game rather than a copy.
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const state = decodeButtonState(useHudValue(hud, frame => encodeButtonState(touchButtonState(input.peek(), frame))));
  useEffect(() => {
    if (!root.current) return;
    const gestures = new TouchGestures(root.current, input, (x, y) => { if (knob.current) knob.current.style.transform = `translate(${x}px, ${y}px)`; });
    const reset = input.subscribeReset(redraw);
    return () => { reset(); gestures.dispose(); releaseLatches(input); };
  }, [input]);
  const specs = touchButtonSpecs({ input, settings: controls, layout, rewards, state, changed: redraw });
  return <div ref={root} className="touch-controls touch-v3" style={{ ['--touch-scale' as string]: layout.scale } as CSSProperties}>
    <div className="look-pad" data-touch="look" aria-label="Drag to look" style={rectStyle(layout.look)}/>
    <div className={`touch-stick ${state.motion}`} data-touch="move" aria-label="Movement stick. Push it all the way forward to sprint." style={sized(layout.stick)}>
      <div className="stick-ring"/>{controls.sprintMode === 'auto' && <div className="stick-sprint"><Icon name="sprint" size={16}/></div>}<div ref={knob} className="stick-knob"/>
    </div>
    {specs.map((spec, index) => <TouchButton key={`${spec.id}-${index}`} spec={spec}/>)}
  </div>;
}

const sized = (rect: Rect | undefined): CSSProperties => rect ? { ...rectStyle(rect), ['--size' as string]: `${rect.w}px` } : { display: 'none' };

function TouchButton({ spec }: { spec: ButtonSpec }) {
  const { id, label, icon, rect, touch, ariaLabel, active, pressed, handlers } = spec;
  return <button type="button" className={`touch-btn touch-${id} ${active ? 'active' : ''}`} data-touch={touch} aria-label={ariaLabel ?? label}
    aria-pressed={pressed} style={sized(rect)} onPointerDown={handlers?.onPointerDown} onPointerUp={handlers?.onPointerUp} onPointerCancel={handlers?.onPointerCancel}
    onLostPointerCapture={handlers?.onLostPointerCapture} onClick={handlers?.onClick}>
    <Icon name={icon} size={id === 'fire' ? 30 : 20}/><span>{label}</span>
  </button>;
}
