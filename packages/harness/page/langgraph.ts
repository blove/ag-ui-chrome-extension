/**
 * The harness's LangGraph Platform client: the requests `@langchain/langgraph-sdk` makes, by hand.
 *
 * WHY NOT THE SDK. The extension patches `fetch`, and what it captures is the request line and
 * the response bytes. The SDK's `client.runs.stream()` is a `fetch` POST with a JSON body whose
 * response it parses itself — nothing it adds is visible to capture, and its parser is not the
 * one under test. A raw `fetch` sends the same request line and leaves the response bytes
 * exactly as the server wrote them, with no SDK dependency in the harness.
 *
 * WHY A SEPARATE PAGE. `e2e/capture.spec.ts` asserts `main.ts` makes exactly one POST.
 *
 * Query string:
 *   ?scenario=<name>   the LangGraph scenario, sent as `assistant_id` (the server picks by it)
 *   ?thread=<id>       the thread in the URL path; default `harness-thread`
 *   ?join=<runId>      after the POST ends, rejoin that run with `GET …/runs/:runId/stream`
 *   ?agui=1            first run the AG-UI happy scenario through the real `HttpAgent` on
 *                      `/agui` — one page, two dialects
 */
import { HttpAgent } from '@ag-ui/client';

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

const params = new URLSearchParams(window.location.search);
const scenario = params.get('scenario') ?? 'lg-reasoning';
const threadId = params.get('thread') ?? 'harness-thread';
const joinRunId = params.get('join');
const withAgui = params.get('agui') === '1';

/** Read a response to its end. The capture layer reads its own tee; this is the page's half. */
async function drain(response: Response): Promise<void> {
  if (!response.ok) throw new Error(`HTTP ${String(response.status)} from ${response.url}`);
  const reader = response.body?.getReader();
  if (reader === undefined) return;
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}

async function runLangGraph(content: string): Promise<void> {
  const base = `/threads/${encodeURIComponent(threadId)}/runs`;
  const response = await fetch(new URL(`${base}/stream`, window.location.origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      assistant_id: scenario,
      input: { messages: [{ type: 'human', content }] },
      stream_mode: ['values', 'messages-tuple', 'updates', 'custom'],
      stream_subgraphs: true,
    }),
  });
  await drain(response);
  if (joinRunId !== null) {
    await drain(
      await fetch(new URL(`${base}/${encodeURIComponent(joinRunId)}/stream`, window.location.origin)),
    );
  }
}

async function runAgui(content: string): Promise<void> {
  const agent = new HttpAgent({ url: new URL('/agui', window.location.origin).toString() });
  agent.addMessage({ id: crypto.randomUUID(), role: 'user', content });
  await agent.runAgent();
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  errorLine.hidden = true;
  status.textContent = 'running';
  // Sequential, not concurrent: each connection's frames then land in the buffer as one block,
  // and a spec reading the capture can tell a dialect mix-up from an interleaving.
  (withAgui ? runAgui(prompt.value) : Promise.resolve())
    .then(() => runLangGraph(prompt.value))
    .then(() => {
      status.textContent = 'done';
    })
    .catch((cause: unknown) => {
      errorLine.hidden = false;
      errorLine.textContent = cause instanceof Error ? cause.message : String(cause);
      status.textContent = 'error';
    });
});

status.textContent = 'ready';
