/** Matched Before/After captures of Kannon Town v3 (Before: v2) from the real renderer on the
 *  installed Edge (hardware GPU). Same camera, canvas and quality for each pair; each side is
 *  lit with the real-time light it was made for (src/vehicle-test/main.tsx, ?graphics=v3).
 *
 *  Start only the page server first (no game server is needed for fixed views):
 *    node scripts/build-ktx2-worker.mjs
 *    node node_modules/vite/bin/vite.js --config vite.graphics.config.ts --port 5194 --strictPort
 *  then:
 *    node scripts/vehicle-test/capture-town-v3.mjs [--url http://127.0.0.1:5194/graphics-test.html] [--out art/source/town-v3/captures] */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import sharp from 'sharp';

const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://127.0.0.1:5194/graphics-test.html' },
  out: { type: 'string', default: 'art/source/town-v3/captures' },
  'executable-path': { type: 'string', default: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' },
  settle: { type: 'string', default: '2500' },
} });
const url = new URL(values.url), output = resolve(values.out), settle = Number(values.settle);
assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname)); assert.equal(url.pathname, '/graphics-test.html');
await mkdir(output, { recursive: true });
const VIEWS = {
  'checkpoint-north': 'Checkpoint from the north end', 'checkpoint-south': 'Checkpoint from the south end', truck: 'Cargo truck',
  'burnt-car': 'Burnt-out car and ammo crates', barrier: 'Concrete barrier', 'yard-sandbags': 'Back-yard sandbags',
  'teal-shadow': 'Long shadows across the street', street: 'Main street', 'teal-front': 'Teal house front',
  'teal-room': 'Teal house ground floor', 'yellow-upstairs': 'Yellow house upstairs window', 'bus-gameplay': 'Bus, player view',
  'yard-crates': 'Back-yard crate stack', 'broken-window': 'Broken upstairs window',
  'sun-shadow': 'Player in the sun: real-time shadow', 'shade-shadow': 'Player in house shade: no phantom shadow',
};
const PHONE_VIEWS = new Set(['checkpoint-north', 'teal-shadow', 'teal-room', 'bus-gameplay', 'shade-shadow']);
const manifest = { capturedAt: new Date().toISOString(), url: url.href, note: 'Before = Kannon Town v2 under v2 exposure, fog and daylight; After = v3 under the golden-hour light. Both sides share the v3 sky dome.', captures: [] };
const api = (page, name, value) => page.evaluate(async ({ name, value }) => await window.vehicleTest[name](value), { name, value });
const browser = await chromium.launch({ executablePath: values['executable-path'], headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const pairs = [];
try {
  for (const [label, mobile] of [['desktop', false], ['phone', true]]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 852, height: 393 } : { width: 1280, height: 720 }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    page.setDefaultTimeout(240000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const target = new URL(url); target.searchParams.set('graphics', 'v3'); target.searchParams.set('quality', mobile ? 'auto' : 'high'); if (mobile) target.searchParams.set('tier', 'phone');
    await page.goto(target.href); await page.waitForFunction(() => window.vehicleTest?.ready === true);
    const info = await api(page, 'info');
    assert.ok(!/SwiftShader|software/i.test(info.gpu || ''), `Hardware GPU required, got ${info.gpu}`);
    for (const [view, title] of Object.entries(VIEWS)) {
      if (mobile && !PHONE_VIEWS.has(view)) continue;
      await api(page, 'selectView', view);
      const pair = {};
      for (const [variant, name] of [['current', 'before'], ['improved', 'after']]) {
        await api(page, 'setVariant', variant); await page.waitForTimeout(settle);
        const file = `town-v3-${view}-${name}-${label}.jpg`;
        await page.screenshot({ path: join(output, file), type: 'jpeg', quality: 86 });
        const state = await api(page, 'info');
        manifest.captures.push({ file, title, view, variant: name, label, camera: state.camera, canvas: state.canvas, quality: state.quality, tier: state.tier, lighting: state.lighting, drawCalls: state.drawCalls, triangles: state.triangles });
        pair[name] = join(output, file);
        process.stdout.write(`${file}\n`);
      }
      pairs.push({ ...pair, label, view });
    }
    manifest[`${label}Errors`] = errors;
    await context.close();
  }
} finally { await browser.close(); }
await writeFile(join(output, 'captures.json'), JSON.stringify(manifest, null, 2) + '\n');
// One review sheet: Before | After per row.
const width = 640;
const rows = await Promise.all(pairs.map(async pair => Promise.all([pair.before, pair.after].map(file => sharp(file).resize({ width }).toBuffer()))));
const heights = await Promise.all(rows.map(async ([before]) => (await sharp(before).metadata()).height));
const sheet = sharp({ create: { width: width * 2 + 8, height: heights.reduce((s, h) => s + h + 8, 0), channels: 3, background: '#111' } });
let top = 0; const composite = [];
rows.forEach(([before, after], i) => { composite.push({ input: before, left: 0, top }, { input: after, left: width + 8, top }); top += heights[i] + 8; });
await sheet.composite(composite).jpeg({ quality: 82 }).toFile(join(output, 'captures-sheet.jpg'));
console.log(`${manifest.captures.length} captures, sheet ${join(output, 'captures-sheet.jpg')}`);
