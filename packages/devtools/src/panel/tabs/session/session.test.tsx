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

  it('reports undetected framework and endpoints rather than omitting them', () => {
    render(<Session store={createPanelStore()} />);
    expect(screen.getByText('Framework')).toBeTruthy();
    expect(screen.getByText('Endpoints')).toBeTruthy();
    expect(
      screen.getAllByText(/not detected — detection ships with the capture layer/).length,
    ).toBeGreaterThanOrEqual(2);
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
