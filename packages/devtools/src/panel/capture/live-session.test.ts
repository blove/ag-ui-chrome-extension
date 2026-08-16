import { describe, expect, it } from 'vitest';
import type { AguiEvent, CaptureRecord } from '../../core/model/types';
import type { RequestLine, SwMessage } from '../../sw/protocol';
import { initialPanelState } from '../model/panel-types';
import { createLiveSession } from './live-session';

let nextSeq = 0;

function record(event: AguiEvent, connId = 'c1', tMs = nextSeq * 10): CaptureRecord {
  const seq = nextSeq++;
  return { kind: 'event', seq, tMs, connId, raw: event, event, issues: [] };
}

function requestLine(connId = 'c1'): RequestLine {
  return {
    connId,
    tMs: 0,
    method: 'POST',
    url: 'http://localhost:5173/agent',
    input: { threadId: 't1', runId: 'r1', messages: [], tools: [], context: [], state: {} },
  };
}

function happyRun(connId = 'c1'): CaptureRecord[] {
  nextSeq = 0;
  return [
    record({ type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }, connId),
    record({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }, connId),
    record({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'hi' }, connId),
    record({ type: 'TEXT_MESSAGE_END', messageId: 'm1' }, connId),
    record({ type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' }, connId),
  ];
}

describe('createLiveSession', () => {
  it('folds a snapshot into runs, records and issues', () => {
    const session = createLiveSession();
    const records = happyRun();

    const next = session.apply(initialPanelState(), {
      kind: 'snapshot',
      records,
      requests: [requestLine()],
      closed: [],
      droppedBefore: 0,
      loaded: true,
      info: null,
      registration: { matches: [], error: null },
    });

    expect(next.records).toHaveLength(5);
    expect(next.runs).toHaveLength(1);
    expect(next.runs[0]?.runId).toBe('r1');
    expect(next.issues).toEqual([]);
  });

  it('appends onto an existing fold without replaying it', () => {
    const session = createLiveSession();
    const records = happyRun();
    const head = records.slice(0, 2);
    const tail = records.slice(2);

    let state = session.apply(initialPanelState(), {
      kind: 'snapshot',
      records: head,
      requests: [requestLine()],
      closed: [],
      droppedBefore: 0,
      loaded: true,
      info: null,
      registration: { matches: [], error: null },
    });
    state = session.apply(state, { kind: 'append', records: tail });

    expect(state.records.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]?.outcome).toBe('finished');
  });

  it('carries the request through, so a run is not reported as input-less', () => {
    const withRequest = createLiveSession();
    const withoutRequest = createLiveSession();
    const records = happyRun();

    const a = withRequest.apply(initialPanelState(), { kind: 'request', request: requestLine() });
    const withInput = withRequest.apply(a, { kind: 'append', records });
    const withoutInput = withoutRequest.apply(initialPanelState(), {
      kind: 'append',
      records: happyRun(),
    });

    expect(withInput.issues.map((issue) => issue.code)).not.toContain('run-started-without-input');
    expect(withoutInput.issues.map((issue) => issue.code)).toContain('run-started-without-input');
  });

  it('finalizes on closed, so an unterminated run reports it', () => {
    const session = createLiveSession();
    nextSeq = 0;
    const records = [
      record({ type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }),
      record({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }),
    ];

    let state = session.apply(initialPanelState(), { kind: 'request', request: requestLine() });
    state = session.apply(state, { kind: 'append', records });
    expect(state.issues.map((issue) => issue.code)).not.toContain('run-never-terminated');

    state = session.apply(state, { kind: 'closed', connId: 'c1', tMs: 99 });
    expect(state.issues.map((issue) => issue.code)).toContain('run-never-terminated');
  });

  /**
   * The same finalisation, for the panel that was NOT there when the close went out.
   *
   * A `closed` message is delivered to whoever is subscribed at the time. A panel opened after
   * the run gets one `snapshot` and nothing else, so unless the snapshot carries the closes it
   * finalises nothing — the run sits in `outcome: 'running'` and every run-end issue is silently
   * absent. `panel/capture/late-panel-parity.test.ts` holds that against the import path.
   */
  it('finalizes from a snapshot too, for a panel that opened after the run', () => {
    const session = createLiveSession();
    nextSeq = 0;
    const records = [
      record({ type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }),
      record({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }),
    ];

    const state = session.apply(initialPanelState(), {
      kind: 'snapshot',
      records,
      requests: [requestLine()],
      closed: [{ connId: 'c1', tMs: 99 }],
      droppedBefore: 0,
      loaded: true,
      info: null,
      registration: { matches: [], error: null },
    });

    expect(state.issues.map((issue) => issue.code)).toContain('run-never-terminated');
    // Anchored at the close the worker reported, never at a time this fold chose for itself.
    expect(state.issues.find((issue) => issue.code === 'run-never-terminated')?.tMs).toBe(99);
    expect(state.runs[0]?.outcome).toBe('aborted');
  });

  it('leaves a still-open connection open when the snapshot lists no close for it', () => {
    // The negative half, and the reason `closed` is a list rather than a flag: a snapshot taken
    // mid-run must not finalise anything, or a live capture would report `run-never-terminated`
    // about a run that is still going.
    const session = createLiveSession();
    nextSeq = 0;
    const records = [record({ type: 'RUN_STARTED', threadId: 't1', runId: 'r1' })];

    const state = session.apply(initialPanelState(), {
      kind: 'snapshot',
      records,
      requests: [requestLine()],
      closed: [],
      droppedBefore: 0,
      loaded: true,
      info: null,
      registration: { matches: [], error: null },
    });

    expect(state.issues.map((issue) => issue.code)).not.toContain('run-never-terminated');
    expect(state.runs[0]?.outcome).toBe('running');
  });

  it('replaces the closes on a new snapshot, which is a new dataset', () => {
    // A snapshot replaces everything, closes included. Carrying a previous one over would
    // finalise a connection the new dataset may not even contain.
    const session = createLiveSession();
    nextSeq = 0;
    const first = [record({ type: 'RUN_STARTED', threadId: 't1', runId: 'r1' })];
    let state = session.apply(initialPanelState(), {
      kind: 'snapshot',
      records: first,
      requests: [requestLine()],
      closed: [{ connId: 'c1', tMs: 50 }],
      droppedBefore: 0,
      loaded: true,
      info: null,
      registration: { matches: [], error: null },
    });
    expect(state.runs[0]?.outcome).toBe('aborted');

    nextSeq = 0;
    const second = [record({ type: 'RUN_STARTED', threadId: 't2', runId: 'r2' }, 'c2')];
    state = session.apply(state, {
      kind: 'snapshot',
      records: second,
      requests: [requestLine('c2')],
      closed: [],
      droppedBefore: 0,
      loaded: true,
      info: null,
      registration: { matches: [], error: null },
    });

    expect(state.runs.map((run) => run.runId)).toEqual(['r2']);
    expect(state.runs[0]?.outcome).toBe('running');
  });

  it('counts its own eviction into droppedBefore (P9)', () => {
    const session = createLiveSession({ maxRecords: 3 });
    const records = happyRun();

    const state = session.apply(initialPanelState(), {
      kind: 'snapshot',
      records,
      requests: [requestLine()],
      closed: [],
      droppedBefore: 0,
      loaded: true,
      info: null,
      registration: { matches: [], error: null },
    });

    expect(state.records.map((r) => r.seq)).toEqual([2, 3, 4]);
    expect(state.droppedBefore).toBe(2);
  });

  it("adds the worker's own eviction count to its own", () => {
    const session = createLiveSession({ maxRecords: 3 });
    const state = session.apply(initialPanelState(), {
      kind: 'snapshot',
      records: happyRun(),
      requests: [requestLine()],
      closed: [],
      droppedBefore: 7,
      loaded: true,
      info: null,
      registration: { matches: [], error: null },
    });

    expect(state.droppedBefore).toBe(9);
  });

  /*
   * C4: `append` carries the worker's eviction count too. Eviction happens DURING a long
   * session, so a count that only ever arrived with the initial snapshot would be permanently
   * stale by the time P9's marker mattered.
   */
  it("tracks the worker's eviction count as it moves on append", () => {
    const session = createLiveSession();
    let state = session.apply(initialPanelState(), {
      kind: 'snapshot',
      records: happyRun(),
      requests: [requestLine()],
      closed: [],
      droppedBefore: 0,
      loaded: true,
      info: null,
      registration: { matches: [], error: null },
    });
    expect(state.droppedBefore).toBe(0);

    nextSeq = 5;
    state = session.apply(state, {
      kind: 'append',
      records: [record({ type: 'CUSTOM', name: 'x', value: 1 })],
      droppedBefore: 4,
    });

    expect(state.droppedBefore).toBe(4);
  });

  it('keeps the last reported worker count when an append omits it', () => {
    const session = createLiveSession();
    let state = session.apply(initialPanelState(), {
      kind: 'snapshot',
      records: happyRun(),
      requests: [requestLine()],
      closed: [],
      droppedBefore: 6,
      loaded: true,
      info: null,
      registration: { matches: [], error: null },
    });
    nextSeq = 5;
    state = session.apply(state, {
      kind: 'append',
      records: [record({ type: 'CUSTOM', name: 'x', value: 1 })],
    });

    expect(state.droppedBefore).toBe(6);
  });

  it('adds panel eviction on top of a moving worker count', () => {
    const session = createLiveSession({ maxRecords: 3 });
    let state = session.apply(initialPanelState(), {
      kind: 'snapshot',
      records: happyRun(),
      requests: [requestLine()],
      closed: [],
      droppedBefore: 0,
      loaded: true,
      info: null,
      registration: { matches: [], error: null },
    });
    // Two evicted by the panel already.
    expect(state.droppedBefore).toBe(2);

    nextSeq = 5;
    state = session.apply(state, {
      kind: 'append',
      records: [record({ type: 'CUSTOM', name: 'x', value: 1 })],
      droppedBefore: 10,
    });

    expect(state.records.map((r) => r.seq)).toEqual([3, 4, 5]);
    expect(state.droppedBefore).toBe(13);
  });

  it('empties everything on cleared', () => {
    const session = createLiveSession();
    let state = session.apply(initialPanelState(), {
      kind: 'snapshot',
      records: happyRun(),
      requests: [requestLine()],
      closed: [],
      droppedBefore: 4,
      loaded: true,
      info: null,
      registration: { matches: [], error: null },
    });
    state = { ...state, selectedSeq: 2, scope: 'r1' };

    state = session.apply(state, { kind: 'cleared' });

    expect(state.records).toEqual([]);
    expect(state.runs).toEqual([]);
    expect(state.issues).toEqual([]);
    expect(state.droppedBefore).toBe(0);
    expect(state.selectedSeq).toBeNull();
    expect(state.scope).toBeNull();
  });

  it('re-folds under a new expandChunks without losing the request', () => {
    const session = createLiveSession({ expandChunks: false });
    nextSeq = 0;
    const records = [
      record({ type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }),
      record({ type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', role: 'assistant', delta: 'hi' }),
      record({ type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' }),
    ];

    let state = session.apply(initialPanelState(), {
      kind: 'snapshot',
      records,
      requests: [requestLine()],
      closed: [],
      droppedBefore: 0,
      loaded: true,
      info: null,
      registration: { matches: [], error: null },
    });
    state = session.apply(state, { kind: 'closed', connId: 'c1', tMs: 40 });
    const before = state.issues.map((issue) => issue.code);

    const after = session.refold(state, { expandChunks: true });

    expect(after.records.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(after.runs).toHaveLength(1);
    // A re-fold must not invent an issue the same capture did not have a moment earlier.
    expect(after.issues.map((issue) => issue.code)).not.toContain('run-started-without-input');
    expect(after.issues.map((issue) => issue.code)).not.toContain('run-never-terminated');
    expect(before).not.toContain('run-started-without-input');
  });

  /**
   * The announcement, folded into state and NOWHERE ELSE.
   *
   * It is extension-internal state about our own capture layer. The Timeline claims to show AG-UI
   * protocol events reconstructed from the wire, so a row for this would make the panel assert
   * something false about the user's application — and it would take a `seq`, moving every anchor
   * the validator reports issues against.
   */
  describe('instrumentation', () => {
    it('records that the page reported its hooks, without producing anything to show', () => {
      const session = createLiveSession();
      const start = { ...initialPanelState(), loaded: null };

      const state = session.apply(start, { kind: 'capture-loaded' });

      expect(state.loaded).toBe(true);
      expect(state.records).toEqual([]);
      expect(state.runs).toEqual([]);
      expect(state.issues).toEqual([]);
    });

    it('leaves seq numbering exactly where it was', () => {
      const session = createLiveSession();
      const records = happyRun();
      let state = session.apply(initialPanelState(), {
        kind: 'snapshot',
        records,
        requests: [requestLine()],
        closed: [],
        droppedBefore: 0,
        loaded: false,
        info: null,
        registration: { matches: [], error: null },
      });
      const before = state.records.map((r) => r.seq);

      state = session.apply(state, { kind: 'capture-loaded' });

      expect(state.records.map((r) => r.seq)).toEqual(before);
      expect(state.runs).toHaveLength(1);
    });

    it('takes instrumentation from a snapshot, which is how a late panel learns it', () => {
      const session = createLiveSession();

      const state = session.apply(
        { ...initialPanelState(), loaded: null },
        {
          kind: 'snapshot',
          records: [],
          requests: [],
          closed: [],
          droppedBefore: 0,
          loaded: true,
          info: null,
          registration: { matches: [], error: null },
        },
      );

      expect(state.loaded).toBe(true);
    });

    it('never reads a snapshot as proof that the capture layer is NOT loaded', () => {
      const session = createLiveSession();

      // A snapshot arrives the instant the panel subscribes, which on a page that is still
      // loading is before any announcement is due. `false` here means "nothing reported YET",
      // and treating it as a finding is exactly the false warning the grace period exists to
      // prevent — the finding is made by the timeout in `use-live-capture`, never here.
      const fresh = session.apply(
        { ...initialPanelState(), loaded: null },
        { kind: 'snapshot', records: [], requests: [], closed: [], droppedBefore: 0, loaded: false, info: null, registration: { matches: [], error: null } },
      );
      expect(fresh.loaded).toBeNull();

      const known = session.apply(
        { ...initialPanelState(), loaded: true },
        { kind: 'snapshot', records: [], requests: [], closed: [], droppedBefore: 0, loaded: false, info: null, registration: { matches: [], error: null } },
      );
      expect(known.loaded).toBe(true);
    });

    it('survives a clear, which empties data and uninstalls nothing', () => {
      const session = createLiveSession();
      const state = session.apply(
        { ...initialPanelState(), loaded: true },
        { kind: 'cleared' },
      );

      expect(state.loaded).toBe(true);
      expect(state.records).toEqual([]);
    });
  });

  it('drops a selection that a new snapshot may not contain', () => {
    const session = createLiveSession();
    const state = session.apply(
      { ...initialPanelState(), selectedSeq: 99, scope: 'r_old' },
      {
        kind: 'snapshot',
        records: happyRun(),
        requests: [requestLine()],
        closed: [],
        droppedBefore: 0,
        loaded: true,
        info: null,
        registration: { matches: [], error: null },
      },
    );

    expect(state.selectedSeq).toBeNull();
    expect(state.scope).toBeNull();
  });

  /*
   * C3 / requirements §5.4. A binary connection produces no records at all, so a fold that
   * ignored this arm would leave a protobuf stream looking exactly like a capture that saw
   * nothing — which §15 names as the failure mode to avoid.
   */
  describe('binary transport', () => {
    it('labels the transport instead of folding a record', () => {
      const session = createLiveSession();
      const state = session.apply(initialPanelState(), {
        kind: 'binary',
        connId: 'c9',
        tMs: 12,
        contentType: 'application/vnd.ag-ui.event+proto',
        bytes: 4096,
      });

      expect(state.records).toEqual([]);
      expect(state.binaryTransport).toEqual({
        connId: 'c9',
        tMs: 12,
        contentType: 'application/vnd.ag-ui.event+proto',
        bytes: 4096,
      });
    });

    it('accumulates bytes across notices for the same connection', () => {
      const session = createLiveSession();
      let state = session.apply(initialPanelState(), {
        kind: 'binary',
        connId: 'c9',
        tMs: 12,
        contentType: 'application/vnd.ag-ui.event+proto',
        bytes: 10,
      });
      state = session.apply(state, {
        kind: 'binary',
        connId: 'c9',
        tMs: 30,
        contentType: 'application/vnd.ag-ui.event+proto',
        bytes: 32,
      });

      expect(state.binaryTransport?.bytes).toBe(42);
      expect(state.binaryTransport?.tMs).toBe(12);
    });

    it('starts over for a new connection rather than mixing two transports', () => {
      const session = createLiveSession();
      let state = session.apply(initialPanelState(), {
        kind: 'binary',
        connId: 'c9',
        tMs: 12,
        contentType: 'application/vnd.ag-ui.event+proto',
        bytes: 10,
      });
      state = session.apply(state, {
        kind: 'binary',
        connId: 'c10',
        tMs: 90,
        contentType: 'application/octet-stream',
        bytes: 7,
      });

      expect(state.binaryTransport).toEqual({
        connId: 'c10',
        tMs: 90,
        contentType: 'application/octet-stream',
        bytes: 7,
      });
    });

    it('forgets the transport on cleared', () => {
      const session = createLiveSession();
      let state = session.apply(initialPanelState(), {
        kind: 'binary',
        connId: 'c9',
        tMs: 12,
        contentType: 'application/vnd.ag-ui.event+proto',
        bytes: 10,
      });
      state = session.apply(state, { kind: 'cleared' });

      expect(state.binaryTransport).toBeNull();
    });

    it('keeps the label across a snapshot replay, since the connection is still binary', () => {
      const session = createLiveSession();
      let state = session.apply(initialPanelState(), {
        kind: 'binary',
        connId: 'c9',
        tMs: 12,
        contentType: 'application/vnd.ag-ui.event+proto',
        bytes: 10,
      });
      // A reconnect replays the buffer, which never held the binary notice — dropping the label
      // here would un-explain an empty capture the moment the panel reconnected.
      state = session.apply(state, {
        kind: 'snapshot',
        records: [],
        requests: [],
        closed: [],
        droppedBefore: 0,
        loaded: true,
        info: null,
        registration: { matches: [], error: null },
      });

      expect(state.binaryTransport?.contentType).toBe('application/vnd.ag-ui.event+proto');
    });
  });
});

describe('the request lines an export has to put back', () => {
  it('projects the request lines onto panel state, not only into the fold', () => {
    // Export re-encodes from what `PanelState` holds. The fold keeps the request lines so it can
    // refold; without them on the state as well, a live capture would export a run whose
    // RunAgentInput was gone and re-import as `run-started-without-input`.
    const session = createLiveSession();

    const state = session.apply(initialPanelState(), {
      kind: 'request',
      request: requestLine(),
    });

    expect(state.requests).toEqual([requestLine()]);
  });

  it('replaces them on a snapshot, which is a new dataset', () => {
    const session = createLiveSession();

    let state = session.apply(initialPanelState(), { kind: 'request', request: requestLine('c9') });
    state = session.apply(state, {
      kind: 'snapshot',
      records: happyRun(),
      requests: [requestLine('c1')],
      closed: [],
      droppedBefore: 0,
      loaded: true,
      info: null,
      registration: { matches: [], error: null },
    });

    expect(state.requests.map((request) => request.connId)).toEqual(['c1']);
  });

  it('drops them on cleared, along with everything else the user asked to be rid of', () => {
    const session = createLiveSession();

    let state = session.apply(initialPanelState(), { kind: 'request', request: requestLine() });
    state = session.apply(state, { kind: 'cleared' });

    expect(state.requests).toEqual([]);
  });

  it('keeps them across a refold, so Expand chunks does not lose the run input', () => {
    const session = createLiveSession();

    let state = session.apply(initialPanelState(), { kind: 'request', request: requestLine() });
    state = session.apply(state, { kind: 'append', records: happyRun() });
    state = session.refold(state, { expandChunks: false });

    expect(state.requests).toEqual([requestLine()]);
  });
});

/**
 * `/info` agent discovery through the fold (spec §13 done-when #2).
 *
 * Two delivery routes, and the second is the one that matters: a panel is normally opened after
 * the client has already connected, so the SNAPSHOT is how this fact usually arrives.
 */
describe('createLiveSession — /info agent discovery', () => {
  const RUNTIME = {
    version: '1.52.1-next.1',
    mode: 'multi-route' as const,
    agents: [
      { id: 'a2ui_chat', name: 'a2ui_chat', description: '' },
      { id: 'default', name: 'default', description: '' },
    ],
  };

  it('starts with nothing, which is the common case rather than a failure', () => {
    expect(initialPanelState().runtime).toBeNull();
  });

  it('folds a pushed info message into state', () => {
    const session = createLiveSession();
    const next = session.apply(initialPanelState(), {
      kind: 'info',
      connId: 'c-info',
      tMs: 3,
      url: 'http://localhost:3000/api/copilotkit/info',
      info: RUNTIME,
    });
    expect(next.runtime).toEqual(RUNTIME);
  });

  it('adds no record and moves no seq', () => {
    const session = createLiveSession();
    const next = session.apply(initialPanelState(), {
      kind: 'info',
      connId: 'c-info',
      tMs: 3,
      url: 'http://localhost:3000/api/copilotkit/info',
      info: RUNTIME,
    });
    expect(next.records).toEqual([]);
    expect(next.runs).toEqual([]);
    expect(next.issues).toEqual([]);
  });

  it('takes it off a snapshot, which is how a late panel gets it', () => {
    const session = createLiveSession();
    const next = session.apply(initialPanelState(), {
      kind: 'snapshot',
      records: [],
      requests: [],
      closed: [],
      droppedBefore: 0,
      loaded: true,
      info: RUNTIME,
      registration: { matches: [], error: null },
    });
    expect(next.runtime).toEqual(RUNTIME);
  });

  it('lets a snapshot with no runtime clear one this session was holding', () => {
    // The worker retains this fact and states it on every snapshot, so the snapshot is the
    // authority. Keeping the held value would carry a previous page's agent list across a
    // reconnect that reported none.
    const session = createLiveSession();
    let state = session.apply(initialPanelState(), {
      kind: 'info',
      connId: 'c-info',
      tMs: 3,
      url: 'http://localhost:3000/api/copilotkit/info',
      info: RUNTIME,
    });
    state = session.apply(state, {
      kind: 'snapshot',
      records: [],
      requests: [],
      closed: [],
      droppedBefore: 0,
      loaded: true,
      info: null,
      registration: { matches: [], error: null },
    });
    expect(state.runtime).toBeNull();
  });

  it('keeps the most recent answer rather than merging two', () => {
    const session = createLiveSession();
    let state = session.apply(initialPanelState(), {
      kind: 'info',
      connId: 'c1',
      tMs: 1,
      url: '/api/copilotkit/info',
      info: RUNTIME,
    });
    state = session.apply(state, {
      kind: 'info',
      connId: 'c2',
      tMs: 2,
      url: '/api/copilotkit',
      info: { version: '2.0.0', mode: 'single-route', agents: [] },
    });
    expect(state.runtime).toEqual({ version: '2.0.0', mode: 'single-route', agents: [] });
  });

  it('survives a refold, so Expand chunks does not erase it', () => {
    const session = createLiveSession();
    const state = session.apply(initialPanelState(), {
      kind: 'info',
      connId: 'c-info',
      tMs: 3,
      url: '/api/copilotkit/info',
      info: RUNTIME,
    });
    // Metadata vanishing when the user pressed a display toggle would look exactly like metadata
    // that was never captured.
    expect(session.refold(state, { expandChunks: true }).runtime).toEqual(RUNTIME);
  });

  it('drops it on a clear, matching the worker', () => {
    const session = createLiveSession();
    let state = session.apply(initialPanelState(), {
      kind: 'info',
      connId: 'c-info',
      tMs: 3,
      url: '/api/copilotkit/info',
      info: RUNTIME,
    });
    state = session.apply(state, { kind: 'cleared' });
    expect(state.runtime).toBeNull();
  });
});

/**
 * The registration picture, folded.
 *
 * Whether the capture scripts are registered for an origin is a fact about the EXTENSION, not
 * about this capture, and the panel needs it to tell "this document predates the registration, so
 * reload it" from "there is no registration, so reloading achieves nothing".
 */
describe('live session — content-script registration', () => {
  const REGISTERED = { matches: ['https://app.example.com/*'], error: null };

  function snapshot(registration: {
    matches: string[];
    error: string | null;
  }): Extract<SwMessage, { kind: 'snapshot' }> {
    return {
      kind: 'snapshot',
      records: [],
      requests: [],
      closed: [],
      droppedBefore: 0,
      loaded: false,
      info: null,
      registration,
    };
  }

  it('takes the registration out of the snapshot, not out of what it was holding', () => {
    const session = createLiveSession();
    let state = session.apply(initialPanelState(), snapshot(REGISTERED));
    expect(state.registration).toEqual(REGISTERED);

    // A reconnect happens precisely when the worker respawned, which is precisely when
    // registrations may have been dropped — so the snapshot is the authority and the held value
    // is the stale one. Keeping the held value here is how a panel would go on reporting a
    // registration that no longer exists.
    state = session.apply(state, snapshot({ matches: [], error: null }));
    expect(state.registration).toEqual({ matches: [], error: null });
  });

  it('replaces the whole picture on a push rather than merging into it', () => {
    const session = createLiveSession();
    let state = session.apply(initialPanelState(), snapshot(REGISTERED));
    state = session.apply(state, {
      kind: 'registration',
      registration: { matches: [], error: null },
    });

    // A merge would keep an origin listed after it had been unregistered — the worker states the
    // entire picture every time, precisely so this cannot happen.
    expect(state.registration).toEqual({ matches: [], error: null });
  });

  it('carries a registration failure through, rather than reporting a bare absence', () => {
    const session = createLiveSession();
    const state = session.apply(initialPanelState(), {
      kind: 'registration',
      registration: { matches: [], error: 'Invalid value for parameter matches' },
    });
    expect(state.registration).toEqual({
      matches: [],
      error: 'Invalid value for parameter matches',
    });
  });

  it('spends no seq, adds no record and builds no run', () => {
    const session = createLiveSession();
    const state = session.apply(initialPanelState(), {
      kind: 'registration',
      registration: REGISTERED,
    });
    // Nothing about the extension's own plumbing is a protocol event. A Timeline row here would
    // be the panel asserting something the user's stream never contained.
    expect(state.records).toEqual([]);
    expect(state.runs).toEqual([]);
    expect(state.issues).toEqual([]);
  });

  it('survives a refold, so Expand chunks does not un-explain the page', () => {
    const session = createLiveSession();
    const state = session.apply(initialPanelState(), snapshot(REGISTERED));
    expect(session.refold(state, { expandChunks: true }).registration).toEqual(REGISTERED);
  });

  it('survives a clear, which empties data and unregisters nothing', () => {
    const session = createLiveSession();
    let state = session.apply(initialPanelState(), snapshot(REGISTERED));
    state = session.apply(state, { kind: 'cleared' });

    // Unlike `info`, this is not a fact about the page the capture came from — it is a fact about
    // the extension, and no message is due to restate it. Dropping it here would put the panel
    // back to "not known yet" for a page it had just explained.
    expect(state.registration).toEqual(REGISTERED);
    expect(state.records).toEqual([]);
  });
});
