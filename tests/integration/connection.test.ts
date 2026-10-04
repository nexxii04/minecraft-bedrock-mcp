import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BedrockClient } from '../../src/bedrock/client.js';
import { loadConfig } from '../../src/config.js';
import { createNoopLogger } from '../../src/logger.js';
import { startTestBedrockServer, type TestBedrockServer } from '../helpers/test-server.js';

/**
 * Integration tests for the connection layer, against a real Bedrock server
 * process (in-process, but a genuine RakNet transport and protocol exchange). They
 * prove the wrapper drives `bedrock-protocol` correctly: discovery, login, the
 * `join` event, packet ingestion, and a clean teardown that does not reconnect.
 */

/**
 * Starts a server on a specific port, retrying while the previous socket is
 * still being released by the OS.
 */
async function startSecondServerOnPort(port: number): Promise<TestBedrockServer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await startTestBedrockServer({ port });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not rebind the test server port');
}

const config = loadConfig({
  MCBE_RAKNET_BACKEND: 'jsp-raknet',
  MCBE_SKIP_PING: 'true',
  MCBE_LOG_LEVEL: 'silent',
  MCBE_RECONNECT_ENABLED: 'false',
});

let server: TestBedrockServer;
let client: BedrockClient | undefined;

function makeClient(overrides: { port: number; username?: string; reconnect?: boolean }): BedrockClient {
  return new BedrockClient({
    sessionId: 'test',
    defaults: { ...config.defaults, port: overrides.port, username: overrides.username ?? 'TestAgent' },
    reconnect: {
      ...config.reconnect,
      enabled: overrides.reconnect ?? false,
      // Keep the reconnect path fast, and independent of the jittered default.
      baseDelayMs: 150,
      maxDelayMs: 300,
    },
    limits: config.limits,
    logger: createNoopLogger(),
    logRawPackets: false,
  });
}

beforeEach(async () => {
  server = await startTestBedrockServer();
});

afterEach(async () => {
  if (client !== undefined) await client.dispose();
  client = undefined;
  await server.close();
});

