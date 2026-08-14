/**
 * Panel UI root.
 *
 * Creates the one store the panel owns and mounts `App` on it. Everything below `App` takes the
 * store as a prop — no context, no module-level singleton reached into from components — which
 * is what lets each component be rendered in a test with a store built for that test.
 */
import { render } from 'preact';

// Without this the panel has no stylesheet at all: the class names below would resolve to
// nothing and the panel would render black-on-dark under the DevTools dark theme. That is not
// hypothetical — it is exactly what the previous milestone shipped, and `scripts/screenshot-panel.mts`
// is the gate that now catches it.
import './panel.css';

import { App } from './app';
import { createPanelStore } from './model/store';

const store = createPanelStore();
const mountPoint = document.getElementById('root') ?? document.body;
render(<App store={store} />, mountPoint);
