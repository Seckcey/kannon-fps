import { useEffect, useRef, useState } from 'react';
import type { InputController } from '../game/InputController';
import { TouchGestures } from '../game/TouchGestures';
import { Icon } from './Icon';

export function TouchControls({ input, healingSlot }: { input: InputController; healingSlot: boolean }) {
  const root = useRef<HTMLDivElement>(null), knob = useRef<HTMLDivElement>(null);
  const [aim, setAim] = useState(false), [sprint, setSprint] = useState(false);
  useEffect(() => {
    if (!root.current) return;
    const gestures = new TouchGestures(root.current, input, (x, y) => {
      if (knob.current) knob.current.style.transform = `translate(${x}px, ${y}px)`;
    });
    const reset = input.subscribeReset(() => { setAim(false); setSprint(false); });
    return () => { reset(); gestures.dispose(); input.cancelAction('aim'); input.cancelAction('sprint'); };
  }, [input]);
  const toggle = (action: 'aim' | 'sprint') => {
    if (!input.acceptsInput) return;
    const next = action === 'aim' ? !aim : !sprint;
    input.setAction(action, next);
    if (action === 'aim') setAim(next); else setSprint(next);
  };
  return <div ref={root} className="touch-controls">
    <div className="look-pad" data-touch="look" aria-label="Drag to look"/>
    <div className="touch-joystick" data-touch="move" aria-label="Movement joystick"><div className="joystick-ring"/><div ref={knob} className="joystick-knob"/></div>
    <button className={`touch-action touch-sprint ${sprint ? 'active' : ''}`} aria-label="Toggle sprint" aria-pressed={sprint} onClick={() => toggle('sprint')}><Icon name="arrow" size={22}/><span>Sprint</span></button>
    <div className="touch-right">
      <button className="touch-action" data-touch="reload" aria-label="Reload"><Icon name="reload" size={22}/><span>Reload</span></button>
      <button className={`touch-action ${aim ? 'active' : ''}`} aria-label="Toggle aim" aria-pressed={aim} onClick={() => toggle('aim')}><Icon name="aim" size={22}/><span>Aim</span></button>
      <button className="touch-action" data-touch="jump" aria-label="Jump"><Icon name="jump" size={22}/><span>Jump</span></button>
      <button className="touch-action touch-fire" data-touch="fire" aria-label={healingSlot ? 'Heal' : 'Fire and drag to aim'}><Icon name={healingSlot ? 'heal' : 'target'} size={34}/><span>{healingSlot ? 'Heal' : 'Fire'}</span></button>
    </div>
    {!healingSlot && <span className="touch-mode-hint">{input.firingMode === 'simple' ? 'Auto-fire · aim at a rival' : 'Hold fire + drag to aim'}</span>}
  </div>;
}
