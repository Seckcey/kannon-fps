import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_TARGET, overlaps, touchLayout, type Insets, type Rect, type TouchLayout } from '../../src/components/hud/touchLayout.js';

const VIEWPORTS: Array<{ name: string; width: number; height: number; safe: Partial<Insets> }> = [
  { name: 'iPhone landscape 844x390', width: 844, height: 390, safe: { left: 47, right: 47, bottom: 21 } },
  { name: 'small phone landscape 667x375', width: 667, height: 375, safe: {} },
  { name: 'large phone landscape 932x430', width: 932, height: 430, safe: { left: 59, right: 59, bottom: 21 } },
  { name: 'Android landscape 800x360', width: 800, height: 360, safe: { left: 24 } },
  { name: 'tablet landscape 1180x820', width: 1180, height: 820, safe: { bottom: 20 } },
  { name: 'phone portrait 390x844', width: 390, height: 844, safe: { top: 47, bottom: 34 } },
  { name: 'touch laptop 1920x1080', width: 1920, height: 1080, safe: {} },
];
const REQUIRED = ['fire', 'fireLeft', 'aim', 'crouch', 'jump', 'reload', 'grenade', 'knife', 'swap'] as const;

function controls(layout: TouchLayout): Array<[string, Rect]> {
  return [['stick', layout.stick], ...Object.entries(layout.buttons) as Array<[string, Rect]>, ...layout.rewards.map((rect, index): [string, Rect] => [`reward${index}`, rect])];
}

test('every first-person touch control fits, is big enough and stays clear of the others', () => {
  for (const viewport of VIEWPORTS) for (const sprintButton of [false, true]) for (const rewards of [0, 1, 3]) {
    const layout = touchLayout({ ...viewport, sprintButton, rewards });
    const label = `${viewport.name} sprint=${sprintButton} rewards=${rewards}`;
    for (const id of REQUIRED) assert.ok(layout.buttons[id], `${label}: ${id}`);
    assert.equal(!!layout.buttons.sprint, sprintButton, `${label}: sprint button only when sprint is not automatic`);
    assert.equal(layout.rewards.length, rewards);
    const safe = { top: viewport.safe.top ?? 0, right: viewport.safe.right ?? 0, bottom: viewport.safe.bottom ?? 0, left: viewport.safe.left ?? 0 };
    const placed = controls(layout);
    for (const [id, rect] of placed) {
      assert.ok(rect.w >= MIN_TARGET && rect.h >= MIN_TARGET, `${label}: ${id} is ${rect.w}x${rect.h}`);
      assert.ok(rect.x >= safe.left && rect.y >= safe.top && rect.x + rect.w <= viewport.width - safe.right && rect.y + rect.h <= viewport.height - safe.bottom,
        `${label}: ${id} ${JSON.stringify(rect)} leaves the safe area`);
    }
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
      assert.equal(overlaps(placed[i]![1], placed[j]![1], 4), false, `${label}: ${placed[i]![0]} touches ${placed[j]![0]}`);
    }
    const { status } = layout;
    assert.ok(status.x >= safe.left && status.y >= safe.top && status.x + status.w <= viewport.width - safe.right && status.y + status.h <= viewport.height - safe.bottom, `${label}: status inside`);
    for (const [id, rect] of placed) assert.equal(overlaps(status, rect), false, `${label}: status covers ${id}`);
    assert.equal(overlaps(layout.look, layout.stick), false, `${label}: looking never starts on the stick`);
    const fire = layout.buttons.fire!, small = layout.buttons.reload!;
    assert.ok(fire.w > small.w, `${label}: Fire is the biggest button`);
  }
});

test('on a landscape phone the status panel sits between the thumbs and Jump owns the corner', () => {
  const layout = touchLayout({ width: 844, height: 390, safe: { left: 47, right: 47, bottom: 21 } });
  assert.equal(layout.scale, 1);
  const { status, buttons, stick } = layout;
  assert.ok(status.x > stick.x + stick.w && status.x + status.w < buttons.reload!.x, 'between the stick and the right-hand buttons');
  assert.ok(status.y + status.h >= 390 - 21 - 20, 'along the bottom');
  const jump = buttons.jump!;
  for (const [id, rect] of Object.entries(buttons)) if (id !== 'jump') assert.ok(rect.x + rect.w <= jump.x + jump.w && rect.y + rect.h <= jump.y + jump.h, `${id} is above or left of Jump`);
  assert.ok(buttons.fireLeft!.y + buttons.fireLeft!.h <= stick.y, 'Fire left is above the stick');
  // The look area covers the right side of the screen, under the buttons.
  assert.ok(layout.look.x < buttons.reload!.x && layout.look.x + layout.look.w === 844 && layout.look.y + layout.look.h === 390);
});

test('in portrait the status panel moves above the controls', () => {
  const layout = touchLayout({ width: 390, height: 844, safe: { top: 47, bottom: 34 }, rewards: 2 });
  const top = Math.min(...controls(layout).map(([, rect]) => rect.y));
  assert.ok(layout.status.y + layout.status.h <= top);
});
