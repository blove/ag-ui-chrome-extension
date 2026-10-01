import { describe, expect, test } from 'vitest';
import { exportFilename, fixtureFilename, threadplaneFilename } from './filename';

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
  test('strips path separators out of capturedAt too — an imported header sets it', () => {
    // `capturedAt` is preserved from the file being re-exported, so it is as untrusted as `url`.
    expect(exportFilename('http://localhost:3000/', '../../etc/passwd')).toBe(
      'agui-localhost-3000-etc-passwd.agui.jsonl',
    );
    expect(exportFilename('http://localhost:3000/', 'a\\b/c d')).toBe('agui-localhost-3000-a-b-c-d.agui.jsonl');
  });

  test('reduces a capturedAt of nothing but separators to `unknown`', () => {
    expect(exportFilename('http://localhost:3000/', '/ :')).toBe('agui-localhost-3000-unknown.agui.jsonl');
  });

  test('keeps a stamp that is already "unknown" readable', () => {
    // What `loadJsonl` reads a non-string capturedAt as.
    expect(exportFilename('unknown', 'unknown')).toBe('agui-unknown-unknown.agui.jsonl');
  });
});

describe('fixtureFilename', () => {
  test('is a TypeScript module, because that is what a fixture export is', () => {
    expect(fixtureFilename('http://localhost:3000/', '2026-08-15T12:00:00.000Z')).toBe(
      'agui-localhost-3000-2026-08-15T12-00-00.000Z.fixture.ts',
    );
  });
});

describe('threadplaneFilename', () => {
  test('is a spec file, so the test runner picks it up where it is dropped', () => {
    expect(threadplaneFilename('http://127.0.0.1:2024', '2026-05-08T00:00:00.000Z')).toBe(
      'threadplane-127.0.0.1-2024-2026-05-08T00-00-00.000Z.spec.ts',
    );
  });

  test('cannot be steered out of its directory by capturedAt either', () => {
    expect(threadplaneFilename('http://127.0.0.1:2024', '../x')).toBe('threadplane-127.0.0.1-2024-x.spec.ts');
    expect(fixtureFilename('http://127.0.0.1:2024', '../x')).toBe('agui-127.0.0.1-2024-x.fixture.ts');
  });
});
