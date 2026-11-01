/** First-person touch layout, computed from the viewport and its safe areas so every control stays
 * reachable, at least 44 px, inside the notch and home-indicator insets, and clear of the others. */
export interface Insets { top: number; right: number; bottom: number; left: number }
export interface Rect { x: number; y: number; w: number; h: number }
export type TouchButton = 'fire' | 'fireLeft' | 'aim' | 'crouch' | 'jump' | 'reload' | 'grenade' | 'knife' | 'swap' | 'sprint';
export interface TouchLayoutOptions {
  width: number; height: number; safe?: Partial<Insets>;
  /** Hold or toggle sprint needs its own button; automatic sprint uses the stick. */
  sprintButton?: boolean;
  /** Earned rewards, each with its own button (at most three). */
  rewards?: number;
}
export interface TouchLayout {
  scale: number;
  /** Square around the movement stick ring. */
  stick: Rect;
  /** Drag-to-look area; buttons sit above it. */
  look: Rect;
  buttons: Partial<Record<TouchButton, Rect>>;
  rewards: Rect[];
  /** Free space for the health bar and ammo panel. */
  status: Rect;
}
export const MIN_TARGET = 44;
const STATUS_HEIGHT = 64;

export function touchLayout({ width, height, safe = {}, sprintButton = false, rewards = 0 }: TouchLayoutOptions): TouchLayout {
  const inset: Insets = { top: safe.top ?? 0, right: safe.right ?? 0, bottom: safe.bottom ?? 0, left: safe.left ?? 0 };
  const scale = clamp(Math.min(width / 844, height / 390), 0.9, 1.3);
  const px = (value: number, min = MIN_TARGET) => Math.max(min, Math.round(value * scale));
  const fire = px(76), big = px(56), small = px(50, MIN_TARGET + 2), fireLeft = px(64), stickSize = px(132, 110);
  const gap = px(10, 8), margin = px(12, 8);
  const left = inset.left + margin, right = width - inset.right - margin, bottom = height - inset.bottom - margin;

  const at = (x: number, y: number, size: number): Rect => ({ x: Math.round(x), y: Math.round(y), w: size, h: size });
  // Right thumb: Jump in the corner, Crouch beside it, Fire above Jump with Aim and Reload to its left,
  // Grenade and Knife above Fire, Swap at the bottom left of the cluster.
  const jump = at(right - big, bottom - big, big);
  const crouch = at(jump.x - gap - big, bottom - big, big);
  const swap = at(crouch.x - gap - small, bottom - small, small);
  const fireButton = at(right - fire, jump.y - gap - fire, fire);
  const aim = at(fireButton.x - gap - big, fireButton.y + (fire - big) / 2, big);
  const reload = at(aim.x - gap - small, fireButton.y + (fire - small) / 2, small);
  const knife = at(right - small, fireButton.y - gap - small, small);
  const grenade = at(knife.x - gap - small, knife.y, small);
  const rewardRects = Array.from({ length: Math.max(0, Math.min(3, Math.floor(rewards))) }, (_, index) =>
    at(right - small - index * (small + gap), knife.y - gap - small, small));

  // Left thumb: the stick in the corner, Fire left above its inner edge, Sprint above its outer edge.
  const stick = at(left, bottom - stickSize, stickSize);
  const fireLeftButton = at(stick.x + stick.w - fireLeft * 0.6, stick.y - gap - fireLeft, fireLeft);
  const sprint = sprintButton ? at(left, stick.y - gap - small, small) : undefined;

  const buttons: TouchLayout['buttons'] = { fire: fireButton, fireLeft: fireLeftButton, aim, crouch, jump, reload, grenade, knife, swap, ...(sprint ? { sprint } : {}) };
  const placed = [stick, ...Object.values(buttons), ...rewardRects].filter((rect): rect is Rect => !!rect);
  const leftEdge = Math.max(stick.x + stick.w, fireLeftButton.x + fireLeftButton.w, sprint ? sprint.x + sprint.w : 0) + gap;
  const rightEdge = Math.min(reload.x, swap.x) - gap;
  const statusWidth = Math.min(340, rightEdge - leftEdge);
  // Between the thumbs when there is room (landscape); otherwise above every control (portrait).
  const status: Rect = statusWidth >= 180
    ? { x: Math.round(leftEdge + (rightEdge - leftEdge - statusWidth) / 2), y: bottom - STATUS_HEIGHT, w: Math.round(statusWidth), h: STATUS_HEIGHT }
    : { x: left, y: Math.min(...placed.map(rect => rect.y)) - gap - STATUS_HEIGHT, w: right - left, h: STATUS_HEIGHT };
  const lookTop = inset.top + px(52, 40);
  const lookLeft = Math.round(width * 0.36);
  return { scale, stick, buttons, rewards: rewardRects, status, look: { x: lookLeft, y: lookTop, w: width - lookLeft, h: height - lookTop } };
}

