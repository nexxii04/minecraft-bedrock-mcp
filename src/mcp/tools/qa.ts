import { z } from 'zod';

import { readBlock } from '../../bedrock/terrain.js';
import { blockIdIndex } from '../../bedrock/vanilla-blocks.js';
import type { McpContext, TextResult } from '../context.js';
import { handle, resolveConnectedSession } from '../context.js';
import type { ToolRegistry } from '../registry.js';
import { sessionIdSchema } from '../schemas.js';

/**
 * QA / testing tools.
 *
 * `run_action_sequence` runs a list of tool calls against one session then
 * evaluates declarative assertions; `assert_session_state` evaluates them on their
 * own; `wait_for_event` blocks until something specific happens, so a scenario
 * synchronises on server-side effects instead of sleeps.
 *
 * Assertions read through one of several flattened views using dotted paths
 * (`position.x`, `connection.state`, `health`), so a scenario is plain data. A
 * snapshot alone only answers questions about bookkeeping, so each `source`
 * exposes the view actually under test (command output, chat, events, block,
 * inventory) rather than forcing an assertion on counters like `trackedBlocks`.
 * Every result says which view it read.
 */

/** The views an assertion can read through. */
const ASSERTION_SOURCES = ['state', 'command', 'chat', 'events', 'block', 'inventory'] as const;

type AssertionSource = (typeof ASSERTION_SOURCES)[number];

const assertionSchema = z.object({
  name: z.string().min(1).describe('Label for this assertion, echoed back in the result.'),
  source: z
    .enum(ASSERTION_SOURCES)
    .optional()
    .describe(
      'Which view to read. "state" (default) is the session snapshot: position, health, counts, connection state. "command" is the most recent command_output: `succeeded`, `output`, `command`, `acknowledged`, `requestId`. "chat" is the chat log: `count`, `text` (all messages joined), and `last.*`. "events" is event counts by type plus `total` and `last.*`, so "at least one block_updated happened" is `path: "block_updated"`. "block" is what is at a coordinate — pass `at`, or it reads where the player is standing. "inventory" is the inventory: `count`, `slots`, `byName.*` (name to total count) and `held` for the held stack.',
    ),
  path: z
    .string()
    .min(1)
    .describe(
      'Dotted path into the chosen view, for example "position.y", "connection.state", "health", "byName.minecraft:dirt", "succeeded", "text".',
    ),
  at: z
    .object({ x: z.number().int(), y: z.number().int(), z: z.number().int() })
    .optional()
    .describe('Coordinate to read when `source` is "block". Defaults to the block the player is standing in.'),
  equals: z.unknown().optional().describe('Assert the value equals this.'),
  notEquals: z.unknown().optional().describe('Assert the value differs from this.'),
  contains: z
    .string()
    .optional()
    .describe(
      'Assert a string value contains this substring, or an array value contains this element. Useful for command output and chat text.',
    ),
  greaterThan: z.number().optional().describe('Assert a numeric value is strictly greater than this.'),
  lessThan: z.number().optional().describe('Assert a numeric value is strictly less than this.'),
  atLeast: z.number().optional().describe('Assert a numeric value is greater than or equal to this.'),
  atMost: z.number().optional().describe('Assert a numeric value is less than or equal to this.'),
  tolerance: z.number().min(0).optional().describe('Allowed difference when comparing numbers with `equals`. Defaults to 0.0001.'),
  isNull: z.boolean().optional().describe('Assert the value is (or is not) null.'),
});

const stepSchema = z.object({
  tool: z
    .string()
    .min(1)
    .describe('Name of any registered tool to call, for example "move_to", "send_chat", "break_block", or the pseudo-step "wait".'),
  args: z.record(z.string(), z.unknown()).optional().describe('Arguments for that tool, exactly as you would pass them directly.'),
});

const runSequenceArgs = {
  sessionId: sessionIdSchema,
  steps: z.array(stepSchema).min(1).max(100).describe('Ordered steps: each is a tool call, or {"tool":"wait","args":{"ms":500}} to pause.'),
  stopOnFailure: z
    .boolean()
    .optional()
    .describe(
      'Abort the run when a step returns an error or reports confirmed: false. Defaults to false, which runs every step and reports per-step outcomes.',
    ),
  assertions: z.array(assertionSchema).optional().describe('Checks evaluated against the session state after the steps finish.'),
  assertionsAfterEachStep: z
    .boolean()
    .optional()
    .describe('Evaluate the assertions after every step instead of only at the end. Defaults to false.'),
};

