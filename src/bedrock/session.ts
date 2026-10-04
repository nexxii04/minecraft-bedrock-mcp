import type { SessionLimits } from '../config.js';
import type {
  BlockPosition,
  ChatMessage,
  CommandDescriptor,
  ConnectionInfo,
  ConnectionState,
  Dimension,
  DomainEvent,
  EntitySnapshot,
  GameMode,
  ItemStack,
  NearbyBlock,
  NearbyEntity,
  PlayerListEntry,
  Rotation,
  SessionSnapshot,
  Vec3,
} from '../types.js';
import { normalizePacket, type MutableSessionState, type TrackedChunk } from './events.js';
import { blockKey, distance, parseBlockKey, toBlockPosition } from './vec3.js';

export interface SessionStateInit {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  offline: boolean;
  raknetBackend: string;
  limits: SessionLimits;
}

/**
 * Everything we know about one connected agent-player.
 *
 * `bedrock-protocol` hands back raw packets, so the "what does the world look like
 * now" picture (position, inventory, entities, blocks, chat) is assembled and
 * maintained here. It also runs packets through the normalizers, keeps bounded
 * chat/event ring buffers, and produces plain-JSON snapshots for MCP resources.
 * Deliberately synchronous and dependency-free, so it is easy to unit-test without
 * a socket.
 */
export class BedrockSession implements MutableSessionState {
  readonly sessionId: string;

  state: ConnectionState = 'idle';
  entityId: string | null = null;
  runtimeEntityId: number | null = null;
  position: Vec3 | null = null;
  rotation: Rotation | null = null;
  onGround: boolean | null = null;
  dimension: Dimension = 'unknown';
  gameMode: GameMode = 'unknown';
  health: number | null = null;
  isAlive = true;
  worldName: string | null = null;
  serverVersion: string | null = null;
  permissionLevel: string | null = null;
  serverAuthoritativeInventory = false;
  serverAuthoritativeBlockBreaking = false;
  chunkRadius: number | null = null;
  chunksLoaded = 0;
  tick = 0;
  lastTickAt: number | null = null;
  entities = new Map<number, EntitySnapshot>();
  blocks = new Map<string, { blockRuntimeId: number; layer: number; at: number }>();
  inventory = new Map<string, Map<number, ItemStack>>();
  selectedHotbarSlot: number | null = null;
  itemNames = new Map<number, string>();
  /** Biome names the server announced via `biome_definition_list`. */
  biomes = new Map<number, string>();
  /** Clientbound packets the deserializer rejected, and the last complaint. */
  undecodablePackets = 0;
  lastUndecodablePacket: string | null = null;
  playerNames = new Map<number, string>();
  playerList = new Map<string, PlayerListEntry>();
  commands = new Map<string, CommandDescriptor>();
  chunks = new Map<string, TrackedChunk>();
  chunksDecoded = 0;
  chunksFailed = 0;
  maxTrackedEntities: number;
  maxTrackedBlocks: number;
  maxTrackedChunks: number;

  readonly connection: ConnectionInfo;
  private readonly limits: SessionLimits;
  private readonly chatLog: ChatMessage[] = [];
  private readonly eventLog: DomainEvent[] = [];
  private readonly listeners = new Set<(event: DomainEvent) => void>();

  constructor(init: SessionStateInit) {
    this.sessionId = init.sessionId;
    this.limits = init.limits;
    this.maxTrackedEntities = init.limits.maxTrackedEntities;
    this.maxTrackedBlocks = init.limits.maxTrackedBlocks;
    this.maxTrackedChunks = init.limits.maxTrackedChunks;
    this.connection = {
      state: 'idle',
      host: init.host,
      port: init.port,
      username: init.username,
      offline: init.offline,
      version: null,
      protocolVersion: null,
      raknetBackend: init.raknetBackend,
      connectedAt: null,
      lastDisconnectReason: null,
      reconnectAttempts: 0,
      nextReconnectAt: null,
      packetsReceived: 0,
      packetsSent: 0,
      lastPacketAt: null,
    };
  }

  /** Feeds one decoded packet in, returning its events and notifying subscribers. */
  ingest(packetName: string, params: Record<string, unknown>): DomainEvent[] {
    this.connection.packetsReceived += 1;
    this.connection.lastPacketAt = Date.now();
    const events = normalizePacket(packetName, params, this);
    for (const event of events) this.record(event);
    return events;
  }

  notePacketSent(): void {
    this.connection.packetsSent += 1;
  }

