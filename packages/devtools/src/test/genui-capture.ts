/**
 * Small generative-UI captures built in code — for the hostile-input and UI-model tests, where a
 * committed fixture would be megabytes. Folded the way the panel folds a live capture.
 */
import type { AguiEvent, CaptureRecord } from '../core/model/types';
import { createRunBuilder } from '../core/normalizer/run-builder';
import { A2UI_SENTINEL, type GenuiCapture } from '../core/genui/extract';

/** One AG-UI connection carrying `events`, folded the way the panel folds a live capture. */
export function aguiCapture(events: readonly Record<string, unknown>[]): GenuiCapture {
  const builder = createRunBuilder();
  const records: CaptureRecord[] = [];
  const requests = [{ connId: 'c1', method: 'POST', url: 'http://localhost:8000/agent', input: { threadId: 't', runId: 'r1' } }];
  builder.addRequest('c1', 'POST', requests[0]?.url ?? '', requests[0]?.input);
  events.forEach((event, index) => {
    const record: CaptureRecord = {
      kind: 'event',
      seq: index + 1,
      tMs: index + 1,
      connId: 'c1',
      raw: event,
      event: event as unknown as AguiEvent,
      issues: [],
    };
    records.push(record);
    builder.addRecord(record);
  });
  builder.closeConnection('c1', events.length + 1);
  return { records, requests, runs: builder.runs() };
}

/** A run whose assistant message is `chunks`, streamed one delta each. */
export function textRun(chunks: readonly string[]): GenuiCapture {
  return aguiCapture([
    { type: 'RUN_STARTED', threadId: 't', runId: 'r1' },
    { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
    ...chunks.map((delta) => ({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta })),
    { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
    { type: 'RUN_FINISHED', threadId: 't', runId: 'r1' },
  ]);
}

/** An A2UI message: a surface whose components are `components`, one updateComponents line. */
export function a2uiText(components: readonly Record<string, unknown>[], surfaceId = 's'): string {
  return [
    A2UI_SENTINEL,
    JSON.stringify({ createSurface: { surfaceId, catalogId: 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json' } }),
    JSON.stringify({ updateComponents: { surfaceId, components } }),
    '',
  ].join('\n');
}
