import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { Session } from './session';
import { createPanelStore } from '../../model/store';
import { initialPanelState } from '../../model/panel-types';
import { makeIssue } from '../../../core/model/types';

const HAPPY =
  '{"kind":"event","connId":"c1","seq":1,"tMs":0,"event":{"type":"RUN_STARTED","threadId":"t_1","runId":"r_1"}}\n' +
  '{"kind":"event","connId":"c1","seq":2,"tMs":9,"event":{"type":"RUN_FINISHED","threadId":"t_1","runId":"r_1"}}\n';

function dropOn(target: HTMLElement, name: string, text: string): void {
  fireEvent.drop(target, {
    dataTransfer: {
      files: {
        item: (i: number) => (i === 0 ? new File([text], name, { type: 'text/plain' }) : null),
      },
    },
  });
}

describe('Session', () => {
  it('says nothing is loaded, and that capture is unavailable in this build', () => {
    render(<Session store={createPanelStore()} />);
    expect(screen.getByText('nothing loaded yet')).toBeTruthy();
    expect(screen.getByText('unavailable in this build')).toBeTruthy();
  });

  it('names the imported file as the source', () => {
    const store = createPanelStore({
      ...initialPanelState(),
      source: { kind: 'imported', filename: 'bug.agui.jsonl', importedAtMs: 0 },
    });
    render(<Session store={store} />);
    expect(screen.getByText(/bug\.agui\.jsonl \(imported /)).toBeTruthy();
  });

  it('names the live origin as the source', () => {
    const store = createPanelStore({
      ...initialPanelState(),
      source: { kind: 'live', origin: 'http://localhost:3000' },
      capture: { kind: 'on', origin: 'http://localhost:3000' },
    });
    render(<Session store={store} />);
    expect(screen.getByText('live capture from http://localhost:3000')).toBeTruthy();
    expect(screen.getByText('on for http://localhost:3000')).toBeTruthy();
  });

  it('reports a capture-off origin without claiming nothing is there', () => {
    const store = createPanelStore({
      ...initialPanelState(),
      capture: { kind: 'off', origin: 'https://app.example', signal: { level: 'none' } },
    });
    render(<Session store={store} />);
    const value = screen.getByText(/^off for https:\/\/app\.example/);
    expect(value.textContent).toMatch(/nothing on the wire yet/i);
    expect(value.textContent).not.toMatch(/nothing detected/i);
  });

  it('labels the session with the framework the page probe found', () => {
    const store = createPanelStore({ ...initialPanelState(), framework: 'Angular 21.1.6' });
    render(<Session store={store} />);
    expect(screen.getByText('Framework')).toBeTruthy();
    expect(screen.getByText('Angular 21.1.6')).toBeTruthy();
  });

  it('reports undetected framework and endpoints rather than omitting them', () => {
    render(<Session store={createPanelStore()} />);
    expect(screen.getByText('Framework')).toBeTruthy();
    expect(screen.getByText('Endpoints')).toBeTruthy();
    expect(
      screen.getAllByText(/not detected — detection ships with the capture layer/).length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/no framework fingerprint in the page/)).toBeTruthy();
  });

  it('summarizes issues by severity', () => {
    const store = createPanelStore({
      ...initialPanelState(),
      issues: [
        makeIssue('empty-text-delta', 'a', 1),
        makeIssue('unclosed-message', 'b', 2),
        makeIssue('unbalanced-steps', 'c', 3),
        makeIssue('keepalive-gap', 'd', 4),
      ],
    });
    render(<Session store={store} />);

    const value = (label: string): string =>
      screen.getByText(label).nextElementSibling?.textContent ?? '';
    expect(screen.getByText('Issues (all runs)')).toBeTruthy();
    expect(value('Errors')).toBe('1');
    expect(value('Warnings')).toBe('2');
    expect(value('Info')).toBe('1');
    expect(value('Total')).toBe('4');
  });

  it('states that export is not available rather than offering one', () => {
    render(<Session store={createPanelStore()} />);
    expect(screen.getByText('not available in phase 1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /export/i })).toBeNull();
  });

  it('carries the import control and commits a dropped capture to the store', async () => {
    const store = createPanelStore();
    render(<Session store={store} />);

    dropOn(screen.getByText(/drop a \.agui\.jsonl capture here/i), 'shared.agui.jsonl', HAPPY);

    await waitFor(() => expect(store.get().source.kind).toBe('imported'));
    expect(store.get().records).toHaveLength(2);
    expect(store.get().loadError).toBeNull();
    expect(screen.getByText(/shared\.agui\.jsonl \(imported /)).toBeTruthy();
  });

  it('records a partial decode in loadError so it survives leaving this tab', async () => {
    const store = createPanelStore();
    render(<Session store={store} />);

    dropOn(
      screen.getByText(/drop a \.agui\.jsonl capture here/i),
      'partial.agui.jsonl',
      `${HAPPY}{ not json\n`,
    );

    await waitFor(() => expect(store.get().source.kind).toBe('imported'));
    expect(store.get().loadError).toBe(
      'partial.agui.jsonl: 1 line could not be decoded — this capture is incomplete.',
    );
  });
});

/*
 * Requirements §5.4 / resolution C3. A binary connection yields no records at all, so if the
 * Session tab said nothing about it the reader would see an empty capture and conclude capture
 * is broken — which §15 names as the failure mode to avoid.
 */
describe('Session — binary transport', () => {
  it('names the binary transport and says decoding is not supported yet', () => {
    const store = createPanelStore({
      ...initialPanelState(),
      source: { kind: 'live', origin: 'http://localhost:3000' },
      capture: { kind: 'on', origin: 'http://localhost:3000' },
      binaryTransport: {
        connId: 'c1',
        tMs: 4,
        contentType: 'application/vnd.ag-ui.event+proto',
        bytes: 2048,
      },
    });
    render(<Session store={store} />);

    const transport = screen.getByText('Transport').nextElementSibling?.textContent ?? '';
    expect(transport).toContain('binary');
    expect(transport).toContain('application/vnd.ag-ui.event+proto');
    expect(transport).toContain('2048');
    expect(transport).toMatch(/decoding is not supported yet/i);
  });

  it('reports SSE for a live capture that produced records', () => {
    const store = createPanelStore({
      ...initialPanelState(),
      source: { kind: 'live', origin: 'http://localhost:3000' },
      capture: { kind: 'on', origin: 'http://localhost:3000' },
      records: [
        {
          kind: 'event',
          seq: 1,
          tMs: 0,
          connId: 'c1',
          raw: null,
          event: { type: 'CUSTOM' },
          issues: [],
        },
      ],
    });
    render(<Session store={store} />);
    expect(screen.getByText('Transport').nextElementSibling?.textContent ?? '').toContain(
      'text/event-stream',
    );
  });
});
