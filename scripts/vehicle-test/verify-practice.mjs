/** Native-input smoke test against the isolated local game's real server.
 * Start the local server and Vite proxy first. No production URLs are accepted.
 * Writes only external QA evidence; never records profile tokens or auth frames.
 * node scripts/vehicle-test/verify-practice.mjs --url http://127.0.0.1:5183/
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';

const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://127.0.0.1:5183/' },
  out: { type: 'string', default: join(tmpdir(), 'kannon-vehicle-test') },
  channel: { type: 'string', default: 'msedge' },
  'executable-path': { type: 'string' },
  headed: { type: 'boolean', default: false },
} });
const base = new URL(values.url), output = resolve(values.out);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Local practice only.');
assert.equal(base.pathname, '/');
await mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), status: 'running', url: base.href,
  scope: 'Real local practice UI, native desktop/touch input and received authoritative server snapshots; no synthetic gameplay snapshots, clocks, hit results or input frames are injected.',
  limitations: ['Mobile checks are desktop Chromium touch emulation, not a physical iPhone test.', 'Short unranked practice checks do not establish two-household play, WAN latency, full-round results or device thermal performance.', 'This intentionally creates disposable local QA profiles and unranked practice rooms in the isolated server database. Auth/profile tokens are neither inspected nor retained.'],
  browserPath: 'Browser plugin not available; repository Playwright with installed Edge.', cases: [], errors: [], warnings: [] };
const save = () => writeFile(join(output, 'practice-report.json'), JSON.stringify(report, null, 2) + '\n');
const log = message => process.stdout.write(`${new Date().toISOString()} ${message}\n`);
let browser;
async function state(page) {
  return page.evaluate(() => {
    const q = window.practiceQA, p = q.snapshot?.players.find(player => player.id === q.playerId);
    return { phase: q.snapshot?.phase, player: p ? { x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, health: p.health, slot: p.slot, ammoAR: p.ammoAR, ammoShotgun: p.ammoShotgun, reloadingUntil: p.reloadingUntil } : null,
      input: q.inputs.at(-1), snapshots: q.snapshotCount, localShots: q.localShots, botShots: q.botShots, phases: [...q.phases], players: q.snapshot?.players.length,
      pointerLocked: Boolean(document.pointerLockElement), errors: [...q.errors] };
  });
}
async function capture(page, filename) {
  await page.screenshot({ path: join(output, filename), animations: 'disabled' });
  return { path: filename, kind: 'Actual local practice GameView capture; real server and native input' };
}
async function assertHealth(page, label) {
  const result = await page.evaluate(() => {
    const canvas = document.querySelector('canvas'), rect = canvas?.getBoundingClientRect(), gl = canvas?.getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return { title: document.title, text: document.body.innerText.slice(0, 2000), viewport: [innerWidth, innerHeight],
      canvas: rect ? [rect.width, rect.height, canvas.width, canvas.height] : null,
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
      overlay: Boolean(document.querySelector('vite-error-overlay, webpack-dev-server-client-overlay')),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      models: performance.getEntriesByType('resource').filter(r => /\/models\/.*\.glb(?:[?#]|$)/.test(r.name)).map(r => ({ path: new URL(r.name).pathname, transferSize: r.transferSize, encodedBodySize: r.encodedBodySize })),
      controls: [...document.querySelectorAll('[data-touch]')].map(el => ({ action: el.dataset.touch, box: el.getBoundingClientRect().toJSON() })),
    };
  });
  assert.match(result.title, /Kannon/i, `${label}: correct page`);
  assert.match(result.text, /Kannon Town/i, `${label}: actual game HUD`);
  assert.equal(result.overlay, false); assert.equal(result.horizontalOverflow, false);
  assert.ok(result.canvas?.[0] > 0 && result.canvas[1] > 0);
  assert.ok(!/Graphics unavailable|could not load|Something went wrong/i.test(result.text));
  return result;
}

async function runCase(label, variant, mobile) {
  const context = await browser.newContext({ viewport: mobile ? { width: 852, height: 393 } : { width: 1280, height: 720 }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage(); page.setDefaultTimeout(60000);
  const result = { label, variant, mobileEmulated: mobile, status: 'running', checks: [], captures: [] }; report.cases.push(result);
  page.on('pageerror', error => report.errors.push({ label, type: 'pageerror', message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.errors.push({ label, type: 'console', message: message.text(), location: message.location() }); if (message.type() === 'warning') report.warnings.push({ label, type: 'console', message: message.text() }); });
  page.on('response', response => { if (response.status() >= 400) report.errors.push({ label, type: 'http', status: response.status(), url: response.url() }); });
  await page.addInitScript(() => {
    const q = { playerId: '', snapshot: null, snapshotCount: 0, inputs: [], localShots: 0, botShots: 0, phases: new Set(), errors: [] };
    window.practiceQA = q;
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', event => {
          let message; try { message = JSON.parse(event.data); } catch { return; }
          if (message.type === 'welcome') q.playerId = message.playerId;
          if (message.type === 'snapshot') { q.snapshot = message.snapshot; q.snapshotCount++; q.phases.add(message.snapshot.phase); }
          if (message.type === 'event' && message.event.type === 'shot') {
            if (message.event.playerId === q.playerId) q.localShots++; else q.botShots++;
          }
          if (message.type === 'error') q.errors.push(message.message);
        });
      }
      send(data) {
        // Observe only normal input frames. Never retain the hello/auth message.
        let message; try { message = JSON.parse(data); } catch { return super.send(data); }
        if (message.type === 'input') { q.inputs.push(message.input); if (q.inputs.length > 180) q.inputs.shift(); }
        return super.send(data);
      }
    };
  });
  try {
    const url = new URL(base); url.searchParams.set('vehicles', variant);
    log(`Open ${label}: ${url.href}`); await page.goto(url.href);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel(/^Graphics/).selectOption('low');
    await page.getByLabel(/^Mobile firing/).selectOption('advanced');
    await page.getByRole('slider', { name: /Game volume/ }).press('Home');
    assert.equal(await page.getByRole('slider', { name: /Game volume/ }).inputValue(), '0');
    await page.getByRole('button', { name: 'Back to arena', exact: true }).click();
    await page.getByLabel('Player name', { exact: true }).fill(mobile ? 'Vehicle Touch QA' : `Vehicle ${variant === 'current' ? 'Before' : 'After'} QA`);
    await page.getByRole('button', { name: 'Play against bots', exact: true }).click();
    await page.getByRole('radio', { name: /Relaxed/ }).check();
    await page.getByRole('button', { name: 'Create bot match', exact: true }).click();
    await page.getByRole('button', { name: 'Enter bot match', exact: true }).click();
    await page.getByRole('button', { name: 'Ready to play', exact: true }).waitFor({ state: 'visible' });
    assert.equal((await state(page)).phase, 'preparing');
    await page.getByRole('button', { name: 'Ready to play', exact: true }).click();
    await page.waitForFunction(() => window.practiceQA.snapshot?.phase === 'playing');
    if (!mobile) await page.waitForFunction(() => document.pointerLockElement !== null);
    const started = await state(page);
    assert.ok(started.phases.includes('countdown') && started.phases.includes('preparing'));
    assert.equal(started.players, 4); result.checks.push('Actual artwork readiness, deliberate Ready, countdown and four-player practice');

    const before = await state(page);
    assert.ok(before.player?.health > 0);
    if (mobile) {
      const cdp = await context.newCDPSession(page), point = (id, x, y) => ({ id, x, y, radiusX: 1, radiusY: 1, force: 1 });
      const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
      await page.getByLabel('Movement joystick', { exact: true }).waitFor({ state: 'visible' });
      const move = await page.getByLabel('Movement joystick', { exact: true }).boundingBox();
      const mx = move.x + move.width / 2, my = move.y + move.height / 2;
      await touch('touchStart', [point(1, mx, my)]); await touch('touchMove', [point(1, mx, my - 44)]);
      await page.waitForFunction(() => window.practiceQA.inputs.at(-1)?.moveZ > .8);
      await page.waitForTimeout(600); await touch('touchEnd', []);
      await page.waitForFunction(() => { const q = window.practiceQA, p = q.snapshot?.players.find(p => p.id === q.playerId); return p && Math.hypot(p.vx, p.vz) === 0 && q.inputs.at(-1)?.moveZ === 0; });
      result.afterMove = await state(page);
      const look = await page.getByLabel('Drag to look', { exact: true }).boundingBox(), lx = look.x + look.width * .6, ly = look.y + look.height * .4;
      const yaw = result.afterMove.input.yaw;
      await touch('touchStart', [point(2, lx, ly)]); await touch('touchMove', [point(2, lx + 35, ly + 4)]); await touch('touchEnd', []);
      await page.waitForFunction(previous => window.practiceQA.inputs.at(-1)?.yaw !== previous, yaw);
      const fire = await page.getByRole('button', { name: 'Fire and drag to aim', exact: true }).boundingBox(), fx = fire.x + fire.width / 2, fy = fire.y + fire.height / 2;
      await touch('touchStart', [point(3, fx, fy)]); await touch('touchMove', [point(3, fx + 8, fy - 4)]);
      await page.waitForFunction(() => window.practiceQA.inputs.at(-1)?.fire && window.practiceQA.inputs.at(-1)?.aim && window.practiceQA.localShots > 0);
      await touch('touchEnd', []); await page.waitForFunction(() => !window.practiceQA.inputs.at(-1)?.fire);
      result.checks.push('Native touch joystick movement and authoritative release stop', 'Native touch look and manual Fire drag/ADS produce a server shot');
    } else {
      await page.keyboard.down('w'); await page.waitForTimeout(600); await page.keyboard.up('w');
      await page.waitForFunction(() => { const q = window.practiceQA, p = q.snapshot?.players.find(p => p.id === q.playerId); return p && Math.hypot(p.vx, p.vz) === 0 && q.inputs.at(-1)?.moveZ === 0; });
      result.afterMove = await state(page);
      const yaw = result.afterMove.input.yaw;
      await page.mouse.move(680, 330); await page.mouse.move(705, 335);
      await page.waitForFunction(previous => window.practiceQA.inputs.at(-1)?.yaw !== previous, yaw);
      await page.mouse.down({ button: 'right' }); await page.mouse.down();
      await page.waitForFunction(() => window.practiceQA.inputs.at(-1)?.fire && window.practiceQA.inputs.at(-1)?.aim && window.practiceQA.localShots > 0);
      await page.mouse.up(); await page.mouse.up({ button: 'right' });
      await page.waitForFunction(() => !window.practiceQA.inputs.at(-1)?.fire && !window.practiceQA.inputs.at(-1)?.aim);
      for (const slot of [2, 3, 1]) { await page.keyboard.press(String(slot)); await page.waitForFunction(expected => window.practiceQA.snapshot.players.find(p => p.id === window.practiceQA.playerId)?.slot === expected, slot); }
      result.checks.push('Native pointer capture through countdown', 'Keyboard movement and authoritative release stop', 'Mouse look/manual fire/ADS produce a server shot', 'All three loadout slots reach authoritative snapshots');
    }
    result.travel = Math.hypot(result.afterMove.player.x - before.player.x, result.afterMove.player.z - before.player.z);
    assert.ok(result.travel > .5, `${label}: actual server movement`);
    assert.ok(result.afterMove.player.health > 0, `${label}: movement comparison remains the same living player`);
    result.layout = await assertHealth(page, label);
    const expectedModel = variant === 'improved' ? '/models/vehicles-improved.glb' : '/models/environment.glb';
    assert.ok(result.layout.models.some(model => model.path === expectedModel), `${label}: expected vehicle asset was downloaded`);
    if (variant === 'current') assert.ok(!result.layout.models.some(model => model.path === '/models/vehicles-improved.glb'), `${label}: ordinary baseline does not load the candidate`);
    const expectedModels = variant === 'improved'
      ? ['/models/scout.glb', '/models/environment-vehicle-test.glb', '/models/vehicles-improved.glb']
      : ['/models/scout.glb', '/models/environment.glb'];
    assert.deepEqual(result.layout.models.map(model => model.path).sort(), expectedModels.sort(), `${label}: each required model appears exactly once, with no extra baseline/variant download`);
    result.checks.push('Each expected model downloaded once; candidate practice does not download original artwork');
    result.captures.push(await capture(page, `practice-${label}-gameplay.png`));
    if (mobile) {
      await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(500);
      result.portraitLayout = await assertHealth(page, `${label}-portrait`);
      result.captures.push(await capture(page, `practice-${label}-portrait.png`));
      await page.setViewportSize({ width: 852, height: 393 }); await page.waitForTimeout(500);
      result.checks.push('Portrait layout and return to landscape retain the rendered game');
    } else {
      await page.keyboard.press('Escape'); await page.waitForFunction(() => document.pointerLockElement === null);
      await page.getByRole('button', { name: /^Click to play/ }).click(); await page.waitForFunction(() => document.pointerLockElement !== null);
      await page.keyboard.press('Escape'); await page.waitForFunction(() => document.pointerLockElement === null);
      result.checks.push('Escape release and deliberate mouse recapture');
    }
    result.finalState = await state(page); assert.deepEqual(result.finalState.errors, []);
    await page.getByRole('button', { name: 'Pause menu', exact: true }).click();
    await page.getByRole('button', { name: 'Leave match', exact: true }).click();
    await page.getByLabel('Player name', { exact: true }).waitFor({ state: 'visible' });
    result.checks.push('Pause and explicit Leave match return to the menu'); result.status = 'passed'; log(`PASS ${label}`);
  } catch (error) {
    result.status = 'failed'; result.failure = { message: error.message, stack: error.stack };
    try { result.captures.push(await capture(page, `practice-${label}-failure.png`)); } catch {}
    throw error;
  } finally { await save(); await context.close(); }
}

try {
  browser = await chromium.launch({ ...(values['executable-path'] ? { executablePath: values['executable-path'] } : { channel: values.channel }), headless: !values.headed, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
  report.browserVersion = browser.version();
  await runCase('desktop-current', 'current', false);
  await runCase('desktop-improved', 'improved', false);
  await runCase('mobile-emulated-improved', 'improved', true);
  assert.equal(report.errors.length, 0, 'No application/browser errors'); report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.errors.push({ type: 'verification', message: error.message, stack: error.stack }); process.exitCode = 1; log(`FAIL ${error.message}`);
} finally {
  report.finishedAt = new Date().toISOString(); await browser?.close(); await save(); log(`Report: ${join(output, 'practice-report.json')}`);
}
