// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { CaptureRecord, Run } from '../../core/model/types';
import { initialPanelState, type DetectionSignal, type PanelState } from './panel-types';
import {
  captureOn,
  createPanelStore,
  loadFailed,
  raiseSignal,
  selectScope,
  selectSeq,
  selectTab,
  setCapture,
  setFramework,
  setRecording,
  setTextFilter,
  toggleExpandChunks,
  toggleIssuesOnly,
  togglePreserveLog,
} from './store';

function makeRecord(seq: number): CaptureRecord {
  return {
    kind: 'event',
    seq,
    tMs: seq * 10,
    connId: 'conn-1',
    raw: null,
    event: { type: 'CUSTOM' },
    issues: [],
  };
}

function makeRun(runId: string, recordSeqs: number[]): Run {
  return {
    runId,
    threadId: 'thread-1',
    connId: 'conn-1',
    startedAtMs: 0,
    outcome: 'finished',
    messages: new Map(),
    toolCalls: new Map(),
    activities: new Map(),
    steps: [],
    stateTimeline: [],
    metrics: {
      stalls: [],
      toolLatencyMs: {},
      statePatchCount: 0,
      statePatchBytes: 0,
      eventCountByType: {},
      totalStreamBytes: 0,
    },
    issues: [],
    recordSeqs,
  };
}

/** Two runs, r_1 owning seqs 1-2 and r_2 owning seqs 3-4, with seq 2 selected. */
function loadedState(): PanelState {
  return {
    ...initialPanelState(),
    runs: [makeRun('r_1', [1, 2]), makeRun('r_2', [3, 4])],
    records: [makeRecord(1), makeRecord(2), makeRecord(3), makeRecord(4)],
    selectedSeq: 2,
  };
}

/**
 * Runs an action and asserts the two properties every action shares: a NEW state object out, and
 * the input left byte-for-byte as it was. `structuredClone` is used rather than a shallow copy so
 * a mutation buried in `filter` or in a `Run`'s maps still fails the comparison.
 */
function expectPure(s: PanelState, act: (input: PanelState) => PanelState): PanelState {
  const before = structuredClone(s);
  const next = act(s);
  expect(next).not.toBe(s);
  expect(s).toEqual(before);
  return next;
}

describe('initialPanelState', () => {
  it('starts empty, unscoped, on the timeline tab', () => {
    const s = initialPanelState();
    expect(s.source).toEqual({ kind: 'empty' });
    expect(s.droppedBefore).toBe(0);
    expect(s.tab).toBe('timeline');
    expect(s.scope).toBeNull();
  });

  it('starts with no data, no filter, and no error', () => {
    const s = initialPanelState();
    expect(s.capture).toEqual({ kind: 'unsupported' });
    expect(s.filter).toEqual({ text: '', issuesOnly: false });
    expect(s.runs).toEqual([]);
    expect(s.records).toEqual([]);
    expect(s.issues).toEqual([]);
    expect(s.expandChunks).toBe(false);
    expect(s.selectedSeq).toBeNull();
    expect(s.loadError).toBeNull();
  });

  it('returns a fresh object each call, so one panel cannot alias another', () => {
    const a = initialPanelState();
    const b = initialPanelState();
    expect(a).not.toBe(b);
    expect(a.filter).not.toBe(b.filter);
    expect(a.runs).not.toBe(b.runs);
  });
});

describe('selectTab', () => {
  it('sets the tab without mutating the input', () => {
    const next = expectPure(loadedState(), (s) => selectTab(s, 'session'));
    expect(next.tab).toBe('session');
  });

  it('returns a new object even when the tab is unchanged', () => {
    const next = expectPure(initialPanelState(), (s) => selectTab(s, 'timeline'));
    expect(next.tab).toBe('timeline');
  });
});

