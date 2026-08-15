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
] as const;

export interface CopyFields {
  title?: string;
  summary?: string;
  category?: string;
  language?: string;
  single_purpose?: string;
  privacy_policy_url?: string;
  uses_remote_code?: string;
  permissions?: Record<string, string>;
}

export interface Copy {
  fields: CopyFields;
  body: string;
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

  for (const line of front.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const nested = /^ {2}([A-Za-z_][A-Za-z0-9_]*):\s?(.*)$/.exec(line);
    if (inPermissions && nested !== null) {
      permissions[nested[1] as string] = (nested[2] ?? '').trim();
      continue;
    }
    const top = /^([A-Za-z_][A-Za-z0-9_]*):\s?(.*)$/.exec(line);
    if (top === null) {
      throw new Error(`front matter line is not \`key: value\`: ${JSON.stringify(line)}`);
    }
    const key = top[1] as string;
    const value = (top[2] ?? '').trim();
    inPermissions = key === 'permissions';
    if (inPermissions) continue;
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
  if (fields.privacy_policy_url !== undefined && fields.privacy_policy_url !== '') {
    if (!/^https:\/\//.test(fields.privacy_policy_url)) {
      failures.push('privacy_policy_url must be an https URL.');
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
 */
function manifestPermissions(): string[] {
  const source = readFileSync(join(packageRoot, 'manifest.config.ts'), 'utf8');
  const found: string[] = [];
  const permissions = /permissions:\s*\[([^\]]*)\]/.exec(source);
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
    console.error(`FAIL: ${String(failures.length)} problem(s) with the listing copy:\n`);
    for (const failure of failures) console.error(`  - ${failure}\n`);
    process.exit(1);
  }
  console.log('listing copy is within every Chrome Web Store limit.');
  console.log(`  permissions justified: ${manifestPermissions().join(', ')}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]).endsWith('verify-listing-copy.ts')) {
  main();
}
