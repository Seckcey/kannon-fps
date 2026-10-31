import { useEffect, useRef } from 'react';
import type { InputController } from '../game/InputController';
import { TouchGestures } from '../game/TouchGestures';

/** Walk-around controls for touch screens in the graphics review: a stick to move, the right of
 *  the screen to look and a jump button, through the game's own touch gestures. Combat controls
 *  live in the game; this page only walks. */
export function ReviewTouch({ input }: { input: InputController }) {
  const root = useRef<HTMLDivElement>(null), knob = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!root.current) return;
    const gestures = new TouchGestures(root.current, input, (x, y) => {
      if (knob.current) knob.current.style.transform = `translate(${x}px, ${y}px)`;
    });
    return () => gestures.dispose();
  }, [input]);
  return <div ref={root} className="review-touch">
    <div className="review-touch-look" data-touch="look" aria-label="Drag to look"/>
    <div className="review-touch-stick" data-touch="move" aria-label="Movement stick"><div ref={knob} className="review-touch-knob"/></div>
    <button className="review-touch-jump" data-touch="jump" aria-label="Jump">Jump</button>
  </div>;
}
