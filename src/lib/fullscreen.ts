/** How the game gets away from the browser's bars on this device. iPhone Safari gives a website no way to
 * do it (only videos go full screen there), so the player gets the steps; other phones do it on a tap. */
export type FullscreenMode = 'active' | 'available' | 'manual' | 'none';

export interface FullscreenDocument {
  fullscreenEnabled?: boolean; webkitFullscreenEnabled?: boolean;
  fullscreenElement?: Element | null; webkitFullscreenElement?: Element | null;
  exitFullscreen?: () => Promise<void>; webkitExitFullscreen?: () => void;
  documentElement: { requestFullscreen?: (options?: FullscreenOptions) => Promise<void>; webkitRequestFullscreen?: () => void };
}
export const browserFullscreen = () => document as unknown as FullscreenDocument;

export function fullscreenMode(page: FullscreenDocument, { installed, iPhone }: { installed: boolean; iPhone: boolean }): FullscreenMode {
  if (installed || page.fullscreenElement || page.webkitFullscreenElement) return 'active';
  const root = page.documentElement;
  if ((page.fullscreenEnabled && root.requestFullscreen) || (page.webkitFullscreenEnabled && root.webkitRequestFullscreen)) return 'available';
  return iPhone ? 'manual' : 'none';
}

/** Opened from the Home Screen, where iPhones show no Safari bars. */
export function installedApp(): boolean {
  return (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
}
export const isIPhone = () => /iPhone|iPod/.test(navigator.userAgent);

const ANSWER_LIMIT_MS = 1500, OLD_API_WAIT_MS = 300;
/** Needs a tap to be running. Always finishes, whatever the browser does: Ready to play waits for it, and
 * a game under the browser's bars is still playable. */
export async function enterFullscreen(page: FullscreenDocument): Promise<void> {
  const root = page.documentElement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const asked = root.requestFullscreen ? root.requestFullscreen({ navigationUI: 'hide' }) : root.webkitRequestFullscreen?.();
    // The older call answers nothing, so it only gets a moment for the switch to happen.
    const limit = new Promise<void>(resolve => { timer = setTimeout(resolve, asked ? ANSWER_LIMIT_MS : OLD_API_WAIT_MS); });
    await Promise.race([asked ?? limit, limit]);
  } catch { /* Refused: the game carries on under the browser's bars. */ }
  clearTimeout(timer);
}

export function exitFullscreen(page: FullscreenDocument): void {
  if (page.fullscreenElement) page.exitFullscreen?.().catch(() => {});
  else if (page.webkitFullscreenElement) page.webkitExitFullscreen?.();
}