const assertArgs = {
  sessionId: sessionIdSchema,
  assertions: z.array(assertionSchema).min(1).describe('Checks to evaluate against the current session state.'),
};

const waitForEventArgs = {
  sessionId: sessionIdSchema,
  types: z.array(z.string()).min(1).describe('Event types to wait for, for example ["block_updated"] or ["chat","entity_spawned"].'),
  predicatePath: z
    .string()
    .optional()
    .describe('Optional dotted path into the event to match, for example "chat.message" or "position.y".'),
  contains: z.string().optional().describe('Optional substring the matched value must contain (case-sensitive).'),
  equals: z.unknown().optional().describe('Optional exact value the matched field must equal.'),
  timeoutMs: z.number().int().min(100).max(120_000).optional().describe('How long to wait. Defaults to 10000 ms.'),
};

/**
 * Flattens a nested object into dotted keys. Arrays are kept whole; objects are
 * expanded up to `maxDepth`, so a pathological payload cannot explode into
 * thousands of keys.
 */
function flattenValue(value: unknown, maxDepth = 4): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  const walk = (entry: unknown, prefix: string, depth: number): void => {
    if (entry === null || entry === undefined || typeof entry !== 'object' || depth > maxDepth) {
      flat[prefix] = entry;
      return;
    }
    if (Array.isArray(entry)) {
      flat[prefix] = entry;
      return;
    }
    for (const [key, nested] of Object.entries(entry as Record<string, unknown>)) {
      walk(nested, prefix === '' ? key : `${prefix}.${key}`, depth + 1);
    }
  };
  walk(value, '', 0);
  return flat;
}

/** Flattens the session snapshot so assertions can use dotted paths. */
function flattenSnapshot(context: McpContext, sessionId?: string): Record<string, unknown> {
  const snapshot = context.manager.require(sessionId).client.session.snapshot();
  const flat = flattenValue(snapshot);
  // A few convenience aliases agents reach for by instinct.
  flat['inventorySlots'] = snapshot.inventorySlots;
  flat['trackedEntities'] = snapshot.trackedEntities;
  flat['chunksLoaded'] = snapshot.chunksLoaded;
  flat['chunksDecoded'] = snapshot.chunksDecoded;
  flat['chunksFailed'] = snapshot.chunksFailed;
  flat['isAlive'] = snapshot.isAlive;
  return flat;
}

/** The most recent event of a type, or `null`. */
function lastEvent(context: McpContext, sessionId: string | undefined, type: string): Record<string, unknown> | null {
  const events = context.manager.require(sessionId).client.session.getEventLog({ types: [type] });
  const last = events[events.length - 1];
  return last === undefined ? null : (last as unknown as Record<string, unknown>);
}

/**
 * The `command` view: the server's answer to the last command we ran, read from
 * the event log so it reflects the command however it was issued.
 */
function commandRoot(context: McpContext, sessionId: string | undefined): Record<string, unknown> {
  const event = lastEvent(context, sessionId, 'command_executed');
  if (event === null) {
    return { count: 0, succeeded: null, acknowledged: false, output: '', command: null, requestId: null, messages: [] };
  }
  const messages = Array.isArray(event['messages']) ? event['messages'] : [];
  const text = messages
    .map((message) => (typeof (message as { message?: unknown }).message === 'string' ? (message as { message: string }).message : ''))
    .join('\n');
  return {
    count: 1,
    succeeded: event['succeeded'] ?? (typeof event['successCount'] === 'number' ? event['successCount'] > 0 : null),
    acknowledged: event['requestId'] !== '',
    outputType: event['outputType'] ?? null,
    requestId: event['requestId'] ?? null,
    originType: event['originType'] ?? null,
    messages,
    messageCount: messages.length,
    // The message text joined, colour codes stripped the same way the tool's own
    // `detail.output` is, so `contains` on it reads naturally.
    output: text,
  };
}

