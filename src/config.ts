import { z } from 'zod';

/**
 * All runtime configuration, resolved from environment variables.
 *
 * Nothing in this project hardcodes a host, port or credential: every knob is
 * declared here, has a safe default, and can be overridden per connection
 * through the `connect_to_server` tool.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'y', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'n', 'off']);

/**
 * Treats unset *and* empty environment variables as "not provided", so that
 * `MCBE_PORT=` behaves like `MCBE_PORT` being absent instead of coercing to 0.
 */
function normalizeEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    normalized[key] = value === undefined || value.trim() === '' ? undefined : value;
  }
  return normalized;
}

function boolSchema(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return defaultValue;
      const lowered = value.trim().toLowerCase();
      if (TRUTHY.has(lowered)) return true;
      if (FALSY.has(lowered)) return false;
      ctx.addIssue({ code: 'custom', message: `expected a boolean-like value, received "${value}"` });
      return z.NEVER;
    });
}

function intSchema(defaultValue: number, bounds: { min?: number; max?: number } = {}) {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return defaultValue;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        ctx.addIssue({ code: 'custom', message: `expected an integer, received "${value}"` });
        return z.NEVER;
      }
      if (bounds.min !== undefined && parsed < bounds.min) {
        ctx.addIssue({ code: 'custom', message: `expected a value >= ${bounds.min}, received ${parsed}` });
        return z.NEVER;
      }
      if (bounds.max !== undefined && parsed > bounds.max) {
        ctx.addIssue({ code: 'custom', message: `expected a value <= ${bounds.max}, received ${parsed}` });
        return z.NEVER;
      }
      return parsed;
    });
}

function enumSchema<T extends readonly [string, ...string[]]>(values: T, defaultValue: T[number]) {
  return (
    z
      .string()
      .optional()
      // The return type is annotated so the transform's output stays the literal
      // union (`T[number]`) rather than widening to `string`; without it, every
      // `enumSchema(RAKNET_BACKENDS, ...)` call would produce a plain string.
      .transform((value, ctx): T[number] => {
        if (value === undefined) return defaultValue;
        if ((values as readonly string[]).includes(value)) return value;
        ctx.addIssue({ code: 'custom', message: `expected one of ${values.join(', ')}, received "${value}"` });
        return z.NEVER;
      })
  );
}

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export const TRANSPORTS = ['stdio', 'http'] as const;
/** Bedrock RakNet backends supported by `bedrock-protocol`. */
export const RAKNET_BACKENDS = ['jsp-raknet', 'raknet-native', 'raknet-node'] as const;

/**
 * `bedrock-protocol`'s native RakNet binding (`raknet-native`) needs a compiler at
 * install time; the pure JS one (`jsp-raknet`) always works, so it is the default
 * for a fresh clone. Set `MCBE_RAKNET_BACKEND=raknet-native` when available.
 */
export const DEFAULT_RAKNET_BACKEND = 'jsp-raknet';

