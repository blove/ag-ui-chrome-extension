import { useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { PanelStore } from '../model/store';
import { loadFailed } from '../model/store';
import type { LoadedCapture } from './load-jsonl';
import { loadJsonl } from './load-jsonl';

/**
 * Read a picked or dropped file as text.
 *
 * `File.text()` would be the modern spelling, but jsdom implements neither `Blob.text()` nor
 * `Blob.arrayBuffer()`, so using it would make this component untestable outside a real browser.
 * `FileReader` is implemented everywhere including jsdom. Do not "modernize" this.
 */
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('could not be read'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(file);
  });
}

export interface DropZoneProps {
  store: PanelStore;
  /** Called with a successfully decoded capture. The caller commits it (see `applyLoaded`). */
  onLoaded: (loaded: LoadedCapture, filename: string) => void;
}

/**
 * Import of a `.agui.jsonl` capture, by drag-and-drop or file picker.
 *
 * Requirements §10 makes this the shareable-bug-report path, not a fallback: a colleague who
 * cannot reproduce the issue gets your exact stream, read-only, with every tab working. Under
 * the design's §7 sequencing it is also the only way data reaches the panel until the capture
 * layer lands, so it is a first-class control rather than a corner of an empty state.
 *
 * Reading is a `FileReader` over the picked file and nothing else — no network, nothing
 * written to disk (requirements §11).
 *
 * `decodeErrors` is rendered here line by line and summarized into `loadError` by the caller's
 * commit. A file that half decoded must never render as a clean one.
 */
export function DropZone({ store, onLoaded }: DropZoneProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [decodeErrors, setDecodeErrors] = useState<string[]>([]);
  const [loadedName, setLoadedName] = useState<string | null>(null);

  function fail(filename: string, cause: unknown): void {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const message = `${filename}: ${detail}`;
    setDecodeErrors([]);
    setLoadedName(null);
    setFailure(message);
    store.update((s) => loadFailed(s, message));
  }

  async function ingest(file: File): Promise<void> {
    let text: string;
    try {
      text = await readText(file);
    } catch (cause) {
      fail(file.name, cause);
      return;
    }
    let loaded: LoadedCapture;
    try {
      loaded = loadJsonl(text, { expandChunks: store.get().expandChunks });
    } catch (cause) {
      // `loadJsonl` is specified not to throw, so reaching here is a bug in the decoder rather
      // than bad input. Report it as a failed import instead of rendering an empty panel.
      fail(file.name, cause);
      return;
    }
    setFailure(null);
    setDecodeErrors(loaded.decodeErrors);
    setLoadedName(file.name);
    onLoaded(loaded, file.name);
  }

  function onDrop(event: JSX.TargetedDragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer?.files.item(0);
    if (file) void ingest(file);
  }

  function onPick(event: JSX.TargetedEvent<HTMLInputElement, Event>): void {
    const input = event.currentTarget;
    const file = input.files?.item(0);
    // Clear the value so re-picking the same file fires `change` again.
    input.value = '';
    if (file) void ingest(file);
  }

  return (
    <div class="agui-drop">
      <div
        class={dragging ? 'agui-drop__target agui-drop__target--over' : 'agui-drop__target'}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p class="agui-drop__hint">Drop a .agui.jsonl capture here</p>
        <button type="button" class="agui-drop__pick" onClick={() => inputRef.current?.click()}>
          Choose file
        </button>
        <input
          ref={inputRef}
          class="agui-drop__input"
          type="file"
          accept=".jsonl,.agui.jsonl,application/jsonl,text/plain"
          aria-label="Import .agui.jsonl capture"
          onChange={onPick}
        />
      </div>

      {failure !== null && (
        <p class="agui-drop__error" role="alert">
          Import failed — {failure}
        </p>
      )}

      {loadedName !== null && decodeErrors.length === 0 && (
        <p class="agui-drop__ok">Loaded {loadedName} — every line decoded.</p>
      )}

      {loadedName !== null && decodeErrors.length > 0 && (
        <div class="agui-drop__partial" role="alert">
          <p class="agui-drop__partial-head">
            Loaded {loadedName} with {decodeErrors.length} undecodable{' '}
            {decodeErrors.length === 1 ? 'line' : 'lines'} — this capture is incomplete.
          </p>
          <ul class="agui-drop__partial-list">
            {decodeErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