describe('selectScope', () => {
  it('preserves selectedSeq when the new scope still contains it', () => {
    const next = expectPure(loadedState(), (s) => selectScope(s, 'r_1'));
    expect(next.scope).toBe('r_1');
    expect(next.selectedSeq).toBe(2);
  });

  it('clears selectedSeq when the new scope no longer contains it', () => {
    const next = expectPure(loadedState(), (s) => selectScope(s, 'r_2'));
    expect(next.scope).toBe('r_2');
    expect(next.selectedSeq).toBeNull();
  });

  it('preserves selectedSeq when widening to all runs', () => {
    const scoped = selectScope(loadedState(), 'r_1');
    const next = expectPure(scoped, (s) => selectScope(s, null));
    expect(next.scope).toBeNull();
    expect(next.selectedSeq).toBe(2);
  });

  it('clears selectedSeq for an unknown run id, whose record set is empty', () => {
    const next = expectPure(loadedState(), (s) => selectScope(s, 'r_missing'));
    expect(next.scope).toBe('r_missing');
    expect(next.selectedSeq).toBeNull();
  });

  it('clears a selectedSeq that matches no record at all under all runs', () => {
    const orphaned: PanelState = { ...loadedState(), selectedSeq: 99 };
    const next = expectPure(orphaned, (s) => selectScope(s, null));
    expect(next.selectedSeq).toBeNull();
  });

  it('leaves a null selectedSeq null', () => {
    const none: PanelState = { ...loadedState(), selectedSeq: null };
    const next = expectPure(none, (s) => selectScope(s, 'r_1'));
    expect(next.selectedSeq).toBeNull();
  });
});

describe('selectSeq', () => {
  it('sets the selected seq without mutating the input', () => {
    const next = expectPure(loadedState(), (s) => selectSeq(s, 3));
    expect(next.selectedSeq).toBe(3);
  });

  it('clears the selection when given null', () => {
    const next = expectPure(loadedState(), (s) => selectSeq(s, null));
    expect(next.selectedSeq).toBeNull();
  });
});

describe('setTextFilter', () => {
  it('replaces the filter object rather than mutating it', () => {
    const s = loadedState();
    const next = expectPure(s, (input) => setTextFilter(input, 'RUN_STARTED'));
    expect(next.filter).not.toBe(s.filter);
    expect(next.filter).toEqual({ text: 'RUN_STARTED', issuesOnly: false });
  });

  it('keeps issuesOnly untouched', () => {
    const s: PanelState = { ...loadedState(), filter: { text: 'old', issuesOnly: true } };
    const next = expectPure(s, (input) => setTextFilter(input, 'new'));
    expect(next.filter).toEqual({ text: 'new', issuesOnly: true });
  });

  it('accepts the empty string as "no text filter"', () => {
    const s: PanelState = { ...loadedState(), filter: { text: 'old', issuesOnly: false } };
    const next = expectPure(s, (input) => setTextFilter(input, ''));
    expect(next.filter.text).toBe('');
  });
});

describe('toggleIssuesOnly', () => {
  it('flips false to true without mutating the input', () => {
    const s = loadedState();
    const next = expectPure(s, toggleIssuesOnly);
    expect(next.filter).not.toBe(s.filter);
    expect(next.filter.issuesOnly).toBe(true);
  });

  it('flips true back to false and keeps the text', () => {
    const s: PanelState = { ...loadedState(), filter: { text: 'tool', issuesOnly: true } };
    const next = expectPure(s, toggleIssuesOnly);
    expect(next.filter).toEqual({ text: 'tool', issuesOnly: false });
  });
});

describe('toggleExpandChunks', () => {
  it('flips the flag without mutating the input', () => {
    const next = expectPure(loadedState(), toggleExpandChunks);
    expect(next.expandChunks).toBe(true);
  });

  it('flips back on a second call', () => {
    const once = toggleExpandChunks(loadedState());
    const next = expectPure(once, toggleExpandChunks);
    expect(next.expandChunks).toBe(false);
  });

  it('only flips the flag — records and runs are left alone for the caller to rebuild', () => {
    const s = loadedState();
    const next = toggleExpandChunks(s);
    expect(next.records).toBe(s.records);
    expect(next.runs).toBe(s.runs);
  });
});

describe('setCapture', () => {
  it('replaces the capture status without mutating the input', () => {
    const next = expectPure(loadedState(), (s) =>
      setCapture(s, { kind: 'off', origin: 'https://example.test', signal: { level: 'stream' } }),
    );
    expect(next.capture).toEqual({
      kind: 'off',
      origin: 'https://example.test',
      signal: { level: 'stream' },
    });
  });

  it('accepts the unsupported status', () => {
    const on: PanelState = { ...loadedState(), capture: { kind: 'on', origin: 'https://a.test' } };
    const next = expectPure(on, (s) => setCapture(s, { kind: 'unsupported' }));
    expect(next.capture).toEqual({ kind: 'unsupported' });
  });
});

