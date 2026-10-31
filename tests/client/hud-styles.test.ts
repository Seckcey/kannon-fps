import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The text between the braces that open at or after `from`. */
function block(source: string, from: number): { body: string; end: number } {
  const open = source.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return { body: source.slice(open + 1, i), end: i + 1 };
  }
  throw new Error(`Unbalanced braces after ${from}`);
}
/** Innermost rules as [selectors, declarations]. */
function rules(source: string): Array<[string[], string]> {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => [match[1]!.split(',').map(selector => selector.trim()).filter(Boolean), match[2]!]);
}

test('with reduced motion, score pop-ups, medals and reward notices stay visible and nothing flickers', () => {
  const start = css.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(start >= 0, 'the stylesheet has a reduced-motion block');
  const reduced = block(css, start);
  const elsewhere = css.slice(0, start) + css.slice(reduced.end);
  // Keyframes that end invisible: with `forwards` and a near-zero duration they would hide the element.
  const fadeOuts = new Set<string>();
  for (const match of css.matchAll(/@keyframes\s+([\w-]+)/g)) {
    const stops = rules(block(css, match.index!).body);
    const last = stops.at(-1);
    if (last && /^(100%|to)$/.test(last[0][0]!) && /opacity:\s*0(?![.\d])/.test(last[1])) fadeOuts.add(match[1]!);
  }
  assert.ok(fadeOuts.has('popup-in') && fadeOuts.has('callout-in'), `fade-outs found: ${[...fadeOuts]}`);
  const turnedOff = new Set(rules(reduced.body).filter(([, body]) => /animation:\s*none/.test(body)).flatMap(([selectors]) => selectors));
  const needs = new Set<string>();
  for (const [selectors, body] of rules(elsewhere)) {
    const animation = /animation:\s*([^;]+)/.exec(body)?.[1];
    if (!animation) continue;
    const name = animation.split(/\s+/).find(token => /^[a-z][\w-]*$/.test(token) && !/^(forwards|infinite|alternate|ease|ease-in|ease-out|ease-in-out|linear|both|none)$/.test(token));
    if ((name && fadeOuts.has(name) && /\bforwards\b/.test(animation)) || /\binfinite\b/.test(animation)) for (const selector of selectors) needs.add(selector);
  }
  for (const selector of ['.medal-card', '.score-popup', '.reward-ready']) assert.ok(needs.has(selector), `${selector} fades out with forwards`);
  for (const selector of needs) assert.ok(turnedOff.has(selector), `${selector} must use animation: none under reduced motion`);
});

/** The z-index of the last rule for exactly this selector that sets one. */
function zIndex(selector: string): number | undefined {
  let value: number | undefined;
  for (const [selectors, body] of rules(css)) {
    const match = /z-index:\s*(-?\d+)/.exec(body);
    if (match && selectors.includes(selector)) value = Number(match[1]);
  }
  return value;
}

test('a scope darkens the arena under the touch controls, while the HUD stays on top', () => {
  // GameScreen draws the scope as its own layer just before the HUD layer, never inside it.
  const scope = zIndex('.scope-overlay'), controls = zIndex('.touch-controls'), hud = zIndex('.game-hud'), touchHud = zIndex('.touch-game .game-hud');
  assert.ok(scope !== undefined && controls !== undefined && hud !== undefined && touchHud !== undefined, `${scope} ${controls} ${hud} ${touchHud}`);
  assert.ok(scope < controls, 'the stick and every button draw over the dark scope surround');
  assert.ok(controls < touchHud, 'on phones the HUD text and the mortar map stay above the controls');
  assert.ok(scope <= hud, 'on desktop the HUD still draws over the scope (it comes later in the page)');
});

test('live standings never blur the game behind them', () => {
  const live = rules(css).filter(([selectors]) => selectors.some(selector => selector.includes('.scoreboard-overlay.live') || selector.includes('.scoreboard-overlay.placed')));
  assert.ok(live.some(([, body]) => /backdrop-filter:\s*none/.test(body)));
  assert.ok(live.some(([, body]) => /pointer-events:\s*none/.test(body)), 'phone standings let touches reach the controls around them');
});
