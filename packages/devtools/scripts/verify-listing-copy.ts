/**
 * `listing/copy.md` is the source of truth for the Chrome Web Store listing text. Every
 * constrained field has a limit that is otherwise discovered at the upload form, halfway through
 * a submission.
 *
 * The front-matter parser is hand-written and deliberately small: it handles exactly the shape
 * this one document uses (flat `key: value`, plus a single nested `permissions:` block). Adding a
 * YAML dependency to ship a listing would be absurd. If the document ever needs richer YAML, that
 * is the signal to reach for a parser, not to grow this.
 *
 * BEING SMALL IS ONLY SAFE IF IT FAILS LOUDLY, and "handles exactly this shape" describes what it
 * REJECTS, not where it quietly produces a wrong answer. Two inputs looked like YAML, parsed
 * without complaint, and were wrong:
 *
 *   - QUOTED VALUES. There is no unquoting step, so `title: "AG-UI DevTools"` yielded the
 *     16-character string *including* the quotes, passed every length check green, and would have
 *     put the quotes in the store listing. Anyone with YAML habits quotes a value the moment it
 *     contains a colon or a leading `#`, so this was the likeliest way to be silently wrong. It is
 *     now a hard error — see `rejectQuoted`.
 *   - DUPLICATE KEYS, which are still silently last-wins, at the top level and inside
 *     `permissions:` alike. This is the one wrong-answer path left. It is documented rather than
 *     detected because a duplicate key is a visible editing mistake in a 12-line block, whereas a
 *     quote is something a careful author adds on purpose.
 *
 * Everything else this parser does not understand throws. Prefer keeping it that way over
 * accepting more shapes: a listing that fails to parse costs a minute, and a listing that parses
 * to the wrong string costs a submission round-trip.
 *
 * Run: `pnpm verify:listing`
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Chrome Web Store field limits. */
const LIMITS = { title: 75, summary: 132, description: 16_000 } as const;

const REQUIRED_FIELDS = [
  'title',
  'summary',
  'category',
  'language',
  'single_purpose',
  'privacy_policy_url',
  'website',
  'support_url',
] as const;

/**
 * Every field the store treats as a link. They are checked together because they fail together:
 * `privacy_policy_url` pointed at a file that did not exist for the whole of the listing
 * milestone, and nothing noticed, because "is a URL" and "resolves" are different questions and
 * only the first is checkable offline. This asserts the first for all three rather than for one.
 */
const URL_FIELDS = ['privacy_policy_url', 'website', 'support_url'] as const;

export interface CopyFields {
  title?: string;
  summary?: string;
  category?: string;
  language?: string;
  single_purpose?: string;
  privacy_policy_url?: string;
  website?: string;
  support_url?: string;
  uses_remote_code?: string;
  permissions?: Record<string, string>;
}

export interface Copy {
  fields: CopyFields;
  body: string;
}

/**
 * Refuse a value wrapped in matching quotes, at either nesting level.
 *
 * This parser has no unquoting step and never will (see the file header). Keeping the quotes is a
 * silent corruption that survives every downstream check — the length limits still pass, the
 * permission names still match — and surfaces only as a store listing rendered with stray
 * quotation marks in it. Throwing costs the author one keystroke; not throwing costs a resubmit.
 */
function rejectQuoted(key: string, value: string): void {
  if (value.length >= 2 && /^(".*"|'.*')$/s.test(value)) {
    throw new Error(
      `front matter value for \`${key}\` is quoted. This parser is not YAML — quotes are kept ` +
        'literally and would be uploaded to the store. Remove them.',
    );
  }
}

export function parseCopy(text: string): Copy {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (match === null) {
    throw new Error('listing copy has no `---` front matter block at the top of the file.');
  }
  const [, front = '', body = ''] = match;

  const fields: CopyFields = {};
  const permissions: Record<string, string> = {};
  let inPermissions = false;

  // `permissions:` is the only nested block, so the whole state machine is one boolean.
  //
  // A nested key must be indented EXACTLY two spaces: `^ {2}[A-Za-z_]` cannot match a deeper
  // indent, because the third character would be another space. That is deliberate — a four-space
  // reformat throws instead of quietly parsing as something else.
  //
  // The block has no terminator, and needs none: a zero-indent line fails the `nested` pattern,
  // falls through to the top-level branch, and sets `inPermissions` false there. `inPermissions`
  // is also required in the nested test, so a two-space-indented line appearing before any
  // `permissions:` key is a malformed document rather than a stray justification.
  for (const line of front.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const nested = /^ {2}([A-Za-z_][A-Za-z0-9_]*):\s?(.*)$/.exec(line);
    if (inPermissions && nested !== null) {
      const nestedKey = nested[1] as string;
      const nestedValue = (nested[2] ?? '').trim();
      rejectQuoted(nestedKey, nestedValue);
      permissions[nestedKey] = nestedValue;
      continue;
    }
    const top = /^([A-Za-z_][A-Za-z0-9_]*):\s?(.*)$/.exec(line);
    if (top === null) {
      // An indented, otherwise well-formed line is the reformatting case, and it is the common
      // one. Reporting it as "not `key: value`" sends the author looking at the colon when the
      // line IS `key: value` and only the indent is wrong, so name the actual defect.
      const misindented = /^\s+[A-Za-z_][A-Za-z0-9_]*:/.test(line);
      throw new Error(
        misindented
          ? `front matter nested keys must be indented exactly two spaces: ${JSON.stringify(line)}`
          : `front matter line is not \`key: value\`: ${JSON.stringify(line)}`,
      );
    }
    const key = top[1] as string;
    const value = (top[2] ?? '').trim();
    rejectQuoted(key, value);
    inPermissions = key === 'permissions';
    // `permissions:` itself carries no value; its entries arrive on the following lines.
    if (inPermissions) continue;
    // Last-wins on a duplicate key, silently. See the file header: this is the one remaining
    // path where a document parses cleanly to something other than what it says.
    (fields as Record<string, string>)[key] = value;
  }

  if (Object.keys(permissions).length > 0) fields.permissions = permissions;
  return { fields, body: body.trim() };
}

