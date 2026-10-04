import type {
  BlockPosition,
  ChatKind,
  ChatMessage,
  CommandDescriptor,
  ConnectionState,
  Dimension,
  DomainEvent,
  EntitySnapshot,
  GameMode,
  ItemStack,
  PlayerListEntry,
  Rotation,
  Vec3,
} from '../types.js';
import { decodeChunkData, dimensionFromId, type DecodedChunk, type DecodedSubChunk } from './chunk.js';
import { blockCenter, blockKey, distance } from './vec3.js';

/**
 * Translation layer between raw Bedrock packets and the domain events agents
 * consume.
 *
 * `bedrock-protocol` emits one event per packet name with a ProtoDef-decoded
 * object full of protocol trivia (bigints, `lf32` floats, per-window containers,
 * numeric metadata keys). Each normalizer folds a packet into session state and
 * returns the events it produced; packets with no useful signal are swallowed so
 * they never reach an agent's context window. A normalizer is a pure function of
 * `(params, state)` apart from the state mutation, which keeps it cheap to test.
 */

/** Mutable view of a session that normalizers are allowed to touch. */
export interface MutableSessionState {
  /* connection / world */
  state: ConnectionState;
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
  serverAuthoritativeInventory: boolean;
  serverAuthoritativeBlockBreaking: boolean;
  chunkRadius: number | null;
  chunksLoaded: number;
  tick: number;
  lastTickAt: number | null;

  /* mirrors of server state */
  entities: Map<number, EntitySnapshot>;
  blocks: Map<string, { blockRuntimeId: number; layer: number; at: number }>;
  /** Upper bounds, injected from config so long sessions cannot grow unbounded. */
  maxTrackedEntities: number;
  maxTrackedBlocks: number;
  inventory: Map<string, Map<number, ItemStack>>;
  selectedHotbarSlot: number | null;
  itemNames: Map<number, string>;
  /**
   * Biome ids the server named, from `biome_definition_list`. A chunk's biome id
   * is only meaningful against the list the same server announced.
   */
  biomes: Map<number, string>;
  playerNames: Map<number, string>;
  playerList: Map<string, PlayerListEntry>;
  /**
   * Command catalogue from `available_commands`, keyed by lower-cased name. The
   * packet is a full snapshot, so this map is rebuilt on every one.
   */
  commands: Map<string, CommandDescriptor>;

  /**
   * Decoded terrain, keyed `"chunkX,chunkZ"`, so queries can answer for blocks the
   * server never mentioned. Bounded by `maxTrackedChunks` (least recently decoded
   * evicted first).
   */
  chunks: Map<string, TrackedChunk>;
  maxTrackedChunks: number;
  /** Payloads that decoded exactly. */
  chunksDecoded: number;
  /** Payloads that did not: a statement about the server, counted deliberately. */
  chunksFailed: number;
}

/** One chunk of decoded terrain, plus the lookup its queries need. */
export interface TrackedChunk {
  chunkX: number;
  chunkZ: number;
  dimension: Dimension;
  decoded: DecodedChunk;
  /** Sub-chunk by vertical slice index, so a Y lookup does not scan the list. */
  slices: Map<number, DecodedSubChunk>;
  /** When we decoded it, for cache eviction. */
  at: number;
}

export function chunkKey(chunkX: number, chunkZ: number): string {
  return `${String(chunkX)},${String(chunkZ)}`;
}

/** Receives a decoded packet plus live state, updates the state and returns events. */
export type PacketNormalizer = (params: Record<string, unknown>, state: MutableSessionState) => DomainEvent[];

/**
 * Protocol default for a biome definition id ("no id given"): `biome_id` is a
 * `lu16`, so an unfilled definition reads back as `65535`.
 */
const UNKNOWN_BIOME_ID = 0xffff;

/**
 * ProtoDef decodes 64-bit integers as `bigint`; the domain layer uses plain
 * `number`, so all widening funnels through here.
 */
export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

export function toStringValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return fallback;
}

function toVec3(value: unknown): Vec3 {
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    x: toNumber(record.x),
    y: toNumber(record.y),
    z: toNumber(record.z),
  };
}

function toBlockPosition(value: unknown): BlockPosition {
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    x: Math.trunc(toNumber(record.x)),
    y: Math.trunc(toNumber(record.y)),
    z: Math.trunc(toNumber(record.z)),
  };
}

