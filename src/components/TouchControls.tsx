import { useRef, useState, type PointerEvent } from 'react';
import type { InputController } from '../game/InputController';
import { Icon, type IconName } from './Icon';

export function TouchControls({ input, healingSlot }: { input: InputController; healingSlot: boolean }) {
  const moveId = useRef<number | null>(null); const origin = useRef({ x: 0, y: 0 });
  const lookId = useRef<number | null>(null); const look = useRef({ x: 0, y: 0 });
  const [stick, setStick] = useState({ x: 0, y: 0 });
  const [aim, setAim] = useState(false); const [sprint, setSprint] = useState(false);
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (moveId.current !== e.pointerId) return;
    const dx = e.clientX - origin.current.x; const dy = e.clientY - origin.current.y;
    const scale = Math.max(1, Math.hypot(dx, dy) / 44);
    setStick({ x: dx / scale, y: dy / scale }); input.setTouchMove(dx / scale / 44, -dy / scale / 44);
  };
  const releaseMove = (e: PointerEvent<HTMLDivElement>) => {
    if (moveId.current !== e.pointerId) return;
    moveId.current = null; setStick({ x: 0, y: 0 }); input.setTouchMove(0, 0);
  };
  const action = (name: 'fire' | 'jump' | 'reload', label: string, icon: IconName, className = '') => <button className={`touch-action ${className}`} aria-label={label} onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); input.setAction(name, true); }} onPointerUp={() => input.setAction(name, false)} onPointerCancel={() => input.setAction(name, false)} onLostPointerCapture={() => input.setAction(name, false)}><Icon name={icon} size={className === 'touch-fire' ? 34 : 22}/><span>{label}</span></button>;
  return <div className="touch-controls">
    <div className="look-pad" aria-label="Drag to look" onPointerDown={e => { if (lookId.current !== null) return; lookId.current = e.pointerId; look.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { if (lookId.current !== e.pointerId) return; input.setTouchLook(e.clientX - look.current.x, e.clientY - look.current.y); look.current = { x: e.clientX, y: e.clientY }; }} onPointerUp={() => { lookId.current = null; }} onPointerCancel={() => { lookId.current = null; }}/>
    <div className="touch-joystick" aria-label="Movement joystick" onPointerDown={e => { if (moveId.current !== null) return; e.preventDefault(); moveId.current = e.pointerId; const bounds = e.currentTarget.getBoundingClientRect(); origin.current = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }; e.currentTarget.setPointerCapture(e.pointerId); move(e); }} onPointerMove={move} onPointerUp={releaseMove} onPointerCancel={releaseMove} onLostPointerCapture={releaseMove}><div className="joystick-ring"/><div className="joystick-knob" style={{ transform: `translate(${stick.x}px, ${stick.y}px)` }}/></div>
    <button className={`touch-action touch-sprint ${sprint ? 'active' : ''}`} aria-label="Toggle sprint" aria-pressed={sprint} onClick={() => { setSprint(!sprint); input.setAction('sprint', !sprint); }}><Icon name="arrow" size={22}/><span>Sprint</span></button>
    <div className="touch-right">{action('reload', 'Reload', 'reload')}<button className={`touch-action ${aim ? 'active' : ''}`} aria-label="Toggle aim" aria-pressed={aim} onClick={() => { setAim(!aim); input.setAction('aim', !aim); }}><Icon name="aim" size={22}/><span>Aim</span></button>{action('jump', 'Jump', 'jump')}{action('fire', healingSlot ? 'Heal' : 'Fire', healingSlot ? 'heal' : 'target', 'touch-fire')}</div>
  </div>;
}
