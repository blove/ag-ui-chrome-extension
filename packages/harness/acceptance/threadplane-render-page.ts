/**
 * Browser entry for the UI-inspector phase of the Threadplane acceptance check (§14.5) — bundled by
 * `threadplane.ts` against a REAL Threadplane build, never against this repo.
 *
 * One AG-UI run over a REAL network transport (`toAgent(new HttpAgent(...))` against this page's
 * own server, `POST /genui`), so the extension captures it: two assistant messages, an A2UI surface
 * (`---a2ui_JSON---` + v0.9 JSONL) and a json-render spec. The page then renders both the way a
 * Threadplane app does — the surface through `<a2ui-surface>` (fed by the library's own parser and
 * surface store), the spec through `<chat-generative-ui>` — with the basic catalog as registry, so
 * one component type in each is unknown. In Angular's default development mode the two components
 * dispatch `threadplane:devtools` render reports; this page's own listener collects them into
 * `window.__TP_RENDERS__` for the node side to compare with what the worker holds.
 *
 * Not in `tsconfig.json`'s include: `@threadplane/*` resolves only through the bundler's aliases.
 */
import '@angular/compiler';
import { createComponent, type ApplicationRef, type ComponentRef } from '@angular/core';
import { createApplication } from '@angular/platform-browser';
import { HttpAgent } from '@ag-ui/client';
import { createA2uiMessageParser } from '@threadplane/a2ui';
import { toAgent } from '@threadplane/ag-ui';
import {
  A2uiSurfaceComponent,
  ChatGenerativeUiComponent,
  a2uiBasicCatalog,
  createA2uiSurfaceStore,
  toRenderRegistry,
} from '@threadplane/chat';

/** The sentinel Threadplane's content classifier looks for (`content-classifier.ts`). */
const SENTINEL = '---a2ui_JSON---';

interface RenderWindow extends Window {
  __TP_RENDERS__: unknown[];
  __TP_MESSAGES__?: string[];
  __TP_DONE__?: boolean;
  __TP_ERROR__?: string;
}
const w = window as unknown as RenderWindow;
w.__TP_RENDERS__ = [];
window.addEventListener('threadplane:devtools', (event) => {
  const detail = (event as CustomEvent).detail as { kind?: unknown } | null;
  if (detail !== null && typeof detail === 'object' && detail.kind === 'render') {
    w.__TP_RENDERS__.push(JSON.parse(JSON.stringify(detail)));
  }
});

function mount<T>(app: ApplicationRef, type: new (...args: never[]) => T, inputs: Record<string, unknown>): ComponentRef<T> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const ref = createComponent(type, { environmentInjector: app.injector, hostElement: host });
  for (const [name, value] of Object.entries(inputs)) ref.setInput(name, value);
  app.attachView(ref.hostView);
  return ref;
}

(async () => {
  try {
    const agent = toAgent(new HttpAgent({ url: `${location.origin}/genui` }));
    await agent.submit({ message: 'Show the weekly report.' });
    const texts = agent
      .messages()
      .map((message) => (message as { content?: unknown }).content)
      .filter((content): content is string => typeof content === 'string');
    w.__TP_MESSAGES__ = texts;

    const a2ui = texts.find((text) => text.trimStart().startsWith(SENTINEL));
    const specText = texts.find((text) => text.trimStart().startsWith('{'));
    if (a2ui === undefined || specText === undefined) throw new Error(`missing messages: ${JSON.stringify(texts)}`);

    // The surface, as Threadplane's chat applies it: its parser (lines apply on their newline), its store.
    const store = createA2uiSurfaceStore();
    const parser = createA2uiMessageParser();
    for (const message of parser.push(a2ui.slice(a2ui.indexOf(SENTINEL) + SENTINEL.length))) store.apply(message);
    const state = store.surfaceStates().get('weekly-report');
    if (state === undefined) throw new Error('the A2UI surface did not become visible in the store');

    const app = await createApplication({ providers: [] });
    const catalog = a2uiBasicCatalog();
    mount(app, A2uiSurfaceComponent, { state, catalog });
    mount(app, ChatGenerativeUiComponent, { spec: JSON.parse(specText) as unknown, registry: toRenderRegistry(catalog) });
    app.tick();

    // The reporter coalesces for 50 ms after a render pass; wait for one report per surface.
    const deadline = Date.now() + 10_000;
    const surfaces = (): Set<unknown> => new Set(w.__TP_RENDERS__.map((report) => (report as { surface?: unknown }).surface));
    while ((!surfaces().has('weekly-report') || !surfaces().has('spec:card')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      app.tick();
    }
  } catch (error) {
    w.__TP_ERROR__ = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  } finally {
    w.__TP_DONE__ = true;
  }
})();
