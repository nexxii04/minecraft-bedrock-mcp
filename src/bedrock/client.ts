import { EventEmitter } from 'node:events';
import bedrock from 'bedrock-protocol';

import { reconnectDelayMs, type ConnectionDefaults, type ReconnectConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { ConnectionState, DomainEvent, SessionSnapshot } from '../types.js';
import { MODELLED_PACKET_NAMES } from './packets.js';
import { OFFLINE_OIDC_CLAIMS, resignOidcOfflineToken } from './offline-oidc.js';
import { applyProtocolPatches } from './protocol-patches.js';
import { BedrockSession, type SessionStateInit } from './session.js';

/**
 * Connection layer: the only module that talks to `bedrock-protocol`'s client.
 *
 * The library gives a socket, login handshake and decoded packets; everything on
 * top (reconnection, timeouts, state tracking, acknowledgement waits) lives here.
 *
 * Two library details shape this code:
 * 1. `client.close()` calls `removeAllListeners()`, so listeners are never reused
 *    across reconnects — each (re)connect builds a new client and re-attaches.
 * 2. `createClient()` is fire-and-forget, so "connected" is detected from events.
 */

/** Decoded packet as `bedrock-protocol` emits it on its `packet` event. */
export interface RawPacket {
  name: string;
  params: Record<string, unknown>;
}

/** Delay between the farewell `disconnect` packet and closing, so the last encrypted batch is not truncated. */
const DISCONNECT_FLUSH_MS = 150;

/** Status codes used by `bedrock-protocol`'s `ClientStatus` enum. */
const CLIENT_STATUS = {
  Disconnected: 0,
  Connecting: 1,
  Authenticating: 2,
  Initializing: 3,
  Initialized: 4,
} as const;

/**
 * Undeclared fields on the library's `Client` instance, reached through a narrow
 * cast instead of `any`.
 */
interface RawClientInternals {
  options?: {
    version?: string;
    protocolVersion?: number;
  };
  /**
   * Set during authentication. In offline mode its `uuid` is derived from the
   * username, so it is stable across reconnects.
   */
  profile?: {
    uuid?: string;
    name?: string;
  };
  username?: string;
}

export interface BedrockClientOptions {
  sessionId: string;
  defaults: ConnectionDefaults;
  reconnect: ReconnectConfig;
  limits: SessionStateInit['limits'];
  logger: Logger;
  /** Log every decoded packet (very noisy; for protocol debugging only). */
  logRawPackets: boolean;
}

export interface ConnectOverrides {
  host?: string;
  port?: number;
  username?: string;
  offline?: boolean;
  version?: string | null;
  profilesFolder?: string | null;
  authTitle?: string | null;
  raknetBackend?: ConnectionDefaults['raknetBackend'];
  skipPing?: boolean;
}

export interface KickedInfo {
  message: string;
  hidden: boolean;
  reason: string;
}

export interface DisconnectedInfo {
  reason: string | null;
  intentional: boolean;
  willReconnect: boolean;
}

export interface ReconnectInfo {
  attempt: number;
  delayMs: number;
  reason: string | null;
}

export interface BedrockClientEventMap {
  /** A normalised domain event (chat, movement, block change, ...). */
  event: [DomainEvent];
  /** Raw decoded packet, before normalisation. */
  packet: [RawPacket];
  /** Socket is up, handshake finished and we are a player in the world. */
  connected: [SessionSnapshot];
  /** Server told us we may spawn; the session is fully interactive. */
  spawned: [SessionSnapshot];
  disconnected: [DisconnectedInfo];
  kicked: [KickedInfo];
  errored: [Error];
  reconnecting: [ReconnectInfo];
  state: [ConnectionState];
}

/** Small promise utility: resolve a `waitFor*` call from an event listener. */
interface Waiter<T> {
  predicate: (value: T) => boolean;
  resolve: (value: T) => void;
  timer: NodeJS.Timeout;
}

export class BedrockClient extends EventEmitter<BedrockClientEventMap> {
  readonly session: BedrockSession;
  readonly sessionId: string;

  private readonly options: BedrockClientOptions;
  private readonly logger: Logger;

  private raw: bedrock.Client | null = null;
  private overrides: ConnectOverrides = {};
  private intentionalClose = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private joining = false;
  private eventWaiters: Waiter<DomainEvent>[] = [];
  private packetWaiters: Waiter<RawPacket>[] = [];

  constructor(options: BedrockClientOptions) {
    super();
    this.options = options;
    this.sessionId = options.sessionId;
    this.logger = options.logger.child({ component: 'bedrock-client', session: options.sessionId });

    const defaults = options.defaults;
    this.session = new BedrockSession({
      sessionId: options.sessionId,
      host: defaults.host,
      port: defaults.port,
      username: defaults.username,
      offline: defaults.offline,
      raknetBackend: defaults.raknetBackend,
      limits: options.limits,
    });

    this.session.onEvent((event) => {
      this.emit('event', event);
      this.resolveWaiters(this.eventWaiters, event);
    });
  }

  get isConnected(): boolean {
    return this.raw !== null && this.session.state !== 'disconnected' && this.session.state !== 'errored';
  }

  /**
   * Opens the connection and resolves once the server has let us in (the `join`
   * stage). Rejects on handshake failure or timeout; a failed first connection is
   * not retried, so it surfaces as an error.
   */
  async connect(overrides: ConnectOverrides = {}): Promise<SessionSnapshot> {
    if (this.raw !== null) {
      throw new Error(
        `Session "${this.sessionId}" is already connected to ${this.session.connection.host}:${this.session.connection.port}`,
      );
    }

    this.overrides = overrides;
    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    this.session.resetWorldState();

    return await this.openSocket({ isReconnect: false });
  }

  private async openSocket(context: { isReconnect: boolean }): Promise<SessionSnapshot> {
    const defaults = this.options.defaults;
    const host = this.overrides.host ?? defaults.host;
    const port = this.overrides.port ?? defaults.port;
    const username = this.overrides.username ?? defaults.username;
    const version = this.overrides.version ?? defaults.version;

    this.session.connection.host = host;
    this.session.connection.port = port;
    this.session.connection.username = username;
    this.session.setConnectionState(context.isReconnect ? 'reconnecting' : 'connecting');

    this.logger.info(
      { host, port, username, version: version ?? '(library default)', reconnect: context.isReconnect },
      'connecting to Bedrock server',
    );

    // `version: undefined` falls through to the library's CURRENT_VERSION and lets
    // server discovery upgrade it when a ping succeeds.
    const clientOptions: bedrock.ClientOptions = {
      host,
      port,
      username,
      offline: this.overrides.offline ?? defaults.offline,
      raknetBackend: this.overrides.raknetBackend ?? defaults.raknetBackend,
      useRaknetWorkers: defaults.useRaknetWorkers,
      skipPing: this.overrides.skipPing ?? defaults.skipPing,
      pingTimeout: defaults.pingTimeoutMs,
      connectTimeout: defaults.connectTimeoutMs,
      viewDistance: defaults.viewDistance,
      profilesFolder: this.overrides.profilesFolder ?? defaults.profilesFolder ?? false,
      // Critical: the library's default `conLog` is console.log, and stdout is the
      // MCP JSON-RPC channel over stdio. Route its output to our stderr logger.
      conLog: (...args: unknown[]) => this.logger.debug({ args: sanitizeForLog(args) }, 'bedrock-protocol'),
    };
    if (version !== null && version !== undefined && version !== '') clientOptions.version = version;

    const authTitle = this.overrides.authTitle ?? defaults.authTitle;
    if (authTitle !== null && authTitle !== undefined && authTitle !== '') clientOptions.authTitle = authTitle;
    if ((this.overrides.offline ?? defaults.offline) !== true) {
      clientOptions.onMsaCode = (data) => {
        // Device-code flow: the user must see this, and stdout may be the protocol
        // channel, so it goes to the logger at warn level.
        this.logger.warn(
          { userCode: data.user_code, verificationUri: data.verification_uri, expiresIn: data.expires_in },
          'Microsoft authentication required: open the URL and enter the code',
        );
      };
    }

    // Schema fixes must land before `createClient` compiles the protocol: see
    // protocol-patches.ts for the wire-format drift this corrects.
    applyProtocolPatches();

    const raw = bedrock.createClient(clientOptions);
    this.applyOfflineOidcShim(raw);
    this.raw = raw;
    this.attachHandlers(raw, { isReconnect: context.isReconnect });

    const internals = raw as unknown as RawClientInternals;
    this.session.markConnected(internals.options?.version ?? version ?? null, internals.options?.protocolVersion ?? null);

    try {
      await this.waitForJoin(raw, defaults.connectTimeoutMs + defaults.pingTimeoutMs + 5000);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.session.setConnectionState('errored', { reason: failure.message });
      this.teardownRaw();
      throw failure;
    }

    this.emit('connected', this.session.snapshot());
    return this.session.snapshot();
  }

  /**
   * Patches the raw client's offline login for servers that parse the OIDC
   * identity token strictly (some third-party servers require the `tid` claim,
   * which the library omits). Wrapping `createClientChain` keeps the library's own
   * key pair, header and chain assembly, re-signing with the same identity so
   * servers see a self-consistent login. No-op on legacy formats and online mode.
   *
   * `createClientChain` only exists after the library's `init()` runs, which is
   * after `createClient()` returns — a missing one is deferred to
   * `connect_allowed`, which always fires before any login is sent.
   */
  private applyOfflineOidcShim(raw: bedrock.Client): void {
    const install = (): void => {
      type ChainFactory = (mojangKey: string | null, offline: boolean) => void;
      const client = raw as unknown as {
        createClientChain?: ChainFactory;
        multiplayerToken?: string;
        ecdhKeyPair?: { privateKey: { export(options: { format: 'pem'; type: 'sec1' }): string } };
        clientX509?: string;
      };
      const original = client.createClientChain;
      if (typeof original !== 'function') return;
      client.createClientChain = (mojangKey, offline): void => {
        original.call(client, mojangKey, offline);
        if (offline !== true) return;
        const token = client.multiplayerToken;
        const keyPair = client.ecdhKeyPair;
        if (typeof token !== 'string' || token === '' || keyPair === undefined || typeof client.clientX509 !== 'string') return;
        const result = resignOidcOfflineToken(token, OFFLINE_OIDC_CLAIMS, {
          privateKeyPem: keyPair.privateKey.export({ format: 'pem', type: 'sec1' }),
          clientX509: client.clientX509,
          logger: this.logger,
        });
        if (result.modified) client.multiplayerToken = result.token;
      };
    };

    type ChainFactory = (mojangKey: string | null, offline: boolean) => void;
    if (typeof (raw as unknown as { createClientChain?: ChainFactory }).createClientChain === 'function') {
      install();
    } else {
      raw.once('connect_allowed', install);
    }
  }

  /** Waits for the library to reach the `join` stage, or fails with context. */
  private waitForJoin(raw: bedrock.Client, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (raw.status >= CLIENT_STATUS.Initializing) {
        resolve();
        return;
      }
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        raw.removeListener('join', onJoin);
        raw.removeListener('error', onError);
        raw.removeListener('close', onClose);
        raw.removeListener('kick', onKick);
        if (error !== undefined) reject(error);
        else resolve();
      };
      const onJoin = (): void => finish();
      const onError = (error: Error): void => finish(error);
      const onClose = (reason: string | undefined): void =>
        finish(new Error(`Connection closed before joining${reason !== undefined && reason !== '' ? `: ${reason}` : ''}`));
      const onKick = (packet: { message?: string; hide_disconnect_reason?: boolean }): void =>
        finish(
          new Error(`Kicked before joining: ${packet.hide_disconnect_reason === true ? '(reason hidden)' : (packet.message ?? 'unknown')}`),
        );
      const timer = setTimeout(() => finish(new Error(`Timed out after ${timeoutMs}ms waiting for the server to let us join`)), timeoutMs);

      raw.on('join', onJoin);
      raw.on('error', onError);
      raw.on('close', onClose);
      raw.on('kick', onKick);
    });
  }

  /** Resolves once the server signals spawn, or `null` on timeout. */
  async waitForSpawn(timeoutMs = this.options.defaults.spawnTimeoutMs): Promise<SessionSnapshot | null> {
    if (this.session.state === 'initialized') return this.session.snapshot();
    const event = await this.waitForDomainEvent((candidate) => candidate.type === 'spawned', timeoutMs, 'spawn');
    return event === null ? null : this.session.snapshot();
  }

  /** Closes on purpose: no reconnect, and the session is marked `disconnected`. */
  async disconnect(reason = 'Disconnected by MCP client'): Promise<void> {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    const raw = this.raw;
    if (raw === null) {
      this.session.setConnectionState('disconnected', { reason });
      return;
    }
    try {
      if (raw.status >= CLIENT_STATUS.Initializing)
        raw.write('disconnect', {
          reason: 'unknown',
          hide_disconnect_reason: false,
          message: reason,
          filtered_message: '',
        });
      // Give the outgoing batch time to leave the socket: closing straight after
      // the write can truncate the encrypted batch and desync the server's cipher.
      await new Promise((resolve) => setTimeout(resolve, DISCONNECT_FLUSH_MS));
    } catch (error) {
      this.logger.debug({ error: errorMessage(error) }, 'failed to send disconnect packet; closing socket anyway');
    }
    try {
      raw.close(reason);
    } catch (error) {
      this.logger.debug({ error: errorMessage(error) }, 'error while closing Bedrock socket');
    }
    this.teardownRaw();
    this.session.setConnectionState('disconnected', { reason });
  }

  /**
   * Tears down everything and forbids further reconnects. Declared async because
   * callers await it; the body is synchronous.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- awaitable API, synchronous body
  async dispose(): Promise<void> {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.rejectWaiters('Session disposed');
    if (this.raw !== null) {
      try {
        this.raw.close('Session disposed');
      } catch {
        // Already gone.
      }
    }
    this.teardownRaw();
    this.session.setConnectionState('disconnected', { reason: 'Session disposed' });
    this.removeAllListeners();
  }

  /** Writes a packet immediately. Throws when not connected rather than silently no-op. */
  send(packetName: string, params: Record<string, unknown>): void {
    const raw = this.requireRaw();
    raw.write(packetName, params);
    this.session.notePacketSent();
    this.logger.trace({ packet: packetName }, 'sent packet');
  }

  /** Queues a packet for the next outgoing batch (lower latency cost). */
  queue(packetName: string, params: Record<string, unknown>): void {
    const raw = this.requireRaw();
    raw.queue(packetName, params);
    this.session.notePacketSent();
    this.logger.trace({ packet: packetName }, 'queued packet');
  }

  /**
   * Packet names this project models. `npm run inspect:packets` prints the full
   * list for the installed protocol version, the authority when names change.
   */
  listKnownPackets(): string[] {
    return [...MODELLED_PACKET_NAMES];
  }

  /**
   * The player UUID the library used at login, or `null` before auth. Command
   * requests carry it in their origin and servers expect the sender's own
   * identity, so actions read it here rather than inventing one.
   */
  get playerUuid(): string | null {
    if (this.raw === null) return null;
    const internals = this.raw as unknown as RawClientInternals;
    return internals.profile?.uuid ?? null;
  }

  /**
   * Serialises a payload without sending it, used by `send_raw_packet` dry-runs
   * and packet contract tests to ask whether the installed protocol would accept it.
   */
  canSerialize(packetName: string, params: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
    try {
      const raw = this.raw;
      if (raw === null) return { ok: true };
      // `createPacketBuffer` is what `write()` calls under the hood.
      const internals = raw as unknown as { serializer?: { createPacketBuffer: (packet: unknown) => Buffer } };
      internals.serializer?.createPacketBuffer({ name: packetName, params });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  private requireRaw(): bedrock.Client {
    if (this.raw === null) throw new Error(`Session "${this.sessionId}" is not connected`);
    return this.raw;
  }

  /**
   * Waits for the next domain event matching `predicate`, returning `null` on
   * timeout (not throwing): "server ignored it" and "connection broke" are both
   * normal QA outcomes.
   */
  waitForDomainEvent(
    predicate: (event: DomainEvent) => boolean,
    timeoutMs: number,
    description = 'domain event',
  ): Promise<DomainEvent | null> {
    return new Promise<DomainEvent | null>((resolve) => {
      const timer = setTimeout(() => {
        this.eventWaiters = this.eventWaiters.filter((waiter) => waiter.timer !== timer);
        this.logger.debug({ description, timeoutMs }, 'timed out waiting for event');
        resolve(null);
      }, timeoutMs);
      this.eventWaiters.push({ predicate, resolve, timer });
    });
  }

  /** Waits for the next raw packet named `packetName` satisfying `predicate`. */
  waitForPacket(
    packetName: string,
    predicate: (packet: RawPacket) => boolean = () => true,
    timeoutMs = this.options.defaults.connectTimeoutMs,
  ): Promise<RawPacket | null> {
    return new Promise<RawPacket | null>((resolve) => {
      const timer = setTimeout(() => {
        this.packetWaiters = this.packetWaiters.filter((waiter) => waiter.timer !== timer);
        resolve(null);
      }, timeoutMs);
      this.packetWaiters.push({
        predicate: (packet) => packet.name === packetName && predicate(packet),
        resolve,
        timer,
      });
    });
  }

  private resolveWaiters<T>(waiters: Waiter<T>[], value: T): void {
    if (waiters.length === 0) return;
    const remaining: Waiter<T>[] = [];
    for (const waiter of waiters) {
      let matches = false;
      try {
        matches = waiter.predicate(value);
      } catch {
        matches = false;
      }
      if (matches) {
        clearTimeout(waiter.timer);
        waiter.resolve(value);
      } else {
        remaining.push(waiter);
      }
    }
    waiters.length = 0;
    waiters.push(...remaining);
  }

  private rejectWaiters(reason: string): void {
    for (const waiter of this.eventWaiters) {
      clearTimeout(waiter.timer);
      this.logger.debug({ reason }, 'abandoning event waiter');
    }
    this.eventWaiters = [];
    for (const waiter of this.packetWaiters) clearTimeout(waiter.timer);
    this.packetWaiters = [];
  }

  private attachHandlers(raw: bedrock.Client, context: { isReconnect: boolean }): void {
    // `error` must always have a listener or an unhandled 'error' would crash the
    // MCP server. The emitter is overloaded: it reports both session failures and
    // single undecodable packets. The latter is normal after protocol drift, so it
    // is counted as data; the connection only enters `errored` for real trouble.
    raw.on('error', (error: Error) => {
      if (isUndecodablePacket(error)) {
        const event = this.session.noteUndecodablePacket(error.message);
        this.logger.warn(
          { error: error.message, count: this.session.undecodablePackets },
          'dropped a packet the deserializer could not read',
        );
        this.emit('event', event);
        this.resolveWaiters(this.eventWaiters, event);
        return;
      }
      this.logger.error({ error: error.message }, 'bedrock client error');
      this.emit('errored', error);
    });

    raw.on('status', (status: number) => {
      const mapped = mapClientStatus(status);
      if (mapped !== null) {
        this.session.setConnectionState(mapped);
        this.emit('state', mapped);
      }
    });

    raw.on('join', () => {
      this.clearReconnectTimer();
      this.session.setConnectionState('initializing');
      this.logger.info({ host: this.session.connection.host, port: this.session.connection.port }, 'joined Bedrock server');
      if (this.joining) return;
      this.joining = true;
      this.finishJoin(context);
    });

    raw.on('spawn', () => {
      this.session.setConnectionState('initialized');
      this.logger.info('spawned into the world');
      this.emit('spawned', this.session.snapshot());
    });

    raw.on('kick', (packet: { message?: string; hide_disconnect_reason?: boolean; reason?: string }) => {
      const hidden = packet.hide_disconnect_reason === true;
      const message = hidden ? '(reason hidden by server)' : (packet.message ?? '');
      this.logger.warn({ message, reason: packet.reason }, 'kicked by server');
      const info: KickedInfo = { message, hidden, reason: packet.reason ?? 'unknown' };
      this.emit('kicked', info);
      // Usually a server restart during testing, so the reconnect policy still
      // applies; `MCBE_RECONNECT_ON_KICK=false` makes a kick final instead.
      if (!this.options.reconnect.onKick) {
        this.intentionalClose = true;
        this.session.setConnectionState('disconnected', { reason: message });
      }
    });

    raw.on('packet', (deserialized: { data: RawPacket }) => {
      const packet: RawPacket = { name: deserialized.data.name, params: deserialized.data.params };
      if (this.options.logRawPackets) {
        this.logger.debug({ packet: packet.name, params: sanitizeForLog(packet.params) }, 'recv packet');
      }
      // `session.ingest` folds the packet into state and re-emits normalised events
      // on this object's `event` channel.
      this.session.ingest(packet.name, packet.params);
      this.emit('packet', packet);
      this.resolveWaiters(this.packetWaiters, packet);
    });

    raw.on('close', () => {
      this.handleClose();
    });
  }

  /**
   * Post-join bookkeeping that needs a live socket; the resource-pack handshake is
   * handled by the library, so only project-specific requests are added.
   */
  private finishJoin(context: { isReconnect: boolean }): void {
    this.joining = false;
    if (this.intentionalClose) return;

    if (this.options.defaults.requestChunkRadius) {
      // Without this many servers keep the view distance at the minimum.
      try {
        this.queue('request_chunk_radius', {
          chunk_radius: this.options.defaults.viewDistance,
          max_radius: 0,
        });
      } catch (error) {
        this.logger.debug({ error: errorMessage(error) }, 'failed to request chunk radius');
      }
    }

    if (context.isReconnect) {
      this.logger.info({ attempt: this.reconnectAttempts }, 'reconnected');
    }
  }

  private handleClose(): void {
    const intentional = this.intentionalClose;
    const reason = this.session.connection.lastDisconnectReason;
    const canReconnect = !intentional && this.options.reconnect.enabled && this.reconnectAttempts < this.options.reconnect.maxAttempts;

    this.teardownRaw();

    const info: DisconnectedInfo = { reason: reason ?? null, intentional, willReconnect: canReconnect };
    this.emit('disconnected', info);

    if (!canReconnect) {
      this.session.setConnectionState('disconnected', { reason: reason ?? null });
      if (!intentional) {
        this.logger.warn(
          { attempts: this.reconnectAttempts, max: this.options.reconnect.maxAttempts },
          'connection lost and no reconnect attempts left',
        );
      }
      return;
    }

    this.reconnectAttempts += 1;
    this.session.connection.reconnectAttempts = this.reconnectAttempts;
    const delayMs = reconnectDelayMs(this.reconnectAttempts, this.options.reconnect);
    this.session.connection.nextReconnectAt = Date.now() + delayMs;
    this.session.setConnectionState('reconnecting', { reason: reason ?? null });
    this.emit('reconnecting', { attempt: this.reconnectAttempts, delayMs, reason: reason ?? null });
    this.logger.info({ attempt: this.reconnectAttempts, maxAttempts: this.options.reconnect.maxAttempts, delayMs }, 'scheduling reconnect');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket({ isReconnect: true })
        .then(() => this.logger.info('reconnect succeeded'))
        .catch((error: unknown) => {
          this.logger.warn({ error: errorMessage(error) }, 'reconnect attempt failed');
          this.handleClose();
        });
    }, delayMs);
  }

  private teardownRaw(): void {
    const raw = this.raw;
    this.raw = null;
    this.joining = false;
    if (raw === null) return;
    raw.removeAllListeners();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

/**
 * True when an error came from the packet deserializer rather than the socket.
 * protodef's `PartialReadError` sets the `partialReadError` marker, matched rather
 * than the class to avoid reaching into protodef internals.
 */
function isUndecodablePacket(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { partialReadError?: unknown }).partialReadError === true;
}

function mapClientStatus(status: number): ConnectionState | null {
  switch (status) {
    case CLIENT_STATUS.Connecting:
      return 'connecting';
    case CLIENT_STATUS.Authenticating:
      return 'authenticating';
    case CLIENT_STATUS.Initializing:
      return 'initializing';
    case CLIENT_STATUS.Initialized:
      return 'initialized';
    case CLIENT_STATUS.Disconnected:
      return 'disconnected';
    default:
      return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Makes a value JSON-serialisable for logging: bigints become strings, deep
 * structures are truncated, and chunk-sized blobs are omitted.
 */
export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 4) return '[truncated]';
  if (Buffer.isBuffer(value)) return `[buffer ${value.length}b]`;
  if (Array.isArray(value)) {
    const head = value.slice(0, 25).map((entry) => sanitizeForLog(entry, depth + 1));
    return value.length > 25 ? [...head, `... ${value.length - 25} more`] : head;
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'payload' || key === 'blobs') {
      result[key] = '[omitted]';
      continue;
    }
    result[key] = sanitizeForLog(entry, depth + 1);
  }
  return result;
}
