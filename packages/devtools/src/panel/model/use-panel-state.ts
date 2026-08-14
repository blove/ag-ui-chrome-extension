import { useEffect, useState } from 'preact/hooks';
import type { PanelStore } from './store';
import type { PanelState } from './panel-types';

/**
 * Subscribe a component to the store.
 *
 * `useSyncExternalStore` lives in `preact/compat`, which would pull the React shim into a
 * package that has exactly one runtime dependency. `PanelStore.subscribe` already returns its
 * own unsubscribe, so this is the whole of it.
 */
export function usePanelState(store: PanelStore): PanelState {
  const [state, setState] = useState<PanelState>(() => store.get());
  useEffect(() => store.subscribe(() => setState(store.get())), [store]);
  return state;
}
