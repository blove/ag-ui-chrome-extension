import { describe, expect, it } from 'vitest';
import { isAutoEnabledOrigin, isRegisteredForOrigin, originPattern } from './grant';

/**
 * Whether the capture scripts are REGISTERED for an origin — a third fact, distinct from both
 * "the origin is granted" and "this document has the capture layer in it".
 *
 * It exists because the first two were not enough. Chrome drops dynamically registered content
 * scripts when the extension is reloaded or updated and keeps the permission, so an origin can be
 * granted with nothing registered for it at all. The panel could only see the grant, so it drew
 * the only conclusion left to it — the document must predate the registration — and advised a page
 * reload, which in that state does precisely nothing.
 */
describe('isRegisteredForOrigin', () => {
  it('is true for the manifest’s static family without consulting the list at all', () => {
    // Those origins are covered by the manifest's own `content_scripts`, which Chrome registers
    // and which cannot be dropped, so they are never in the worker's dynamic list — and could not
    // be matched against it if they were, because a match pattern ignores the port.
    expect(isRegisteredForOrigin('http://localhost:5173', { matches: [] })).toBe(true);
    expect(isRegisteredForOrigin('http://127.0.0.1:8080', null)).toBe(true);
    expect(isRegisteredForOrigin('http://0.0.0.0:3000', { matches: [] })).toBe(true);
  });

  it('is null while no worker has answered, so nothing may warn on it', () => {
    // The same tri-state discipline the `loaded` signal has: a panel opens before any worker has
    // answered, and a banner that warned on "not known yet" would flash a false alarm on every
    // open — which teaches the user to ignore the one that matters.
    expect(isRegisteredForOrigin('https://app.example.com', null)).toBeNull();
  });

  it('reads the origin’s own match pattern out of the worker’s list', () => {
    const registration = { matches: ['https://app.example.com/*'] };
    expect(isRegisteredForOrigin('https://app.example.com', registration)).toBe(true);
    // The pattern, not the bare origin: `chrome.permissions.request` and the worker both work in
    // match patterns, and the difference is the whole of `originPattern`.
    expect(registration.matches).toContain(originPattern('https://app.example.com'));
  });

  it('is false for a granted origin whose registration Chrome dropped', () => {
    // The shipped defect, as one assertion. Granted, nothing registered, and the panel now knows.
    expect(isRegisteredForOrigin('https://app.example.com', { matches: [] })).toBe(false);
  });

  it('does not mistake another origin’s registration for this one’s', () => {
    const registration = { matches: ['https://other.example.com/*'] };
    expect(isRegisteredForOrigin('https://app.example.com', registration)).toBe(false);
  });

  it('does not treat an https localhost as auto-enabled', () => {
    // `http:` only, matching the manifest. An `https://localhost` page is a genuinely different
    // origin and needs a grant and a registration like any other.
    expect(isAutoEnabledOrigin('https://localhost:5173')).toBe(false);
    expect(isRegisteredForOrigin('https://localhost:5173', { matches: [] })).toBe(false);
  });
});
