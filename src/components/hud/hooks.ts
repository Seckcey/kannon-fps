import { useEffect, useState, useSyncExternalStore } from 'react';
import type { HudFrame, HudStore } from '../../game/hud';
import type { Insets } from './touchLayout';

/** The latest frame; re-renders the caller at the HUD feed rate (about 30 Hz). */
export function useHudFrame(hud: HudStore): HudFrame | null {
  return useSyncExternalStore(hud.subscribe, hud.getSnapshot);
}
/** One primitive value from the frame; the caller only re-renders when that value changes. */
export function useHudValue<T extends string | number | boolean | null>(hud: HudStore, select: (frame: HudFrame | null) => T): T {
  return useSyncExternalStore(hud.subscribe, () => select(hud.getSnapshot()));
}

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
export function useViewport(): { width: number; height: number } {
  const [size, setSize] = useState(viewport);
  useEffect(() => {
    const update = () => setSize(previous => { const next = viewport(); return next.width === previous.width && next.height === previous.height ? previous : next; });
    window.addEventListener('resize', update); window.addEventListener('orientationchange', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('orientationchange', update); window.visualViewport?.removeEventListener('resize', update); };
  }, []);
  return size;
}

const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
/** Notch and home-indicator insets, read from CSS env() through a hidden probe. */
export function useSafeArea(): Insets {
  const [insets, setInsets] = useState<Insets>(NO_INSETS);
  useEffect(() => {
    const probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:fixed;inset:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);';
    document.body.append(probe);
    const read = () => {
      const style = getComputedStyle(probe), value = (name: string) => Number.parseFloat(style.getPropertyValue(name)) || 0;
      const next = { top: value('padding-top'), right: value('padding-right'), bottom: value('padding-bottom'), left: value('padding-left') };
      setInsets(previous => previous.top === next.top && previous.right === next.right && previous.bottom === next.bottom && previous.left === next.left ? previous : next);
    };
    read();
    // Insets change after rotation settles, so read again on the next frame too.
    const update = () => { read(); requestAnimationFrame(read); };
    window.addEventListener('resize', update); window.addEventListener('orientationchange', update);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('orientationchange', update); probe.remove(); };
  }, []);
  return insets;
}