describe('BedrockClient connection lifecycle', () => {
  it('joins the server and marks the session as connected', async () => {
    client = makeClient({ port: server.port });
    const snapshot = await client.connect();

    expect(snapshot.connection.state).toBe('initializing');
    expect(snapshot.connection.host).toBe('127.0.0.1');
    expect(snapshot.connection.port).toBe(server.port);
    expect(snapshot.connection.username).toBe('TestAgent');
    // The library resolves the protocol version during login; we surface it.
    expect(snapshot.connection.version).toBeTruthy();
    expect(snapshot.connection.connectedAt).not.toBeNull();

    const joinedClientId = await server.waitForJoin();
    expect(joinedClientId).toBeTruthy();
  });

  it('records packets it receives on the session', async () => {
    client = makeClient({ port: server.port });
    await client.connect();
    await server.waitForJoin();

    expect(client.session.connection.packetsReceived).toBeGreaterThan(0);
    // `play_status` is part of every successful Bedrock login.
    const statusEvent = client.session.getEventLog({ types: ['connection_state'] });
    expect(statusEvent.length).toBeGreaterThan(0);
    expect(client.session.connection.lastPacketAt).not.toBeNull();
  });

  it('sends chat as a text packet the server can decode', async () => {
    client = makeClient({ port: server.port });
    await client.connect();
    await server.waitForJoin();

    const received = server.waitForPacket((packet) => packet.name === 'text');
    client.send('text', {
      type: 'chat',
      needs_translation: false,
      category: 'message_only',
      source_name: 'TestAgent',
      message: 'hello from the integration test',
      xuid: '',
      platform_chat_id: '',
      has_filtered_message: false,
      filtered_message: '',
    });

    const packet = await received;
    expect(packet).not.toBeNull();
    expect(packet?.name).toBe('text');
    expect(packet?.params.type).toBe('chat');
    expect(packet?.params.message).toBe('hello from the integration test');
    expect(packet?.params.source_name).toBe('TestAgent');
  });

  it('ingests chat that the server sends us', async () => {
    client = makeClient({ port: server.port });
    await client.connect();
    await server.waitForJoin();

    const chatEvent = client.waitForDomainEvent((event) => event.type === 'chat', 5000);
    server.broadcast('text', {
      type: 'chat',
      needs_translation: false,
      category: 'message_only',
      source_name: 'ServerAdmin',
      message: 'welcome to the test server',
      xuid: '',
      platform_chat_id: '',
      has_filtered_message: false,
      filtered_message: '',
    });

    const event = await chatEvent;
    expect(event).not.toBeNull();
    expect(event?.type).toBe('chat');
    if (event?.type === 'chat') {
      expect(event.chat.source).toBe('ServerAdmin');
      expect(event.chat.message).toBe('welcome to the test server');
      expect(event.chat.kind).toBe('chat');
    }

    const log = client.session.getChatLog();
    expect(log).toHaveLength(1);
    expect(log[0]?.message).toBe('welcome to the test server');
  });

  it('refuses a second connect on the same session', async () => {
    client = makeClient({ port: server.port });
    await client.connect();
    await expect(client.connect()).rejects.toThrow(/already connected/);
  });

  it('reports a clear error when nothing is listening', async () => {
    const busyPort = await startTestBedrockServer();
    const closedPort = busyPort.port;
    await busyPort.close();

    const failing = makeClient({ port: closedPort });
    try {
      await expect(failing.connect()).rejects.toThrow();
      expect(failing.session.state).toBe('errored');
    } finally {
      await failing.dispose();
    }
  });

  it('disconnects cleanly and without auto-reconnecting', async () => {
    const sut = makeClient({ port: server.port, reconnect: true });
    client = sut;
    await sut.connect();
    await server.waitForJoin();

    const disconnected = new Promise<{ intentional: boolean; willReconnect: boolean }>((resolve) => {
      sut.once('disconnected', resolve);
    });

    await sut.disconnect('test finished');
    const info = await disconnected;

    expect(info.intentional).toBe(true);
    expect(info.willReconnect).toBe(false);
    expect(sut.session.state).toBe('disconnected');
    expect(sut.isConnected).toBe(false);

    // Give a reconnect loop a chance to (incorrectly) fire.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sut.session.state).toBe('disconnected');
  });

  it('reports the kick it received with the server-supplied reason', async () => {
    const sut = makeClient({ port: server.port });
    client = sut;
    await sut.connect();
    await server.waitForJoin();

    const kicked = new Promise<{ message: string; hidden: boolean }>((resolve) => {
      sut.once('kicked', resolve);
    });

    server.broadcast('disconnect', {
      reason: 'disconnected',
      hide_disconnect_reason: false,
      message: 'kicked for testing',
      filtered_message: '',
    });

    const info = await kicked;
    expect(info.message).toBe('kicked for testing');
    expect(info.hidden).toBe(false);
  });

  it('schedules a reconnect after an unexpected drop', async () => {
    const reconnectClient = makeClient({ port: server.port, reconnect: true });
    try {
      await reconnectClient.connect();
      await server.waitForJoin();

      const reconnecting = new Promise<{ attempt: number; delayMs: number }>((resolve) => {
        reconnectClient.once('reconnecting', resolve);
      });

      // A kick with reconnect-on-kick enabled is the deterministic way to drop
      // the transport without the wrapper treating the close as intentional.
      server.broadcast('disconnect', {
        reason: 'disconnected',
        hide_disconnect_reason: false,
        message: 'server restarting',
        filtered_message: '',
      });

      const info = await reconnecting;
      expect(info.attempt).toBe(1);
      expect(info.delayMs).toBeGreaterThan(0);
      expect(reconnectClient.session.state).toBe('reconnecting');
      expect(reconnectClient.session.connection.nextReconnectAt).not.toBeNull();
    } finally {
      await reconnectClient.dispose();
    }
  });

  it('completes the reconnect against a restarted server', async () => {
    const firstServer = server;
    const port = firstServer.port;
    const reconnectClient = makeClient({ port, reconnect: true });
    let secondServer: TestBedrockServer | undefined;

    try {
      await reconnectClient.connect();
      await firstServer.waitForJoin();

      const reconnecting = new Promise<number>((resolve) => {
        reconnectClient.once('reconnecting', (info) => resolve(info.attempt));
      });

      // Simulate a server restart: stop the first instance, stand a fresh one up
      // on the same port before the backoff expires.
      //
      // The restart is deliberate rather than a plain kick: the library's own
      // *server* implementation mishandles a reconnecting client while the old
      // session is still being torn down (its stale session decipher throws a
      // checksum error). A fresh server has no stale state, and a real Bedrock
      // Dedicated Server does not have that problem at all.
      await firstServer.close();
      secondServer = await startSecondServerOnPort(port);

      expect(await reconnecting).toBe(1);

      await expect.poll(() => reconnectClient.session.state, { timeout: 25_000, interval: 250 }).toMatch(/initializing|initialized/);

      // A successful reconnect resets the attempt counter, so the policy starts
      // fresh for the next drop instead of counting up forever.
      expect(reconnectClient.session.connection.reconnectAttempts).toBe(0);
      expect(reconnectClient.session.connection.nextReconnectAt).toBeNull();

      const joinedClientId = await secondServer.waitForJoin();
      expect(joinedClientId).toBeTruthy();
    } finally {
      await reconnectClient.dispose();
      if (secondServer !== undefined) await secondServer.close();
    }
  });
});
