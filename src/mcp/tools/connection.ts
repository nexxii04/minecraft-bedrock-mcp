import { z } from 'zod';

import { RAKNET_BACKENDS } from '../../config.js';
import type { McpContext } from '../context.js';
import type { ToolRegistry } from '../registry.js';
import { handle, resolveSession } from '../context.js';
import { sessionIdSchema } from '../schemas.js';

/**
 * Connection lifecycle tools. `connect_to_server` is the entry point for everything
 * else: it creates (or reuses) a session, opens the connection and reports how far
 * through the login sequence the server let us get.
 */

const connectArgs = {
  sessionId: sessionIdSchema,
  host: z.string().min(1).optional().describe('Bedrock server host or IP. Defaults to MCBE_HOST (127.0.0.1).'),
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe('UDP port of the Bedrock server. Defaults to MCBE_PORT (19132). Bedrock normally listens on 19132/19133.'),
  username: z
    .string()
    .min(1)
    .max(32)
    .optional()
    .describe('In-game name for this agent-player. Must be unique per concurrent session. Defaults to MCBE_USERNAME.'),
  offline: z
    .boolean()
    .optional()
    .describe(
      'Skip Xbox Live login (offline mode). Required for a Bedrock Dedicated Server running with online-mode=false, which is the normal setup for local testing.',
    ),
  version: z
    .string()
    .optional()
    .describe(
      'Pin the Bedrock protocol version, e.g. "1.21.130". Leave unset to use the installed library default and let server discovery pick the right one. Only set this when connecting to an older server that rejects newer clients.',
    ),
  raknetBackend: z
    .enum(RAKNET_BACKENDS)
    .optional()
    .describe(
      'RakNet implementation. jsp-raknet is pure JS and always available; raknet-native is faster but needs a compiler at install time.',
    ),
  skipPing: z
    .boolean()
    .optional()
    .describe(
      'Skip the initial UDP discovery ping. Pinging picks the exact protocol version automatically, so only skip it to save a second.',
    ),
  waitForSpawn: z
    .boolean()
    .optional()
    .describe('Also wait for the server to allow spawning (the point at which the world is interactive). Defaults to true.'),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(600_000)
    .optional()
    .describe('How long to wait for the spawn confirmation, in milliseconds. Defaults to MCBE_SPAWN_TIMEOUT_MS (30000).'),
};

const disconnectArgs = {
  sessionId: sessionIdSchema,
  reason: z.string().max(256).optional().describe('Reason shown in the server logs and to other players.'),
  dispose: z
    .boolean()
    .optional()
    .describe(
      'Also forget the session entirely, freeing the id for a different server later. Defaults to false, which keeps the session reusable.',
    ),
};

export function registerConnectionTools(registry: ToolRegistry, context: McpContext): void {
  registry.define(
    {
      name: 'connect_to_server',
      title: 'Connect to a Minecraft Bedrock server',
      description:
        'Logs this agent in to a Minecraft Bedrock Edition server as a real player, using the RakNet/Bedrock protocol (not Java Edition). Creates the session if it does not exist. Resolves when the server has accepted the login; always check the `spawned` field in the response, because a server can accept the login and then never spawn us into the world (that is what happens with a bare protocol-level test server). After this succeeds the other tools work against the same sessionId.',
      inputSchema: connectArgs,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    handle(context, 'connect_to_server', async (args: z.infer<z.ZodObject<typeof connectArgs>>): Promise<unknown> => {
      const requestedSessionId = args.sessionId ?? context.manager.defaultSessionId;
      const existing = context.manager.get(requestedSessionId);
      if (existing !== undefined && existing.client.isConnected) {
        return {
          sessionId: existing.id,
          alreadyConnected: true,
          warning: 'This session is already connected. Call disconnect first if you want to reconnect to a different server.',
          status: existing.client.session.snapshot(),
        };
      }

      const { session } = await context.manager.connect(args.sessionId, {
        ...(args.host !== undefined ? { host: args.host } : {}),
        ...(args.port !== undefined ? { port: args.port } : {}),
        ...(args.username !== undefined ? { username: args.username } : {}),
        ...(args.offline !== undefined ? { offline: args.offline } : {}),
        ...(args.version !== undefined ? { version: args.version } : {}),
        ...(args.raknetBackend !== undefined ? { raknetBackend: args.raknetBackend } : {}),
        ...(args.skipPing !== undefined ? { skipPing: args.skipPing } : {}),
      });

      const shouldWaitForSpawn = args.waitForSpawn ?? true;
      const spawnTimeoutMs = args.timeoutMs ?? context.config.defaults.spawnTimeoutMs;
      const spawnStartedAt = Date.now();
      const spawned = shouldWaitForSpawn ? (await session.client.waitForSpawn(spawnTimeoutMs)) !== null : false;

      return {
        sessionId: session.id,
        connected: true,
        spawned,
        spawnWaitedMs: shouldWaitForSpawn ? Date.now() - spawnStartedAt : 0,
        guidance: spawned
          ? 'The session is spawned into the world; movement, world and inventory tools are usable.'
          : 'Login succeeded but no spawn confirmation arrived. The server may still be sending world data, or it may be a protocol-level test server that never spawns players. Read bedrock://session/{id}/state to see the live picture.',
        status: session.client.session.snapshot(),
      };
    }),
  );

  registry.define(
    {
      name: 'disconnect',
      title: 'Disconnect a session',
      description:
        'Cleanly leaves the Bedrock server: sends a disconnect packet, closes the RakNet socket and suppresses automatic reconnection. Use `dispose: true` to also forget the session so the id can point at another server later.',
      inputSchema: disconnectArgs,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handle(context, 'disconnect', async (args: z.infer<z.ZodObject<typeof disconnectArgs>>): Promise<unknown> => {
      const session = resolveSession(context, args.sessionId);
      await session.client.disconnect(args.reason ?? 'Disconnected by MCP client');
      const disposed = args.dispose === true ? await context.manager.dispose(session.id) : false;
      return {
        sessionId: session.id,
        disconnected: true,
        disposed,
        status: disposed ? null : session.client.session.snapshot(),
      };
    }),
  );

  registry.define(
    {
      name: 'get_connection_status',
      title: 'Get connection status',
      description:
        'Reports the live state of one session (or all of them when sessionId is omitted): connection state, host, protocol version, position, health, how many packets have flowed, and whether a reconnect is pending. Cheap to call and useful before deciding what to do next.',
      inputSchema: { sessionId: sessionIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(context, 'get_connection_status', (args: { sessionId?: string }): unknown => {
      const sessions =
        args.sessionId !== undefined
          ? [context.manager.require(args.sessionId)]
          : context.manager.list().map((summary) => context.manager.require(summary.id));
      return {
        sessionCount: sessions.length,
        maxSessions: context.manager.maxSessions,
        defaultSessionId: context.manager.defaultSessionId,
        sessions: sessions.map((session) => ({
          ...session.client.session.snapshot(),
          createdAt: session.createdAt,
        })),
      };
    }),
  );

  registry.define(
    {
      name: 'list_sessions',
      title: 'List sessions',
      description:
        'Lists every session this MCP server knows about, connected or not, with its host, username, state and last known position. Use it when a tool reports an unknown session id.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(context, 'list_sessions', (): unknown => {
      const sessions = context.manager.list();
      return {
        count: sessions.length,
        maxSessions: context.manager.maxSessions,
        defaultSessionId: context.manager.defaultSessionId,
        sessions,
      };
    }),
  );
}
