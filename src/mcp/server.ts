import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { SessionManager } from '../session-manager.js';
import type { McpContext } from './context.js';
import { ToolRegistry } from './registry.js';
import { registerSessionResources } from './resources/session-state.js';
import { registerChatTools } from './tools/chat.js';
import { registerCommandTools } from './tools/commands.js';
import { registerConnectionTools } from './tools/connection.js';
import { registerEntityTools } from './tools/entities.js';
import { registerInventoryTools } from './tools/inventory.js';
import { registerMovementTools } from './tools/movement.js';
import { registerQaTools } from './tools/qa.js';
import { registerRawTools } from './tools/raw.js';
import { registerWorldTools } from './tools/world.js';

export interface BuildServerOptions {
  manager: SessionManager;
  config: AppConfig;
  logger: Logger;
  version: string;
}

export interface BuiltMcpServer {
  server: McpServer;
  registry: ToolRegistry;
  context: McpContext;
}

export const MCP_SERVER_NAME = 'minecraft-bedrock-mcp';

/**
 * Builds the MCP server: tools and resources wired to one session manager. Adding a
 * capability means adding a `register*Tools(registry, context)` module and listing
 * it below — no change to the connection layer. The registry sits in front of
 * `McpServer` so `run_action_sequence` shares one implementation with the
 * interactive path.
 */
export function buildMcpServer(options: BuildServerOptions): BuiltMcpServer {
  const context: McpContext = {
    manager: options.manager,
    config: options.config,
    logger: options.logger,
    version: options.version,
  };

  const server = new McpServer(
    {
      name: MCP_SERVER_NAME,
      version: options.version,
    },
    {
      instructions: [
        'This server lets you play Minecraft Bedrock Edition (MCBE, not Java) as a real client over RakNet.',
        '',
        'Typical flow:',
        '1. connect_to_server — logs in as a player. Read `spawned` in the response to know whether the world is interactive yet.',
        '2. Read bedrock://session/{id}/state or bedrock://sessions for context before acting.',
        '3. Act: move_to, break_block, place_block, attack_entity, get_inventory, send_chat, run_command, ...',
        '4. Verify: every action reports `ok` (packet sent) and `confirmed` (server acknowledged). `confirmed: false` is meaningful data, not a transport failure.',
        '',
        'For automated QA, run_action_sequence executes a list of tool calls and then evaluates declarative assertions on the resulting state; wait_for_event synchronises on server-side effects instead of sleeping.',
        '',
        'Sessions are independent connections: pass sessionId to work with several agent-players at once.',
      ].join('\n'),
    },
  );

  const registry = new ToolRegistry();
  registerConnectionTools(registry, context);
  registerMovementTools(registry, context);
  registerWorldTools(registry, context);
  registerInventoryTools(registry, context);
  registerEntityTools(registry, context);
  registerChatTools(registry, context);
  registerCommandTools(registry, context);
  registerQaTools(registry, context);
  registerRawTools(registry, context);

  registry.bind(server);
  registerSessionResources(server, context);

  options.logger.info({ tools: registry.names().length, toolNames: registry.names() }, 'registered MCP tools');

  return { server, registry, context };
}
