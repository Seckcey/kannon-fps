#!/usr/bin/env node
/**
 * Plays one bot match at exact phone screen sizes and reports anything a player needs that is off screen,
 * covered, too small to tap or spilling out of its panel, on every match screen. A browser emulator shows no
 * browser bars, so the default sizes are what an iPhone has left with Safari's address bar and tab bar showing.
 *
 *   npm run build && npm run phone-fit
 *   npm run phone-fit -- 844x390:47,47,21 390x700:0,0,34     width x height : notch left, notch right, home bar
 *
 * Needs a built client and Playwright's Chromium with a GPU. Set ENGINE=webkit to use WebKit, which cannot
 * emulate the notch. Set REAL_FULLSCREEN=1 to keep the browser's full-screen support instead of an iPhone's lack
 * of it. Screenshots and a report for each size go under test-results/phone-fit/. Exits 1 on any problem.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, webkit } from '@playwright/test';

const DEFAULT_SIZES = ['852x258:59,59,21', '844x255:47,47,21', '932x295:59,59,21', '667x227:0,0,0'];
const PORT = Number(process.env.PHONE_FIT_PORT ?? 14352), BASE = `http://127.0.0.1:${PORT}`;
const sizes = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SIZES;
const OUT = resolve('test-results/phone-fit');
const useWebkit = process.env.ENGINE === 'webkit';
const wait = ms => new Promise(done => setTimeout(done, ms));

/** Runs in the page. Only what the player can reach counts: when something covers the screen, what is inside it. */
function audit({ safeLeft, safeRight, safeBottom }) {
  const W = innerWidth, H = innerHeight, problems = [];
  const label = el => (el.getAttribute('aria-label') || el.textContent || el.tagName).toString().trim().replace(/\s+/g, ' ').slice(0, 28);
  const shown = el => { const s = getComputedStyle(el), r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0.02; };
  const scroller = el => { for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowY; if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight + 1) return p; } return null; };
  const layer = el => el.matches('dialog') ? 1e4 : +getComputedStyle(el).zIndex || 0;
  const cover = [...document.querySelectorAll('dialog[open], .game-cover, .connection-cover, .mortar-overlay, .pause-cover, .scoreboard-overlay.results')].filter(shown).sort((a, b) => layer(a) - layer(b)).at(-1);
  const placed = [];
  for (const el of [...(cover ?? document).querySelectorAll('button, select, input, a[href], summary, .touch-stick, .mortar-map')].filter(shown)) {
    // Ready to play has to be on screen as it stands, scrolling area or not.
    const r = el.getBoundingClientRect(), name = label(el), box = el.matches('.preparation-panel > .button') ? null : scroller(el);
    if (box) {
      const b = box.getBoundingClientRect();
      if (b.top < -0.5 || b.bottom > H + 0.5 || b.left < -0.5 || b.right > W + 0.5) problems.push(`scrolling area off screen: ${box.className}`);
      continue;
    }
    if (r.left < -0.5 || r.top < -0.5 || r.right > W + 0.5 || r.bottom > H + 0.5) { problems.push(`off screen: "${name}" x ${Math.round(r.left)}..${Math.round(r.right)} y ${Math.round(r.top)}..${Math.round(r.bottom)} of ${W}x${H}`); continue; }
    if (r.bottom > H - safeBottom + 0.5 && !el.matches('.touch-stick')) problems.push(`on the home bar: "${name}" bottom ${Math.round(r.bottom)} of ${H - safeBottom}`);
    if (r.left < safeLeft - 0.5 || r.right > W - safeRight + 0.5) problems.push(`in the notch: "${name}" x ${Math.round(r.left)}..${Math.round(r.right)} of ${safeLeft}..${W - safeRight}`);
    if (!el.matches('input[type=radio], input[type=checkbox], .touch-stick, .mortar-map') && !el.closest('.game-error') && (r.width < 40 || r.height < 40)) problems.push(`too small: "${name}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) problems.push(`covered: "${name}" by ${(hit.className?.baseVal ?? hit.className ?? hit.tagName).toString().slice(0, 30)}`);
    if (!el.matches('.mortar-map')) placed.push([name, r]);
  }
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
    const [a, ra] = placed[i], [b, rb] = placed[j];
    if (ra.left < rb.right && rb.left < ra.right && ra.top < rb.bottom && rb.top < ra.bottom) problems.push(`overlap: "${a}" and "${b}"`);
  }
  for (const selector of ['.preparation-panel', '.pause-panel', '.respawn-card', '.scoreboard-panel', '.mortar-panel', '.center-message', '.modal', '.game-cover > *', '.connection-cover > *', '.hud-status.touch']) {
    for (const panel of document.querySelectorAll(selector)) {
      if (!shown(panel)) continue;
      const p = panel.getBoundingClientRect();
      if (p.top < -0.5 || p.bottom > H + 0.5 || p.left < -0.5 || p.right > W + 0.5) problems.push(`panel off screen: ${selector} x ${Math.round(p.left)}..${Math.round(p.right)} y ${Math.round(p.top)}..${Math.round(p.bottom)} of ${W}x${H}`);
      if (getComputedStyle(panel).overflowY !== 'visible') continue;
      for (const child of panel.querySelectorAll('*')) {
        if (!shown(child) || scroller(child) || !(child.childElementCount === 0 || child.tagName === 'BUTTON')) continue;
        const c = child.getBoundingClientRect();
        if (c.bottom > p.bottom + 1 || c.top < p.top - 1) { problems.push(`spills out of ${selector}: "${label(child)}" y ${Math.round(c.top)}..${Math.round(c.bottom)}, panel ${Math.round(p.top)}..${Math.round(p.bottom)}`); break; }
      }
    }
  }
  return [...new Set(problems)];
}

async function play(browser, size) {
  const [dims, insets = '0,0,0'] = size.split(':'), [width, height] = dims.split('x').map(Number), [left, right, bottom] = insets.split(',').map(Number);
  const dir = join(OUT, `${width}x${height}`); mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, ...(useWebkit ? {} : { isMobile: true }), hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  // iPhone Safari gives a page no way to go full screen.
  if (!process.env.REAL_FULLSCREEN) await context.addInitScript(() => { for (const name of ['fullscreenEnabled', 'webkitFullscreenEnabled']) Object.defineProperty(Document.prototype, name, { get: () => false, configurable: true }); });
  const page = await context.newPage();
  const report = { size, screens: {}, unreachable: [], errors: [] };
  page.on('pageerror', error => report.errors.push(error.message));
  const cdp = useWebkit ? null : await context.newCDPSession(page);
  if (cdp) await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left, right, bottom } });
  let shot = 0;
  const check = async name => {
    await wait(350);
    const problems = await page.evaluate(audit, useWebkit ? { safeLeft: 0, safeRight: 0, safeBottom: 0 } : { safeLeft: left, safeRight: right, safeBottom: bottom });
    report.screens[name] = problems;
    await page.screenshot({ path: join(dir, `${String(++shot).padStart(2, '0')}-${name}.png`) });
    console.log(`  ${name}: ${problems.length ? problems.join(' | ') : 'ok'}`);
  };
  /** A real tap when the button can be reached; a script click and a mark in the report when it cannot. */
  const press = async (button, name, timeout = 60000) => {
    await button.waitFor({ state: 'attached', timeout });
    try { await button.tap({ timeout: 2500 }); } catch {
      console.log(`  cannot tap "${name}"`);
      report.unreachable.push(name);
      await button.evaluate(el => el.click());
    }
  };
  const named = (text, exact = false) => page.getByRole('button', { name: text, exact }).first();
  /** A screen that never appears is a failure, not a pass: otherwise the check would audit whatever is showing. */
  const reach = (locator, name, timeout) => locator.waitFor({ state: 'visible', timeout }).then(() => true, () => { console.log(`  never reached: ${name}`); report.unreachable.push(`never reached: ${name}`); return false; });
  const alive = (timeout = 20000) => page.locator('.touch-controls').first().waitFor({ state: 'visible', timeout });
  const touch = async (type, points) => { if (cdp) await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) }); };
  const dialog = page.locator('dialog.modal');
  const list = page.locator('.preparation-panel ul');

  console.log(`${width}x${height} (notch ${left}/${right}, home bar ${bottom})`);
  await page.goto(BASE, { waitUntil: 'load' });
  await page.locator('#player-name').fill('Phone fit');
  await named('Play against bots').tap();
  await named('Create bot match').tap();
  await named('Enter bot match').tap();
  await page.getByText('Your arena is ready.').waitFor({ state: 'visible', timeout: 120000 });
  await check('ready');
  if (await list.evaluate(el => el.children.length <= 4 && el.scrollHeight > el.clientHeight + 1)) report.unreachable.push('four names do not fit in the player list');
  const help = named('Play full screen');
  if (await help.count()) {
    await press(help, 'Play full screen');
    await dialog.waitFor({ state: 'visible' });
    await check('full-screen-steps');
    await dialog.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await check('full-screen-steps-end');
    await press(named('Back to game'), 'Back to game');
    await page.getByText('Your arena is ready.').waitFor({ state: 'visible' });
  } else if (!process.env.REAL_FULLSCREEN) report.unreachable.push('no Play full screen button');
  // Eight names in the list, and a finger that scrolls them.
  const people = await list.evaluate(el => { const count = el.children.length; for (let i = count; i < 8; i++) el.append(el.firstElementChild.cloneNode(true)); return count; });
  await check('ready-full-room');
  const box = await list.boundingBox();
  if (cdp && box && await list.evaluate(el => el.scrollHeight > el.clientHeight + 1)) {
    const x = box.x + box.width / 2, y = box.y + box.height - 4;
    await touch('touchStart', [[x, y]]);
    for (let step = 1; step <= 6; step++) { await touch('touchMove', [[x, y - step * Math.min(8, box.height / 7)]]); await wait(30); }
    await touch('touchEnd', []);
    await wait(250);
    if (!(await list.evaluate(el => el.scrollTop > 0))) report.unreachable.push('a finger cannot scroll the player list');
  }
  await list.evaluate((el, count) => { while (el.children.length > count) el.lastElementChild.remove(); el.scrollTop = 0; }, people);
  await press(named('Change'), 'Change');
  await dialog.waitFor({ state: 'visible' });
  await check('loadout');
  await press(page.getByRole('radio', { name: /Custom/ }).first(), 'Custom');
  await check('loadout-custom');
  await dialog.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await check('loadout-end');
  await press(named('Back to game'), 'Back to game');
  await press(named('Ready to play'), 'Ready to play');
  await reach(page.locator('.center-message'), 'countdown', 15000);
  await check('countdown');
  await alive(15000);
  await wait(500);
  await check('play');
  await press(named('Match standings'), 'Match standings');
  await check('standings');
  await press(named('Match standings'), 'Match standings');
  await press(named('Pause menu'), 'Pause menu');
  await check('pause');
  await press(named('Settings'), 'Settings');
  await dialog.waitFor({ state: 'visible' });
  await check('settings');
  await press(named('Back to game'), 'Back to game');
  await press(named('Resume game'), 'Resume game');
  // A bot can eliminate the player here, so this waits out a respawn.
  const mortar = page.locator('.touch-reward').nth(1);
  if (await reach(mortar, 'reward buttons', 25000)) {
    await press(mortar, 'Mortar reward');
    if (await reach(page.locator('.mortar-overlay'), 'mortar map', 3000)) {
      await check('mortar');
      await press(page.locator('.mortar-overlay').getByRole('button', { name: 'Cancel' }), 'Cancel mortar');
    }
  }
  // A frag held past its fuse is the reliable way to the respawn card.
  for (let attempt = 0; attempt < 8 && !(await page.locator('.respawn-card').count()); attempt++) {
    await alive(8000).catch(() => {});
    const grenade = await named('Grenade').boundingBox().catch(() => null);
    if (grenade && cdp) { await touch('touchStart', [[grenade.x + grenade.width / 2, grenade.y + grenade.height / 2]]); await wait(4200); await touch('touchEnd', []); }
    await wait(700);
  }
  // WebKit cannot script a held finger, so there it depends on a bot; the card is checked if one comes.
  if (cdp ? await reach(page.locator('.respawn-card'), 'respawn card', 25000) : await page.locator('.respawn-card').waitFor({ state: 'visible', timeout: 25000 }).then(() => true, () => false)) await check('respawn');
  if (await reach(page.locator('.scoreboard-overlay.results'), 'results', 150000)) {
    await wait(600);
    await check('results');
  }
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 1));
  await context.close();
  if (report.errors.length) console.log(`  page errors: ${report.errors.slice(0, 3).join(' | ')}`);
  return Object.values(report.screens).flat().length + report.unreachable.length + report.errors.length;
}

if (await fetch(`${BASE}/health`).then(() => true, () => false)) {
  console.error(`Something is already running on port ${PORT}. Stop it, or set PHONE_FIT_PORT.`);
  process.exit(1);
}
const data = mkdtempSync(join(tmpdir(), 'kannon-phone-fit-'));
const server = spawn(process.execPath, ['--import', 'tsx', 'scripts/phone-fit/server.mts'], { stdio: 'ignore',
  env: { ...process.env, PORT: String(PORT), DB_PATH: join(data, 'phone-fit.sqlite'), ALLOWED_ORIGINS: BASE } });
let failures = 0;
try {
  for (let tries = 0; ; tries++) {
    if (await fetch(`${BASE}/health`).then(response => response.ok, () => false)) break;
    if (tries > 120) throw new Error('The test server did not start.');
    await wait(500);
  }
  const browser = await (useWebkit ? webkit : chromium).launch({ headless: true, args: useWebkit ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  for (const size of sizes) failures += await play(browser, size).catch(error => { console.log(`  failed: ${error.message.slice(0, 300)}`); return 1; });
  await browser.close();
} finally {
  server.kill();
  await wait(300);
  rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(failures ? `${failures} problem(s). Screenshots: ${OUT}` : `Every screen fits. Screenshots: ${OUT}`);
process.exit(failures ? 1 : 0);
