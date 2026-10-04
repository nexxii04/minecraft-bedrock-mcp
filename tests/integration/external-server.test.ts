import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { createNoopLogger } from '../../src/logger.js';
import { SessionManager } from '../../src/session-manager.js';

/**
 * Full end-to-end test against a **real** Bedrock server.
 *
 * The in-process tests cover the transport, login and packet formats; what they
 * cannot cover is anything needing a world (`start_game`/position, block updates,
 * inventory, entity spawns, whether the server accepts our actions). Skipped unless
 * configured:
 *
 * ```bash
 * MCBE_TEST_HOST=127.0.0.1 MCBE_TEST_PORT=19132 npm run test:integration
 * ```
 *
 * The recommended target is a Bedrock Dedicated Server with `online-mode=false` and
 * `server-authoritative-movement=server-auth`. Destructive steps only run with
 * `MCBE_TEST_DESTRUCTIVE=true`.
 */

const host = process.env['MCBE_TEST_HOST'];
const port = Number(process.env['MCBE_TEST_PORT'] ?? '19132');
const username = process.env['MCBE_TEST_USERNAME'] ?? 'QAAgent';
const destructive = process.env['MCBE_TEST_DESTRUCTIVE'] === 'true';
const configured = host !== undefined && host !== '';

describe.skipIf(!configured)('external Bedrock server', () => {
  let manager: SessionManager;

  beforeAll(() => {
    manager = new SessionManager(
      loadConfig({
        MCBE_HOST: host,
        MCBE_PORT: String(port),
        MCBE_USERNAME: username,
        MCBE_OFFLINE: 'true',
        MCBE_LOG_LEVEL: 'silent',
        // A real server may restart between steps; keep the reconnect policy but
        // do not let it race the test's own connection handling.
        MCBE_RECONNECT_MAX_ATTEMPTS: '1',
      }),
      createNoopLogger(),
    );
  });

  afterAll(async () => {
    await manager.disposeAll();
  });

  it('logs in, spawns into the world and reports real state', async () => {
    const { session, snapshot } = await manager.connect('qa', {});

    expect(snapshot.connection.state).toBe('initializing');
    expect(snapshot.connection.version).toMatch(/^\d+\.\d+/);

    const spawned = await session.client.waitForSpawn(30_000);
    expect(spawned, 'server never sent a spawn confirmation').not.toBeNull();

    const state = session.client.session.snapshot();
    expect(state.position).not.toBeNull();
    expect(state.runtimeEntityId).not.toBeNull();
    expect(state.entityId).not.toBeNull();
    expect(state.dimension).toBe('overworld');
    expect(state.serverVersion).not.toBeNull();
    // A real server streams chunks once we are in the world.
    await expect.poll(() => session.client.session.chunksLoaded, { timeout: 20_000, interval: 250 }).toBeGreaterThan(0);
  }, 60_000);

  it('moves the player to a position and gets the server to agree', async () => {
    const session = manager.require('qa');
    const before = session.client.session.position;
    expect(before).not.toBeNull();
    if (before === null) return;

    const target = { x: before.x + 2, y: before.y, z: before.z + 2 };
    const result = await session.actions.moveTo(target, { mode: 'teleport', timeoutMs: 10_000 });

    expect(result.ok).toBe(true);
    // A vanilla BDS validates movement; if the server refused the teleport, the
    // action reports it rather than pretending it worked.
    if (!result.confirmed) {
      expect(result.warnings.join(' ')).toMatch(/did not confirm/i);
    }
    expect(session.client.session.position).not.toBeNull();
  }, 45_000);

  it('sends chat and reads the chat log', async () => {
    const session = manager.require('qa');
    const message = `minecraft-bedrock-mcp qa ${Date.now()}`;
    const result = await session.actions.sendChat(message, { echoTimeoutMs: 3000 });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('send_chat');

    // Whether the server echoes to the author varies; either way the send is
    // reported honestly, and the log must still be readable.
    expect(Array.isArray(session.client.session.getChatLog({ limit: 10 }))).toBe(true);
  }, 30_000);

  it('reads an inventory and resolves item names', async () => {
    const session = manager.require('qa');
    await expect.poll(() => session.client.session.inventory.size, { timeout: 20_000, interval: 250 }).toBeGreaterThan(0);

    const slots = session.client.session.getInventory('inventory');
    expect(Array.isArray(slots)).toBe(true);
    // Creative mode gives a populated hotbar; survival may be empty right after
    // joining, so only assert the shape and that ids resolve when present.
    for (const item of slots) {
      expect(item.slot).toBeGreaterThanOrEqual(0);
      expect(item.networkId).toBeGreaterThan(0);
      expect(item.count).toBeGreaterThan(0);
    }
    expect(session.client.session.itemNames.size).toBeGreaterThan(0);
  }, 45_000);

  it('sees entities and reports its own player', async () => {
    const session = manager.require('qa');
    await expect.poll(() => session.client.session.entities.size, { timeout: 20_000, interval: 250 }).toBeGreaterThan(0);

    const withSelf = session.client.session.getNearbyEntities({ radius: 128, includeSelf: true });
    const self = withSelf.find((entity) => entity.runtimeId === session.client.session.runtimeEntityId);
    expect(self, 'our own player entity should be tracked after spawn').toBeDefined();
    expect(self?.isPlayer).toBe(true);
  }, 45_000);

  it.runIf(destructive)(
    'breaks and replaces a block at the player position',
    async () => {
      const session = manager.require('qa');
      const position = session.client.session.position;
      expect(position).not.toBeNull();
      if (position === null) return;

      // One block above the player's feet: reachable, and the usual target of a
      // "can this bot dig?" test.
      const target = {
        x: Math.floor(position.x),
        y: Math.floor(position.y) + 1,
        z: Math.floor(position.z),
      };

      const broken = await session.actions.breakBlock(target, { mode: 'creative', timeoutMs: 10_000 });
      expect(broken.ok).toBe(true);
      expect(broken.detail.position).toEqual(target);
      if (!broken.confirmed) {
        // Creative destroy on a protected or unbreakable block is a legitimate
        // "server said no"; the failure must be visible, not silent.
        expect(broken.warnings.length).toBeGreaterThan(0);
      }

      const placed = await session.actions.placeBlock(target, { timeoutMs: 10_000 });
      expect(placed.ok).toBe(true);
      if (!placed.confirmed) expect(placed.warnings.length).toBeGreaterThan(0);
    },
    60_000,
  );

  it('disconnects cleanly', async () => {
    const summary = await manager.disconnect('qa', 'QA run complete');
    expect(summary?.state).toBe('disconnected');
    const session = manager.get('qa');
    expect(session?.client.isConnected).toBe(false);
  }, 20_000);
});
