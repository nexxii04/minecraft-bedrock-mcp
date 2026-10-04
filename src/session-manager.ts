import type { AppConfig, ConnectionDefaults } from './config.js';
import { BedrockActions } from './bedrock/actions.js';
import { BedrockClient, type ConnectOverrides } from './bedrock/client.js';
import type { Logger } from './logger.js';
import type { ConnectionState, SessionSnapshot } from './types.js';

/**
 * One agent-player: a Bedrock connection plus the actions that operate on it.
 */
export interface AgentSession {
  readonly id: string;
  readonly client: BedrockClient;
  readonly actions: BedrockActions;
  readonly createdAt: number;
  /** Effective connection defaults, after any per-session overrides. */
  readonly effective: ConnectionDefaults;
}

export interface SessionSummary {
  id: string;
  state: ConnectionState;
  host: string;
  port: number;
  username: string;
  version: string | null;
  connectedAt: number | null;
  runtimeEntityId: number | null;
  position: SessionSnapshot['position'];
  createdAt: number;
}

/**
 * Owns every live session. Multi-agent support is a day-one requirement, so
 * sessions are keyed by a caller-chosen id and created lazily by the tools.
 */
export class SessionManager {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly config: AppConfig;
  private readonly logger: Logger;

  constructor(config: AppConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child({ component: 'session-manager' });
  }

  get size(): number {
    return this.sessions.size;
  }

  get maxSessions(): number {
    return this.config.maxSessions;
  }

  get defaultSessionId(): string {
    return this.config.defaultSessionId;
  }

  /**
   * Returns the session with this id, creating it when missing. Creating is cheap
   * and side-effect free — nothing connects until the client is asked to — so
   * `connect_to_server` can be called repeatedly on the same id.
   */
  ensureSession(id: string = this.config.defaultSessionId, overrides: ConnectOverrides = {}): AgentSession {
    const existing = this.sessions.get(id);
    if (existing !== undefined) return existing;

    if (this.sessions.size >= this.config.maxSessions) {
      throw new Error(
        `Session limit reached (${this.config.maxSessions}). Disconnect an existing session first, or raise MCBE_MAX_SESSIONS. Active sessions: ${[...this.sessions.keys()].join(', ')}`,
      );
    }

    const effective: ConnectionDefaults = {
      ...this.config.defaults,
      ...(overrides.host !== undefined ? { host: overrides.host } : {}),
      ...(overrides.port !== undefined ? { port: overrides.port } : {}),
      ...(overrides.username !== undefined ? { username: overrides.username } : {}),
      ...(overrides.offline !== undefined ? { offline: overrides.offline } : {}),
      ...(overrides.version !== undefined ? { version: overrides.version } : {}),
      ...(overrides.raknetBackend !== undefined ? { raknetBackend: overrides.raknetBackend } : {}),
    };

    const client = new BedrockClient({
      sessionId: id,
      defaults: effective,
      reconnect: this.config.reconnect,
      limits: this.config.limits,
      logger: this.logger,
      logRawPackets: this.config.logRawPackets,
    });

    const actions = new BedrockActions({
      client,
      logger: this.logger,
      actionTimeoutMs: this.config.actionTimeoutMs,
      chatEchoTimeoutMs: this.config.chatEchoTimeoutMs,
    });

    const session: AgentSession = { id, client, actions, createdAt: Date.now(), effective };
    this.sessions.set(id, session);
    this.logger.info({ session: id }, 'created session');
    return session;
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  /**
   * Resolves a session id, defaulting to the configured one.
   *
   * Throws a message that lists the sessions that *do* exist, because the most
   * common agent mistake is passing a typo'd or stale session id.
   */
  require(id?: string): AgentSession {
    const key = id ?? this.config.defaultSessionId;
    const session = this.sessions.get(key);
    if (session === undefined) {
      const available = [...this.sessions.keys()];
      throw new Error(
        available.length === 0
          ? `No session "${key}" exists yet. Call connect_to_server first.`
          : `No session "${key}". Existing sessions: ${available.join(', ')}`,
      );
    }
    return session;
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map((session) => {
      const snapshot = session.client.session.snapshot();
      return {
        id: session.id,
        state: snapshot.connection.state,
        host: snapshot.connection.host,
        port: snapshot.connection.port,
        username: snapshot.connection.username,
        version: snapshot.connection.version,
        connectedAt: snapshot.connection.connectedAt,
        runtimeEntityId: snapshot.runtimeEntityId,
        position: snapshot.position,
        createdAt: session.createdAt,
      };
    });
  }

  /** Connects `id`, creating the session if needed. */
  async connect(id: string | undefined, overrides: ConnectOverrides): Promise<{ session: AgentSession; snapshot: SessionSnapshot }> {
    const session = this.ensureSession(id ?? this.config.defaultSessionId, overrides);
    const snapshot = await session.client.connect(overrides);
    return { session, snapshot };
  }

  async disconnect(id?: string, reason?: string): Promise<SessionSummary | null> {
    const key = id ?? this.config.defaultSessionId;
    const session = this.sessions.get(key);
    if (session === undefined) return null;
    await session.client.disconnect(reason ?? 'Disconnected through MCP');
    return this.list().find((summary) => summary.id === key) ?? null;
  }

  /** Disconnects and forgets a session. */
  async dispose(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (session === undefined) return false;
    this.sessions.delete(id);
    await session.client.dispose();
    this.logger.info({ session: id }, 'disposed session');
    return true;
  }

  /** Graceful shutdown: used by the entry point on SIGINT/SIGTERM. */
  async disposeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(
      ids.map(async (id) => {
        const session = this.sessions.get(id);
        if (session === undefined) return;
        this.sessions.delete(id);
        try {
          await session.client.dispose();
        } catch (error) {
          this.logger.warn(
            { session: id, error: error instanceof Error ? error.message : String(error) },
            'failed to dispose session cleanly',
          );
        }
      }),
    );
  }
}
