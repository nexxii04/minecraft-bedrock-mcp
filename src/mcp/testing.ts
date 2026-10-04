/** Test-only helpers shared by unit tests and manual scripts. */
import type { TextResult } from './context.js';

/** Shape of a parsed tool payload: whatever JSON.stringify produced. */
export type JsonPayload = Record<string, unknown>;

/** Parses the first text block of a tool result as JSON. */
export function payloadOf(result: Pick<TextResult, 'content'>): JsonPayload {
  return JSON.parse(result.content[0]?.text ?? '{}') as JsonPayload;
}
