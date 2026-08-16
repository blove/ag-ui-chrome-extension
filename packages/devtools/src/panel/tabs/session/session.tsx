import type { JSX } from 'preact';
import type { AgentInfo, RuntimeInfo } from '../../../core/detect/info';
import type { PanelState, PanelSource, CaptureStatus } from '../../model/panel-types';
import type { PanelStore } from '../../model/store';
import { usePanelState } from '../../model/use-panel-state';
import { issueCounts } from '../../model/selectors';
import { DropZone } from '../../import/drop-zone';
import type { LoadedCapture } from '../../import/load-jsonl';
import { applyLoaded } from '../../import/apply-loaded';
import { ExportPanel } from '../../export/export-panel';
import type { ExportIo } from '../../export/download';

export interface SessionProps {
  store: PanelStore;
  /** Injected in tests so the export controls' failure branches are reachable without a Blob. */
  exportIo?: ExportIo;
  /**
   * Commit a decoded capture. `App` passes its own so that an import started here is retained
   * for re-decode exactly like one started from the Timeline empty state — otherwise Expand
   * chunks would work after one import path and silently do nothing after the other.
   *
   * Optional so `Session` stays renderable from a test with nothing but a store.
   */
  onLoaded?: (loaded: LoadedCapture, filename: string, text: string) => void;
}

function describeSource(source: PanelSource): string {
  switch (source.kind) {
    case 'imported':
      return `${source.filename} (imported ${new Date(source.importedAtMs).toLocaleTimeString()})`;
    case 'live':
      return `live capture from ${source.origin}`;
    case 'empty':
      return 'nothing loaded yet';
  }
}

/**
 * The capture row, in the same three honest levels the banner uses (design decision P11).
 *
 * The `none` wording is the one that matters: it reports what the PANEL has seen, not a verdict
 * on the page. A production AG-UI app sends nothing until the user types, so "nothing detected"
 * would read as a finding when it is only an absence of evidence.
 */
function describeCapture(capture: CaptureStatus, loaded: boolean | null): string {
  switch (capture.kind) {
    case 'unsupported':
      return 'unavailable in this build';
    case 'on':
      /*
       * `on for <origin>` alone would be the panel's original false claim in its second home.
       * The origin being granted says capture is AVAILABLE here; whether this DOCUMENT has the
       * capture layer in it is a separate fact that only the extension's own content script can
       * report, and one that `registerContentScripts` — which affects future navigations only —
       * routinely leaves false on a page that was already open.
       *
       * The positive wording stops at "loaded" for the same reason the banner does: the relay
       * reporting proves the content scripts were registered here, not that the MAIN-world
       * patches installed. See `relay/relay.ts`.
       */
      if (loaded === false) {
        return `on for ${capture.origin} — but the capture layer is not loaded in this page, so nothing is being captured until you reload it`;
      }
      if (loaded === null) {
        return `on for ${capture.origin} — waiting for this page to report its capture layer`;
      }
      return `on for ${capture.origin} — capture layer loaded in this page`;
    case 'off':
      switch (capture.signal.level) {
        case 'stream':
          return `off for ${capture.origin} — an event stream was seen here`;
        case 'none':
          return `off for ${capture.origin} — nothing on the wire yet, which is normal before the first message`;
      }
  }
}

/**
 * What carried this capture — and the one row that must never be silent.
 *
 * Requirements §5.4 defers protobuf DECODING to phase 3 and asks only that capture detect the
 * content type and label the connection. That label lands here. A binary connection produces no
 * records, so a Session tab that reported "not detected" over one would leave the reader with an
 * empty Timeline and no explanation — indistinguishable from capture being broken.
 */
function describeTransport(state: PanelState): string {
  const binary = state.binaryTransport;
  if (binary !== null) {
    return `binary — ${binary.contentType}, ${String(binary.bytes)} bytes. Decoding is not supported yet (requirements §5.4 defers it to phase 3), so no events can be reconstructed from this connection.`;
  }
  if (state.source.kind === 'imported') return 'as recorded in the imported capture';
  if (state.source.kind === 'live') {
    return state.records.length > 0
      ? 'text/event-stream — SSE frames are being decoded'
      : 'nothing on the wire yet, which is normal before the first message';
  }
  return 'not detected — detection ships with the capture layer';
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div class="agui-session__row">
      <dt class="agui-session__label">{label}</dt>
      <dd class="agui-session__value">{value}</dd>
    </div>
  );
}

