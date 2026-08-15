/**
 * Done-when #6, stated literally: **export a run, clear, re-import, tabs are identical.**
 *
 * Requirements §13 criterion 6 is one sentence, and this file is that sentence executed. It uses
 * the panel's own state — `applyLoaded`, the Clear the toolbar performs, `loadJsonl` — rather than
 * comparing two `LoadedCapture`s, because the criterion is about what the TABS show, and every tab
 * reads `runs`, `records` and `issues` off `PanelState`.
 *
 * Identity here is semantic, not byte-for-byte (E2). The exported file is re-encoded from records,
 * so its bytes may differ from the file that was imported — key order, an omitted optional. What
 * must not differ is the model both files fold to.
 */
import { describe, expect, test } from 'vitest';
import happyJsonl from '../../test/fixtures/happy-run.agui.jsonl?raw';
import malformedJsonl from '../../test/fixtures/malformed.agui.jsonl?raw';
import chunkedJsonl from '../../test/fixtures/chunked-run.agui.jsonl?raw';
import { encodeJsonl } from '../../core/jsonl/codec';
import { ALL_REDACTION_GROUPS, type RedactionGroup } from '../../core/jsonl/redact';
import { applyLoaded } from '../import/apply-loaded';
import { loadJsonl } from '../import/load-jsonl';
import { initialPanelState, type PanelState } from '../model/panel-types';
import { selectScope } from '../model/store';
import { buildExport } from './build';

const OPTIONS = { toolVersion: '0.1.0', exportedAtIso: '2026-08-15T12:00:00.000Z' };

/** The panel after a user has imported `text`. */
function afterImport(text: string, expandChunks = true): PanelState {
  const start: PanelState = { ...initialPanelState(), expandChunks };
  return applyLoaded(start, loadJsonl(text, { expandChunks }), 'capture.agui.jsonl', 1000);
}

/**
 * Exactly what the toolbar's Clear button does: a reset to the initial state, keeping only the
 * facts that describe the inspected page and the session's settings.
 */
function afterClear(s: PanelState): PanelState {
  return {
    ...initialPanelState(),
    capture: s.capture,
    source: s.source.kind === 'live' ? s.source : { kind: 'empty' },
    recording: s.recording,
    preserveLog: s.preserveLog,
    expandChunks: s.expandChunks,
  };
}

/** What every tab renders. Not `source` or `filename`: those describe the file, not the stream. */
function tabs(s: PanelState): Pick<PanelState, 'runs' | 'records' | 'issues'> {
  return { runs: s.runs, records: s.records, issues: s.issues };
}

function exportText(s: PanelState, groups: RedactionGroup[] = []): string {
  return encodeJsonl(buildExport(s, { scope: s.scope, groups, ...OPTIONS }).lines);
}

describe('done-when #6: export a run, clear, re-import, tabs are identical', () => {
  test('the happy run survives the round trip', () => {
    const imported = selectScope(afterImport(happyJsonl), 'r_happy');

    const text = exportText(imported);
    const cleared = afterClear(imported);
    expect(tabs(cleared)).toEqual({ runs: [], records: [], issues: [] });

    const reimported = applyLoaded(cleared, loadJsonl(text), 'export.agui.jsonl', 2000);

    expect(tabs(reimported)).toEqual(tabs(imported));
  });

  test('the issues survive it too, which is what makes the file a bug report', () => {
    // `malformed` carries the three validator entries done-when #5 pins. A round trip that lost
    // or invented one would hand a colleague a different bug from the one that was reported.
    const imported = afterImport(malformedJsonl);

    const reimported = applyLoaded(
      afterClear(imported),
      loadJsonl(exportText(imported)),
      'export.agui.jsonl',
      2000,
    );

    expect(reimported.issues.map((issue) => `${issue.code}@${String(issue.seq)}`)).toEqual([
      'empty-text-delta@5',
      'state-patch-failed@9',
      'run-never-terminated@10',
    ]);
    expect(tabs(reimported)).toEqual(tabs(imported));
  });

  test('a chunked capture survives it with expansion on', () => {
    const imported = afterImport(chunkedJsonl, true);

    const reimported = applyLoaded(
      afterClear(imported),
      loadJsonl(exportText(imported), { expandChunks: true }),
      'export.agui.jsonl',
      2000,
    );

    expect(tabs(reimported)).toEqual(tabs(imported));
  });

  test('the run keeps its RunAgentInput, so no run-started-without-input is invented', () => {
    const imported = selectScope(afterImport(happyJsonl), 'r_happy');

    const reimported = applyLoaded(
      afterClear(imported),
      loadJsonl(exportText(imported)),
      'export.agui.jsonl',
      2000,
    );

    expect(reimported.issues).toEqual([]);
    expect(reimported.runs[0]?.input).toEqual(imported.runs[0]?.input);
  });

  test('exporting all runs is the same round trip as exporting the one run this capture holds', () => {
    const scoped = selectScope(afterImport(happyJsonl), 'r_happy');
    const all = afterImport(happyJsonl);
    expect(exportText(scoped)).toBe(exportText(all));
  });

  test('the exported file is a valid capture: header on line 1, no decode errors', () => {
    const text = exportText(afterImport(happyJsonl));

    expect(text.split('\n')[0]).toContain('"kind":"header"');
    expect(loadJsonl(text).decodeErrors).toEqual([]);
  });

  test('a second round trip changes nothing — export is idempotent', () => {
    const once = afterImport(exportText(afterImport(happyJsonl)));
    const twice = afterImport(exportText(once));
    expect(tabs(twice)).toEqual(tabs(once));
  });
});

