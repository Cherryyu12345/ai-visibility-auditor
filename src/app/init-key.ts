/** `npm run key:init` — create the master key file, or say it already exists. */

import { KEY_FILE, loadMasterKey } from './keyfile.js';

const source = await loadMasterKey(true);

if (source === 'created') {
  process.stdout.write(`Created a master key at ${KEY_FILE}\n\nBack it up. Without it, every stored credential has to be entered again.\n`);
} else if (source === 'file') {
  process.stdout.write(`A master key already exists at ${KEY_FILE}. Leaving it alone.\n`);
} else {
  process.stdout.write('AIVA_MASTER_KEY is set in the environment, so no file is needed.\n');
}
