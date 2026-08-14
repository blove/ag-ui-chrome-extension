import { makeIssue } from '../../model/types';
import { DEPRECATED_EVENT_TYPES } from '../../events/table';
import type { ValidatorRule } from '../types';

// Stream-level rules. `unknown-event-type` and `shape-invalid` are produced by
// `events/shape-check`, `chunk-missing-*` by `normalizer/chunk-expander`, and
// `keepalive-gap` by Task 13c's run builder from keepalive frame timing — none of them
// belong here. `keepalive-gap` in particular CANNOT live here: a keepalive record is the
// `kind: 'keepalive'` arm of `CaptureRecord` and carries no `event`, so there is nothing
// to pass as a `ValidatorRule`'s first argument.
export const deprecatedEventRule: ValidatorRule = (event, record, state) => {
  if (!DEPRECATED_EVENT_TYPES.has(event.type)) return [];
  return [
    makeIssue(
      'deprecated-event',
      `${event.type} is deprecated in the AG-UI protocol`,
      record.seq,
      { runId: state.run.runId },
    ),
  ];
};
