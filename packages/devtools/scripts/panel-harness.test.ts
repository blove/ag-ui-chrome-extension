import { get as httpGet } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type StaticServer } from './panel-harness';

/**
 * Issues a raw HTTP GET against a `StaticServer`. Deliberately not `fetch`: the WHATWG URL
 * parser collapses literal `..` segments (and, for some payloads, percent-encoded ones) before
 * the request is ever sent, which would silently "fix" the very traversal payloads these tests
 * exist to send. `http.get`'s `path` option is written to the request line unmodified, so it is
 * the server's own `normalize` + `startsWith(root)` guard being exercised here, not the client's.
 */
function rawGet(origin: string, path: string): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve, reject) => {
    httpGet({ hostname, port: Number(port), path }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

describe('startServer', () => {
  // A fresh root (and, for the traversal cases, a sentinel file one level above it) per test, so
  // one test's files can never leak into another's expectations.
  let workDir: string | undefined;
  let server: StaticServer | undefined;

  afterEach(async () => {
    await server?.close();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
    server = undefined;
  });

  it('serves a file with the content-type inferred from its extension', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'panel-harness-'));
    const root = join(workDir, 'public');
    mkdirSync(root);
    writeFileSync(join(root, 'index.html'), '<h1>hi</h1>', 'utf8');
    server = await startServer(root);

    const res = await fetch(`${server.origin}/index.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe('<h1>hi</h1>');
  });

  it('404s a file that does not exist', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'panel-harness-'));
    const root = join(workDir, 'public');
    mkdirSync(root);
    server = await startServer(root);

    const res = await fetch(`${server.origin}/missing.html`);
    expect(res.status).toBe(404);
  });

  it('does not serve a file outside root via literal `..` segments', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'panel-harness-'));
    const root = join(workDir, 'public');
    mkdirSync(root);
    // The sentinel lives next to `root`, not inside it — if the traversal guard has a hole, this
    // is what would leak through it.
    writeFileSync(join(workDir, 'secret.txt'), 'do-not-serve', 'utf8');
    server = await startServer(root);

    const res = await rawGet(server.origin, '/foo/../../../secret.txt');
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('do-not-serve');
  });

  it('does not serve a file outside root via percent-encoded `..` segments', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'panel-harness-'));
    const root = join(workDir, 'public');
    mkdirSync(root);
    writeFileSync(join(workDir, 'secret.txt'), 'do-not-serve', 'utf8');
    server = await startServer(root);

    // `%2f` is `/`. The WHATWG URL parser leaves it encoded (unlike a literal `..`), so this is
    // the payload shape that actually reaches the server as written, which is the point of the
    // `rawGet` helper's own comment above.
    const res = await rawGet(server.origin, '/..%2f..%2fsecret.txt');
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('do-not-serve');
  });

  it('responds (rather than crashing the process) when the request path is a directory', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'panel-harness-'));
    const root = join(workDir, 'public');
    mkdirSync(join(root, 'sub'), { recursive: true });
    server = await startServer(root);

    // Before the EISDIR fix, `existsSync(dir)` was true and `createReadStream(dir)` threw an
    // unhandled stream error that took the whole process down. A clean response here — whatever
    // the status — is the assertion; the test process surviving to make it is the real proof.
    const res = await fetch(`${server.origin}/sub`);
    expect(res.status).toBe(404);
  });
});
