import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { McpContext } from '../context.js';

/**
 * MCP resources: the read side of the bridge. Resources are addressed by URI and can
 * be attached to a context window wholesale, which is cheaper than a tool round trip
 * per fact:
 *
 *   bedrock://sessions                       — every session, one view
 *   bedrock://config                         — non-secret runtime configuration
 *   bedrock://last-chat                      — most recent chat across all sessions
 *   bedrock://session/{sessionId}/state      — the live snapshot
 *   bedrock://session/{sessionId}/inventory  — slots and held item
 *   bedrock://session/{sessionId}/entities   — tracked entities
 *   bedrock://session/{sessionId}/blocks     — blocks the server has reported
 *   bedrock://session/{sessionId}/chat       — chat buffer
 *   bedrock://session/{sessionId}/events     — normalised event buffer
 */

const SESSION_TEMPLATE = 'bedrock://session/{sessionId}/{view}';

interface ResourcePayload {
  [key: string]: unknown;
}

function textResource(
  uri: URL | string,
  payload: ResourcePayload,
): {
  contents: { uri: string; mimeType: string; text: string }[];
} {
  return {
    contents: [
      {
        uri: typeof uri === 'string' ? uri : uri.toString(),
        mimeType: 'application/json',
        // `bigint` is not JSON-serialisable and Bedrock packets are full of them.
        text: JSON.stringify(payload, (_key: string, value: unknown): unknown => (typeof value === 'bigint' ? value.toString() : value), 2),
      },
    ],
  };
}

export function registerSessionResources(server: McpServer, context: McpContext): void {
  server.registerResource(
    'sessions',
    'bedrock://sessions',
    {
      title: 'Bedrock sessions',
      description:
        'Every Bedrock session this MCP server manages, with connection state, host, protocol version, position, health and packet counters. Start here: it answers "am I connected, and as whom?" in one read.',
      mimeType: 'application/json',
    },
    (uri) =>
      textResource(uri, {
        defaultSessionId: context.manager.defaultSessionId,
        maxSessions: context.manager.maxSessions,
        count: context.manager.size,
        sessions: context.manager.list().map((summary) => {
          const session = context.manager.get(summary.id);
          return { ...summary, snapshot: session?.client.session.snapshot() ?? null };
        }),
      }),
  );

  server.registerResource(
    'config',
    'bedrock://config',
    {
      title: 'Server configuration',
      description:
        'The non-secret runtime configuration: default host/port/username, auth mode, RakNet backend, timeouts, reconnect policy, session limits, logging and MCP transport. Useful for an agent to know what defaults it is working with before connecting.',
      mimeType: 'application/json',
    },
    (uri) =>
      textResource(uri, {
        defaults: context.config.defaults,
        reconnect: context.config.reconnect,
        limits: context.config.limits,
        actionTimeoutMs: context.config.actionTimeoutMs,
        chatEchoTimeoutMs: context.config.chatEchoTimeoutMs,
        maxSessions: context.config.maxSessions,
        defaultSessionId: context.config.defaultSessionId,
        rawPacketToolEnabled: context.config.enableRawPacketTool,
        transport: context.config.transport,
        serverVersion: context.version,
      }),
  );

  server.registerResource(
    'last-chat',
    'bedrock://last-chat',
    {
      title: 'Most recent chat across sessions',
      description:
        'The last few chat messages from every session, newest last. Reads well when one agent watches several connected players.',
      mimeType: 'application/json',
    },
    (uri) =>
      textResource(uri, {
        messages: context.manager
          .list()
          .flatMap((summary) => {
            const session = context.manager.get(summary.id);
            if (session === undefined) return [];
            return session.client.session.getChatLog({ limit: 10 }).map((message) => ({ sessionId: summary.id, ...message }));
          })
          .sort((a, b) => a.at - b.at)
          .slice(-25),
      }),
  );

  const template = new ResourceTemplate(SESSION_TEMPLATE, {
    list: () => ({
      resources: context.manager.list().flatMap((summary) =>
        ['state', 'inventory', 'entities', 'blocks', 'chat', 'events'].map((view) => ({
          uri: `bedrock://session/${summary.id}/${view}`,
          name: `${summary.id} ${view}`,
          description: `${view} for session ${summary.id}`,
          mimeType: 'application/json',
        })),
      ),
    }),
    complete: {
      sessionId: () => context.manager.list().map((summary) => summary.id),
      view: () => ['state', 'inventory', 'entities', 'blocks', 'chat', 'events'],
    },
  });

  server.registerResource(
    'session-state',
    template,
    {
      title: 'Per-session world state',
      description:
        'Live view of one session. Use the `view` segment to pick what you need: state (position, health, dimension, counters), inventory (slots, held item), entities (tracked entities by distance), blocks (block updates the server has sent), chat (message buffer), events (normalised event buffer).',
      mimeType: 'application/json',
    },
    (uri, variables) => {
      const sessionId = String(variables['sessionId'] ?? '');
      const view = String(variables['view'] ?? 'state');
      const session = context.manager.get(sessionId);
      if (session === undefined) {
        return textResource(uri, {
          error: `No session "${sessionId}". Existing sessions: ${
            context.manager
              .list()
              .map((summary) => summary.id)
              .join(', ') || '(none)'
          }`,
        });
      }

      const state = session.client.session;
      const origin = state.position;

      switch (view) {
        case 'state':
          return textResource(uri, { sessionId, snapshot: state.snapshot() });
        case 'inventory':
          return textResource(uri, {
            sessionId,
            selectedHotbarSlot: state.selectedHotbarSlot,
            heldItem: state.getHeldItem(),
            itemRegistrySize: state.itemNames.size,
            containers: [...state.inventory.keys()],
            slots: state.getInventory('inventory').map((item) => ({
              ...item,
              isHotbar: item.slot >= 0 && item.slot <= 8,
            })),
          });
        case 'entities':
          return textResource(uri, {
            sessionId,
            origin,
            trackedTotal: state.entities.size,
            entities: state.getNearbyEntities({ radius: 64, limit: 100, includeSelf: true }),
          });
        case 'blocks':
          return textResource(uri, {
            sessionId,
            trackedTotal: state.blocks.size,
            note: 'Only blocks the server has explicitly reported. Absence means "unknown", not "air".',
            blocks: state.getNearbyTrackedBlocks({ radius: 24, limit: 200 }),
          });
        case 'chat':
          return textResource(uri, { sessionId, messages: state.getChatLog({ limit: 100 }) });
        case 'events':
          return textResource(uri, { sessionId, events: state.getEventLog({ limit: 200 }) });
        default:
          return textResource(uri, {
            error: `Unknown view "${view}". Use one of: state, inventory, entities, blocks, chat, events.`,
          });
      }
    },
  );
}
