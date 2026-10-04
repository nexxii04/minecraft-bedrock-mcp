/**
 * Protocol probe: connects through the project's own BedrockClient (shims
 * included) and logs every distinct packet the server sends, so we can see how
 * far the login sequence gets. Run: npx tsx scripts/probe-packets.ts
 */
import process from 'node:process';

import { BedrockClient } from '../src/bedrock/client.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';

const config = loadConfig({
  MCBE_HOST: process.argv[2] ?? '127.0.0.1',
  MCBE_PORT: process.argv[3] ?? '19132',
  MCBE_USERNAME: process.argv[4] ?? 'ProbeAgent',
  MCBE_OFFLINE: 'true',
  MCBE_RECONNECT_ENABLED: 'false',
  MCBE_LOG_LEVEL: 'info',
});
const logger = createLogger({ level: config.logLevel });

const client = new BedrockClient({
  sessionId: 'probe',
  defaults: config.defaults,
  reconnect: { ...config.reconnect, enabled: false },
  limits: config.limits,
  logger,
  logRawPackets: false,
});

const seen = new Set<string>();
let count = 0;
client.on('packet', (packet) => {
  count += 1;
  if (!seen.has(packet.name)) {
    seen.add(packet.name);
    console.log(
      `#${String(count)} ${packet.name}`,
      JSON.stringify(packet.params, (_key, value: unknown) => (typeof value === 'bigint' ? `${value}n` : value)).slice(0, 220),
    );
  }
});
client.on('state', (state) => console.log('>> state:', state));
client.on('kicked', (info) => console.log('>> KICK', JSON.stringify(info)));
client.on('errored', (error) => console.log('>> error:', error.message));
client.on('disconnected', (info) => console.log('>> disconnected:', JSON.stringify(info)));

client
  .connect({
    host: config.defaults.host,
    port: config.defaults.port,
    username: config.defaults.username,
  })
  .then((snapshot) => console.log('>> connect resolved: pos', JSON.stringify(snapshot.position)))
  .catch((error: Error) => console.log('>> connect failed:', error.message));

setTimeout(() => {
  console.log(`\ntotal packets: ${String(count)}; distinct: ${[...seen].join(', ')}`);
  process.exit(0);
}, 25_000);