/**
 * P11's monotonic rule.
 *
 * Detection only ever strengthens the offer, so the level must only ever move UP. The rule is
 * cheap to keep and the alternative is a panel that visibly walks back a claim it had already
 * earned: `observeNetwork` fires once per subscription, and a re-subscribe on navigation would
 * otherwise be able to reset a stream that was genuinely seen.
 */
describe('raiseSignal', () => {
  function off(signal: DetectionSignal): PanelState {
    return { ...loadedState(), capture: { kind: 'off', origin: 'https://example.test', signal } };
  }

  it('raises none to stream', () => {
    const next = expectPure(off({ level: 'none' }), (s) => raiseSignal(s, { level: 'stream' }));
    expect(next.capture).toEqual({
      kind: 'off',
      origin: 'https://example.test',
      signal: { level: 'stream' },
    });
  });

  it('never downgrades a stream that was already seen', () => {
    const seen = off({ level: 'stream' });
    expect(raiseSignal(seen, { level: 'none' })).toBe(seen);
  });

  it('ignores a repeat of the level already held', () => {
    const held = off({ level: 'stream' });
    expect(raiseSignal(held, { level: 'stream' })).toBe(held);
    const quiet = off({ level: 'none' });
    expect(raiseSignal(quiet, { level: 'none' })).toBe(quiet);
  });

  it('leaves a capture that is not off alone — there is no offer to strengthen', () => {
    const on: PanelState = { ...loadedState(), capture: { kind: 'on', origin: 'https://a.test' } };
    expect(raiseSignal(on, { level: 'stream' })).toBe(on);

    const unsupported = loadedState();
    expect(raiseSignal(unsupported, { level: 'stream' })).toBe(unsupported);
  });
});

/**
 * The framework label is session metadata, not a capture signal.
 *
 * Requirements §4.3: a framework fingerprint labels the session, never gates capture. It lives
 * beside the capture status rather than inside it for exactly that reason — nothing about the
 * offer, the banner, or the signal may read it.
 */
describe('setFramework', () => {
  it('records the label without mutating the input', () => {
    const next = expectPure(loadedState(), (s) => setFramework(s, 'Angular 21.1.6'));
    expect(next.framework).toBe('Angular 21.1.6');
  });

  it('leaves the capture status untouched', () => {
    const s: PanelState = {
      ...loadedState(),
      capture: { kind: 'off', origin: 'https://example.test', signal: { level: 'none' } },
    };
    expect(setFramework(s, 'Angular 21.1.6').capture).toBe(s.capture);
  });

  it('clears back to null', () => {
    const labelled = setFramework(loadedState(), 'Angular 21.1.6');
    expect(setFramework(labelled, null).framework).toBeNull();
  });
});

describe('loadFailed', () => {
  it('records the message without mutating the input', () => {
    const next = expectPure(loadedState(), (s) => loadFailed(s, 'unreadable file'));
    expect(next.loadError).toBe('unreadable file');
  });

  it('replaces an earlier error', () => {
    const failed = loadFailed(initialPanelState(), 'first');
    const next = expectPure(failed, (s) => loadFailed(s, 'second'));
    expect(next.loadError).toBe('second');
  });
});

