/**
 * Domain types shared by every layer.
 *
 * These types are this project's internal contract. They are deliberately free of
 * any `bedrock-protocol` type: the MCP layer only ever sees the shapes declared
 * here, which keeps the protocol library confined to `src/bedrock/`.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Integer block coordinates, as used by every block-oriented Bedrock packet. */
export interface BlockPosition {
  x: number;
  y: number;
  z: number;
}

export interface Rotation {
  /** Degrees. 0 = south (+Z), 90 = west (-X), -90 = east (+X). */
  yaw: number;
  /** Degrees. -90 = straight up, 90 = straight down. */
  pitch: number;
  headYaw: number;
}

/** Where the connection currently sits in the Bedrock login/spawn sequence. */
export type ConnectionState =
  'idle' | 'connecting' | 'authenticating' | 'initializing' | 'initialized' | 'reconnecting' | 'disconnected' | 'errored';

export type Dimension = 'overworld' | 'nether' | 'end' | 'unknown';

export type GameMode = 'survival' | 'creative' | 'adventure' | 'spectator' | 'unknown';

/**
 * One item stack as it appears on the wire. `name` is only populated once the
 * session has seen an `item_registry` (or resolved via minecraft-data), because
 * Bedrock refers to items by numeric runtime id.
 */
export interface ItemStack {
  /** Position inside its container (0-8 = hotbar for the player inventory). */
  slot: number;
  /** Bedrock item runtime id. `0` means "empty". */
  networkId: number;
  count: number;
  metadata: number;
  blockRuntimeId: number;
  stackId?: number;
  name?: string;
  /** Raw `extra` payload, kept verbatim so it can be echoed back to the server. */
  extra?: unknown;
}

export interface InventoryWindow {
  containerId: string;
  slots: Map<number, ItemStack>;
  updatedAt: number;
}

export interface EntitySnapshot {
  runtimeId: number;
  uniqueId: number;
  type: string;
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  headYaw: number;
  isPlayer: boolean;
  username?: string;
  /** Only known for entities spawned after we joined. */
  spawnedAt: number;
  lastSeenAt: number;
}

export type ChatKind =
  | 'chat'
  | 'whisper'
  | 'announcement'
  | 'system'
  | 'raw'
  | 'tip'
  | 'json'
  | 'json_whisper'
  | 'json_announcement'
  | 'popup'
  | 'jukebox_popup';

export interface ChatMessage {
  kind: ChatKind;
  /** Empty for system/raw messages. */
  source: string;
  message: string;
  at: number;
  /** True when this arrived from the server as a result of our own `send_chat`. */
  fromSelf: boolean;
}

export interface PlayerListEntry {
  uuid: string;
  username: string;
  entityUniqueId?: number;
  xuid?: string;
}

/**
 * One command the server announced through `available_commands` — its own
 * catalogue of what it will accept, and the most direct answer to "what can I test
 * against this server?".
 *
 * `overloads` are pre-rendered signature strings (`name:type`, `?` for optional)
 * rather than structured parameter objects: the only consumer is an agent deciding
 * what to type.
 */
export interface CommandDescriptor {
  /** Command name as the server spells it, without a leading slash (e.g. `teleport`). */
  name: string;
  description: string;
  /** `any`, `operator` or a permission node the server checks. */
  permissionLevel: string;
  /** Alternative spellings resolved from the server's alias enum, e.g. `["tp"]`. */
  aliases: string[];
  /** Argument patterns the command accepts; more than one means overloads. */
  overloads: string[];
  /** Raw flag bits from the packet. Non-zero usually means "hidden from the client list". */
  flags: number;
}

interface DomainEventBase {
  at: number;
}

export interface ChatEvent extends DomainEventBase {
  type: 'chat';
  chat: ChatMessage;
}

export interface SessionStartedEvent extends DomainEventBase {
  type: 'session_started';
  entityId: string;
  runtimeEntityId: number;
  gameMode: GameMode;
  dimension: Dimension;
  position: Vec3;
  rotation: Rotation;
  worldName: string;
  serverVersion: string;
  permissionLevel?: string;
  serverAuthoritativeInventory: boolean;
  serverAuthoritativeBlockBreaking: boolean;
}

export interface PositionUpdatedEvent extends DomainEventBase {
  type: 'position_updated';
  position: Vec3;
  rotation: Rotation;
  onGround: boolean;
  /** How the position was learned, so agents can tell acks from self-reports. */
  source: 'self_report' | 'server_move' | 'server_correction' | 'respawn' | 'teleport';
}

export interface HealthChangedEvent extends DomainEventBase {
  type: 'health_changed';
  health: number;
  previousHealth: number | null;
}

