import { createSocket } from 'node:dgram';

import bedrock from 'bedrock-protocol';

/**
 * An in-process Bedrock Edition server, used by the integration tests.
 *
 * BDS is a ~300 MB proprietary download that cannot run in CI, while
 * `bedrock-protocol` can act as a server: it implements RakNet, the
 * login/handshake exchange and packet decoding, enough to prove our client
 * produces packets the protocol accepts. It has no world, so it never sends
 * `start_game` or triggers `spawn`; anything needing a real world is covered by
 * `tests/integration/external-server.test.ts`.
 */

export interface TestServerPacket {
  /** Client address hash, so a test can tell players apart. */
  client: string;
  name: string;
  params: Record<string, unknown>;
}

export interface TestBedrockServer {
  host: string;
  port: number;
  /** Every packet the server decoded from any client, in arrival order. */
  packets: TestServerPacket[];
  /** Packets received from a specific client id. */
  packetsFrom(clientId: string): TestServerPacket[];
  /** Resolves once a client has completed the login handshake. */
  waitForJoin(timeoutMs?: number): Promise<string>;
  /** Resolves when a packet matching the predicate arrives. */
  waitForPacket(predicate: (packet: TestServerPacket) => boolean, timeoutMs?: number): Promise<TestServerPacket | null>;
  clientIds(): string[];
  /** Sends a packet to every connected player. */
  broadcast(packetName: string, params: Record<string, unknown>): void;
  close(): Promise<void>;
}

/**
 * The subset of the library's server/player API this helper uses. Its published
 * types overload only a few event names and hide `connection` on a player, so the
 * helper narrows them once here instead of scattering casts through the tests.
 */
interface RawPlayer {
  connection?: { address?: string };
  on(event: string, callback: (payload: unknown) => void): unknown;
  write(packetName: string, params: Record<string, unknown>): void;
}

interface RawServer {
  transport?: unknown;
  on(event: 'connect', callback: (player: RawPlayer) => void): unknown;
  on(event: 'error', callback: (error: Error) => void): unknown;
}

/** Asks the OS for a free UDP port, then releases it for the server to claim. */
export async function findFreeUdpPort(): Promise<number> {
  const socket = createSocket('udp4');
  return await new Promise<number>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      const address = socket.address();
      const port = address.port;
      socket.close(() => resolve(port));
    });
  });
}

export interface StartTestServerOptions {
  /** Bedrock protocol version to speak. Defaults to the library's current one. */
  version?: string;
  /** RakNet implementation. Defaults to the pure JS one so no compiler is needed. */
  raknetBackend?: 'jsp-raknet' | 'raknet-native' | 'raknet-node';
  port?: number;
}

