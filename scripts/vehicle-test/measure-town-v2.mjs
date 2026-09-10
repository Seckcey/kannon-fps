/** Repeated GPU measurement of Kannon Town v2 against the previous town on the installed Edge
 *  (hardware GPU through ANGLE). Desktop High at 1280x720 and touch-emulated Auto (the phone
 *  tier with the phone GLB) at 852x393, fixed bus gameplay view, adaptation locked.
 *
 *  node scripts/vehicle-test/measure-town-v2.mjs [--url http://127.0.0.1:5184/graphics-test.html] [--out docs/verification/town-v2-performance.json]
 *
 *  Desktop touch emulation is never physical iPhone acceptance. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';

const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://127.0.0.1:5184/graphics-test.html' },
  out: { type: 'string', default: 'docs/verification/town-v2-performance.json' },
  'executable-path': { type: 'string', default: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' },
  'sample-ms': { type: 'string', default: '20000' },
} });
const url = new URL(values.url), output = resolve(values.out), sampleMs = Number(values['sample-ms']);
assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname)); assert.equal(url.pathname, '/graphics-test.html');
await mkdir(dirname(output), { recursive: true });
const report = { startedAt: new Date().toISOString(), status: 'running', url: url.href,
  purpose: 'Kannon Town v2 (lightmapped, KTX2) versus the shipped refined town at identical camera, canvas and quality settings.',
  protocol: { sampleMs, warmupMs: 7000, view: 'bus-gameplay', order: 'refined, v2, refined per page', desktop: '1280x720 CSS, DPR 1, High fixed, desktop presentation stack', phone: '852x393 CSS, DPR 1, hasTouch/isMobile, Auto fixed = phone tier with environment-v2-phone.glb' },
  limits: ['Desktop browser touch emulation, not physical iPhone performance.', 'GPU timer values vary with driver scheduling and clocks; repeat brackets are retained, not averaged away.', 'Both towns are resident in the comparison page, so memory figures are not production memory.'],
  pages: [], runs: [], errors: [], warnings: [] };
const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n');
const log = message => process.stdout.write(`${new Date().toISOString()} ${message}\n`);
const api = (page, name, value) => page.evaluate(async ({ name, value }) => await window.vehicleTest[name](value), { name, value });
function config(info) {
  return Object.fromEntries(['camera', 'quality', 'qualityLocked', 'qualityScale', 'viewport', 'canvas', 'devicePixelRatio', 'pixelRatio', 'postprocessing', 'shadowSize', 'lighting', 'tier'].map(key => [key, info[key]]));
}
function same(a, b, path = 'config') {
  if (typeof a === 'number' && typeof b === 'number') assert.ok(Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < .00002, `${path}: ${a} versus ${b}`);
  else if (a && b && typeof a === 'object' && typeof b === 'object') { assert.deepEqual(Object.keys(a), Object.keys(b)); for (const key of Object.keys(a)) same(a[key], b[key], `${path}.${key}`); }
  else assert.deepEqual(a, b, path);
}
let browser;
async function pageRun(label, mobile) {
  const quality = mobile ? 'auto' : 'high';
  const context = await browser.newContext({ viewport: mobile ? { width: 852, height: 393 } : { width: 1280, height: 720 }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage(), models = [];
  page.setDefaultTimeout(180000);
  page.on('pageerror', error => report.errors.push({ label, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.errors.push({ label, message: message.text() }); if (message.type() === 'warning' && !/X4122/.test(message.text())) report.warnings.push({ label, message: message.text().slice(0, 300) }); });
  page.on('response', response => {
    if (response.status() >= 400) report.errors.push({ label, url: response.url(), status: response.status() });
    // Model identity comes from the validator manifests; here only the served path and size are noted.
    if (response.ok() && /\/models\/.*\.glb(?:[?#]|$)/i.test(response.url())) models.push({ path: new URL(response.url()).pathname, contentLength: Number(response.headers()['content-length'] ?? 0) || null });
  });
  try {
    const target = new URL(url); target.searchParams.set('graphics', 'v2'); target.searchParams.set('quality', quality); if (mobile) target.searchParams.set('tier', 'phone');
    log(`Open ${label}`); await page.goto(target.href); await page.waitForFunction(() => window.vehicleTest?.ready === true);
    await api(page, 'selectView', 'bus-gameplay');
    const initial = await api(page, 'info');
    assert.ok(/AMD|Radeon|NVIDIA|Intel/i.test(initial.gpu || '') && !/Basic Render|SwiftShader|software/i.test(initial.gpu || ''), `Hardware GPU required, got ${initial.gpu}`);
    assert.equal(initial.qualityLocked, true); assert.equal(initial.quality, quality);
    report.pages.push({ label, url: page.url(), initial, models });
    let first;
    for (const [index, variant] of ['current', 'improved', 'current'].entries()) {
      await api(page, 'setVariant', variant);
      log(`Warm ${label}-${variant}-${index + 1}`); await page.waitForTimeout(7000);
      const before = await api(page, 'info');
      if (first) same(config(first), config(before)); else first = before;
      log(`Measure ${label}-${variant}-${index + 1} for ${sampleMs} ms`);
      const measured = await api(page, 'sample', sampleMs), after = await api(page, 'info');
      same(config(before), config(after));
      assert.ok(measured.sampleFrames > 0 && Number.isFinite(measured.fps));
      report.runs.push({ label: `${label}-${variant === 'improved' ? 'v2' : 'refined'}-${index + 1}`, before, measured, after, fixedCameraAndSettings: true });
      await save(); log(`Finished ${label}-${variant}-${index + 1}: ${measured.fps.toFixed(2)} FPS; GPU p50 ${measured.gpuMs?.p50}; draws ${measured.drawCalls ?? before.drawCalls ?? '?'}`);
    }
  } finally { await context.close(); }
}
try {
  browser = await chromium.launch({ executablePath: values['executable-path'], headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
  report.browserVersion = browser.version();
  await pageRun('desktop-high', false);
  await pageRun('phone-emulated-auto', true);
  report.status = report.errors.length ? 'errors' : 'passed';
} catch (error) {
  report.status = 'failed'; report.errors.push({ message: error.message });
  throw error;
} finally {
  report.finishedAt = new Date().toISOString(); await save(); await browser?.close();
  log(`${report.status}: ${output}`);
}