/** Returns one string per problem. Empty means the copy is submittable. */
export function checkCopy(copy: Copy, manifestPermissions: readonly string[]): string[] {
  const failures: string[] = [];
  const { fields, body } = copy;

  for (const key of REQUIRED_FIELDS) {
    const value = fields[key];
    if (value === undefined || value === '') failures.push(`${key} is required and is empty.`);
  }

  if (fields.title !== undefined && fields.title.length > LIMITS.title) {
    failures.push(
      `title is ${String(fields.title.length)} characters; the store limit is ${String(LIMITS.title)}.`,
    );
  }
  if (fields.summary !== undefined) {
    if (fields.summary.length > LIMITS.summary) {
      failures.push(
        `summary is ${String(fields.summary.length)} characters; the store limit is ${String(LIMITS.summary)}.`,
      );
    }
    if (/<[a-z]/i.test(fields.summary)) {
      failures.push('summary contains markup; the store field is plain text.');
    }
  }
  if (body === '') {
    failures.push('the detailed description (the body below the front matter) is empty.');
  } else if (body.length > LIMITS.description) {
    failures.push(
      `the detailed description is ${String(body.length)} characters; the store limit is ${String(LIMITS.description)}.`,
    );
  }
  for (const key of URL_FIELDS) {
    const value = fields[key];
    if (value === undefined || value === '') continue;
    if (!/^https:\/\//.test(value)) {
      failures.push(`${key} must be an https URL.`);
    }
  }

  const justified = fields.permissions ?? {};
  for (const permission of manifestPermissions) {
    const text = justified[permission];
    if (text === undefined || text === '') {
      failures.push(
        `the manifest requests "${permission}" but the listing justifies no such permission. ` +
          'A reviewer will ask, and an unanswered permission is the most common rejection.',
      );
    }
  }
  for (const permission of Object.keys(justified)) {
    if (!manifestPermissions.includes(permission)) {
      failures.push(
        `the listing justifies "${permission}", which the manifest does not request. Either the ` +
          'justification is stale or the manifest lost a permission.',
      );
    }
  }

  return failures;
}

/* -------------------------------------------------------------------------- */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Read straight from `manifest.config.ts` rather than `dist/manifest.json`, so this runs without
 * a build. `optional_host_permissions` is listed as a permission because the store asks for it to
 * be justified like one.
 *
 * The `\b` is load-bearing. Without it the pattern also matches the tail of
 * `optional_host_permissions:`, and since it takes the FIRST match the result depends on which of
 * the two keys appears earlier in the file. Reorder them and this returns the optional HOST MATCH
 * PATTERNS as if they were permission names, with `storage` and `scripting` silently dropped —
 * the listing would then be checked against permissions the manifest never requested, and the two
 * it does request would go unjustified without any failure. `_` is a word character, so no
 * boundary exists inside `optional_host_permissions`; `\b` pins the match to the top-level key
 * whatever the key order.
 */
function manifestPermissions(): string[] {
  const source = readFileSync(join(packageRoot, 'manifest.config.ts'), 'utf8');
  const found: string[] = [];
  const permissions = /\bpermissions:\s*\[([^\]]*)\]/.exec(source);
  if (permissions !== null) {
    for (const m of (permissions[1] ?? '').matchAll(/'([^']+)'/g)) found.push(m[1] as string);
  }
  if (/optional_host_permissions:\s*\[/.test(source)) found.push('optional_host_permissions');
  return found;
}

function main(): void {
  const copyPath = join(packageRoot, 'listing/copy.md');
  if (!existsSync(copyPath)) {
    console.error(`FAIL: ${copyPath} does not exist.`);
    process.exit(1);
  }
  const failures = checkCopy(parseCopy(readFileSync(copyPath, 'utf8')), manifestPermissions());
  if (failures.length > 0) {
    // Name the file, not just "the listing copy": this runs in CI, and a log line that does not
    // say which document to open makes the reader go find the npm script first.
    console.error(`FAIL: ${String(failures.length)} problem(s) with ${copyPath}:\n`);
    for (const failure of failures) console.error(`  - ${failure}\n`);
    process.exit(1);
  }
  console.log('listing copy is within every Chrome Web Store limit.');
  console.log(`  permissions justified: ${manifestPermissions().join(', ')}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]).endsWith('verify-listing-copy.ts')) {
  main();
}