  /**
   * Records a clientbound packet the deserializer could not read. Protocol drift
   * is expected and `bedrock-protocol` drops such packets; counting them turns
   * "some feature does nothing" into "the server sent N packets this client could
   * not read". Deliberately not cleared by `resetWorldState` — it describes the
   * server version, not the world.
   */
  noteUndecodablePacket(error: string): DomainEvent {
    this.undecodablePackets += 1;
    this.lastUndecodablePacket = error;
    const event: DomainEvent = {
      type: 'packet_undecodable',
      at: Date.now(),
      error,
      count: this.undecodablePackets,
    };
    this.record(event);
    return event;
  }

  /**
   * Records a position we just reported to the server.
   *
   * The client is authoritative over its own position and the server broadcasts
   * movement only to other viewers, never echoing it to the mover, so nothing else
   * updates our belief; without this a teleporting session stays pinned to stale
   * coordinates. The event is tagged `source: 'self_report'` so nothing — most
   * importantly a movement action's own waiter — mistakes our belief for the server
   * agreeing.
   */
  reportSelfPosition(position: Vec3, rotation?: Rotation, onGround?: boolean): DomainEvent {
    this.position = position;
    if (rotation !== undefined) this.rotation = rotation;
    if (onGround !== undefined) this.onGround = onGround;
    const event: DomainEvent = {
      type: 'position_updated',
      at: Date.now(),
      position,
      rotation: this.rotation ?? { yaw: 0, pitch: 0, headYaw: 0 },
      onGround: this.onGround ?? false,
      source: 'self_report',
    };
    this.record(event);
    return event;
  }

  setConnectionState(state: ConnectionState, detail?: { reason?: string | null }): DomainEvent {
    const previous = this.state;
    this.state = state;
    this.connection.state = state;
    if (detail?.reason !== undefined) this.connection.lastDisconnectReason = detail.reason;
    const event: DomainEvent = {
      type: 'connection_state',
      at: Date.now(),
      previous,
      current: state,
    };
    this.record(event);
    return event;
  }

  markConnected(version: string | null, protocolVersion: number | null): void {
    this.connection.connectedAt = Date.now();
    this.connection.version = version;
    this.connection.protocolVersion = protocolVersion;
    this.connection.reconnectAttempts = 0;
    this.connection.nextReconnectAt = null;
  }

  /** Resets the world half of the state while keeping the connection metadata. */
  resetWorldState(): void {
    this.entityId = null;
    this.runtimeEntityId = null;
    this.position = null;
    this.rotation = null;
    this.onGround = null;
    this.dimension = 'unknown';
    this.gameMode = 'unknown';
    this.health = null;
    this.isAlive = true;
    this.worldName = null;
    this.permissionLevel = null;
    this.chunkRadius = null;
    this.chunksLoaded = 0;
    this.tick = 0;
    this.lastTickAt = null;
    this.entities.clear();
    this.blocks.clear();
    this.chunks.clear();
    // Decode counters describe the world view we are dropping, so they reset with it.
    this.chunksDecoded = 0;
    this.chunksFailed = 0;
    this.inventory.clear();
    this.itemNames.clear();
    this.biomes.clear();
    this.playerNames.clear();
    this.playerList.clear();
    this.selectedHotbarSlot = null;
    this.commands.clear();
  }

