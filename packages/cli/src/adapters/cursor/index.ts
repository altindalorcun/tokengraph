import { stat } from 'node:fs/promises';
import { CURSOR_SOURCE, type Adapter, type CollectResult } from '@tokengraph/core';
import { readLines } from '../jsonl-files.js';
import { CursorUsageAggregator, type CursorAggregatorOptions, type CursorDiagnostics } from './aggregator.js';
import { cursorEventsPath, parseCursorEvent } from './events.js';
import { cursorImportPath, readImportedRows } from './imports.js';

export { cursorEventsPath, cursorImportPath };

function describeDiagnostics({ missingCounts, clampedEvents }: CursorDiagnostics): string[] {
  const notes: string[] = [];
  if (missingCounts > 0) {
    notes.push(`${missingCounts} Cursor turn(s) reported no token counts and were skipped`);
  }
  if (clampedEvents > 0) notes.push(`${clampedEvents} turn(s) reported more cached than total input; counted as 0 fresh input`);
  return notes;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Reads the events the `cursor-hook` command recorded, plus the rows `tokengraph import cursor` stored
 * from a dashboard CSV (they count only before the hook's first turn). Cursor itself keeps no usable
 * token counters on disk, so nothing under Cursor's own directories is read.
 */
export function createCursorAdapter(options: Pick<CursorAggregatorOptions, 'timeZone'> = {}): Adapter {
  return {
    name: CURSOR_SOURCE,

    async detect(): Promise<boolean> {
      return (await isFile(cursorEventsPath())) || (await isFile(cursorImportPath()));
    },

    async collect(since: Date): Promise<CollectResult> {
      const aggregator = new CursorUsageAggregator({ ...options, since });
      let readError: unknown;
      try {
        await readLines(cursorEventsPath(), (line) => {
          const event = parseCursorEvent(line);
          if (event) aggregator.add(event);
        });
      } catch (error) {
        // No hook has run yet: nothing to report. Anything else (EACCES, EISDIR, a stream
        // error, a RangeError from an invalid --timezone) must surface instead of silently
        // dropping whatever usage was already read.
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') readError = error;
      }
      try {
        for (const row of await readImportedRows()) aggregator.addImported(row);
      } catch (error) {
        readError ??= error;
      }
      const notes = describeDiagnostics(aggregator.diagnostics());
      if (readError) {
        notes.push(`could not read Cursor events or imports: ${readError instanceof Error ? readError.message : String(readError)}`);
      }
      return { ...aggregator.result(), ...(notes.length > 0 ? { notes } : {}) };
    },
  };
}
