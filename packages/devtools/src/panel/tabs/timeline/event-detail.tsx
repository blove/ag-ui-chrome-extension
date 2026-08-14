import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { CaptureRecord, Issue, PatchFailure } from '../../../core/model/types';
import { formatDuration } from '../../common/format';
import { issuesBySeq, selectedRecord } from '../../model/selectors';
import type { PanelState } from '../../model/panel-types';
import type { PanelStore } from '../../model/store';
import { usePanelState } from '../../model/use-panel-state';

export interface EventDetailProps {
  store: PanelStore;
}

/**
 * The reason a JSON Patch op failed is not on `Issue` — only `opIndex` and `path` are. It lives
 * on the `delta` arm of `StateFrame`, so it has to be read back off the run's state timeline.
 * `StateFrame` is a union: `patch` and `failure` exist on `kind === 'delta'` only.
 */
function patchFailureReason(state: PanelState, issue: Issue): PatchFailure | undefined {
  const runs =
    issue.runId === undefined ? state.runs : state.runs.filter((r) => r.runId === issue.runId);
  for (const run of runs) {
    for (const frame of run.stateTimeline) {
      if (frame.kind !== 'delta') continue;
      if (frame.seq !== issue.seq) continue;
      if (frame.failure !== undefined) return frame.failure.reason;
    }
  }
  return undefined;
}

function renderValue(value: unknown): JSX.Element {
  if (typeof value === 'string') return <span class="agui-detail__scalar">{value}</span>;
  if (value === null || typeof value !== 'object') {
    return <span class="agui-detail__scalar">{String(value)}</span>;
  }
  return <pre class="agui-detail__json">{JSON.stringify(value, null, 2)}</pre>;
}

function rawText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  const json = JSON.stringify(raw, null, 2);
  return json === undefined ? 'undefined' : json;
}

function Verdict({ issues, state }: { issues: Issue[]; state: PanelState }): JSX.Element | null {
  if (issues.length === 0) return null;
  return (
    <section class="agui-detail__verdict" aria-label="Verdict">
      <ul>
        {issues.map((issue) => {
          const reason =
            issue.code === 'state-patch-failed' ? patchFailureReason(state, issue) : undefined;
          return (
            <li key={`${issue.code}@${issue.seq}`} data-severity={issue.severity}>
              <p class="agui-detail__verdict-head">
                <span class="agui-detail__severity">{issue.severity}</span>{' '}
                <code>{issue.code}</code>
              </p>
              <p class="agui-detail__verdict-message">{issue.message}</p>
              {issue.code === 'state-patch-failed' ? (
                <dl class="agui-detail__fields">
                  <dt>operation index</dt>
                  <dd>{issue.opIndex === undefined ? '—' : String(issue.opIndex)}</dd>
                  <dt>reason</dt>
                  <dd>{reason ?? 'unknown'}</dd>
                  <dt>path</dt>
                  <dd>{issue.path ?? '—'}</dd>
                </dl>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Payload({ record }: { record: CaptureRecord }): JSX.Element {
  if (record.kind === 'keepalive') {
    return (
      <section class="agui-detail__payload" aria-label="Payload">
        <dl class="agui-detail__fields">
          <dt>kind</dt>
          <dd>keepalive</dd>
          <dt>comment</dt>
          <dd>{record.comment === '' ? '(empty heartbeat)' : record.comment}</dd>
        </dl>
      </section>
    );
  }
  const event = record.event;
  if (event === null) {
    return (
      <section class="agui-detail__payload" aria-label="Payload">
        <p>This frame could not be decoded into an event. The bytes are under raw, below.</p>
      </section>
    );
  }
  const fields = Object.entries(event).filter(([key]) => key !== 'type');
  return (
    <section class="agui-detail__payload" aria-label="Payload">
      <dl class="agui-detail__fields">
        {/* HTML5 allows a dt/dd pair to be grouped in a div inside a dl, which is what gives
            each field a stable key without a keyless fragment. */}
        <div class="agui-detail__field">
          <dt>type</dt>
          <dd>{event.type}</dd>
        </div>
        {fields.map(([key, value]) => (
          <div class="agui-detail__field" key={key}>
            <dt>{key}</dt>
            <dd>{renderValue(value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function EventDetail({ store }: EventDetailProps): JSX.Element {
  const state = usePanelState(store);
  const [showRaw, setShowRaw] = useState(false);
  /*
   * `selectedRecord` looks the seq up in `state.records`, not in `visibleRecords`, and that is
   * load-bearing: `setTextFilter` and `toggleIssuesOnly` deliberately do not clear
   * `selectedSeq` — losing the selection mid-keystroke is worse than keeping it — so the
   * selected record is routinely one the list is no longer showing. It still gets a detail pane.
   */
  const record = selectedRecord(state);

  if (record === undefined) {
    return (
      <section class="agui-detail" aria-label="Event detail">
        <p class="agui-detail__empty">Select an event to see its detail.</p>
      </section>
    );
  }

  // Annotation reads the seq index, never `record.issues`, which is empty on the import path.
  const issues = issuesBySeq(state).get(record.seq) ?? [];

  return (
    <section class="agui-detail" aria-label="Event detail">
      <h2 class="agui-detail__title">
        seq {record.seq} · {formatDuration(record.tMs)} · {record.connId}
      </h2>
      {/* Order is load-bearing: verdict, then payload, then raw. P2 has no Issues tab, so this
          is the only place a validator finding is explained. */}
      <Verdict issues={issues} state={state} />
      <Payload record={record} />
      <section class="agui-detail__raw" aria-label="Raw frame">
        <button
          type="button"
          aria-expanded={showRaw}
          onClick={() => {
            setShowRaw((prev) => !prev);
          }}
        >
          raw
        </button>
        {showRaw ? <pre class="agui-detail__json">{rawText(record.raw)}</pre> : null}
      </section>
    </section>
  );
}
