/**
 * The Simulate tab (§14.4, design R9): script the inspected page's next agent run(s).
 *
 * Pick a template for an adapter (inferred, overridable), edit it as JSON, Arm. The arm list then
 * says what the extension did with it (the worker's `sim-dispatch`) and what the page's hook did
 * (its acks, R4). Arm is disabled — with the reason — until capture is on for the inspected origin
 * and Developer mode is on for it (R6); the worker and the relay check again regardless.
 */
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ArmCommand, SimAdapter } from '../../core/simulate/commands';
import {
  armCommand,
  replayScript,
  TEMPLATE_IDS,
  TEMPLATE_LABELS,
  templateScript,
  type ArmScript,
  type TemplateId,
} from '../../core/simulate/templates';
import type { PanelStore } from '../model/store';
import { noteArm } from '../model/store';
import { usePanelState } from '../model/use-panel-state';
import { DeveloperModeSwitch } from './developer-mode';
import {
  ADAPTER_LABELS,
  armDisabledReason,
  armRows,
  checkScript,
  formatSize,
  inferAdapter,
  NO_HOOK_AFTER_MS,
  NO_HOOK_MESSAGE,
  replayableRuns,
  TOP_FRAME_NOTE,
  type AdapterSource,
  type ArmRow,
} from './simulate-model';

export interface SimulateProps {
  store: PanelStore;
  /** Send an arm to the worker. Absent outside a live panel, which disables Arm. */
  onArm?: (command: ArmCommand) => void;
  onDisarm?: (armId: string) => void;
  onSetDeveloperMode?: (enabled: boolean) => void;
}

type Choice = TemplateId | 'replay';

const ADAPTER_SOURCE_NOTE: Readonly<Record<AdapterSource, string>> = {
  signals: 'from this page’s Signals reports',
  connections: 'from this page’s connections',
  default: 'no agent seen on this page yet — choose the app’s adapter',
};

function pretty(runs: unknown): string {
  return JSON.stringify(runs, null, 2);
}

/** A fresh, validator-safe arm id: a UUID is 36 characters of hex and dashes. */
function mintArmId(): string {
  return crypto.randomUUID();
}

function ArmItem({ row, silent, onDisarm }: { row: ArmRow; silent: boolean; onDisarm?: (armId: string) => void }): JSX.Element {
  const state = row.awaitingHook ? 'sent' : row.status.startsWith('not sent') ? 'not-sent' : (row.status.split(/[ :]/, 1)[0] ?? 'unknown');
  return (
    <li class="agui-simulate__arm" data-arm-id={row.armId} data-state={state}>
      <div class="agui-simulate__arm-head">
        <span class="agui-simulate__arm-label">{row.label ?? 'Arm'}</span>{' '}
        <code class="agui-simulate__arm-id" title={row.armId}>
          {row.armId.slice(0, 8)}
        </code>
        <span class="agui-simulate__arm-status">{row.status}</span>
        {row.cancellable && onDisarm !== undefined && (
          <button type="button" class="agui-simulate__cancel" onClick={() => onDisarm(row.armId)}>
            Cancel
          </button>
        )}
      </div>
      {row.history.length > 1 && <p class="agui-simulate__arm-history">{row.history.join(' → ')}</p>}
      {row.awaitingHook && silent && <p class="agui-simulate__arm-note">{NO_HOOK_MESSAGE}</p>}
      {row.cancelNote !== undefined && <p class="agui-simulate__arm-note">{row.cancelNote}</p>}
    </li>
  );
}

