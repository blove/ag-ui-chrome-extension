import type { AguiEvent, CaptureRecord, Issue, Run } from '../model/types';

export interface RunValidationState {
  run: Run;
  openTextMessages: Set<string>;
  openReasoningMessages: Set<string>;
  openToolCalls: Set<string>;
  endedToolCalls: Set<string>;
  openSteps: string[];
  terminated: boolean;
  sawSnapshot: boolean;
}

export type ValidatorRule = (
  event: AguiEvent,
  record: CaptureRecord,
  state: RunValidationState,
) => Issue[];
