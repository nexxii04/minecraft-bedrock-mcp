#!/usr/bin/env node
/**
 * Packet inspector.
 *
 * Connects to a Bedrock server as a real player and prints every decoded packet
 * (and, optionally, the normalised event) as one JSON line per packet. The tool of
 * last resort for protocol work: when a tool reports `confirmed: false`, this shows
 * which packet the server actually sent back — or that it sent nothing at all.
 *
 * Usage:
 *   npm run inspect:packets -- --only mob_equipment,update_block
 *   npm run inspect:packets -- --host 127.0.0.1 --port 19132 --duration 30000
 *
 * Options:
 *   --host <name>      server host (default: MCBE_HOST)
 *   --port <number>    server port (default: MCBE_PORT)
 *   --username <name>  player name (default: MCBE_USERNAME)
 *   --online           use Xbox Live auth instead of offline
 *   --version <v>      protocol version override (default: MCBE_VERSION or library default)
 *   --only <a,b,c>     only print these packet names (repeatable, comma separated)
 *   --excluding <a,b>  drop these packet names (noisy ones like `level_chunk`)
 *   --events           also print normalised domain events
 *   --duration <ms>    how long to listen before disconnecting (default: 20000)
 *   --help
 */
import process from 'node:process';

import dotenv from 'dotenv';

import { BedrockClient } from '../src/bedrock/client.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';

interface CliArgs {
  host?: string;
  port?: number;
  username?: string;
  online: boolean;
  version?: string;
  only: string[];
  excluding: string[];
  showEvents: boolean;
  durationMs: number;
  help: boolean;
}

const HELP = `Packet inspector for Minecraft Bedrock servers.

  --host <name>      server host (default: MCBE_HOST)
  --port <number>    server port (default: MCBE_PORT)
  --username <name>  player name (default: MCBE_USERNAME)
  --online           use Xbox Live auth instead of offline mode
  --version <v>      protocol version override (default: MCBE_VERSION)
  --only <a,b,c>     only print these packet names (repeatable/comma separated)
  --excluding <a,b>  drop these packet names (handy: level_chunk,set_entity_data)
  --events           also print normalised domain events
  --duration <ms>    listen for this long, then disconnect (default: 20000)
  --help             show this message
`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { online: false, only: [], excluding: [], showEvents: false, durationMs: 20_000, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${flag ?? ''} needs a value`);
      index += 1;
      return value;
    };
    switch (flag) {
      case '--host':
        args.host = next();
        break;
      case '--port':
        args.port = Number.parseInt(next(), 10);
        break;
      case '--username':
        args.username = next();
        break;
      case '--online':
        args.online = true;
        break;
      case '--version':
        args.version = next();
        break;
      case '--only':
        args.only.push(...next().split(',').filter(Boolean));
        break;
      case '--excluding':
        args.excluding.push(...next().split(',').filter(Boolean));
        break;
      case '--events':
        args.showEvents = true;
        break;
      case '--duration':
        args.durationMs = Number.parseInt(next(), 10);
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`Unknown option "${flag ?? ''}"`);
    }
  }
  return args;
}

/** One JSON line per packet, to stdout: easy to pipe into `jq` or a file. */
function emit(line: unknown): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function main(): Promise<void> {
  dotenv.config({ quiet: true });

  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });

  const client = new BedrockClient({
    sessionId: 'inspect',
    defaults: config.defaults,
    // A one-shot inspection should never silently retry: a reconnect would make
    // the packet stream look continuous when it is not.
    reconnect: { ...config.reconnect, enabled: false },
    limits: config.limits,
    logger,
    logRawPackets: true,
  });

  const only = new Set(args.only);
  const excluded = new Set(args.excluding);
  let printed = 0;

  client.on('packet', (packet) => {
    if (only.size > 0 && !only.has(packet.name)) return;
    if (excluded.has(packet.name)) return;
    printed += 1;
    emit({ kind: 'packet', sessionId: client.sessionId, name: packet.name, params: packet.params });
  });

  if (args.showEvents) {
    client.on('event', (event) => {
      emit({ kind: 'event', sessionId: client.sessionId, type: event.type, event });
    });
  }

  client.on('state', (state) => logger.info({ state }, 'connection state changed'));
  client.on('kicked', (info) => logger.warn(info, 'kicked by server'));
  client.on('disconnected', (info) => logger.warn(info, 'disconnected'));
  client.on('errored', (error) => logger.error({ error: error.message }, 'client error'));

  const overrides: Parameters<BedrockClient['connect']>[0] = {};
  if (args.host !== undefined) overrides.host = args.host;
  if (args.port !== undefined && Number.isInteger(args.port)) overrides.port = args.port;
  if (args.username !== undefined) overrides.username = args.username;
  if (args.online) overrides.offline = false;
  if (args.version !== undefined) overrides.version = args.version;

  logger.info(
    {
      host: overrides.host ?? config.defaults.host,
      port: overrides.port ?? config.defaults.port,
      username: overrides.username ?? config.defaults.username,
      offline: !args.online,
      durationMs: args.durationMs,
      only: [...only],
      excluding: [...excluded],
    },
    'inspecting packets',
  );

  try {
    const snapshot = await client.connect(overrides);
    logger.info({ entityId: snapshot.entityId, position: snapshot.position }, 'join complete; streaming packets');

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, args.durationMs);
      const stop = (): void => {
        clearTimeout(timer);
        resolve();
      };
      process.once('SIGINT', stop);
      client.once('disconnected', stop);
    });
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.message : String(error) }, 'inspection failed');
    process.exitCode = 1;
  } finally {
    await client.dispose();
    process.stderr.write(`\n${printed} packet(s) printed\n`);
  }
}

void main();