export async function startTestBedrockServer(options: StartTestServerOptions = {}): Promise<TestBedrockServer> {
  const port = options.port ?? (await findFreeUdpPort());
  const host = '127.0.0.1';
  const packets: TestServerPacket[] = [];
  const joined = new Set<string>();
  const playerSockets = new Map<string, RawPlayer>();

  const server = bedrock.createServer({
    host,
    port,
    offline: true,
    raknetBackend: options.raknetBackend ?? 'jsp-raknet',
    ...(options.version !== undefined ? { version: options.version } : {}),
    // The library's default `conLog` is `console.log`; keep test output clean.
    conLog: () => {},
    maxPlayers: 8,
  } as bedrock.ServerOptions & { conLog: () => void });

  const rawServer = server as unknown as RawServer;
  // A failed bind reports through the server's `error` event while
  // `createServer` swallows it, so startup failures are captured here and
  // surfaced by `waitForServerListening` instead of failing silently.
  let startupError: Error | null = null;

  const joinWaiters: { resolve: (id: string) => void; timer: NodeJS.Timeout }[] = [];
  const packetWaiters: {
    predicate: (packet: TestServerPacket) => boolean;
    resolve: (packet: TestServerPacket | null) => void;
    timer: NodeJS.Timeout;
  }[] = [];

  let clientSequence = 0;
  rawServer.on('connect', (player) => {
    // Deliberately not `player.connection.address`: with the pure JS RakNet
    // backend the library's server stores players under that *object*, which
    // stringifies to "[object Object]" for every client, so the address cannot
    // distinguish two players even if this helper wanted it to.
    clientSequence += 1;
    const clientId = `client-${clientSequence}`;
    playerSockets.set(clientId, player);

    // A half-torn-down session (a client disconnecting mid-batch) can desync the
    // server-side cipher; without this listener the resulting 'error' would take
    // down the whole test process.
    player.on('error', () => {});

    player.on('join', () => {
      joined.add(clientId);
      for (const waiter of [...joinWaiters]) {
        clearTimeout(waiter.timer);
        joinWaiters.splice(joinWaiters.indexOf(waiter), 1);
        waiter.resolve(clientId);
      }
    });

    player.on('packet', (payload) => {
      const deserialized = payload as { data: { name: string; params: Record<string, unknown> } };
      const packet: TestServerPacket = {
        client: clientId,
        name: deserialized.data.name,
        params: deserialized.data.params,
      };
      packets.push(packet);
      for (const waiter of [...packetWaiters]) {
        let matches = false;
        try {
          matches = waiter.predicate(packet);
        } catch {
          matches = false;
        }
        if (!matches) continue;
        clearTimeout(waiter.timer);
        packetWaiters.splice(packetWaiters.indexOf(waiter), 1);
        waiter.resolve(packet);
      }
    });

    player.on('close', () => {
      playerSockets.delete(clientId);
      joined.delete(clientId);
    });

    player.on('spawn', () => {
      // Not reached with this library's server (no world), but harmless to track.
    });
  });

  let listening = false;
  rawServer.on('error', (error) => {
    if (!listening) startupError = error;
    // RakNet also reports transport hiccups after startup; tests assert on
    // packets, not on those.
  });

  // `createServer` binds the socket itself. Calling `listen()` here too would
  // fail with EADDRINUSE, so we only wait for the transport to come up.
  await waitForServerListening(server, () => startupError);
  listening = true;

  return {
    host,
    port,
    packets,
    packetsFrom(clientId) {
      return packets.filter((packet) => packet.client === clientId);
    },
    waitForJoin(timeoutMs = 10_000) {
      return new Promise<string>((resolve, reject) => {
        const already = [...joined][0];
        if (already !== undefined) {
          resolve(already);
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error(`No client joined within ${timeoutMs}ms`));
        }, timeoutMs);
        joinWaiters.push({
          resolve: (id) => {
            clearTimeout(timer);
            resolve(id);
          },
          timer,
        });
      });
    },
    waitForPacket(predicate, timeoutMs = 10_000) {
      const existing = packets.find((packet) => {
        try {
          return predicate(packet);
        } catch {
          return false;
        }
      });
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise<TestServerPacket | null>((resolve) => {
        const timer = setTimeout(() => {
          packetWaiters.splice(
            packetWaiters.findIndex((waiter) => waiter.timer === timer),
            1,
          );
          resolve(null);
        }, timeoutMs);
        packetWaiters.push({ predicate, resolve, timer });
      });
    },
    clientIds() {
      return [...playerSockets.keys()];
    },
    broadcast(packetName, params) {
      for (const player of playerSockets.values()) {
        player.write(packetName, params);
      }
    },
    async close() {
      for (const waiter of joinWaiters) clearTimeout(waiter.timer);
      for (const waiter of packetWaiters) clearTimeout(waiter.timer);
      joinWaiters.length = 0;
      packetWaiters.length = 0;
      await server.close('Test finished');
    },
  };
}

/**
 * Waits until the server's transport is actually bound.
 *
 * `createServer` starts listening internally without returning a promise, so the
 * only reliable signal is the transport appearing on the instance.
 */
async function waitForServerListening(server: bedrock.Server, readStartupError: () => Error | null, timeoutMs = 5000): Promise<void> {
  const internals = server as unknown as RawServer;
  const deadline = Date.now() + timeoutMs;
  while (internals.transport === undefined) {
    const startupError = readStartupError();
    if (startupError !== null) throw startupError;
    if (Date.now() > deadline) throw new Error(`Test Bedrock server did not start listening within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // The transport object exists before the socket is bound, so give the bind a
  // moment and re-check for an error.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const startupError = readStartupError();
  if (startupError !== null) throw startupError;
}
