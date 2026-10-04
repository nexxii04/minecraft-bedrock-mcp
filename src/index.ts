import process from 'node:process';

import dotenv from 'dotenv';

import { loadConfig, type AppConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { buildMcpServer, MCP_SERVER_NAME } from './mcp/server.js';
import { SessionManager } from './session-manager.js';
import { silenceStdout, startTransport, type RunningTransport } from './transport.js';

/**
 * Entry point.
 *
 * Order matters here: stdout is redirected *before* anything else can write to
 * it, because over the stdio transport stdout is the JSON-RPC channel and one
 * stray `console.log` from a dependency would corrupt the protocol.
 */

export const VERSION = '0.1.0';

export interface BootstrapResult {
  config: AppConfig;
  logger: Logger;
  manager: SessionManager;
  transport: RunningTransport;
  shutdown: (signal?: string) => Promise<void>;
}

export async function bootstrap(env: Record<string, string | undefined> = process.env): Promise<BootstrapResult> {
  dotenv.config({ quiet: true });

  const config = loadConfig(env);
  const logger = createLogger({ level: config.logLevel });

  if (config.transport.kind === 'stdio') silenceStdout();

  logger.info(
    {
      server: MCP_SERVER_NAME,
      version: VERSION,
      transport: config.transport.kind,
      logLevel: config.logLevel,
      defaultTarget: `${config.defaults.host}:${config.defaults.port}`,
      username: config.defaults.username,
      offline: config.defaults.offline,
      raknetBackend: config.defaults.raknetBackend,
      maxSessions: config.maxSessions,
      rawPacketTool: config.enableRawPacketTool,
    },
    'starting minecraft-bedrock-mcp',
  );

  const manager = new SessionManager(config, logger);
  const { server, registry } = buildMcpServer({ manager, config, logger, version: VERSION });

  const transport = await startTransport({ server, transport: config.transport, logger });

  let shuttingDown = false;
  const shutdown = async (signal?: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    try {
      await manager.disposeAll();
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'error while closing sessions');
    }
    try {
      await transport.close();
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'error while closing MCP transport');
    }
    logger.info({ tools: registry.names().length }, 'shutdown complete');
  };

  return { config, logger, manager, transport, shutdown };
}

async function main(): Promise<void> {
  let bootstrapped: BootstrapResult;
  try {
    bootstrapped = await bootstrap();
  } catch (error) {
    // The logger is not available yet: configuration or bootstrap itself failed.
    process.stderr.write(`${MCP_SERVER_NAME} failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const { logger, shutdown } = bootstrapped;

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal).then(() => process.exit(0));
    });
  }

  process.on('uncaughtException', (error) => {
    logger.error({ error: error.message, stack: error.stack }, 'uncaught exception');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: reason instanceof Error ? reason.message : String(reason) }, 'unhandled rejection');
  });
}

// Only run when executed directly, so tests can import `bootstrap` freely.
const invokedDirectly =
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('minecraft-bedrock-mcp/dist/index.js'));

if (invokedDirectly) {
  void main();
}