/**
 * THE WORDING THAT MATTERS MOST IN THIS FILE.
 *
 * `/info` is a CopilotKit runtime endpoint. The AG-UI protocol does not have one, and an app that
 * speaks AG-UI without a CopilotKit runtime — which is most of them, including the production
 * Angular deployment this panel was measured against across three page loads without a single
 * `/info` request — will never emit it. Absence here is the NORMAL outcome and says nothing
 * whatsoever about whether the app or the capture layer is working.
 *
 * So this must not read as a finding. "Not detected" would say detection ran and came up short;
 * "no agents found" would say the runtime was asked and had none. Neither happened. What actually
 * happened is that no such response went past, which is what this says — together with why that is
 * ordinary, and the fact that the panel only ever reads a request the page made on its own (§11).
 *
 * This is the third time this project has had to write an absence honestly. The capture row learned
 * it ("nothing on the wire yet, which is normal before the first message"), the transport row
 * learned it, and the lesson both times was that a signal can be technically correct and still
 * mislead the reader into hunting a bug that is not there.
 */
const NO_INFO =
  'no /info response seen — /info is a CopilotKit runtime endpoint, so an AG-UI app built ' +
  'without one never calls it, and this panel only ever reads a request the page already made';

function describeRuntime(runtime: RuntimeInfo | null): string {
  if (runtime === null) return NO_INFO;
  const mode = runtime.mode === 'single-route' ? 'single-route mode' : 'multi-route mode';
  // The runtime answered but did not name a version. Reporting "unknown" flat would read as a
  // failure to read it; the response simply did not carry one.
  const version = runtime.version === null ? 'version not reported' : `version ${runtime.version}`;
  return `${version} — ${mode}`;
}

/** One agent the runtime reported. `data-agent-id` is what the visual gate reads. */
function Agent({ agent }: { agent: AgentInfo }): JSX.Element {
  const description = agent.description;
  return (
    <li class="agui-session__agent" data-agent-id={agent.id}>
      <code class="agui-session__agent-id">{agent.id}</code>
      {/*
       * The name is shown only when it says something the id does not. Measured against the Dojo,
       * every agent's `name` is its own id, so printing both would double every row for no
       * information. `null` means the runtime did not report one, which is not worth a row of its
       * own — the id is the thing the client addresses.
       */}
      {agent.name !== null && agent.name !== agent.id && (
        <span class="agui-session__agent-name">{agent.name}</span>
      )}
      <span
        class="agui-session__agent-description"
        data-known={description !== null && description !== '' ? 'true' : 'false'}
      >
        {description !== null && description !== ''
          ? description
          : /* Measured: the Dojo's agents all carry `description: ""`. An empty cell would read
               as a rendering bug; this reads as the runtime having written nothing. */
            'no description'}
      </span>
    </li>
  );
}

/**
 * The agent list — the row spec §13 done-when #2 is about.
 *
 * Three states, kept apart because they are three different claims: no response was seen at all,
 * a response was seen but carried no readable agent map, and a response was seen and listed N
 * agents (possibly zero, which is the runtime's own report and not an absence of evidence).
 */
function Agents({ runtime }: { runtime: RuntimeInfo | null }): JSX.Element {
  if (runtime === null) return <Row label="Agents" value={NO_INFO} />;
  const agents = runtime.agents;
  if (agents === null) {
    return <Row label="Agents" value="the /info response carried no readable agent list" />;
  }
  if (agents.length === 0) {
    return <Row label="Agents" value="none — the runtime reported no registered agents" />;
  }
  return (
    <div class="agui-session__row">
      <dt class="agui-session__label">Agents</dt>
      <dd class="agui-session__value">
        <ul class="agui-session__agents">
          {agents.map((agent) => (
            <Agent key={agent.id} agent={agent} />
          ))}
        </ul>
      </dd>
    </div>
  );
}

