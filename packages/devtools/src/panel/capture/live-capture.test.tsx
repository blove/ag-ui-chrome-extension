import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/preact';
import { App } from '../app';
import type { AguiEvent, CaptureRecord } from '../../core/model/types';
import type { PanelCommand, RequestLine, SwMessage } from '../../sw/protocol';
import { createPanelStore } from '../model/store';

/* ------------------------------------------------------------------ fakes */

type Listener<T> = (value: T) => void;

interface FakePort {
  readonly posted: PanelCommand[];
  connected: boolean;
  /** Push a message as if the service worker had sent it. */
  emit: (message: SwMessage) => void;
  /** Drop the port as if the worker had gone away. */
  drop: () => void;
  postMessage: (command: PanelCommand) => void;
  disconnect: () => void;
  onMessage: {
    addListener: (listener: Listener<unknown>) => void;
    removeListener: (listener: Listener<unknown>) => void;
  };
  onDisconnect: {
    addListener: (listener: Listener<void>) => void;
    removeListener: (listener: Listener<void>) => void;
  };
}

function createFakePort(): FakePort {
  const messageListeners = new Set<Listener<unknown>>();
  const disconnectListeners = new Set<Listener<void>>();
  const posted: PanelCommand[] = [];
  const port: FakePort = {
    posted,
    connected: true,
    emit: (message) => {
      for (const listener of [...messageListeners]) listener(message);
    },
    drop: () => {
      port.connected = false;
      for (const listener of [...disconnectListeners]) listener();
    },
    postMessage: (command) => {
      posted.push(command);
    },
    disconnect: () => {
      port.connected = false;
    },
    onMessage: {
      addListener: (listener) => {
        messageListeners.add(listener);
      },
      removeListener: (listener) => {
        messageListeners.delete(listener);
      },
    },
    onDisconnect: {
      addListener: (listener) => {
        disconnectListeners.add(listener);
      },
      removeListener: (listener) => {
        disconnectListeners.delete(listener);
      },
    },
  };
  return port;
}

interface RuntimeWithConnect {
  connect?: (info: { name: string }) => unknown;
}

/** Install a fake port factory and return the port every `connect` hands back. */
function stubPort(): { port: FakePort; names: string[] } {
  const port = createFakePort();
  const names: string[] = [];
  (chrome.runtime as unknown as RuntimeWithConnect).connect = (info) => {
    names.push(info.name);
    return port;
  };
  return { port, names };
}

interface PermissionsStub {
  request: (p: { origins: string[] }) => Promise<boolean>;
  contains: (p: { origins: string[] }) => Promise<boolean>;
}

function stubPermissions(stub: Partial<PermissionsStub>): { requested: string[][] } {
  const requested: string[][] = [];
  const permissions: PermissionsStub = {
    request: async (p) => {
      requested.push(p.origins);
      return (await stub.request?.(p)) ?? false;
    },
    contains: async (p) => (await stub.contains?.(p)) ?? false,
  };
  (chrome as unknown as { permissions?: PermissionsStub }).permissions = permissions;
  return { requested };
}

/** Answer `location.origin` with `origin`, and every other probe with undefined. */
function stubOrigin(origin: string): void {
  chrome.devtools.inspectedWindow.eval = ((
    expression: string,
    callback?: (result: unknown) => void,
  ) => {
    callback?.(expression === 'location.origin' ? origin : undefined);
  }) as typeof chrome.devtools.inspectedWindow.eval;
}

interface NavigatedStub {
  emit: (url: string) => void;
}

function navigated(): NavigatedStub {
  return chrome.devtools.network.onNavigated as unknown as NavigatedStub;
}

afterEach(() => {
  delete (chrome.runtime as unknown as RuntimeWithConnect).connect;
  delete (chrome as unknown as { permissions?: PermissionsStub }).permissions;
});

/* --------------------------------------------------------------- fixtures */

function eventRecord(seq: number, event: AguiEvent, tMs = seq * 10): CaptureRecord {
  return { kind: 'event', seq, tMs, connId: 'c1', raw: event, event, issues: [] };
}

const REQUEST: RequestLine = {
  connId: 'c1',
  tMs: 0,
  method: 'POST',
  url: 'http://localhost:5173/agent',
  input: { threadId: 't1', runId: 'r1', messages: [], tools: [], context: [], state: {} },
};

