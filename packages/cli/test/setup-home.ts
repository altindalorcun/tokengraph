import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A test that forgets to point TOKENGRAPH_HOME somewhere would read and write the developer's real ledger,
// config and Cursor event file. Default it to a throwaway folder for every test file; tests that set their own
// still win, and restoring "the previous value" restores this one.
process.env['TOKENGRAPH_HOME'] ??= mkdtempSync(join(tmpdir(), 'tokengraph-test-home-'));
