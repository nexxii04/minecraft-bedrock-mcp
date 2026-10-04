import { describe, expect, it } from 'vitest';

import { loadConfig, reconnectDelayMs } from '../../src/config.js';

describe('loadConfig', () => {
  it('applies safe defaults when nothing is set', () => {
    const config = loadConfig({});

    expect(config.defaults.host).toBe('127.0.0.1');
    expect(config.defaults.port).toBe(19132);
    expect(config.defaults.username).toBe('MCPAgent');
    expect(config.defaults.offline).toBe(true);
    expect(config.defaults.version).toBeNull();
    // The pure JS RakNet backend works without a compiler.
    expect(config.defaults.raknetBackend).toBe('jsp-raknet');
    expect(config.reconnect.enabled).toBe(true);
    expect(config.reconnect.onKick).toBe(true);
    expect(config.maxSessions).toBe(4);
    expect(config.defaultSessionId).toBe('default');
    expect(config.transport.kind).toBe('stdio');
    expect(config.enableRawPacketTool).toBe(false);
    expect(config.logRawPackets).toBe(false);
  });

  it('reads overrides from the environment', () => {
    const config = loadConfig({
      MCBE_HOST: 'mc.example.net',
      MCBE_PORT: '19133',
      MCBE_USERNAME: 'QAOne',
      MCBE_OFFLINE: 'false',
      MCBE_VERSION: '1.21.130',
      MCBE_RAKNET_BACKEND: 'raknet-native',
      MCBE_SKIP_PING: 'true',
      MCBE_ACTION_TIMEOUT_MS: '9000',
      MCBE_MAX_SESSIONS: '2',
      MCBE_LOG_LEVEL: 'debug',
      MCBE_TRANSPORT: 'http',
      MCBE_HTTP_PORT: '9000',
      MCBE_HTTP_PATH: 'mcp',
      MCBE_ENABLE_RAW_PACKET_TOOL: 'true',
      MCBE_RECONNECT_ON_KICK: 'false',
    });

    expect(config.defaults.host).toBe('mc.example.net');
    expect(config.defaults.port).toBe(19133);
    expect(config.defaults.username).toBe('QAOne');
    expect(config.defaults.offline).toBe(false);
    expect(config.defaults.version).toBe('1.21.130');
    expect(config.defaults.raknetBackend).toBe('raknet-native');
    expect(config.defaults.skipPing).toBe(true);
    expect(config.actionTimeoutMs).toBe(9000);
    expect(config.maxSessions).toBe(2);
    expect(config.logLevel).toBe('debug');
    expect(config.transport.kind).toBe('http');
    expect(config.transport.http.port).toBe(9000);
    // A path without a leading slash is normalised, because it is used as a URL.
    expect(config.transport.http.path).toBe('/mcp');
    expect(config.enableRawPacketTool).toBe(true);
    expect(config.reconnect.onKick).toBe(false);
  });

  it('treats empty and whitespace-only values as unset', () => {
    // `FOO=` is a common shell mistake; coercing it would give port 0 or an empty
    // username rather than the documented default.
    const config = loadConfig({ MCBE_HOST: '', MCBE_PORT: '', MCBE_USERNAME: '   ', MCBE_OFFLINE: '' });
    expect(config.defaults.host).toBe('127.0.0.1');
    expect(config.defaults.port).toBe(19132);
    expect(config.defaults.username).toBe('MCPAgent');
    expect(config.defaults.offline).toBe(true);
  });

  it('rejects values it cannot honour, naming the variable', () => {
    expect(() => loadConfig({ MCBE_PORT: 'not-a-port' })).toThrow(/MCBE_PORT/);
    expect(() => loadConfig({ MCBE_PORT: '70000' })).toThrow(/MCBE_PORT/);
    expect(() => loadConfig({ MCBE_MAX_SESSIONS: '0' })).toThrow(/MCBE_MAX_SESSIONS/);
    expect(() => loadConfig({ MCBE_OFFLINE: 'maybe' })).toThrow(/MCBE_OFFLINE/);
    expect(() => loadConfig({ MCBE_LOG_LEVEL: 'verbose' })).toThrow(/MCBE_LOG_LEVEL/);
    expect(() => loadConfig({ MCBE_TRANSPORT: 'carrier-pigeon' })).toThrow(/MCBE_TRANSPORT/);
    expect(() => loadConfig({ MCBE_RAKNET_BACKEND: 'not-a-backend' })).toThrow(/MCBE_RAKNET_BACKEND/);
  });

  it('accepts the boolean spellings a shell script is likely to produce', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on', 'Y']) {
      expect(loadConfig({ MCBE_OFFLINE: value }).defaults.offline).toBe(true);
    }
    for (const value of ['0', 'false', 'FALSE', 'no', 'off', 'n']) {
      expect(loadConfig({ MCBE_OFFLINE: value }).defaults.offline).toBe(false);
    }
  });

  it('keeps the HTTP path usable as a URL', () => {
    expect(loadConfig({ MCBE_HTTP_PATH: '/rpc' }).transport.http.path).toBe('/rpc');
    expect(loadConfig({ MCBE_HTTP_PATH: 'rpc' }).transport.http.path).toBe('/rpc');
    expect(loadConfig({ MCBE_HTTP_PATH: '' }).transport.http.path).toBe('/mcp');
  });
});

describe('reconnectDelayMs', () => {
  const reconnect = { enabled: true, onKick: true, maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 8000 };

  it('grows exponentially and then caps', () => {
    // Jitter is bounded to 50-100% of the computed delay, so the deterministic
    // properties are the lower and upper bounds.
    for (const attempt of [1, 2, 3, 4]) {
      const delay = reconnectDelayMs(attempt, reconnect);
      const ceiling = Math.min(1000 * 2 ** (attempt - 1), 8000);
      expect(delay).toBeGreaterThanOrEqual(Math.round(ceiling * 0.5));
      expect(delay).toBeLessThanOrEqual(ceiling);
    }
  });

  it('never exceeds the configured maximum', () => {
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      expect(reconnectDelayMs(attempt, reconnect)).toBeLessThanOrEqual(reconnect.maxDelayMs);
    }
  });

  it('treats a zero or negative attempt as the first one', () => {
    expect(reconnectDelayMs(0, reconnect)).toBeGreaterThanOrEqual(Math.round(1000 * 0.5));
    expect(reconnectDelayMs(0, reconnect)).toBeLessThanOrEqual(1000);
  });
});
