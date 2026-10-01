import { describe, expect, it } from 'vitest';
import { developerModeKey, isWebOrigin, originOfPattern } from './developer-mode';

describe('isWebOrigin', () => {
  it('accepts a canonical http(s) origin, with or without a port', () => {
    for (const origin of ['https://example.com', 'http://localhost:5173', 'http://127.0.0.1:8080', 'https://app.test']) {
      expect(isWebOrigin(origin)).toBe(true);
    }
  });

  it('refuses anything a flag could be set under and never read back', () => {
    for (const origin of [
      'https://Example.com',
      'https://example.com/',
      'https://example.com/path',
      'https://example.com:443',
      'null',
      'file:///tmp',
      'chrome-extension://abc',
      '',
      'example.com',
      42,
      null,
    ]) {
      expect(isWebOrigin(origin)).toBe(false);
    }
  });
});

describe('developerModeKey', () => {
  it('is one key per origin', () => {
    expect(developerModeKey('https://example.com')).toBe('agui-dt:devmode:https://example.com');
    expect(developerModeKey('https://example.com:8443')).not.toBe(developerModeKey('https://example.com'));
  });
});

describe('originOfPattern', () => {
  it('reads the one origin a granted pattern names', () => {
    expect(originOfPattern('https://example.com/*')).toBe('https://example.com');
    expect(originOfPattern('https://example.com:8443/*')).toBe('https://example.com:8443');
  });

  it('is null for a pattern that names no single origin', () => {
    for (const pattern of ['<all_urls>', 'https://*.example.com/*', '*://example.com/*', 'https://example.com/app/*', 'file:///*']) {
      expect(originOfPattern(pattern)).toBeNull();
    }
  });
});
