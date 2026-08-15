/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/preact';
// `?raw` rather than `readFileSync(new URL(...))`: under the jsdom project `import.meta.url` is
// not a filesystem URL, so the node-style read resolves to the wrong path.
import happyJsonl from '../../../test/fixtures/happy-run.agui.jsonl?raw';
import malformedJsonl from '../../../test/fixtures/malformed.agui.jsonl?raw';
import stateEdgeJsonl from '../../../test/fixtures/state-edge.agui.jsonl?raw';
import { encodeJsonl } from '../../../core/jsonl/codec';
import { ALL_REDACTION_GROUPS } from '../../../core/jsonl/redact';
import type { Run, StateFrame } from '../../../core/model/types';
import { buildExport } from '../../export/build';
import { applyLoaded } from '../../import/apply-loaded';
import { loadJsonl } from '../../import/load-jsonl';
import { initialPanelState, type PanelState } from '../../model/panel-types';
import { createPanelStore } from '../../model/store';
import { State } from './state';

type FixtureName = 'happy' | 'malformed' | 'edge';

const TEXT: Record<FixtureName, string> = {
  happy: happyJsonl,
  malformed: malformedJsonl,
  edge: stateEdgeJsonl,
};

function imported(name: FixtureName): PanelState {
  const loaded = loadJsonl(TEXT[name]);
  expect(loaded.decodeErrors).toEqual([]);
  return applyLoaded(initialPanelState(), loaded, `${name}.agui.jsonl`, 1000);
}

/**
 * A capture the user redacted before sharing it, produced the way a user produces one: through
 * the real export builder, then re-imported. §11 keeps structure and replaces values, so this is
 * the state a colleague opening a bug report is in.
 */
function redacted(name: FixtureName): PanelState {
  const source = imported(name);
  const text = encodeJsonl(
    buildExport(source, {
      scope: null,
      groups: [...ALL_REDACTION_GROUPS],
      toolVersion: '0.1.0',
      exportedAtIso: '2026-08-15T12:00:00.000Z',
    }).lines,
  );
  return applyLoaded(initialPanelState(), loadJsonl(text), 'redacted.agui.jsonl', 2000);
}

function renderTab(state: PanelState): ReturnType<typeof createPanelStore> {
  const store = createPanelStore(state);
  render(<State store={store} />);
  return store;
}

/** The first run of a fixture, with `stateTimeline` and anything else swapped out. */
function withRun(state: PanelState, patch: Partial<Run>): PanelState {
  const [run] = state.runs;
  expect(run).toBeDefined();
  return { ...state, runs: [{ ...run!, ...patch }] };
}

/** Every scrubber position, as `kind` plus whether it is marked failed. */
function tickMarks(): string[] {
  return screen
    .getAllByRole('radio')
    .map(
      (el) =>
        `${el.getAttribute('data-kind') ?? '?'}:${el.getAttribute('data-failed') ?? '?'}`,
    );
}

describe('State — empty', () => {
  it('says there is no capture rather than rendering a blank pane', () => {
    renderTab(initialPanelState());

    expect(screen.getByRole('region', { name: 'State' })).toBeTruthy();
    expect(screen.getByText(/no runs to show/i)).toBeTruthy();
  });

  it('says a run recorded no state at all, rather than dropping the run', () => {
    renderTab(withRun(imported('happy'), { stateTimeline: [] }));

    expect(screen.getByRole('region', { name: /Run r_happy/ })).toBeTruthy();
    expect(screen.getByText(/recorded no state/i)).toBeTruthy();
    // Nothing to scrub: a scrubber with no positions is a control that does nothing.
    expect(screen.queryAllByRole('radio')).toEqual([]);
  });
});

