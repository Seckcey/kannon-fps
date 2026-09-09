import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const town = process.argv.includes('--town');
const children = [];
let closing = false;
function close(code = 0) {
  if (closing) return; closing = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
function start(args, env = {}) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, ...env } });
  children.push(child);
  child.on('error', error => { console.error(error.message); close(1); });
  child.on('exit', code => { if (!closing) close(code ?? 1); });
}
start(['--import', 'tsx', 'server/index.ts'], { HOST: '127.0.0.1', PORT: town ? '3014' : '3013', DB_PATH: resolve(root, town ? 'data/graphics-review.sqlite' : 'data/vehicle-review.sqlite') });
start(['node_modules/vite/bin/vite.js', '--config', town ? 'vite.graphics.config.ts' : 'vite.vehicle-test.config.ts']);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => close());
console.log(town ? 'Local town review: http://127.0.0.1:5184/graphics-test.html' : 'Local vehicle review: http://127.0.0.1:5183/vehicle-test.html');
console.log('Separate test database; no deployment. Press Ctrl+C to stop.');
