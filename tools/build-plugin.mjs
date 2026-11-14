/**
 * Packages the companion plugin as an installable zip.
 *
 * The consultant uploads this under Plugins → Add New → Upload Plugin. It is
 * deliberately a single file with no build step, so anyone can read exactly
 * what they are installing on their client's site before they install it.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const srcDir = resolve(root, 'src/plugin');
const outDir = resolve(root, 'dist/plugin');
const outFile = resolve(outDir, 'ai-visibility-bridge.zip');

await mkdir(outDir, { recursive: true });
await rm(outFile, { force: true });

// -x excludes macOS resource forks, which otherwise confuse WordPress's installer.
await run('zip', ['-r', '-q', outFile, 'ai-visibility-bridge', '-x', '*.DS_Store', '__MACOSX/*'], { cwd: srcDir });

const { stdout } = await run('unzip', ['-l', outFile]);
console.log(stdout);
console.log(`Plugin zip: ${outFile}`);