describe('State — S1: a scrubber over the timeline, and the frame it selects', () => {
  it('gives the scrubber one position per frame, in timeline order', () => {
    renderTab(imported('edge'));

    expect(tickMarks()).toEqual([
      'snapshot:false',
      'delta:false',
      'delta:false',
      'delta:true',
      'delta:false',
      'delta:true',
      'delta:false',
    ]);
  });

  it('opens on the latest frame — the current reconstructed state (§9.3)', () => {
    renderTab(imported('edge'));

    const frame = screen.getByTestId('frame-r_state');
    expect(frame.getAttribute('data-index')).toBe('6');
    expect(screen.getByTestId('frame-head-r_state').textContent).toContain('Frame 7 of 7');
  });

  it('renders the selected frame value as a JSON tree, with types visible', () => {
    renderTab(imported('edge'));

    const doc = screen.getByRole('region', { name: 'State after frame 7 of 7' });
    // The state as of the last frame: `/profile/name` was replaced with "Grace" at seq 8.
    expect(within(doc).getByText('"Grace"').getAttribute('data-type')).toBe('string');
  });

  it('scrubs: clicking a position renders the document as it stood at that frame', () => {
    renderTab(imported('edge'));

    fireEvent.click(screen.getByRole('radio', { name: /Frame 1 of 7/ }));

    const doc = screen.getByRole('region', { name: 'State after frame 1 of 7' });
    // Frame 1 is the snapshot: the name had not been replaced yet, and no notes had arrived.
    expect(within(doc).getByText('"Ada"')).toBeTruthy();
    expect(within(doc).queryByText('"Grace"')).toBeNull();
  });

  it('counts the frames in the run heading', () => {
    renderTab(imported('edge'));

    expect(screen.getByTestId('state-frames-r_state').textContent).toBe('7 frames');
  });

  it('scopes to the selected run', () => {
    renderTab({ ...imported('edge'), scope: 'r_state' });

    expect(screen.getByRole('region', { name: /Run r_state/ })).toBeTruthy();
  });

  it('shows nothing for an unknown scope rather than falling back to every run', () => {
    renderTab({ ...imported('edge'), scope: 'r_nope' });

    expect(screen.queryByRole('region', { name: /Run r_state/ })).toBeNull();
    expect(screen.getByText(/no runs to show/i)).toBeTruthy();
  });
});

describe('State — S2: the ops a delta carried, and the one that failed', () => {
  it('lists the patch ops of the selected delta', () => {
    renderTab(imported('edge'));

    fireEvent.click(screen.getByRole('radio', { name: /Frame 3 of 7/ }));

    expect(screen.getByTestId('op-r_state-0').textContent).toContain('/notes/-');
    expect(screen.getByTestId('op-r_state-1').textContent).toContain('/profile/tags/-');
  });

  it('shows no patch section for a snapshot, which carries none', () => {
    renderTab(imported('edge'));

    fireEvent.click(screen.getByRole('radio', { name: /Frame 1 of 7/ }));

    expect(screen.queryByTestId('op-r_state-0')).toBeNull();
    expect(screen.getByTestId('frame-r_state').getAttribute('data-kind')).toBe('snapshot');
  });

  it('marks the op at failure.opIndex, and only that one', () => {
    renderTab(imported('edge'));

    // Frame 4 replaced /counter successfully and then added to /missing/child, which does not
    // exist. The first op is not the bug and must not be drawn as though it were.
    fireEvent.click(screen.getByRole('radio', { name: /Frame 4 of 7/ }));

    expect(screen.getByTestId('op-r_state-0').getAttribute('data-failed')).toBe('false');
    expect(screen.getByTestId('op-r_state-1').getAttribute('data-failed')).toBe('true');
  });

  it('says why the op failed, in words rather than a symbol', () => {
    renderTab(imported('edge'));

    fireEvent.click(screen.getByRole('radio', { name: /Frame 4 of 7/ }));

    const failed = screen.getByTestId('op-r_state-1');
    expect(within(failed).getByText(/parent of that path does not exist/i)).toBeTruthy();
  });

  it('names the failing position in the frame summary, so it reads before any scrolling', () => {
    renderTab(imported('edge'));

    fireEvent.click(screen.getByRole('radio', { name: /Frame 4 of 7/ }));

    // 1-based, matching "op 2 of 2" as a reader counts them.
    expect(screen.getByTestId('failure-r_state').textContent).toMatch(/operation 2 of 2/i);
  });

  it('says the state did not advance past a failed delta', () => {
    renderTab(imported('edge'));

    fireEvent.click(screen.getByRole('radio', { name: /Frame 4 of 7/ }));

    // The model's own contract: `value` on a failed frame repeats the previous frame's. A
    // reader who took the tree below for the result of this patch would be reading a document
    // the patch never produced.
    expect(screen.getByTestId('failure-r_state').textContent).toMatch(/did not advance/i);
  });

  it('renders an op that is not a well-formed operation rather than dropping it', () => {
    renderTab(imported('edge'));

    // Frame 6 is `{"op":"frobnicate","path":"/counter"}` — shaped like an op, not one.
    fireEvent.click(screen.getByRole('radio', { name: /Frame 6 of 7/ }));

    const op = screen.getByTestId('op-r_state-0');
    expect(within(op).getByText('frobnicate')).toBeTruthy();
    expect(within(op).getByText(/not a well-formed JSON Patch operation/i)).toBeTruthy();
  });

  it('prints an entry that carries no op or path at all as the bytes that arrived', () => {
    const state = imported('edge');
    const wire = [{ path: '/counter' }] as unknown as StateFrame;
    const frames: StateFrame[] = [
      {
        kind: 'delta',
        seq: 1,
        tMs: 10,
        value: undefined,
        patch: [wire] as never,
        failure: { opIndex: 0, reason: 'invalid-op' },
      },
    ];
    renderTab(withRun(state, { stateTimeline: frames }));

    const op = screen.getByTestId('op-r_state-0');
    expect(within(op).getByTestId('op-raw-r_state-0').textContent).toContain('"/counter"');
  });
});

