/**
 * The harness client. Drives runs with the REAL `@ag-ui/client` `HttpAgent` (design H3).
 *
 * A hand-rolled `fetch` here would test our idea of a client. `HttpAgent.requestInit()` is
 * `{ method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
 * body: JSON.stringify(input) }` — the shape measured on a production AG-UI deployment, and
 * the exact shape `inject/` has to intercept. Getting it from the library is the point.
 *
 * The agent endpoint is same-origin on purpose: `AGUIMock` sends no CORS headers and 404s the
 * preflight, so a cross-origin POST would never leave the browser. `page/serve.ts` proxies it.
 */
import { HttpAgent } from '@ag-ui/client';
import type { Message } from '@ag-ui/core';

import { lineFor } from './render.js';

const AGENT_PATH = '/agui';

function required<T extends HTMLElement>(id: string, ctor: new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof ctor)) {
    throw new Error(`#${id} is missing or is not a ${ctor.name}`);
  }
  return node;
}

const form = required('run-form', HTMLFormElement);
const prompt = required('prompt', HTMLInputElement);
const status = required('status', HTMLOutputElement);
const errorLine = required('error', HTMLParagraphElement);
const list = required('messages', HTMLUListElement);

const agent = new HttpAgent({ url: new URL(AGENT_PATH, window.location.origin).toString() });

function render(messages: readonly Message[]): void {
  list.replaceChildren(
    ...messages.map((message) => {
      const item = document.createElement('li');
      item.dataset.role = message.role;
      item.dataset.id = message.id;
      item.textContent = lineFor(message);
      return item;
    }),
  );
}

agent.subscribe({
  onMessagesChanged: ({ messages }) => {
    render(messages);
  },
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  errorLine.hidden = true;
  errorLine.textContent = '';
  status.textContent = 'running';
  agent.addMessage({ id: crypto.randomUUID(), role: 'user', content: prompt.value });
  agent
    .runAgent()
    .then(() => {
      status.textContent = 'done';
    })
    .catch((cause: unknown) => {
      // A failed run must be visibly different from a run that produced nothing. `#status`
      // is what the e2e waits on, so it must reach a terminal value on every path.
      errorLine.hidden = false;
      errorLine.textContent = cause instanceof Error ? cause.message : String(cause);
      status.textContent = 'error';
    });
});

status.textContent = 'ready';