  onEvent(listener: (event: DomainEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private record(event: DomainEvent): void {
    this.eventLog.push(event);
    if (this.eventLog.length > this.limits.maxEventLog) {
      this.eventLog.splice(0, this.eventLog.length - this.limits.maxEventLog);
    }
    if (event.type === 'chat') {
      this.chatLog.push(event.chat);
      if (this.chatLog.length > this.limits.maxChatLog) {
        this.chatLog.splice(0, this.chatLog.length - this.limits.maxChatLog);
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A misbehaving subscriber must not break packet handling.
      }
    }
  }

  /** Most recent chat messages, oldest first. */
  getChatLog(options: { limit?: number; since?: number; source?: string } = {}): ChatMessage[] {
    let messages = this.chatLog;
    if (options.since !== undefined) messages = messages.filter((message) => message.at >= options.since!);
    if (options.source !== undefined) {
      const needle = options.source.toLowerCase();
      messages = messages.filter((message) => message.source.toLowerCase() === needle);
    }
    const limit = options.limit ?? messages.length;
    return messages.slice(-limit);
  }

  /** Most recent domain events, oldest first. */
  getEventLog(options: { limit?: number; types?: string[]; since?: number } = {}): DomainEvent[] {
    let events = this.eventLog;
    if (options.since !== undefined) events = events.filter((event) => event.at >= options.since!);
    if (options.types !== undefined && options.types.length > 0) {
      const wanted = new Set(options.types);
      events = events.filter((event) => wanted.has(event.type));
    }
    const limit = options.limit ?? events.length;
    return events.slice(-limit);
  }

  /** Inventory slots of the player's main container (hotbar first). */
  getInventory(containerId = 'inventory'): ItemStack[] {
    const container = this.inventory.get(containerId);
    if (container === undefined) return [];
    return [...container.values()].sort((a, b) => a.slot - b.slot);
  }

  getHeldItem(): ItemStack | null {
    const slot = this.selectedHotbarSlot;
    if (slot === null) return null;
    return this.inventory.get('inventory')?.get(slot) ?? null;
  }

  getNearbyEntities(options: { radius?: number; limit?: number; includeSelf?: boolean; types?: string[] } = {}): NearbyEntity[] {
    const origin = this.position;
    if (origin === null) return [];
    const radius = options.radius ?? 32;
    const limit = options.limit ?? 50;
    const selfId = this.runtimeEntityId;
    const result: NearbyEntity[] = [];
    for (const entity of this.entities.values()) {
      if (options.includeSelf !== true && selfId !== null && entity.runtimeId === selfId) continue;
      if (options.types !== undefined && options.types.length > 0 && !options.types.includes(entity.type)) continue;
      const entityDistance = distance(entity.position, origin);
      if (entityDistance > radius) continue;
      result.push({ ...entity, distance: Number(entityDistance.toFixed(3)) });
    }
    result.sort((a, b) => a.distance - b.distance);
    return result.slice(0, limit);
  }

  getTrackedBlock(position: BlockPosition): { blockRuntimeId: number; layer: number; at: number } | null {
    return this.blocks.get(blockKey(position)) ?? null;
  }

  /**
   * Blocks we have seen the server change near a point. Bedrock sends geometry as
   * chunk payloads plus deltas; this tracks the delta stream, which is what QA
   * scripts asserting on changes they caused need.
   */
  getNearbyTrackedBlocks(options: { radius?: number; limit?: number; center?: Vec3 } = {}): NearbyBlock[] {
    const origin = options.center ?? this.position;
    if (origin === null) return [];
    const radius = options.radius ?? 16;
    const limit = options.limit ?? 100;
    const result: NearbyBlock[] = [];
    const originBlock = toBlockPosition(origin);
    for (const [key, value] of this.blocks) {
      const position = parseBlockKey(key);
      if (position === null) continue;
      const blockDistance = Math.hypot(position.x - originBlock.x, position.y - originBlock.y, position.z - originBlock.z);
      if (blockDistance > radius) continue;
      result.push({
        position,
        blockRuntimeId: value.blockRuntimeId,
        distance: Number(blockDistance.toFixed(3)),
      });
    }
    result.sort((a, b) => a.distance - b.distance);
    return result.slice(0, limit);
  }

  getItemName(networkId: number): string | null {
    return this.itemNames.get(networkId) ?? null;
  }

  snapshot(): SessionSnapshot {
    const uptimeMs = this.connection.connectedAt === null ? null : Date.now() - this.connection.connectedAt;
    return {
      connection: { ...this.connection },
      entityId: this.entityId,
      runtimeEntityId: this.runtimeEntityId,
      position: this.position,
      rotation: this.rotation,
      onGround: this.onGround,
      dimension: this.dimension,
      gameMode: this.gameMode,
      health: this.health,
      isAlive: this.isAlive,
      worldName: this.worldName,
      serverVersion: this.serverVersion,
      permissionLevel: this.permissionLevel,
      serverAuthoritative: {
        inventory: this.serverAuthoritativeInventory,
        blockBreaking: this.serverAuthoritativeBlockBreaking,
      },
      chunkRadius: this.chunkRadius,
      chunksLoaded: this.chunksLoaded,
      tick: this.tick,
      itemRegistrySize: this.itemNames.size,
      biomesNamed: this.biomes.size,
      undecodablePackets: this.undecodablePackets,
      lastUndecodablePacket: this.lastUndecodablePacket,
      commandCount: this.commands.size,
      chunksTracked: this.chunks.size,
      chunksDecoded: this.chunksDecoded,
      chunksFailed: this.chunksFailed,
      trackedEntities: this.entities.size,
      trackedBlocks: this.blocks.size,
      knownPlayers: this.playerList.size,
      inventorySlots: this.inventory.get('inventory')?.size ?? 0,
      selectedHotbarSlot: this.selectedHotbarSlot,
      uptimeMs,
    };
  }
}
