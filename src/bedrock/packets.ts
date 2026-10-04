import type { BlockPosition, Rotation, Vec3 } from '../types.js';
import { faceIndex, type BlockFace } from './vec3.js';

/**
 * Pure payload builders for every packet this project writes.
 *
 * `bedrock-protocol` is packet-level: it serialises whatever object you hand to
 * `client.write(name, params)` and nothing more, so the gap between "break this
 * block" and "these bytes go out" is this project's job.
 *
 * Field names and enum spellings come from `minecraft-data`'s ProtoDef schema for
 * the protocol pinned by the installed `bedrock-protocol` (see
 * `scripts/inspect-packets.ts`). Bedrock changes its protocol often, so these are
 * covered by serialisation tests that fail loudly when a field disappears. The
 * builders are intentionally dumb, which makes them unit-testable without a socket.
 */

export type OutgoingChatType = 'chat' | 'whisper' | 'announcement';

export interface TextPacketPayload {
  type: string;
  needs_translation: boolean;
  category: string;
  source_name: string;
  message: string;
  xuid: string;
  platform_chat_id: string;
  has_filtered_message: boolean;
  filtered_message: string;
  [key: string]: unknown;
}

/**
 * `text` is bidirectional and shape depends on `type`: `chat`/`whisper`/
 * `announcement` carry `source_name` + `message`, while `raw`/`tip`/`system` only
 * carry `message`. We always send the `chat` variant; `category: 'message_only'`
 * mirrors a plain player message (the alternative, `authored`, is for signed chat).
 */
export function buildChatPacket(options: { message: string; sourceName: string; type?: OutgoingChatType }): TextPacketPayload {
  return {
    type: options.type ?? 'chat',
    needs_translation: false,
    category: 'message_only',
    source_name: options.sourceName,
    message: options.message,
    xuid: '',
    platform_chat_id: '',
    has_filtered_message: false,
    filtered_message: '',
  };
}

/** `mode` decides how the server interprets the position we report. */
export type MoveMode = 'normal' | 'reset' | 'teleport' | 'rotation';

export type TeleportCause = 'unknown' | 'projectile' | 'chorus_fruit' | 'command' | 'behavior';

export interface MovePlayerPacketPayload {
  runtime_id: number;
  position: Vec3;
  pitch: number;
  yaw: number;
  head_yaw: number;
  mode: MoveMode;
  on_ground: boolean;
  ridden_runtime_id: number;
  tick: bigint;
  teleport?: { cause: TeleportCause; source_entity_type: number };
}

/**
 * `move_player` is how a client reports position, and also what the server sends
 * to correct a client, so listening to it confirms our own moves.
 *
 * There is no `player_auth_input` hard-teleport equivalent, so `mode: 'teleport'`
 * is how QA scripts force a position where the server allows it.
 */
export function buildMovePlayerPacket(options: {
  runtimeId: number;
  position: Vec3;
  rotation: Rotation;
  mode?: MoveMode;
  onGround?: boolean;
  riddenRuntimeId?: number;
  tick?: number;
}): MovePlayerPacketPayload {
  return {
    runtime_id: options.runtimeId,
    position: options.position,
    pitch: options.rotation.pitch,
    yaw: options.rotation.yaw,
    head_yaw: options.rotation.headYaw,
    mode: options.mode ?? 'normal',
    on_ground: options.onGround ?? true,
    ridden_runtime_id: options.riddenRuntimeId ?? 0,
    tick: BigInt(Math.max(0, Math.trunc(options.tick ?? 0))),
  };
}

export type InputData =
  | 'ascend'
  | 'descend'
  | 'north_jump'
  | 'jump_down'
  | 'sprint_down'
  | 'change_height'
  | 'jumping'
  | 'auto_jumping_in_water'
  | 'sneaking'
  | 'sneak_down'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'up_left'
  | 'up_right'
  | 'want_up'
  | 'want_down'
  | 'want_down_slow'
  | 'want_up_slow'
  | 'sprinting'
  | 'start_sprinting'
  | 'stop_sprinting'
  | 'start_sneaking'
  | 'stop_sneaking'
  | 'start_swimming'
  | 'stop_swimming'
  | 'start_jumping'
  | 'start_gliding'
  | 'stop_gliding'
  | 'item_interact'
  | 'block_action';

