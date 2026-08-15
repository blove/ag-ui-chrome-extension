/**
 * The Messages tab — requirements §9.4, design decisions M1–M5.
 *
 * The "is the bug in my UI or in the stream?" tab. Its entire value is being a faithful render of
 * what the wire said, so every temptation to make the data look nicer than it is has been
 * declined on purpose:
 *
 *  - message text is rendered verbatim, newlines and all, and never truncated;
 *  - a message that never closed is labelled `streaming` rather than drawn as finished (M4);
 *  - tool arguments are shown as the bytes that arrived, beside the verdict on whether they
 *    parse (M2), and a call whose arguments never parsed is marked in the collapsed row so the
 *    reader does not have to go looking;
 *  - a redacted capture says its arguments were redacted rather than reporting the placeholder
 *    as a protocol error, because that error would be the redactor's, not the agent's.
 *
 * Ordering and the arguments verdict live in `./conversation`, which is pure — this file decides
 * only how to draw them.
 */
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { InputMessage } from '../../../core/model/input-messages';
import type { ReconstructedMessage, Run, ToolCallRecord } from '../../../core/model/types';
import { JsonTree } from '../../common/json-tree';
import { formatDuration } from '../../common/format';
import type { PanelState } from '../../model/panel-types';
import type { PanelStore } from '../../model/store';
import { selectScope, selectSeq, selectTab } from '../../model/store';
import { usePanelState } from '../../model/use-panel-state';
import type { ToolArgsStatus } from './conversation';
import { conversation, toolArgsStatus } from './conversation';

export interface MessagesProps {
  store: PanelStore;
}

/** What each verdict says in the collapsed row. Phrases, not glyphs: a colour is not a claim. */
const ARGS_LABEL: Record<ToolArgsStatus, string> = {
  parsed: 'arguments parsed',
  failed: 'arguments never parsed',
  streaming: 'arguments still streaming',
  none: 'no arguments',
  redacted: 'arguments redacted',
};

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * A labelled expander that mounts its body only while open.
 *
 * Unmounted rather than hidden, for the same reason the JSON tree is lazy: a tool result can be
 * an arbitrarily large document, and there may be many of them on screen.
 */
function Disclosure({
  label,
  summary,
  children,
}: {
  label: string;
  summary: string;
  children: () => JSX.Element;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div class="agui-tool__section">
      <button
        type="button"
        class="agui-tool__toggle"
        aria-expanded={open}
        aria-label={label}
        onClick={() => {
          setOpen((prev) => !prev);
        }}
      >
        <span class="agui-tool__caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        {summary}
      </button>
      {open ? (
        <section class="agui-tool__pane" aria-label={label}>
          {children()}
        </section>
      ) : null}
    </div>
  );
}

/**
 * Any value off the wire.
 *
 * A string is printed as itself rather than fed to the tree: a tool result is very often a JSON
 * document that arrived as a *string*, and quoting-and-escaping it into `"{\"tempC\":24}"` would
 * put an extra layer between the reader and the bytes they came to check.
 */
function WireValue({ value, label }: { value: unknown; label: string }): JSX.Element {
  if (typeof value === 'string') return <pre class="agui-msg__pre">{value}</pre>;
  return <JsonTree value={value} label={label} />;
}

/** A turn the APP sent, read out of the captured request body. */
function InputTurn({ message, index }: { message: InputMessage; index: number }): JSX.Element {
  const id = message.id ?? `turn-${String(index)}`;
  return (
    <li
      class="agui-msg agui-msg--input"
      data-item-kind="input"
      data-item-id={id}
      data-role={message.role}
      data-testid={`item-${id}`}
    >
      <div class="agui-msg__head">
        <span class="agui-msg__role">{message.role}</span>
        <span class="agui-msg__id">{id}</span>
        {/* Attribution, not decoration. A turn the page sent is not evidence about the stream,
            and a reader who mistakes one for the other is looking for the bug in the wrong half
            of their system. */}
        <span class="agui-msg__origin">from the request</span>
      </div>
      {message.content === undefined ? (
        <p class="agui-msg__absent">no content field on this turn</p>
      ) : (
        <div class="agui-msg__content" data-testid={`content-${id}`}>
          <WireValue value={message.content} label="content" />
        </div>
      )}
    </li>
  );
}

