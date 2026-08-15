/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/preact';
// `?raw` rather than `readFileSync(new URL(...))`: under the jsdom project `import.meta.url` is
// not a filesystem URL, so the node-style read resolves to the wrong path.
import happyJsonl from '../../../test/fixtures/happy-run.agui.jsonl?raw';
import malformedJsonl from '../../../test/fixtures/malformed.agui.jsonl?raw';
import edgeJsonl from '../../../test/fixtures/messages-edge.agui.jsonl?raw';
import { encodeJsonl } from '../../../core/jsonl/codec';
import { ALL_REDACTION_GROUPS } from '../../../core/jsonl/redact';
import { buildExport } from '../../export/build';
import { applyLoaded } from '../../import/apply-loaded';
import { loadJsonl } from '../../import/load-jsonl';
import { initialPanelState, type PanelState } from '../../model/panel-types';
import { createPanelStore } from '../../model/store';
import { Messages } from './messages';

type FixtureName = 'happy' | 'malformed' | 'edge';

const TEXT: Record<FixtureName, string> = {
  happy: happyJsonl,
  malformed: malformedJsonl,
  edge: edgeJsonl,
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

/** Every conversation row, in DOM order, as `kind:id`. */
function rowIds(): string[] {
  return [...document.querySelectorAll('[data-item-id]')].map(
    (el) => `${el.getAttribute('data-item-kind') ?? '?'}:${el.getAttribute('data-item-id') ?? '?'}`,
  );
}

function renderTab(state: PanelState): ReturnType<typeof createPanelStore> {
  const store = createPanelStore(state);
  render(<Messages store={store} />);
  return store;
}

describe('Messages — empty', () => {
  it('says there is no conversation rather than rendering a blank pane', () => {
    renderTab(initialPanelState());

    expect(screen.getByRole('region', { name: 'Messages' })).toBeTruthy();
    expect(screen.getByText(/no runs to show/i)).toBeTruthy();
  });

  it('says a run carried no conversation at all, rather than dropping the run', () => {
    const state = imported('happy');
    const [run] = state.runs;
    expect(run).toBeDefined();
    renderTab({
      ...state,
      runs: [{ ...run!, input: undefined, messages: new Map(), toolCalls: new Map() }],
    });

    expect(screen.getByText(/carried no messages/i)).toBeTruthy();
  });
});

describe('Messages — M1: one conversation, ordered, tool calls inline', () => {
  it('puts the request turn first and the tool call at its position in time', () => {
    renderTab(imported('happy'));

    expect(rowIds()).toEqual(['input:m_user_1', 'message:m_1', 'tool:tc_1']);
  });

  it('renders the turn the app sent, marked as coming from the request', () => {
    renderTab(imported('happy'));

    const turn = screen.getByTestId('item-m_user_1');
    expect(turn.getAttribute('data-role')).toBe('user');
    expect(within(turn).getByText('What is the weather in Paris?')).toBeTruthy();
    // Attribution is the whole point: a turn the page sent is not evidence about the stream.
    expect(within(turn).getByText(/from the request/i)).toBeTruthy();
  });

  it('renders the streamed assistant text exactly as reconstructed', () => {
    renderTab(imported('happy'));

    const body = screen.getByTestId('content-m_1');
    expect(body.textContent).toBe('The weather in Paris is sunny and 24 degrees.\nEnjoy!');
  });

  it('scopes to the selected run', () => {
    renderTab({ ...imported('happy'), scope: 'r_happy' });

    expect(screen.getByRole('region', { name: /Run r_happy/ })).toBeTruthy();
  });

  it('shows nothing for an unknown scope rather than falling back to every run', () => {
    renderTab({ ...imported('happy'), scope: 'r_nope' });

    expect(screen.queryByRole('region', { name: /Run r_happy/ })).toBeNull();
    expect(screen.getByText(/no runs to show/i)).toBeTruthy();
  });
});

describe('Messages — M2: do the arguments parse?', () => {
  it('names the tool call and reports arguments that parsed', () => {
    renderTab(imported('happy'));

    const call = screen.getByTestId('item-tc_1');
    expect(call.getAttribute('data-args')).toBe('parsed');
    expect(within(call).getByText('get_weather')).toBeTruthy();
    expect(within(call).getByText('arguments parsed')).toBeTruthy();
  });

  it('states that arguments never parsed without anything being expanded first', () => {
    renderTab(imported('edge'));

    const call = screen.getByTestId('item-tc_bad');
    expect(call.getAttribute('data-args')).toBe('failed');
    // Unmissable means visible in the collapsed row. A verdict a reader has to click to find is
    // a verdict most readers never see.
    expect(within(call).getByText('arguments never parsed')).toBeTruthy();
  });

  it('shows the bytes that failed and the parser error when the arguments are expanded', () => {
    renderTab(imported('edge'));

    fireEvent.click(screen.getByRole('button', { name: 'Arguments of tc_bad' }));
    const args = screen.getByRole('region', { name: 'Arguments of tc_bad' });
    // The truncated JSON exactly as it came off the wire — that is the evidence.
    expect(within(args).getByTestId('args-text-tc_bad').textContent).toBe('{"city": "Par');
    expect(within(args).getByTestId('args-error-tc_bad').textContent).toMatch(/JSON/);
  });

  it('expands arguments and result independently', () => {
    renderTab(imported('happy'));

    const argsToggle = screen.getByRole('button', { name: 'Arguments of tc_1' });
    const resultToggle = screen.getByRole('button', { name: 'Result of tc_1' });
    expect(argsToggle.getAttribute('aria-expanded')).toBe('false');
    expect(resultToggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(argsToggle);
    expect(screen.getByRole('button', { name: 'Arguments of tc_1' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Result of tc_1' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', { name: 'Result of tc_1' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Result of tc_1' }));
    const result = screen.getByRole('region', { name: 'Result of tc_1' });
    expect(result.textContent).toContain('{"tempC":24,"summary":"Sunny"}');
  });

  it('renders parsed arguments as a tree, so a type confusion is visible', () => {
    renderTab(imported('happy'));

    fireEvent.click(screen.getByRole('button', { name: 'Arguments of tc_1' }));
    const args = screen.getByRole('region', { name: 'Arguments of tc_1' });
    expect(within(args).getByText('"Paris"').getAttribute('data-type')).toBe('string');
  });

  it('says a result has not arrived rather than showing an empty box', () => {
    const state = imported('happy');
    const [run] = state.runs;
    expect(run).toBeDefined();
    const call = run!.toolCalls.get('tc_1');
    expect(call).toBeDefined();
    const toolCalls = new Map(run!.toolCalls);
    toolCalls.set('tc_1', { ...call!, result: undefined, resultAtMs: undefined });
    renderTab({ ...state, runs: [{ ...run!, toolCalls }] });

    expect(within(screen.getByTestId('item-tc_1')).getByText(/no result/i)).toBeTruthy();
  });
});

describe('Messages — M3: reasoning is distinct and collapsed', () => {
  it('does not mount a reasoning message body until it is asked for', () => {
    renderTab(imported('edge'));

    const reasoning = screen.getByTestId('item-m_think');
    expect(reasoning.getAttribute('data-kind')).toBe('reasoning');
    expect(screen.queryByTestId('content-m_think')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Reasoning m_think' }));
    expect(screen.getByTestId('content-m_think').textContent).toContain('The user asked for Paris');
  });

  it('leaves a text message open, because that is what the reader came for', () => {
    renderTab(imported('happy'));

    expect(screen.getByTestId('item-m_1').getAttribute('data-kind')).toBe('text');
    expect(screen.getByTestId('content-m_1')).toBeTruthy();
  });
});

describe('Messages — M4: a message that never closed says so', () => {
  it('labels an unclosed message streaming', () => {
    renderTab(imported('edge'));

    const streaming = screen.getByTestId('item-m_1');
    expect(streaming.getAttribute('data-streaming')).toBe('true');
    expect(within(streaming).getByText('streaming')).toBeTruthy();
  });

  it('does not label a closed message', () => {
    renderTab(imported('happy'));

    const closed = screen.getByTestId('item-m_1');
    expect(closed.getAttribute('data-streaming')).toBe('false');
    expect(within(closed).queryByText('streaming')).toBeNull();
  });
});

describe('Messages — M5: jump to the frames that produced it', () => {
  it('selects the message content frames in Timeline', () => {
    const store = renderTab(imported('happy'));

    fireEvent.click(screen.getByRole('button', { name: 'Show m_1 in Timeline' }));

    const next = store.get();
    expect(next.tab).toBe('timeline');
    // m_1's content arrived on seqs 3, 4 and 5; the selection lands on the first of them.
    expect(next.selectedSeq).toBe(3);
    // Scoped too, or the jump could land on a run the Timeline is filtered away from.
    expect(next.scope).toBe('r_happy');
  });

  it('offers no jump for a message that produced no content frames', () => {
    const state = imported('happy');
    const [run] = state.runs;
    expect(run).toBeDefined();
    const message = run!.messages.get('m_1');
    expect(message).toBeDefined();
    const messages = new Map(run!.messages);
    messages.set('m_1', { ...message!, contentSeqs: [] });
    renderTab({ ...state, runs: [{ ...run!, messages }] });

    const button = screen.getByRole('button', { name: 'Show m_1 in Timeline' });
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('names how many frames the jump is anchored to', () => {
    renderTab(imported('happy'));

    expect(screen.getByTestId('frames-m_1').textContent).toBe('3 frames');
  });
});

describe('Messages — a redacted capture', () => {
  it('renders placeholders where the content was, keeping the structure readable', () => {
    renderTab(redacted('happy'));

    // The turn the app sent is redacted too — `redactLine` covers the request body.
    expect(within(screen.getByTestId('item-m_user_1')).getByText(/«redacted: \d+ chars»/)).toBeTruthy();
    expect(screen.getByTestId('content-m_1').textContent).toMatch(/«redacted: \d+ chars»/);
    // Structure survives §11, so the tool is still named and still attributed.
    expect(within(screen.getByTestId('item-tc_1')).getByText('get_weather')).toBeTruthy();
  });

  it('does not report redacted arguments as a protocol bug', () => {
    // The placeholder is not JSON, so a redacted capture's tool arguments genuinely do not
    // parse. Reporting that as "arguments never parsed" would send a colleague hunting a bug
    // the redactor caused — the failure mode this tab is least allowed to have.
    renderTab(redacted('happy'));

    const call = screen.getByTestId('item-tc_1');
    expect(call.getAttribute('data-args')).toBe('redacted');
    expect(within(call).getByText('arguments redacted')).toBeTruthy();
  });
});

describe('Messages — a live capture and a run carrying issues', () => {
  it('renders a live capture the same way it renders an imported one', () => {
    const state = imported('happy');
    renderTab({ ...state, source: { kind: 'live', origin: 'http://localhost:3000' } });

    expect(rowIds()).toEqual(['input:m_user_1', 'message:m_1', 'tool:tc_1']);
  });

  it('counts the run issues in the run heading', () => {
    renderTab(imported('edge'));

    // tool-args-not-json, run-never-terminated, unclosed-message.
    expect(screen.getByTestId('run-issues-r_edge').textContent).toBe('3 issues');
  });

  it('reports the run outcome, so a run that never terminated is not read as finished', () => {
    renderTab(imported('malformed'));

    expect(screen.getByTestId('run-outcome-r_bad').textContent).toBe('aborted');
  });
});
