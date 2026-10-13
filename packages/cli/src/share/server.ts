import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { phonePage, type PageCard } from './page.js';

export interface ShareCard extends PageCard {
  png: Uint8Array;
}
export type ShareEvent = { kind: 'page'; userAgent: string } | { kind: 'saved'; id: string };
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
  let finish: (reason: StopReason) => void = () => undefined;
  const done = new Promise<StopReason>((resolve) => {
    finish = resolve;
  });
  let idleTimer: NodeJS.Timeout | undefined;
  let endTimer: NodeJS.Timeout | undefined;
  let stopped = false;

  const server = createServer((req, res) => {
    armIdle();
    const url = new URL(req.url ?? '/', 'http://local');
    if (!url.pathname.startsWith(prefix)) {
      res.writeHead(404, SECURITY_HEADERS).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, HEAD' }).end();
      return;
    }
    const rest = url.pathname.slice(prefix.length);
    if (rest === '') {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      });
      res.end(req.method === 'HEAD' ? undefined : page);
      if (req.method === 'GET') options.onEvent?.({ kind: 'page', userAgent: String(req.headers['user-agent'] ?? '') });
      return;
    }
    const match = /^card\/([a-z]+)\.png$/.exec(rest);
    const card = match ? options.cards.find((c) => c.id === match[1]) : undefined;
    if (!card) {
      res.writeHead(404, SECURITY_HEADERS).end();
      return;
    }
    const download = url.searchParams.get('download') === '1';
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'image/png',
      'Content-Length': String(card.png.length),
      ...(download ? { 'Content-Disposition': `attachment; filename="${card.fileName}"` } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : card.png);
    if (download && req.method === 'GET') {
      saved.add(card.id);
      options.onEvent?.({ kind: 'saved', id: card.id });
      if (saved.size === options.cards.length) {
        clearTimeout(endTimer);
        endTimer = setTimeout(() => stop('all-saved'), options.afterAllSavedMs ?? AFTER_ALL_SAVED_MS);
      }
    }
  });

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