const envSchema = z.object({
  MCBE_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? '127.0.0.1'),
  MCBE_PORT: intSchema(19132, { min: 1, max: 65535 }),
  MCBE_USERNAME: z
    .string()
    .optional()
    .transform((v) => v ?? 'MCPAgent'),
  MCBE_OFFLINE: boolSchema(true),
  MCBE_AUTH_TITLE: z.string().optional(),
  MCBE_PROFILES_FOLDER: z
    .string()
    .optional()
    .transform((v) => v ?? '.minecraft-auth'),
  /**
   * Leave unset to let `bedrock-protocol` pick its current protocol version (and
   * upgrade it when server discovery succeeds). Set it to pin a specific
   * Bedrock release, e.g. `MCBE_VERSION=1.21.130`.
   */
  MCBE_VERSION: z.string().optional(),
  MCBE_RAKNET_BACKEND: enumSchema(RAKNET_BACKENDS, DEFAULT_RAKNET_BACKEND),
  MCBE_USE_RAKNET_WORKERS: boolSchema(true),
  MCBE_SKIP_PING: boolSchema(false),
  MCBE_PING_TIMEOUT_MS: intSchema(2000, { min: 100, max: 60000 }),
  MCBE_CONNECT_TIMEOUT_MS: intSchema(15000, { min: 1000, max: 300000 }),
  MCBE_SPAWN_TIMEOUT_MS: intSchema(30000, { min: 1000, max: 600000 }),
  MCBE_ACTION_TIMEOUT_MS: intSchema(5000, { min: 100, max: 120000 }),
  MCBE_CHAT_ECHO_TIMEOUT_MS: intSchema(1500, { min: 0, max: 60000 }),
  MCBE_VIEW_DISTANCE: intSchema(10, { min: 1, max: 64 }),
  MCBE_REQUEST_CHUNK_RADIUS: boolSchema(true),

  MCBE_RECONNECT_ENABLED: boolSchema(true),
  /**
   * Whether a server-side kick counts as a reason to reconnect. On by default
   * because the common kick during testing is "server restarting", and the attempt
   * count bounds a ban loop. Turn it off where a kick means "stop knocking".
   */
  MCBE_RECONNECT_ON_KICK: boolSchema(true),
  MCBE_RECONNECT_MAX_ATTEMPTS: intSchema(5, { min: 0, max: 100 }),
  MCBE_RECONNECT_BASE_DELAY_MS: intSchema(1000, { min: 50, max: 60000 }),
  MCBE_RECONNECT_MAX_DELAY_MS: intSchema(30000, { min: 100, max: 600000 }),

  MCBE_MAX_SESSIONS: intSchema(4, { min: 1, max: 64 }),
  MCBE_DEFAULT_SESSION_ID: z
    .string()
    .optional()
    .transform((v) => v ?? 'default'),

  MCBE_MAX_CHAT_LOG: intSchema(200, { min: 10, max: 10000 }),
  MCBE_MAX_EVENT_LOG: intSchema(500, { min: 10, max: 50000 }),
  MCBE_MAX_TRACKED_ENTITIES: intSchema(512, { min: 16, max: 20000 }),
  MCBE_MAX_TRACKED_BLOCKS: intSchema(4096, { min: 64, max: 500000 }),
  MCBE_MAX_TRACKED_CHUNKS: intSchema(1024, { min: 4, max: 16384 }),

  MCBE_ENABLE_RAW_PACKET_TOOL: boolSchema(false),

  MCBE_LOG_LEVEL: enumSchema(LOG_LEVELS, 'info'),
  MCBE_LOG_RAW_PACKETS: boolSchema(false),

  MCBE_TRANSPORT: enumSchema(TRANSPORTS, 'stdio'),
  MCBE_HTTP_HOST: z
    .string()
    .optional()
    .transform((v) => v ?? '127.0.0.1'),
  MCBE_HTTP_PORT: intSchema(8787, { min: 1, max: 65535 }),
  MCBE_HTTP_PATH: z
    .string()
    .optional()
    .transform((v) => v ?? '/mcp'),
  MCBE_HTTP_STATEFUL: boolSchema(true),
});

export type RawConfig = z.infer<typeof envSchema>;

/** Connection-level settings that `connect_to_server` may override per session. */
export interface ConnectionDefaults {
  host: string;
  port: number;
  username: string;
  offline: boolean;
  version: string | null;
  authTitle: string | null;
  profilesFolder: string | null;
  raknetBackend: (typeof RAKNET_BACKENDS)[number];
  useRaknetWorkers: boolean;
  skipPing: boolean;
  pingTimeoutMs: number;
  connectTimeoutMs: number;
  spawnTimeoutMs: number;
  viewDistance: number;
  requestChunkRadius: boolean;
}

