/**
 * Build `.agui.jsonl` text for a LangGraph Platform capture, the way the extension writes one:
 * a request line, then one event line per SSE frame with its name in `sseEvent`.
 */
export interface LangGraphTestFrame {
  readonly event: string;
  readonly data: unknown;
}

export interface LangGraphCaptureOptions {
  readonly connId?: string;
  /** `POST` by default; a join stream is a `GET`, the only verb its `/runs/:id/stream` route has. */
  readonly method?: string;
  readonly url?: string;
  readonly body?: unknown;
  readonly header?: boolean;
  /** The first frame's seq: a second connection in one capture continues the first's numbering. */
  readonly firstSeq?: number;
}

export const DEFAULT_LG_URL = 'http://localhost:2024/threads/t-1/runs/stream';

export const DEFAULT_LG_BODY = {
  assistant_id: 'agent',
  input: { messages: [{ type: 'human', content: 'hi' }] },
  stream_mode: ['values', 'messages-tuple', 'updates', 'custom'],
};

export function langGraphJsonl(frames: readonly LangGraphTestFrame[], options: LangGraphCaptureOptions = {}): string {
  const connId = options.connId ?? 'c1';
  const lines: unknown[] = [];
  if (options.header ?? true) {
    lines.push({
      kind: 'header',
      schemaVersion: 1,
      tool: 'ag-ui-devtools@test',
      capturedAt: '2026-09-30T12:00:00.000Z',
      url: 'http://localhost:2024',
      transport: 'sse',
      redacted: [],
    });
  }
  lines.push({
    kind: 'request',
    connId,
    tMs: 0,
    method: options.method ?? 'POST',
    url: options.url ?? DEFAULT_LG_URL,
    // An explicit `body: null` is kept: a join stream's GET has no body.
    input: 'body' in options ? options.body : DEFAULT_LG_BODY,
  });
  const firstSeq = options.firstSeq ?? 1;
  frames.forEach((frame, i) => {
    const seq = firstSeq + i;
    lines.push({ kind: 'event', connId, seq, tMs: seq * 10, ...(frame.event !== '' ? { sseEvent: frame.event } : {}), event: frame.data });
  });
  return lines.map((line) => JSON.stringify(line)).join('\n');
}

/** A `messages` tuple frame carrying one assistant chunk. */
export function aiChunk(id: string, content: unknown, extra: Record<string, unknown> = {}): LangGraphTestFrame {
  return {
    event: 'messages',
    data: [{ type: 'AIMessageChunk', id, content, tool_call_chunks: [], ...extra }, { langgraph_node: 'agent' }],
  };
}
