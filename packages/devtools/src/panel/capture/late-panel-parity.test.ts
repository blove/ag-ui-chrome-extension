/**
 * THE COMPARISON. Open DevTools after your run has finished, and the tool must report exactly
 * what the same bytes report when they are imported from a `.agui.jsonl` file.
 *
 * This is a test about a DISAGREEMENT between two paths, so it asserts nothing about either one
 * on its own — it computes both and compares them. Asserting only that the live path reports
 * `run-never-terminated` would pass on a build that reported it for the wrong reason, at the
 * wrong seq, or that had stopped reporting the other two issues; asserting only that import does
 * would say nothing about live capture at all.
 *
 * WHAT WENT WRONG, and why the comparison catches it. `closeConnection` is the sole trigger for
 * `finalizeRules`, and `finalizeRules` is the sole owner of every run-end issue. A panel that
 * subscribes while a run is streaming gets a `closed` message and finalises. A panel opened
 * AFTER the run gets one `snapshot` instead — and the snapshot did not carry the closes, so that
 * panel finalised nothing: the run sat in `outcome: 'running'` with `run-never-terminated`
 * silently absent. Silently is the operative word. A missing issue looks exactly like a clean
 * run, so the tool under-reported and said nothing about it, and whether it did depended on when
 * the user happened to open DevTools.
 *
 * The stream used is `malformed`, whose defining property is that it ENDS WITH NO TERMINAL EVENT
 * — the run's last frame is `STEP_FINISHED`. So `run-never-terminated` is genuinely at stake
 * here rather than being a code that happens not to fire on either side.
 *
 * There is precedent for this shape of proof: `packages/harness/e2e/capture.spec.ts` shows the
 * same scenario captured through a real browser reconstructing to the same three issues at the
 * same seqs as the golden fixture's offline result.
 */
import { describe, expect, test } from 'vitest';
import malformedJsonl from '../../test/fixtures/malformed.agui.jsonl?raw';
import { encodeJsonl } from '../../core/jsonl/codec';
import type { CaptureRecord, Issue } from '../../core/model/types';
import type { RequestLine } from '../../sw/protocol';
import { buildExport } from '../export/build';
import { loadJsonl } from '../import/load-jsonl';
import { initialPanelState, type PanelState } from '../model/panel-types';
import { createLiveSession } from './live-session';

const OPTIONS = { toolVersion: '0.1.0', exportedAtIso: '2026-08-15T12:00:00.000Z' };

const CONN_ID = 'c1';
/**
 * When the connection ended.
 *
 * Deliberately LATER than the last frame (`tMs` 130 in the fixture): a stream's last byte and the
 * socket closing are two different moments, and conflating them is the approximation this fix
 * exists to avoid. The gap is what makes the timestamp assertion below able to fail.
 */
const CLOSED_AT_MS = 175;
/** The last frame the fixture carries — `STEP_FINISHED`, with no terminal event after it. */
const LAST_FRAME_MS = 130;

interface CapturedStream {
  records: CaptureRecord[];
  requests: RequestLine[];
}

/**
 * The bytes, as the capture layer would hold them.
 *
 * Decoded from the golden fixture rather than hand-built, so "the same bytes" is literally true:
 * this is the one array of records both paths below are given.
 */
function capturedStream(): CapturedStream {
  const loaded = loadJsonl(malformedJsonl);
  return { records: loaded.records, requests: loaded.requests };
}

/** The panel opened AFTER the run finished: one snapshot, nothing streamed. */
function afterLateOpen(stream: CapturedStream): PanelState {
  const session = createLiveSession();
  return session.apply(initialPanelState(), {
    kind: 'snapshot',
    records: stream.records,
    requests: stream.requests,
    closed: [{ connId: CONN_ID, tMs: CLOSED_AT_MS }],
    droppedBefore: 0,
    loaded: true,
    info: null,
  });
}

/** The panel opened BEFORE the run: request, frames, then the close, as they happen. */
function afterWatchingLive(stream: CapturedStream): PanelState {
  const session = createLiveSession();
  let state = initialPanelState();
  for (const request of stream.requests) state = session.apply(state, { kind: 'request', request });
  for (const record of stream.records) {
    state = session.apply(state, { kind: 'append', records: [record], droppedBefore: 0 });
  }
  return session.apply(state, { kind: 'closed', connId: CONN_ID, tMs: CLOSED_AT_MS });
}

/** Export what the panel holds, then read those bytes back the way an import does. */
function afterExportAndImport(s: PanelState): PanelState {
  const text = encodeJsonl(buildExport(s, { scope: null, groups: [], ...OPTIONS }).lines);
  const loaded = loadJsonl(text);
  return { ...initialPanelState(), runs: loaded.runs, records: loaded.records, issues: loaded.issues };
}