export interface DeathEvent extends DomainEventBase {
  type: 'death';
  cause?: string;
  position?: Vec3;
}

export interface EntitySpawnedEvent extends DomainEventBase {
  type: 'entity_spawned';
  entity: EntitySnapshot;
}

export interface EntityRemovedEvent extends DomainEventBase {
  type: 'entity_removed';
  runtimeId: number;
  entityType?: string;
}

export interface EntityMovedEvent extends DomainEventBase {
  type: 'entity_moved';
  runtimeId: number;
  position: Vec3;
}

export interface EntityMetadataEvent extends DomainEventBase {
  type: 'entity_metadata';
  runtimeId: number;
  metadata: Record<string, unknown>;
}

export interface BlockUpdatedEvent extends DomainEventBase {
  type: 'block_updated';
  position: BlockPosition;
  blockRuntimeId: number;
  layer: number;
}

export interface InventoryUpdatedEvent extends DomainEventBase {
  type: 'inventory_updated';
  containerId: string;
  slotCount: number;
}

export interface InventorySlotEvent extends DomainEventBase {
  type: 'inventory_slot';
  containerId: string;
  slot: number;
  item: ItemStack | null;
}

export interface DimensionChangedEvent extends DomainEventBase {
  type: 'dimension_changed';
  dimension: Dimension;
  position: Vec3;
}

export interface PlayerListEvent extends DomainEventBase {
  type: 'player_list';
  added: PlayerListEntry[];
  removed: string[];
}

export interface ChunkEvent extends DomainEventBase {
  type: 'chunk_loaded';
  x: number;
  z: number;
  dimension: Dimension;
  chunksLoaded: number;
  /** True when the payload decoded and its blocks are now queryable. */
  decoded: boolean;
  /** Set when the payload did not decode cleanly; a statement about the server. */
  decodeError?: string;
}

export interface ChunkRadiusAcceptedEvent extends DomainEventBase {
  type: 'chunk_radius_accepted';
  chunkRadius: number;
}

export interface KickedEvent extends DomainEventBase {
  type: 'kicked';
  message: string;
  hidden: boolean;
}

export interface StatusEvent extends DomainEventBase {
  type: 'connection_state';
  previous: ConnectionState;
  current: ConnectionState;
}

export interface SpawnedEvent extends DomainEventBase {
  type: 'spawned';
  runtimeEntityId: number;
}

export interface HeartbeatEvent extends DomainEventBase {
  type: 'heartbeat';
  tick: number;
}

export interface ItemRegistryEvent extends DomainEventBase {
  type: 'item_registry';
  itemCount: number;
}

export interface CommandsAvailableEvent extends DomainEventBase {
  type: 'commands_available';
  commandCount: number;
}

/**
 * The server's own biome catalogue, from `biome_definition_list`. Names come from
 * the server, not a bundled table, because an id is only meaningful against the
 * catalogue the server announced (a custom world reuses ids). `namedCount` is
 * lower than `definitionCount` when the server left the id at its protocol default
 * — how a server says "these biomes exist" without saying which id.
 */
export interface BiomeDefinitionsEvent extends DomainEventBase {
  type: 'biome_definitions';
  definitionCount: number;
  namedCount: number;
}

/**
 * A clientbound packet this client could not decode. The packet is dropped and the
 * only trace is this event plus the session counter. It is not a session failure —
 * one unknown packet from a newer server is normal — but it is the first thing to
 * check when a feature silently does nothing.
 */
export interface UndecodablePacketEvent extends DomainEventBase {
  type: 'packet_undecodable';
  /** The deserializer's complaint, verbatim. */
  error: string;
  /** Packets dropped so far, counting this one. */
  count: number;
}

/**
 * One line of a `command_output`. The field is named `message_id` on the wire but
 * is the literal text (usually carrying `§` colour codes); `parameters` are the
 * substitution values for translated messages.
 */
export interface CommandOutputMessage {
  message: string;
  success: boolean;
  parameters: string[];
}

/**
 * A command we asked the server to run has produced output — the acknowledgement
 * `run_command` waits for. The echoed `uuid`/`request_id` correlate the reply with
 * its request on a busy connection.
 */
export interface CommandExecutedEvent extends DomainEventBase {
  type: 'command_executed';
  /** Verbatim echo of the request's `request_id`; the correlation key. */
  requestId: string;
  /** Verbatim echo of the request origin's `uuid`. */
  uuid: string;
  /** Origin the server attributed the command to, e.g. `player`. */
  originType: string;
  /** `alloutput` for a complete reply; `data_set`/`last_output` for streaming. */
  outputType: string;
  /** How many of the messages the server considered successful. */
  successCount: number;
  messages: CommandOutputMessage[];
  /** True when the server attached a raw `data` payload (block-data style replies). */
  hasData: boolean;
  data: string;
}

