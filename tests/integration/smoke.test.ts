import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildMovePlayerPacket, buildPlayerActionPacket } from '../../src/bedrock/packets.js';
import { loadConfig } from '../../src/config.js';
import { createNoopLogger } from '../../src/logger.js';
import { SessionManager } from '../../src/session-manager.js';
import { startTestBedrockServer, type TestBedrockServer } from '../helpers/test-server.js';

/**
 * The smoke test required by the project brief: connect, move, chat, disconnect.
 *
 * Runs the whole stack — config → SessionManager → BedrockClient → BedrockActions
 * → raw packets → a real RakNet server that decodes them — which is the only way
 * to prove the action→packet mapping, because the library will happily let you send
 * a malformed packet into the void.
 *
 * `bedrock-protocol`'s own server has no world: it never sends `start_game`, so the
 * session never learns its runtime entity id or position and movement actions
 * correctly refuse to run. This test therefore exercises movement at the packet
 * level and covers the action guards; `external-server.test.ts` runs the full
 * sequence against a real server when configured.
 */

const baseEnv = {
  MCBE_RAKNET_BACKEND: 'jsp-raknet',
  MCBE_SKIP_PING: 'true',
  MCBE_LOG_LEVEL: 'silent',
  MCBE_RECONNECT_ENABLED: 'false',
};

let server: TestBedrockServer;
let manager: SessionManager;

beforeEach(async () => {
  server = await startTestBedrockServer();
  manager = new SessionManager(
    loadConfig({
      ...baseEnv,
      MCBE_HOST: '127.0.0.1',
      MCBE_PORT: String(server.port),
      MCBE_USERNAME: 'SmokeAgent',
    }),
    createNoopLogger(),
  );
});

afterEach(async () => {
  await manager.disposeAll();
  await server.close();
});

