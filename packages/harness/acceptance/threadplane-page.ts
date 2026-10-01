/**
 * Browser entry for the Threadplane acceptance check — bundled by `threadplane.ts` against a REAL
 * Threadplane build (`dist/libs/{chat,ag-ui,langgraph}`), never against this repo.
 *
 * Runs one AG-UI run (`toAgent(new FakeAgent(...))`) and one LangGraph run (`provideAgent` +
 * `injectAgent` over a `MockAgentTransport`, in an application injector made by
 * `createApplication`), in Angular's default development mode. Every `threadplane:devtools` report
 * the libraries dispatch is collected by this page's own listener into `window.__TP_REPORTS__`, so
 * the node side can compare what was dispatched with what the extension's worker holds.
 *
 * Not in `tsconfig.json`'s include: `@threadplane/*` resolves only through the bundler's aliases.
 */
// Partially compiled (ng-packagr) declarations are linked at runtime by the JIT compiler.
import '@angular/compiler';
import { runInInjectionContext } from '@angular/core';
import { createApplication } from '@angular/platform-browser';
import { EventType, type BaseEvent } from '@ag-ui/client';
import { FakeAgent, toAgent } from '@threadplane/ag-ui';
import { MockAgentTransport, injectAgent, provideAgent } from '@threadplane/langgraph';

interface TpWindow extends Window {
  __TP_REPORTS__: unknown[];
  __TP_DONE__?: boolean;
  __TP_ERROR__?: string;
}
const w = window as unknown as TpWindow;
w.__TP_REPORTS__ = [];
window.addEventListener('threadplane:devtools', (event) => {
  // A structured copy, so later mutation (there should be none) cannot change what was recorded.
  w.__TP_REPORTS__.push(JSON.parse(JSON.stringify((event as CustomEvent).detail)));
});

async function runAgUi(): Promise<void> {
  const events = [
    { type: EventType.TEXT_MESSAGE_START, messageId: 'm1', role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'Hel' },
    { type: EventType.TEXT_MESSAGE_END, messageId: 'm1' },
    { type: EventType.STATE_SNAPSHOT, snapshot: { count: 1 } },
    { type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/count', value: 2 }] },
    { type: EventType.TOOL_CALL_START, toolCallId: 't1', toolCallName: 'search', parentMessageId: 'm1' },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: 't1', delta: '{"q":"x"}' },
    { type: EventType.TOOL_CALL_END, toolCallId: 't1' },
    { type: EventType.CUSTOM, name: 'progress', value: { step: 1 } },
  ] as BaseEvent[];
  const agent = toAgent(new FakeAgent({ delayMs: 0, script: [{ when: 'initial', events }] }));
  await agent.submit({ message: 'hi' });
}

async function runLangGraph(): Promise<void> {
  const transport = new MockAgentTransport();
  const app = await createApplication({
    providers: [provideAgent({ assistantId: 'test', transport, throttle: 0 })],
  });
  const agent = runInInjectionContext(app.injector, () => injectAgent());
  const run = agent.submit({ message: 'hi' });
  await transport.flush();
  await transport.emit([
    {
      type: 'messages',
      messages: [{ id: 'ai-1', type: 'ai', content: 'hel' }],
      messageMetadata: { langgraph_node: 'model' },
    },
  ] as never);
  await transport.emit([
    {
      type: 'values',
      data: {
        messages: [
          { id: 'h-1', type: 'human', content: 'hi' },
          { id: 'ai-1', type: 'ai', content: 'hello' },
        ],
        topic: 'greeting',
      },
    },
  ] as never);
  await transport.emit([{ type: 'updates', data: { topic: 'farewell' } }] as never);
  await transport.emit([{ type: 'custom', data: { name: 'progress', data: { step: 1 } } }] as never);
  await transport.close();
  await run;
}

(async () => {
  try {
    await runAgUi();
    await runLangGraph();
  } catch (error) {
    w.__TP_ERROR__ = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  } finally {
    w.__TP_DONE__ = true;
  }
})();