export type InputMode = 'mouse' | 'touch' | 'game_pad' | 'motion_controller';
export type PlayMode =
  'normal' | 'teaser' | 'screen' | 'viewer' | 'reality' | 'placement' | 'living_room' | 'exit_level' | 'exit_level_living_room';
export type InteractionModel = 'touch' | 'crosshair' | 'classic';

export interface PlayerAuthInputPacketPayload {
  pitch: number;
  yaw: number;
  position: Vec3;
  move_vector: { x: number; z: number };
  head_yaw: number;
  input_data: string[];
  input_mode: string;
  play_mode: string;
  interaction_model: string;
  interact_rotation: { x: number; z: number };
  tick: bigint;
  delta: Vec3;
  analogue_move_vector: { x: number; z: number };
  camera_orientation: Vec3;
  raw_move_vector: { x: number; z: number };
  item_stack_request?: unknown;
  block_action?: unknown;
  vehicle_rotation?: { x: number; z: number };
  predicted_vehicle?: bigint;
}

/**
 * Modern Bedrock movement packet. Since 1.19.30 the client reports its position
 * here every tick, with `move_player` reserved for teleports/resets. We send it
 * for every movement so servers that trust authoritative input see us move.
 */
export function buildPlayerAuthInputPacket(options: {
  position: Vec3;
  rotation: Rotation;
  tick: number;
  inputData?: InputData[];
  moveVector?: { x: number; z: number };
  delta?: Vec3;
  inputMode?: InputMode;
  playMode?: PlayMode;
  interactionModel?: InteractionModel;
}): PlayerAuthInputPacketPayload {
  const moveVector = options.moveVector ?? { x: 0, z: 0 };
  return {
    pitch: options.rotation.pitch,
    yaw: options.rotation.yaw,
    position: options.position,
    move_vector: moveVector,
    head_yaw: options.rotation.headYaw,
    input_data: options.inputData ?? [],
    input_mode: options.inputMode ?? 'mouse',
    play_mode: options.playMode ?? 'normal',
    interaction_model: options.interactionModel ?? 'crosshair',
    interact_rotation: { x: 0, z: 0 },
    tick: BigInt(Math.max(0, Math.trunc(options.tick))),
    delta: options.delta ?? { x: 0, y: 0, z: 0 },
    analogue_move_vector: moveVector,
    camera_orientation: { x: 0, y: 0, z: 0 },
    raw_move_vector: moveVector,
  };
}

/**
 * The subset of `Action` this project emits. The full enum also covers sleeping,
 * gliding, spin attacks and editor-only actions.
 */
export type PlayerAction =
  | 'start_break'
  | 'abort_break'
  | 'stop_break'
  | 'crack_break'
  | 'creative_player_destroy_block'
  | 'drop_item'
  | 'jump'
  | 'start_sprinting'
  | 'stop_sprinting'
  | 'start_sneaking'
  | 'stop_sneaking'
  | 'start_using_item'
  | 'respawn'
  | 'interact_block'
  | 'predict_break'
  | 'continue_break';

export interface PlayerActionPacketPayload {
  runtime_entity_id: bigint;
  action: string;
  position: BlockPosition;
  result_position: BlockPosition;
  face: number;
}

/**
 * `player_action` carries block breaking and movement modifiers. Breaking is a
 * two-step dance: `start_break` (optionally a stream of `crack_break`) then
 * `stop_break`, whose `result_position` is the block that actually broke. The
 * server acknowledges with `update_block`.
 */
export function buildPlayerActionPacket(options: {
  runtimeEntityId: number | bigint;
  action: PlayerAction;
  position: BlockPosition;
  resultPosition?: BlockPosition;
  face?: BlockFace | number;
}): PlayerActionPacketPayload {
  return {
    runtime_entity_id: BigInt(options.runtimeEntityId),
    action: options.action,
    position: options.position,
    result_position: options.resultPosition ?? options.position,
    face: typeof options.face === 'string' ? faceIndex(options.face) : (options.face ?? 0),
  };
}

