import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { phonePage, type PageCard } from './page.js';

export interface ShareCard extends PageCard {
  png: Uint8Array;
}
export type ShareEvent =
  | { kind: 'page'; userAgent: string }
  | { kind: 'viewed'; id: string }
  | { kind: 'saved'; id: string };
export type StopReason = 'all-saved' | 'idle' | 'stopped';
export interface ShareServer {
  url: string;
  done: Promise<StopReason>;
  stop(): void;
}

const IDLE_MS = 10 * 60_000;
const AFTER_ALL_SAVED_MS = 30_000;

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/** A plain ASCII name plus the exact one in RFC 5987 form, so a quote or newline can never break the header. */
function contentDisposition(fileName: string): string {
  const plain = fileName.replace(/[^A-Za-z0-9._-]/g, '-');
  const exact = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${plain}"; filename*=UTF-8''${exact}`;
}

/**
 * A one-off web server for the phone on the same network: one random path token, the cards from
 * memory, nothing from disk, and it always ends.
 */
export async function startShareServer(options: {
  address: string;
  cards: readonly ShareCard[];
  handle: string;
  onEvent?: (event: ShareEvent) => void;
  idleMs?: number;
  afterAllSavedMs?: number;
  token?: string;
}): Promise<ShareServer> {
  const token = options.token ?? randomBytes(16).toString('base64url');
  const prefix = `/${token}/`;
  const page = phonePage(options.cards, { handle: options.handle });
  const saved = new Set<string>();
  const viewed = new Set<string>();
  let finish: (reason: StopReason) => void = () => undefined;
  const done = new Promise<StopReason>((resolve) => {
    finish = resolve;
  });
  let idleTimer: NodeJS.Timeout | undefined;
  let endTimer: NodeJS.Timeout | undefined;
  let stopped = false;

  const server = createServer((req, res) => {
    // Route on the raw target: URL parsing can throw on targets Node's parser accepts, and nothing
    // before the token check may be able to take the process down.
    const target = req.url ?? '';
    const queryAt = target.indexOf('?');
    const path = queryAt === -1 ? target : target.slice(0, queryAt);
    if (!path.startsWith(prefix)) {
      res.writeHead(404, SECURITY_HEADERS).end();
      return;
    }
    // Only a request under the token counts as activity: a scanner hitting other paths must not keep the server alive.
    armIdle();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, HEAD' }).end();
      return;
    }
    const rest = path.slice(prefix.length);
    if (rest === '') {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy':
          "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      res.end(req.method === 'HEAD' ? undefined : page);
      if (req.method === 'GET') emit({ kind: 'page', userAgent: String(req.headers['user-agent'] ?? '') });
      return;
    }
    const match = /^card\/([a-z]+)\.png$/.exec(rest);
    const card = match ? options.cards.find((c) => c.id === match[1]) : undefined;
    if (!card) {
      res.writeHead(404, SECURITY_HEADERS).end();
      return;
    }
    let download = false;
    try {
      download = queryAt !== -1 && new URLSearchParams(target.slice(queryAt + 1)).get('download') === '1';
    } catch {
      res.writeHead(404, SECURITY_HEADERS).end();
      return;
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'image/png',
      'Content-Length': String(card.png.length),
      ...(download ? { 'Content-Disposition': contentDisposition(card.fileName) } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : card.png);
    if (!download && req.method === 'GET' && !viewed.has(card.id)) {
      // iPhone's touch-and-hold fetches the plain image, so this is the only sign that the card reached the phone.
      viewed.add(card.id);
      emit({ kind: 'viewed', id: card.id });
    }
    if (download && req.method === 'GET') {
      saved.add(card.id);
      emit({ kind: 'saved', id: card.id });
      if (saved.size === options.cards.length) {
        clearTimeout(endTimer);
        endTimer = setTimeout(() => stop('all-saved'), options.afterAllSavedMs ?? AFTER_ALL_SAVED_MS);
      }
    }
  });

  // A throwing listener must not take a request handler (and with it the process) down.
  function emit(event: ShareEvent) {
    try {
      options.onEvent?.(event);
    } catch {
      /* ignore */
    }
  }

  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop('idle'), options.idleMs ?? IDLE_MS);
  }

  function stop(reason: StopReason) {
    if (stopped) return;
    stopped = true;
    clearTimeout(idleTimer);
    clearTimeout(endTimer);
    server.close();
    server.closeAllConnections();
    finish(reason);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, options.address, () => resolve());
  });
  armIdle();
  const { port } = server.address() as AddressInfo;
  return { url: `http://${options.address}:${port}${prefix}`, done, stop: () => stop('stopped') };
}
