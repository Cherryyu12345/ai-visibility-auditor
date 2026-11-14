/**
 * Entry point.
 *
 * Refuses to start without a master key rather than falling back to storing
 * credentials in the clear — there is no safe default for that, and a tool
 * that silently chose one would be worse than one that will not start.
 */

import { resolve } from 'node:path';
import { Store } from '../store/store.js';
import { Engine } from './engine.js';
import { createAppServer } from './server.js';
import { loadMasterKey, missingKeyMessage } from './keyfile.js';
import { log } from '../core/logger.js';

async function main(): Promise<void> {
  const keySource = await loadMasterKey();
  if (keySource === 'missing') {
    process.stderr.write(missingKeyMessage());
    process.exit(1);
  }

  const dataFile = resolve(process.env.AIVA_DATA ?? '.aiva/state.json');
  const store = await Store.open(dataFile);
  const engine = new Engine(store);

  const app = createAppServer({
    store,
    engine,
    operator: process.env.AIVA_OPERATOR ?? 'operator',
    ...(process.env.AIVA_PORT ? { port: Number(process.env.AIVA_PORT) } : {}),
    ...(process.env.AIVA_HOST ? { host: process.env.AIVA_HOST } : {}),
  });

  const { host, port } = await app.listen();
  process.stdout.write(
    '\nAI Visibility Auditor — publishing stage\n' +
    `  http://${host}:${port}\n` +
    `  state:      ${dataFile}\n` +
    `  master key: ${keySource === 'env' ? 'from AIVA_MASTER_KEY' : 'from the key file'}\n` +
    `  operator:   ${process.env.AIVA_OPERATOR ?? 'operator'}\n\n`,
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void (async () => {
        await store.flush();
        await app.close();
        process.exit(0);
      })();
    });
  }
}

main().catch((err) => {
  log.error('could not start', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
