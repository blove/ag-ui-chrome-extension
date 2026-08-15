/**
 * The Session tab's export controls — E5's "full control" surface.
 *
 * The toolbar's Export is the same function with the arguments fixed: current scope, unredacted,
 * and labelled as unredacted. This is where the mode, the group checkboxes and a statement of
 * what the file will contain live. Two call sites, one implementation; all the policy is in
 * `build.ts`, so nothing here can decide anything the tests do not see.
 *
 * Redaction is never a default. §11 makes the redaction profile "on by default for the bug-report
 * bundle", and this IS that bundle's builder — but a checkbox the user did not tick is a claim
 * they did not make, and the summary line states what is about to happen either way.
 */
import { useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { encodeJsonl } from '../../core/jsonl/codec';
import { ALL_REDACTION_GROUPS, type RedactionGroup } from '../../core/jsonl/redact';
import type { PanelStore } from '../model/store';
import { usePanelState } from '../model/use-panel-state';
import { buildExport, exportBlockedReason, type ExportBundle, type ExportCounts } from './build';
import { DEFAULT_EXPORT_IO, type ExportIo, type IoResult } from './download';
import { exportFilename, fixtureFilename } from './filename';
import { toFixtureModule } from './fixture';

/** §11's five groups, with the words a user chooses by. */
const GROUP_LABELS: Record<RedactionGroup, string> = {
  text: 'Message text — assistant and user content',
  reasoning: 'Reasoning content',
  toolArgs: 'Tool arguments',
  toolResults: 'Tool results',
  state: 'State values — snapshots, patch values, context and forwarded props',
};

function plural(count: number, one: string): string {
  return `${String(count)} ${count === 1 ? one : `${one}s`}`;
}

/**
 * What the file will contain, in words, before the click.
 *
 * The last clause is the one that matters: it says "unredacted" when nothing is selected, so a
 * full-fidelity export is never a surprise, and names the groups when some are.
 */
function summarize(counts: ExportCounts, groups: RedactionGroup[]): string {
  const parts = [
    plural(counts.runs, 'run'),
    plural(counts.events, 'event'),
    plural(counts.keepalives, 'keepalive'),
    plural(counts.requests, 'request line'),
  ];
  const body = `${parts.slice(0, -1).join(', ')} and ${String(parts.at(-1))}`;
  const tail = groups.length === 0 ? 'unredacted' : `redacting ${groups.join(', ')}`;
  return `${body} — ${tail}.`;
}

type Notice = { tone: 'ok' | 'error'; text: string } | null;

export function ExportPanel({ store, io = DEFAULT_EXPORT_IO }: { store: PanelStore; io?: ExportIo }): JSX.Element {
  const state = usePanelState(store);
  const [groups, setGroups] = useState<RedactionGroup[]>([]);
  const [notice, setNotice] = useState<Notice>(null);

  const blocked = exportBlockedReason(state, state.scope);
  // Ordered by `ALL_REDACTION_GROUPS` so the header, the summary and the checkbox list all say
  // the same thing in the same order.
  const selected = ALL_REDACTION_GROUPS.filter((group) => groups.includes(group));

  const build = (): ExportBundle =>
    buildExport(state, {
      scope: state.scope,
      groups: [...selected],
      toolVersion: chrome.runtime.getManifest().version,
      exportedAtIso: new Date().toISOString(),
    });

  const report = (result: IoResult, okText: string): void => {
    setNotice(result.ok ? { tone: 'ok', text: okText } : { tone: 'error', text: result.reason });
  };

  const bundle = blocked === null ? build() : null;
  /*
   * E3, on screen. The groups this capture arrived already carrying are shown separately from the
   * ones being applied now, because the user cannot deselect them — the payloads are already gone
   * — and a checkbox that could not be unticked would be a worse explanation than a sentence.
   */
  const inherited = (state.importedHeader?.redacted ?? []).filter(
    (group) => !selected.includes(group),
  );

  function toggle(group: RedactionGroup): void {
    setGroups((current) =>
      current.includes(group) ? current.filter((held) => held !== group) : [...current, group],
    );
    setNotice(null);
  }

  /**
   * Refuse, with the reason, when there is nothing to write.
   *
   * `disabled` on the button is the visible half; this is the half a keyboard path or an
   * assistive technology cannot get around. An export that emitted a zero-record file would
   * produce something that opens, validates and renders an empty timeline — indistinguishable
   * from a capture that genuinely saw nothing.
   */
  function refused(): boolean {
    if (blocked === null) return false;
    setNotice({ tone: 'error', text: blocked });
    return true;
  }

  function onDownload(): void {
    if (refused()) return;
    const built = build();
    report(
      io.download(exportFilename(built.header.url, built.header.capturedAt), encodeJsonl(built.lines)),
      'Capture downloaded.',
    );
  }

  function onCopy(): void {
    if (refused()) return;
    const built = build();
    void io.copy(encodeJsonl(built.lines)).then((result) => {
      report(result, 'Copied the capture to the clipboard.');
    });
  }

  function onFixture(): void {
    if (refused()) return;
    const built = build();
    const name = fixtureFilename(built.header.url, built.header.capturedAt);
    report(
      io.download(name, toFixtureModule(built.lines, name), 'text/typescript'),
      'Fixture downloaded.',
    );
  }

  return (
    <div class="agui-export">
      <p class="agui-session__note">
        Export re-encodes the capture from the records this panel holds, so a live capture and an
        imported one produce the same file. Nothing leaves this machine: the file is written by the
        browser from memory.
      </p>

      <fieldset class="agui-export__groups" disabled={blocked !== null}>
        <legend class="agui-export__legend">
          Redact before exporting (requirements §11) — nothing is redacted unless you say so
        </legend>
        {ALL_REDACTION_GROUPS.map((group) => (
          <label class="agui-export__group" key={group}>
            <input
              type="checkbox"
              checked={selected.includes(group)}
              onChange={() => {
                toggle(group);
              }}
            />
            <span>{GROUP_LABELS[group]}</span>
          </label>
        ))}
        <button
          type="button"
          class="agui-toolbar__button"
          onClick={() => {
            setGroups([...ALL_REDACTION_GROUPS]);
            setNotice(null);
          }}
        >
          Redact everything
        </button>
        <button
          type="button"
          class="agui-toolbar__button"
          onClick={() => {
            setGroups([]);
            setNotice(null);
          }}
        >
          Redact nothing
        </button>
      </fieldset>

      {selected.includes('toolArgs') && (
        <p class="agui-export__warning" data-testid="agui-export-args-note">
          Redacting tool arguments makes the accumulated arguments unparseable, so the exported
          capture will report a <code>tool-args-not-json</code> error the original did not have. No
          per-event placeholder can compose into valid JSON across a split JSON string. Leave this
          group unticked if the bug is about the arguments themselves.
        </p>
      )}

      {inherited.length > 0 && (
        <p class="agui-export__inherited" data-testid="agui-export-inherited">
          This capture was imported already redacted ({inherited.join(', ')}). Those groups stay
          redacted and stay recorded in the header — redaction cannot be undone.
        </p>
      )}

      {blocked === null ? (
        <p class="agui-export__summary" data-testid="agui-export-summary">
          {summarize(bundle?.counts ?? { events: 0, keepalives: 0, requests: 0, runs: 0 }, [
            ...selected,
          ])}
        </p>
      ) : (
        <p class="agui-export__blocked" data-testid="agui-export-blocked">
          {blocked}
        </p>
      )}

      <div class="agui-export__actions">
        <button
          type="button"
          class="agui-toolbar__button"
          disabled={blocked !== null}
          onClick={onDownload}
        >
          Download capture (.agui.jsonl)
        </button>
        <button
          type="button"
          class="agui-toolbar__button"
          disabled={blocked !== null}
          onClick={onCopy}
        >
          Copy JSON to clipboard
        </button>
        <button
          type="button"
          class="agui-toolbar__button"
          disabled={blocked !== null}
          onClick={onFixture}
        >
          Download TypeScript fixture (.ts)
        </button>
      </div>

      {notice !== null && (
        <p
          class={notice.tone === 'ok' ? 'agui-export__ok' : 'agui-export__error'}
          role={notice.tone === 'ok' ? 'status' : 'alert'}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}