function toRotation(params: Record<string, unknown>): Rotation {
  // `move_player` carries flat pitch/yaw/head_yaw, `move_entity` nests them in a
  // `rotation` container. Support both so one helper covers every packet.
  const nested = (params.rotation ?? {}) as Record<string, unknown>;
  const yaw = toNumber(params.yaw ?? nested.yaw);
  const pitch = toNumber(params.pitch ?? nested.pitch);
  const headYaw = toNumber(params.head_yaw ?? nested.head_yaw ?? yaw, yaw);
  return { yaw, pitch, headYaw };
}

function toGameMode(value: unknown): GameMode {
  const raw = toStringValue(value, 'unknown');
  switch (raw) {
    case 'survival':
    case 'creative':
    case 'adventure':
    case 'spectator':
      return raw;
    case 'survival_spectator':
    case 'creative_spectator':
      return 'spectator';
    default:
      return 'unknown';
  }
}

function toDimension(value: unknown): Dimension {
  // `start_game` sends a named mapper; `change_dimension` and `level_chunk` send
  // a bare numeric id. Both have to land on the same domain type.
  if (typeof value === 'number' || typeof value === 'bigint') return dimensionFromId(Number(value));
  const raw = toStringValue(value, 'unknown');
  if (raw === 'overworld' || raw === 'nether' || raw === 'end') return raw;
  return 'unknown';
}

/** Angle values arrive as `byterot` (degrees/1.4-ish quantised floats). */
function normalizeRotationValue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value;
}

const CHAT_KIND_BY_PACKET_TYPE: Record<string, ChatKind> = {
  chat: 'chat',
  whisper: 'whisper',
  announcement: 'announcement',
  system: 'system',
  raw: 'raw',
  tip: 'tip',
  json: 'json',
  json_whisper: 'json_whisper',
  json_announcement: 'json_announcement',
  popup: 'popup',
  jukebox_popup: 'jukebox_popup',
  translation: 'system',
};

const onStartGame: PacketNormalizer = (params, state) => {
  const position = toVec3(params.player_position);
  const rotation = {
    x: toNumber((params.rotation as Record<string, unknown>)?.x),
    z: toNumber((params.rotation as Record<string, unknown>)?.z),
  };

  state.entityId = toStringValue(params.entity_id, '');
  state.runtimeEntityId = toNumber(params.runtime_entity_id);
  state.position = position;
  // `start_game.rotation` is a vec2f where x = yaw and z = pitch.
  state.rotation = { yaw: rotation.x, pitch: rotation.z, headYaw: rotation.x };
  state.gameMode = toGameMode(params.player_gamemode);
  state.dimension = toDimension(params.dimension);
  state.worldName = toStringValue(params.world_name, '');
  state.serverVersion = toStringValue(params.game_version, '');
  state.permissionLevel = toStringValue(params.permission_level, '');
  state.serverAuthoritativeInventory = params.server_authoritative_inventory === true;
  state.serverAuthoritativeBlockBreaking = params.server_authoritative_block_breaking === true;
  state.health = null;
  state.isAlive = true;

  return [
    {
      type: 'session_started',
      at: Date.now(),
      entityId: state.entityId ?? '',
      runtimeEntityId: state.runtimeEntityId ?? 0,
      gameMode: state.gameMode,
      dimension: state.dimension,
      position,
      rotation: state.rotation,
      worldName: state.worldName ?? '',
      serverVersion: state.serverVersion ?? '',
      permissionLevel: state.permissionLevel ?? undefined,
      serverAuthoritativeInventory: state.serverAuthoritativeInventory,
      serverAuthoritativeBlockBreaking: state.serverAuthoritativeBlockBreaking,
    },
  ];
};

const onText: PacketNormalizer = (params, state) => {
  const packetType = toStringValue(params.type, 'raw');
  const kind = CHAT_KIND_BY_PACKET_TYPE[packetType] ?? 'raw';
  const message = toStringValue(params.message, '');
  const source = toStringValue(params.source_name, '');
  const chat: ChatMessage = {
    kind: kind === 'json' || kind === 'json_whisper' || kind === 'json_announcement' ? 'json_announcement' : kind,
    source,
    // `json` message bodies still contain the raw JSON string; keep it verbatim
    // rather than guessing a translation, so agents can decide.
    message,
    at: Date.now(),
    fromSelf: source !== '' && source === state.playerNames.get(state.runtimeEntityId ?? -1),
  };
  return [{ type: 'chat', at: chat.at, chat }];
};

