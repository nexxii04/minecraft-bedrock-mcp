import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { AgentSession, SessionManager } from '../session-manager.js';

/**
 * Everything a tool handler needs, injected once. Tools go through the session
 * manager rather than importing `bedrock-protocol`, which keeps the connection
 * layer isolated.
 */
export interface McpContext {
  manager: SessionManager;
  config: AppConfig;
  logger: Logger;
  /** Version string reported in the MCP server handshake. */
  version: string;
}

/** Shape of a `tools/call` response payload, kept minimal on purpose. */
export interface TextResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Serialises a tool payload as pretty JSON text. Tools return JSON in a text block
 * rather than a structured content schema: every MCP client renders text, whereas a
 * mismatched `outputSchema` fails the whole call.
 */
export function jsonResult(payload: unknown): TextResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, jsonReplacer, 2) }],
  };
}

/**
 * Turns a thrown value into an MCP tool error. Errors are data (`isError: true`)
 * rather than thrown, so an agent reads the message and decides what to do.
 */
export function errorResult(error: unknown): TextResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }, jsonReplacer, 2) }],
    isError: true,
  };
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Fetches the session a tool should act on, failing with a message that lists
 * the sessions that actually exist.
 */
export function resolveSession(context: McpContext, sessionId?: string): AgentSession {
  return context.manager.require(sessionId);
}

/**
 * Fetches a session and asserts it is usable for player actions. The state check
 * matters: a block-break against a socket that never finished logging in produces
 * a confusing protocol error instead of a clear one.
 */
export function resolveConnectedSession(context: McpContext, sessionId?: string): AgentSession {
  const session = resolveSession(context, sessionId);
  const state = session.client.session.state;
  if (state !== 'initializing' && state !== 'initialized') {
    throw new Error(
      `Session "${session.id}" is not in the world yet (state: ${state}). Call connect_to_server for this session and confirm the response reports "initializing" or "initialized".`,
    );
  }
  return session;
}

/** Wraps a tool handler with uniform error handling. */
export function handle<Args>(context: McpContext, toolName: string, run: (args: Args) => unknown): (args: Args) => Promise<TextResult> {
  return async (args: Args): Promise<TextResult> => {
    try {
      return jsonResult(await run(args));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.logger.warn({ tool: toolName, error: message }, 'tool failed');
      return errorResult(error);
    }
  };
}