export function Simulate({ store, onArm, onDisarm, onSetDeveloperMode }: SimulateProps): JSX.Element {
  const state = usePanelState(store);
  const inferred = inferAdapter(state);
  const [override, setOverride] = useState<SimAdapter | null>(null);
  const [choice, setChoice] = useState<Choice>('interrupt');
  const [replayRunId, setReplayRunId] = useState<string | null>(null);

  const replayable = replayableRuns(state);
  const replayRun = choice === 'replay' ? (replayable.find((run) => run.runId === replayRunId) ?? replayable[0]) : undefined;
  // A replay is in the captured run's own adapter; otherwise the user's choice, else the inference.
  const adapter: SimAdapter = replayRun?.adapter ?? override ?? inferred.adapter;
  const replayId = replayRun?.runId ?? null;

  function scriptFor(): string {
    if (choice !== 'replay') return pretty(templateScript(adapter, choice).runs);
    if (replayId === null) return '';
    const current = store.get();
    const run = current.runs.find((candidate) => candidate.runId === replayId);
    return run === undefined ? '' : pretty(replayScript(adapter, current.records, run.recordSeqs).runs);
  }

  const [text, setText] = useState<string>(scriptFor);
  // A new template, adapter or captured run starts the editor over. Captured records arriving do
  // not: a live capture grows all the time, and the user's edits must survive it.
  useEffect(() => {
    setText(scriptFor());
  }, [choice, adapter, replayId]);

  const rows = armRows(state);
  const waiting = rows.filter((row) => row.awaitingHook).map((row) => row.armId);
  const waitingKey = waiting.join(',');
  const [silent, setSilent] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (waitingKey === '') return;
    const ids = waitingKey.split(',');
    const timer = setTimeout(() => {
      setSilent((prev) => new Set([...prev, ...ids]));
    }, NO_HOOK_AFTER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [waitingKey]);

  const noRuns = choice === 'replay' && replayRun === undefined;
  const check = noRuns ? null : checkScript(adapter, text);
  const reason = armDisabledReason(state, onArm !== undefined);
  const canArm = reason === null && check?.ok === true;

  function arm(): void {
    if (!canArm || !check.ok || onArm === undefined) return;
    const armId = mintArmId();
    const script = { adapter, runs: check.runs } as ArmScript;
    const label = choice === 'replay' ? `Replay of ${replayId ?? 'a captured run'}` : TEMPLATE_LABELS[choice];
    store.update((s) => noteArm(s, armId, { template: label, runs: check.runs.length }));
    onArm(armCommand(armId, script));
  }

  return (
    <section class="agui-simulate" aria-label="Simulate">
      <DeveloperModeSwitch store={store} {...(onSetDeveloperMode !== undefined ? { onSet: onSetDeveloperMode } : {})} />
      <p class="agui-simulate__note">{TOP_FRAME_NOTE}</p>

      <div class="agui-simulate__pickers">
        <label class="agui-simulate__field">
          <span>Template</span>
          <select
            aria-label="Template"
            value={choice}
            onChange={(event) => setChoice((event.currentTarget as HTMLSelectElement).value as Choice)}
          >
            {TEMPLATE_IDS.map((id) => (
              <option key={id} value={id}>
                {TEMPLATE_LABELS[id]}
              </option>
            ))}
            <option value="replay">{TEMPLATE_LABELS.replay}</option>
          </select>
        </label>

        {choice === 'replay' ? (
          replayable.length > 0 ? (
            <label class="agui-simulate__field">
              <span>Captured run</span>
              <select
                aria-label="Captured run"
                value={replayId ?? ''}
                onChange={(event) => setReplayRunId((event.currentTarget as HTMLSelectElement).value)}
              >
                {replayable.map((run) => (
                  <option key={run.runId} value={run.runId}>
                    {run.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p class="agui-simulate__note">No captured runs to replay yet — capture or import one first.</p>
          )
        ) : (
          <label class="agui-simulate__field">
            <span>Adapter</span>
            <select
              aria-label="Adapter"
              value={adapter}
              onChange={(event) => setOverride((event.currentTarget as HTMLSelectElement).value as SimAdapter)}
            >
              {(['ag-ui', 'langgraph'] as const).map((id) => (
                <option key={id} value={id}>
                  {ADAPTER_LABELS[id]}
                </option>
              ))}
            </select>
            <span class="agui-simulate__hint">
              {override === null || override === inferred.adapter ? ADAPTER_SOURCE_NOTE[inferred.from] : 'chosen by you'}
            </span>
          </label>
        )}
      </div>

      <label class="agui-simulate__editor-label" for="agui-simulate-editor">
        Script (JSON runs)
      </label>
      <textarea
        id="agui-simulate-editor"
        class="agui-simulate__editor"
        spellcheck={false}
        rows={14}
        value={text}
        aria-invalid={check !== null && !check.ok}
        onInput={(event) => setText((event.currentTarget as HTMLTextAreaElement).value)}
      />
      <div class="agui-simulate__status">
        {check?.chars !== undefined && <span class="agui-simulate__size">{formatSize(check.chars)}</span>}
        {check !== null && !check.ok && (
          <span class="agui-simulate__error" role="alert">
            {check.reason}
          </span>
        )}
      </div>

      <div class="agui-simulate__actions">
        <button type="button" class="agui-simulate__arm-button" disabled={!canArm} onClick={arm}>
          Arm
        </button>
        {reason !== null && <span class="agui-simulate__reason">{reason}</span>}
      </div>

      <h3 class="agui-simulate__heading">Arms</h3>
      {rows.length === 0 ? (
        <p class="agui-simulate__note">Nothing armed on this tab yet.</p>
      ) : (
        <ul class="agui-simulate__arms">
          {rows.map((row) => (
            <ArmItem
              key={row.armId}
              row={row}
              silent={silent.has(row.armId)}
              {...(onDisarm !== undefined ? { onDisarm } : {})}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
