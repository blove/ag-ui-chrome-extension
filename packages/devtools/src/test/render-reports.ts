/** Render reports for the ring-bound tests (worker, panel, contract). */
import {
  MAX_RENDER_ELEMENTS,
  MAX_RENDER_NAME_LENGTH,
  MAX_RENDER_REGISTRY,
  type RenderDevtoolsReport,
} from '../core/signals/render-report';

/** The largest report the contract allows: every list full, every name at the length limit. */
export function maxSizeRenderReport(seq: number): RenderDevtoolsReport {
  const name = (prefix: string, i: number): string => `${prefix}${String(i)}`.padEnd(MAX_RENDER_NAME_LENGTH, 'x');
  return {
    v: 1,
    kind: 'render',
    surface: name('s', seq),
    seq,
    registry: Array.from({ length: MAX_RENDER_REGISTRY }, (_, i) => name('r', i)),
    elements: Array.from({ length: MAX_RENDER_ELEMENTS }, (_, i) => ({ key: name('k', i), type: name('t', i), state: 'mounted' as const })),
    tMs: seq,
  };
}
