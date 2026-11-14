/**
 * Boots a real WordPress for the integration suite using WordPress Playground.
 *
 * Docker is the usual way to do this and is what the brief asked for, but this
 * machine has no container runtime and installing one needs admin rights. The
 * Playground CLI runs genuine WordPress and genuine PHP (compiled to WASM)
 * under Node with nothing to install, so the connector is still exercised
 * against a real REST API rather than a mock.
 */

import { spawn } from 'node:child_process';
import { readFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

export const HARNESS_PORT = Number(process.env.AIVA_TEST_WP_PORT ?? 9400);
const OUT_DIR = resolve(projectRoot, '.playground/out');
const HARNESS_FILE = resolve(OUT_DIR, 'harness.json');
const PLUGIN_DIR = resolve(projectRoot, 'src/plugin/ai-visibility-bridge');
const MU_DIR = resolve(projectRoot, 'tools/wp-harness/mu-plugins');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startWordPress({ quiet = true, port = HARNESS_PORT } = {}) {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const args = [
    '--yes', '@wp-playground/cli@3.1.64', 'server',
    '--port', String(port),
    '--php', '8.3',
    '--wp', 'latest',
    // Application Passwords require TLS unless WordPress considers the site local.
    '--define', 'WP_ENVIRONMENT_TYPE', 'local',
    '--mount', `${PLUGIN_DIR}:/wordpress/wp-content/plugins/ai-visibility-bridge`,
    '--mount', `${MU_DIR}:/wordpress/wp-content/mu-plugins`,
    '--mount', `${OUT_DIR}:/aiva-out`,
    '--verbosity', quiet ? 'quiet' : 'normal',
  ];

  const child = spawn('npx', args, {
    cwd: projectRoot,
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env },
  });

  let stderr = '';
  child.stderr?.on('data', (d) => { stderr += String(d); });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 240_000;

  // The site must answer AND the bootstrap mu-plugin must have run; the harness
  // file appearing is the signal that WordPress finished installing.
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Playground exited early (code ${child.exitCode}).\n${stderr.slice(-2000)}`);
    }
    try {
      const res = await fetch(`${baseUrl}/wp-json/`, { signal: AbortSignal.timeout(4000) });
      if (res.ok && existsSync(HARNESS_FILE)) {
        const harness = JSON.parse(await readFile(HARNESS_FILE, 'utf8'));
        return { baseUrl, harness, stop: () => stopChild(child) };
      }
    } catch {
      // not up yet
    }
    await sleep(2000);
  }

  stopChild(child);
  throw new Error(`WordPress did not become ready within the timeout.\n${stderr.slice(-2000)}`);
}

function stopChild(child) {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5000).unref?.();
  }
}

// CLI usage: node tools/playground.mjs start
if (process.argv[2] === 'start') {
  const { baseUrl, harness } = await startWordPress({ quiet: false });
  console.log(`\nWordPress ready at ${baseUrl}`);
  console.log(`Admin user: ${harness.username}`);
  console.log(`Harness config: ${HARNESS_FILE}`);
  console.log('Press Ctrl+C to stop.\n');
}
