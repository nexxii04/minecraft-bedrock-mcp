import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { ServerTransportConfig } from './config.js';
import type { Logger } from './logger.js';

/**
 * Transport layer for the MCP server itself.
 *
 * Two ways in: **stdio** (how Claude Code, Claude Desktop and most CLI agents
 * launch a local server — one process, one client) and **Streamable HTTP** (for
 * remote/shared use, where several agents talk to one long-lived process holding
 * the Bedrock sessions).
 *
 * With stdio, stdout *is* the JSON-RPC channel, so `silenceStdout()` is installed
 * before the transport starts.
 */

export interface RunningTransport {
  kind: 'stdio' | 'http';
  /** Present for the HTTP transport. */
  httpServer?: Server;
  url?: string;
  close(): Promise<void>;
}

export interface StartTransportOptions {
  server: McpServer;
  transport: ServerTransportConfig;
  logger: Logger;
}

export async function startTransport(options: StartTransportOptions): Promise<RunningTransport> {
  if (options.transport.kind === 'stdio') return await startStdioTransport(options);
  return await startHttpTransport(options);
}

async function startStdioTransport(options: StartTransportOptions): Promise<RunningTransport> {
  const transport = new StdioServerTransport();
  await options.server.connect(transport);
  options.logger.info('MCP server listening on stdio');
  return {
    kind: 'stdio',
    close: async () => {
      await options.server.close();
    },
  };
}

/**
 * Streamable HTTP endpoint. Stateful mode (default) keeps one transport per MCP
 * session, keyed by the `mcp-session-id` header the SDK issues on initialize;
 * stateless mode suits simple clients that carry no session header.
 */
async function startHttpTransport(options: StartTransportOptions): Promise<RunningTransport> {
  const { host, port, path, stateful } = options.transport.http;
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer((request, response) => {
    void handleHttpRequest(request, response, {
      mcpServer: options.server,
      logger: options.logger,
      path,
      stateful,
      transports,
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const url = `http://${host}:${port}${path}`;
  options.logger.info({ url, stateful }, 'MCP server listening over Streamable HTTP');

  return {
    kind: 'http',
    httpServer,
    url,
    close: async () => {
      for (const transport of transports.values()) {
        try {
          await transport.close();
        } catch {
          // Already closed.
        }
      }
      transports.clear();
      await options.server.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

interface HttpRequestContext {
  mcpServer: McpServer;
  logger: Logger;
  path: string;
  stateful: boolean;
  transports: Map<string, StreamableHTTPServerTransport>;
}

async function handleHttpRequest(request: IncomingMessage, response: ServerResponse, context: HttpRequestContext): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (url.pathname === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, transports: context.transports.size }));
    return;
  }

  if (url.pathname !== context.path) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: `Not found. The MCP endpoint is ${context.path}` }));
    return;
  }

  try {
    const sessionId = request.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? context.transports.get(sessionId) : undefined;

    if (existing !== undefined) {
      await existing.handleRequest(request, response, await readJsonBody(request));
      return;
    }

    if (!context.stateful) {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await context.mcpServer.connect(transport);
      await transport.handleRequest(request, response, await readJsonBody(request));
      await transport.close();
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        context.transports.set(id, transport);
        context.logger.info({ mcpSessionId: id, active: context.transports.size }, 'MCP HTTP session started');
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id !== undefined) context.transports.delete(id);
      context.logger.info({ mcpSessionId: id, active: context.transports.size }, 'MCP HTTP session closed');
    };

    await context.mcpServer.connect(transport);
    await transport.handleRequest(request, response, await readJsonBody(request));
  } catch (error) {
    context.logger.error({ error: error instanceof Error ? error.message : String(error) }, 'HTTP request failed');
    if (!response.headersSent) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Internal MCP transport error' }));
    }
  }
}

/**
 * Reads and parses a JSON body. Returns `undefined` for GET/DELETE, which have no
 * body and are forwarded untouched.
 */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (request.method !== 'POST' && request.method !== 'PUT' && request.method !== 'PATCH') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Hand the raw string back so the transport can produce its own JSON-RPC
    // parse error rather than us inventing one.
    return raw;
  }
}

/**
 * Redirects `console` to stderr. `bedrock-protocol` and its dependencies call
 * `console.log`/`debug` internally, and over stdio any of that would inject
 * non-JSON-RPC bytes and break the client, so it is rerouted to stderr.
 */
export function silenceStdout(): void {
  const toStderr =
    (writer: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      writer(...args);
    };

  const stderrWrite = process.stderr.write.bind(process.stderr);
  const writeToStderr = (...args: unknown[]): void => {
    void args;
    stderrWrite(args.map((arg) => (typeof arg === 'string' ? arg : safeInspect(arg))).join(' ') + '\n');
  };

  /* eslint-disable no-console -- reassigning the console methods is the point of
     this function, and the replacement writes to stderr, never to stdout. */
  console.log = toStderr(writeToStderr);
  console.info = toStderr(writeToStderr);
  console.warn = toStderr(writeToStderr);
  console.debug = toStderr(writeToStderr);
  console.error = toStderr(writeToStderr);
  /* eslint-enable no-console */
}

function safeInspect(value: unknown): string {
  try {
    return (
      JSON.stringify(value, (_key: string, entry: unknown): unknown => (typeof entry === 'bigint' ? `${entry}n` : entry)) ?? String(value)
    );
  } catch {
    return String(value);
  }
}