/**
 * The `chat` view: what the server said, plus our own sends. `text` is every
 * message joined, making "the server mentioned X" a one-line assertion.
 */
function chatRoot(context: McpContext, sessionId: string | undefined): Record<string, unknown> {
  const log = context.manager.require(sessionId).client.session.getChatLog();
  const last = log[log.length - 1];
  const flat = flattenValue({ last: last ?? null });
  return {
    count: log.length,
    text: log.map((entry) => `${entry.source === '' ? '' : `${entry.source}: `}${entry.message}`).join('\n'),
    kinds: [...new Set(log.map((entry) => entry.kind))],
    ...flat,
  };
}

/**
 * The `events` view: counts by event type, so "this happened at all" is assertable
 * (`path: "block_updated", atLeast: 1`). `last` is the most recent event.
 */
function eventsRoot(context: McpContext, sessionId: string | undefined): Record<string, unknown> {
  const events = context.manager.require(sessionId).client.session.getEventLog();
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  const last = events[events.length - 1];
  return {
    total: events.length,
    ...counts,
    ...flattenValue({ last: last ?? null }),
  };
}

/**
 * The `block` view: what is at a coordinate, from the same terrain reader the
 * world tools use. It carries `source` and `unknown`, so asserting on `name` alone
 * cannot quietly accept "we know nothing" as "it is not stone".
 */
function blockRoot(context: McpContext, sessionId: string | undefined, at?: { x: number; y: number; z: number }): Record<string, unknown> {
  const session = context.manager.require(sessionId);
  const sessionState = session.client.session;
  const target =
    at ??
    (sessionState.position === null
      ? undefined
      : { x: Math.floor(sessionState.position.x), y: Math.floor(sessionState.position.y), z: Math.floor(sessionState.position.z) });
  if (target === undefined) {
    throw new Error('Cannot read a block: pass `at`, or move the agent first so its position is known.');
  }
  const reading = readBlock(sessionState.chunks, sessionState.blocks, target);
  const entry =
    reading.blockRuntimeId === null ? undefined : blockIdIndex(sessionState.connection.version).byNetworkId(reading.blockRuntimeId);
  return {
    ...flattenValue({ reading }),
    at: target,
    // Flattened aliases so the common assertions do not have to know the shape.
    known: reading.blockRuntimeId !== null,
    blockRuntimeId: reading.blockRuntimeId,
    name: entry?.name ?? null,
    source: reading.source,
    unknown: reading.unknown,
  };
}

/**
 * The `inventory` view. `byName` maps item name to total count across slots (the
 * form most assertions want); `byShortName` is the same without the `minecraft:`
 * prefix.
 */
function inventoryRoot(context: McpContext, sessionId: string | undefined): Record<string, unknown> {
  const session = context.manager.require(sessionId);
  const sessionState = session.client.session;
  const items = sessionState.getInventory('inventory');
  const byName: Record<string, number> = {};
  const byShortName: Record<string, number> = {};
  for (const item of items) {
    const name = item.name ?? sessionState.getItemName(item.networkId) ?? `runtime_id_${String(item.networkId)}`;
    byName[name] = (byName[name] ?? 0) + item.count;
    const short = name.startsWith('minecraft:') ? name.slice('minecraft:'.length) : name;
    byShortName[short] = (byShortName[short] ?? 0) + item.count;
  }
  const held = sessionState.getHeldItem();
  return {
    count: items.length,
    byName,
    byShortName,
    slots: items,
    held: held === null ? null : flattenValue(held),
    heldName: held?.name ?? null,
    heldCount: held?.count ?? 0,
    selectedHotbarSlot: sessionState.selectedHotbarSlot,
  };
}

/** Builds the view one assertion reads through. */
function assertionRoot(
  context: McpContext,
  sessionId: string | undefined,
  assertion: AssertionSpec,
): { source: AssertionSource; root: Record<string, unknown> } {
  const source = assertion.source ?? 'state';
  switch (source) {
    case 'command':
      return { source, root: commandRoot(context, sessionId) };
    case 'chat':
      return { source, root: chatRoot(context, sessionId) };
    case 'events':
      return { source, root: eventsRoot(context, sessionId) };
    case 'block':
      return { source, root: blockRoot(context, sessionId, assertion.at) };
    case 'inventory':
      return { source, root: inventoryRoot(context, sessionId) };
    default:
      return { source, root: flattenSnapshot(context, sessionId) };
  }
}

