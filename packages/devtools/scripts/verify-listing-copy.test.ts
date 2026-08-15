import { describe, expect, it } from 'vitest';
import { checkCopy, parseCopy } from './verify-listing-copy';

const VALID = `---
title: AG-UI DevTools
summary: Inspect, validate, and replay AG-UI agent event streams from any page.
category: Developer Tools
language: en
single_purpose: Capture and inspect AG-UI protocol event streams for debugging.
uses_remote_code: false
privacy_policy_url: https://github.com/blove/ag-ui-chrome-extension/blob/main/PRIVACY.md
website: https://threadplane.ai
support_url: https://github.com/blove/ag-ui-chrome-extension/issues
permissions:
  storage: Per-origin opt-in and panel preferences only.
  scripting: Registers capture content scripts on origins the user grants.
  optional_host_permissions: Requested one origin at a time, on an explicit click.
---

# AG-UI DevTools

A real detailed description.
`;

describe('parseCopy', () => {
  it('reads the front matter and the body', () => {
    const copy = parseCopy(VALID);
    expect(copy.fields.title).toBe('AG-UI DevTools');
    expect(copy.fields.permissions?.storage).toContain('opt-in');
    expect(copy.body).toContain('A real detailed description.');
  });

  it('rejects a document with no front matter', () => {
    expect(() => parseCopy('# no front matter')).toThrow(/front matter/i);
  });

  // The one input that used to parse cleanly to the wrong string: there is no unquoting step, so
  // `"AG-UI DevTools"` is 16 characters with the quotes in them, and every length check passes.
  // Asserted at BOTH nesting levels because `rejectQuoted` has two call sites.
  it('rejects a quoted value rather than keeping the quotes', () => {
    const quotedTitle = VALID.replace(/^title: .*$/m, 'title: "AG-UI DevTools"');
    expect(() => parseCopy(quotedTitle)).toThrow(/quoted/i);

    const quotedPermission = VALID.replace(
      /^ {2}storage: .*$/m,
      "  storage: 'Per-origin opt-in only.'",
    );
    expect(() => parseCopy(quotedPermission)).toThrow(/quoted/i);
  });

  it('blames the indent, not the colon, when a nested key is misindented', () => {
    const misindented = VALID.replace(/^ {2}storage: .*$/m, '    storage: Per-origin opt-in only.');
    expect(() => parseCopy(misindented)).toThrow(/two spaces/i);
  });
});

describe('checkCopy', () => {
  const MANIFEST_PERMISSIONS = ['storage', 'scripting', 'optional_host_permissions'];

  it('passes a valid document', () => {
    expect(checkCopy(parseCopy(VALID), MANIFEST_PERMISSIONS)).toEqual([]);
  });

  it('fails a summary over 132 characters', () => {
    const long = VALID.replace(
      /^summary: .*$/m,
      `summary: ${'x'.repeat(133)}`,
    );
    expect(checkCopy(parseCopy(long), MANIFEST_PERMISSIONS).join(' ')).toMatch(/summary.*132/i);
  });

  it('fails a title over 75 characters', () => {
    const long = VALID.replace(/^title: .*$/m, `title: ${'x'.repeat(76)}`);
    expect(checkCopy(parseCopy(long), MANIFEST_PERMISSIONS).join(' ')).toMatch(/title.*75/i);
  });

  it('fails an empty required field', () => {
    const blank = VALID.replace(/^single_purpose: .*$/m, 'single_purpose: ');
    expect(checkCopy(parseCopy(blank), MANIFEST_PERMISSIONS).join(' ')).toMatch(/single_purpose/);
  });

  it('fails a manifest permission with no justification', () => {
    const failures = checkCopy(parseCopy(VALID), [...MANIFEST_PERMISSIONS, 'tabs']);
    expect(failures.join(' ')).toMatch(/tabs/);
  });

  it('fails a justification for a permission the manifest does not request', () => {
    // ` {2}` rather than two literal spaces: `no-regex-spaces` rejects the literal form, and the
    // indent is load-bearing here — it is what makes this a nested `permissions:` entry.
    const extra = VALID.replace(
      /^ {2}storage: .*$/m,
      '  storage: Per-origin opt-in only.\n  bookmarks: Nothing requests this.',
    );
    expect(checkCopy(parseCopy(extra), MANIFEST_PERMISSIONS).join(' ')).toMatch(/bookmarks/);
  });

  it('fails an empty detailed description', () => {
    const empty = VALID.slice(0, VALID.lastIndexOf('---') + 3);
    expect(checkCopy(parseCopy(empty), MANIFEST_PERMISSIONS).join(' ')).toMatch(/description/i);
  });

  it('fails a detailed description over 16,000 characters', () => {
    const bloated = VALID + 'x'.repeat(16_001);
    expect(checkCopy(parseCopy(bloated), MANIFEST_PERMISSIONS).join(' ')).toMatch(
      /description.*16000/i,
    );
  });

  // The store's summary field is plain text; markup is rendered literally, not interpreted.
  it('fails a summary containing markup', () => {
    const markup = VALID.replace(/^summary: .*$/m, 'summary: Inspect <b>every</b> AG-UI event.');
    expect(checkCopy(parseCopy(markup), MANIFEST_PERMISSIONS).join(' ')).toMatch(/markup/i);
  });

  it.each(['privacy_policy_url', 'website', 'support_url'])(
    'fails a %s that is not https',
    (field) => {
      const insecure = VALID.replace(
        new RegExp(`^${field}: .*$`, 'm'),
        `${field}: http://example.com`,
      );
      expect(checkCopy(parseCopy(insecure), MANIFEST_PERMISSIONS).join(' ')).toMatch(
        new RegExp(`${field} must be an https URL`),
      );
    },
  );

  it.each(['website', 'support_url'])('fails when %s is missing entirely', (field) => {
    const without = VALID.replace(new RegExp(`^${field}: .*\n`, 'm'), '');
    expect(checkCopy(parseCopy(without), MANIFEST_PERMISSIONS).join(' ')).toMatch(
      new RegExp(`${field} is required`),
    );
  });

});