/**
 * One item as the wire understands it. Items are `ItemV4` containers: a runtime
 * id, a little-endian u16 `count`, and an `extra` varint-length-prefixed blob
 * whose shape depends on whether the item holds NBT. An empty slot is an item
 * with `network_id: 0` and `count: 0`, not a missing field.
 */
export interface WireItem {
  network_id: number;
  count: number;
  metadata: number;
  has_stack_id: boolean;
  stack_id?: number;
  block_runtime_id: number;
  extra: {
    has_nbt: string;
    nbt?: { version: number; nbt: unknown };
    can_place_on: string[];
    can_destroy: string[];
  };
}

export function buildEmptyItem(): WireItem {
  return {
    network_id: 0,
    count: 0,
    metadata: 0,
    has_stack_id: false,
    block_runtime_id: 0,
    extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] },
  };
}

export function buildWireItem(options: {
  networkId: number;
  count?: number;
  metadata?: number;
  blockRuntimeId?: number;
  stackId?: number;
  extra?: WireItem['extra'];
}): WireItem {
  const item: WireItem = {
    network_id: options.networkId,
    count: options.count ?? 1,
    metadata: options.metadata ?? 0,
    has_stack_id: options.stackId !== undefined,
    block_runtime_id: options.blockRuntimeId ?? 0,
    extra: options.extra ?? { has_nbt: 'false', can_place_on: [], can_destroy: [] },
  };
  if (options.stackId !== undefined) item.stack_id = options.stackId;
  return item;
}

/** `transaction_type` of an `inventory_transaction`. */
export type TransactionType = 'normal' | 'inventory_mismatch' | 'item_use' | 'item_use_on_entity' | 'item_release';

export interface InventoryTransactionPayload {
  transaction: {
    legacy: { legacy_request_id: number; legacy_transactions: unknown[] };
    transaction_type: string;
    actions: unknown[];
    transaction_data?: unknown;
  };
}

/** Empty transaction envelope, for `normal` transactions and mismatches. */
export function buildInventoryTransaction(options?: {
  transactionType?: TransactionType;
  actions?: unknown[];
  transactionData?: unknown;
  legacyRequestId?: number;
}): InventoryTransactionPayload {
  const transaction: InventoryTransactionPayload['transaction'] = {
    legacy: { legacy_request_id: options?.legacyRequestId ?? 0, legacy_transactions: [] },
    transaction_type: options?.transactionType ?? 'normal',
    actions: options?.actions ?? [],
  };
  if (options?.transactionData !== undefined) transaction.transaction_data = options.transactionData;
  return { transaction };
}

/**
 * "Use the held item" — placing a block, using a bucket, eating, clicking air.
 * `trigger_type: 'player_input'` says the click came from the player rather than a
 * simulation tick. `block_position` is the block clicked; the new block appears on
 * `face` of it.
 */
export function buildItemUseOnBlockTransaction(options: {
  /** Block the player clicked, not the block that will appear. */
  blockPosition: BlockPosition;
  face: BlockFace;
  hotbarSlot: number;
  heldItem: WireItem;
  playerPosition: Vec3;
  /** Which block the server believes is at `blockPosition`, for validation. */
  blockRuntimeId?: number;
}): InventoryTransactionPayload {
  return buildInventoryTransaction({
    transactionType: 'item_use',
    transactionData: {
      action_type: 'click_block',
      trigger_type: 'player_input',
      block_position: options.blockPosition,
      face: faceIndex(options.face),
      hotbar_slot: options.hotbarSlot,
      hand: 'main_hand',
      held_item: options.heldItem,
      player_pos: options.playerPosition,
      click_pos: { x: 0.5, y: 0.5, z: 0.5 },
      block_runtime_id: options.blockRuntimeId ?? 0,
      client_prediction: 'success',
      client_cooldown_state: 'off',
    },
  });
}