describe('done-when #7: a redacted export has no message text, and still validates and renders', () => {
  test('no message text survives, in the run the panel reconstructs', () => {
    const imported = afterImport(happyJsonl);
    expect(imported.runs[0]?.messages.get('m_1')?.content).toBe(
      'The weather in Paris is sunny and 24 degrees.\nEnjoy!',
    );

    const redacted = afterImport(exportText(imported, [...ALL_REDACTION_GROUPS]));

    const content = redacted.runs[0]?.messages.get('m_1')?.content ?? '';
    expect(content).not.toContain('weather');
    expect(content).not.toContain('Paris');
    expect(content).not.toContain('Enjoy');
    // Sizes survive, which is what a protocol bug report is about (§11).
    expect(content).toBe('«redacted: 20 chars»«redacted: 16 chars»«redacted: 16 chars»');
  });

  test('it still VALIDATES: the file decodes cleanly and every rule runs over it', () => {
    const imported = afterImport(happyJsonl);
    const redacted = afterImport(exportText(imported, [...ALL_REDACTION_GROUPS]));

    expect(loadJsonl(exportText(imported, [...ALL_REDACTION_GROUPS])).decodeErrors).toEqual([]);
    expect(redacted.runs).toHaveLength(1);
    /*
     * `tool-args-not-json` is the ONE issue redaction adds, and it is a true statement about the
     * file in hand: `«redacted: 16 chars»«redacted: 16 chars»` is not JSON, because no
     * per-event placeholder can compose into valid JSON across an arbitrary split of a JSON
     * string. It is redaction's unavoidable cost, not a defect — but it IS a finding a reader
     * could mistake for one about their agent, so the export panel says so before the click
     * rather than leaving it to be discovered in the timeline.
     */
    expect(redacted.issues.map((issue) => issue.code)).toEqual(['tool-args-not-json']);
  });

  test('redacting only what the bug is about leaves the capture issue-for-issue identical', () => {
    // The realistic bug report: redact the prose, keep the tool arguments the bug is about.
    const imported = afterImport(happyJsonl);
    const redacted = afterImport(exportText(imported, ['text', 'reasoning', 'state']));

    expect(redacted.issues).toEqual(imported.issues);
    expect(redacted.runs[0]?.toolCalls.get('tc_1')?.args).toEqual({
      city: 'Paris',
      units: 'metric',
    });
  });

  test('it still RENDERS: every run, record and frame is still there to draw', () => {
    const imported = afterImport(happyJsonl);
    const redacted = afterImport(exportText(imported, [...ALL_REDACTION_GROUPS]));

    expect(redacted.records.map((record) => record.seq)).toEqual(
      imported.records.map((record) => record.seq),
    );
    expect(redacted.runs).toHaveLength(1);
    expect(redacted.runs[0]?.outcome).toBe('finished');
    expect(redacted.runs[0]?.stateTimeline).toHaveLength(imported.runs[0]?.stateTimeline.length ?? 0);
    expect(redacted.runs[0]?.toolCalls.get('tc_1')?.toolCallName).toBe('get_weather');
    expect(redacted.runs[0]?.metrics.durationMs).toBe(imported.runs[0]?.metrics.durationMs);
  });

  test('the redacted file’s three validator entries still land where they did (malformed)', () => {
    const imported = afterImport(malformedJsonl);
    const redacted = afterImport(exportText(imported, [...ALL_REDACTION_GROUPS]));

    // Not identical to the original: `empty-text-delta` fires on an EMPTY delta, and a redacted
    // empty string is still empty, so all three survive verbatim. If that ever stops being true
    // the redactor has started changing what the validator sees, which is a finding.
    expect(redacted.issues.map((issue) => `${issue.code}@${String(issue.seq)}`)).toEqual([
      'empty-text-delta@5',
      'state-patch-failed@9',
      'run-never-terminated@10',
    ]);
  });
});
