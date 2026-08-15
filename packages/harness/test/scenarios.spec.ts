import { expect, test } from '@playwright/test';

import { SCENARIOS } from '../fixtures/index.js';
import { startHarnessServer, type HarnessServer } from '../server/agui-server.js';
import { replayScenario } from './replay.js';

test.describe('SCENARIOS replayed through the real core/ pipeline', () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    test(`${name} produces exactly its expectIssues`, async () => {
      // `keepalive-gap` sleeps 15.5 s on the wire on purpose: the run builder measures arrival
      // times, so the gap cannot be faked in the payload. The budget is per test rather than a
      // special case, because the corpus grows.
      test.setTimeout(60_000);
      const server: HarnessServer = await startHarnessServer();
      try {
        server.use(name);
        const result = await replayScenario(server.url);
        const codes = result.issues.map((issue) => issue.code).sort();
        expect(codes).toEqual([...scenario.expectIssues].sort());
      } finally {
        await server.stop();
      }
    });
  }

  test('happy replays its keepalive as a keepalive record, not as an event', async () => {
    const server = await startHarnessServer();
    try {
      server.use('happy');
      const result = await replayScenario(server.url);
      expect(result.records.filter((record) => record.kind === 'event')).toHaveLength(14);
      expect(result.records.filter((record) => record.kind === 'keepalive')).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  test('binary yields bytes but no records', async () => {
    const server = await startHarnessServer();
    try {
      server.use('binary');
      const result = await replayScenario(server.url);
      expect(result.contentType).toBe('application/vnd.ag-ui.event+proto');
      expect(result.records).toEqual([]);
      expect(result.binaryBytes).toBeGreaterThan(0);
    } finally {
      await server.stop();
    }
  });

  test('a run captured without its request body gains run-started-without-input', async () => {
    // Verified fact 4, kept honest here rather than trusted: `expectIssues` is derived WITH the
    // POST body, so if `inject/` ever stops capturing it, this is the issue every scenario grows.
    const server = await startHarnessServer();
    try {
      server.use('happy');
      const result = await replayScenario(server.url, { withRequest: false });
      expect(result.issues.map((issue) => issue.code)).toEqual(['run-started-without-input']);
    } finally {
      await server.stop();
    }
  });
});
