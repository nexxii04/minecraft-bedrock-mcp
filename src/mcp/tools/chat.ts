import { z } from 'zod';

import type { McpContext } from '../context.js';
import type { ToolRegistry } from '../registry.js';
import { handle, resolveConnectedSession } from '../context.js';
import { sessionIdSchema, timeoutSchema } from '../schemas.js';

/**
 * Chat tools.
 *
 * Two things make Bedrock chat different from what an agent might assume: the
 * `text` packet is bidirectional and its payload depends on the message type (this
 * project normalises all variants into one chat-log shape), and servers are not
 * obliged to echo a message back to its sender — so "the message was accepted" is
 * a weaker claim than "I can see my own line", and `send_chat` reports the
 * difference.
 */

const sendChatArgs = {
  sessionId: sessionIdSchema,
  message: z.string().min(1).max(512).describe('Message text. A leading "/" is interpreted by the server as a command.'),
  type: z
    .enum(['chat', 'whisper', 'announcement'])
    .optional()
    .describe(
      'Which text variant to send. "chat" (default) is an ordinary public message; "whisper" is directed; "announcement" is styled as a server announcement.',
    ),
  timeoutMs: timeoutSchema.describe('How long to wait for the server to echo this message back, in milliseconds.'),
};

const chatLogArgs = {
  sessionId: sessionIdSchema,
  limit: z.number().int().min(1).max(500).optional().describe('Maximum number of messages, most recent last. Defaults to 50.'),
  since: z.number().int().optional().describe('Only messages received at or after this Unix timestamp in milliseconds.'),
  source: z.string().optional().describe('Only messages from this exact sender name (case-insensitive).'),
};

export function registerChatTools(registry: ToolRegistry, context: McpContext): void {
  registry.define(
    {
      name: 'send_chat',
      title: 'Send a chat message',
      description:
        'Sends a public chat message as the agent-player. Use it for QA assertions that other players can see the bot talk, or to drive server commands (a leading "/"). `confirmed` means the server echoed the message back to us, which many servers do not do; treat `confirmed: false` as "sent, acceptance unproven" rather than failure.',
      inputSchema: sendChatArgs,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    handle(context, 'send_chat', async (args: z.infer<z.ZodObject<typeof sendChatArgs>>): Promise<unknown> => {
      const session = resolveConnectedSession(context, args.sessionId);
      const result = await session.actions.sendChat(args.message, {
        ...(args.type !== undefined ? { type: args.type } : {}),
        ...(args.timeoutMs !== undefined ? { echoTimeoutMs: args.timeoutMs } : {}),
      });
      return { sessionId: session.id, ...result };
    }),
  );

  registry.define(
    {
      name: 'get_chat_log',
      title: 'Read recent chat',
      description:
        'Returns chat and system messages this session has received, oldest first, from a bounded in-memory buffer (default 200 messages, see MCBE_MAX_CHAT_LOG). Filter by time or sender. This is the cheapest way to see what happened in the world without polling a tool per packet.',
      inputSchema: chatLogArgs,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(context, 'get_chat_log', (args: z.infer<z.ZodObject<typeof chatLogArgs>>): unknown => {
      const session = resolveConnectedSession(context, args.sessionId);
      const messages = session.client.session.getChatLog({
        limit: args.limit ?? 50,
        ...(args.since !== undefined ? { since: args.since } : {}),
        ...(args.source !== undefined ? { source: args.source } : {}),
      });
      return {
        sessionId: session.id,
        count: messages.length,
        messages: messages.map((message) => ({
          at: message.at,
          kind: message.kind,
          source: message.source,
          message: message.message,
          fromSelf: message.fromSelf,
        })),
      };
    }),
  );

  registry.define(
    {
      name: 'get_event_log',
      title: 'Read the recent world event log',
      description:
        'Returns normalised world events (chat, entity spawns and removals, movement, block changes, health changes, dimension changes, spawn, kicks) from a bounded buffer, oldest first. Filter by event type or timestamp. This is the cheapest way for an agent to catch up on what happened while it was reasoning.',
      inputSchema: {
        sessionId: sessionIdSchema,
        limit: z.number().int().min(1).max(1000).optional().describe('Maximum number of events. Defaults to 100.'),
        types: z
          .array(z.string())
          .optional()
          .describe('Restrict to these event types, for example ["block_updated","entity_spawned"]. See docs/TOOLS.md for the full list.'),
        since: z.number().int().optional().describe('Only events at or after this Unix timestamp in milliseconds.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(context, 'get_event_log', (args: { sessionId?: string; limit?: number; types?: string[]; since?: number }): unknown => {
      const session = resolveConnectedSession(context, args.sessionId);
      const events = session.client.session.getEventLog({
        limit: args.limit ?? 100,
        ...(args.types !== undefined ? { types: args.types } : {}),
        ...(args.since !== undefined ? { since: args.since } : {}),
      });
      return { sessionId: session.id, count: events.length, events };
    }),
  );

  registry.define(
    {
      name: 'wait_for_chat',
      title: 'Wait for a chat message',
      description:
        'Blocks until a chat message matching a substring arrives (or the timeout expires), then returns the messages seen. Designed for QA flows that trigger something on the server and need to assert on the reply without polling get_chat_log in a tight loop.',
      inputSchema: {
        sessionId: sessionIdSchema,
        contains: z.string().min(1).describe('Substring to look for in incoming message text.'),
        from: z.string().optional().describe('Restrict to messages sent by this exact sender name.'),
        timeoutMs: z.number().int().min(100).max(120_000).optional().describe('How long to wait, in milliseconds. Defaults to 10000.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(
      context,
      'wait_for_chat',
      async (args: { sessionId?: string; contains: string; from?: string; timeoutMs?: number }): Promise<unknown> => {
        const session = resolveConnectedSession(context, args.sessionId);
        const event = await session.client.waitForDomainEvent(
          (candidate) =>
            candidate.type === 'chat' &&
            candidate.chat.message.includes(args.contains) &&
            (args.from === undefined || candidate.chat.source.toLowerCase() === args.from.toLowerCase()),
          args.timeoutMs ?? 10_000,
          'matching chat message',
        );
        if (event === null || event.type !== 'chat') {
          return {
            sessionId: session.id,
            matched: false,
            note: `No chat message containing "${args.contains}" arrived within the timeout.`,
          };
        }
        return { sessionId: session.id, matched: true, chat: event.chat };
      },
    ),
  );
}
