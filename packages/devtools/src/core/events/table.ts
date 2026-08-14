/**
 * Hand-written wrapper over the generated event table.
 *
 * Everything downstream reads the table through this module so the generated
 * file stays a dumb data blob and lookups are prototype-safe.
 */
import {
  EVENT_TABLE,
  EVENT_TYPES,
  type EventSpec,
  type FieldKind,
  type FieldSpec,
} from './event-table.generated';

export type { EventSpec, FieldKind, FieldSpec };
export { EVENT_TABLE, EVENT_TYPES };

/**
 * Superseded by the REASONING_* family. Decoded normally, flagged as deprecated.
 */
export const DEPRECATED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'THINKING_START',
  'THINKING_END',
  'THINKING_TEXT_MESSAGE_START',
  'THINKING_TEXT_MESSAGE_CONTENT',
  'THINKING_TEXT_MESSAGE_END',
]);

export function getEventSpec(type: string): EventSpec | undefined {
  if (!Object.prototype.hasOwnProperty.call(EVENT_TABLE, type)) return undefined;
  return EVENT_TABLE[type];
}

export function isKnownEventType(type: string): boolean {
  return getEventSpec(type) !== undefined;
}

export function isDeprecatedEventType(type: string): boolean {
  return DEPRECATED_EVENT_TYPES.has(type);
}

export type ChunkKind = 'text' | 'tool' | 'reasoning';

const CHUNK_KIND_BY_TYPE: ReadonlyMap<string, ChunkKind> = new Map<string, ChunkKind>([
  ['TEXT_MESSAGE_CHUNK', 'text'],
  ['TOOL_CALL_CHUNK', 'tool'],
  ['REASONING_MESSAGE_CHUNK', 'reasoning'],
]);

export function chunkKindOf(type: string): ChunkKind | undefined {
  return CHUNK_KIND_BY_TYPE.get(type);
}
