import { ORPHANED_RUN_ID, makeIssue } from '../../model/types';
import type { ValidatorRule } from '../types';

export const eventBeforeRunStartedRule: ValidatorRule = (event, record, state) => {
  if (event.type === 'RUN_STARTED') return [];
  if (state.run.outcome !== 'orphaned' && state.run.runId !== ORPHANED_RUN_ID) return [];
  return [
    makeIssue(
      'event-before-run-started',
      `${event.type} arrived before any RUN_STARTED`,
      record.seq,
      { runId: state.run.runId },
    ),
  ];
};

export const eventAfterTerminalRule: ValidatorRule = (event, record, state) => {
  if (!state.terminated) return [];
  return [
    makeIssue(
      'event-after-terminal',
      `${event.type} arrived after the run reached a terminal event`,
      record.seq,
      { runId: state.run.runId },
    ),
  ];
};

export const unbalancedStepsRule: ValidatorRule = (event, record, state) => {
  if (event.type !== 'STEP_FINISHED') return [];
  const stepName = typeof event.stepName === 'string' ? event.stepName : undefined;
  if (stepName === undefined) return [];
  if (state.openSteps.includes(stepName)) return [];
  return [
    makeIssue(
      'unbalanced-steps',
      `STEP_FINISHED "${stepName}" has no matching open STEP_STARTED`,
      record.seq,
      { runId: state.run.runId },
    ),
  ];
};

export const runStartedWithoutInputRule: ValidatorRule = (event, record, state) => {
  if (event.type !== 'RUN_STARTED') return [];
  if (state.run.input !== undefined) return [];
  return [
    makeIssue(
      'run-started-without-input',
      'RUN_STARTED has no captured request input; reproducing this run will be harder',
      record.seq,
      { runId: state.run.runId },
    ),
  ];
};
