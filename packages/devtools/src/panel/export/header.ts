/**
 * The `.agui.jsonl` header line, and the one rule in export that cannot be got wrong.
 *
 * Requirements §10 puts a header on line 1 of every capture, and §11 makes its `redacted` field
 * the record of what was replaced. Everything here is pure; `build.ts` is its only caller.
 */
import type { JsonlHeader } from '../../core/jsonl/codec';
import { ALL_REDACTION_GROUPS, type RedactionGroup } from '../../core/jsonl/redact';

export interface HeaderInput {
  /**
   * The header of the capture being re-exported, when there is one. `null` for a live capture,
   * and for an imported file that carried no header line.
   */
  previous: JsonlHeader | null;
  /** The groups being redacted by THIS export. */
  groups: RedactionGroup[];
  /** `chrome.runtime.getManifest().version` — the build writing the file. */
  toolVersion: string;
  /** The moment of export, used only when there is no earlier capture time to preserve. */
  exportedAtIso: string;
  /** The inspected origin, or `null` when the panel never learned one. */
  url: string | null;
  framework: string | null;
  transport: 'sse' | 'binary';
}

/**
 * E3 — `header.redacted` is CUMULATIVE, never replaced.
 *
 * Re-exporting an imported capture unions the groups the file arrived with into the groups
 * applied now. **You cannot un-redact.** The upstream export already replaced those payloads
 * with `«redacted: N chars»`; a header that then claimed only the groups this pass applied would
 * under-report, and a colleague reading it would believe text they are looking at is verbatim.
 *
 * The result is ordered by `ALL_REDACTION_GROUPS`, so two headers describing the same redaction
 * are the same string — which is what lets a round-trip be compared, and a diff of two exports be
 * read. A group this build does not recognise is KEPT, appended after the known ones: a file
 * written by a later version may name a group that does not exist here, and dropping it would be
 * the same under-report by a different route.
 */
export function unionRedacted(
  previous: readonly RedactionGroup[],
  applied: readonly RedactionGroup[],
): RedactionGroup[] {
  const claimed = new Set<RedactionGroup>([...previous, ...applied]);
  const known = ALL_REDACTION_GROUPS.filter((group) => claimed.has(group));
  const unknown = [...claimed].filter((group) => !ALL_REDACTION_GROUPS.includes(group));
  return [...known, ...unknown];
}

/**
 * Build the header for an export.
 *
 * `capturedAt`, `url` and `framework` describe the CAPTURE and are preserved from the file being
 * re-exported when there is one — re-stamping them with the export moment would say the stream
 * was recorded now, from this panel, which is false for every imported capture and is the same
 * class of untruth E3 rules out for `redacted`. `tool` is the opposite: this build wrote these
 * bytes, so it names itself.
 */
export function buildHeader(input: HeaderInput): JsonlHeader {
  const { previous } = input;
  const framework = previous?.framework ?? input.framework;
  const header: JsonlHeader = {
    kind: 'header',
    schemaVersion: 1,
    tool: `ag-ui-devtools@${input.toolVersion}`,
    capturedAt: previous?.capturedAt ?? input.exportedAtIso,
    // "unknown" rather than an empty string: a reader must be able to tell a capture whose origin
    // was never resolved from one taken against an origin that is literally blank.
    url: previous?.url ?? input.url ?? 'unknown',
    transport: previous?.transport ?? input.transport,
    redacted: unionRedacted(previous?.redacted ?? [], input.groups),
  };
  // Absent rather than `null`: `framework` is optional in the codec, and a `null` would decode as
  // a claim that the framework was identified as nothing.
  if (framework !== null && framework !== undefined) header.framework = framework;
  return header;
}