/**
 * A finding's identity: what is wrong, where in the stream, and what it says.
 *
 * `tMs` is left out ON PURPOSE and is asserted separately below, because the two paths anchor it
 * to different real events and both are right: the live path has the close time, and the
 * `.agui.jsonl` format has no line for a close at all, so an import can only anchor at the last
 * frame it saw. That is a property of the file format, identical on the streaming path, and not
 * something this fix introduces. Everything else must match exactly.
 */
function findings(issues: readonly Issue[]): string[] {
  return [...issues]
    .map((issue) => `${issue.code}@${String(issue.seq)}/${issue.severity}: ${issue.message}`)
    .sort();
}

describe('a run that finished before the panel opened', () => {
  test('THE COMPARISON: live capture and the import of its own export report the same findings', () => {
    const stream = capturedStream();

    const live = afterLateOpen(stream);
    const imported = afterExportAndImport(live);

    // Not vacuous: both sides genuinely have findings, and the fixture's three are they. Without
    // this a build where BOTH paths reported nothing would satisfy the equality below.
    expect(findings(imported.issues)).toHaveLength(3);
    expect(imported.issues.map((issue) => `${issue.code}@${String(issue.seq)}`)).toEqual([
      'empty-text-delta@5',
      'state-patch-failed@9',
      'run-never-terminated@10',
    ]);

    expect(findings(live.issues)).toEqual(findings(imported.issues));
  });

  test('and the run is finalised, not left sitting in running', () => {
    const live = afterLateOpen(capturedStream());
    const imported = afterExportAndImport(live);

    expect(live.runs).toHaveLength(1);
    expect(live.runs[0]?.outcome).toBe('aborted');
    expect(live.runs[0]?.outcome).toBe(imported.runs[0]?.outcome);
  });

  test('the answer does not depend on when DevTools was opened', () => {
    // The same bytes down the two live routes — a snapshot replay and a streamed fold — with the
    // same close. These share a code path only if the snapshot arm replays its closes, so this
    // is `tMs` and all: no format limitation stands between them.
    const stream = capturedStream();

    const late = afterLateOpen(stream);
    const watching = afterWatchingLive(stream);

    expect(late.issues).toEqual(watching.issues);
    expect(late.runs[0]?.outcome).toBe(watching.runs[0]?.outcome);
    expect(late.runs[0]?.endedAtMs).toBe(watching.runs[0]?.endedAtMs);
  });

  test('the run-end issue is anchored at the close, not at a time the panel made up', () => {
    // The one thing a bare connection id cannot carry. A snapshot that shipped ids alone would
    // have to invent this number, and an invented anchor misplaces every run-end issue — a
    // quieter version of the same bug rather than a fix for it.
    const live = afterLateOpen(capturedStream());

    const terminated = live.issues.find((issue) => issue.code === 'run-never-terminated');
    expect(terminated?.tMs).toBe(CLOSED_AT_MS);
    expect(terminated?.tMs).not.toBe(LAST_FRAME_MS);
    expect(live.runs[0]?.endedAtMs).toBe(CLOSED_AT_MS);
  });

  test('a close that arrives twice — once by snapshot, once by push — is applied once', () => {
    // The worker broadcasts a close to whoever is subscribed AND hands it to whoever subscribes
    // afterwards, so a panel connecting at the wrong instant genuinely sees both. `finalizeRules`
    // is a pure function of a validation state that closing does not reset, so a second pass over
    // an unterminated run would re-raise `run-never-terminated` and every `unclosed-*`.
    const stream = capturedStream();
    const session = createLiveSession();

    const once = session.apply(initialPanelState(), {
      kind: 'snapshot',
      records: stream.records,
      requests: stream.requests,
      closed: [{ connId: CONN_ID, tMs: CLOSED_AT_MS }],
      droppedBefore: 0,
      loaded: true,
      info: null,
    });
    const twice = session.apply(once, { kind: 'closed', connId: CONN_ID, tMs: 999 });

    expect(twice.issues).toEqual(once.issues);
    // The later time does not overwrite the anchor either: the connection ended when it ended.
    expect(twice.issues.find((issue) => issue.code === 'run-never-terminated')?.tMs).toBe(
      CLOSED_AT_MS,
    );
  });

  test('a refold keeps the snapshot’s closes, so Expand chunks does not un-finalise the run', () => {
    // `refold` rebuilds from what the session retained. A close that reached the panel only as a
    // snapshot field, and was never retained, would vanish the first time the user toggled a
    // display option — the run would silently return to `running`.
    const stream = capturedStream();
    const session = createLiveSession({ expandChunks: true });
    const state = session.apply(initialPanelState(), {
      kind: 'snapshot',
      records: stream.records,
      requests: stream.requests,
      closed: [{ connId: CONN_ID, tMs: CLOSED_AT_MS }],
      droppedBefore: 0,
      loaded: true,
      info: null,
    });

    const refolded = session.refold(state, { expandChunks: false });

    expect(findings(refolded.issues)).toEqual(findings(state.issues));
    expect(refolded.runs[0]?.outcome).toBe('aborted');
  });
});