/** Resolves a dotted path against an object, returning `undefined` when absent. */
function readPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Resolves a dotted path against the *flattened* snapshot.
 *
 * `flattenSnapshot` already stores `position.x` as a literal key, so an exact
 * key hit must win over walking nested objects — otherwise `position.x` would
 * be looked up as `flat.position?.x`, find nothing, and report `undefined`
 * even though the state clearly contains the value.
 */
function readFlatPath(flat: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(flat, path)) return flat[path];
  return readPath(flat, path);
}

interface AssertionSpec {
  name: string;
  path: string;
  source?: AssertionSource;
  at?: { x: number; y: number; z: number };
  equals?: unknown;
  notEquals?: unknown;
  greaterThan?: number;
  lessThan?: number;
  atLeast?: number;
  atMost?: number;
  tolerance?: number;
  isNull?: boolean;
}

function evaluateAssertions(
  context: McpContext,
  sessionId: string | undefined,
  assertions: AssertionSpec[],
): {
  name: string;
  source: AssertionSource;
  passed: boolean;
  expected: unknown;
  actual: unknown;
  message?: string;
}[] {
  return assertions.map((assertion) => {
    // Read through the view `source` selects, and report it back.
    const { source, root } = assertionRoot(context, sessionId, assertion);
    const actual = readFlatPath(root, assertion.path);
    const expected: Record<string, unknown> = {};
    let passed = true;
    let message: string | undefined;

    if (assertion.equals !== undefined) {
      expected.equals = assertion.equals;
      const tolerance = assertion.tolerance ?? 0.0001;
      if (typeof actual === 'number' && typeof assertion.equals === 'number') {
        if (Math.abs(actual - assertion.equals) > tolerance) {
          passed = false;
          message = `expected ${assertion.equals} ±${tolerance}, got ${actual}`;
        }
      } else if (actual !== assertion.equals) {
        passed = false;
        message = `expected ${JSON.stringify(assertion.equals)}, got ${JSON.stringify(actual)}`;
      }
    }
    if (assertion.notEquals !== undefined) {
      expected.notEquals = assertion.notEquals;
      if (actual === assertion.notEquals) {
        passed = false;
        message = `expected a value different from ${JSON.stringify(assertion.notEquals)}`;
      }
    }
    for (const [key, predicate] of [
      ['greaterThan', (value: number, bound: number) => value > bound],
      ['lessThan', (value: number, bound: number) => value < bound],
      ['atLeast', (value: number, bound: number) => value >= bound],
      ['atMost', (value: number, bound: number) => value <= bound],
    ] as const) {
      const bound = assertion[key];
      if (bound === undefined) continue;
      expected[key] = bound;
      if (typeof actual !== 'number') {
        passed = false;
        message = `expected a number to compare with ${key} ${bound}, got ${JSON.stringify(actual)}`;
      } else if (!predicate(actual, bound)) {
        passed = false;
        message = `expected ${key} ${bound}, got ${actual}`;
      }
    }
    if (assertion.isNull !== undefined) {
      expected.isNull = assertion.isNull;
      const isNull = actual === null || actual === undefined;
      if (isNull !== assertion.isNull) {
        passed = false;
        message = `expected ${assertion.isNull ? 'null' : 'non-null'}`;
      }
    }
    if (Object.keys(expected).length === 0) {
      passed = false;
      message = 'assertion has no comparison (set equals, notEquals, greaterThan, lessThan, atLeast, atMost or isNull)';
    }

    const result: { name: string; source: AssertionSource; passed: boolean; expected: unknown; actual: unknown; message?: string } = {
      name: assertion.name,
      source,
      passed,
      expected,
      actual,
    };
    if (message !== undefined) result.message = message;
    return result;
  });
}

/** A step's payload is JSON text; scenario logic wants the object back. */
function parseStepResult(result: TextResult): unknown {
  const first = result.content[0];
  if (first === undefined) return null;
  try {
    return JSON.parse(first.text) as unknown;
  } catch {
    return first.text;
  }
}

