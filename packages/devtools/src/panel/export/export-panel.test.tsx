import { describe, expect, test, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/preact';
import happyJsonl from '../../test/fixtures/happy-run.agui.jsonl?raw';
import { decodeJsonl, type JsonlHeader } from '../../core/jsonl/codec';
import { applyLoaded } from '../import/apply-loaded';
import { loadJsonl } from '../import/load-jsonl';
import { initialPanelState, type PanelState } from '../model/panel-types';
import { createPanelStore, selectScope, type PanelStore } from '../model/store';
import { ExportPanel } from './export-panel';
import type { ExportIo } from './download';

interface Written {
  filename: string;
  text: string;
}

function io(overrides: Partial<ExportIo> = {}): { io: ExportIo; files: Written[]; copies: string[] } {
  const files: Written[] = [];
  const copies: string[] = [];
  return {
    files,
    copies,
    io: {
      download: (filename, text) => {
        files.push({ filename, text });
        return { ok: true };
      },
      copy: (text) => {
        copies.push(text);
        return Promise.resolve({ ok: true });
      },
      ...overrides,
    },
  };
}

function importedStore(text = happyJsonl): PanelStore {
  return createPanelStore(
    applyLoaded(initialPanelState(), loadJsonl(text), 'happy-run.agui.jsonl', 1000),
  );
}

function headerOf(text: string): JsonlHeader {
  const first = decodeJsonl(text).lines[0];
  if (first === undefined || first.kind !== 'header') throw new Error('no header on line 1');
  return first;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ExportPanel: what it says before you click', () => {
  test('states what the file will contain, so the click is never a guess', () => {
    render(<ExportPanel store={importedStore()} io={io().io} />);

    expect(screen.getByTestId('agui-export-summary').textContent).toBe(
      '1 run, 14 events, 1 keepalive and 1 request line — unredacted.',
    );
  });

  test('restates the summary when a redaction group is chosen', () => {
    render(<ExportPanel store={importedStore()} io={io().io} />);

    fireEvent.click(screen.getByLabelText(/Message text/));

    expect(screen.getByTestId('agui-export-summary').textContent).toBe(
      '1 run, 14 events, 1 keepalive and 1 request line — redacting text.',
    );
  });

  test('narrows the summary to the scoped run', () => {
    const store = importedStore();
    store.update((s) => selectScope(s, 'r_happy'));

    render(<ExportPanel store={store} io={io().io} />);

    expect(screen.getByTestId('agui-export-summary').textContent).toContain('1 run, 14 events');
  });

  test('warns that redacting tool arguments makes them unparseable', () => {
    render(<ExportPanel store={importedStore()} io={io().io} />);
    expect(screen.queryByTestId('agui-export-args-note')).toBeNull();

    fireEvent.click(screen.getByLabelText(/Tool arguments/));

    expect(screen.getByTestId('agui-export-args-note').textContent).toContain(
      'tool-args-not-json',
    );
  });
});

describe('ExportPanel: the empty capture', () => {
  test('disables every control with a stated reason instead of writing a zero-record file', () => {
    render(<ExportPanel store={createPanelStore(initialPanelState())} io={io().io} />);

    for (const name of [/Download capture/, /Copy JSON/, /Download TypeScript fixture/]) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.getByTestId('agui-export-blocked').textContent).toBe(
      'Nothing has been captured yet, so there is nothing to export.',
    );
  });

  test('the handler refuses too, so no path can write a zero-record file', () => {
    // `disabled` is the visible half. `fireEvent.click` dispatches straight to the handler, which
    // is exactly what an assistive technology or a stray keyboard path could do — so the refusal
    // is stated in the handler as well, not left to the attribute.
    const harness = io();
    render(<ExportPanel store={createPanelStore(initialPanelState())} io={harness.io} />);

    fireEvent.click(screen.getByRole('button', { name: /Download capture/ }));

    expect(harness.files).toEqual([]);
    expect(screen.getByRole('alert').textContent).toBe(
      'Nothing has been captured yet, so there is nothing to export.',
    );
  });
});