const onPlayStatus: PacketNormalizer = (params) => {
  const status = toStringValue(params.status, 'unknown');
  if (status === 'player_spawn') {
    return [{ type: 'spawned', at: Date.now(), runtimeEntityId: 0 }];
  }
  return [];
};

const onSetHealth: PacketNormalizer = (params, state) => {
  const health = toNumber(params.health, -1);
  const previousHealth = state.health;
  state.health = health;
  state.isAlive = health > 0;
  return [{ type: 'health_changed', at: Date.now(), health, previousHealth }];
};

const onRespawn: PacketNormalizer = (params, state) => {
  const position = toVec3(params.position);
  state.position = position;
  state.isAlive = true;
  if (state.health !== null && state.health <= 0) state.health = 1;
  return [
    {
      type: 'position_updated',
      at: Date.now(),
      position,
      rotation: state.rotation ?? { yaw: 0, pitch: 0, headYaw: 0 },
      onGround: state.onGround ?? false,
      source: 'respawn',
    },
  ];
};

const onMovePlayer: PacketNormalizer = (params, state) => {
  const position = toVec3(params.position);
  const rotation = toRotation(params);
  const onGround = params.on_ground === true;
  const mode = toStringValue(params.mode, 'normal');
  // The server sends `move_player` to correct or teleport us; when our own
  // runtime id comes back it is the acknowledgement of a move we requested.
  const isSelf = toNumber(params.runtime_id, -1) === (state.runtimeEntityId ?? -1);
  const source = mode === 'teleport' ? 'teleport' : isSelf ? 'server_correction' : 'server_move';
  state.position = position;
  state.rotation = rotation;
  state.onGround = onGround;
  return [{ type: 'position_updated', at: Date.now(), position, rotation, onGround, source }];
};

const onCorrectPlayerMovePrediction: PacketNormalizer = (params, state) => {
  const position = toVec3(params.position);
  state.position = position;
  state.tick = toNumber(params.tick, state.tick);
  return [
    {
      type: 'position_updated',
      at: Date.now(),
      position,
      rotation: state.rotation ?? { yaw: 0, pitch: 0, headYaw: 0 },
      onGround: params.on_ground === true,
      source: 'server_correction',
    },
  ];
};

const onPlayerLocation: PacketNormalizer = (params, state) => {
  const isSelf = toNumber(params.entity_unique_id, -1) === Number(state.entityId ?? -1);
  if (!isSelf) return [];
  const position = toVec3(params.position);
  state.position = position;
  return [
    {
      type: 'position_updated',
      at: Date.now(),
      position,
      rotation: state.rotation ?? { yaw: 0, pitch: 0, headYaw: 0 },
      onGround: state.onGround ?? false,
      source: 'server_move',
    },
  ];
};

const onAddEntity: PacketNormalizer = (params, state) => {
  const runtimeId = toNumber(params.runtime_id);
  const position = toVec3(params.position);
  const velocity = toVec3(params.velocity);
  const rotation = toRotation(params);
  const now = Date.now();
  const entity: EntitySnapshot = {
    runtimeId,
    uniqueId: toNumber(params.unique_id),
    type: toStringValue(params.entity_type, 'unknown'),
    position,
    velocity,
    yaw: rotation.yaw,
    pitch: rotation.pitch,
    headYaw: rotation.headYaw,
    isPlayer: false,
    spawnedAt: now,
    lastSeenAt: now,
  };
  trackEntity(state, entity);
  return [{ type: 'entity_spawned', at: now, entity }];
};

const onAddPlayer: PacketNormalizer = (params, state) => {
  const runtimeId = toNumber(params.runtime_id);
  const now = Date.now();
  const username = toStringValue(params.username, '');
  const entity: EntitySnapshot = {
    runtimeId,
    uniqueId: toNumber(params.unique_id),
    type: 'minecraft:player',
    position: toVec3(params.position),
    velocity: toVec3(params.velocity),
    yaw: toNumber(params.yaw),
    pitch: toNumber(params.pitch),
    headYaw: toNumber(params.head_yaw),
    isPlayer: true,
    username,
    spawnedAt: now,
    lastSeenAt: now,
  };
  trackEntity(state, entity);
  // Player display names arrive with the entity, which is how we recognise our
  // own chat messages later without needing the player list.
  if (username !== '') state.playerNames.set(runtimeId, username);
  return [{ type: 'entity_spawned', at: now, entity }];
};

