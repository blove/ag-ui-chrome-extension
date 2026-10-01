import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/preact';
import type { ArmCommand } from '../../core/simulate/commands';
import { templateScript } from '../../core/simulate/templates';
import type { ThreadplaneDevtoolsReport } from '../../core/signals/report';
import type { CaptureRecord, Run } from '../../core/model/types';
import { initialPanelState, type PanelState } from '../model/panel-types';
import { createPanelStore, type PanelStore } from '../model/store';
import { Simulate } from './simulate';
import { NO_HOOK_MESSAGE } from './simulate-model';

const ORIGIN = 'http://localhost:5173';
const FAULT_WORDS =
  /\b(not detected|detection|failed|failure|error|unable|could not|missing|broken|none found|no agents)\b/i;

function state(devMode: boolean, extra: Partial<PanelState> = {}): PanelState {
  return {
    ...initialPanelState(),
    tab: 'simulate',
    capture: { kind: 'on', origin: ORIGIN },
    source: { kind: 'live', origin: ORIGIN },
    developerModes: { [ORIGIN]: devMode },
    ...extra,
  };
}

interface Rendered {
  store: PanelStore;
  onArm: ReturnType<typeof vi.fn<(command: ArmCommand) => void>>;
  onDisarm: ReturnType<typeof vi.fn<(armId: string) => void>>;
}

function renderTab(initial: PanelState, live = true): Rendered {
  const store = createPanelStore(initial);
  const onArm = vi.fn<(command: ArmCommand) => void>();
  const onDisarm = vi.fn<(armId: string) => void>();
  render(
    live ? (
      <Simulate store={store} onArm={onArm} onDisarm={onDisarm} onSetDeveloperMode={() => undefined} />
    ) : (
      <Simulate store={store} />
    ),
  );
  return { store, onArm, onDisarm };
}

function armButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Arm' }) as HTMLButtonElement;
}

function editor(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'Script (JSON runs)' }) as HTMLTextAreaElement;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Simulate tab — the second lock (R6)', () => {
  it('disables Arm with the reason while Developer mode is off', () => {
    renderTab(state(false));
    expect(armButton().disabled).toBe(true);
    expect(screen.getByText('Developer mode is off for http://localhost:5173. Turn it on above to arm.')).toBeTruthy();
  });

  it('disables Arm with the reason when capture is not enabled for the origin', () => {
    renderTab({ ...initialPanelState(), tab: 'simulate', capture: { kind: 'off', origin: 'https://app.test', signal: { level: 'none' } } });
    expect(armButton().disabled).toBe(true);
    expect(screen.getByText(/Capture is not enabled for https:\/\/app\.test/)).toBeTruthy();
  });

  it('enables Arm with Developer mode on, and offers the switch on the tab itself', () => {
    renderTab(state(true));
    expect(armButton().disabled).toBe(false);
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(true);
  });

  it('states that only the top frame’s agent is reached (R7)', () => {
    renderTab(state(true));
    expect(screen.getByText(/top frame only — an agent inside an iframe is not scripted/)).toBeTruthy();
  });
});

