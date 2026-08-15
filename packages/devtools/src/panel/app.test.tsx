import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { App } from './app';
import { createPanelStore } from './model/store';
import { initialPanelState } from './model/panel-types';
import type { TabId } from './model/panel-types';
import { tabPanelId } from './shell/tab-strip';

const HAPPY =
  '{"kind":"event","connId":"c1","seq":1,"tMs":0,"event":{"type":"RUN_STARTED","threadId":"t_1","runId":"r_1"}}\n' +
  '{"kind":"event","connId":"c1","seq":2,"tMs":9,"event":{"type":"RUN_FINISHED","threadId":"t_1","runId":"r_1"}}\n';

/**
 * A chunked run.
 *
 * `expandChunks` does not change how many RECORDS there are — the records are the captured
 * frames and stay what the wire carried. It changes what the run BUILDER makes of them: an
 * unexpanded `TEXT_MESSAGE_CHUNK` reconstructs no message at all, an expanded one reconstructs
 * START + CONTENT + END and therefore a message. That difference is what these tests watch, and
 * it is visible on screen as the waterfall's lane summary.
 */
const CHUNKED =
  '{"kind":"event","connId":"c1","seq":1,"tMs":0,"event":{"type":"RUN_STARTED","threadId":"t_1","runId":"r_1"}}\n' +
  '{"kind":"event","connId":"c1","seq":2,"tMs":5,"event":{"type":"TEXT_MESSAGE_CHUNK","messageId":"m_1","role":"assistant","delta":"hi"}}\n' +
  '{"kind":"event","connId":"c1","seq":3,"tMs":9,"event":{"type":"RUN_FINISHED","threadId":"t_1","runId":"r_1"}}\n';

/** How many messages the run builder reconstructed — 0 unexpanded, 1 expanded. */
function messageCount(store: ReturnType<typeof createPanelStore>): number {
  return store.get().runs[0]?.messages.size ?? -1;
}

/** Fire the DevTools network log's "a finished SSE response" event at `observeNetwork`. */
function emitEventStream(): void {
  const event = chrome.devtools.network.onRequestFinished as unknown as {
    emit: (request: unknown) => void;
  };
  event.emit({ response: { content: { mimeType: 'text/event-stream', size: 0 }, headers: [] } });
}

type EvalFn = (expression: string, callback?: (result: unknown) => void) => void;

interface EvalStub {
  /** Answer the marker probe, at the moment the test chooses — the two detectors race. */
  answerProbe: (result: unknown) => void;
}

/** Undo whatever `stubEval` installed, even for a test that failed before restoring it. */
let restoreEval: (() => void) | null = null;
afterEach(() => {
  restoreEval?.();
  restoreEval = null;
});

/**
 * Give `App` an inspected page to talk to.
 *
 * The shared stub in `test-setup.ts` answers every `eval` with `undefined`, which is the honest
 * default for a test with no inspected page. These two paths need one: `location.origin` is
 * answered immediately, and the probe is held so the test can land it before or after a stream.
 */
function stubEval(origin: string): EvalStub {
  const inspected = chrome.devtools.inspectedWindow as unknown as { eval: EvalFn };
  const original = inspected.eval;
  restoreEval = () => {
    inspected.eval = original;
  };
  let pending: ((result: unknown) => void) | undefined;

  inspected.eval = (expression, callback) => {
    if (expression === 'location.origin') {
      callback?.(origin);
      return;
    }
    pending = callback;
  };

  return { answerProbe: (result) => pending?.(result) };
}

function dropOn(target: HTMLElement, name: string, text: string): void {
  fireEvent.drop(target, {
    dataTransfer: {
      files: {
        item: (i: number) => (i === 0 ? new File([text], name, { type: 'text/plain' }) : null),
      },
    },
  });
}

/** The drop target of whichever drop zone is currently on screen. */
function dropTarget(): HTMLElement {
  return screen.getByText(/drop a \.agui\.jsonl capture here/i);
}