/** HUD spacing from the screen edges, never inside the notch or home-indicator insets. The game screen
 * sets these as `--edge-*` CSS variables on touch screens, so CSS and the layout below always agree. */
export function hudEdges(safe: Partial<Insets> = {}, touch: boolean): Insets {
  const [top, side, bottom] = touch ? [8, 12, 8] : [16, 18, 18];
  return { top: Math.max(top, safe.top ?? 0), right: Math.max(side, safe.right ?? 0), bottom: Math.max(bottom, safe.bottom ?? 0), left: Math.max(side, safe.left ?? 0) };
}
/** Minimap size in CSS pixels and how many metres it shows from its centre to its edge. */
export function minimapSpec(width: number, height: number, touch: boolean): { size: number; range: number } {
  return touch ? { size: Math.min(width, height) < 500 ? 96 : 128, range: 20 } : { size: Math.round(clamp(height * 0.2, 150, 240)), range: 30 };
}

/** Kill feed rows on touch screens, in CSS pixels (applied inline by the HUD). */
export const FEED_ROW = 17, FEED_GAP = 2;
/** The touch score bar and the top-right buttons (connection, standings, pause), as the touch CSS draws
 * them; portrait hides the connection readout. */
export const TOUCH_SCORE_BAR = { w: 290, h: 32 };
export const TOUCH_TOP_ACTIONS = { w: 160, h: 44, portraitW: 94 };
export interface TouchHudOptions {
  width: number; height: number; safe?: Partial<Insets>;
  /** The control layout from touchLayout(). */
  controls: TouchLayout;
  minimapSize: number;
  /** How far the crosshair and its markers reach from the screen centre (see crosshairReach). */
  reach: number;
}
export interface TouchHud {
  edges: Insets;
  minimap: Rect; scoreBar: Rect; topActions: Rect;
  /** Kill feed: top-left corner, maximum width, and how many rows fit above the left thumb's buttons. */
  feed: Rect & { rows: number };
  /** Threat warnings, medals and score pop-ups: under the score bar, ending above the crosshair. */
  callouts: Rect;
  /** Live standings: between the thumbs and above the status panel, clear of every control. */
  standings: Rect;
  /** Portrait only: the "turn your phone sideways" hint, between the minimap and the top buttons. */
  hint: Rect | null;
}
const CLEARANCE = 4;

