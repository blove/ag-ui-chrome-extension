/// <reference types="vite/client" />
/**
 * One file, one story: what every surface says about a clean capture that was redacted for
 * sharing.
 *
 * The recipient of a redacted bug report is the person this protects. They did not press the
 * export button, they never saw the warning beside it, and they cannot re-run the capture —
 * all they have is the file. So the toolbar badge, the Messages run heading, the Timeline row
 * tint and the Messages tool row have to agree, and the thing they agree on has to be true.
 *
 * Before this suite the panel contradicted itself: Messages read the header and reported
 * `arguments redacted`, while the badge, the heading and the timeline all asserted
 * `tool-args-not-json` — an error the original stream never had, caused by the redactor. The
 * honest half was the one the recipient was least likely to look at.
 *
 * These assertions are deliberately about the SAME state object rendered four ways. Testing each
 * surface in its own file with its own fixture is what let them drift apart in the first place.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/preact';
import happyJsonl from '../test/fixtures/happy-run.agui.jsonl?raw';
import { encodeJsonl } from '../core/jsonl/codec';
import { ALL_REDACTION_GROUPS, type RedactionGroup } from '../core/jsonl/redact';
import { buildExport } from './export/build';
import { applyLoaded } from './import/apply-loaded';
import { loadJsonl } from './import/load-jsonl';
import { initialPanelState, type PanelState } from './model/panel-types';
import { createPanelStore } from './model/store';
import { Toolbar } from './shell/toolbar';
import { Messages } from './tabs/messages/messages';
import { EventList } from './tabs/timeline/event-list';

/** The clean capture as its author sees it, before anything is taken out. */
function original(): PanelState {
  const loaded = loadJsonl(happyJsonl);
  expect(loaded.decodeErrors).toEqual([]);
  return applyLoaded(initialPanelState(), loaded, 'happy-run.agui.jsonl', 1000);
}

/**
 * The same capture as its RECIPIENT sees it: run through the real export builder with the
 * groups a user ticks, written out, and re-imported. No shortcut through `redactLine`, because
 * the header — the thing that tells the fold what was removed — is the export builder's work.
 */
function shared(groups: RedactionGroup[]): PanelState {
  const text = encodeJsonl(
    buildExport(original(), {
      scope: null,
      groups,
      toolVersion: '0.1.0',
      exportedAtIso: '2026-08-15T12:00:00.000Z',
    }).lines,
  );
  return applyLoaded(initialPanelState(), loadJsonl(text), 'bug-report.agui.jsonl', 2000);
}

describe('a clean capture shared as a redacted bug report', () => {
  it('is clean before it is shared — otherwise this suite proves nothing', () => {
    expect(original().issues).toEqual([]);
    expect(original().runs[0]?.toolCalls.get('tc_1')?.args).toEqual({
      city: 'Paris',
      units: 'metric',
    });
  });

  it('the toolbar badge does not accuse', () => {
    render(<Toolbar store={createPanelStore(shared([...ALL_REDACTION_GROUPS]))} onImport={() => undefined} />);

    const badge = screen.getByRole('button', { name: /events with issues/ });
    expect(badge.textContent).toContain('0 issues');
    expect(badge.getAttribute('data-tone')).toBe('none');
  });

  it('the Messages run heading does not accuse', () => {
    render(<Messages store={createPanelStore(shared([...ALL_REDACTION_GROUPS]))} />);

    // The heading renders an issue count only when there is one, so its absence is the claim.
    expect(screen.queryByTestId('run-issues-r_happy')).toBeNull();
  });

  it('the Timeline tints no row', () => {
    render(<EventList store={createPanelStore(shared([...ALL_REDACTION_GROUPS]))} />);

    const tinted = screen.getAllByRole('option').filter((row) => row.hasAttribute('data-severity'));
    expect(tinted).toEqual([]);
  });

  it('and Messages still SAYS the arguments were redacted, so the fact is not lost', () => {
    // Suppressing the issue removes the accusation, not the evidence that the file is partial.
    // This is the surface where the arguments themselves are on screen, so it is where the
    // "cannot be known from this file" belongs.
    render(<Messages store={createPanelStore(shared([...ALL_REDACTION_GROUPS]))} />);

    const call = screen.getByTestId('item-tc_1');
    expect(call.getAttribute('data-args')).toBe('redacted');
    expect(within(call).getByText('arguments redacted')).toBeTruthy();
  });

  it('all four surfaces read one field, so they cannot drift apart again', () => {
    // `Run.redacted` is set by the import path from `JsonlHeader.redacted`; the validator reads
    // it in `core/`, and the Messages tab reads it in the panel. There is no second source.
    expect(shared(['toolArgs']).runs[0]?.redacted).toEqual(['toolArgs']);
    expect(original().runs[0]?.redacted).toEqual([]);
  });
});

describe('redacting groups that spare the arguments changes nothing at all', () => {
  it('keeps the badge, the heading, the timeline and the verdict exactly as they were', () => {
    // The realistic bug report: redact the prose, keep the arguments the bug is about. Nothing
    // here is suppressed, because nothing here was removed.
    const state = shared(['text', 'reasoning', 'state']);

    expect(state.issues).toEqual([]);
    expect(state.runs[0]?.toolCalls.get('tc_1')?.args).toEqual({ city: 'Paris', units: 'metric' });

    render(<Messages store={createPanelStore(state)} />);
    expect(screen.getByTestId('item-tc_1').getAttribute('data-args')).toBe('parsed');
  });
});
