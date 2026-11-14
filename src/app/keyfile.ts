/**
 * Where the master key lives.
 *
 * Deliberately outside the project: the sealed credentials live in the
 * project's own `.aiva/state.json`, and a key kept next to its own ciphertext
 * is not encryption. Keeping them in different places means a copied repo, a
 * zipped backup or a synced folder carries one without the other.
 *
 * The environment always wins, so a deployment can hand the key in from a
 * secret manager and never write it to a disk at all.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { generateMasterKey } from '../core/crypto.js';

export const KEY_FILE = resolve(homedir(), '.config/ai-visibility-auditor/master.key');

export type KeySource = 'env' | 'file' | 'created' | 'missing';

/** Put the master key into the environment, creating one only if asked. */
export async function loadMasterKey(create = false): Promise<KeySource> {
  if (process.env.AIVA_MASTER_KEY) return 'env';

  try {
    const key = (await readFile(KEY_FILE, 'utf8')).trim();
    if (key) {
      process.env.AIVA_MASTER_KEY = key;
      return 'file';
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (!create) return 'missing';

  const key = generateMasterKey();
  await mkdir(dirname(KEY_FILE), { recursive: true, mode: 0o700 });
  // `wx` so a concurrent start cannot overwrite a key that already exists —
  // that would silently orphan every credential sealed with the old one.
  await writeFile(KEY_FILE, `${key}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(KEY_FILE, 0o600);
  process.env.AIVA_MASTER_KEY = key;
  return 'created';
}

export function missingKeyMessage(): string {
  return (
    'No master key, and credentials are never stored unencrypted.\n\n' +
    'Either set one in the environment:\n\n' +
    `  export AIVA_MASTER_KEY='${generateMasterKey()}'\n\n` +
    'or create one kept outside the project, so a copy of the repo does not\n' +
    'carry the key that opens it:\n\n' +
    '  npm run key:init\n\n' +
    'Either way, back it up. If it is lost, every stored credential has to be\n' +
    'entered again.\n\n'
  );
}
