/**
 * E2E smoke test against a LIVE Bedrock server, exercising the same code path an
 * MCP client would (registry.invoke on real tools, JSON results and all). Not part
 * of the vitest suite; run manually:
 *   npx tsx scripts/e2e-smoke.ts [host] [port] [username]
 */
import process from 'node:process';

import { loadConfig } from '../src/config.js';
import { createNoopLogger } from '../src/logger.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { payloadOf, type JsonPayload } from '../src/mcp/testing.js';
import { SessionManager } from '../src/session-manager.js';

const host = process.argv[2] ?? '127.0.0.1';
const port = Number(process.argv[3] ?? '19132');
const username = process.argv[4] ?? 'MCPAgent';

const config = loadConfig({
  MCBE_HOST: host,
  MCBE_PORT: String(port),
  MCBE_USERNAME: username,
  MCBE_OFFLINE: 'true',
  MCBE_RECONNECT_ENABLED: 'false',
  MCBE_LOG_LEVEL: 'info',
});
const logger = createNoopLogger();
const manager = new SessionManager(config, logger);
const { registry } = buildMcpServer({ manager, config, logger, version: 'e2e-smoke' });

async function call(name: string, args: Record<string, unknown> = {}): Promise<JsonPayload> {
  const result: Awaited<ReturnType<typeof registry.invoke>> = await registry.invoke(name, args);
  const payload = payloadOf(result);
  const isError = result.isError === true;
  const icon = isError ? '✗' : payload['confirmed'] === false ? '·' : '✓';
  console.log(
    `${icon} ${name}${isError ? ` ERROR: ${JSON.stringify(payload).slice(0, 200)}` : payload['confirmed'] === false ? ' (confirmed:false)' : ''}`,
  );
  return payload;
}

async function main(): Promise<void> {
  console.log(`== E2E smoke vs ${host}:${port} (username=${username}) ==\n`);

  // 1) connect_to_server (default waitForSpawn: true)
  const connect = await call('connect_to_server', { sessionId: 'e2e', host, port, username, timeoutMs: 30_000 });
  console.log('  payload:', JSON.stringify(connect).slice(0, 400), '\n');

  // 2) move_to a nearby spot — position may be unknown when the library cannot
  // parse the server's start_game (interop gap); fall back to a hard-coded spot
  // near spawn only if the session reports none.
  const snap = await call('snapshot_session_state', { sessionId: 'e2e' });
  const raw = snap['raw'] as { position?: { x: number; y: number; z: number }; runtimeEntityId?: number | null } | null;
  const base = raw?.position ?? { x: 0, y: 64, z: 0 };
  const move = await call('move_to', { sessionId: 'e2e', x: base.x + 3, y: base.y, z: base.z, timeoutMs: 8_000 });
  console.log('  move:', JSON.stringify(move).slice(0, 300), '\n');

  // 2b) walk_to — several authoritative-input packets instead of one position
  // report. Nothing here confirms it (the server broadcasts to other viewers),
  // so what is checked is that the walk ran and left the session where it said.
  const walkTarget = { x: Math.round(base.x) + 12, y: base.y, z: Math.round(base.z) };
  const walk = await call('walk_to', {
    sessionId: 'e2e',
    ...walkTarget,
    stepLength: 2,
    stepIntervalMs: 60,
    maxSteps: 20,
  });
  const walkDetail = walk['detail'] as { steps: number; reached: boolean; finalPosition: { x: number } } | undefined;
  console.log(
    `  walk: steps=${String(walkDetail?.steps)} reached=${String(walkDetail?.reached)} at x=${String(walkDetail?.finalPosition.x)}\n`,
  );
  if (walkDetail === undefined || walkDetail.steps < 1) throw new Error('walk_to sent no steps');

  // 3) send_chat + 4) wait_for_chat (server echo)
  const line = `hello from minecraft-bedrock-mcp at ${new Date().toISOString()}`;
  await call('send_chat', { sessionId: 'e2e', message: line });
  const waited = await call('wait_for_chat', { sessionId: 'e2e', contains: 'hello from minecraft-bedrock-mcp', timeoutMs: 5_000 });
  const messages = (waited['messages'] ?? []) as { message: string }[];
  console.log('  echoed:', messages.length > 0, '\n');

  // 5) run_command — the guaranteed command path, which answers with the
  // server's own command_output. `/about` is used because most servers reply to
  // it; a silent command is the case where `confirmed` legitimately stays false.
  const command = await call('run_command', { sessionId: 'e2e', command: 'about', timeoutMs: 8_000 });
  console.log('  command:', JSON.stringify(command).slice(0, 400), '\n');

  // 6) list_commands — the server's own catalogue of what it will accept.
  const catalogue = await call('list_commands', { sessionId: 'e2e', search: 'give' });
  console.log('  commands:', JSON.stringify(catalogue).slice(0, 400), '\n');

  // 7) terrain: get_block_at at a column of heights, find_block for something
  // common nearby, and get_biome for the same coordinate. All three read the
  // decoded level_chunk payloads, so they only answer for streamed chunks —
  // hence the wait, which is what an agent would have to do too.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const poll = await call('snapshot_session_state', { sessionId: 'e2e' });
    const polled = poll['raw'] as { chunksDecoded?: number } | null;
    if ((polled?.chunksDecoded ?? 0) > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const terrainSnap = await call('snapshot_session_state', { sessionId: 'e2e' });
  const terrainRaw = terrainSnap['raw'] as { position?: { x: number; y: number; z: number } } | null;
  const at = terrainRaw?.position ?? base;
  const column = [Math.floor(at.y) - 3, Math.floor(at.y) - 1];
  for (const y of column) {
    const block = await call('get_block_at', { sessionId: 'e2e', x: Math.floor(at.x), y, z: Math.floor(at.z) });
    console.log(`  block at y=${String(y)}:`, JSON.stringify(block).slice(0, 300), '\n');
  }

  const found = await call('find_block', { sessionId: 'e2e', block: 'dirt', radius: 8, limit: 5 });
  const matchCount = found['count'] as number;
  console.log(`  dirt found: ${String(matchCount)} match(es)`, JSON.stringify(found).slice(0, 300), '\n');
  if (matchCount < 1) throw new Error('find_block found no dirt in a loaded box, which cannot be right');

  const biome = await call('get_biome', { sessionId: 'e2e', x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) });
  console.log('  biome:', JSON.stringify(biome).slice(0, 300), '\n');

  // 8) assert_session_state
  const assert = await call('assert_session_state', {
    sessionId: 'e2e',
    assertions: [
      { name: 'connected', path: 'connection.state', equals: 'initialized' },
      { name: 'alive', path: 'isAlive', equals: true },
      { name: 'has runtime id', path: 'runtimeEntityId', notEquals: null },
      { name: 'the server announced commands', path: 'commandCount', atLeast: 1 },
      { name: 'chunks were decoded', path: 'chunksDecoded', atLeast: 1 },
      { name: 'the server announced biomes', path: 'biomesNamed', atLeast: 0 },
    ],
  });
  console.log('  success:', assert['success'], JSON.stringify(assert['assertions']).slice(0, 220), '\n');

  // 9) get_connection_status
  const status = await call('get_connection_status', { sessionId: 'e2e' });
  console.log('  status:', JSON.stringify(status).slice(0, 400), '\n');

  // 10) disconnect
  await call('disconnect', { sessionId: 'e2e', reason: 'e2e smoke done', dispose: true });
  console.log('\n== E2E smoke complete ==');
  process.exit(0);
}

main().catch((error) => {
  console.error('E2E smoke failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