describe('Simulate tab — templates and the editor', () => {
  it('infers LangGraph from the Signals reports and fills the editor with that adapter’s template', () => {
    const report = { v: 1, agent: 'a', adapter: 'langgraph', seq: 1, eventType: 'values', wrote: ['values'], tMs: 1 } as ThreadplaneDevtoolsReport;
    renderTab(state(true, { signals: { reports: [report], droppedBefore: 0 } }));
    expect((screen.getByRole('combobox', { name: 'Adapter' }) as HTMLSelectElement).value).toBe('langgraph');
    expect(screen.getByText(/from this page’s Signals reports/)).toBeTruthy();
    expect(JSON.parse(editor().value)).toEqual(templateScript('langgraph', 'interrupt').runs);
  });

  it('the adapter is overridable, and a template switch refills the editor', () => {
    renderTab(state(true));
    fireEvent.change(screen.getByRole('combobox', { name: 'Adapter' }), { target: { value: 'langgraph' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Template' }), { target: { value: 'malformed-event' } });
    expect(JSON.parse(editor().value)).toEqual(templateScript('langgraph', 'malformed-event').runs);
  });

  it('shows the validator’s reason inline and disables Arm for a broken script', () => {
    renderTab(state(true));
    fireEvent.input(editor(), { target: { value: '[{"frames": []}]' } });
    expect(screen.getByRole('alert').textContent).toBe('runs[0] is missing "events"');
    expect(armButton().disabled).toBe(true);
    fireEvent.input(editor(), { target: { value: '[{' } });
    expect(screen.getByRole('alert').textContent).toMatch(/^The script is not valid JSON/);
  });

  it('shows the size against the 2 MB limit', () => {
    renderTab(state(true));
    expect(screen.getByText(/KB of 2 MB$/)).toBeTruthy();
  });

  it('Arm sends the edited script as a validated command and lists it', () => {
    const { onArm, store } = renderTab(state(true));
    fireEvent.click(armButton());
    expect(onArm).toHaveBeenCalledTimes(1);
    const command = onArm.mock.calls[0]?.[0];
    expect(command).toMatchObject({ v: 1, adapter: 'ag-ui', runs: templateScript('ag-ui', 'interrupt').runs });
    expect(command?.armId).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
    expect(store.get().simArmLabels[command?.armId ?? '']).toEqual({ template: 'Interrupt (approval)', runs: 2 });
  });

  it('replays a captured run: lists the capture’s runs by id and fills the editor with its frames', () => {
    const records: CaptureRecord[] = [
      { kind: 'event', seq: 0, tMs: 0, connId: 'c1', raw: {}, issues: [], event: { type: 'RUN_STARTED', threadId: 't', runId: 'r1' } },
      { kind: 'event', seq: 1, tMs: 1, connId: 'c1', raw: {}, issues: [], event: { type: 'RUN_FINISHED', threadId: 't', runId: 'r1' } },
    ];
    const runs = [{ runId: 'r1', recordSeqs: [0, 1] }] as unknown as Run[];
    renderTab(state(true, { records, runs }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Template' }), { target: { value: 'replay' } });
    const pick = screen.getByRole('combobox', { name: 'Captured run' }) as HTMLSelectElement;
    expect([...pick.options].map((option) => option.textContent)).toEqual(['r1 — AG-UI, 2 frames']);
    expect(JSON.parse(editor().value)).toEqual([
      { events: [{ type: 'RUN_STARTED', threadId: 't', runId: 'r1' }, { type: 'RUN_FINISHED', threadId: 't', runId: 'r1' }] },
    ]);
  });

  it('says there is nothing to replay before any run is captured', () => {
    renderTab(state(true));
    fireEvent.change(screen.getByRole('combobox', { name: 'Template' }), { target: { value: 'replay' } });
    expect(screen.getByText(/No captured runs to replay yet/)).toBeTruthy();
    expect(armButton().disabled).toBe(true);
  });
});

describe('Simulate tab — the arm list', () => {
  it('shows armed → consumed from the acks, and Cancel disarms', () => {
    const { onDisarm } = renderTab(
      state(true, {
        simArmLabels: { a1: { template: 'Interrupt (approval)', runs: 2 } },
        simulator: {
          dispatches: [{ armId: 'a1', action: 'arm', outcome: 'dispatched' }],
          acks: [
            { v: 1, armId: 'a1', state: 'armed' },
            { v: 1, armId: 'a1', state: 'consumed', run: 0 },
          ],
        },
      }),
    );
    const row = screen.getByRole('listitem');
    expect(row.getAttribute('data-state')).toBe('consumed');
    expect(within(row).getByText('consumed run 1 of 2')).toBeTruthy();
    expect(within(row).getByText('armed → consumed run 1 of 2')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel' }));
    expect(onDisarm).toHaveBeenCalledWith('a1');
  });

  it('shows the dispatch outcome when the extension did not send it', () => {
    renderTab(state(true, { simulator: { dispatches: [{ armId: 'a1', action: 'arm', outcome: 'developer-mode-off' }], acks: [] } }));
    expect(screen.getByText('not sent: Developer mode is off for http://localhost:5173')).toBeTruthy();
  });

  it('after ~2 s with no ack, says no Threadplane hook answered — in words that name no fault', () => {
    vi.useFakeTimers();
    renderTab(state(true, { simulator: { dispatches: [{ armId: 'a1', action: 'arm', outcome: 'dispatched' }], acks: [] } }));
    expect(screen.queryByText(NO_HOOK_MESSAGE)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1900);
    });
    expect(screen.queryByText(NO_HOOK_MESSAGE)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByText(NO_HOOK_MESSAGE)).toBeTruthy();
    expect(NO_HOOK_MESSAGE).toBe(
      'no Threadplane hook answered — the app must be a Threadplane development build (0.3.0 or later) with an agent created on the page',
    );
    expect(FAULT_WORDS.exec(NO_HOOK_MESSAGE)).toBeNull();
  });

  it('an ack that arrives clears the no-hook note', () => {
    vi.useFakeTimers();
    const { store } = renderTab(state(true, { simulator: { dispatches: [{ armId: 'a1', action: 'arm', outcome: 'dispatched' }], acks: [] } }));
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(screen.getByText(NO_HOOK_MESSAGE)).toBeTruthy();
    act(() => {
      store.update((s) => ({ ...s, simulator: { ...s.simulator, acks: [{ v: 1, armId: 'a1', state: 'armed' }] } }));
    });
    expect(screen.queryByText(NO_HOOK_MESSAGE)).toBeNull();
  });
});
