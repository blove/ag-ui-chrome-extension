import { describe, it, expect } from 'vitest';
import { EVENT_TYPES } from '../events/event-table.generated';
import {
  classifyContentType,
  createConnClassifier,
  isAguiPayload,
  routeHint,
  type RouteHint,
} from './classifier';

const RUN_STARTED = '{"type":"RUN_STARTED","threadId":"t1","runId":"r1"}';
const TEXT_DELTA = '{"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"hi"}';

describe('classifyContentType', () => {
  it('recognizes text/event-stream', () => {
    expect(classifyContentType('text/event-stream')).toBe('sse');
  });

  it('recognizes text/event-stream with parameters', () => {
    expect(classifyContentType('text/event-stream; charset=utf-8')).toBe('sse');
    expect(classifyContentType('text/event-stream;charset=UTF-8')).toBe('sse');
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(classifyContentType('  Text/Event-Stream ; charset=utf-8')).toBe('sse');
  });

  it('recognizes the AG-UI protobuf content type as binary', () => {
    expect(classifyContentType('application/vnd.ag-ui.event+proto')).toBe('binary');
  });

  it('returns other for anything else, including null and undefined', () => {
    expect(classifyContentType('application/json')).toBe('other');
    expect(classifyContentType('')).toBe('other');
    expect(classifyContentType(null)).toBe('other');
    expect(classifyContentType(undefined)).toBe('other');
  });
});

describe('isAguiPayload', () => {
  it('accepts a JSON object whose type is a known event type', () => {
    expect(EVENT_TYPES).toContain('RUN_STARTED');
    expect(isAguiPayload(RUN_STARTED)).toBe(true);
    expect(isAguiPayload(TEXT_DELTA)).toBe(true);
  });

  it('rejects a JSON object whose type is not a known event type', () => {
    expect(isAguiPayload('{"type":"TOTALLY_MADE_UP"}')).toBe(false);
  });

  it('rejects a non-string type', () => {
    expect(isAguiPayload('{"type":123}')).toBe(false);
    expect(isAguiPayload('{"type":null}')).toBe(false);
    expect(isAguiPayload('{}')).toBe(false);
  });

  it('rejects malformed JSON without throwing', () => {
    expect(isAguiPayload('{"type":"RUN_STARTED"')).toBe(false);
    expect(isAguiPayload('not json at all')).toBe(false);
    expect(isAguiPayload('')).toBe(false);
    expect(isAguiPayload('[DONE]')).toBe(false);
  });

  it('rejects JSON that is not a non-null object', () => {
    expect(isAguiPayload('null')).toBe(false);
    expect(isAguiPayload('"RUN_STARTED"')).toBe(false);
    expect(isAguiPayload('42')).toBe(false);
    expect(isAguiPayload('[{"type":"RUN_STARTED"}]')).toBe(false);
  });
});

describe('createConnClassifier', () => {
  it('promotes not-agui -> provisional -> agui over two matching payloads', () => {
    const c = createConnClassifier('text/event-stream');
    expect(c.current()).toBe('not-agui');
    expect(c.observe(RUN_STARTED)).toBe('provisional');
    expect(c.current()).toBe('provisional');
    expect(c.observe(TEXT_DELTA)).toBe('agui');
    expect(c.current()).toBe('agui');
  });

  it('stays not-agui while payloads do not match', () => {
    const c = createConnClassifier('text/event-stream; charset=utf-8');
    expect(c.observe('{"choices":[{"delta":{"content":"hi"}}]}')).toBe('not-agui');
    expect(c.observe('[DONE]')).toBe('not-agui');
    expect(c.current()).toBe('not-agui');
  });

  it('reaches agui across interleaved non-matching payloads', () => {
    const c = createConnClassifier('text/event-stream');
    expect(c.observe(RUN_STARTED)).toBe('provisional');
    expect(c.observe('garbage')).toBe('provisional');
    expect(c.observe(TEXT_DELTA)).toBe('agui');
  });

  it('never regresses once agui', () => {
    const c = createConnClassifier('text/event-stream');
    c.observe(RUN_STARTED);
    c.observe(TEXT_DELTA);
    expect(c.observe('not json')).toBe('agui');
    expect(c.observe('{"type":"TOTALLY_MADE_UP"}')).toBe('agui');
    expect(c.current()).toBe('agui');
  });

  it('short-circuits to binary for the protobuf content type', () => {
    const c = createConnClassifier('application/vnd.ag-ui.event+proto');
    expect(c.current()).toBe('binary');
    expect(c.observe(RUN_STARTED)).toBe('binary');
    expect(c.observe(TEXT_DELTA)).toBe('binary');
    expect(c.current()).toBe('binary');
  });

  it('stays not-agui for a non-SSE content type even when payloads match', () => {
    const c = createConnClassifier('application/json');
    expect(c.current()).toBe('not-agui');
    expect(c.observe(RUN_STARTED)).toBe('not-agui');
    expect(c.observe(TEXT_DELTA)).toBe('not-agui');
  });

  it('stays not-agui when there is no content type at all', () => {
    const c = createConnClassifier(null);
    expect(c.observe(RUN_STARTED)).toBe('not-agui');
    expect(createConnClassifier(undefined).current()).toBe('not-agui');
  });
});

