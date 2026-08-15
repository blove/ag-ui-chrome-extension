import { describe, expect, it } from 'vitest';
import type { AguiEvent, CaptureRecord } from '../../core/model/types';
import type { RequestLine } from '../../sw/protocol';
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
      droppedBefore: 0,
      instrumented: true,
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
      droppedBefore: 0,
      instrumented: true,
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

  it('counts its own eviction into droppedBefore (P9)', () => {
    const session = createLiveSession({ maxRecords: 3 });
    const records = happyRun();

    const state = session.apply(initialPanelState(), {
      kind: 'snapshot',
      records,
      requests: [requestLine()],
      droppedBefore: 0,
      instrumented: true,
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
      droppedBefore: 7,
      instrumented: true,
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
      droppedBefore: 0,
      instrumented: true,
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
      droppedBefore: 6,
      instrumented: true,
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
      droppedBefore: 0,
      instrumented: true,
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
      droppedBefore: 4,
      instrumented: true,
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
      droppedBefore: 0,
      instrumented: true,
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
      const start = { ...initialPanelState(), instrumented: null };

      const state = session.apply(start, { kind: 'capture-installed' });

      expect(state.instrumented).toBe(true);
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
        droppedBefore: 0,
        instrumented: false,
      });
      const before = state.records.map((r) => r.seq);

      state = session.apply(state, { kind: 'capture-installed' });

      expect(state.records.map((r) => r.seq)).toEqual(before);
      expect(state.runs).toHaveLength(1);
    });

    it('takes instrumentation from a snapshot, which is how a late panel learns it', () => {
      const session = createLiveSession();

      const state = session.apply(
        { ...initialPanelState(), instrumented: null },
        {
          kind: 'snapshot',
          records: [],
          requests: [],
          droppedBefore: 0,
          instrumented: true,
        },
      );

      expect(state.instrumented).toBe(true);
    });

    it('never reads a snapshot as proof that the page is NOT instrumented', () => {
      const session = createLiveSession();

      // A snapshot arrives the instant the panel subscribes, which on a page that is still
      // loading is before any announcement is due. `false` here means "nothing reported YET",
      // and treating it as a finding is exactly the false warning the grace period exists to
      // prevent — the finding is made by the timeout in `use-live-capture`, never here.
      const fresh = session.apply(
        { ...initialPanelState(), instrumented: null },
        { kind: 'snapshot', records: [], requests: [], droppedBefore: 0, instrumented: false },
      );
      expect(fresh.instrumented).toBeNull();

      const known = session.apply(
        { ...initialPanelState(), instrumented: true },
        { kind: 'snapshot', records: [], requests: [], droppedBefore: 0, instrumented: false },
      );
      expect(known.instrumented).toBe(true);
    });

    it('survives a clear, which empties data and uninstalls nothing', () => {
      const session = createLiveSession();
      const state = session.apply(
        { ...initialPanelState(), instrumented: true },
        { kind: 'cleared' },
      );

      expect(state.instrumented).toBe(true);
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
        droppedBefore: 0,
        instrumented: true,
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
        droppedBefore: 0,
        instrumented: true,
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
      droppedBefore: 0,
      instrumented: true,
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
