import { describe, expect, test } from 'vitest';
import { exportFilename, fixtureFilename } from './filename';

describe('exportFilename', () => {
  test('names the host and the moment the capture was taken', () => {
    expect(exportFilename('https://agent.example.com/chat', '2026-08-15T12:00:00.000Z')).toBe(
      'agui-agent.example.com-2026-08-15T12-00-00.000Z.agui.jsonl',
    );
  });

  test('keeps the port, because localhost:3000 and localhost:3001 are different apps', () => {
    expect(exportFilename('http://localhost:3000/', '2026-08-15T12:00:00.000Z')).toBe(
      'agui-localhost-3000-2026-08-15T12-00-00.000Z.agui.jsonl',
    );
  });

  test('carries no colon, which is not a legal filename character everywhere', () => {
    // A file the user is about to hand to a colleague must survive being saved on their machine.
    expect(exportFilename('http://localhost:3000/', '2026-08-15T12:00:00.000Z')).not.toContain(':');
  });

  test('falls back to a stated unknown host rather than emitting a bare timestamp', () => {
    expect(exportFilename('unknown', '2026-08-15T12:00:00.000Z')).toBe(
      'agui-unknown-2026-08-15T12-00-00.000Z.agui.jsonl',
    );
  });

  test('reduces a host of nothing but separators to `unknown`', () => {
    expect(exportFilename('   ', '2026-08-15T12:00:00.000Z')).toBe(
      'agui-unknown-2026-08-15T12-00-00.000Z.agui.jsonl',
    );
  });

  test('strips path separators out of a host, so the name can never escape its directory', () => {
    expect(exportFilename('../../etc/passwd', '2026-08-15T12:00:00.000Z')).toBe(
      'agui-etc-passwd-2026-08-15T12-00-00.000Z.agui.jsonl',
    );
  });
});

describe('fixtureFilename', () => {
  test('is a TypeScript module, because that is what a fixture export is', () => {
    expect(fixtureFilename('http://localhost:3000/', '2026-08-15T12:00:00.000Z')).toBe(
      'agui-localhost-3000-2026-08-15T12-00-00.000Z.fixture.ts',
    );
  });
});