describe('routeHint', () => {
  it('recognizes GET {base}/info', () => {
    expect(routeHint('https://app.example.com/api/copilotkit/info', 'GET')).toEqual({
      kind: 'copilotkit-info',
      basePath: '/api/copilotkit',
      mode: 'multi-route',
    });
  });

  it('recognizes POST {base}/agent/:agentId/run', () => {
    expect(routeHint('https://app.example.com/api/copilotkit/agent/my-agent/run', 'POST')).toEqual({
      kind: 'copilotkit-run',
      basePath: '/api/copilotkit',
      agentId: 'my-agent',
    });
  });

  it('recognizes POST {base}/agent/:agentId/connect', () => {
    expect(routeHint('/api/copilotkit/agent/my-agent/connect', 'POST')).toEqual({
      kind: 'copilotkit-connect',
      basePath: '/api/copilotkit',
      agentId: 'my-agent',
    });
  });

  it('recognizes POST {base}/agent/:agentId/stop/:threadId', () => {
    expect(routeHint('/api/copilotkit/agent/my-agent/stop/thread-42', 'POST')).toEqual({
      kind: 'copilotkit-stop',
      basePath: '/api/copilotkit',
      agentId: 'my-agent',
      threadId: 'thread-42',
    });
  });

  it('recognizes GET {base}/inspector-metadata', () => {
    expect(routeHint('https://app.example.com/api/copilotkit/inspector-metadata', 'GET')).toEqual({
      kind: 'copilotkit-inspector-metadata',
      basePath: '/api/copilotkit',
    });
  });

  it('works for an arbitrary basePath, including the root', () => {
    expect(routeHint('/v3/ck/info', 'GET')).toEqual({
      kind: 'copilotkit-info',
      basePath: '/v3/ck',
      mode: 'multi-route',
    });
    expect(routeHint('/info', 'GET')).toEqual({ kind: 'copilotkit-info', basePath: '', mode: 'multi-route' });
  });

  it('works on path-only strings and ignores query and hash', () => {
    expect(routeHint('/api/copilotkit/info?v=2', 'GET')).toEqual({
      kind: 'copilotkit-info',
      basePath: '/api/copilotkit',
      mode: 'multi-route',
    });
    expect(routeHint('https://app.example.com/api/copilotkit/info?v=2#x', 'GET')).toEqual({
      kind: 'copilotkit-info',
      basePath: '/api/copilotkit',
      mode: 'multi-route',
    });
  });

  it('accepts a lowercase method', () => {
    expect(routeHint('/api/copilotkit/agent/a1/run', 'post')).toEqual({
      kind: 'copilotkit-run',
      basePath: '/api/copilotkit',
      agentId: 'a1',
    });
  });

  it('honors the HTTP method', () => {
    expect(routeHint('/api/copilotkit/info', 'POST')).toBeUndefined();
    expect(routeHint('/api/copilotkit/inspector-metadata', 'POST')).toBeUndefined();
    expect(routeHint('/api/copilotkit/agent/a1/run', 'GET')).toBeUndefined();
    expect(routeHint('/api/copilotkit/agent/a1/connect', 'GET')).toBeUndefined();
    expect(routeHint('/api/copilotkit/agent/a1/stop/t1', 'GET')).toBeUndefined();
  });

  it('returns undefined when nothing matches', () => {
    expect(routeHint('https://app.example.com/api/chat', 'POST')).toBeUndefined();
    expect(routeHint('/api/copilotkit', 'POST')).toBeUndefined();
    expect(routeHint('/api/copilotkit/agent/a1/run/extra', 'POST')).toBeUndefined();
    expect(routeHint('/api/copilotkit/agent//run', 'POST')).toBeUndefined();
    expect(routeHint('/api/copilotkit/agent/a1/stop', 'POST')).toBeUndefined();
    expect(routeHint('', 'GET')).toBeUndefined();
  });
});

/**
 * The transport the URL grammar alone could not see.
 *
 * Measured in `@copilotkitnext/core`'s dist: a client whose `_runtimeTransport` is `"single"`
 * POSTs to the runtime URL ITSELF with `body: JSON.stringify({ method: 'info' })`, and only a
 * `"multi"` client fetches `GET {runtimeUrl}/info`. The URL of a single-route call is the same
 * URL every other single-route call uses, so before this the discovery request was invisible to
 * everything in this codebase.
 */
