/**
 * Serves the built page over `http://localhost:<port>/` and proxies `POST /agui` to the
 * harness server.
 *
 * The proxy is not convenience. `AGUIMock` sends no `Access-Control-Allow-*` headers and
 * 404s the `OPTIONS` preflight (measured), so a cross-origin POST carrying
 * `Content-Type: application/json` never leaves the browser. Same-origin is also what a real
 * app does — agent endpoints are normally proxied through the app's own origin.
 *
 * `localhost` rather than `127.0.0.1` because the manifest's static content scripts match
 * `http://localhost/*` and D3 auto-enables the localhost family.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PageServer {
  readonly url: string;
  stop(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const pageRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const distRoot = join(pageRoot, 'dist');

function proxy(req: IncomingMessage, res: ServerResponse, agentUrl: string): void {
  const target = new URL(agentUrl);
  const headers = { ...req.headers };
  delete headers.host;
  const upstream = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: req.method ?? 'POST',
      headers,
    },
    (upstreamRes) => {
      // Headers first, then a raw pipe: the SSE frames must reach the browser with the same
      // chunk boundaries the server wrote, because chunk cadence is one of the things the
      // capture layer is being tested on.
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
}

export function startPageServer(opts: { agentUrl: string; port?: number }): Promise<PageServer> {
  if (!existsSync(join(distRoot, 'index.html'))) {
    throw new Error(
      `${join(distRoot, 'index.html')} does not exist. ` +
        'Run `pnpm --filter ag-ui-harness build:page` first.',
    );
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/agui') {
      proxy(req, res, opts.agentUrl);
      return;
    }
    // Chrome asks unprompted, and an unhandled 404 shows up as a console error, which the
    // e2e asserts is empty.
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = rel === '/' || rel === '\\' ? join(distRoot, 'index.html') : join(distRoot, rel);
    if (!file.startsWith(distRoot) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ready) => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      ready({
        url: `http://localhost:${String(port)}/`,
        stop: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            // A proxied SSE response holds its socket open. `close` alone would wait for it,
            // so idle and in-flight sockets are dropped explicitly — same reason
            // `startHarnessServer` does it.
            server.closeAllConnections();
          }),
      });
    });
  });
}