describe('State — S3: a failed patch is red at its position on the scrubber', () => {
  it('marks the failing positions and no others', () => {
    renderTab(imported('edge'));

    const failedPositions = screen
      .getAllByRole('radio')
      .map((el, index) => (el.getAttribute('data-failed') === 'true' ? index : -1))
      .filter((index) => index >= 0);

    // Positions 3 and 5 of 0..6. The point of S3 is that these are visible WITHOUT scrubbing:
    // a failure summarized at the end is one the reader still has to hunt for.
    expect(failedPositions).toEqual([3, 5]);
  });

  it('says a position failed in its accessible name, because a colour is not a claim', () => {
    renderTab(imported('edge'));

    expect(
      screen.getByRole('radio', {
        name: /Frame 4 of 7: delta at seq 5, patch failed — the parent of that path does not exist/,
      }),
    ).toBeTruthy();
  });

  it('marks the failed position on the malformed golden fixture', () => {
    renderTab(imported('malformed'));

    expect(tickMarks()).toEqual(['snapshot:false', 'delta:true']);
  });

  it('marks no position on a capture whose patches all applied', () => {
    renderTab(imported('happy'));

    expect(tickMarks()).toEqual(['snapshot:false', 'delta:false']);
    expect(screen.queryByTestId('state-failures-r_happy')).toBeNull();
  });

  it('counts the failed patches in the run heading', () => {
    renderTab(imported('edge'));

    expect(screen.getByTestId('state-failures-r_state').textContent).toBe('2 failed patches');
  });
});

describe('State — the scrubber is usable from the keyboard', () => {
  it('moves one frame at a time with the arrow keys', () => {
    renderTab(imported('edge'));

    const last = screen.getByRole('radio', { name: /Frame 7 of 7/ });
    fireEvent.keyDown(last, { key: 'ArrowLeft' });

    expect(screen.getByTestId('frame-r_state').getAttribute('data-index')).toBe('5');
  });

  it('jumps to the first and last frame with Home and End', () => {
    renderTab(imported('edge'));

    fireEvent.keyDown(screen.getByRole('radio', { name: /Frame 7 of 7/ }), { key: 'Home' });
    expect(screen.getByTestId('frame-r_state').getAttribute('data-index')).toBe('0');

    fireEvent.keyDown(screen.getByRole('radio', { name: /Frame 1 of 7/ }), { key: 'End' });
    expect(screen.getByTestId('frame-r_state').getAttribute('data-index')).toBe('6');
  });

  it('does not run off either end', () => {
    renderTab(imported('edge'));

    fireEvent.keyDown(screen.getByRole('radio', { name: /Frame 7 of 7/ }), { key: 'ArrowRight' });
    expect(screen.getByTestId('frame-r_state').getAttribute('data-index')).toBe('6');

    fireEvent.keyDown(screen.getByRole('radio', { name: /Frame 7 of 7/ }), { key: 'Home' });
    fireEvent.keyDown(screen.getByRole('radio', { name: /Frame 1 of 7/ }), { key: 'ArrowLeft' });
    expect(screen.getByTestId('frame-r_state').getAttribute('data-index')).toBe('0');
  });

  it('takes focus with it, or the reader is left on a position that is no longer selected', () => {
    renderTab(imported('edge'));

    fireEvent.keyDown(screen.getByRole('radio', { name: /Frame 7 of 7/ }), { key: 'ArrowLeft' });

    expect(document.activeElement).toBe(screen.getByRole('radio', { name: /Frame 6 of 7/ }));
  });

  it('keeps exactly one position in the tab order, so a long timeline is not a tab trap', () => {
    renderTab(imported('edge'));

    const reachable = screen
      .getAllByRole('radio')
      .filter((el) => el.getAttribute('tabindex') === '0');
    expect(reachable).toHaveLength(1);
    expect(reachable[0]?.getAttribute('aria-checked')).toBe('true');
  });
});