/**
 * The Session tab: where the data came from, what is known about the page, and the import
 * control.
 *
 * Design §4 lists detected framework, versions, endpoints, transport, runtime mode and `/info`
 * agents here. Framework, transport, runtime mode, version and agents are answered; endpoints
 * still are not, and is reported as "not detected" with the reason rather than omitted — an absent
 * row reads as "there is nothing to know", which is a different and false claim.
 *
 * The runtime and agent rows close spec §13 done-when #2. They are filled from a `/info` response
 * the PAGE fetched — the CopilotKit v2 client does so at connect time, before any run — so they
 * are on screen before the user types, and the extension issues nothing of its own (§11). Their
 * empty state is the important half: see the note on `NO_INFO`.
 *
 * Design §4 also lists export controls, and this is where E5 puts the full-control surface: the
 * scope, the redaction groups, and a statement of what the file will contain.
 */
export function Session({ store, onLoaded, exportIo }: SessionProps): JSX.Element {
  const state: PanelState = usePanelState(store);
  const counts = issueCounts(state);
  const scopeLabel = state.scope === null ? 'all runs' : `run ${state.scope}`;

  return (
    <section class="agui-session" aria-label="Session">
      <h2 class="agui-session__title">Session</h2>

      <h3 class="agui-session__heading">Source</h3>
      <dl class="agui-session__grid">
        <Row label="Data" value={describeSource(state.source)} />
        <Row label="Runs" value={String(state.runs.length)} />
        <Row label="Records" value={String(state.records.length)} />
        <Row
          label="Dropped before"
          value={
            state.droppedBefore === 0
              ? 'none — nothing has been evicted'
              : `${String(state.droppedBefore)} records evicted`
          }
        />
      </dl>

      <h3 class="agui-session__heading">Detected</h3>
      <dl class="agui-session__grid">
        {/*
         * The one row that IS answered before the capture layer exists.
         *
         * Requirements §4.3 puts the framework fingerprint here and only here: it labels the
         * session, never gates capture. It says how the app was built, which is useful when
         * reading a bug report and says nothing whatsoever about whether the app speaks AG-UI —
         * AG-UI is a wire protocol with no DOM footprint.
         */}
        <Row
          label="Framework"
          value={state.framework ?? 'not identified — no framework fingerprint in the page'}
        />
        <Row label="Endpoints" value="not detected — detection ships with the capture layer" />
        <Row label="Transport" value={describeTransport(state)} />
        {/*
         * Requirements §4 asks for the runtime's version AND its mode (multi-route vs
         * single-route). Both come from the same `/info` exchange, and the mode comes from WHICH
         * of the two transports carried it — `GET {base}/info` or `POST {base}` with a
         * `{"method":"info"}` envelope — rather than from anything in the body.
         */}
        <Row label="Runtime" value={describeRuntime(state.runtime)} />
        <Agents runtime={state.runtime} />
      </dl>

      <h3 class="agui-session__heading">Capture</h3>
      <dl class="agui-session__grid">
        <Row label="Status" value={describeCapture(state.capture, state.loaded)} />
        <Row label="Expand chunks" value={state.expandChunks ? 'on' : 'off'} />
      </dl>

      <h3 class="agui-session__heading">Export</h3>
      <ExportPanel store={store} io={exportIo} />

      <h3 class="agui-session__heading">Issues ({scopeLabel})</h3>
      <dl class="agui-session__grid">
        <Row label="Errors" value={String(counts.error)} />
        <Row label="Warnings" value={String(counts.warning)} />
        <Row label="Info" value={String(counts.info)} />
        <Row label="Total" value={String(counts.total)} />
      </dl>

      <h3 class="agui-session__heading">Import</h3>
      <p class="agui-session__note">
        A <code>.agui.jsonl</code> capture loads read-only with every tab working — the shareable
        bug report of requirements §10. Nothing is uploaded; the file is read in this panel.
      </p>
      <DropZone
        store={store}
        onLoaded={(loaded, filename, text) => {
          if (onLoaded !== undefined) {
            onLoaded(loaded, filename, text);
            return;
          }
          store.update((s) => applyLoaded(s, loaded, filename, Date.now()));
        }}
      />
    </section>
  );
}
