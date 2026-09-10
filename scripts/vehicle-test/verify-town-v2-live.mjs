/** Public acceptance of the deployed Kannon Town v2: open the live site on the installed Edge
 *  (hardware GPU), create a bot match, enter the arena, confirm the v2 models are the ones
 *  downloaded, capture the prepared world, and record console errors.
 *
 *  node scripts/vehicle-test/verify-town-v2-live.mjs [--url https://kpop.8westventures.com] [--out docs/verification/town-v2-live.json] */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';

const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'https://kpop.8westventures.com' },
  out: { type: 'string', default: 'docs/verification/town-v2-live.json' },
  capture: { type: 'string', default: 'docs/art/town-v2-public-ready.jpg' },
  'executable-path': { type: 'string', default: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' },
} });
const output = resolve(values.out);
await mkdir(dirname(output), { recursive: true });
const report = { startedAt: new Date().toISOString(), url: values.url, status: 'running', errors: [], warnings: [], models: [], health: null };
const browser = await chromium.launch({ executablePath: values['executable-path'], headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  page.on('pageerror', error => report.errors.push({ message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.errors.push({ message: message.text().slice(0, 500) }); if (message.type() === 'warning' && !/X4122/.test(message.text())) report.warnings.push({ message: message.text().slice(0, 300) }); });
  page.on('response', response => { if (response.status() >= 400) report.errors.push({ url: response.url(), status: response.status() }); });
  report.health = await (await page.request.get(`${values.url}/health`)).json();
  await page.goto(values.url);
  await page.getByRole('button', { name: 'Play against bots' }).click();
  await page.getByRole('button', { name: 'Create bot match' }).click();
  await page.getByRole('button', { name: 'Enter bot match' }).click();
  await page.getByText('Ready to play').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(4000);
  report.models = await page.evaluate(() => performance.getEntriesByType('resource').filter(e => e.name.includes('/models/')).map(e => ({ name: new URL(e.name).pathname + new URL(e.name).search, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize, durationMs: Math.round(e.duration) })));
  await page.screenshot({ path: resolve(values.capture), type: 'jpeg', quality: 86 });
  report.readiness = await page.evaluate(() => Array.from(document.querySelectorAll('[role=region] li')).map(item => item.textContent?.trim()).filter(Boolean));
  assert.ok(report.models.some(m => m.name.startsWith('/models/environment-v2')), 'v2 environment downloaded');
  assert.ok(report.models.some(m => m.name.startsWith('/models/scout-v2')), 'v2 scout downloaded');
  await page.getByRole('button', { name: 'Pause menu' }).click().catch(() => {});
  const leave = page.getByRole('button', { name: /Leave match/ });
  if (await leave.count()) await leave.first().click();
  await context.close();
  report.status = report.errors.length ? 'errors' : 'passed';
} catch (error) {
  report.status = 'failed'; report.errors.push({ message: error.message });
} finally {
  report.finishedAt = new Date().toISOString(); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); await browser.close();
  console.log(`${report.status}: ${output}`);
  if (report.status !== 'passed') { console.log(JSON.stringify(report.errors.slice(0, 5), null, 2)); process.exitCode = 1; }
}