interface StreamedProps {
  message: ReconstructedMessage;
  runId: string;
  store: PanelStore;
}

/** A message the server streamed: `TEXT_MESSAGE_*` or `REASONING_MESSAGE_*`. */
function StreamedMessage({ message, runId, store }: StreamedProps): JSX.Element {
  const reasoning = message.kind === 'reasoning';
  // M3: reasoning starts collapsed — long, and usually not what you came for.
  const [open, setOpen] = useState(!reasoning);
  const id = message.messageId;
  const seqs = message.contentSeqs;
  const first = seqs.at(0);

  const body =
    message.content === '' ? (
      // Distinct from a message that said nothing: this one opened and no content arrived.
      <p class="agui-msg__absent">no content arrived for this message</p>
    ) : (
      <div class="agui-msg__content" data-testid={`content-${id}`}>
        {message.content}
      </div>
    );

  return (
    <li
      class="agui-msg"
      data-item-kind="message"
      data-item-id={id}
      data-kind={message.kind}
      data-streaming={message.closed ? 'false' : 'true'}
      data-testid={`item-${id}`}
    >
      <div class="agui-msg__head">
        <span class="agui-msg__role">{reasoning ? 'reasoning' : 'assistant'}</span>
        <span class="agui-msg__id">{id}</span>
        {/* M4: `closed: false` is a real state. Drawing it as complete would misrepresent a run
            still going, or one that never terminated. */}
        {message.closed ? null : (
          <span class="agui-msg__flag" data-flag="streaming">
            streaming
          </span>
        )}
        <span class="agui-msg__time">{formatDuration(message.startedAtMs)}</span>
        <span class="agui-msg__frames" data-testid={`frames-${id}`}>
          {seqs.length === 0 ? 'no frames' : plural(seqs.length, 'frame')}
        </span>
        {/* M5: the workflow. See it wrong here, jump to the frames that produced it. */}
        <button
          type="button"
          class="agui-msg__locate"
          aria-label={`Show ${id} in Timeline`}
          disabled={first === undefined}
          title={
            first === undefined
              ? 'This message produced no content frames, so there is nothing to select.'
              : `Select seq ${String(first)} in Timeline, scoped to ${runId}.`
          }
          onClick={() => {
            if (first === undefined) return;
            /*
             * Scope, then select, then switch — in that order and in one write. `selectScope`
             * drops a selection that falls outside the new scope, so selecting first would
             * throw the selection away again; and scoping matters because the Timeline may be
             * filtered to a different run, where the frame would not be on screen at all.
             */
            store.update((s) => selectTab(selectSeq(selectScope(s, runId), first), 'timeline'));
          }}
        >
          Timeline
        </button>
      </div>
      {reasoning ? (
        <div class="agui-msg__reasoning">
          <button
            type="button"
            class="agui-msg__disclosure"
            aria-expanded={open}
            aria-label={`Reasoning ${id}`}
            onClick={() => {
              setOpen((prev) => !prev);
            }}
          >
            <span aria-hidden="true">{open ? '▾' : '▸'}</span> reasoning ·{' '}
            {plural(message.content.length, 'char')}
          </button>
          {open ? body : null}
        </div>
      ) : (
        body
      )}
    </li>
  );
}

