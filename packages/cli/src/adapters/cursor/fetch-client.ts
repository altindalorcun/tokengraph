import { parseCursorCsv, type CursorCsvParse } from './csv.js';

/**
 * The HTTP half of the Cursor usage fetch: one GET of the dashboard's own CSV export
 * (docs/agents/cursor-usage.md, "Automatic history"). Nothing here touches the disk.
 *
 * The cookie is built from the user's sign-in and sent only to cursor.com. Redirects are handled by hand
 * and followed only to https://cursor.com or https://www.cursor.com, so the cookie can never leave that
 * origin. Neither the cookie, the token, the user id, the request URL nor any part of a response body ever
 * appears in a result or an error; failures are one of a few fixed texts.
 */

export const CURSOR_ORIGIN = 'https://cursor.com';
export const EXPORT_PATH = '/api/dashboard/export-usage-events-csv';
export const REQUEST_TIMEOUT_MS = 30_000;
/** A year of heavy use is a few MiB; a response beyond this is not an export. */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
export const MAX_REDIRECTS = 3;

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** True for the only places the cookie may go. */
export function isCursorUrl(url: URL): boolean {
  return url.protocol === 'https:' && (url.hostname === 'cursor.com' || url.hostname === 'www.cursor.com') && url.port === '';
}

export type FetchOutcome =
  | { kind: 'ok'; parsed: CursorCsvParse }
  /** 401 or 403: the sign-in has expired. */
  | { kind: 'expired' }
  /** 429, with the wait the server asked for when it said (seconds). */
  | { kind: 'rate-limited'; retryAfterSeconds: number | null }
  /** Anything else. `reason` is one of a few fixed texts; the stored data is untouched. */
  | { kind: 'failed'; reason: string };

export interface FetchRequest {
  token: string;
  userId: string;
  /** Epoch ms, inclusive start and end of the window. */
  startMs: number;
  endMs: number;
}

export interface FetchClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  /** Which URLs may be requested and followed to. Tests allow their local server; the default is {@link isCursorUrl}. */
  allowUrl?: (url: URL) => boolean;
  /** The export's URL without its query. */
  endpoint?: string;
}

function retryAfter(header: string | null, now = Date.now()): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

class TooLarge extends Error {}

/** Reads the body up to `maxBytes`, then stops: a larger response is cancelled, not buffered. */
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new TooLarge();
  }
  if (!response.body) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new TooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchCursorUsageCsv(request: FetchRequest, options: FetchClientOptions = {}): Promise<FetchOutcome> {
  const doFetch = options.fetch ?? fetch;
  const allow = options.allowUrl ?? isCursorUrl;
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const signal = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const first = new URL(options.endpoint ?? `${CURSOR_ORIGIN}${EXPORT_PATH}`);
  first.searchParams.set('strategy', 'tokens');
  first.searchParams.set('startDate', String(request.startMs));
  first.searchParams.set('endDate', String(request.endMs));
  if (!allow(first)) return { kind: 'failed', reason: 'the export address is not a Cursor address' };

  const headers = {
    Cookie: `WorkosCursorSessionToken=${request.userId}%3A%3A${request.token}`,
    Accept: 'text/csv',
    Referer: 'https://www.cursor.com/settings',
    Origin: CURSOR_ORIGIN,
    'User-Agent': BROWSER_USER_AGENT,
  };

  try {
    let url = first;
    for (let hop = 0; ; hop += 1) {
      const response = await doFetch(url, { method: 'GET', headers, redirect: 'manual', signal });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get('location');
        if (!location || hop >= MAX_REDIRECTS) return { kind: 'failed', reason: 'too many redirects' };
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          return { kind: 'failed', reason: 'redirected to an unreadable address' };
        }
        // Never forward the cookie anywhere but Cursor.
        if (!allow(next)) return { kind: 'failed', reason: 'redirected away from cursor.com; nothing was sent there' };
        url = next;
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: 'expired' };
      }
      if (response.status === 429) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: 'rate-limited', retryAfterSeconds: retryAfter(response.headers.get('retry-after')) };
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: 'failed', reason: `cursor.com answered with status ${response.status}` };
      }
      const text = await readBounded(response, maxBytes);
      // A window with no usage may come back empty. An HTML page (a bot challenge) never counts as one.
      if (text.trim() === '' && /csv/i.test(response.headers.get('content-type') ?? '')) {
        return { kind: 'ok', parsed: { ok: true, rows: [], rowsRead: 0, malformed: 0, zero: 0 } };
      }
      const parsed = parseCursorCsv(text);
      if (!parsed.ok) return { kind: 'failed', reason: 'cursor.com did not answer with a usage export (a sign-in check or an unknown layout)' };
      return { kind: 'ok', parsed };
    }
  } catch (error) {
    if (error instanceof TooLarge) return { kind: 'failed', reason: 'the response was larger than the limit and was dropped' };
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') return { kind: 'failed', reason: 'cursor.com did not answer in time' };
    return { kind: 'failed', reason: 'could not reach cursor.com' };
  }
}