describe('routeHint: the single-route info envelope', () => {
  it('recognizes POST {base} carrying {"method":"info"}', () => {
    expect(routeHint('https://app.example.com/api/copilotkit', 'POST', { method: 'info' })).toEqual(
      { kind: 'copilotkit-info', basePath: '/api/copilotkit', mode: 'single-route' },
    );
  });

  it('reports the whole path as the base, because the runtime URL is the endpoint', () => {
    expect(routeHint('/v3/ck', 'POST', { method: 'info' })).toEqual({
      kind: 'copilotkit-info',
      basePath: '/v3/ck',
      mode: 'single-route',
    });
    expect(routeHint('/', 'POST', { method: 'info' })).toEqual({
      kind: 'copilotkit-info',
      basePath: '/',
      mode: 'single-route',
    });
  });

  it('tolerates the rest of the envelope spec §4.2 describes', () => {
    // `{method, params, body}` is the documented single-route envelope. Extra keys must not
    // disqualify a request the client genuinely made.
    expect(
      routeHint('/api/copilotkit', 'POST', { method: 'info', params: {}, body: null }),
    ).toEqual({ kind: 'copilotkit-info', basePath: '/api/copilotkit', mode: 'single-route' });
  });

  it('distinguishes the two modes from each other', () => {
    // `mode` lives on the info arm alone, so the hint has to be narrowed to read it — which is
    // the type saying the same thing this test does.
    const modeOf = (hint: RouteHint | undefined): string | undefined =>
      hint?.kind === 'copilotkit-info' ? hint.mode : undefined;
    expect(modeOf(routeHint('/api/copilotkit/info', 'GET'))).toBe('multi-route');
    expect(modeOf(routeHint('/api/copilotkit', 'POST', { method: 'info' }))).toBe('single-route');
  });

  /* --- the near misses, each of which must NOT be read as discovery ------- */

  it('does not match another single-route method', () => {
    expect(routeHint('/api/copilotkit', 'POST', { method: 'run' })).toBeUndefined();
    expect(routeHint('/api/copilotkit', 'POST', { method: 'connect' })).toBeUndefined();
  });

  it('is case-sensitive on the discriminant, which the client sends lowercase', () => {
    expect(routeHint('/api/copilotkit', 'POST', { method: 'Info' })).toBeUndefined();
    expect(routeHint('/api/copilotkit', 'POST', { method: 'INFO' })).toBeUndefined();
  });

  it('does not match a nested or misplaced discriminant', () => {
    expect(routeHint('/api/copilotkit', 'POST', { params: { method: 'info' } })).toBeUndefined();
    expect(routeHint('/api/copilotkit', 'POST', { body: { method: 'info' } })).toBeUndefined();
  });

  it('does not match a discriminant carried on a prototype', () => {
    // A body reaching here was decoded from the page's own request. Own-property strict, like
    // every other boundary in this codebase.
    expect(routeHint('/api/copilotkit', 'POST', Object.create({ method: 'info' }))).toBeUndefined();
  });

  it('does not match a body that is not an object', () => {
    for (const body of ['{"method":"info"}', 'info', 42, null, undefined, [{ method: 'info' }]]) {
      expect(routeHint('/api/copilotkit', 'POST', body)).toBeUndefined();
    }
  });

  it('does not match on any verb but POST', () => {
    // A GET cannot carry a body at all, and `GET /api/copilotkit` is not `.../info`.
    expect(routeHint('/api/copilotkit', 'GET', { method: 'info' })).toBeUndefined();
    expect(routeHint('/api/copilotkit', 'DELETE', { method: 'info' })).toBeUndefined();
  });

  it('leaves a run a run, whatever its body happens to contain', () => {
    // The multi-route grammar is checked first on purpose: a run body is free to contain a
    // `method` field, and letting one field reclassify an SSE stream as a metadata request would
    // turn a captured run into nothing at all.
    expect(routeHint('/api/copilotkit/agent/a1/run', 'POST', { method: 'info' })).toEqual({
      kind: 'copilotkit-run',
      basePath: '/api/copilotkit',
      agentId: 'a1',
    });
    expect(routeHint('/api/copilotkit/agent/a1/connect', 'POST', { method: 'info' })?.kind).toBe(
      'copilotkit-connect',
    );
    expect(routeHint('/api/copilotkit/agent/a1/stop/t1', 'POST', { method: 'info' })?.kind).toBe(
      'copilotkit-stop',
    );
  });

  it('leaves every existing two-argument call meaning exactly what it did', () => {
    // The body parameter is optional, and a POST with no body known to us is still not info.
    expect(routeHint('/api/copilotkit', 'POST')).toBeUndefined();
    expect(routeHint('/api/copilotkit/info', 'POST')).toBeUndefined();
  });
});