/** A tool call, inline at its position in the conversation (M1), with M2's verdict. */
function ToolCall({
  call,
  argsRedacted,
}: {
  call: ToolCallRecord;
  argsRedacted: boolean;
}): JSX.Element {
  const status = toolArgsStatus(call, { argsRedacted });
  const id = call.toolCallId;

  return (
    <li
      class="agui-tool"
      data-item-kind="tool"
      data-item-id={id}
      data-args={status}
      data-testid={`item-${id}`}
    >
      <div class="agui-tool__head">
        <span class="agui-tool__name">{call.toolCallName ?? 'unnamed tool call'}</span>
        <span class="agui-tool__id">{id}</span>
        {call.parentMessageId === undefined ? null : (
          <span class="agui-tool__parent">in {call.parentMessageId}</span>
        )}
        {/* M2, in the collapsed row: a verdict a reader has to click to find is a verdict most
            readers never see. */}
        <span class="agui-tool__status" data-status={status}>
          {ARGS_LABEL[status]}
        </span>
      </div>

      <Disclosure label={`Arguments of ${id}`} summary="arguments">
        {() => (
          <>
            {call.argsText === '' ? (
              <p class="agui-msg__absent">no argument deltas arrived for this call</p>
            ) : (
              // The accumulated bytes, exactly as they arrived. When they did not parse, this
              // is the evidence; when they did, it is what the parse is answerable to.
              <pre class="agui-msg__pre" data-testid={`args-text-${id}`}>
                {call.argsText}
              </pre>
            )}
            {status === 'failed' && call.argsParseError !== undefined ? (
              <p class="agui-tool__error" data-testid={`args-error-${id}`}>
                {call.argsParseError}
              </p>
            ) : null}
            {status === 'redacted' ? (
              <p class="agui-tool__note">
                This capture&rsquo;s header declares <code>toolArgs</code> redacted, so whether
                these arguments parsed cannot be known from this file.
              </p>
            ) : null}
            {status === 'parsed' ? <JsonTree value={call.args} label="args" /> : null}
          </>
        )}
      </Disclosure>

      {call.resultAtMs === undefined ? (
        <p class="agui-tool__absent">no result — TOOL_CALL_RESULT never arrived for this call</p>
      ) : (
        <Disclosure label={`Result of ${id}`} summary="result">
          {() => <WireValue value={call.result} label="result" />}
        </Disclosure>
      )}
    </li>
  );
}

function RunConversation({
  run,
  store,
  argsRedacted,
}: {
  run: Run;
  store: PanelStore;
  argsRedacted: boolean;
}): JSX.Element {
  const items = conversation(run);
  return (
    <section class="agui-messages__run" aria-label={`Run ${run.runId}`}>
      <h2 class="agui-messages__run-head">
        <span class="agui-messages__run-id">{run.runId}</span>
        <span class="agui-messages__run-thread">thread {run.threadId}</span>
        <span
          class="agui-messages__run-outcome"
          data-outcome={run.outcome}
          data-testid={`run-outcome-${run.runId}`}
        >
          {run.outcome}
        </span>
        {run.issues.length === 0 ? null : (
          <span class="agui-messages__run-issues" data-testid={`run-issues-${run.runId}`}>
            {plural(run.issues.length, 'issue')}
          </span>
        )}
      </h2>
      {items.length === 0 ? (
        <p class="agui-messages__empty">
          This run carried no messages — no request turns, no streamed text, no tool calls.
        </p>
      ) : (
        <ol class="agui-messages__list">
          {items.map((item) => {
            if (item.kind === 'input') {
              return (
                <InputTurn
                  key={`input-${String(item.index)}`}
                  message={item.message}
                  index={item.index}
                />
              );
            }
            if (item.kind === 'message') {
              return (
                <StreamedMessage
                  key={`message-${item.message.messageId}`}
                  message={item.message}
                  runId={run.runId}
                  store={store}
                />
              );
            }
            return (
              <ToolCall
                key={`tool-${item.call.toolCallId}`}
                call={item.call}
                argsRedacted={argsRedacted}
              />
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** P3 puts the run scope in the shell, so this tab reads it rather than owning a selector. */
function scopedRuns(state: PanelState): Run[] {
  if (state.scope === null) return state.runs;
  return state.runs.filter((run) => run.runId === state.scope);
}

export function Messages({ store }: MessagesProps): JSX.Element {
  const state = usePanelState(store);
  const runs = scopedRuns(state);

  return (
    <section class="agui-messages" aria-label="Messages">
      {runs.length === 0 ? (
        <p class="agui-messages__empty">
          There are no runs to show. Import a <code>.agui.jsonl</code> capture from the Session
          tab, or enable capture and reload the inspected page.
        </p>
      ) : (
        runs.map((run) => (
          /*
           * Whether this file's tool arguments were replaced before it was shared is read off
           * `Run.redacted` — the same field `core/`'s `toolArgsNotJsonRule` reads, put there by
           * the import path from `JsonlHeader.redacted`. One source, so the verdict in this tab
           * and the issue the validator does or does not raise cannot tell different stories.
           */
          <RunConversation
            key={run.runId}
            run={run}
            store={store}
            argsRedacted={run.redacted.includes('toolArgs')}
          />
        ))
      )}
    </section>
  );
}