const RUN_STARTED = eventRecord(0, { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' });
const TEXT_START = eventRecord(1, {
  type: 'TEXT_MESSAGE_START',
  messageId: 'm1',
  role: 'assistant',
});
const TEXT_CONTENT = eventRecord(2, {
  type: 'TEXT_MESSAGE_CONTENT',
  messageId: 'm1',
  delta: 'hello',
});

/* ------------------------------------------------------------------ tests */

describe('panel live wiring', () => {
  it('auto-enables a localhost origin and subscribes with the inspected tab id', async () => {
    stubOrigin('http://localhost:5173');
    const { port, names } = stubPort();
    const store = createPanelStore();

    render(<App store={store} />);

    await waitFor(() => {
      expect(names).toEqual(['agui-devtools-panel']);
    });
    expect(port.posted[0]).toEqual({ kind: 'subscribe', tabId: 1 });
    expect(store.get().capture).toEqual({ kind: 'on', origin: 'http://localhost:5173' });
    expect(await screen.findByText('Capture is on for http://localhost:5173.')).toBeTruthy();
  });

  it('renders a snapshot and then tails appended records', async () => {
    stubOrigin('http://localhost:5173');
    const { port } = stubPort();
    const store = createPanelStore();

    render(<App store={store} />);
    await waitFor(() => {
      expect(port.posted).toHaveLength(1);
    });

    act(() => {
      port.emit({
        kind: 'snapshot',
        records: [RUN_STARTED, TEXT_START],
        requests: [REQUEST],
        droppedBefore: 0,
      });
    });

    expect(await screen.findByRole('option', { name: /seq 0 RUN_STARTED/ })).toBeTruthy();

    act(() => {
      port.emit({ kind: 'append', records: [TEXT_CONTENT] });
    });

    expect(await screen.findByRole('option', { name: /seq 2 TEXT_MESSAGE_CONTENT/ })).toBeTruthy();
    expect(store.get().source).toEqual({ kind: 'live', origin: 'http://localhost:5173' });
  });

  it("surfaces the worker's eviction count in the toolbar (P9)", async () => {
    stubOrigin('http://localhost:5173');
    const { port } = stubPort();
    const store = createPanelStore();

    render(<App store={store} />);
    await waitFor(() => {
      expect(port.posted).toHaveLength(1);
    });

    act(() => {
      port.emit({
        kind: 'snapshot',
        records: [RUN_STARTED],
        requests: [REQUEST],
        droppedBefore: 12,
      });
    });

    expect(await screen.findByText('12 dropped')).toBeTruthy();
  });

  /* C4: eviction that begins AFTER the snapshot must still reach the toolbar. */
  it('updates the eviction count from an append, not just the snapshot (P9, C4)', async () => {
    stubOrigin('http://localhost:5173');
    const { port } = stubPort();
    const store = createPanelStore();

    render(<App store={store} />);
    await waitFor(() => {
      expect(port.posted).toHaveLength(1);
    });

    act(() => {
      port.emit({ kind: 'snapshot', records: [RUN_STARTED], requests: [REQUEST], droppedBefore: 0 });
    });
    expect(screen.queryByText(/dropped/)).toBeNull();

    act(() => {
      port.emit({ kind: 'append', records: [TEXT_START], droppedBefore: 31 });
    });

    expect(await screen.findByText('31 dropped')).toBeTruthy();
  });

  /* C3 / §5.4: an undecodable transport must be named, never left as an empty capture. */
  it('labels a binary transport instead of showing an empty capture', async () => {
    stubOrigin('http://localhost:5173');
    const { port } = stubPort();
    const store = createPanelStore();

    render(<App store={store} />);
    await waitFor(() => {
      expect(port.posted).toHaveLength(1);
    });

    act(() => {
      port.emit({
        kind: 'binary',
        connId: 'c1',
        tMs: 5,
        contentType: 'application/vnd.ag-ui.event+proto',
        bytes: 128,
      });
    });

    expect(await screen.findByText(/binary transport/i)).toBeTruthy();
    expect(store.get().binaryTransport?.bytes).toBe(128);
    expect(store.get().records).toEqual([]);
  });

  it('activates record/pause and tells the worker', async () => {
    stubOrigin('http://localhost:5173');
    const { port } = stubPort();
    const store = createPanelStore();

    render(<App store={store} />);
    const pause = await screen.findByRole('button', { name: 'Pause' });
    expect(pause.hasAttribute('disabled')).toBe(false);
    expect(pause.getAttribute('aria-pressed')).toBe('true');

    pause.click();

    await waitFor(() => {
      expect(port.posted).toContainEqual({ kind: 'set-recording', recording: false });
    });
    expect(store.get().recording).toBe(false);
    expect(await screen.findByRole('button', { name: 'Record' })).toBeTruthy();
  });

  it('clears the worker buffer when the page navigates, unless preserve is on', async () => {
    stubOrigin('http://localhost:5173');
    const { port } = stubPort();
    const store = createPanelStore();

    render(<App store={store} />);
    await waitFor(() => {
      expect(port.posted).toHaveLength(1);
    });

    act(() => {
      navigated().emit('http://localhost:5173/next');
    });
    expect(port.posted).toContainEqual({ kind: 'clear' });

    const preserve = await screen.findByRole('button', { name: 'Preserve log on navigate' });
    expect(preserve.hasAttribute('disabled')).toBe(false);
    preserve.click();
    await waitFor(() => {
      expect(store.get().preserveLog).toBe(true);
    });

    const before = port.posted.filter((command) => command.kind === 'clear').length;
    act(() => {
      navigated().emit('http://localhost:5173/again');
    });
    expect(port.posted.filter((command) => command.kind === 'clear')).toHaveLength(before);
  });

  it('requests the origin grant from Enable and then offers the reload', async () => {
    stubOrigin('https://app.example.com');
    stubPort();
    const { requested } = stubPermissions({ request: async () => true });
    const store = createPanelStore();

    render(<App store={store} />);

    const enable = await screen.findByRole('button', {
      name: 'Enable capture for https://app.example.com',
    });
    enable.click();

    await waitFor(() => {
      expect(requested).toEqual([['https://app.example.com/*']]);
    });
    expect(store.get().capture).toEqual({ kind: 'on', origin: 'https://app.example.com' });

    const reload = await screen.findByRole('button', { name: 'Reload the inspected page' });
    const spy = vi.spyOn(chrome.devtools.inspectedWindow, 'reload');
    reload.click();
    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    spy.mockRestore();
  });

  it('says so when the grant is declined', async () => {
    stubOrigin('https://app.example.com');
    stubPort();
    stubPermissions({ request: async () => false });
    const store = createPanelStore();

    render(<App store={store} />);
    const enable = await screen.findByRole('button', {
      name: 'Enable capture for https://app.example.com',
    });
    enable.click();

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('Access to this origin was declined'),
    );
    expect(store.get().capture.kind).toBe('off');
  });

  it('auto-enables an origin that was already granted', async () => {
    stubOrigin('https://app.example.com');
    const { names } = stubPort();
    stubPermissions({ contains: async () => true });
    const store = createPanelStore();

    render(<App store={store} />);

    await waitFor(() => {
      expect(store.get().capture).toEqual({ kind: 'on', origin: 'https://app.example.com' });
    });
    // The port opens in the effect that the capture change schedules, one commit later.
    await waitFor(() => {
      expect(names).toEqual(['agui-devtools-panel']);
    });
  });

  it('drops a malformed port message instead of folding it', async () => {
    stubOrigin('http://localhost:5173');
    const { port } = stubPort();
    const store = createPanelStore();

    render(<App store={store} />);
    await waitFor(() => {
      expect(port.posted).toHaveLength(1);
    });

    act(() => {
      port.emit({ kind: 'not-a-kind' } as unknown as SwMessage);
      port.emit(null as unknown as SwMessage);
    });

    expect(store.get().records).toEqual([]);
    expect(store.get().loadError).toBeNull();
  });

  /*
   * The panel must not resume by dumping everything it missed. The worker forgets a paused
   * panel on every reconnection, so the state has to be re-stated on the new port — otherwise
   * a worker restart silently un-pauses a capture the user paused.
   */
  it('re-states a paused capture on a fresh port', async () => {
    stubOrigin('http://localhost:5173');
    const first = stubPort();
    const store = createPanelStore();

    const view = render(<App store={store} />);
    const pause = await screen.findByRole('button', { name: 'Pause' });
    pause.click();
    await waitFor(() => {
      expect(store.get().recording).toBe(false);
    });

    view.unmount();
    const second = stubPort();
    render(<App store={store} />);

    await waitFor(() => {
      expect(second.port.posted).toContainEqual({ kind: 'set-recording', recording: false });
    });
    expect(second.port.posted[0]).toEqual({ kind: 'subscribe', tabId: 1 });
    expect(first.port.connected).toBe(false);
  });

  /* P6: `VirtualList.follow` has existed and never been set. Live tailing is what it was for. */
  it('tails a live capture and not an imported one (P6)', async () => {
    stubOrigin('http://localhost:5173');
    const { port } = stubPort();
    const store = createPanelStore();

    render(<App store={store} />);
    await waitFor(() => {
      expect(port.posted).toHaveLength(1);
    });

    const records = Array.from({ length: 400 }, (_, i) =>
      eventRecord(i, { type: 'CUSTOM', name: 'n', value: i }),
    );
    act(() => {
      port.emit({ kind: 'snapshot', records, requests: [REQUEST], droppedBefore: 0 });
    });

    // Following means the window has moved to the tail: the last row is rendered, the first is
    // not. Without `follow` a virtualized list stays pinned at the top and shows seq 0.
    expect(await screen.findByRole('option', { name: /seq 399 CUSTOM/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /seq 0 CUSTOM/ })).toBeNull();
  });
});
