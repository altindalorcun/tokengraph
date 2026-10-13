import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StoredGist { id: string; description: string; public: boolean; files: Record<string, string> }

export async function startFakeGitHub(login = 'octocat') {
  const gists = new Map<string, StoredGist>();
  let approved = false;
  let nextId = 1;
  let url = '';

  const body = async (req: IncomingMessage) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    return text;
  };
  const send = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(value));
  };
  const view = (gist: StoredGist, withContent: boolean) => ({
    id: gist.id,
    description: gist.description,
    public: gist.public,
    html_url: `https://gist.github.com/${login}/${gist.id}`,
    files: Object.fromEntries(
      Object.entries(gist.files).map(([name, content]) => [
        name,
        withContent ? { filename: name, content, truncated: false, raw_url: `${url}/raw/${gist.id}/${name}` } : { filename: name },
      ]),
    ),
  });

  const server = createServer(async (req, res) => {
    const path = req.url ?? '/';
    if (req.method === 'POST' && path === '/login/device/code') return send(res, 200, { device_code: 'dev', user_code: 'WDJB-MJHT', verification_uri: `${url}/login/device`, expires_in: 900, interval: 1 });
    if (req.method === 'POST' && path === '/login/oauth/access_token') {
      await body(req);
      return send(res, 200, approved ? { access_token: 'gho_fake', token_type: 'bearer', scope: 'gist' } : { error: 'authorization_pending' });
    }
    if (req.headers.authorization !== 'Bearer gho_fake' && !path.startsWith('/raw/')) return send(res, 401, { message: 'Bad credentials' });
    if (req.method === 'GET' && path === '/user') return send(res, 200, { login }, { 'x-oauth-scopes': 'gist' });
    if (req.method === 'GET' && path.startsWith('/gists?')) {
      const page = Number(new URL(path, url).searchParams.get('page') ?? '1');
      return send(res, 200, page === 1 ? [...gists.values()].map((gist) => view(gist, false)) : []);
    }
    const match = /^\/gists\/([^/?]+)$/.exec(path);
    if (req.method === 'POST' && path === '/gists') {
      const input = JSON.parse(await body(req)) as { description: string; public: boolean; files: Record<string, { content: string }> };
      const gist: StoredGist = { id: (nextId++).toString(16).padStart(32, '0'), description: input.description, public: input.public, files: Object.fromEntries(Object.entries(input.files).map(([n, f]) => [n, f.content])) };
      gists.set(gist.id, gist);
      return send(res, 201, view(gist, true));
    }
    if (match) {
      const gist = gists.get(match[1]!);
      if (!gist) return send(res, 404, { message: 'Not Found' });
      if (req.method === 'GET') return send(res, 200, view(gist, true));
      if (req.method === 'PATCH') {
        const input = JSON.parse(await body(req)) as { files: Record<string, { content: string } | null> };
        for (const [name, file] of Object.entries(input.files)) {
          if (file === null) delete gist.files[name];
          else gist.files[name] = file.content;
        }
        return send(res, 200, view(gist, true));
      }
    }
    const raw = /^\/raw\/([^/]+)\/(.+)$/.exec(path);
    if (raw) {
      const content = gists.get(raw[1]!)?.files[decodeURIComponent(raw[2]!)];
      if (content === undefined) return send(res, 404, { message: 'Not Found' });
      res.writeHead(200, { 'content-type': raw[2]!.endsWith('.svg') ? 'image/svg+xml' : 'text/plain' });
      return res.end(content);
    }
    send(res, 404, { message: 'Not Found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    gists,
    approve: () => {
      approved = true;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