/** Click air: used to start "using" an item with no target block. */
export function buildItemUseOnAirTransaction(options: {
  hotbarSlot: number;
  heldItem: WireItem;
  playerPosition: Vec3;
}): InventoryTransactionPayload {
  return buildInventoryTransaction({
    transactionType: 'item_use',
    transactionData: {
      action_type: 'click_air',
      trigger_type: 'player_input',
      block_position: { x: 0, y: 0, z: 0 },
      face: 0,
      hotbar_slot: options.hotbarSlot,
      hand: 'main_hand',
      held_item: options.heldItem,
      player_pos: options.playerPosition,
      click_pos: { x: 0, y: 0, z: 0 },
      block_runtime_id: 0,
      client_prediction: 'success',
      client_cooldown_state: 'off',
    },
  });
}

/**
 * "Use the held item on an entity": attacking, feeding, shearing, milking. This —
 * not `interact` — is what the vanilla client sends on hit or right-click;
 * `interact` only covers hovering, mounting and NPC dialogs.
 */
export function buildItemUseOnEntityTransaction(options: {
  entityRuntimeId: number;
  actionType: 'interact' | 'attack';
  hotbarSlot: number;
  heldItem: WireItem;
  playerPosition: Vec3;
}): InventoryTransactionPayload {
  return buildInventoryTransaction({
    transactionType: 'item_use_on_entity',
    transactionData: {
      entity_runtime_id: BigInt(options.entityRuntimeId),
      action_type: options.actionType,
      hotbar_slot: options.hotbarSlot,
      held_item: options.heldItem,
      player_pos: options.playerPosition,
      click_pos: { x: 0, y: 0.5, z: 0 },
    },
  });
}

/** Release or consume the item currently in use (bow, potion, food). */
export function buildItemReleaseTransaction(options: {
  actionType: 'release' | 'consume';
  hotbarSlot: number;
  heldItem: WireItem;
  headPosition: Vec3;
}): InventoryTransactionPayload {
  return buildInventoryTransaction({
    transactionType: 'item_release',
    transactionData: {
      action_type: options.actionType,
      hotbar_slot: options.hotbarSlot,
      held_item: options.heldItem,
      head_pos: options.headPosition,
    },
  });
}

/**
 * Dropping an item, expressed as a `normal` transaction whose source is
 * `world_interaction` and which replaces the stack with an empty one. There is no
 * dedicated "drop" packet.
 */
export function buildDropItemTransaction(options: { slot: number; windowId?: number; item: WireItem }): InventoryTransactionPayload {
  return buildInventoryTransaction({
    transactionType: 'normal',
    actions: [
      {
        source_type: 'world_interaction',
        window_id: options.windowId ?? 0,
        flags: 0,
        slot: options.slot,
        old_item: options.item,
        new_item: buildEmptyItem(),
      },
    ],
  });
}

/** Moves the held-item highlight. Slot 0 is the leftmost hotbar slot. */
export function buildPlayerHotbarPacket(options: { selectedSlot: number; windowId?: string; selectSlot?: boolean }): {
  selected_slot: number;
  window_id: string;
  select_slot: boolean;
} {
  return {
    selected_slot: options.selectedSlot,
    window_id: options.windowId ?? 'inventory',
    select_slot: options.selectSlot ?? true,
  };
}

/**
 * `interact` is narrow: leaving a vehicle, hovering an entity, opening an NPC
 * dialog, opening your inventory.
 */
export function buildInteractPacket(options: {
  actionId: 'leave_vehicle' | 'mouse_over_entity' | 'npc_open' | 'open_inventory';
  targetEntityId?: number;
  position?: Vec3;
}): {
  action_id: string;
  target_entity_id: bigint;
  has_position: boolean;
  position?: Vec3;
} {
  const payload: {
    action_id: string;
    target_entity_id: bigint;
    has_position: boolean;
    position?: Vec3;
  } = {
    action_id: options.actionId,
    target_entity_id: BigInt(options.targetEntityId ?? 0),
    has_position: options.position !== undefined,
  };
  if (options.position !== undefined) payload.position = options.position;
  return payload;
}

export function buildRequestChunkRadiusPacket(options: { chunkRadius: number; maxRadius?: number }): {
  chunk_radius: number;
  max_radius: number;
} {
  return {
    chunk_radius: options.chunkRadius,
    max_radius: options.maxRadius ?? 0,
  };
}