export type DomainEvent =
  | ChatEvent
  | SessionStartedEvent
  | PositionUpdatedEvent
  | HealthChangedEvent
  | DeathEvent
  | EntitySpawnedEvent
  | EntityRemovedEvent
  | EntityMovedEvent
  | EntityMetadataEvent
  | BlockUpdatedEvent
  | InventoryUpdatedEvent
  | InventorySlotEvent
  | DimensionChangedEvent
  | PlayerListEvent
  | ChunkEvent
  | ChunkRadiusAcceptedEvent
  | KickedEvent
  | StatusEvent
  | SpawnedEvent
  | HeartbeatEvent
  | ItemRegistryEvent
  | CommandsAvailableEvent
  | CommandExecutedEvent
  | BiomeDefinitionsEvent
  | UndecodablePacketEvent;

export type DomainEventType = DomainEvent['type'];

export interface ConnectionInfo {
  state: ConnectionState;
  host: string;
  port: number;
  username: string;
  offline: boolean;
  /** Protocol version string, e.g. `1.26.51`. */
  version: string | null;
  protocolVersion: number | null;
  raknetBackend: string;
  connectedAt: number | null;
  /** Set when the last disconnect was started by us instead of the server. */
  lastDisconnectReason: string | null;
  reconnectAttempts: number;
  nextReconnectAt: number | null;
  packetsReceived: number;
  packetsSent: number;
  lastPacketAt: number | null;
}

export interface SessionSnapshot {
  connection: ConnectionInfo;
  entityId: string | null;
  runtimeEntityId: number | null;
  position: Vec3 | null;
  rotation: Rotation | null;
  onGround: boolean | null;
  dimension: Dimension;
  gameMode: GameMode;
  health: number | null;
  isAlive: boolean;
  worldName: string | null;
  serverVersion: string | null;
  permissionLevel: string | null;
  serverAuthoritative: {
    inventory: boolean;
    blockBreaking: boolean;
  };
  chunkRadius: number | null;
  chunksLoaded: number;
  tick: number;
  itemRegistrySize: number;
  /** Biome ids the server's own `biome_definition_list` named; `0` means it named none. */
  biomesNamed: number;
  /** Clientbound packets the deserializer rejected; the first thing to check when something silently does nothing. */
  undecodablePackets: number;
  /** The most recent decode complaint, verbatim. */
  lastUndecodablePacket: string | null;
  /** Commands the server announced via `available_commands`. */
  commandCount: number;
  /** Chunk payloads currently held, and therefore queryable block by block. */
  chunksTracked: number;
  /** Chunk payloads that decoded exactly; `chunksFailed` is a conformance signal. */
  chunksDecoded: number;
  chunksFailed: number;
  trackedEntities: number;
  trackedBlocks: number;
  knownPlayers: number;
  inventorySlots: number;
  selectedHotbarSlot: number | null;
  uptimeMs: number | null;
}

export interface NearbyEntity extends EntitySnapshot {
  distance: number;
}

export interface NearbyBlock {
  position: BlockPosition;
  blockRuntimeId: number;
  distance: number;
}

/**
 * The block at one coordinate and where the answer came from. `reported` (server
 * told us it changed) wins over `chunk` (decoded terrain), because the change is
 * newer than the terrain around it.
 */
export interface BlockQueryResult {
  position: BlockPosition;
  /** Network block id. `0` is air; ids are per-version hashes, not names. */
  blockRuntimeId: number;
  isAir: boolean;
  source: 'reported' | 'chunk';
  /** Chunk coordinates the answer came from, for `source: 'chunk'`. */
  chunkX?: number;
  chunkZ?: number;
}

/**
 * Result of a high-level action. `ok` = packets were handed to the transport;
 * `confirmed` = the server acknowledged with observable evidence (a block update, a
 * health bump, our chat echoed). Agents must check both: a write can succeed while
 * the server silently ignores it.
 */
export interface ActionResult {
  action: string;
  ok: boolean;
  confirmed: boolean;
  /** Human-readable description of the acknowledgement we waited for. */
  evidence: string;
  warnings: string[];
  elapsedMs: number;
  detail?: Record<string, unknown>;
}

export interface ScenarioStepResult {
  step: number;
  tool: string;
  ok: boolean;
  result: unknown;
  error?: string;
  elapsedMs: number;
}

export interface ScenarioAssertionResult {
  name: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
  message?: string;
}
