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

export function overlaps(a: Rect, b: Rect, clearance = 0): boolean {
  return a.x < b.x + b.w + clearance && b.x < a.x + a.w + clearance && a.y < b.y + b.h + clearance && b.y < a.y + a.h + clearance;
}
/** A rect as absolute CSS position. */
export const rectStyle = (rect: Rect) => ({ left: rect.x, top: rect.y, width: rect.w, height: rect.h });
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