const onRemoveEntity: PacketNormalizer = (params, state) => {
  const runtimeId = toNumber(params.entity_id_self);
  const existing = state.entities.get(runtimeId);
  state.entities.delete(runtimeId);
  state.playerNames.delete(runtimeId);
  return [
    {
      type: 'entity_removed',
      at: Date.now(),
      runtimeId,
      entityType: existing?.type,
    },
  ];
};

const onMoveEntity: PacketNormalizer = (params, state) => {
  const runtimeId = toNumber(params.runtime_entity_id);
  const position = toVec3(params.position);
  const rotation = toRotation(params);
  const existing = state.entities.get(runtimeId);
  if (existing === undefined) return [];
  existing.position = position;
  existing.yaw = rotation.yaw;
  existing.pitch = rotation.pitch;
  existing.headYaw = rotation.headYaw;
  existing.lastSeenAt = Date.now();
  return [{ type: 'entity_moved', at: Date.now(), runtimeId, position }];
};

/**
 * `move_entity_delta` sends only the axes that changed, as an optional float
 * each. A missing axis means "unchanged", not "zero".
 */
const onMoveEntityDelta: PacketNormalizer = (params, state) => {
  const runtimeId = toNumber(params.runtime_entity_id);
  const existing = state.entities.get(runtimeId);
  if (existing === undefined) return [];

  const position: Vec3 = {
    x: typeof params.x === 'number' ? params.x : existing.position.x,
    y: typeof params.y === 'number' ? params.y : existing.position.y,
    z: typeof params.z === 'number' ? params.z : existing.position.z,
  };
  existing.position = position;
  existing.lastSeenAt = Date.now();
  return [{ type: 'entity_moved', at: Date.now(), runtimeId, position }];
};

const onSetEntityData: PacketNormalizer = (params, state) => {
  const runtimeId = toNumber(params.runtime_entity_id);
  const entries = Array.isArray(params.metadata) ? params.metadata : [];
  const metadata: Record<string, unknown> = {};
  for (const entry of entries) {
    const record = (entry ?? {}) as Record<string, unknown>;
    const key = toStringValue(record.key, '');
    if (key !== '') metadata[key] = record.value;
  }
  if (Object.keys(metadata).length === 0) return [];

  const existing = state.entities.get(runtimeId);
  if (existing !== undefined) {
    existing.lastSeenAt = Date.now();
    const nametag = metadata['nametag'];
    if (typeof nametag === 'string' && nametag !== '') existing.username = nametag;
  }
  return [{ type: 'entity_metadata', at: Date.now(), runtimeId, metadata }];
};

const onUpdateBlock: PacketNormalizer = (params, state) => {
  const position = toBlockPosition(params.position);
  const blockRuntimeId = toNumber(params.block_runtime_id);
  const layer = toNumber(params.layer);
  // `flags` is a bitflag set; we only record that the server asserted a change.
  state.blocks.set(blockKey(position), { blockRuntimeId, layer, at: Date.now() });
  evictOldest(state.blocks, state.maxTrackedBlocks);
  return [{ type: 'block_updated', at: Date.now(), position, blockRuntimeId, layer }];
};

const onUpdateSubchunkBlocks: PacketNormalizer = (params, state) => {
  const events: DomainEvent[] = [];
  for (const bucket of ['blocks', 'extra']) {
    const list = params[bucket];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const record = (raw ?? {}) as Record<string, unknown>;
      const position = toBlockPosition(record.position);
      const blockRuntimeId = toNumber(record.runtime_id);
      state.blocks.set(blockKey(position), { blockRuntimeId, layer: 0, at: Date.now() });
      events.push({ type: 'block_updated', at: Date.now(), position, blockRuntimeId, layer: 0 });
    }
  }
  evictOldest(state.blocks, state.maxTrackedBlocks);
  return events;
};

const onInventoryContent: PacketNormalizer = (params, state) => {
  const containerId = toStringValue(params.window_id, 'inventory');
  const items = Array.isArray(params.input) ? params.input : [];
  const slots = new Map<number, ItemStack>();
  items.forEach((raw, index) => {
    const item = toItemStack(raw, index, state);
    if (item !== null) slots.set(index, item);
  });
  state.inventory.set(containerId, slots);
  return [
    {
      type: 'inventory_updated',
      at: Date.now(),
      containerId,
      slotCount: slots.size,
    },
  ];
};

