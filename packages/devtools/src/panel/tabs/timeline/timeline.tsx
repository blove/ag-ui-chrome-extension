import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { useIsNarrow } from '../../common/layout';
import type { PanelStore } from '../../model/store';
import { EventDetail } from './event-detail';
import { EventList } from './event-list';
import { Waterfall } from './waterfall';

export interface TimelineProps {
  store: PanelStore;
}

export function Timeline({ store }: TimelineProps): JSX.Element {
  // P4 and open question 1 share one answer: below `NARROW_BREAKPOINT_PX` the detail pane stacks
  // under the list and the waterfall collapses to a single line. The breakpoint is applied in JS
  // rather than a media query so `NARROW_BREAKPOINT_PX` stays the single definition of it.
  const narrow = useIsNarrow();

  /*
   * The cross-pane locate channel (P7).
   *
   * `selectedSeq` says *which* event to show; it cannot say *again*. Clicking the same waterfall
   * bar a second time — after the user has scrolled the list somewhere else — writes the same
   * seq, so `VirtualList`, which deliberately refuses to re-scroll for an index it has already
   * served, would leave the list where it was. Timeline owns the nonce because it is the only
   * component that sees both ends: the waterfall knows a click happened, the list knows where
   * that seq lives. A counter rather than a key on `EventList` — keying would remount the list,
   * throwing away its scroll position, its focus and its whole rendered window.
   */
  const [locateNonce, setLocateNonce] = useState(0);

  return (
    <div class="agui-timeline" data-layout={narrow ? 'stacked' : 'split'}>
      <Waterfall
        store={store}
        collapsed={narrow}
        onLocate={() => {
          setLocateNonce((prev) => prev + 1);
        }}
      />
      <div class="agui-timeline__body">
        <EventList store={store} locateNonce={locateNonce} />
        <EventDetail store={store} />
      </div>
    </div>
  );
}
