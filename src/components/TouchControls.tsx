import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { InputController } from '../game/InputController';
import { Icon, type IconName } from './Icon';

type HeldAction = 'fire' | 'jump' | 'reload';
interface CapturedPointer { id: number; target: HTMLElement }
function releaseCapture(pointer: CapturedPointer | null) {
  if (pointer?.target.hasPointerCapture(pointer.id)) pointer.target.releasePointerCapture(pointer.id);
}

export function TouchControls({ input, healingSlot }: { input: InputController; healingSlot: boolean }) {
  const movePointer = useRef<CapturedPointer | null>(null);
  const lookPointer = useRef<CapturedPointer | null>(null);
  const actionPointers = useRef(new Map<HeldAction, CapturedPointer>());
  const origin = useRef({ x: 0, y: 0 });
  const look = useRef({ x: 0, y: 0 });
  const [stick, setStick] = useState({ x: 0, y: 0 });
  const [aim, setAim] = useState(false);
  const [sprint, setSprint] = useState(false);

  useEffect(() => {
    const cancelPointers = (updateDisplay: boolean) => {
      const pointers = [movePointer.current, lookPointer.current, ...actionPointers.current.values()];
      movePointer.current = null; lookPointer.current = null; actionPointers.current.clear();
      // Drop ownership before releasing capture, because the browser dispatches capture-loss events.
      for (const pointer of pointers) releaseCapture(pointer);
      input.setTouchMove(0, 0);
      for (const action of ['fire', 'jump', 'reload', 'aim', 'sprint'] as const) input.cancelAction(action);
      if (updateDisplay) { setStick({ x: 0, y: 0 }); setAim(false); setSprint(false); }
    };
    const unsubscribe = input.subscribeReset(() => cancelPointers(true));
    return () => { unsubscribe(); cancelPointers(false); };
  }, [input]);

  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (movePointer.current?.id !== event.pointerId) return;
    const dx = event.clientX - origin.current.x; const dy = event.clientY - origin.current.y;
    const scale = Math.max(1, Math.hypot(dx, dy) / 44);
    setStick({ x: dx / scale, y: dy / scale }); input.setTouchMove(dx / scale / 44, -dy / scale / 44);
  };
  const releaseMove = (event: PointerEvent<HTMLDivElement>) => {
    if (movePointer.current?.id !== event.pointerId) return;
    const pointer = movePointer.current; movePointer.current = null;
    setStick({ x: 0, y: 0 }); input.setTouchMove(0, 0); releaseCapture(pointer);
  };
  const releaseLook = (event: PointerEvent<HTMLDivElement>) => {
    if (lookPointer.current?.id !== event.pointerId) return;
    const pointer = lookPointer.current; lookPointer.current = null; releaseCapture(pointer);
  };
  const releaseAction = (name: HeldAction, event: PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const pointer = actionPointers.current.get(name);
    if (pointer?.id !== event.pointerId) return;
    actionPointers.current.delete(name);
    if (cancelled) input.cancelAction(name); else input.setAction(name, false);
    releaseCapture(pointer);
  };
  const action = (name: HeldAction, label: string, icon: IconName, className = '') => (
    <button className={`touch-action ${className}`} aria-label={label}
      onPointerDown={event => {
        if (!input.acceptsInput || actionPointers.current.has(name)) return;
        event.preventDefault();
        actionPointers.current.set(name, { id: event.pointerId, target: event.currentTarget });
        event.currentTarget.setPointerCapture(event.pointerId); input.setAction(name, true);
      }}
      onPointerUp={event => releaseAction(name, event)}
      onPointerCancel={event => releaseAction(name, event, true)}
      onLostPointerCapture={event => releaseAction(name, event, true)}>
      <Icon name={icon} size={className === 'touch-fire' ? 34 : 22}/><span>{label}</span>
    </button>
  );
  const toggle = (action: 'aim' | 'sprint') => {
    if (!input.acceptsInput) return;
    const next = !input.peek()[action]; input.setAction(action, next);
    if (action === 'aim') setAim(next); else setSprint(next);
  };

  return <div className="touch-controls">
    <div className="look-pad" aria-label="Drag to look"
      onPointerDown={event => {
        if (!input.acceptsInput || lookPointer.current) return;
        event.preventDefault(); lookPointer.current = { id: event.pointerId, target: event.currentTarget };
        look.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        if (lookPointer.current?.id !== event.pointerId) return;
        input.setTouchLook(event.clientX - look.current.x, event.clientY - look.current.y);
        look.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={releaseLook} onPointerCancel={releaseLook} onLostPointerCapture={releaseLook}/>
    <div className="touch-joystick" aria-label="Movement joystick"
      onPointerDown={event => {
        if (!input.acceptsInput || movePointer.current) return;
        event.preventDefault(); movePointer.current = { id: event.pointerId, target: event.currentTarget };
        const bounds = event.currentTarget.getBoundingClientRect();
        origin.current = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        event.currentTarget.setPointerCapture(event.pointerId); move(event);
      }}
      onPointerMove={move} onPointerUp={releaseMove} onPointerCancel={releaseMove} onLostPointerCapture={releaseMove}>
      <div className="joystick-ring"/><div className="joystick-knob" style={{ transform: `translate(${stick.x}px, ${stick.y}px)` }}/>
    </div>
    <button className={`touch-action touch-sprint ${sprint ? 'active' : ''}`} aria-label="Toggle sprint" aria-pressed={sprint} onClick={() => toggle('sprint')}>
      <Icon name="arrow" size={22}/><span>Sprint</span>
    </button>
    <div className="touch-right">
      {action('reload', 'Reload', 'reload')}
      <button className={`touch-action ${aim ? 'active' : ''}`} aria-label="Toggle aim" aria-pressed={aim} onClick={() => toggle('aim')}><Icon name="aim" size={22}/><span>Aim</span></button>
      {action('jump', 'Jump', 'jump')}{action('fire', healingSlot ? 'Heal' : 'Fire', healingSlot ? 'heal' : 'target', 'touch-fire')}
    </div>
  </div>;
}