const onInventorySlot: PacketNormalizer = (params, state) => {
  const containerId = toStringValue(params.window_id, 'inventory');
  const slot = toNumber(params.slot);
  const item = toItemStack(params.item, slot, state);
  const container = state.inventory.get(containerId) ?? new Map<number, ItemStack>();
  if (item === null) container.delete(slot);
  else container.set(slot, item);
  state.inventory.set(containerId, container);
  return [{ type: 'inventory_slot', at: Date.now(), containerId, slot, item }];
};

const onMobEquipment: PacketNormalizer = (params, state) => {
  const runtimeId = toNumber(params.runtime_entity_id);
  const selectedSlot = toNumber(params.selected_slot);
  const isSelf = runtimeId === (state.runtimeEntityId ?? -1);
  if (isSelf) state.selectedHotbarSlot = selectedSlot;
  return [];
};

const onChangeDimension: PacketNormalizer = (params, state) => {
  const dimension = toDimension(params.dimension);
  const position = toVec3(params.position);
  state.dimension = dimension;
  state.position = position;
  // A dimension change invalidates our block cache: same coordinates, different
  // world.
  state.blocks.clear();
  state.entities.clear();
  return [{ type: 'dimension_changed', at: Date.now(), dimension, position }];
};

const onPlayerList: PacketNormalizer = (params, state) => {
  const records = Array.isArray(params.records) ? params.records : [];
  const added: PlayerListEntry[] = [];
  const removed: string[] = [];
  for (const raw of records) {
    const record = (raw ?? {}) as Record<string, unknown>;
    const uuid = toStringValue(record.uuid, '');
    if (record.type === 'remove') {
      state.playerList.delete(uuid);
      removed.push(uuid);
      continue;
    }
    const entry: PlayerListEntry = {
      uuid,
      username: toStringValue(record.username, ''),
      entityUniqueId: toNumber(record.entity_unique_id, Number.NaN),
      xuid: toStringValue(record.xbox_user_id, ''),
    };
    state.playerList.set(uuid, entry);
    added.push(entry);
  }
  if (added.length === 0 && removed.length === 0) return [];
  return [{ type: 'player_list', at: Date.now(), added, removed }];
};

const onLevelChunk: PacketNormalizer = (params, state) => {
  const x = toNumber(params.x);
  const z = toNumber(params.z);
  const dimension = toDimension(params.dimension);
  const subChunkCount = toNumber(params.sub_chunk_count);
  state.chunksLoaded += 1;

  // Keep the decoded column (not just a count) so queries can answer for blocks
  // the server never explicitly mentioned.
  const bytes = toBytes(params.payload ?? params.data);
  let decoded: DecodedChunk | null = null;
  let decodeError: string | undefined;
  if (bytes === null) {
    decodeError = 'chunk payload was not a byte buffer';
  } else {
    const result = decodeChunkData(bytes, { subChunkCount, dimension });
    if (result.error !== null) {
      decodeError = result.error;
    } else if (!result.consistent) {
      // Reading stopped before the end: blocks are usable but the shape is wrong,
      // so do not cache it.
      decodeError = `payload did not end where the format says (${String(result.leftoverBytes)} byte(s) left over)`;
    } else {
      decoded = result;
    }
  }

  if (decoded === null) {
    state.chunksFailed += 1;
  } else {
    state.chunksDecoded += 1;
    state.chunks.set(chunkKey(x, z), {
      chunkX: x,
      chunkZ: z,
      dimension,
      decoded,
      slices: new Map(decoded.subChunks.map((subChunk) => [subChunk.index, subChunk])),
      at: Date.now(),
    });
    evictFarthestChunk(state.chunks, state.maxTrackedChunks, state.position);
  }

  return [
    {
      type: 'chunk_loaded',
      at: Date.now(),
      x,
      z,
      dimension,
      chunksLoaded: state.chunksLoaded,
      decoded: decoded !== null,
      ...(decodeError === undefined ? {} : { decodeError }),
    },
  ];
};

const onChunkRadiusUpdate: PacketNormalizer = (params, state) => {
  const chunkRadius = toNumber(params.chunk_radius);
  state.chunkRadius = chunkRadius;
  return [{ type: 'chunk_radius_accepted', at: Date.now(), chunkRadius }];
};

