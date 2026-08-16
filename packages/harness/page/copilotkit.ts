/**
 * The harness's CopilotKit-shaped page: agent discovery, then a run.
 *
 * WHY IT IS A SEPARATE PAGE. `main.ts` is what `e2e/capture.spec.ts` measures, and that spec
 * asserts the page makes exactly ONE POST — the run. A discovery request added there would be a
 * second POST in single-route mode and would silently rewrite what that assertion means.
 *
 * WHY DISCOVERY IS AWAITED BEFORE THE FORM WORKS. Measured in `@copilotkitnext/core`'s dist: the
 * v2 client sets `_runtimeConnectionStatus = Connecting`, awaits `fetchRuntimeInfo()`, populates
 * `remoteAgents` and only then notifies — discovery is initialisation, not a lazy fetch. Doing it
 * in that order here is not just fidelity, it is what makes the e2e deterministic: the capture
 * layer posts its `info` message strictly before the run's `conn-open`, `postMessage` delivery is
 * FIFO and port messages are ordered, so a worker that has handled the run's `conn-close` has
 * necessarily handled the discovery response too. `readSettledCapture` waits on that close, which
 * is a real message with a real cause rather than a duration guessed at.
 *
 * WHY `?mode=`. The two transports are two different requests carrying the same body, and the
 * single-route one is the reason this task existed at all — its URL is the runtime's own base
 * path, so nothing about it is visible without reading the request body. Serving one per page
 * load lets a spec assert each mode on its own rather than watching the last one win.
 */
import { HttpAgent } from '@ag-ui/client';

const AGENT_PATH = '/agui';

/** Mounted by `page/serve.ts`. Mirrors a CopilotKit runtime's own two shapes. */
export const RUNTIME_BASE_PATH = '/api/copilotkit';

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
const info = required('info', HTMLOutputElement);
const errorLine = required('error', HTMLParagraphElement);

const agent = new HttpAgent({ url: new URL(AGENT_PATH, window.location.origin).toString() });

/**
 * The two discovery calls, written to match the client's own dist byte for byte in shape:
 *
 * ```js
 * if (this._runtimeTransport === "single") {
 *   fetch(this.runtimeUrl, { method: 'POST', body: JSON.stringify({ method: 'info' }), ... })
 * }
 * // otherwise: GET `${this.runtimeUrl}/info`
 * ```
 */
async function discover(mode: string): Promise<void> {
  const base = new URL(RUNTIME_BASE_PATH, window.location.origin).toString();
  const response =
    mode === 'single'
      ? await fetch(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: 'info' }),
        })
      : await fetch(`${base}/info`);
  // Read here as the client does. The capture layer tees the body, so this consuming it is
  // precisely the transparency being tested.
  const body = (await response.json()) as { agents?: Record<string, unknown> };
  info.textContent = String(Object.keys(body.agents ?? {}).length);
}

const mode = new URL(window.location.href).searchParams.get('mode') ?? 'multi';

discover(mode)
  .then(() => {
    status.textContent = 'ready';
  })
  .catch((cause: unknown) => {
    // A discovery failure must not look like a page that simply had nothing to discover: the
    // spec waits on `#info`, and a silent failure would hang it with no diagnosis.
    info.textContent = 'failed';
    errorLine.hidden = false;
    errorLine.textContent = cause instanceof Error ? cause.message : String(cause);
    status.textContent = 'error';
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
      errorLine.hidden = false;
      errorLine.textContent = cause instanceof Error ? cause.message : String(cause);
      status.textContent = 'error';
    });
});