export interface ReconnectConfig {
  enabled: boolean;
  /** Treat a server kick as a reconnectable event. */
  onKick: boolean;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface SessionLimits {
  maxChatLog: number;
  maxEventLog: number;
  maxTrackedEntities: number;
  maxTrackedBlocks: number;
  /**
   * Decoded chunks kept per session.
   *
   * A chunk costs roughly a kilobyte once decoded (the packed bit arrays are
   * kept as-is rather than expanded), so the default covers a typical view
   * distance for well under a megabyte.
   */
  maxTrackedChunks: number;
}

export interface ServerTransportConfig {
  kind: (typeof TRANSPORTS)[number];
  http: {
    host: string;
    port: number;
    path: string;
    stateful: boolean;
  };
}

export interface AppConfig {
  defaults: ConnectionDefaults;
  reconnect: ReconnectConfig;
  limits: SessionLimits;
  /** Time budget for actions that wait for a server acknowledgement. */
  actionTimeoutMs: number;
  /** How long to wait for our own chat message to come back before giving up. */
  chatEchoTimeoutMs: number;
  maxSessions: number;
  defaultSessionId: string;
  enableRawPacketTool: boolean;
  logLevel: (typeof LOG_LEVELS)[number];
  logRawPackets: boolean;
  transport: ServerTransportConfig;
}

/**
 * Parses and validates the environment. Pure: pass `process.env` (or a fake) and
 * get an immutable-ish config object back, which keeps this unit testable.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(normalizeEnv(env));
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const raw = parsed.data;

  return {
    defaults: {
      host: raw.MCBE_HOST,
      port: raw.MCBE_PORT,
      username: raw.MCBE_USERNAME,
      offline: raw.MCBE_OFFLINE,
      version: raw.MCBE_VERSION ?? null,
      authTitle: raw.MCBE_AUTH_TITLE ?? null,
      profilesFolder: raw.MCBE_PROFILES_FOLDER,
      raknetBackend: raw.MCBE_RAKNET_BACKEND,
      useRaknetWorkers: raw.MCBE_USE_RAKNET_WORKERS,
      skipPing: raw.MCBE_SKIP_PING,
      pingTimeoutMs: raw.MCBE_PING_TIMEOUT_MS,
      connectTimeoutMs: raw.MCBE_CONNECT_TIMEOUT_MS,
      spawnTimeoutMs: raw.MCBE_SPAWN_TIMEOUT_MS,
      viewDistance: raw.MCBE_VIEW_DISTANCE,
      requestChunkRadius: raw.MCBE_REQUEST_CHUNK_RADIUS,
    },
    reconnect: {
      enabled: raw.MCBE_RECONNECT_ENABLED,
      onKick: raw.MCBE_RECONNECT_ON_KICK,
      maxAttempts: raw.MCBE_RECONNECT_MAX_ATTEMPTS,
      baseDelayMs: raw.MCBE_RECONNECT_BASE_DELAY_MS,
      maxDelayMs: raw.MCBE_RECONNECT_MAX_DELAY_MS,
    },
    limits: {
      maxChatLog: raw.MCBE_MAX_CHAT_LOG,
      maxEventLog: raw.MCBE_MAX_EVENT_LOG,
      maxTrackedEntities: raw.MCBE_MAX_TRACKED_ENTITIES,
      maxTrackedBlocks: raw.MCBE_MAX_TRACKED_BLOCKS,
      maxTrackedChunks: raw.MCBE_MAX_TRACKED_CHUNKS,
    },
    actionTimeoutMs: raw.MCBE_ACTION_TIMEOUT_MS,
    chatEchoTimeoutMs: raw.MCBE_CHAT_ECHO_TIMEOUT_MS,
    maxSessions: raw.MCBE_MAX_SESSIONS,
    defaultSessionId: raw.MCBE_DEFAULT_SESSION_ID,
    enableRawPacketTool: raw.MCBE_ENABLE_RAW_PACKET_TOOL,
    logLevel: raw.MCBE_LOG_LEVEL,
    logRawPackets: raw.MCBE_LOG_RAW_PACKETS,
    transport: {
      kind: raw.MCBE_TRANSPORT,
      http: {
        host: raw.MCBE_HTTP_HOST,
        port: raw.MCBE_HTTP_PORT,
        path: raw.MCBE_HTTP_PATH.startsWith('/') ? raw.MCBE_HTTP_PATH : `/${raw.MCBE_HTTP_PATH}`,
        stateful: raw.MCBE_HTTP_STATEFUL,
      },
    },
  };
}

/** Bounded exponential backoff with full jitter, used by the reconnect loop. */
export function reconnectDelayMs(attempt: number, config: ReconnectConfig): number {
  const exponential = config.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, config.maxDelayMs);
  const jitter = 0.5 + Math.random() * 0.5;
  return Math.round(capped * jitter);
}
