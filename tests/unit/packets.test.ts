import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import {
  buildChatPacket,
  buildCommandRequestPacket,
  buildDropItemTransaction,
  buildEmptyItem,
  buildInteractPacket,
  buildItemReleaseTransaction,
  buildItemUseOnAirTransaction,
  buildItemUseOnBlockTransaction,
  buildItemUseOnEntityTransaction,
  buildMovePlayerPacket,
  buildPlayerActionPacket,
  buildPlayerAuthInputPacket,
  buildPlayerHotbarPacket,
  buildRequestChunkRadiusPacket,
  buildWireItem,
  MODELLED_PACKET_NAMES,
  OUTGOING_PACKET_NAMES,
} from '../../src/bedrock/packets.js';

/**
 * The protocol contract test.
 *
 * Bedrock's packet/field/enum names change between game releases and
 * `bedrock-protocol` tracks the game, so a rename would not fail at type-check time
 * — only at runtime. Every payload this project builds is therefore serialised
 * through the installed library's own serialiser; a rename fails here and points at
 * the offending builder.
 *
 * Requiring a private subpath of `bedrock-protocol` is deliberate: reaching into the
 * library is what makes this a real contract check, and it is confined to tests.
 */

const require = createRequire(import.meta.url);
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer') as {
  createSerializer: (version: string) => { createPacketBuffer: (packet: { name: string; params: object }) => Buffer };
  createDeserializer: (version: string) => {
    parsePacketBuffer: (buffer: Buffer) => { data: { name: string; params: Record<string, unknown> } };
  };
};
const { CURRENT_VERSION } = require('bedrock-protocol/src/options.js') as { CURRENT_VERSION: string };

const serializer = createSerializer(CURRENT_VERSION);
const deserializer = createDeserializer(CURRENT_VERSION);

/** Serialises a payload, asserting the protocol accepts it. */
function encode(name: string, params: object): Buffer {
  return serializer.createPacketBuffer({ name, params });
}

/**
 * Round-trips a payload through the library's own serialiser *and* deserialiser,
 * so decoded field values can be asserted rather than just the byte count. A
 * successful decode also proves the enum spellings are real mappings.
 */
function roundTrip(name: string, params: object): Record<string, unknown> {
  const buffer = encode(name, params);
  const decoded = deserializer.parsePacketBuffer(buffer);
  expect(decoded.data.name).toBe(name);
  return decoded.data.params;
}

