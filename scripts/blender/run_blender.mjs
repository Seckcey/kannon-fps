/** Launch Blender headless with the given arguments.
 *  node scripts/blender/run_blender.mjs [blend file] --python <script> -- <script args>
 *  Set BLENDER to override the executable; the default is the Blender 5.2 install path. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const candidates = [process.env.BLENDER, 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe', '/Applications/Blender.app/Contents/MacOS/Blender', 'blender'].filter(Boolean);
const executable = candidates.find(path => path === 'blender' || existsSync(path));
if (!executable) { console.error('Blender not found. Set BLENDER to the executable path.'); process.exit(1); }
const result = spawnSync(executable, ['--background', ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
process.exit(result.status ?? 1);