export function registerQaTools(registry: ToolRegistry, context: McpContext): void {
  registry.define(
    {
      name: 'run_action_sequence',
      title: 'Run a sequence of actions with assertions',
      description:
        'Executes an ordered list of tool calls against one session and then evaluates assertions about the resulting state. Each step names a tool and its arguments, so a scenario is plain JSON you can store, diff and re-run. Use it for reproducible server QA: connect, run the sequence, assert the world changed as expected. Steps report their own `ok`/`confirmed` outcome, and a step that returns an error is captured rather than aborting the run unless stopOnFailure is set.',
      inputSchema: runSequenceArgs,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handle(
      context,
      'run_action_sequence',
      async (args: {
        sessionId?: string;
        steps: { tool: string; args?: Record<string, unknown> }[];
        stopOnFailure?: boolean;
        assertions?: AssertionSpec[];
        assertionsAfterEachStep?: boolean;
      }): Promise<unknown> => {
        resolveConnectedSession(context, args.sessionId);
        const results: {
          step: number;
          tool: string;
          ok: boolean;
          confirmed: boolean | null;
          elapsedMs: number;
          error?: string;
          result: unknown;
        }[] = [];
        const assertionRuns: { afterStep: number | 'final'; results: ReturnType<typeof evaluateAssertions> }[] = [];
        let aborted = false;
        let abortedReason: string | null = null;

        for (const [index, step] of args.steps.entries()) {
          const stepNumber = index + 1;
          const startedAt = Date.now();

          if (step.tool === 'wait') {
            const ms = Number(step.args?.['ms'] ?? 500);
            await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(ms, 0), 60_000)));
            results.push({
              step: stepNumber,
              tool: 'wait',
              ok: true,
              confirmed: null,
              elapsedMs: Date.now() - startedAt,
              result: { waitedMs: ms },
            });
            // A wait is a step like any other for `assertionsAfterEachStep`.
            if (args.assertionsAfterEachStep === true && args.assertions !== undefined && args.assertions.length > 0) {
              assertionRuns.push({
                afterStep: stepNumber,
                results: evaluateAssertions(context, args.sessionId, args.assertions),
              });
            }
            continue;
          }

          if (!registry.has(step.tool)) {
            results.push({
              step: stepNumber,
              tool: step.tool,
              ok: false,
              confirmed: null,
              elapsedMs: Date.now() - startedAt,
              error: `Unknown tool "${step.tool}". Available tools: ${registry.names().join(', ')}`,
              result: null,
            });
            if (args.stopOnFailure === true) {
              aborted = true;
              abortedReason = `step ${stepNumber} failed: unknown tool`;
              break;
            }
            continue;
          }

          try {
            const stepResult = await registry.invoke(step.tool, {
              ...(step.args ?? {}),
              ...(args.sessionId !== undefined && step.args?.['sessionId'] === undefined ? { sessionId: args.sessionId } : {}),
            });
            const payload = parseStepResult(stepResult);
            const record = (payload ?? {}) as Record<string, unknown>;
            const ok = stepResult.isError !== true;
            const confirmed = typeof record['confirmed'] === 'boolean' ? record['confirmed'] : null;
            const entry: (typeof results)[number] = {
              step: stepNumber,
              tool: step.tool,
              ok,
              confirmed,
              elapsedMs: Date.now() - startedAt,
              result: payload,
            };
            if (!ok) {
              // Stringify structured errors instead of letting `String()` produce
              // "[object Object]".
              const reported: unknown = record['error'];
              entry.error =
                typeof reported === 'string' ? reported : reported === undefined ? 'tool reported an error' : JSON.stringify(reported);
            }
            results.push(entry);
            if (args.stopOnFailure === true && (!ok || confirmed === false)) {
              aborted = true;
              abortedReason = `step ${stepNumber} (${step.tool}) did not succeed`;
            }
          } catch (error) {
            results.push({
              step: stepNumber,
              tool: step.tool,
              ok: false,
              confirmed: null,
              elapsedMs: Date.now() - startedAt,
              error: error instanceof Error ? error.message : String(error),
              result: null,
            });
            if (args.stopOnFailure === true) {
              aborted = true;
              abortedReason = `step ${stepNumber} (${step.tool}) threw`;
            }
          }

          if (aborted) break;

          if (args.assertionsAfterEachStep === true && args.assertions !== undefined && args.assertions.length > 0) {
            assertionRuns.push({
              afterStep: stepNumber,
              results: evaluateAssertions(context, args.sessionId, args.assertions),
            });
          }
        }

        const finalAssertions =
          args.assertions !== undefined && args.assertions.length > 0 ? evaluateAssertions(context, args.sessionId, args.assertions) : [];

        const passed = finalAssertions.every((assertion) => assertion.passed) && results.every((result) => result.ok);

        return {
          sessionId: args.sessionId ?? context.manager.defaultSessionId,
          success: passed,
          aborted,
          abortedReason,
          stepsRun: results.length,
          stepsTotal: args.steps.length,
          steps: results,
          assertions: finalAssertions,
          assertionsAfterEachStep: assertionRuns,
          stateAfter: flattenSnapshot(context, args.sessionId),
        };
      },
    ),
  );

  registry.define(
    {
      name: 'assert_session_state',
      title: 'Assert on the session state',
      description:
        'Evaluates declarative assertions against the current session state without performing any action. Each assertion reads a dotted path from the session snapshot (`position.x`, `connection.state`, `health`, `trackedEntities`, `chunksLoaded`, ...) and compares it. Returns per-assertion results plus the flattened state, so a failure shows exactly what the value was.',
      inputSchema: assertArgs,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(context, 'assert_session_state', (args: { sessionId?: string; assertions: AssertionSpec[] }): unknown => {
      resolveConnectedSession(context, args.sessionId);
      const flat = flattenSnapshot(context, args.sessionId);
      const results = evaluateAssertions(context, args.sessionId, args.assertions);
      return {
        sessionId: args.sessionId ?? context.manager.defaultSessionId,
        success: results.every((result) => result.passed),
        assertions: results,
        state: flat,
      };
    }),
  );

  registry.define(
    {
      name: 'wait_for_event',
      title: 'Wait for a specific world event',
      description:
        'Blocks until the given event types occur (optionally filtered by a field value), then returns the matched event. This is how a QA scenario synchronises on a server-side effect: wait for the block_updated caused by a break, or for the chat line a command produces, instead of sleeping and hoping.',
      inputSchema: waitForEventArgs,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(
      context,
      'wait_for_event',
      async (args: {
        sessionId?: string;
        types: string[];
        predicatePath?: string;
        contains?: string;
        equals?: unknown;
        timeoutMs?: number;
      }): Promise<unknown> => {
        const session = resolveConnectedSession(context, args.sessionId);
        const wanted = new Set(args.types);
        const event = await session.client.waitForDomainEvent(
          (candidate) => {
            if (!wanted.has(candidate.type)) return false;
            if (args.predicatePath === undefined) return true;
            const value = readPath(candidate, args.predicatePath);
            if (args.equals !== undefined) return value === args.equals;
            if (args.contains !== undefined) return typeof value === 'string' && value.includes(args.contains);
            return true;
          },
          args.timeoutMs ?? 10_000,
          `event ${args.types.join('|')}`,
        );
        if (event === null) {
          return {
            sessionId: session.id,
            matched: false,
            note: `No ${args.types.join('/')} event matched within the timeout. Check get_event_log for what did happen.`,
          };
        }
        return { sessionId: session.id, matched: true, event };
      },
    ),
  );

  registry.define(
    {
      name: 'snapshot_session_state',
      title: 'Snapshot the full session state',
      description:
        'Returns a flat, assertion-friendly view of everything the session knows: connection details, position, rotation, dimension, game mode, health, inventory slot count, entity and block counts, chunk radius and packet counters. Useful as the "actual" side of an expected/actual comparison.',
      inputSchema: { sessionId: sessionIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(context, 'snapshot_session_state', (args: { sessionId?: string }): unknown => {
      const session = resolveConnectedSession(context, args.sessionId);
      return {
        sessionId: session.id,
        raw: session.client.session.snapshot(),
        flat: flattenSnapshot(context, args.sessionId),
      };
    }),
  );
}
