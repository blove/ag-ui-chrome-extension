import { afterEach, describe, expect, test, vi } from 'vitest';
import { copyText, downloadText } from './download';

interface ObjectUrlApi {
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
}

/**
 * jsdom implements neither `URL.createObjectURL` nor `URL.revokeObjectURL`, so a test has to
 * supply them. That absence is the point of the second test below: a panel document that turns
 * out not to have them must say so, not fail silently.
 */
function installObjectUrls(): { created: Blob[]; revoked: string[] } {
  const created: Blob[] = [];
  const revoked: string[] = [];
  const api = URL as unknown as ObjectUrlApi;
  api.createObjectURL = (blob) => {
    created.push(blob);
    return `blob:test/${String(created.length)}`;
  };
  api.revokeObjectURL = (url) => revoked.push(url);
  return { created, revoked };
}

afterEach(() => {
  const api = URL as unknown as ObjectUrlApi;
  delete api.createObjectURL;
  delete api.revokeObjectURL;
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  vi.useRealTimers();
});

describe('downloadText', () => {
  test('E1: a Blob and an object URL, which need no manifest permission at all', () => {
    const { created } = installObjectUrls();

    const result = downloadText('capture.agui.jsonl', '{"kind":"header"}\n');

    expect(result).toEqual({ ok: true });
    expect(created).toHaveLength(1);
    // `application/x-ndjson` is what JSONL is; a browser must not offer to render it as a page.
    expect(created[0]?.type).toBe('application/x-ndjson');
  });

  test('clicks an anchor carrying the filename, which is how the file gets its name', () => {
    installObjectUrls();
    const clicked: { download: string; href: string; inDocument: boolean }[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push({
          download: this.download,
          href: this.href,
          // The anchor has to be IN the document when it is clicked: a detached anchor's click
          // is ignored in Chrome, which is a silent no-op — the failure class this project keeps
          // meeting.
          inDocument: document.body.contains(this),
        });
      });

    downloadText('agui-localhost-3000.agui.jsonl', 'x\n');

    expect(clicked).toEqual([
      {
        download: 'agui-localhost-3000.agui.jsonl',
        href: 'blob:test/1',
        inDocument: true,
      },
    ]);
    click.mockRestore();
  });

  test('takes the anchor back out of the document, leaving no trace in the panel', () => {
    installObjectUrls();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadText('f.agui.jsonl', 'x\n');

    expect(document.querySelectorAll('a[download]')).toHaveLength(0);
    click.mockRestore();
  });

  test('revokes the object URL, so a long session does not leak every capture it exported', () => {
    vi.useFakeTimers();
    const { revoked } = installObjectUrls();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadText('f.agui.jsonl', 'x\n');
    // Revoked on a later turn, not synchronously: revoking before Chrome has read the blob
    // cancels the download.
    expect(revoked).toEqual([]);
    vi.runAllTimers();
    expect(revoked).toEqual(['blob:test/1']);

    click.mockRestore();
  });

  test('writes the exact bytes it was given', async () => {
    const { created } = installObjectUrls();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadText('f.agui.jsonl', '{"a":1}\n{"b":2}\n');

    expect(await created[0]?.text()).toBe('{"a":1}\n{"b":2}\n');
    click.mockRestore();
  });

  test('reports a document with no object-URL support rather than doing nothing', () => {
    // E1's risk, made visible: if a DevTools panel document ever turns out not to support this,
    // the user is told, not left looking at a button that appears to work.
    const api = URL as unknown as ObjectUrlApi;
    delete api.createObjectURL;

    const result = downloadText('f.agui.jsonl', 'x\n');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('could not create an object URL');
    expect(result.ok === false && result.reason).toContain('Copy the capture to the clipboard');
  });

  test('reports an object URL that was refused, naming that as the step that failed', () => {
    // jsdom's own `URL.createObjectURL` rejects a jsdom `Blob`, which is a faithful stand-in for
    // any document where the call is present but refuses.
    const result = downloadText('f.agui.jsonl', 'x\n');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('could not create an object URL');
  });

  test('reports a refusal from the click rather than swallowing it', () => {
    installObjectUrls();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('Not allowed to download in this context');
    });

    const result = downloadText('f.agui.jsonl', 'x\n');

    expect(result).toEqual({
      ok: false,
      reason: 'The browser refused the download: Not allowed to download in this context',
    });
    click.mockRestore();
  });
});

describe('copyText', () => {
  test('writes through the clipboard API when it is available', async () => {
    const written: string[] = [];
    (navigator as unknown as { clipboard: unknown }).clipboard = {
      writeText: (text: string) => {
        written.push(text);
        return Promise.resolve();
      },
    };

    await expect(copyText('{"kind":"header"}')).resolves.toEqual({ ok: true });
    expect(written).toEqual(['{"kind":"header"}']);
  });

  test('reports a refusal, because a silent no-op on copy is indistinguishable from success', () => {
    (navigator as unknown as { clipboard: unknown }).clipboard = {
      writeText: () => Promise.reject(new Error('Write permission denied.')),
    };

    return expect(copyText('x')).resolves.toEqual({
      ok: false,
      reason: 'The browser refused the clipboard write: Write permission denied.',
    });
  });

  test('reports the absence of a clipboard API rather than resolving as though it copied', () => {
    return expect(copyText('x')).resolves.toEqual({
      ok: false,
      reason:
        'This document has no clipboard API, so nothing was copied. Use the download instead.',
    });
  });
});
