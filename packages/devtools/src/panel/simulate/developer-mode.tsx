/**
 * Developer mode (§14.4, design R6): the switch, and the banner that is on screen while it is on.
 *
 * The switch shows what the WORKER says is stored for the inspected origin (`developerModes`),
 * never a value of its own: pressing it sends `developer-mode.set` and the worker's answer is what
 * moves it. It is offered only where capture is on — an origin in the localhost family or one the
 * user granted — and the worker checks the grant again before storing anything.
 */
import type { JSX } from 'preact';
import type { PanelState } from '../model/panel-types';
import type { PanelStore } from '../model/store';
import { usePanelState } from '../model/use-panel-state';

/** The inspected origin's Developer mode, or `null` when capture is not on (nothing to switch). */
export function developerModeFor(state: PanelState): { origin: string; enabled: boolean } | null {
  if (state.capture.kind !== 'on') return null;
  const { origin } = state.capture;
  return { origin, enabled: state.developerModes[origin] === true };
}

export const DEVELOPER_MODE_BANNER =
  'Developer mode: this page’s next agent run can be scripted from the panel.';

/** Shell chrome, shown on every tab while Developer mode is on for the inspected origin. */
export function DeveloperModeBanner({ store }: { store: PanelStore }): JSX.Element | null {
  const mode = developerModeFor(usePanelState(store));
  if (mode === null || !mode.enabled) return null;
  return (
    <p class="agui-app__note agui-devmode__banner" role="status">
      {DEVELOPER_MODE_BANNER}
    </p>
  );
}

export interface DeveloperModeSwitchProps {
  store: PanelStore;
  /** Ask the worker to store the new value. Absent outside a live panel. */
  onSet?: (enabled: boolean) => void;
}

export function DeveloperModeSwitch({ store, onSet }: DeveloperModeSwitchProps): JSX.Element {
  const mode = developerModeFor(usePanelState(store));
  const available = mode !== null && onSet !== undefined;
  return (
    <div class="agui-devmode">
      <label class="agui-devmode__switch">
        <input
          type="checkbox"
          role="switch"
          checked={mode?.enabled ?? false}
          disabled={!available}
          aria-describedby="agui-devmode-help"
          onChange={(event) => onSet?.((event.currentTarget as HTMLInputElement).checked)}
        />{' '}
        Developer mode{mode !== null ? ` for ${mode.origin}` : ''}
      </label>
      <p id="agui-devmode-help" class="agui-devmode__help">
        {available
          ? 'Lets the Simulate tab script this page’s next agent run — an interrupt, a subagent handoff, a malformed event — with no model call. It works only with a Threadplane development build, and only in the top frame. Any script already on a development page can do the same to its own app; this switch guards against scripting a page by accident, not against code already in it.'
          : 'Available once capture is enabled for the inspected origin.'}
      </p>
    </div>
  );
}
