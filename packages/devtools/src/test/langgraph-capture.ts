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
  readonly url?: string;
  readonly body?: unknown;
  readonly header?: boolean;
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
    method: 'POST',
    url: options.url ?? DEFAULT_LG_URL,
    input: options.body ?? DEFAULT_LG_BODY,
  });
  frames.forEach((frame, i) => {
    const seq = i + 1;
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