const onTickSync: PacketNormalizer = (params, state) => {
  const tick = toNumber(params.response_time ?? params.request_time, state.tick);
  state.tick = tick;
  state.lastTickAt = Date.now();
  return [{ type: 'heartbeat', at: Date.now(), tick }];
};

/**
 * `biome_definition_list` is the server's biome catalogue.
 *
 * Each definition's `name_index` points into the packet's `string_list` and
 * carries a `biome_id`. The id is optional in practice: some servers leave it at
 * the protocol default (`65535`) because their vanilla JSON has no per-biome id.
 * Such a definition is counted but not mapped — naming an id the server never
 * attached would be a confident lie.
 */
const onBiomeDefinitionList: PacketNormalizer = (params, state) => {
  const rawDefinitions = Array.isArray(params.biome_definitions) ? params.biome_definitions : [];
  const rawStrings = Array.isArray(params.string_list) ? params.string_list : [];
  const strings = rawStrings.map((value) => toStringValue(value, ''));

  state.biomes.clear();
  let namedCount = 0;
  for (const raw of rawDefinitions) {
    const record = (raw ?? {}) as Record<string, unknown>;
    const id = toNumber(record.biome_id, UNKNOWN_BIOME_ID);
    const nameIndex = toNumber(record.name_index, -1);
    const name = nameIndex >= 0 && nameIndex < strings.length ? (strings[nameIndex] ?? '') : '';
    if (id === UNKNOWN_BIOME_ID || name === '') continue;
    state.biomes.set(id, name);
    namedCount += 1;
  }

  return [{ type: 'biome_definitions', at: Date.now(), definitionCount: rawDefinitions.length, namedCount }];
};

const onItemRegistry: PacketNormalizer = (params, state) => {
  const itemstates = Array.isArray(params.itemstates) ? params.itemstates : [];
  for (const raw of itemstates) {
    const record = (raw ?? {}) as Record<string, unknown>;
    const runtimeId = toNumber(record.runtime_id, -1);
    const name = toStringValue(record.name, '');
    if (runtimeId >= 0 && name !== '') state.itemNames.set(runtimeId, name);
  }
  return [{ type: 'item_registry', at: Date.now(), itemCount: state.itemNames.size }];
};

/**
 * `available_commands` carries the server's full command catalogue: names,
 * descriptions, permissions and argument patterns.
 *
 * Protocol notes: `alias` indexes the packet's `enums` array (not the flat
 * `enum_values` pool), and each of those enums indexes into `enum_values` — a
 * two-hop, bounds-checked lookup because servers get it wrong often.
 * `value_type`/`enum_type` are partial mappers, so an uncovered code is shown
 * verbatim rather than guessed. The packet is a full snapshot, so the map is
 * replaced, never merged.
 */
const onAvailableCommands: PacketNormalizer = (params, state) => {
  const rawCommands = Array.isArray(params.command_data) ? params.command_data : [];
  const enums = Array.isArray(params.enums) ? params.enums : [];
  const enumValues = Array.isArray(params.enum_values) ? params.enum_values : [];

  state.commands.clear();
  for (const raw of rawCommands) {
    const record = (raw ?? {}) as Record<string, unknown>;
    const name = toStringValue(record.name, '');
    if (name === '') continue;
    const descriptor: CommandDescriptor = {
      name,
      description: toStringValue(record.description, ''),
      permissionLevel: toStringValue(record.permission_level, ''),
      aliases: resolveCommandAliases(record.alias, enums, enumValues),
      overloads: renderCommandOverloads(record.overloads),
      flags: toNumber(record.flags),
    };
    state.commands.set(name.toLowerCase(), descriptor);
  }

  return [{ type: 'commands_available', at: Date.now(), commandCount: state.commands.size }];
};

/**
 * `command_output` is the server's reply to a `command_request`. The origin
 * (`uuid` + `request_id`) is echoed so an action can correlate the reply with its
 * own request; each output entry's `message_id` is really the message text.
 */