/** Where HUD text goes on a touch screen, so nothing covers the crosshair or a button. */
export function touchHudLayout({ width, height, safe = {}, controls, minimapSize, reach }: TouchHudOptions): TouchHud {
  const edges = hudEdges(safe, true);
  // Matches the CSS `(orientation: portrait) and (max-width: 650px)`.
  const portrait = height > width && width <= 650, phone = Math.min(width, height) < 500;
  const centre = width / 2;
  const minimap: Rect = { x: edges.left, y: edges.top, w: minimapSize, h: minimapSize };
  const actionsWidth = portrait ? TOUCH_TOP_ACTIONS.portraitW : TOUCH_TOP_ACTIONS.w;
  const topActions: Rect = { x: width - edges.right - actionsWidth, y: edges.top, w: actionsWidth, h: TOUCH_TOP_ACTIONS.h };
  // Portrait has no room beside the minimap, so the CSS moves the score bar under it.
  const scoreBar: Rect = { x: Math.round(centre - TOUCH_SCORE_BAR.w / 2), y: portrait ? minimap.y + minimap.h + 8 : edges.top, ...TOUCH_SCORE_BAR };
  const calloutWidth = Math.round(portrait ? Math.min(320, width - edges.left - edges.right) : clamp(width * 0.36, 200, 320));

  // Kill feed under the minimap (under the score bar in portrait): left of the centred messages in
  // landscape, above them in portrait, and only as many rows as fit above the highest control beneath it.
  const feedTop = portrait ? scoreBar.y + scoreBar.h + 6 : minimap.y + minimap.h + 6;
  const feedWidth = Math.floor(clamp(portrait ? width - edges.left - edges.right : centre - calloutWidth / 2 - 8 - edges.left, 0, 300));
  const beneath = [controls.stick, ...Object.values(controls.buttons), ...controls.rewards, controls.status]
    .filter((rect): rect is Rect => !!rect && rect.x < edges.left + feedWidth && rect.x + rect.w > edges.left && rect.y + rect.h > feedTop);
  const feedBottom = Math.min(height - edges.bottom, ...beneath.map(rect => rect.y - CLEARANCE));
  const rows = clamp(Math.floor((feedBottom - feedTop + FEED_GAP) / (FEED_ROW + FEED_GAP)), 0, phone ? 3 : 5);
  const feed = { x: edges.left, y: feedTop, w: feedWidth, h: rows > 0 ? rows * FEED_ROW + (rows - 1) * FEED_GAP : 0, rows };

  const calloutTop = Math.max(scoreBar.y + scoreBar.h + 6, portrait ? feed.y + feed.h + 6 : 0);
  const calloutBottom = Math.floor(height / 2 - reach - 8);
  const callouts: Rect = { x: Math.round(centre - calloutWidth / 2), y: calloutTop, w: calloutWidth, h: Math.max(0, calloutBottom - calloutTop) };

  const { status } = controls;
  const standingsTop = scoreBar.y + scoreBar.h + 6;
  const standings: Rect = portrait
    ? { x: edges.left, y: standingsTop, w: width - edges.left - edges.right, h: Math.max(0, status.y - 6 - standingsTop) }
    : { x: status.x, y: standingsTop, w: status.w, h: Math.max(0, status.y - 6 - standingsTop) };
  const hintLeft = minimap.x + minimap.w + 8;
  const hint: Rect | null = portrait ? { x: hintLeft, y: edges.top, w: Math.max(0, topActions.x - 8 - hintLeft), h: minimap.h } : null;
  return { edges, minimap, scoreBar, topActions, feed, callouts, standings, hint };
}

/** Inline placement for the touch kill feed. Its height is capped at the rows that fit (none on a short
 * screen), so the feed can never spill over the buttons under it. */
export function feedStyle(feed: TouchHud['feed']): Record<string, string | number> {
  return { left: feed.x, top: feed.y, maxWidth: feed.w, maxHeight: feed.h, overflow: 'hidden', '--feed-row': `${FEED_ROW}px`, '--feed-gap': `${FEED_GAP}px` };
}

export function overlaps(a: Rect, b: Rect, clearance = 0): boolean {
  return a.x < b.x + b.w + clearance && b.x < a.x + a.w + clearance && a.y < b.y + b.h + clearance && b.y < a.y + a.h + clearance;
}
/** A rect as absolute CSS position. */
export const rectStyle = (rect: Rect) => ({ left: rect.x, top: rect.y, width: rect.w, height: rect.h });
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
