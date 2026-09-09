/**
 * Reproducible actual-Three.js vehicle A/B captures and bounded renderer samples.
 * Start the isolated local test server separately, then run:
 *   node scripts/vehicle-test/verify-browser.mjs
 * Optional: --url http://127.0.0.1:5183/vehicle-test.html --headed
 * Reports and captures remain outside the checkout. This never starts a server,
 * purchases assets, changes browser/system settings, or accesses production.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';

const { values: flags } = parseArgs({ options: {
  url: { type: 'string', default: 'http://127.0.0.1:5183/vehicle-test.html' },
  out: { type: 'string', default: join(tmpdir(), 'kannon-vehicle-test') },
  channel: { type: 'string', default: 'msedge' },
  'executable-path': { type: 'string' },
  'sample-ms': { type: 'string', default: '20000' },
  'warmup-ms': { type: 'string', default: '7000' },
  headed: { type: 'boolean', default: false },
  'allow-software': { type: 'boolean', default: false },
  'resume-report': { type: 'string' },
} });
const baseUrl = new URL(flags.url);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname), 'This script is restricted to the explicitly local test server.');
assert.equal(baseUrl.pathname, '/vehicle-test.html', 'Use the isolated /vehicle-test.html route.');
const output = resolve(flags.out), sampleMs = Number(flags['sample-ms']), warmupMs = Number(flags['warmup-ms']);
assert.ok(Number.isFinite(sampleMs) && sampleMs >= 2000 && sampleMs <= 60000);
assert.ok(Number.isFinite(warmupMs) && warmupMs >= 0 && warmupMs <= 60000);
await mkdir(output, { recursive: true });
const views = ['bus-close', 'bus-detail', 'bus-gameplay', 'south-close', 'south-detail', 'south-gameplay', 'north-close', 'north-gameplay'];
const report = {
  startedAt: new Date().toISOString(), status: 'running', url: baseUrl.href,
  scope: 'Actual GameView/Three.js canvas, controlled local vehicle inspection and bounded renderer performance. Controlled snapshots are separate from authoritative multiplayer-input acceptance.',
  browserPath: { classification: 'Browser plugin not available', path: 'Repository Playwright with installed Microsoft Edge by default', channel: flags.channel, headless: !flags.headed },
  protocol: { sampleMs, warmupMs, timedScreenshots: false, sequentialPages: true, cacheDisabled: true, order: 'Desktop High current / improved / current, mobile touch-emulated Auto current / improved, original unsplit High baseline.' },
  limitations: [
    'Desktop GPU results apply only to the recorded browser, renderer, viewport and pixel budget.',
    'Mobile results use desktop Chromium touch/device emulation. No physical iPhone, iPhone Safari, sensor, thermal or sustained-device performance test is claimed.',
    'CPU render submission time does not measure GPU execution time. GPU timer results are valid only when the API reports supported, completed, non-disjoint samples.',
    'Loading both variants increases comparison download and resident memory. Candidate-only download overhead must be calculated separately from exported asset sizes.',
    'A/B camera and graphics equality is checked per capture and measurement; dynamic scenery or animation may still change between frames.',
  ],
  pages: [], captures: [], performance: [], comparisons: [], interactions: [], errors: [], warnings: [],
};
if (flags['resume-report']) {
  // The first mobile attempt exposed an overly narrow harness text assertion:
  // the responsive toolbar deliberately hides its brand heading. Preserve the
  // completed desktop run instead of silently replacing valid measurements.
  const previous = JSON.parse(await readFile(resolve(flags['resume-report']), 'utf8'));
  assert.equal(previous.url, baseUrl.href); assert.equal(previous.protocol.sampleMs, sampleMs); assert.equal(previous.protocol.warmupMs, warmupMs);
  assert.equal(previous.captures.length, views.length * 2);
  assert.deepEqual(previous.performance.map(run => run.label), ['desktop-high-current-A1', 'desktop-high-improved-B', 'desktop-high-current-A2']);
  assert.ok(previous.errors.length > 0 && previous.errors.every(error => error.kind === 'verification' && error.message === 'mobile-emulated-auto-landscape: meaningful content'), 'Resume only the documented mobile text assertion; real app failures require fresh investigation.');
  Object.assign(report, previous, { status: 'running', errors: [], resumedAt: new Date().toISOString(), previousAttempt: { report: resolve(flags['resume-report']), status: previous.status, errors: previous.errors } });
  delete report.finishedAt;
}
const log = message => process.stdout.write(`${new Date().toISOString()} ${message}\n`);
const save = () => writeFile(join(output, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n');
let browser;

function nearEqual(a, b, label, epsilon = 0.00002) {
  if (typeof a === 'number' && typeof b === 'number') {
    assert.ok(Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= epsilon, `${label}: ${a} != ${b}`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    assert.equal(a.length, b.length, `${label}: array size`);
    a.forEach((value, index) => nearEqual(value, b[index], `${label}[${index}]`, epsilon));
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${label}: keys`);
    for (const key of Object.keys(a)) nearEqual(a[key], b[key], `${label}.${key}`, epsilon);
  } else assert.deepEqual(a, b, label);
}
// Keep dynamic renderer counters, elapsed time, and selected model out of the
// comparison. Raw info is also saved in full so the projection is reviewable.
function configuration(info) {
  const result = {};
  for (const key of ['camera', 'settings', 'graphics', 'quality', 'qualityLocked', 'qualityScale', 'devicePixelRatio', 'pixelRatio', 'ratio', 'scale', 'buffer', 'canvas', 'viewport', 'shadowMapSize', 'shadowSize', 'shadows', 'postprocessing', 'post', 'exposure', 'toneMapping', 'sun', 'lighting']) {
    if (info[key] !== undefined) result[key] = info[key];
  }
  assert.ok(result.camera, 'info() must expose camera state for verifiable A/B equality.');
  assert.ok(Object.keys(result).length > 1, 'info() must expose rendering settings or buffer dimensions.');
  return result;
}
function equalConfiguration(a, b, label) {
  nearEqual(configuration(a), configuration(b), label);
  report.comparisons.push({ label, status: 'passed', checked: Object.keys(configuration(a)) });
}
async function api(page, method, value) {
  return page.evaluate(async ({ method, value }) => {
    const test = window.vehicleTest;
    if (!test || typeof test[method] !== 'function') throw new Error(`vehicleTest.${method} is unavailable`);
    return await test[method](value);
  }, { method, value });
}
async function settle(page, duration = 1000) {
  await page.waitForTimeout(duration);
  await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
}
async function layout(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas'), rect = canvas?.getBoundingClientRect();
    return {
      viewport: [innerWidth, innerHeight], dpr: devicePixelRatio,
      scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
      canvas: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bufferWidth: canvas.width, bufferHeight: canvas.height } : null,
      title: document.title, meaningfulText: document.body.innerText.slice(0, 2400),
      touch: { coarsePointer: matchMedia('(pointer: coarse)').matches, maxTouchPoints: navigator.maxTouchPoints },
      controls: [...document.querySelectorAll('button, select, input, a')].map(el => {
        const r = el.getBoundingClientRect(), style = getComputedStyle(el);
        return { label: el.getAttribute('aria-label') || el.innerText || el.getAttribute('name') || el.tagName, hidden: style.visibility === 'hidden' || style.display === 'none' || r.width === 0 || r.height === 0,
          x: r.x, y: r.y, width: r.width, height: r.height, disabled: Boolean(el.disabled) };
      }).filter(el => !el.hidden),
      frameworkOverlay: !!document.querySelector('vite-error-overlay, nextjs-portal, webpack-dev-server-client-overlay'),
    };
  });
}
function assertLayout(value, label) {
  assert.match(value.title, /kannon|vehicle/i, `${label}: page identity`);
  assert.match(value.meaningfulText, /vehicle|school bus|kannon|Before[\s\S]*After/i, `${label}: meaningful content`);
  assert.equal(value.frameworkOverlay, false, `${label}: framework error overlay`);
  assert.ok(value.canvas?.width >= 100 && value.canvas?.height >= 100, `${label}: visible sized canvas`);
  assert.ok(value.scroll[0] <= value.viewport[0] + 1, `${label}: horizontal overflow`);
  assert.ok(!/graphics unavailable|could not load|something went wrong/i.test(value.meaningfulText), `${label}: error message`);
}
async function renderer(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas'), gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return { vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
      version: gl?.getParameter(gl.VERSION), shadingLanguage: gl?.getParameter(gl.SHADING_LANGUAGE_VERSION),
      timerQuery: Boolean(gl?.getExtension('EXT_disjoint_timer_query_webgl2')), contextLost: gl?.isContextLost() };
  });
}
async function createPage(label, options, query = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, ...options });
  const page = await context.newPage();
  const servedModels = [], modelBodyJobs = [];
  page.setDefaultTimeout(60000);
  page.on('pageerror', error => report.errors.push({ page: label, kind: 'pageerror', message: error.message }));
  page.on('console', message => {
    if (message.type() === 'error') report.errors.push({ page: label, kind: 'console', message: message.text() });
    if (message.type() === 'warning') report.warnings.push({ page: label, kind: 'console', message: message.text() });
  });
  page.on('requestfailed', request => report.errors.push({ page: label, kind: 'requestfailed', url: request.url(), message: request.failure()?.errorText }));
  page.on('response', response => {
    if (response.status() >= 400) {
      const target = response.url().endsWith('/favicon.ico') ? report.warnings : report.errors;
      target.push({ page: label, kind: 'http', status: response.status(), url: response.url() });
    }
    if (response.ok() && /\/models\/.*\.glb(?:[?#]|$)/i.test(response.url())) {
      modelBodyJobs.push(response.body().then(bytes => {
        servedModels.push({ path: new URL(response.url()).pathname, decodedBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      }).catch(error => report.errors.push({ page: label, kind: 'model-body', url: response.url(), message: error.message })));
    }
  });
  const session = await context.newCDPSession(page);
  await session.send('Network.enable'); await session.send('Network.setCacheDisabled', { cacheDisabled: true });
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  log(`Open ${label}: ${url.href}`);
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.vehicleTest?.ready === true, null, { timeout: 90000 });
  await settle(page);
  await Promise.all(modelBodyJobs);
  const gpu = await renderer(page), initialLayout = await layout(page);
  assertLayout(initialLayout, label);
  const software = /swiftshader|basic render|llvmpipe|software|warp/i.test(gpu.renderer || '');
  const identifiedHardware = /AMD|Radeon|NVIDIA|Intel|Apple|Adreno|Mali|PowerVR/i.test(gpu.renderer || '') && !software;
  const record = { label, url: page.url(), gpu, hardwareVerified: identifiedHardware, initialLayout, servedModels, resources: [] };
  for (const model of servedModels) {
    const earlier = report.pages.flatMap(previous => previous.servedModels).find(previous => previous.path === model.path);
    if (earlier) assert.equal(model.sha256, earlier.sha256, `${label}: served asset remains byte-identical through all comparison pages`);
  }
  report.pages.push(record);
  assert.equal(gpu.contextLost, false, `${label}: WebGL context lost`);
  if (!flags['allow-software']) assert.ok(identifiedHardware, `${label}: hardware renderer required, got ${gpu.renderer}. Use --allow-software only for an explicitly labeled software-only run.`);
  const close = async () => {
    record.finalLayout = await layout(page);
    record.resources = await page.evaluate(() => performance.getEntriesByType('resource').map(resource => ({ name: resource.name, initiatorType: resource.initiatorType,
      transferSize: resource.transferSize, encodedBodySize: resource.encodedBodySize, decodedBodySize: resource.decodedBodySize, duration: resource.duration, responseStatus: resource.responseStatus, deliveryType: resource.deliveryType })));
    record.modelTransferBytes = record.resources.filter(resource => /\.glb(?:[?#]|$)/i.test(resource.name)).reduce((sum, resource) => sum + resource.transferSize, 0);
    await save(); await context.close();
  };
  return { page, close, record };
}
async function capture(page, label, view, variant) {
  await api(page, 'selectView', view);
  await api(page, 'setVariant', variant);
  await settle(page);
  const info = await api(page, 'info'), dimensions = await layout(page);
  assertLayout(dimensions, label);
  const filename = `${label}-${view}-${variant}.png`;
  await page.screenshot({ path: join(output, filename), animations: 'disabled' });
  report.captures.push({ label, view, variant, path: filename, kind: 'Actual Three.js GameView browser capture; not a Blender render', info, layout: dimensions });
  log(`Capture ${filename}`); await save(); return info;
}
async function uiSmoke(page) {
  await page.getByLabel(/^View/).selectOption('south-gameplay');
  assert.equal((await api(page, 'info')).view, 'south-gameplay', 'Visible View control changes the renderer preset.');
  await page.getByRole('button', { name: 'Before', exact: true }).click();
  assert.equal((await api(page, 'info')).variant, 'current');
  assert.equal(await page.getByRole('button', { name: 'Before', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'After', exact: true }).click();
  assert.equal((await api(page, 'info')).variant, 'improved');
  await page.getByLabel(/^Graphics/).selectOption('low');
  assert.equal((await api(page, 'info')).quality, 'low');
  await page.getByLabel(/^Graphics/).selectOption('high');
  assert.equal((await api(page, 'info')).quality, 'high');
  report.interactions.push({ label: 'Desktop visible review controls', status: 'passed', checks: ['View selector changes actual camera preset', 'Before and After buttons select actual vehicle variant and pressed state', 'Graphics selector changes actual renderer quality'] });
}
async function sample(page, label, variant, quality, view = 'bus-gameplay', original = false) {
  await api(page, 'selectView', view);
  await api(page, 'setQuality', quality);
  if (!original) await api(page, 'setVariant', variant);
  log(`Warm ${label} for ${warmupMs} ms`); await settle(page, warmupMs);
  const before = await api(page, 'info');
  log(`Measure ${label} for ${sampleMs} ms; no screenshot during sample`);
  const measured = await api(page, 'sample', sampleMs);
  const after = await api(page, 'info');
  assert.ok(measured.elapsedMs >= sampleMs - 1, `${label}: completed requested measurement duration`);
  assert.ok(measured.sampleFrames > 0 && Number.isFinite(measured.fps) && measured.fps > 0, `${label}: finite frame sample`);
  assert.ok(Number.isFinite(measured.frameMs?.p95) && measured.frameMs.p95 > 0, `${label}: frame-time samples`);
  assert.ok(after.drawCalls > 0 && after.triangles > 0, `${label}: actual geometry rendered`);
  equalConfiguration(before, after, `${label}: unchanged camera/settings through measurement`);
  const record = { label, variant, quality, view, originalUnsplit: original, before, measured, after };
  report.performance.push(record); await save(); log(`Finished ${label}`); return record;
}

try {
  browser = await chromium.launch({ ...(flags['executable-path'] ? { executablePath: flags['executable-path'] } : { channel: flags.channel }), headless: !flags.headed, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
  report.browserPath.version = browser.version();
  if (!flags['resume-report']) {
  const desktop = await createPage('desktop-high', {}, { quality: 'high' });
  try {
    await uiSmoke(desktop.page);
    for (const view of views) {
      const current = await capture(desktop.page, 'desktop-high', view, 'current');
      const improved = await capture(desktop.page, 'desktop-high', view, 'improved');
      equalConfiguration(current, improved, `${view}: current/improved same camera and graphics`);
    }
    const a1 = await sample(desktop.page, 'desktop-high-current-A1', 'current', 'high');
    const b = await sample(desktop.page, 'desktop-high-improved-B', 'improved', 'high');
    const a2 = await sample(desktop.page, 'desktop-high-current-A2', 'current', 'high');
    equalConfiguration(a1.before, b.before, 'Desktop High A1/B fixed budget');
    equalConfiguration(a1.before, a2.before, 'Desktop High A1/A2 fixed budget');
  } finally { await desktop.close(); }
  }

  const mobile = await createPage('mobile-emulated-auto-landscape', { viewport: { width: 852, height: 393 }, isMobile: true, hasTouch: true }, { quality: 'auto' });
  try {
    assert.equal(mobile.record.initialLayout.touch.coarsePointer, true, 'Mobile context must select coarse pointer graphics behavior.');
    const current = await capture(mobile.page, 'mobile-emulated-auto', 'bus-gameplay', 'current');
    const improved = await capture(mobile.page, 'mobile-emulated-auto', 'bus-gameplay', 'improved');
    equalConfiguration(current, improved, 'Emulated mobile Auto pair fixed camera/settings');
    const a = await sample(mobile.page, 'mobile-emulated-auto-current', 'current', 'auto');
    const b = await sample(mobile.page, 'mobile-emulated-auto-improved', 'improved', 'auto');
    equalConfiguration(a.before, b.before, 'Emulated mobile Auto fixed budget');
    await mobile.page.setViewportSize({ width: 390, height: 844 });
    await capture(mobile.page, 'mobile-emulated-auto-portrait', 'south-gameplay', 'improved');
    await mobile.page.setViewportSize({ width: 852, height: 393 });
    await capture(mobile.page, 'mobile-emulated-auto-rotation', 'north-gameplay', 'improved');
  } finally { await mobile.close(); }

  const original = await createPage('original-unsplit-desktop-high', {}, { quality: 'high', original: '1' });
  try {
    const result = await sample(original.page, 'original-unsplit-desktop-high', 'original-unsplit', 'high', 'bus-gameplay', true);
    const split = report.performance.find(run => run.label === 'desktop-high-current-A1');
    equalConfiguration(split.before, result.before, 'Original unsplit versus split-current rendering budget');
    await original.page.screenshot({ path: join(output, 'desktop-high-bus-gameplay-original-unsplit.png'), animations: 'disabled' });
    report.captures.push({ label: 'original-unsplit-desktop-high', view: 'bus-gameplay', variant: 'original-unsplit', path: 'desktop-high-bus-gameplay-original-unsplit.png', kind: 'Actual Three.js GameView browser capture; not a Blender render', info: result.after });
  } finally { await original.close(); }
  assert.equal(report.errors.length, 0, `Application/browser errors occurred: ${JSON.stringify(report.errors)}`);
  report.status = 'passed'; log('PASS: captures, settings equality, desktop/mobile bounded samples, and original-scene overhead baseline');
} catch (error) {
  report.status = 'failed'; report.errors.push({ kind: 'verification', message: error.message, stack: error.stack });
  process.exitCode = 1; log(`FAIL: ${error.message}`);
} finally {
  report.finishedAt = new Date().toISOString(); await browser?.close(); await save();
  log(`Report: ${join(output, 'browser-report.json')}`);
}
