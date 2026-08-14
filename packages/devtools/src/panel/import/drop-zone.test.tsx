import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { DropZone } from './drop-zone';
import type { LoadedCapture } from './load-jsonl';
import { createPanelStore } from '../model/store';

function fileOf(name: string, text: string): File {
  return new File([text], name, { type: 'application/jsonl' });
}

/** jsdom's DataTransfer has no usable `files`, so hand `drop` a minimal stand-in. */
function dropFile(target: HTMLElement, file: File): void {
  fireEvent.drop(target, {
    dataTransfer: { files: { item: (i: number) => (i === 0 ? file : null), length: 1 } },
  });
}

describe('DropZone', () => {
  it('invites a drop and offers a file picker', () => {
    render(<DropZone store={createPanelStore()} onLoaded={vi.fn()} />);
    expect(screen.getByText(/drop a \.agui\.jsonl capture here/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /choose file/i })).toBeTruthy();
    expect(screen.getByLabelText(/import \.agui\.jsonl capture/i)).toBeTruthy();
  });

  it('decodes a picked file and hands the result up', async () => {
    const onLoaded = vi.fn();
    render(<DropZone store={createPanelStore()} onLoaded={onLoaded} />);

    const input = screen.getByLabelText(/import \.agui\.jsonl capture/i) as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: {
        item: (i: number) =>
          i === 0
            ? fileOf(
                'happy.agui.jsonl',
                '{"kind":"header","schemaVersion":1,"tool":"t","capturedAt":"2026-01-01T00:00:00Z","url":"http://x"}\n' +
                  '{"kind":"event","connId":"c1","seq":1,"tMs":0,"event":{"type":"RUN_STARTED","threadId":"t_1","runId":"r_1"}}\n' +
                  '{"kind":"event","connId":"c1","seq":2,"tMs":9,"event":{"type":"RUN_FINISHED","threadId":"t_1","runId":"r_1"}}\n',
              )
            : null,
      },
      configurable: true,
    });
    fireEvent.change(input);

    await waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(1));
    const [loaded, filename] = onLoaded.mock.calls[0] as [LoadedCapture, string];
    expect(filename).toBe('happy.agui.jsonl');
    expect(loaded.records).toHaveLength(2);
    expect(loaded.decodeErrors).toEqual([]);
    expect(await screen.findByText(/every line decoded/i)).toBeTruthy();
  });

  it('decodes a dropped file', async () => {
    const onLoaded = vi.fn();
    render(<DropZone store={createPanelStore()} onLoaded={onLoaded} />);
    dropFile(
      screen.getByText(/drop a \.agui\.jsonl capture here/i),
      fileOf(
        'x.agui.jsonl',
        '{"kind":"event","connId":"c1","seq":1,"tMs":0,"event":{"type":"RUN_STARTED","threadId":"t_1","runId":"r_1"}}\n',
      ),
    );
    await waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(1));
  });

  it('surfaces every decode error so a partial file never looks clean', async () => {
    const onLoaded = vi.fn();
    render(<DropZone store={createPanelStore()} onLoaded={onLoaded} />);
    dropFile(
      screen.getByText(/drop a \.agui\.jsonl capture here/i),
      fileOf(
        'partial.agui.jsonl',
        '{"kind":"event","connId":"c1","seq":1,"tMs":0,"event":{"type":"RUN_STARTED","threadId":"t_1","runId":"r_1"}}\n' +
          '{ this is not json\n' +
          '{"kind":"event","connId":"c1","seq":2,"tMs":5,"event":{"type":"RUN_FINISHED","threadId":"t_1","runId":"r_1"}}\n' +
          'also not json\n',
      ),
    );

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/2 undecodable lines/i);
    expect(alert.textContent).toMatch(/incomplete/i);
    expect(alert.querySelectorAll('li')).toHaveLength(2);
    // The clean-load line must NOT also be on screen.
    expect(screen.queryByText(/every line decoded/i)).toBeNull();
  });

  it('records a failure on the store and reports it, without calling onLoaded', async () => {
    const store = createPanelStore();
    const onLoaded = vi.fn();
    const unreadable = fileOf('broken.agui.jsonl', 'x');
    // Simulate an unreadable file: FileReader is what the component uses.
    vi.spyOn(FileReader.prototype, 'readAsText').mockImplementation(function (this: FileReader) {
      queueMicrotask(() => this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>));
    });

    render(<DropZone store={store} onLoaded={onLoaded} />);
    dropFile(screen.getByText(/drop a \.agui\.jsonl capture here/i), unreadable);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/import failed/i);
    expect(store.get().loadError).toMatch(/^broken\.agui\.jsonl: /);
    expect(onLoaded).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
