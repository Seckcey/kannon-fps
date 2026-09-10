/** Matched Before/After captures of Kannon Town v2 from the real renderer on the installed Edge
 *  (hardware GPU). Same camera, canvas and quality for each pair.
 *
 *  node scripts/vehicle-test/capture-town-v2.mjs [--url http://127.0.0.1:5184/graphics-test.html] [--out docs/art] */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';

const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://127.0.0.1:5184/graphics-test.html' },
  out: { type: 'string', default: 'docs/art' },
  'executable-path': { type: 'string', default: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' },
} });
const url = new URL(values.url), output = resolve(values.out);
assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname)); assert.equal(url.pathname, '/graphics-test.html');
await mkdir(output, { recursive: true });
const VIEWS = { street: 'Main street', 'teal-front': 'Teal house front', 'yellow-front': 'Yellow house and garage', 'teal-room': 'Teal house ground floor', yard: 'Backyard', 'spawn-gameplay': 'Spawn third person', 'bus-gameplay': 'Bus third person' };
const manifest = { capturedAt: new Date().toISOString(), url: url.href, captures: [] };
const api = (page, name, value) => page.evaluate(async ({ name, value }) => await window.vehicleTest[name](value), { name, value });
const browser = await chromium.launch({ executablePath: values['executable-path'], headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  for (const [label, mobile] of [['desktop', false], ['phone', true]]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 852, height: 393 } : { width: 1280, height: 720 }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    page.setDefaultTimeout(180000);
    const target = new URL(url); target.searchParams.set('graphics', 'v2'); target.searchParams.set('quality', mobile ? 'auto' : 'high'); if (mobile) target.searchParams.set('tier', 'phone');
    await page.goto(target.href); await page.waitForFunction(() => window.vehicleTest?.ready === true);
    const info = await api(page, 'info');
    assert.ok(!/SwiftShader|software/i.test(info.gpu || ''), `Hardware GPU required, got ${info.gpu}`);
    for (const [view, title] of Object.entries(VIEWS)) {
      if (mobile && !['street', 'spawn-gameplay', 'bus-gameplay', 'teal-room'].includes(view)) continue;
      await api(page, 'selectView', view);
      for (const [variant, name] of [['current', 'before'], ['improved', 'after']]) {
        await api(page, 'setVariant', variant); await page.waitForTimeout(2500);
        const file = `town-v2-${view}-${name}-${label}.jpg`;
        await page.screenshot({ path: join(output, file), type: 'jpeg', quality: 86 });
        const state = await api(page, 'info');
        manifest.captures.push({ file, title, view, variant: name, label, camera: state.camera, canvas: state.canvas, quality: state.quality, tier: state.tier, drawCalls: state.drawCalls, triangles: state.triangles });
        process.stdout.write(`${file}\n`);
      }
    }
    await context.close();
  }
} finally { await browser.close(); }
await writeFile(join(output, '..', 'verification', 'town-v2-captures.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`${manifest.captures.length} captures`);