describe('createPanelStore', () => {
  it('defaults to initialPanelState()', () => {
    expect(createPanelStore().get()).toEqual(initialPanelState());
  });

  it('uses the supplied initial state', () => {
    const s = loadedState();
    expect(createPanelStore(s).get()).toBe(s);
  });

  it('get() returns the state written by set()', () => {
    const store = createPanelStore();
    const next = selectTab(initialPanelState(), 'session');
    store.set(next);
    expect(store.get()).toBe(next);
  });

  it('update() applies the function to the current state', () => {
    const store = createPanelStore();
    store.update((prev) => selectTab(prev, 'session'));
    store.update((prev) => selectSeq(prev, 7));
    expect(store.get().tab).toBe('session');
    expect(store.get().selectedSeq).toBe(7);
  });

  it('notifies subscribers on set()', () => {
    const store = createPanelStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.set(selectTab(store.get(), 'session'));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers on update()', () => {
    const store = createPanelStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.update((prev) => selectTab(prev, 'runs'));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('gives listeners the new state when they read it', () => {
    const store = createPanelStore();
    const seen: string[] = [];
    store.subscribe(() => {
      seen.push(store.get().tab);
    });
    store.update((prev) => selectTab(prev, 'state'));
    expect(seen).toEqual(['state']);
  });

  it('notifies every subscriber', () => {
    const store = createPanelStore();
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);
    store.set(initialPanelState());
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('stops notifying after the returned unsubscribe is called', () => {
    const store = createPanelStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set(initialPanelState());
    unsubscribe();
    store.set(initialPanelState());
    store.update((prev) => prev);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribing one listener leaves the others subscribed', () => {
    const store = createPanelStore();
    const a = vi.fn();
    const b = vi.fn();
    const unsubscribeA = store.subscribe(a);
    store.subscribe(b);
    unsubscribeA();
    store.set(initialPanelState());
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('tolerates a listener unsubscribing during notification', () => {
    const store = createPanelStore();
    const b = vi.fn();
    const unsubscribeA: () => void = store.subscribe(() => {
      unsubscribeA();
    });
    store.subscribe(b);
    store.set(initialPanelState());
    store.set(initialPanelState());
    expect(b).toHaveBeenCalledTimes(2);
  });
});

describe('captureOn', () => {
  it('sets capture and source together', () => {
    const next = captureOn(initialPanelState(), 'http://localhost:5173');
    expect(next.capture).toEqual({ kind: 'on', origin: 'http://localhost:5173' });
    expect(next.source).toEqual({ kind: 'live', origin: 'http://localhost:5173' });
  });

  it('drops an imported capture rather than mixing it with a live one', () => {
    const imported: PanelState = {
      ...initialPanelState(),
      source: { kind: 'imported', filename: 'happy.agui.jsonl', importedAtMs: 5 },
      records: [makeRecord(1)],
      runs: [makeRun('r1', [1])],
      scope: 'r1',
      selectedSeq: 1,
      droppedBefore: 3,
      loadError: 'one line could not be decoded',
    };

    const next = captureOn(imported, 'https://app.example');

    expect(next.records).toEqual([]);
    expect(next.runs).toEqual([]);
    expect(next.issues).toEqual([]);
    expect(next.scope).toBeNull();
    expect(next.selectedSeq).toBeNull();
    expect(next.droppedBefore).toBe(0);
    expect(next.loadError).toBeNull();
  });

  it('drops a binary-transport label left over from an imported capture', () => {
    const imported: PanelState = {
      ...initialPanelState(),
      source: { kind: 'imported', filename: 'happy.agui.jsonl', importedAtMs: 5 },
      binaryTransport: { connId: 'c1', tMs: 1, contentType: 'application/proto', bytes: 9 },
    };
    expect(captureOn(imported, 'https://app.example').binaryTransport).toBeNull();
  });

  it('keeps live records when the origin is re-affirmed', () => {
    const live = captureOn(initialPanelState(), 'https://app.example');
    const withData: PanelState = { ...live, records: [makeRecord(1)], selectedSeq: 1 };
    const next = captureOn(withData, 'https://app.example');
    expect(next.records).toHaveLength(1);
    expect(next.selectedSeq).toBe(1);
  });
});

describe('recording and preserve-log', () => {
  it('starts recording, so Enable begins capturing', () => {
    expect(initialPanelState().recording).toBe(true);
    expect(initialPanelState().preserveLog).toBe(false);
  });

  it('sets recording without touching capture', () => {
    const on = captureOn(initialPanelState(), 'https://app.example');
    const paused = setRecording(on, false);
    expect(paused.recording).toBe(false);
    expect(paused.capture).toEqual({ kind: 'on', origin: 'https://app.example' });
  });

  it('toggles preserve-log', () => {
    const once = togglePreserveLog(initialPanelState());
    expect(once.preserveLog).toBe(true);
    expect(togglePreserveLog(once).preserveLog).toBe(false);
  });
});
