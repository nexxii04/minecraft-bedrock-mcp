import { z } from 'zod';

import type { McpContext } from '../context.js';
import type { ToolRegistry } from '../registry.js';
import { handle, resolveConnectedSession } from '../context.js';
import { sessionIdSchema } from '../schemas.js';

/**
 * Command tools.
 *
 * Bedrock offers two ways to run a server command: a `/`-prefixed line through
 * `text` (what `send_chat` does), which many servers honour but the protocol does
 * not promise a reply to, and `command_request`, which is specified to answer with
 * `command_output`. This module wraps the second, so "did the command run?" is
 * answerable here and guesswork there.
 *
 * The confirmation model is deliberately three-valued: `confirmed: false` plus a
 * warning means *no reply*, while `detail.succeeded === false` means *the server
 * replied and said no*. Those need different fixes.
 */

const listCommandsArgs = {
  sessionId: sessionIdSchema,
  search: z
    .string()
    .max(128)
    .optional()
    .describe(
      'Case-insensitive substring matched against the command name, its aliases and its description, e.g. "give", "tp" or "weather". A leading slash is ignored. Omit to list everything.',
    ),
  limit: z.number().int().min(1).max(500).optional().describe('Maximum number of commands to return, alphabetically. Defaults to 100.'),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(30_000)
    .optional()
    .describe(
      'How long to wait for the server to announce its commands when the catalogue is still empty, in milliseconds. Defaults to 3000.',
    ),
};

const runCommandArgs = {
  sessionId: sessionIdSchema,
  command: z
    .string()
    .min(1)
    .max(512)
    .describe(
      'The command to run, with or without a leading slash, e.g. "gamemode creative", "/tp @s 0 64 0", "give @s diamond 64". Bedrock servers strip the slash themselves, so either form works. Maximum 512 characters.',
    ),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(120_000)
    .optional()
    .describe("How long to wait for the server's `command_output` reply, in milliseconds. Defaults to the configured action timeout."),
  waitForOutput: z
    .boolean()
    .optional()
    .describe(
      'Wait for the server to answer (default true). Set false for commands known to be silent — some servers never answer `/say` — which sends the request without waiting; the result is then always `confirmed: false`.',
    ),
  requestId: z
    .string()
    .max(64)
    .optional()
    .describe('Correlation id echoed back by the server. Generated when omitted; pass one only when matching replies by hand.'),
};

export function registerCommandTools(registry: ToolRegistry, context: McpContext): void {
  registry.define(
    {
      name: 'list_commands',
      title: 'List the commands the server accepts',
      description:
        'Returns the command catalogue the server announced through `available_commands`: name, description, permission level, aliases and argument patterns. This is the server\'s own statement of what it will accept, which makes it the fastest way to answer "which features can I exercise here?" — and to notice that a feature you just registered never reached the client. The catalogue is rebuilt from scratch on every announcement, so it is never a mix of old and new. Pass `search` to narrow it; with no match the response names the total and a few real commands so the next call can be well aimed.',
      inputSchema: listCommandsArgs,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(context, 'list_commands', async (args: z.infer<z.ZodObject<typeof listCommandsArgs>>): Promise<unknown> => {
      const session = resolveConnectedSession(context, args.sessionId);

      // The catalogue arrives once during login, so an empty map usually means "not
      // yet" rather than "the server has no commands".
      if (session.client.session.commands.size === 0) {
        await session.client.waitForDomainEvent(
          (event) => event.type === 'commands_available' && event.commandCount > 0,
          args.timeoutMs ?? 3000,
          'command catalogue',
        );
      }

      const all = [...session.client.session.commands.values()].sort((a, b) => a.name.localeCompare(b.name));
      const needle = args.search?.trim().replace(/^\//, '').toLowerCase();
      const matched =
        needle === undefined || needle === ''
          ? all
          : all.filter(
              (command) =>
                command.name.toLowerCase().includes(needle) ||
                command.description.toLowerCase().includes(needle) ||
                command.aliases.some((alias) => alias.toLowerCase().includes(needle)),
            );
      const limit = args.limit ?? 100;
      const commands = matched.slice(0, limit).map((command) => ({
        name: command.name,
        description: command.description,
        permissionLevel: command.permissionLevel,
        ...(command.aliases.length > 0 ? { aliases: command.aliases } : {}),
        ...(command.overloads.length > 0 ? { usage: command.overloads } : {}),
        ...(command.flags !== 0 ? { flags: command.flags } : {}),
      }));

      return {
        sessionId: session.id,
        total: all.length,
        matched: matched.length,
        returned: commands.length,
        ...(args.search !== undefined ? { search: args.search } : {}),
        commands,
        ...(all.length === 0
          ? {
              note: 'The server has not announced any commands to this session. It may send `available_commands` only after the player fully spawns, or it may not support commands at all.',
            }
          : matched.length === 0
            ? {
                note: `No command matched. Some real ones: ${all
                  .slice(0, 8)
                  .map((command) => command.name)
                  .join(', ')}.`,
              }
            : {}),
      };
    }),
  );

  registry.define(
    {
      name: 'run_command',
      title: 'Run a server command',
      description:
        'Runs a Bedrock server command as the agent-player through the guaranteed path (`command_request`) and returns the server\'s own `command_output`. Using this instead of a `/`-prefixed `send_chat` is what makes "did it work?" answerable: `confirmed: true` means the server replied to this exact request, and `detail.output` is its reply with colour codes stripped. `confirmed: false` means no reply arrived, which many commands legitimately never send (so read the warning rather than treating it as failure), while `detail.succeeded: false` means the server replied and refused — wrong syntax, unknown command, or missing permission.',
      inputSchema: runCommandArgs,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    handle(context, 'run_command', async (args: z.infer<z.ZodObject<typeof runCommandArgs>>): Promise<unknown> => {
      const session = resolveConnectedSession(context, args.sessionId);
      const result = await session.actions.runCommand(args.command, {
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        ...(args.waitForOutput !== undefined ? { waitForOutput: args.waitForOutput } : {}),
        ...(args.requestId !== undefined ? { requestId: args.requestId } : {}),
      });
      return { sessionId: session.id, ...result };
    }),
  );
}
