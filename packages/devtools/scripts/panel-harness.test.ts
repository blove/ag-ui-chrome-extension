import { get as httpGet } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type StaticServer } from './panel-harness';

/**
 * Issues a raw HTTP GET against a `StaticServer`, with `path` written to the request line
 * unmodified. Deliberately not `fetch`: the WHATWG URL parser `fetch` builds on collapses literal
 * `..` segments client-side before the request is ever sent, so a payload built with `new
 * URL(...)` never reaches the server as written. `http.get`'s `path` option has no such parsing.
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

  it('a literal `..` segment never reaches the traversal guard at all', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'panel-harness-'));
    const root = join(workDir, 'public');
    mkdirSync(root);
    writeFileSync(join(workDir, 'secret.txt'), 'do-not-serve', 'utf8');
    server = await startServer(root);

    // This is NOT a test of `startServer`'s own defence. `startServer` parses `req.url` with
    // `new URL(...)`, and the WHATWG URL parser collapses literal dot-segments on arrival — same
    // as `fetch` does client-side — so `url.pathname` is already `/secret.txt` before `normalize`
    // or the `startsWith(root)` guard ever run. Sent here via raw `http.get` specifically to prove
    // that: this 404 (and every one of it, against a defenceless variant of the server with the
    // guard and the explicit `normalize` call both deleted) is the URL parser's doing, not ours.
    const res = await rawGet(server.origin, '/foo/../../../secret.txt');
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('do-not-serve');
  });

  it('does not serve a file outside root via a percent-encoded `..` segment', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'panel-harness-'));
    const root = join(workDir, 'public');
    mkdirSync(root);
    // One level above `root`, matching the one `..` in the payload below — a deeper sentinel
    // would let a broken guard overshoot into nonexistent territory and 404 for the wrong reason.
    writeFileSync(join(workDir, 'secret.txt'), 'do-not-serve', 'utf8');
    server = await startServer(root);

    // `%2f` is `/`. Unlike a literal `..`, the WHATWG URL parser leaves `%2f` encoded rather than
    // treating it as a path separator, so `url.pathname` inside `startServer` is still literally
    // `/..%2fsecret.txt` — it is `decodeURIComponent` + `normalize` in `startServer` itself that
    // must turn this back into a confined path, which is what this test actually exercises.
    // Verified by mutation: against a copy of `startServer` with the `startsWith(root)` guard and
    // the explicit `normalize` call both deleted, this exact payload returns 200 with the
    // sentinel's contents; deeper payloads (e.g. two encoded `..`) 404 even on that broken
    // variant because they overshoot past the sentinel instead of landing on it, which is why the
    // payload here is exactly one level, not two.
    const res = await rawGet(server.origin, '/..%2fsecret.txt');
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('do-not-serve');
  });

  it('responds (rather than crashing the process) when the request path is a directory', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'panel-harness-'));
    const root = join(workDir, 'public');
    mkdirSync(join(root, 'sub'), { recursive: true });
    server = await startServer(root);

    // Before the EISDIR fix, `existsSync(dir)` was true and `createReadStream(dir)` threw an
    // unhandled stream error that took the whole process down before any assertion could run.
    // The 404 below (from `isFile()` rejecting a directory) is the expected status; the test
    // process surviving long enough to check it is the regression this test actually pins.
    const res = await fetch(`${server.origin}/sub`);
    expect(res.status).toBe(404);
  });
});