describe('App', () => {
  it('renders the three shell bands above the tab body', () => {
    render(<App store={createPanelStore()} />);
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(screen.getByRole('toolbar')).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Current scope' })).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
  });

  /**
   * The shared focus ring is written as `.agui-shell button:focus-visible`. A band rendered
   * outside `.agui-shell` therefore has no visible focus at all — invisible to every gate except
   * a human tabbing through the panel.
   */
  it('wraps the bands in .agui-shell so the shared focus ring applies', () => {
    const { container } = render(<App store={createPanelStore()} />);
    const shell = container.querySelector('.agui-shell');
    expect(shell).not.toBeNull();
    expect(shell?.contains(screen.getByRole('tablist'))).toBe(true);
    expect(shell?.contains(screen.getByRole('toolbar'))).toBe(true);
  });

  it('labels the tab panel with the tab that controls it', () => {
    const store = createPanelStore();
    render(<App store={store} />);
    const panel = screen.getByRole('tabpanel');
    expect(panel.id).toBe(tabPanelId('timeline'));
    expect(panel.getAttribute('aria-labelledby')).toBe('agui-tab-timeline');
    expect(screen.getByRole('tab', { name: 'Timeline' }).getAttribute('aria-controls')).toBe(
      panel.id,
    );

    act(() => {
      store.update((s) => ({ ...s, tab: 'session' }));
    });
    const next = screen.getByRole('tabpanel');
    expect(next.id).toBe(tabPanelId('session'));
    expect(next.getAttribute('aria-labelledby')).toBe('agui-tab-session');
  });

  it('shows the import invitation on Timeline while nothing is loaded', () => {
    render(<App store={createPanelStore()} />);
    expect(screen.getByText(/nothing to inspect yet/i)).toBeTruthy();
    expect(dropTarget()).toBeTruthy();
  });

  it.each<[TabId, RegExp]>([
    ['runs', /Runs — not built yet/],
    ['state', /State — not built yet/],
    ['messages', /Messages — not built yet/],
  ])('names the milestone for the %s placeholder', (tab, heading) => {
    render(<App store={createPanelStore({ ...initialPanelState(), tab })} />);
    expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
    expect(screen.getByText(/milestone 2 of the design §7 sequencing/i)).toBeTruthy();
  });

  it('renders Session on the session tab', () => {
    render(<App store={createPanelStore({ ...initialPanelState(), tab: 'session' })} />);
    expect(screen.getByRole('heading', { name: 'Session' })).toBeTruthy();
  });

  it('renders Timeline once records are loaded', async () => {
    const store = createPanelStore();
    render(<App store={store} />);
    dropOn(dropTarget(), 'happy.agui.jsonl', HAPPY);

    await waitFor(() => expect(store.get().records.length).toBe(2));
    expect(screen.getByRole('listbox', { name: 'Event list' })).toBeTruthy();
    expect(screen.queryByText(/nothing to inspect yet/i)).toBeNull();
  });

  it('surfaces a partial decode persistently, not only inside the drop zone', async () => {
    const store = createPanelStore();
    render(<App store={store} />);

    dropOn(dropTarget(), 'partial.agui.jsonl', `${HAPPY}{ not json\n`);

    await waitFor(() => expect(store.get().source.kind).toBe('imported'));
    // Still visible after leaving the tab the drop zone lived on.
    act(() => {
      store.update((s) => ({ ...s, tab: 'runs' }));
    });
    const alerts = screen.getAllByRole('alert');
    expect(alerts.some((el) => /1 line could not be decoded/i.test(el.textContent ?? ''))).toBe(
      true,
    );
  });

  it('says nothing about a load error when every line decoded', async () => {
    const store = createPanelStore();
    render(<App store={store} />);
    dropOn(dropTarget(), 'happy.agui.jsonl', HAPPY);

    await waitFor(() => expect(store.get().source.kind).toBe('imported'));
    act(() => {
      store.update((s) => ({ ...s, tab: 'runs' }));
    });
    expect(screen.queryAllByRole('alert')).toEqual([]);
  });

  /**
   * `toggleExpandChunks` flips a flag and nothing else — the store's own comment says rebuilding
   * is the caller's job. `App` is that caller, so without this the button would be a control that
   * changes its pressed state and moves nothing on screen.
   */
  it('rebuilds the run model when Expand chunks is toggled', async () => {
    const store = createPanelStore();
    const { container } = render(<App store={store} />);
    const lanes = (): number => container.querySelectorAll('.agui-waterfall__lane').length;
    dropOn(dropTarget(), 'chunked.agui.jsonl', CHUNKED);

    await waitFor(() => expect(store.get().source.kind).toBe('imported'));
    expect(messageCount(store)).toBe(0);
    // Only the run lane: an unexpanded chunk reconstructs no message to chart.
    expect(lanes()).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Expand chunks' }));
    await waitFor(() => expect(store.get().expandChunks).toBe(true));
    await waitFor(() => expect(messageCount(store)).toBe(1));
    // The rebuild reaches the screen, not just the store: a message lane appears.
    expect(lanes()).toBe(2);

    // And back: the toggle is a setting, not a one-way door.
    fireEvent.click(screen.getByRole('button', { name: 'Expand chunks' }));
    await waitFor(() => expect(messageCount(store)).toBe(0));
    expect(lanes()).toBe(1);
  });

  it('leaves the records themselves alone across a rebuild — they are what the wire carried', async () => {
    const store = createPanelStore();
    render(<App store={store} />);
    dropOn(dropTarget(), 'chunked.agui.jsonl', CHUNKED);
    await waitFor(() => expect(store.get().records.length).toBe(3));

    fireEvent.click(screen.getByRole('button', { name: 'Expand chunks' }));
    await waitFor(() => expect(messageCount(store)).toBe(1));
    expect(store.get().records.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('keeps the original import time across an Expand chunks rebuild', async () => {
    const store = createPanelStore();
    render(<App store={store} />);
    dropOn(dropTarget(), 'chunked.agui.jsonl', CHUNKED);

    await waitFor(() => expect(store.get().source.kind).toBe('imported'));
    const before = store.get().source;

    fireEvent.click(screen.getByRole('button', { name: 'Expand chunks' }));
    await waitFor(() => expect(messageCount(store)).toBe(1));
    expect(store.get().source).toEqual(before);
  });

  it('does not resurrect a cleared capture when Expand chunks is toggled', async () => {
    const store = createPanelStore();
    render(<App store={store} />);
    dropOn(dropTarget(), 'chunked.agui.jsonl', CHUNKED);
    await waitFor(() => expect(store.get().records.length).toBe(3));

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(store.get().records.length).toBe(0));

    fireEvent.click(screen.getByRole('button', { name: 'Expand chunks' }));
    await waitFor(() => expect(store.get().expandChunks).toBe(true));
    expect(store.get().records).toEqual([]);
    expect(store.get().source.kind).toBe('empty');
  });

  it('retains an import made from the Session tab, so Expand chunks still rebuilds', async () => {
    const store = createPanelStore({ ...initialPanelState(), tab: 'session' });
    render(<App store={store} />);
    dropOn(dropTarget(), 'chunked.agui.jsonl', CHUNKED);
    await waitFor(() => expect(store.get().records.length).toBe(3));

    fireEvent.click(screen.getByRole('button', { name: 'Expand chunks' }));
    await waitFor(() => expect(messageCount(store)).toBe(1));
  });

  it('says so when there is no chrome.permissions to grant through', async () => {
    // No `chrome.permissions` in the default stub, which is the panel HTML opened outside
    // DevTools. Enable must still say what happened rather than doing nothing visible.
    const store = createPanelStore({
      ...initialPanelState(),
      capture: { kind: 'off', origin: 'https://app.example', signal: { level: 'stream' } },
    });
    render(<App store={store} />);
    fireEvent.click(screen.getByRole('button', { name: /enable capture for/i }));
    expect(await screen.findByText(/not running inside DevTools/i)).toBeTruthy();
    expect(store.get().capture.kind).toBe('off');
  });

  it('raises the signal to stream when the network observer sees one, offering Enable throughout', () => {
    const store = createPanelStore({
      ...initialPanelState(),
      capture: { kind: 'off', origin: 'https://app.example', signal: { level: 'none' } },
    });
    render(<App store={store} />);
    expect(screen.getByRole('button', { name: /enable capture for/i })).toBeTruthy();

    act(() => {
      emitEventStream();
    });

    expect(store.get().capture).toEqual({
      kind: 'off',
      origin: 'https://app.example',
      signal: { level: 'stream' },
    });
    expect(screen.getByText(/event stream was seen/i)).toBeTruthy();
  });

  it('records the framework label the page probe reports, on the Session tab', async () => {
    const stub = stubEval('https://app.example');
    const store = createPanelStore({ ...initialPanelState(), tab: 'session' });
    render(<App store={store} />);

    expect(store.get().capture).toEqual({
      kind: 'off',
      origin: 'https://app.example',
      signal: { level: 'none' },
    });

    await act(async () => {
      stub.answerProbe('21.1.6');
    });

    expect(store.get().framework).toBe('Angular 21.1.6');
    expect(screen.getByText('Angular 21.1.6')).toBeTruthy();
  });

  /*
   * Requirements §4.3, enforced end to end: the fingerprint labels the session, never gates
   * capture.
   *
   * AG-UI is a wire protocol and specifies nothing in the DOM, so no page markup — a framework
   * attribute least of all — can support a claim about whether this origin speaks AG-UI. The
   * probe must therefore leave the capture signal exactly where it found it, whichever order the
   * two land in.
   */
  it('never lets the framework probe touch the capture signal', async () => {
    const stub = stubEval('https://app.example');
    const store = createPanelStore();
    render(<App store={store} />);

    act(() => {
      emitEventStream();
    });
    const afterStream = store.get().capture;
    expect(afterStream).toEqual({
      kind: 'off',
      origin: 'https://app.example',
      signal: { level: 'stream' },
    });

    await act(async () => {
      stub.answerProbe('21.1.6');
    });

    expect(store.get().capture).toBe(afterStream);
    expect(store.get().framework).toBe('Angular 21.1.6');
    expect(screen.getByText(/event stream was seen/i)).toBeTruthy();
  });

  it('leaves capture unsupported when there is no inspected window to ask', () => {
    const store = createPanelStore();
    render(<App store={store} />);
    expect(store.get().capture).toEqual({ kind: 'unsupported' });
    expect(screen.getByText(/only runs inside the DevTools panel/i)).toBeTruthy();
  });
});