/**
 * Who the server attributes a command to. Bedrock spells these lower-case on the
 * wire. This project only sends `player`: an agent-player is indistinguishable
 * from a human typing, which is what QA wants.
 */
export type CommandOriginType =
  'player' | 'commandblock' | 'minecartcommandblock' | 'devconsole' | 'test' | 'automationplayer' | 'clientautomation';

export interface CommandOrigin {
  type: string;
  uuid: string;
  request_id: string;
  /**
   * The player's *unique* entity id (`start_game.entity_id`), which from 1.21.130
   * onwards is an unconditional `li64` — omitting it throws while serialising.
   */
  player_entity_id: bigint;
}

export interface CommandRequestPacketPayload {
  command: string;
  origin: CommandOrigin;
  internal: boolean;
  version: string;
}

/**
 * The `version` field every 1.26.x client must send.
 *
 * Documented as carrying no functionality, but its encoding changed: varint up to
 * 1.21.x, string from 1.21.130 on. A numeric-looking value on 1.26.x makes real
 * servers disconnect with a misleading `packet_violation_warning`, so `latest` is
 * what the library and vanilla client send.
 *
 * It is also the most interoperable: `latest` encodes as a length-prefixed 7-byte
 * string, so a reader that mistakes it for a little-endian int32 (some third-party
 * server forks do) consumes the first four bytes and leaves the rest unread rather
 * than running off the end. An empty string encodes as a single `0x00` and breaks
 * such a reader.
 */
export const COMMAND_REQUEST_VERSION = 'latest';

/**
 * `command_request` is the guaranteed way to run a server command: unlike a
 * `/`-prefixed line through `text`, it is specified to return output via
 * `command_output`.
 *
 * `uuid` + `request_id` are correlation keys echoed back in the reply, so a reply
 * can be matched to its request. The command line is passed through verbatim;
 * servers strip a leading `/` themselves.
 */
export function buildCommandRequestPacket(options: {
  command: string;
  uuid: string;
  requestId: string;
  /** Player unique entity id; 0 when the session has not learned it yet. */
  playerEntityId?: number | bigint;
  originType?: CommandOriginType;
  internal?: boolean;
  version?: string;
}): CommandRequestPacketPayload {
  return {
    command: options.command,
    origin: {
      type: options.originType ?? 'player',
      uuid: options.uuid,
      request_id: options.requestId,
      player_entity_id: BigInt(options.playerEntityId ?? 0),
    },
    internal: options.internal ?? false,
    version: options.version ?? COMMAND_REQUEST_VERSION,
  };
}

/**
 * Packets this project writes.
 *
 * An explicit list, not derived at runtime: the protocol data naming packets lives
 * in minecraft-data, a transitive dependency not depended on directly.
 * `npm run inspect:packets` verifies the list against the installed version.
 */
export const OUTGOING_PACKET_NAMES = [
  'animate',
  'client_cache_status',
  'command_request',
  'disconnect',
  'interact',
  'inventory_transaction',
  'move_player',
  'player_action',
  'player_auth_input',
  'player_hotbar',
  'request_chunk_radius',
  'set_local_player_as_initialized',
  'text',
] as const;

/** Incoming packets used as acknowledgements by `src/bedrock/actions.ts`. */
export const INCOMING_PACKET_NAMES = [
  'add_entity',
  'add_player',
  'available_commands',
  'change_dimension',
  'chunk_radius_update',
  'command_output',
  'correct_player_move_prediction',
  'death_info',
  'disconnect',
  'inventory_content',
  'inventory_slot',
  'item_registry',
  'level_chunk',
  'mob_equipment',
  'move_entity',
  'move_entity_delta',
  'move_player',
  'play_status',
  'player_list',
  'player_location',
  'remove_entity',
  'respawn',
  'set_entity_data',
  'set_health',
  'start_game',
  'text',
  'tick_sync',
  'update_block',
  'update_subchunk_blocks',
] as const;

/** Every packet name this project produces or reacts to, sorted and deduplicated. */
export const MODELLED_PACKET_NAMES: readonly string[] = Object.freeze(
  [...new Set<string>([...OUTGOING_PACKET_NAMES, ...INCOMING_PACKET_NAMES])].sort(),
);