const onCommandOutput: PacketNormalizer = (params) => {
  const origin = (params.origin ?? {}) as Record<string, unknown>;
  const rawOutput = Array.isArray(params.output) ? params.output : [];
  const messages = rawOutput.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const parameters = Array.isArray(record.parameters) ? record.parameters.map((value) => toStringValue(value, '')) : [];
    return {
      message: toStringValue(record.message_id ?? record.message, ''),
      success: record.success === true,
      parameters,
    };
  });
  return [
    {
      type: 'command_executed',
      at: Date.now(),
      requestId: toStringValue(origin.request_id, ''),
      uuid: toStringValue(origin.uuid, ''),
      originType: toStringValue(origin.type, ''),
      outputType: toStringValue(params.output_type, ''),
      successCount: toNumber(params.success_count),
      messages,
      hasData: params.has_data === true,
      data: toStringValue(params.data, ''),
    },
  ];
};

const onDeathInfo: PacketNormalizer = (params, state) => {
  state.isAlive = false;
  return [
    {
      type: 'death',
      at: Date.now(),
      cause: toStringValue(params.cause, ''),
      position: state.position ?? undefined,
    },
  ];
};

/**
 * Packet name → normalizer. Unmapped packets still reach `client.on('packet')`
 * but never become domain events.
 */
export const PACKET_NORMALIZERS: Readonly<Record<string, PacketNormalizer>> = {
  start_game: onStartGame,
  text: onText,
  play_status: onPlayStatus,
  set_health: onSetHealth,
  respawn: onRespawn,
  move_player: onMovePlayer,
  correct_player_move_prediction: onCorrectPlayerMovePrediction,
  player_location: onPlayerLocation,
  add_entity: onAddEntity,
  add_player: onAddPlayer,
  remove_entity: onRemoveEntity,
  move_entity: onMoveEntity,
  move_entity_delta: onMoveEntityDelta,
  set_entity_data: onSetEntityData,
  update_block: onUpdateBlock,
  update_subchunk_blocks: onUpdateSubchunkBlocks,
  inventory_content: onInventoryContent,
  inventory_slot: onInventorySlot,
  mob_equipment: onMobEquipment,
  change_dimension: onChangeDimension,
  player_list: onPlayerList,
  level_chunk: onLevelChunk,
  chunk_radius_update: onChunkRadiusUpdate,
  tick_sync: onTickSync,
  item_registry: onItemRegistry,
  biome_definition_list: onBiomeDefinitionList,
  available_commands: onAvailableCommands,
  command_output: onCommandOutput,
  death_info: onDeathInfo,
};

/** Feeds one decoded packet through the registry; an unknown packet yields none. */
export function normalizePacket(packetName: string, params: Record<string, unknown>, state: MutableSessionState): DomainEvent[] {
  const normalizer = PACKET_NORMALIZERS[packetName];
  if (normalizer === undefined) return [];
  try {
    return normalizer(params, state);
  } catch {
    // Protocol drift is expected; dropping a packet always beats dropping the
    // connection.
    return [];
  }
}

function toItemStack(raw: unknown, slot: number, state: MutableSessionState): ItemStack | null {
  const record = (raw ?? {}) as Record<string, unknown>;
  const networkId = toNumber(record.network_id);
  const count = toNumber(record.count);
  if (networkId === 0 || count === 0) return null;
  const stackId = toNumber(record.stack_id, Number.NaN);
  const item: ItemStack = {
    slot,
    networkId,
    count,
    metadata: toNumber(record.metadata),
    blockRuntimeId: toNumber(record.block_runtime_id),
    extra: record.extra,
  };
  if (Number.isFinite(stackId)) item.stackId = stackId;
  const name = state.itemNames.get(networkId);
  if (name !== undefined) item.name = name;
  return item;
}

/** Adds an entity, evicting the least recently seen when over budget. */
function trackEntity(state: MutableSessionState, entity: EntitySnapshot): void {
  state.entities.set(entity.runtimeId, entity);
  const limit = state.maxTrackedEntities;
  while (state.entities.size > limit) {
    let oldestId: number | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, candidate] of state.entities) {
      if (candidate.lastSeenAt < oldestAt) {
        oldestAt = candidate.lastSeenAt;
        oldestId = id;
      }
    }
    if (oldestId === null) return;
    state.entities.delete(oldestId);
    state.playerNames.delete(oldestId);
  }
}

/**
 * Resolves a command's `alias` into strings. Two bounds-checked hops: `alias`
 * indexes `enums`, then that enum's `values` index the `enum_values` pool. A bad
 * index costs an empty list, never the catalogue.
 */