describe('ExportPanel: E4’s five modes', () => {
  test('full — every run, unredacted', () => {
    const harness = io();
    render(<ExportPanel store={importedStore()} io={harness.io} />);

    fireEvent.click(screen.getByRole('button', { name: /Download capture/ }));

    const written = harness.files[0];
    if (written === undefined) throw new Error('nothing was written');
    expect(written.filename).toBe('agui-localhost-3000-2026-08-13T10-00-00.000Z.agui.jsonl');
    expect(headerOf(written.text).redacted).toEqual([]);
    expect(decodeJsonl(written.text).lines).toHaveLength(17);
  });

  test('single run — the panel’s current scope, and nothing else', () => {
    const harness = io();
    const store = importedStore();
    store.update((s) => selectScope(s, 'r_happy'));

    render(<ExportPanel store={store} io={harness.io} />);
    fireEvent.click(screen.getByRole('button', { name: /Download capture/ }));

    expect(decodeJsonl(harness.files[0]?.text ?? '').lines).toHaveLength(17);
  });

  test('redacted bug report — a modifier on the scope, recorded in the header', () => {
    const harness = io();
    render(<ExportPanel store={importedStore()} io={harness.io} />);

    fireEvent.click(screen.getByLabelText(/Message text/));
    fireEvent.click(screen.getByLabelText(/State values/));
    fireEvent.click(screen.getByRole('button', { name: /Download capture/ }));

    expect(headerOf(harness.files[0]?.text ?? '').redacted).toEqual(['text', 'state']);
    expect(harness.files[0]?.text).not.toContain('The weather in Paris');
  });

  test('“Redact everything” selects all five §11 groups at once', () => {
    const harness = io();
    render(<ExportPanel store={importedStore()} io={harness.io} />);

    fireEvent.click(screen.getByRole('button', { name: /Redact everything/ }));
    fireEvent.click(screen.getByRole('button', { name: /Download capture/ }));

    expect(headerOf(harness.files[0]?.text ?? '').redacted).toEqual([
      'text',
      'reasoning',
      'toolArgs',
      'toolResults',
      'state',
    ]);
  });

  test('clipboard JSON — the same bytes, to the clipboard', async () => {
    const harness = io();
    render(<ExportPanel store={importedStore()} io={harness.io} />);

    fireEvent.click(screen.getByRole('button', { name: /Copy JSON/ }));
    await screen.findByRole('status');

    expect(harness.copies[0]).toContain('"kind":"header"');
    expect(harness.copies[0]).toContain('RUN_FINISHED');
  });

  test('fixture export — a .ts module with the event array', () => {
    const harness = io();
    render(<ExportPanel store={importedStore()} io={harness.io} />);

    fireEvent.click(screen.getByRole('button', { name: /Download TypeScript fixture/ }));

    expect(harness.files[0]?.filename).toBe(
      'agui-localhost-3000-2026-08-13T10-00-00.000Z.fixture.ts',
    );
    expect(harness.files[0]?.text).toContain('export const events: AguiEvent[] = [');
  });
});

describe('ExportPanel: E3 through the UI', () => {
  test('re-exporting an already-redacted capture keeps the groups it arrived with', () => {
    const harness = io();
    const store = importedStore(happyJsonl.replace('"redacted":[]', '"redacted":["reasoning"]'));

    render(<ExportPanel store={store} io={harness.io} />);
    fireEvent.click(screen.getByLabelText(/Message text/));
    fireEvent.click(screen.getByRole('button', { name: /Download capture/ }));

    expect(headerOf(harness.files[0]?.text ?? '').redacted).toEqual(['text', 'reasoning']);
  });

  test('and says so on screen, before the click', () => {
    const store = importedStore(happyJsonl.replace('"redacted":[]', '"redacted":["reasoning"]'));

    render(<ExportPanel store={store} io={io().io} />);

    expect(screen.getByTestId('agui-export-inherited').textContent).toContain('reasoning');
  });
});

describe('ExportPanel: failures are reported, never swallowed', () => {
  test('a refused download is stated inline', () => {
    render(
      <ExportPanel
        store={importedStore()}
        io={io({ download: () => ({ ok: false, reason: 'The browser refused the download: nope' }) }).io}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Download capture/ }));

    expect(screen.getByRole('alert').textContent).toBe('The browser refused the download: nope');
  });

  test('a refused clipboard write is stated inline — the failure this project keeps meeting', async () => {
    render(
      <ExportPanel
        store={importedStore()}
        io={
          io({
            copy: () => Promise.resolve({ ok: false, reason: 'Write permission denied.' }),
          }).io
        }
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Copy JSON/ }));

    expect((await screen.findByRole('alert')).textContent).toBe('Write permission denied.');
  });

  test('a successful copy confirms, so success and a no-op are never the same thing on screen', async () => {
    render(<ExportPanel store={importedStore()} io={io().io} />);

    fireEvent.click(screen.getByRole('button', { name: /Copy JSON/ }));

    expect((await screen.findByRole('status')).textContent).toContain('Copied');
  });
});

describe('ExportPanel: privacy posture', () => {
  test('nothing is redacted unless the user says so — redaction is never a default', () => {
    render(<ExportPanel store={importedStore()} io={io().io} />);

    for (const label of [
      /Message text/,
      /Reasoning/,
      /Tool arguments/,
      /Tool results/,
      /State values/,
    ]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).checked).toBe(false);
    }
  });
});

/** The state a live capture holds, used to prove export does not need a file behind it. */
function liveState(): PanelState {
  const loaded = loadJsonl(happyJsonl);
  return {
    ...initialPanelState(),
    source: { kind: 'live', origin: 'http://localhost:3000' },
    capture: { kind: 'on', origin: 'http://localhost:3000' },
    runs: loaded.runs,
    records: loaded.records,
    requests: loaded.requests,
    issues: loaded.issues,
  };
}

describe('ExportPanel: a live capture', () => {
  test('exports with no imported file behind it, stamped with the inspected origin', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
    const harness = io();

    render(<ExportPanel store={createPanelStore(liveState())} io={harness.io} />);
    fireEvent.click(screen.getByRole('button', { name: /Download capture/ }));

    expect(harness.files[0]?.filename).toBe(
      'agui-localhost-3000-2026-08-15T12-00-00.000Z.agui.jsonl',
    );
    expect(headerOf(harness.files[0]?.text ?? '').url).toBe('http://localhost:3000');
  });
});
