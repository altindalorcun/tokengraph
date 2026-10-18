import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLEARED_ENV } from './isolated-env.js';

// A test that forgets to point TOKENGRAPH_HOME somewhere would read and write the developer's real ledger,
// config and Cursor event file, and anything that resolves os.homedir() or an agent's config folder would reach
// ~/.claude, ~/.codex, crontab and friends. Redirect all of it into one throwaway folder for every test file;
// tests that set their own values do so after this runs and still win, and restoring "the previous value"
// restores these.
const home = mkdtempSync(join(tmpdir(), 'tokengraph-test-home-'));

process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
for (const name of CLEARED_ENV) {
  delete process.env[name];
}
// Unconditional: an inherited (real) TOKENGRAPH_HOME must never reach a test.
process.env['TOKENGRAPH_HOME'] = join(home, '.tokengraph');
