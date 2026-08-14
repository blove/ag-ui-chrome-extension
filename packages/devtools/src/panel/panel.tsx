/**
 * Panel UI root.
 *
 * STUB. The five tabs of requirements §9 (Timeline, Session, Messages, State, Issues) and the
 * normalizer → run model → validator pipeline they render arrive with the capture layer. This
 * milestone renders the empty state only, which is Done-when #2 of the design doc §7: "a
 * `dist/` that loads unpacked in Chrome and opens an (empty) AG-UI DevTools panel without
 * console errors".
 */
import { render } from 'preact';

const PANEL_NAME = 'AG-UI DevTools';
const EMPTY_STATE = 'No capture yet — the capture layer lands in the next milestone.';

function App() {
  const version = chrome.runtime.getManifest().version;
  return (
    <main class="agui-panel agui-panel--empty">
      <h1 class="agui-panel__title">{PANEL_NAME}</h1>
      <p class="agui-panel__version">v{version}</p>
      <p class="agui-panel__empty-state">{EMPTY_STATE}</p>
    </main>
  );
}

const mountPoint = document.getElementById('root') ?? document.body;
render(<App />, mountPoint);
