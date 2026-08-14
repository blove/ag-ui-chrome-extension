/**
 * Structural validation of a captured AG-UI payload against the generated
 * event table. Deliberately permissive about extra properties: an unrecognised
 * field is forward compatibility, not a bug.
 */
import { makeIssue, type Issue } from '../model/types';
import { getEventSpec, type FieldKind } from './table';

function invalid(message: string, seq: number, path?: string): Issue {
  return makeIssue('shape-invalid', message, seq, path === undefined ? {} : { path });
}

/** Human-readable runtime type, used in the "got X" half of a message. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * `literal` and `unknown` kinds carry no runtime constraint — Zod models them
 * as literals, unions or `z.any()`, so presence is all we can assert.
 */
function matchesKind(value: unknown, kind: FieldKind): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'literal':
    case 'unknown':
      return true;
    default:
      return true;
  }
}

export function checkShape(raw: unknown, seq: number): Issue[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return [invalid(`event is not an object, got ${describe(raw)}`, seq)];
  }

  const record = raw as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== 'string') {
    return [invalid(`event has no string \`type\` field, got ${describe(type)}`, seq, 'type')];
  }

  const spec = getEventSpec(type);
  if (spec === undefined) {
    return [makeIssue('unknown-event-type', `unknown event type \`${type}\``, seq, { path: 'type' })];
  }

  const issues: Issue[] = [];
  for (const field of spec.fields) {
    const value = record[field.name];

    if (value === undefined) {
      if (field.required) {
        issues.push(invalid(`${type}: missing required field \`${field.name}\``, seq, field.name));
      }
      continue;
    }

    if (!matchesKind(value, field.kind)) {
      issues.push(
        invalid(
          `${type}: field \`${field.name}\` should be ${field.kind}, got ${describe(value)}`,
          seq,
          field.name,
        ),
      );
    }
  }

  return issues;
}