describe(`packet payloads serialise for Bedrock ${CURRENT_VERSION}`, () => {
  it('serialises a chat message', () => {
    const params = buildChatPacket({ message: 'hello world', sourceName: 'Agent' });
    const decoded = roundTrip('text', params);

    expect(decoded.type).toBe('chat');
    expect(decoded.needs_translation).toBe(false);
    expect(decoded.category).toBe('message_only');
    expect(decoded.source_name).toBe('Agent');
    expect(decoded.message).toBe('hello world');
  });

  it('serialises each outgoing chat variant', () => {
    for (const type of ['chat', 'whisper', 'announcement'] as const) {
      expect(() => encode('text', buildChatPacket({ message: 'x', sourceName: 'Agent', type }))).not.toThrow();
    }
  });

  it('serialises a position report', () => {
    const params = buildMovePlayerPacket({
      runtimeId: 42,
      position: { x: 1.5, y: 64, z: -2.25 },
      rotation: { yaw: 90, pitch: -30, headYaw: 85 },
      mode: 'teleport',
      onGround: false,
      tick: 7,
    });
    const decoded = roundTrip('move_player', params);

    expect(decoded.mode).toBe('teleport');
    expect(decoded.runtime_id).toBe(42);
    expect(decoded.on_ground).toBe(false);
    expect(Number(decoded.tick)).toBe(7);
    expect(decoded.position).toMatchObject({ x: 1.5, y: 64, z: -2.25 });
    expect(Number(decoded.pitch)).toBeCloseTo(-30, 2);
  });

  it('serialises every move mode the actions can request', () => {
    for (const mode of ['normal', 'reset', 'teleport', 'rotation'] as const) {
      const decoded = roundTrip(
        'move_player',
        buildMovePlayerPacket({
          runtimeId: 1,
          position: { x: 0, y: 0, z: 0 },
          rotation: { yaw: 0, pitch: 0, headYaw: 0 },
          mode,
        }),
      );
      expect(decoded.mode).toBe(mode);
    }
  });

  it('serialises an authoritative input frame', () => {
    const params = buildPlayerAuthInputPacket({
      position: { x: 0.5, y: 64, z: 0.5 },
      rotation: { yaw: 180, pitch: 10, headYaw: 180 },
      tick: 20,
      inputData: ['jumping', 'start_jumping'],
      moveVector: { x: 1, z: 0 },
    });
    const decoded = roundTrip('player_auth_input', params);

    expect(Number(decoded.tick)).toBe(20);
    expect(decoded.input_data).toEqual(['jumping', 'start_jumping']);
    expect(decoded.input_mode).toBe('mouse');
    expect(decoded.play_mode).toBe('normal');
    expect(decoded.position).toMatchObject({ x: 0.5, y: 64, z: 0.5 });
  });

  it('serialises a block-breaking action', () => {
    const decoded = roundTrip(
      'player_action',
      buildPlayerActionPacket({
        runtimeEntityId: 9,
        action: 'stop_break',
        position: { x: 3, y: 64, z: -7 },
        face: 'up',
      }),
    );

    expect(decoded.action).toBe('stop_break');
    expect(decoded.position).toMatchObject({ x: 3, y: 64, z: -7 });
    expect(decoded.result_position).toMatchObject({ x: 3, y: 64, z: -7 });
    // Bedrock numbers faces 0..5 as down, up, north, south, west, east.
    expect(decoded.face).toBe(1);
  });

  it('serialises every player action the actions layer can emit', () => {
    const actions = ['start_break', 'abort_break', 'stop_break', 'creative_player_destroy_block', 'jump', 'start_using_item'] as const;
    for (const action of actions) {
      const decoded = roundTrip('player_action', buildPlayerActionPacket({ runtimeEntityId: 1, action, position: { x: 0, y: 0, z: 0 } }));
      expect(decoded.action).toBe(action);
    }
  });

  it('serialises using an item on a block', () => {
    const held = buildWireItem({ networkId: 5, count: 1 });
    const decoded = roundTrip(
      'inventory_transaction',
      buildItemUseOnBlockTransaction({
        blockPosition: { x: 1, y: 63, z: 1 },
        face: 'up',
        hotbarSlot: 2,
        heldItem: held,
        playerPosition: { x: 1.5, y: 64, z: 1.5 },
        blockRuntimeId: 12,
      }),
    );

    const transaction = decoded.transaction as Record<string, unknown>;
    expect(transaction.transaction_type).toBe('item_use');
    const data = transaction.transaction_data as Record<string, unknown>;
    expect(data.action_type).toBe('click_block');
    expect(data.trigger_type).toBe('player_input');
    expect(data.face).toBe(1);
    expect(data.hotbar_slot).toBe(2);
    expect(data.hand).toBe('main_hand');
    expect(data.block_runtime_id).toBe(12);
    expect((data.block_position as Record<string, number>).y).toBe(63);
  });

  it('serialises using an item in the air and releasing it', () => {
    const held = buildWireItem({ networkId: 7, count: 16 });
    const onAir = roundTrip(
      'inventory_transaction',
      buildItemUseOnAirTransaction({ hotbarSlot: 0, heldItem: held, playerPosition: { x: 0, y: 64, z: 0 } }),
    );
    expect(((onAir.transaction as Record<string, unknown>).transaction_data as Record<string, unknown>).action_type).toBe('click_air');

    const release = roundTrip(
      'inventory_transaction',
      buildItemReleaseTransaction({
        actionType: 'consume',
        hotbarSlot: 0,
        heldItem: held,
        headPosition: { x: 0, y: 65.6, z: 0 },
      }),
    );
    const releaseTransaction = release.transaction as Record<string, unknown>;
    expect(releaseTransaction.transaction_type).toBe('item_release');
    expect((releaseTransaction.transaction_data as Record<string, unknown>).action_type).toBe('consume');
  });

  it('serialises attacking and using an item on an entity', () => {
    const held = buildWireItem({ networkId: 3, count: 1 });
    for (const actionType of ['attack', 'interact'] as const) {
      const decoded = roundTrip(
        'inventory_transaction',
        buildItemUseOnEntityTransaction({
          entityRuntimeId: 77,
          actionType,
          hotbarSlot: 1,
          heldItem: held,
          playerPosition: { x: 0, y: 64, z: 0 },
        }),
      );
      const transaction = decoded.transaction as Record<string, unknown>;
      expect(transaction.transaction_type).toBe('item_use_on_entity');
      const data = transaction.transaction_data as Record<string, unknown>;
      expect(data.action_type).toBe(actionType);
      expect(Number(data.entity_runtime_id)).toBe(77);
    }
  });

  it('serialises dropping an item as a world-interaction transaction', () => {
    const item = buildWireItem({ networkId: 4, count: 3 });
    const decoded = roundTrip('inventory_transaction', buildDropItemTransaction({ slot: 2, item }));

    const transaction = decoded.transaction as Record<string, unknown>;
    expect(transaction.transaction_type).toBe('normal');
    const actions = transaction.actions as Record<string, unknown>[];
    expect(actions).toHaveLength(1);
    expect(actions[0]?.source_type).toBe('world_interaction');
    expect(actions[0]?.slot).toBe(2);

    const newItem = actions[0]?.new_item as Record<string, unknown>;
    expect(newItem.network_id).toBe(0);
    expect(newItem.count).toBe(0);
  });

  it('serialises an empty item exactly as the protocol expects', () => {
    const decoded = roundTrip('inventory_transaction', buildDropItemTransaction({ slot: 0, item: buildEmptyItem() }));
    const actions = (decoded.transaction as Record<string, unknown>).actions as Record<string, unknown>[];
    expect((actions[0]?.old_item as Record<string, unknown>).network_id).toBe(0);
  });

  it('serialises the hotbar selection', () => {
    const decoded = roundTrip('player_hotbar', buildPlayerHotbarPacket({ selectedSlot: 3 }));
    expect(decoded.selected_slot).toBe(3);
    expect(decoded.window_id).toBe('inventory');
    expect(decoded.select_slot).toBe(true);
  });

  it('serialises the interact packet', () => {
    const decoded = roundTrip('interact', buildInteractPacket({ actionId: 'open_inventory' }));
    expect(decoded.action_id).toBe('open_inventory');
    expect(decoded.has_position).toBe(false);

    const withPosition = roundTrip(
      'interact',
      buildInteractPacket({ actionId: 'mouse_over_entity', targetEntityId: 5, position: { x: 1, y: 2, z: 3 } }),
    );
    expect(withPosition.has_position).toBe(true);
    expect(Number(withPosition.target_entity_id)).toBe(5);
  });

  it('serialises the chunk radius request', () => {
    const decoded = roundTrip('request_chunk_radius', buildRequestChunkRadiusPacket({ chunkRadius: 12 }));
    expect(decoded.chunk_radius).toBe(12);
  });

  it('serialises a command request with its correlation keys', () => {
    const params = buildCommandRequestPacket({
      command: '/give @s diamond 64',
      uuid: 'd0ea7ae4-f0c4-35aa-88f6-de686674286f',
      requestId: 'req-1',
      playerEntityId: 42,
    });
    const decoded = roundTrip('command_request', params);

    // The command line is passed through verbatim, slash included: servers strip
    // it themselves, and `detail.command` should show what was asked for.
    expect(decoded.command).toBe('/give @s diamond 64');
    expect(decoded.internal).toBe(false);

    const origin = decoded.origin as Record<string, unknown>;
    expect(origin.type).toBe('player');
    expect(origin.uuid).toBe('d0ea7ae4-f0c4-35aa-88f6-de686674286f');
    expect(origin.request_id).toBe('req-1');
    // ProtoDef decodes the li64 field as a [high, low] pair of 32-bit halves.
    expect(origin.player_entity_id).toEqual([0, 42]);
  });

  it('sends the string `version` that 1.26.x requires', () => {
    // The field changed encoding across releases (varint up to 1.21.x, string
    // from 1.21.130), and a 1.26.x server rejects a numeric-looking value. This
    // pins the default so a schema drift in minecraft-data shows up here.
    const decoded = roundTrip(
      'command_request',
      buildCommandRequestPacket({ command: 'about', uuid: 'd0ea7ae4-f0c4-35aa-88f6-de686674286f', requestId: 'r' }),
    );
    expect(decoded.version).toBe('latest');
  });

  it('keeps the modelled packet catalogue free of duplicates', () => {
    expect(new Set(MODELLED_PACKET_NAMES).size).toBe(MODELLED_PACKET_NAMES.length);
    expect([...MODELLED_PACKET_NAMES]).toEqual([...MODELLED_PACKET_NAMES].sort());
    // Every packet we send must be covered by a serialisation test above.
    for (const name of OUTGOING_PACKET_NAMES) {
      expect(MODELLED_PACKET_NAMES).toContain(name);
    }
  });
});