function resolveCommandAliases(rawAlias: unknown, enums: unknown[], enumValues: unknown[]): string[] {
  const enumIndex = toNumber(rawAlias, -1);
  if (enumIndex < 0 || enumIndex >= enums.length) return [];
  const record = (enums[enumIndex] ?? {}) as Record<string, unknown>;
  const values = Array.isArray(record.values) ? record.values : [];
  const aliases: string[] = [];
  for (const value of values) {
    const poolIndex = toNumber(value, -1);
    if (poolIndex < 0 || poolIndex >= enumValues.length) continue;
    const alias = enumValues[poolIndex];
    if (typeof alias === 'string' && alias !== '') aliases.push(alias);
  }
  return aliases;
}

/**
 * Renders a command's argument patterns, e.g. `player:target level:int?`.
 *
 * `value_type` is mapped only for common kinds, so an unmapped code is shown as a
 * bare number rather than guessed at. `enum_type` overrides: a parameter
 * constrained to an enum is typed `enum` whatever the underlying values look like.
 */
function renderCommandOverloads(rawOverloads: unknown): string[] {
  if (!Array.isArray(rawOverloads)) return [];
  const signatures: string[] = [];
  for (const rawOverload of rawOverloads) {
    const overload = (rawOverload ?? {}) as Record<string, unknown>;
    const parameters = Array.isArray(overload.parameters) ? overload.parameters : [];
    const rendered = parameters.map((rawParameter) => {
      const parameter = (rawParameter ?? {}) as Record<string, unknown>;
      const name = toStringValue(parameter.parameter_name, '?');
      const enumType = toStringValue(parameter.enum_type, '');
      const isEnum = enumType === 'enum' || enumType === 'soft_enum' || enumType === 'suffixed';
      const valueType = parameter.value_type;
      const type = isEnum ? 'enum' : typeof valueType === 'string' ? valueType : String(toNumber(valueType, -1));
      return `${name}:${type}${parameter.optional === true ? '?' : ''}`;
    });
    signatures.push(rendered.join(' '));
  }
  return signatures;
}

/**
 * Narrows a payload field to bytes. Buffers arrive as `Uint8Array` or a plain
 * array of numbers depending on the codec path, so both are accepted.
 */
function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  return null;
}

/** Keeps a per-session cache bounded: least-recently-touched entries go first. */
function evictOldest<T extends { at: number }>(entries: Map<string, T>, maxEntries: number): void {
  if (entries.size <= maxEntries) return;
  const sorted = [...entries.entries()].sort((a, b) => a[1].at - b[1].at);
  const excess = entries.size - maxEntries;
  for (let index = 0; index < excess; index += 1) {
    const entry = sorted[index];
    if (entry === undefined) break;
    entries.delete(entry[0]);
  }
}

/**
 * Bounds the terrain cache by distance from the player, not age: a server streams
 * its whole view radius in one burst, so "oldest" carries no information and would
 * evict the neighbourhood while keeping a far-away tail. Farthest chunks go first
 * (ties by age); without a position, falls back to `evictOldest`.
 */
function evictFarthestChunk(chunks: Map<string, TrackedChunk>, maxEntries: number, position: Vec3 | null): void {
  if (chunks.size <= maxEntries) return;
  if (position === null) {
    evictOldest(chunks, maxEntries);
    return;
  }
  const playerChunkX = Math.floor(position.x / 16);
  const playerChunkZ = Math.floor(position.z / 16);
  const sorted = [...chunks.entries()].sort((a, b) => {
    const distanceA = (a[1].chunkX - playerChunkX) ** 2 + (a[1].chunkZ - playerChunkZ) ** 2;
    const distanceB = (b[1].chunkX - playerChunkX) ** 2 + (b[1].chunkZ - playerChunkZ) ** 2;
    // Farthest first; equal distance drops the older decode.
    return distanceB - distanceA || a[1].at - b[1].at;
  });
  const excess = chunks.size - maxEntries;
  for (let index = 0; index < excess; index += 1) {
    const entry = sorted[index];
    if (entry === undefined) break;
    chunks.delete(entry[0]);
  }
}

/** Distance helper re-exported so MCP tools can sort entities without importing vec3. */
export function entityDistance(entity: EntitySnapshot, from: Vec3): number {
  return distance(entity.position, from);
}

/** Centre of a block, used when a caller asks to walk to a block rather than a point. */
export function blockToPosition(block: BlockPosition): Vec3 {
  return blockCenter(block);
}

export { normalizeRotationValue };
