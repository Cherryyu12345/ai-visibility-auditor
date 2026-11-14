/**
 * Copy the UI into dist.
 *
 * tsc only emits TypeScript, and the server resolves its static directory
 * relative to its own compiled location, so the HTML/CSS/JS has to land beside
 * it. Doing it here keeps `npm run build` the one command that produces a
 * runnable tree.
 */

import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = resolve(root, 'src/ui');
const to = resolve(root, 'dist/src/ui');

await mkdir(dirname(to), { recursive: true });
await cp(from, to, { recursive: true });
process.stdout.write(`copied ${from} -> ${to}\n`);
