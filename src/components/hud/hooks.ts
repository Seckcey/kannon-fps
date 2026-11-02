import { useEffect, useState, useSyncExternalStore } from 'react';
import type { HudFrame, HudStore } from '../../game/hud';
import type { Insets } from './touchLayout';

// The third argument of useSyncExternalStore only serves rendering to markup (the Node tests); the game
// itself always renders in the browser.
/** The latest frame; re-renders the caller at the HUD feed rate (about 30 Hz). */
export function useHudFrame(hud: HudStore): HudFrame | null {
  return useSyncExternalStore(hud.subscribe, hud.getSnapshot, hud.getSnapshot);
}
/** One primitive value from the frame; the caller only re-renders when that value changes. */
export function useHudValue<T extends string | number | boolean | null>(hud: HudStore, select: (frame: HudFrame | null) => T): T {
  const read = () => select(hud.getSnapshot());
  return useSyncExternalStore(hud.subscribe, read, read);
}

export interface VisibleArea { left: number; top: number; width: number; height: number }
export type ViewportSource = EventTarget & Pick<Window, 'innerWidth' | 'innerHeight'> & { visualViewport: (EventTarget & Pick<VisualViewport, 'width' | 'height' | 'offsetLeft' | 'offsetTop'>) | null };

/** The part of the page the player can see. A phone can zoom the page in when it turns, and a match
 * blocks the pinch that would undo it, so the game follows this rather than the size of the whole page. */
export function readVisibleArea(view: ViewportSource): VisibleArea {
  const visible = view.visualViewport;
  if (!visible || !(visible.width > 0) || !(visible.height > 0)) return { left: 0, top: 0, width: view.innerWidth, height: view.innerHeight };
  // Rounded up: a fractional Android size must not leave a hairline at the edge of the screen.
  return { left: Math.round(visible.offsetLeft), top: Math.round(visible.offsetTop), width: Math.ceil(visible.width), height: Math.ceil(visible.height) };
}

/** Phones can report their new size after the events of a turn, so each event is read again until it settles. */
export const VIEWPORT_SETTLE_MS = [100, 300, 600, 1000, 1500] as const;
export function watchVisibleArea(view: ViewportSource, onRead: (area: VisibleArea) => void): () => void {
  let timers: ReturnType<typeof setTimeout>[] = [];
  const read = () => onRead(readVisibleArea(view));
  const settle = () => { read(); timers.forEach(clearTimeout); timers = VIEWPORT_SETTLE_MS.map(delay => setTimeout(read, delay)); };
  view.addEventListener('resize', settle); view.addEventListener('orientationchange', settle);
  view.visualViewport?.addEventListener('resize', settle); view.visualViewport?.addEventListener('scroll', read);
  return () => {
    timers.forEach(clearTimeout);
    view.removeEventListener('resize', settle); view.removeEventListener('orientationchange', settle);
    view.visualViewport?.removeEventListener('resize', settle); view.visualViewport?.removeEventListener('scroll', read);
  };
}

export function useViewport(): VisibleArea {
  const [area, setArea] = useState(() => readVisibleArea(window));
  useEffect(() => {
    const update = (next: VisibleArea) => setArea(previous => next.left === previous.left && next.top === previous.top && next.width === previous.width && next.height === previous.height ? previous : next);
    update(readVisibleArea(window));
    return watchVisibleArea(window, update);
  }, []);
  return area;
}

/** Page zoom limits that also pull an already zoomed page back to normal size. */
export function lockedViewportContent(content: string): string {
  return /maximum-scale/.test(content) ? content : `${content}, minimum-scale=1, maximum-scale=1`;
}
/** Keeps the page at normal size for as long as the caller is on screen; zoom comes back in the menus. */
export function usePageZoomLock() {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;
    const content = meta.content;
    meta.content = lockedViewportContent(content);
    return () => { meta.content = content; };
  }, []);
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
    // Insets change after rotation settles, so they are read again along with the visible area.
    const stop = watchVisibleArea(window, read);
    return () => { stop(); probe.remove(); };
  }, []);
  return insets;
}
