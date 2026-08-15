import { readFileSync } from 'node:fs';

import type { AguiEvent } from '@devtools/core/model/types';

/** A `:` comment frame the server emits between events. */
export interface ScenarioKeepalive {
  /** Emit once this many events have been written. `0` means before the first event. */
  afterEvents: number;
  /** Comment body, written as `: <comment>`. */
  comment: string;
  /** Milliseconds to sleep before writing it. Drives the >15 s `keepalive-gap` path. */
  delayBeforeMs: number;
}

export interface ConvertedFixture {
  events: AguiEvent[];
  keepalives: ScenarioKeepalive[];
}

const GOLDEN_DIR = new URL('../../devtools/src/test/fixtures/', import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Convert one golden `.agui.jsonl` into the server-side inputs that reproduce it.
 *
 * A `.agui.jsonl` is capture *output*; an aimock fixture is server *input*. The conversion is
 * mechanical in one direction only — drop `header` and `request` lines, keep `event` payloads in
 * seq order, and turn `keepalive` lines into comment frames — which is what makes one corpus test
 * `core/` offline and the capture layer online (design §5).
 *
 * The goldens are read at load time rather than transcribed into literals here. A copy would be
 * free to drift from the file that `core/`'s own 675 tests assert against, and a corpus that
 * silently disagrees with itself is worse than no corpus.
 *
 * A keepalive's `delayBeforeMs` is the wall-clock distance to the previous keepalive on the same
 * connection, because that is the only quantity `keepalive-gap` measures. The first keepalive of a
 * stream therefore has no delay: with nothing to measure against, the run builder cannot raise a
 * gap on it.
 */
export function convertGoldenFixture(fileName: string): ConvertedFixture {
  const text = readFileSync(new URL(fileName, GOLDEN_DIR), 'utf8');
  const events: AguiEvent[] = [];
  const keepalives: ScenarioKeepalive[] = [];
  let previousKeepaliveMs: number | undefined;

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) continue;

    if (parsed.kind === 'event') {
      const event = parsed.event;
      if (isRecord(event) && typeof event.type === 'string') {
        events.push(event as AguiEvent);
      }
      continue;
    }

    if (parsed.kind === 'keepalive') {
      const tMs = typeof parsed.tMs === 'number' ? parsed.tMs : 0;
      keepalives.push({
        afterEvents: events.length,
        comment: typeof parsed.comment === 'string' ? parsed.comment : '',
        delayBeforeMs: previousKeepaliveMs === undefined ? 0 : tMs - previousKeepaliveMs,
      });
      previousKeepaliveMs = tMs;
    }
  }

  return { events, keepalives };
}