describe('smoke: connect, move, chat, disconnect', () => {
  it('completes the full sequence against a Bedrock server', async () => {
    // 1. Connect
    const { session, snapshot } = await manager.connect('smoke', {});
    const clientId = await server.waitForJoin();

    expect(snapshot.connection.state).toBe('initializing');
    expect(snapshot.connection.host).toBe('127.0.0.1');
    expect(snapshot.connection.port).toBe(server.port);
    expect(snapshot.connection.username).toBe('SmokeAgent');
    expect(clientId).toBeTruthy();
    expect(session.client.isConnected).toBe(true);

    // 2. Move
    // Assert against the server's decoded view: this mapping is exactly what breaks
    // when Bedrock changes the protocol.
    const movePacket = buildMovePlayerPacket({
      runtimeId: 1,
      position: { x: 12.5, y: 65, z: -3.25 },
      rotation: { yaw: 90, pitch: -15, headYaw: 90 },
      mode: 'teleport',
      onGround: true,
      tick: 1,
    });
    const movementSeen = server.waitForPacket((packet) => packet.name === 'move_player');
    session.client.send('move_player', movePacket as unknown as Record<string, unknown>);

    const moveReceived = await movementSeen;
    expect(moveReceived).not.toBeNull();
    expect(moveReceived?.name).toBe('move_player');
    expect(moveReceived?.params.mode).toBe('teleport');
    expect(moveReceived?.params.position).toMatchObject({ x: 12.5, y: 65, z: -3.25 });
    expect(moveReceived?.params.yaw).toBeCloseTo(90, 3);
    expect(moveReceived?.params.pitch).toBeCloseTo(-15, 3);
    expect(moveReceived?.params.on_ground).toBe(true);

    // Movement *actions* need a spawned player: without a runtime entity id the
    // guard must refuse rather than send a packet the server would discard.
    await expect(session.actions.moveTo({ x: 1, y: 64, z: 1 })).rejects.toThrow(/position is unknown/i);

    // Breaking has the same requirement.
    await expect(session.actions.breakBlock({ x: 1, y: 64, z: 1 })).rejects.toThrow(/runtime entity id is unknown/i);

    // And the same packets build correctly when the ids are known.
    const breakPacket = buildPlayerActionPacket({
      runtimeEntityId: 1,
      action: 'stop_break',
      position: { x: 1, y: 64, z: 1 },
      face: 'up',
    });
    const breakSeen = server.waitForPacket((packet) => packet.name === 'player_action');
    session.client.send('player_action', breakPacket as unknown as Record<string, unknown>);

    const breakReceived = await breakSeen;
    expect(breakReceived?.params.action).toBe('stop_break');
    expect(breakReceived?.params.position).toMatchObject({ x: 1, y: 64, z: 1 });
    // 'up' is face index 1 in the Bedrock face numbering.
    expect(breakReceived?.params.face).toBe(1);

    // 3. Chat
    const chatSeen = server.waitForPacket((packet) => packet.name === 'text');
    const chatResult = await session.actions.sendChat('smoke test says hello');

    expect(chatResult.ok).toBe(true);
    expect(chatResult.action).toBe('send_chat');
    // The library server does not echo messages back, so acceptance cannot be
    // proven here — the action must say so rather than claim success.
    expect(chatResult.confirmed).toBe(false);
    expect(chatResult.warnings.join(' ')).toMatch(/not acknowledged/i);

    const chatReceived = await chatSeen;
    expect(chatReceived).not.toBeNull();
    expect(chatReceived?.params.type).toBe('chat');
    expect(chatReceived?.params.message).toBe('smoke test says hello');
    expect(chatReceived?.params.source_name).toBe('SmokeAgent');
    expect(chatReceived?.params.needs_translation).toBe(false);

    // 4. Perception
    const state = session.client.session.snapshot();
    expect(state.connection.username).toBe('SmokeAgent');
    expect(state.connection.packetsReceived).toBeGreaterThan(0);
    expect(state.chunksLoaded).toBe(0);
    expect(session.client.session.getInventory('inventory')).toEqual([]);
    expect(session.client.session.getNearbyEntities()).toEqual([]);
    expect(Array.isArray(session.client.session.getChatLog())).toBe(true);

    const summaries = manager.list();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.id).toBe('smoke');

    // 5. Disconnect
    // Verify a farewell `disconnect` reaches the server and the session ends without
    // arming a reconnect. The server's own drop is not asserted: its RakNet layer
    // notices a client-initiated close on its timeout, not immediately.
    const farewellSeen = server.waitForPacket((packet) => packet.name === 'disconnect');
    const summary = await manager.disconnect('smoke', 'smoke test complete');

    expect(summary?.state).toBe('disconnected');
    expect(session.client.isConnected).toBe(false);
    expect(session.client.session.state).toBe('disconnected');
    expect(session.client.session.connection.nextReconnectAt).toBeNull();

    const farewell = await farewellSeen;
    expect(farewell).not.toBeNull();
    expect(farewell?.params.message).toBe('smoke test complete');
  });

  it('walks in steps, one authoritative-input packet per step', async () => {
    const { session } = await manager.connect('walker', {});
    const clientId = await server.waitForJoin();

    // Same guard as the other movement actions: a walk needs a position to walk
    // from, and must refuse rather than send packets from nowhere.
    await expect(session.actions.walkTo({ x: 6, y: 64, z: 0 })).rejects.toThrow(/position is unknown/i);

    // The library's test server has no world, so the position it would learn from
    // `start_game` is supplied directly.
    session.client.session.reportSelfPosition({ x: 0, y: 64, z: 0 }, { yaw: 0, pitch: 0, headYaw: 0 }, true);

    const result = await session.actions.walkTo({ x: 6, y: 64, z: 0 }, { stepLength: 2, stepIntervalMs: 0, tolerance: 0.1 });

    expect(result.action).toBe('walk_to');
    expect(result.detail.steps).toBe(3);
    expect(result.detail.reached).toBe(true);
    // The steps are evenly spaced along the straight line, not front-loaded.
    expect(result.detail.trail.map((step) => step.position.x)).toEqual([2, 4, 6]);
    // The server never reports our position back, so the action must not claim it
    // did — that is the whole point of separating `ok` from `confirmed`.
    expect(result.confirmed).toBe(false);

    // The server's own decoded view: three authoritative-input packets with strictly
    // increasing ticks (a repeated or decreasing tick may be treated as a replay).
    // Wait for the last step: packets arrive in order, so it landing means all did.
    await server.waitForPacket(
      (packet) => packet.name === 'player_auth_input' && (packet.params['position'] as { x?: number } | undefined)?.x === 6,
      5000,
    );
    const authInputs = server.packetsFrom(clientId).filter((packet) => packet.name === 'player_auth_input');
    expect(authInputs).toHaveLength(3);
    expect(authInputs.map((packet) => Number(packet.params['tick']))).toEqual([1, 2, 3]);
    expect(authInputs.map((packet) => (packet.params['position'] as { x: number }).x)).toEqual([2, 4, 6]);
    // Each packet carries the displacement since the previous one, which is the
    // field a server reads as motion.
    expect(authInputs[0]?.params['delta']).toMatchObject({ x: 2, z: 0 });
    expect(authInputs[2]?.params['delta']).toMatchObject({ x: 2, z: 0 });

    // The session ends up where the walk said it would, so later block actions
    // aim at the right coordinates.
    expect(session.client.session.position).toEqual({ x: 6, y: 64, z: 0 });
    // And the tick counter moved on, so a subsequent action does not reuse a tick.
    expect(session.client.session.tick).toBe(3);
  });

  it('keeps two sessions independent', async () => {
    // Each session gets its own server instance on purpose. The library's server
    // cannot host two clients: it stores players in `clients[conn.address]`, and
    // with the pure JS RakNet backend `address` is an object, so every client
    // collapses into the single key "[object Object]" and the second connection
    // is never accepted. Session isolation is our responsibility either way and
    // is what this test checks.
    const secondServer = await startTestBedrockServer();
    try {
      const first = await manager.connect('agent-a', { username: 'AgentA' });
      const second = await manager.connect('agent-b', { port: secondServer.port, username: 'AgentB' });

      expect(manager.size).toBe(2);
      expect(first.session.id).toBe('agent-a');
      expect(second.session.id).toBe('agent-b');
      expect(first.session.client.session.connection.port).toBe(server.port);
      expect(second.session.client.session.connection.port).toBe(secondServer.port);

      await server.waitForJoin();
      await secondServer.waitForJoin();

      const chatA = server.waitForPacket((packet) => packet.name === 'text');
      const chatB = secondServer.waitForPacket((packet) => packet.name === 'text');
      await first.session.actions.sendChat('from A');
      await second.session.actions.sendChat('from B');

      expect((await chatA)?.params.message).toBe('from A');
      expect((await chatB)?.params.message).toBe('from B');

      // Each session keeps its own world state and its own logs: A never sees B's
      // traffic, and neither sees an echo it did not receive.
      expect(first.session.client.session.getChatLog()).toHaveLength(0);
      expect(second.session.client.session.getChatLog()).toHaveLength(0);
      expect(second.session.client.session.connection.port).not.toBe(first.session.client.session.connection.port);

      await manager.dispose('agent-a');
      expect(manager.size).toBe(1);
      expect(manager.list()[0]?.username).toBe('AgentB');
      expect(first.session.client.isConnected).toBe(false);
      expect(second.session.client.isConnected).toBe(true);
    } finally {
      await secondServer.close();
    }
  });

  it('enforces the session cap', async () => {
    const capped = new SessionManager(
      loadConfig({ ...baseEnv, MCBE_MAX_SESSIONS: '1', MCBE_PORT: String(server.port) }),
      createNoopLogger(),
    );
    try {
      capped.ensureSession('one');
      expect(() => capped.ensureSession('two')).toThrow(/session limit reached/i);
    } finally {
      await capped.disposeAll();
    }
  });

  it('reports an unknown session with the list of real ones', async () => {
    await manager.connect('known', {});
    expect(() => manager.require('typo')).toThrow(/Existing sessions: known/);
    expect(() => manager.require()).toThrow(/No session "default"/);
  });
});