describe('State — jump to the frame that produced it', () => {
  it('selects the frame’s own record in Timeline, scoped to the run', () => {
    const store = renderTab(imported('edge'));

    fireEvent.click(screen.getByRole('radio', { name: /Frame 4 of 7/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Show frame 4 of 7 in Timeline' }));

    const next = store.get();
    expect(next.tab).toBe('timeline');
    expect(next.selectedSeq).toBe(5);
    expect(next.scope).toBe('r_state');
  });
});

describe('State — a redacted capture', () => {
  it('says the values below are placeholders rather than the state that was on the wire', () => {
    renderTab(redacted('edge'));

    const note = screen.getByTestId('state-redacted');
    expect(note.textContent).toMatch(/placeholder/i);
    // The sharpest consequence, measured on this very fixture: `counter` went 0 → 1 across
    // frames 1 and 2, and both render as `«redacted: 1 chars»`. Scrubbing a redacted capture
    // shows when and where state changed, never what it changed to.
    expect(note.textContent).toMatch(/what it changed to/i);
  });

  it('says nothing of the sort about a capture that was not redacted', () => {
    renderTab(imported('edge'));

    expect(screen.queryByTestId('state-redacted')).toBeNull();
  });

  it('still scrubs, and still marks the same failed positions', () => {
    // §11 keeps structure, ordering and JSON Pointer paths, so a path-based patch failure
    // survives redaction intact — the file is still a usable bug report about the patch.
    renderTab(redacted('edge'));

    expect(tickMarks()).toEqual([
      'snapshot:false',
      'delta:false',
      'delta:false',
      'delta:true',
      'delta:false',
      'delta:true',
      'delta:false',
    ]);
  });

  it('warns that a failed `test` is not evidence in a redacted capture', () => {
    // A `test` compares the op's value against the document's, and redaction replaces both with
    // placeholders sized by the original. Two different values of the same length collide, and
    // two values of different lengths stop matching — so the verdict here is about the redactor.
    const state = redacted('edge');
    const frames: StateFrame[] = [
      {
        kind: 'delta',
        seq: 3,
        tMs: 40,
        value: { counter: 1 },
        patch: [{ op: 'test', path: '/counter', value: 1 }],
        failure: { opIndex: 0, reason: 'test-failed' },
      },
    ];
    renderTab(withRun(state, { stateTimeline: frames }));

    expect(screen.getByTestId('op-r_state-0').textContent).toMatch(/cannot be known from this file/i);
  });

  it('does not warn about a `test` in a capture that was not redacted', () => {
    const frames: StateFrame[] = [
      {
        kind: 'delta',
        seq: 3,
        tMs: 40,
        value: { counter: 1 },
        patch: [{ op: 'test', path: '/counter', value: 1 }],
        failure: { opIndex: 0, reason: 'test-failed' },
      },
    ];
    renderTab(withRun(imported('edge'), { stateTimeline: frames }));

    expect(screen.getByTestId('op-r_state-0').textContent).not.toMatch(/cannot be known/i);
  });
});

describe('State — a live capture and a run still going', () => {
  it('renders a live capture the same way it renders an imported one', () => {
    const state = imported('edge');
    renderTab({ ...state, source: { kind: 'live', origin: 'http://localhost:3000' } });

    expect(screen.getByTestId('state-frames-r_state').textContent).toBe('7 frames');
  });

  it('says a run that has not finished may still produce frames', () => {
    // A timeline that is still growing is a real state. Drawing the last frame as "the" state
    // would present a run mid-flight as one that ended there.
    renderTab(withRun(imported('edge'), { outcome: 'running', endedAtMs: undefined }));

    expect(screen.getByTestId('state-streaming-r_state').textContent).toMatch(/still/i);
  });

  it('does not say so for a run that finished', () => {
    renderTab(imported('edge'));

    expect(screen.queryByTestId('state-streaming-r_state')).toBeNull();
  });

  it('reports the run outcome, so a run that never terminated is not read as finished', () => {
    renderTab(imported('malformed'));

    expect(screen.getByTestId('state-outcome-r_bad').textContent).toBe('aborted');
  });
});

describe('State — a frame with no document at all', () => {
  it('says nothing has been snapshotted rather than printing `undefined`', () => {
    const frames: StateFrame[] = [
      {
        kind: 'delta',
        seq: 3,
        tMs: 40,
        value: undefined,
        patch: [{ op: 'replace', path: '/counter', value: 1 }],
        failure: { opIndex: 0, reason: 'parent-not-found' },
      },
    ];
    renderTab(withRun(imported('edge'), { stateTimeline: frames }));

    expect(screen.getByText(/no state document at this frame/i)).toBeTruthy();
  });
});
