/** Focused repeated GPU measurement; no screenshots during timed samples.
 * Run after the main visual/interaction checks with no other active 3D tab.
 * Default: mobile touch-emulated Auto A/B/A in one page. --original-repeat adds
 * original High and split-current High in separate pages, sequentially.
 * Desktop emulation is never physical iPhone acceptance.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';

const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://127.0.0.1:5183/vehicle-test.html' },
  out: { type: 'string', default: join(tmpdir(), 'kannon-vehicle-test') },
  'executable-path': { type: 'string', default: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' },
  'sample-ms': { type: 'string', default: '20000' },
  'original-repeat': { type: 'boolean', default: false },
} });
const url = new URL(values.url), output = resolve(values.out), sampleMs = Number(values['sample-ms']);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)); assert.equal(url.pathname, '/vehicle-test.html');
assert.ok(Number.isFinite(sampleMs) && sampleMs >= 2000 && sampleMs <= 60000);
await mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), status: 'running', url: url.href, purpose: 'Repeat mobile Auto A/B/A to test reproducibility of GPU cost despite the 60 Hz frame cap.',
  protocol: { sampleMs, warmupMs: 7000, view: 'bus-gameplay', sequentialPages: true, screenshotsDuringSamples: false, mobile: '852x393 CSS, DPR1, hasTouch/isMobile, fixed Auto graphics on recorded desktop GPU' },
  limits: ['Desktop browser touch emulation, not physical iPhone performance.', 'GPU timer values can vary with driver scheduling and GPU clock/power behavior. Repeat brackets are retained, not averaged away.', 'Original versus split comparison changes batching. Any apparent speedup is not proof that adding the candidate improves performance.'],
  pages: [], runs: [], errors: [], warnings: [] };
const save = () => writeFile(join(output, 'performance-repeat-report.json'), JSON.stringify(report, null, 2) + '\n');
const log = message => process.stdout.write(`${new Date().toISOString()} ${message}\n`);
const api = (page, name, value) => page.evaluate(async ({ name, value }) => await window.vehicleTest[name](value), { name, value });
function config(info) {
  return Object.fromEntries(['camera', 'quality', 'qualityLocked', 'qualityScale', 'viewport', 'canvas', 'devicePixelRatio', 'pixelRatio', 'postprocessing', 'shadowSize', 'lighting'].map(key => [key, info[key]]));
}
function same(a, b, path = 'config') {
  if (typeof a === 'number' && typeof b === 'number') assert.ok(Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < .00002, `${path}: ${a} versus ${b}`);
  else if (a && b && typeof a === 'object' && typeof b === 'object') { assert.deepEqual(Object.keys(a), Object.keys(b)); for (const key of Object.keys(a)) same(a[key], b[key], `${path}.${key}`); }
  else assert.deepEqual(a, b, path);
}
let browser;
async function pageRun(label, mobile, original, variants) {
  const quality = mobile ? 'auto' : 'high';
  const context = await browser.newContext({ viewport: mobile ? { width: 852, height: 393 } : { width: 1280, height: 720 }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage(), models = [], bodyJobs = [];
  page.setDefaultTimeout(90000);
  page.on('pageerror', error => report.errors.push({ label, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.errors.push({ label, message: message.text(), location: message.location() }); if (message.type() === 'warning') report.warnings.push({ label, message: message.text() }); });
  page.on('response', response => {
    if (response.status() >= 400) report.errors.push({ label, url: response.url(), status: response.status() });
    if (response.ok() && /\/models\/.*\.glb(?:[?#]|$)/i.test(response.url())) bodyJobs.push(response.body().then(bytes => models.push({ path: new URL(response.url()).pathname, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })));
  });
  try {
    const cdp = await context.newCDPSession(page); await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    const target = new URL(url); target.searchParams.set('quality', quality); if (original) target.searchParams.set('original', '1');
    log(`Open ${label}`); await page.goto(target.href); await page.waitForFunction(() => window.vehicleTest?.ready === true);
    await Promise.all(bodyJobs); await api(page, 'selectView', 'bus-gameplay');
    const initial = await api(page, 'info');
    assert.ok(/AMD|Radeon|NVIDIA|Intel/i.test(initial.gpu || '') && !/Basic Render|SwiftShader|software/i.test(initial.gpu || ''), 'Hardware GPU required');
    assert.equal(initial.qualityLocked, true); assert.equal(initial.quality, quality);
    report.pages.push({ label, url: page.url(), initial, models });
    let first;
    for (const [index, variant] of variants.entries()) {
      if (!original) await api(page, 'setVariant', variant);
      log(`Warm ${label}-${variant}-${index + 1}`); await page.waitForTimeout(7000);
      const before = await api(page, 'info');
      if (first) same(config(first), config(before)); else first = before;
      log(`Measure ${label}-${variant}-${index + 1} for ${sampleMs} ms`);
      const measured = await api(page, 'sample', sampleMs), after = await api(page, 'info');
      same(config(before), config(after));
      assert.ok(measured.sampleFrames > 0 && measured.elapsedMs >= sampleMs - 1 && Number.isFinite(measured.fps));
      report.runs.push({ label: `${label}-${variant}-${index + 1}`, before, measured, after, fixedCameraAndSettings: true });
      await save(); log(`Finished ${label}-${variant}-${index + 1}: ${measured.fps.toFixed(3)} FPS; GPU p50 ${measured.gpuMs?.p50}`);
    }
  } finally { await context.close(); }
}
try {
  browser = await chromium.launch({ executablePath: values['executable-path'], headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
  report.browserVersion = browser.version();
  await pageRun('mobile-emulated-auto-repeat', true, false, ['current', 'improved', 'current']);
  if (values['original-repeat']) {
    await pageRun('original-unsplit-high-repeat', false, true, ['original-unsplit']);
    await pageRun('split-current-high-repeat', false, false, ['current']);
    const original = report.runs.find(run => run.label.startsWith('original-unsplit-high-repeat'));
    const split = report.runs.find(run => run.label.startsWith('split-current-high-repeat'));
    same(config(original.before), config(split.before));
  }
  assert.equal(report.errors.length, 0, 'No browser/application errors'); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.errors.push({ message: error.message, stack: error.stack }); process.exitCode = 1; log(`FAIL ${error.message}`); }
finally { report.finishedAt = new Date().toISOString(); await browser?.close(); await save(); log(`Report: ${join(output, 'performance-repeat-report.json')}`); }
