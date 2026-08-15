import { expect, test } from '@playwright/test';

import { convertGoldenFixture } from '../fixtures/convert.js';
import { SCENARIOS } from '../fixtures/index.js';

test.describe('golden fixture conversion', () => {
  test('happy-run keeps every event in seq order and its lone keepalive', () => {
    const converted = convertGoldenFixture('happy-run.agui.jsonl');

    expect(converted.events).toHaveLength(14);
    expect(converted.events[0]).toEqual({
      type: 'RUN_STARTED',
      threadId: 't_happy',
      runId: 'r_happy',
    });
    expect(converted.events.at(-1)).toEqual({
      type: 'RUN_FINISHED',
      threadId: 't_happy',
      runId: 'r_happy',
    });
    // The first keepalive of a stream has nothing to be measured against, so it carries no delay.
    expect(converted.keepalives).toEqual([{ afterEvents: 10, comment: 'ping', delayBeforeMs: 0 }]);
  });

  test('malformed keeps the three defects and drops header and request lines', () => {
    const converted = convertGoldenFixture('malformed.agui.jsonl');

    expect(converted.events).toHaveLength(10);
    expect(converted.events.map((event) => event.type)).not.toContain('RUN_FINISHED');
    expect(converted.events).toContainEqual({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'm_1',
      delta: '',
    });
    expect(converted.events).toContainEqual({
      type: 'STATE_DELTA',
      delta: [{ op: 'add', path: '/missing/child', value: 42 }],
    });
    expect(converted.keepalives).toEqual([]);
  });

  test('chunked keeps the id-carrying chunk triads', () => {
    const converted = convertGoldenFixture('chunked-run.agui.jsonl');

    expect(converted.events).toHaveLength(7);
    expect(converted.events[2]).toEqual({ type: 'TEXT_MESSAGE_CHUNK', delta: ', world' });
  });
});

test.describe('SCENARIOS corpus', () => {
  test('covers every scenario the contract requires', () => {
    const names = Object.keys(SCENARIOS);
    for (const required of [
      'happy',
      'malformed',
      'chunked',
      'keepalive-gap',
      'slow-chunks',
      'binary',
    ]) {
      expect(names).toContain(required);
    }
  });

  test('every scenario is keyed by its own name and carries a description and events', () => {
    for (const [key, scenario] of Object.entries(SCENARIOS)) {
      expect(scenario.name).toBe(key);
      expect(scenario.description.length).toBeGreaterThan(0);
      expect(scenario.events.length).toBeGreaterThan(0);
      for (const event of scenario.events) expect(typeof event.type).toBe('string');
    }
  });

  test('the converted scenarios reuse the goldens rather than restating them', () => {
    expect(SCENARIOS.happy?.events).toEqual(convertGoldenFixture('happy-run.agui.jsonl').events);
    expect(SCENARIOS.malformed?.events).toEqual(
      convertGoldenFixture('malformed.agui.jsonl').events,
    );
    expect(SCENARIOS.chunked?.events).toEqual(
      convertGoldenFixture('chunked-run.agui.jsonl').events,
    );
  });

  test('keepalive-gap declares a gap the run builder will actually flag', () => {
    const keepalives = SCENARIOS['keepalive-gap']?.keepalives ?? [];
    expect(keepalives).toHaveLength(2);
    // Strictly greater than 15 000 ms, which is the run builder's threshold.
    expect(keepalives[1]?.delayBeforeMs).toBeGreaterThan(15_000);
    expect(SCENARIOS['keepalive-gap']?.expectIssues).toEqual(['keepalive-gap']);
  });

  test('binary declares the protobuf content type and slow-chunks a per-event delay', () => {
    expect(SCENARIOS.binary?.contentType).toBe('application/vnd.ag-ui.event+proto');
    expect(SCENARIOS['slow-chunks']?.delayMs).toBe(150);
  });
});
