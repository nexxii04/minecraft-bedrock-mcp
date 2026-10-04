import { describe, expect, it } from 'vitest';

import type { SessionLimits } from '../../src/config.js';
import { BedrockSession } from '../../src/bedrock/session.js';
import { normalizePacket, PACKET_NORMALIZERS, toNumber } from '../../src/bedrock/events.js';
import { encodeChunkPayload, paletteStorage, uniformStorage } from '../helpers/chunk-encoder.js';

/** A payload holding `stone` throughout one sub-chunk, as a server would send it. */
const AIR = 3690217760;
const STONE = 2150698529;
function stoneChunkPayload(): Uint8Array {
  return encodeChunkPayload({
    subChunks: [{ index: -4, layers: [paletteStorage(new Array<number>(4096).fill(1), [AIR, STONE])], biomes: uniformStorage(64) }],
  });
}

/**
 * Contract tests for the packet→domain event translation.
 *
 * The payloads are the shapes ProtoDef produces for the installed version: bigints
 * for 64-bit fields, mappers resolved to names, arrays of metadata entries. Pinning
 * the translation down here is what keeps an agent from ever seeing a bigint or a
 * numeric enum.
 */

const limits: SessionLimits = {
  maxChatLog: 5,
  maxEventLog: 10,
  maxTrackedEntities: 3,
  maxTrackedBlocks: 4,
  maxTrackedChunks: 4,
};

/** Walks a value and returns the paths of any bigint it contains. */
function findBigint(value: unknown, path = '$'): string[] {
  if (typeof value === 'bigint') return [path];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => findBigint(entry, `${path}.${key}`));
}

function makeSession(): BedrockSession {
  return new BedrockSession({
    sessionId: 'unit',
    host: '127.0.0.1',
    port: 19132,
    username: 'UnitAgent',
    offline: true,
    raknetBackend: 'jsp-raknet',
    limits,
  });
}

describe('toNumber', () => {
  it('widens the bigints ProtoDef produces', () => {
    expect(toNumber(42n)).toBe(42);
    expect(toNumber(-1n)).toBe(-1);
    expect(toNumber(7)).toBe(7);
    expect(toNumber('12')).toBe(12);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber(undefined, -1)).toBe(-1);
    expect(toNumber(Number.NaN, 5)).toBe(5);
  });
});

describe('normalizePacket', () => {
  it('ignores packets with no normalizer rather than inventing events', () => {
    const session = makeSession();
    expect(normalizePacket('level_sound_event', { sound_id: 1 }, session)).toEqual([]);
    expect(normalizePacket('some_future_packet', {}, session)).toEqual([]);
  });

  it('never throws on a malformed payload', () => {
    const session = makeSession();
    // Every registered normalizer is fed garbage; the session must survive.
    for (const name of Object.keys(PACKET_NORMALIZERS)) {
      expect(() => normalizePacket(name, { unexpected: { shape: true } }, session)).not.toThrow();
    }
  });
});

describe('session state normalisation', () => {
  it('turns start_game into session state and a session_started event', () => {
    const session = makeSession();
    const events = session.ingest('start_game', {
      entity_id: 4294967301n,
      runtime_entity_id: 1n,
      player_gamemode: 'creative',
      player_position: { x: 10.5, y: 65, z: -20.25 },
      rotation: { x: 90, z: 15 },
      dimension: 'overworld',
      world_name: 'QA World',
      game_version: '1.26.51',
      permission_level: 'operator',
      server_authoritative_inventory: false,
      server_authoritative_block_breaking: true,
    });

    const started = events.find((event) => event.type === 'session_started');
    expect(started).toBeDefined();
    if (started?.type !== 'session_started') throw new Error('expected session_started');

    expect(started.entityId).toBe('4294967301');
    expect(started.runtimeEntityId).toBe(1);
    expect(started.gameMode).toBe('creative');
    expect(started.dimension).toBe('overworld');
    expect(started.position).toEqual({ x: 10.5, y: 65, z: -20.25 });
    // vec2f rotation has yaw in x and pitch in z.
    expect(started.rotation).toEqual({ yaw: 90, pitch: 15, headYaw: 90 });
    expect(started.worldName).toBe('QA World');
    expect(started.serverVersion).toBe('1.26.51');
    expect(started.permissionLevel).toBe('operator');
    expect(started.serverAuthoritativeBlockBreaking).toBe(true);

    expect(session.runtimeEntityId).toBe(1);
    expect(session.gameMode).toBe('creative');
    expect(session.permissionLevel).toBe('operator');
  });

  it('normalises chat and marks our own messages', () => {
    const session = makeSession();
    session.ingest('start_game', { runtime_entity_id: 5n });
    session.ingest('add_player', { runtime_id: 5n, username: 'UnitAgent', unique_id: 1n });

    const [event] = session.ingest('text', {
      type: 'chat',
      needs_translation: false,
      source_name: 'UnitAgent',
      message: 'self message',
      xuid: '',
      platform_chat_id: '',
      has_filtered_message: false,
      filtered_message: '',
    });

    expect(event?.type).toBe('chat');
    if (event?.type !== 'chat') throw new Error('expected chat');
    expect(event.chat.fromSelf).toBe(true);
    expect(event.chat.kind).toBe('chat');

    session.ingest('text', { type: 'system', message: 'Server restarting in 5' });
    const log = session.getChatLog();
    expect(log).toHaveLength(2);
    expect(log[1]?.kind).toBe('system');
    expect(log[1]?.message).toBe('Server restarting in 5');
  });

  it('tracks entity spawns, deltas and removals', () => {
    const session = makeSession();

    session.ingest('add_entity', {
      unique_id: 100n,
      runtime_id: 2n,
      entity_type: 'minecraft:zombie',
      position: { x: 1, y: 64, z: 1 },
      velocity: { x: 0, y: 0, z: 0 },
      pitch: 0,
      yaw: 0,
      head_yaw: 0,
      body_yaw: 0,
      attributes: [],
      metadata: [],
      properties: [],
      links: [],
    });
    expect(session.entities.get(2)?.type).toBe('minecraft:zombie');
    expect(session.entities.get(2)?.uniqueId).toBe(100);

    // A delta packet only carries the axes that changed.
    const moved = session.ingest('move_entity_delta', { runtime_entity_id: 2n, x: 5, on_ground: true });
    expect(moved).toHaveLength(1);
    expect(session.entities.get(2)?.position).toEqual({ x: 5, y: 64, z: 1 });

    const absolute = session.ingest('move_entity', {
      runtime_entity_id: 2n,
      flags: 0,
      position: { x: 8, y: 65, z: 9 },
      rotation: { yaw: 45, pitch: 10, head_yaw: 45 },
    });
    expect(absolute[0]?.type).toBe('entity_moved');
    expect(session.entities.get(2)?.position).toEqual({ x: 8, y: 65, z: 9 });

    const removed = session.ingest('remove_entity', { entity_id_self: 2n });
    expect(removed[0]?.type).toBe('entity_removed');
    expect(session.entities.has(2)).toBe(false);
  });

  it('tracks players by name and reads metadata nametags', () => {
    const session = makeSession();
    session.ingest('add_player', {
      uuid: 'abc',
      username: 'OtherPlayer',
      runtime_id: 7n,
      platform_chat_id: '',
      position: { x: 0, y: 64, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      pitch: 0,
      yaw: 0,
      head_yaw: 0,
      held_item: {},
      gamemode: 'survival',
      metadata: [],
      properties: [],
      unique_id: 99n,
      permission_level: 'member',
      command_permission: 'normal',
      abilities: [],
      links: [],
      device_id: '',
    });

    expect(session.entities.get(7)?.isPlayer).toBe(true);
    expect(session.entities.get(7)?.username).toBe('OtherPlayer');

    const metadata = session.ingest('set_entity_data', {
      runtime_entity_id: 7n,
      metadata: [
        { key: 'nametag', type: 'string', legacy_type: 0, value: 'RenamedPlayer' },
        { key: 'health', type: 'int', legacy_type: 0, value: 20 },
      ],
      properties: [],
      tick: 1n,
    });

    expect(metadata[0]?.type).toBe('entity_metadata');
    if (metadata[0]?.type !== 'entity_metadata') throw new Error('expected entity_metadata');
    expect(metadata[0].metadata['nametag']).toBe('RenamedPlayer');
    expect(metadata[0].metadata['health']).toBe(20);
    expect(session.entities.get(7)?.username).toBe('RenamedPlayer');
  });

  it('tracks block updates, including batched subchunk updates', () => {
    const session = makeSession();

    const single = session.ingest('update_block', {
      position: { x: 1, y: 64, z: 2 },
      block_runtime_id: 0,
      flags: { network: true },
      layer: 0,
    });
    expect(single[0]?.type).toBe('block_updated');
    expect(session.getTrackedBlock({ x: 1, y: 64, z: 2 })?.blockRuntimeId).toBe(0);

    const batch = session.ingest('update_subchunk_blocks', {
      x: 0,
      y: 0,
      z: 0,
      blocks: [{ position: { x: 3, y: 64, z: 3 }, runtime_id: 55, flags: 0, entity_unique_id: 0n, transition_type: 'create' }],
      extra: [],
    });
    expect(batch).toHaveLength(1);
    expect(session.getTrackedBlock({ x: 3, y: 64, z: 3 })?.blockRuntimeId).toBe(55);
  });

  it('keeps the block cache bounded by the configured limit', () => {
    const session = makeSession();
    for (let index = 0; index < 20; index += 1) {
      session.ingest('update_block', {
        position: { x: index, y: 64, z: 0 },
        block_runtime_id: index + 1,
        flags: 0,
        layer: 0,
      });
    }
    // `maxTrackedBlocks` is 4 in this fixture.
    expect(session.blocks.size).toBeLessThanOrEqual(limits.maxTrackedBlocks);
    // The most recent update always survives.
    expect(session.getTrackedBlock({ x: 19, y: 64, z: 0 })?.blockRuntimeId).toBe(20);
  });

  it('reads inventory contents and names items from the registry', () => {
    const session = makeSession();

    session.ingest('item_registry', {
      itemstates: [
        { name: 'minecraft:stone', runtime_id: 5, component_based: false, version: 'legacy', nbt: null },
        { name: 'minecraft:diamond_pickaxe', runtime_id: 9, component_based: false, version: 'legacy', nbt: null },
      ],
    });
    expect(session.getItemName(5)).toBe('minecraft:stone');

    const items = [
      { network_id: 5, count: 64, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: {} },
      { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: {} },
      { network_id: 9, count: 1, metadata: 0, has_stack_id: true, stack_id: 3, block_runtime_id: 0, extra: {} },
    ];
    const [event] = session.ingest('inventory_content', { window_id: 'inventory', input: items });

    expect(event?.type).toBe('inventory_updated');
    const slots = session.getInventory('inventory');
    // The empty slot is not an item.
    expect(slots).toHaveLength(2);
    expect(slots[0]?.slot).toBe(0);
    expect(slots[0]?.name).toBe('minecraft:stone');
    expect(slots[0]?.count).toBe(64);
    // Slots are keyed by their position on the wire, so the empty slot 1 is
    // simply absent and the pickaxe keeps its real slot number 2.
    expect(slots.map((item) => item.slot)).toEqual([0, 2]);
    expect(slots[1]?.name).toBe('minecraft:diamond_pickaxe');
    expect(slots[1]?.stackId).toBe(3);

    session.ingest('inventory_slot', {
      window_id: 'inventory',
      slot: 0,
      item: { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: {} },
    });
    expect(session.getInventory('inventory').map((item) => item.slot)).toEqual([2]);
  });

  it('names biomes from the catalogue the server itself announced', () => {
    const session = makeSession();
    const [event] = session.ingest('biome_definition_list', {
      biome_definitions: [
        { name_index: 0, biome_id: 1, tags: [] },
        // A definition whose id the server left at the protocol default says
        // nothing about which id it names, so it must not be mapped.
        { name_index: 1, biome_id: 65535, tags: [] },
      ],
      string_list: ['minecraft:plains', 'minecraft:ocean'],
    });

    expect(event?.type).toBe('biome_definitions');
    if (event?.type !== 'biome_definitions') throw new Error('expected biome_definitions');
    expect(event.definitionCount).toBe(2);
    expect(event.namedCount).toBe(1);
    expect(session.biomes.get(1)).toBe('minecraft:plains');
    expect(session.biomes.has(65535)).toBe(false);
  });

  it('reports the held item from the selected hotbar slot', () => {
    const session = makeSession();
    session.ingest('start_game', { runtime_entity_id: 1n });
    session.ingest('inventory_content', {
      window_id: 'inventory',
      input: [{ network_id: 11, count: 1, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: {} }],
    });

    // Nothing is held until the server reports a selected hotbar slot.
    expect(session.getHeldItem()).toBeNull();

    session.ingest('mob_equipment', {
      runtime_entity_id: 1n,
      item: {},
      slot: 0,
      selected_slot: 0,
      window_id: 'inventory',
    });
    expect(session.selectedHotbarSlot).toBe(0);
    expect(session.getHeldItem()?.networkId).toBe(11);

    // Another entity's equipment must not change our selection.
    session.ingest('mob_equipment', {
      runtime_entity_id: 9n,
      item: {},
      slot: 0,
      selected_slot: 5,
      window_id: 'inventory',
    });
    expect(session.selectedHotbarSlot).toBe(0);
  });

  it('builds the command catalogue from available_commands', () => {
    const session = makeSession();
    const [event] = session.ingest('available_commands', {
      values_len: 4,
      enum_values: ['any', 'tp', 'up', 'zombie'],
      chained_subcommand_values: [],
      suffixes: [],
      enums: [
        // `alias` indexes *this* array, and the indices inside point at enum_values.
        { name: 'teleportAliases', values: [1] },
      ],
      chained_subcommands: [],
      command_data: [
        {
          name: 'teleport',
          description: 'Teleport to a player or coordinates',
          flags: 0,
          permission_level: 'any',
          alias: 0,
          chained_subcommand_offsets: [],
          overloads: [
            {
              chaining: false,
              parameters: [
                { parameter_name: 'destination', value_type: 'target', enum_type: 'valid', optional: false, options: {} },
                { parameter_name: 'level', value_type: 'int', enum_type: 'valid', optional: true, options: {} },
              ],
            },
          ],
        },
        {
          name: 'weather',
          description: 'Sets the weather',
          flags: 2,
          permission_level: 'operator',
          alias: -1,
          chained_subcommand_offsets: [],
          overloads: [
            {
              chaining: false,
              // 99 is deliberately unmapped: the protocol's type mapper only
              // covers the common kinds, and an unmapped code must be reported
              // as sent rather than guessed at.
              parameters: [{ parameter_name: 'type', value_type: 99, enum_type: 'enum', optional: true, options: {} }],
            },
          ],
        },
      ],
    });

    expect(event?.type).toBe('commands_available');
    if (event?.type !== 'commands_available') throw new Error('expected commands_available');
    expect(event.commandCount).toBe(2);
    expect(session.snapshot().commandCount).toBe(2);

    const teleport = session.commands.get('teleport');
    expect(teleport?.description).toBe('Teleport to a player or coordinates');
    expect(teleport?.permissionLevel).toBe('any');
    expect(teleport?.aliases).toEqual(['tp']);
    expect(teleport?.overloads).toEqual(['destination:target level:int?']);

    // An enum-constrained parameter reads as `enum` whatever its raw code is.
    const weather = session.commands.get('weather');
    expect(weather?.overloads).toEqual(['type:enum?']);
    expect(weather?.flags).toBe(2);
    expect(weather?.aliases).toEqual([]);
  });

  it('replaces the command catalogue instead of merging it', () => {
    const session = makeSession();
    const announce = (names: string[]): void => {
      session.ingest('available_commands', {
        enum_values: [],
        enums: [],
        chained_subcommand_values: [],
        suffixes: [],
        chained_subcommands: [],
        command_data: names.map((name) => ({
          name,
          description: '',
          flags: 0,
          permission_level: 'any',
          alias: -1,
          chained_subcommand_offsets: [],
          overloads: [],
        })),
      });
    };

    announce(['give', 'teleport']);
    expect([...session.commands.keys()].sort()).toEqual(['give', 'teleport']);

    // A command missing from a later announcement must vanish: a stale entry
    // would hide exactly the broken registration this data is used to detect.
    announce(['give']);
    expect([...session.commands.keys()]).toEqual(['give']);
    expect(session.snapshot().commandCount).toBe(1);

    session.resetWorldState();
    expect(session.commands.size).toBe(0);
  });

  it('survives a command catalogue with broken alias indices', () => {
    const session = makeSession();
    expect(() =>
      session.ingest('available_commands', {
        enum_values: ['only'],
        // An alias index past the end of `enums`, and an enum value past the end
        // of `enum_values`: both must cost an empty alias list, not a throw.
        enums: [{ name: 'bad', values: [50] }],
        command_data: [
          { name: 'a', description: '', flags: 0, permission_level: 'any', alias: 9, chained_subcommand_offsets: [], overloads: [] },
          { name: 'b', description: '', flags: 0, permission_level: 'any', alias: 0, chained_subcommand_offsets: [], overloads: [] },
        ],
      }),
    ).not.toThrow();
    expect(session.commands.get('a')?.aliases).toEqual([]);
    expect(session.commands.get('b')?.aliases).toEqual([]);
  });

  it('normalises command output and keeps the request correlation keys', () => {
    const session = makeSession();
    const [event] = session.ingest('command_output', {
      origin: {
        type: 'player',
        uuid: 'd0ea7ae4-f0c4-35aa-88f6-de686674286f',
        request_id: 'req-7',
        player_entity_id: [0, 5],
      },
      output_type: 'alloutput',
      success_count: 1,
      output: [
        { message_id: '§7TestServer §a0.2.0§r', success: true, parameters: [] },
        { message_id: 'Gave %1 to %2', success: true, parameters: ['64 diamonds', 'UnitAgent'] },
      ],
      has_data: false,
    });

    expect(event?.type).toBe('command_executed');
    if (event?.type !== 'command_executed') throw new Error('expected command_executed');
    expect(event.requestId).toBe('req-7');
    expect(event.uuid).toBe('d0ea7ae4-f0c4-35aa-88f6-de686674286f');
    expect(event.originType).toBe('player');
    expect(event.outputType).toBe('alloutput');
    expect(event.successCount).toBe(1);
    expect(event.hasData).toBe(false);
    // `message_id` is the message text on the wire, not an identifier.
    expect(event.messages).toEqual([
      { message: '§7TestServer §a0.2.0§r', success: true, parameters: [] },
      { message: 'Gave %1 to %2', success: true, parameters: ['64 diamonds', 'UnitAgent'] },
    ]);
  });

  it('marks a rejected command as unsuccessful rather than dropping it', () => {
    const session = makeSession();
    const [event] = session.ingest('command_output', {
      origin: { type: 'player', uuid: 'u', request_id: 'r', player_entity_id: [0, 1] },
      output_type: 'alloutput',
      success_count: 0,
      output: [{ message_id: 'Unknown command', success: false, parameters: [] }],
      has_data: false,
    });

    if (event?.type !== 'command_executed') throw new Error('expected command_executed');
    expect(event.successCount).toBe(0);
    expect(event.messages[0]?.success).toBe(false);
    expect(event.messages[0]?.message).toBe('Unknown command');
  });

  it('tracks health and death', () => {
    const session = makeSession();
    session.ingest('set_health', { health: 20 });
    expect(session.health).toBe(20);
    expect(session.isAlive).toBe(true);

    const [damaged] = session.ingest('set_health', { health: 0 });
    expect(damaged?.type).toBe('health_changed');
    if (damaged?.type !== 'health_changed') throw new Error('expected health_changed');
    expect(damaged.previousHealth).toBe(20);
    expect(session.isAlive).toBe(false);

    const [death] = session.ingest('death_info', { cause: 'fall', messages: ['You fell'] });
    expect(death?.type).toBe('death');
  });

  it('clears the world view when the dimension changes', () => {
    const session = makeSession();
    session.ingest('add_entity', {
      unique_id: 1n,
      runtime_id: 3n,
      entity_type: 'minecraft:pig',
      position: { x: 0, y: 64, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      pitch: 0,
      yaw: 0,
      head_yaw: 0,
      body_yaw: 0,
      attributes: [],
      metadata: [],
      properties: [],
      links: [],
    });
    session.ingest('update_block', { position: { x: 0, y: 64, z: 0 }, block_runtime_id: 1, flags: 0, layer: 0 });

    const [event] = session.ingest('change_dimension', {
      dimension: 'nether',
      position: { x: 0, y: 32, z: 0 },
      respawn: false,
    });

    expect(event?.type).toBe('dimension_changed');
    expect(session.dimension).toBe('nether');
    // Entities and block updates from the old dimension are meaningless now.
    expect(session.entities.size).toBe(0);
    expect(session.blocks.size).toBe(0);
  });

  it('applies player-list additions and removals', () => {
    const session = makeSession();
    const [added] = session.ingest('player_list', {
      records: [
        {
          type: 'add',
          legacy_type: 0,
          uuid: 'uuid-1',
          entity_unique_id: 12n,
          username: 'Alice',
          xbox_user_id: 'xuid-1',
          platform_chat_id: '',
          build_platform: 1,
          skin_data: {},
          is_teacher: false,
          is_host: false,
          is_subclient: false,
          player_color: 0,
        },
      ],
    });

    expect(added?.type).toBe('player_list');
    if (added?.type !== 'player_list') throw new Error('expected player_list');
    expect(added.added[0]?.username).toBe('Alice');
    expect(session.playerList.get('uuid-1')?.username).toBe('Alice');

    const [removed] = session.ingest('player_list', { records: [{ type: 'remove', legacy_type: 0, uuid: 'uuid-1' }] });
    if (removed?.type !== 'player_list') throw new Error('expected player_list');
    expect(removed.removed).toEqual(['uuid-1']);
    expect(session.playerList.size).toBe(0);
  });

  it('counts every chunk that arrives', () => {
    const session = makeSession();
    const [event] = session.ingest('level_chunk', {
      x: 1,
      z: -1,
      dimension: 0,
      sub_chunk_count: 1,
      payload: stoneChunkPayload(),
    });

    expect(event?.type).toBe('chunk_loaded');
    if (event?.type !== 'chunk_loaded') throw new Error('expected chunk_loaded');
    expect(event.x).toBe(1);
    expect(event.z).toBe(-1);
    expect(event.chunksLoaded).toBe(1);
    expect(session.chunksLoaded).toBe(1);
  });

  it('decodes a chunk payload into terrain, and reports one it cannot read', () => {
    const session = makeSession();
    const [good] = session.ingest('level_chunk', {
      x: 1,
      z: -1,
      dimension: 0,
      sub_chunk_count: 1,
      payload: stoneChunkPayload(),
    });
    if (good?.type !== 'chunk_loaded') throw new Error('expected chunk_loaded');
    expect(good.decoded).toBe(true);
    expect(good.decodeError).toBeUndefined();
    expect(session.chunksDecoded).toBe(1);
    expect(session.chunks.get('1,-1')?.decoded.consistent).toBe(true);

    // A payload that does not decode is a finding about the server, so it is
    // counted and surfaced rather than cached.
    const [bad] = session.ingest('level_chunk', {
      x: 2,
      z: -1,
      dimension: 0,
      sub_chunk_count: 1,
      payload: Uint8Array.from([7, 1, 0]),
    });
    if (bad?.type !== 'chunk_loaded') throw new Error('expected chunk_loaded');
    expect(bad.decoded).toBe(false);
    expect(bad.decodeError).toBeDefined();
    expect(session.chunksFailed).toBe(1);
    expect(session.chunks.has('2,-1')).toBe(false);
  });

  it('drops the farthest terrain when the chunk cache overflows, not the oldest', () => {
    const session = makeSession();
    session.ingest('start_game', { runtime_entity_id: 4n, player_position: { x: 0, y: 64, z: 0 } });

    // A server streams its whole view radius at once, so the far chunk can arrive
    // first: what must survive is the neighbourhood, not the newest decode.
    for (const [x, z] of [
      [9, 9],
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      session.ingest('level_chunk', { x, z, dimension: 0, sub_chunk_count: 1, payload: stoneChunkPayload() });
    }

    expect(session.chunks.size).toBe(4);
    expect(session.chunks.has('9,9')).toBe(false);
    expect(session.chunks.has('0,0')).toBe(true);
  });

  it('records the chunk radius the server grants', () => {
    const session = makeSession();
    const [event] = session.ingest('chunk_radius_update', { chunk_radius: 12 });
    expect(event?.type).toBe('chunk_radius_accepted');
    expect(session.chunkRadius).toBe(12);
  });

  it('marks our own position reports as server corrections', () => {
    const session = makeSession();
    session.ingest('start_game', { runtime_entity_id: 4n, player_position: { x: 0, y: 64, z: 0 } });

    const [own] = session.ingest('move_player', {
      runtime_id: 4n,
      position: { x: 5, y: 64, z: 5 },
      pitch: 0,
      yaw: 0,
      head_yaw: 0,
      mode: 'normal',
      on_ground: true,
      ridden_runtime_id: 0,
      tick: 1n,
    });
    if (own?.type !== 'position_updated') throw new Error('expected position_updated');
    expect(own.source).toBe('server_correction');
    expect(session.position).toEqual({ x: 5, y: 64, z: 5 });

    const [teleport] = session.ingest('move_player', {
      runtime_id: 4n,
      position: { x: 100, y: 70, z: 100 },
      pitch: 0,
      yaw: 0,
      head_yaw: 0,
      mode: 'teleport',
      on_ground: false,
      ridden_runtime_id: 0,
      tick: 2n,
    });
    if (teleport?.type !== 'position_updated') throw new Error('expected position_updated');
    expect(teleport.source).toBe('teleport');
  });
});

describe('self-reported position', () => {
  it('records our own report as a self_report position event', () => {
    const session = makeSession();
    session.ingest('start_game', { runtime_entity_id: 1n, player_position: { x: 0, y: 64, z: 0 } });

    const seen: string[] = [];
    session.onEvent((event) => seen.push(`${event.type}:${event.type === 'position_updated' ? event.source : ''}`));

    const event = session.reportSelfPosition({ x: 10, y: 70, z: -5 }, { yaw: 90, pitch: 0, headYaw: 90 }, false);

    expect(event.type).toBe('position_updated');
    if (event.type !== 'position_updated') throw new Error('expected position_updated');
    // The source is the whole point of the method: nothing may mistake our own
    // belief for the server agreeing with us.
    expect(event.source).toBe('self_report');
    expect(session.position).toEqual({ x: 10, y: 70, z: -5 });
    expect(session.rotation).toEqual({ yaw: 90, pitch: 0, headYaw: 90 });
    expect(session.onGround).toBe(false);
    expect(seen).toEqual(['position_updated:self_report']);
  });

  it('leaves the existing rotation and on-ground flag alone when not given', () => {
    const session = makeSession();
    session.ingest('start_game', { runtime_entity_id: 1n, player_position: { x: 0, y: 64, z: 0 } });
    session.ingest('set_health', { health: 20 });

    session.reportSelfPosition({ x: 1, y: 64, z: 1 });

    expect(session.rotation).toEqual({ yaw: 0, pitch: 0, headYaw: 0 });
    expect(session.onGround).toBeNull();
  });

  it('is overwritten by a server correction, which is itself the acknowledgement', () => {
    const session = makeSession();
    session.ingest('start_game', { runtime_entity_id: 4n, player_position: { x: 0, y: 64, z: 0 } });
    session.reportSelfPosition({ x: 100, y: 64, z: 100 });
    expect(session.position).toEqual({ x: 100, y: 64, z: 100 });

    const [correction] = session.ingest('correct_player_move_prediction', {
      position: { x: 1, y: 64, z: 1 },
      delta: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, z: 0 },
      on_ground: true,
      tick: 5n,
    });

    if (correction?.type !== 'position_updated') throw new Error('expected position_updated');
    expect(correction.source).toBe('server_correction');
    expect(session.position).toEqual({ x: 1, y: 64, z: 1 });
  });
});

describe('session buffers', () => {
  it('bounds the chat log and the event log', () => {
    const session = makeSession();
    for (let index = 0; index < 12; index += 1) {
      session.ingest('text', { type: 'chat', source_name: 'Bot', message: `message ${index}` });
    }

    const chat = session.getChatLog();
    expect(chat).toHaveLength(limits.maxChatLog);
    expect(chat[chat.length - 1]?.message).toBe('message 11');

    expect(session.getEventLog().length).toBeLessThanOrEqual(limits.maxEventLog);
  });

  it('filters the chat log by sender and timestamp', () => {
    const session = makeSession();
    session.ingest('text', { type: 'chat', source_name: 'Alice', message: 'one' });
    session.ingest('text', { type: 'chat', source_name: 'Bob', message: 'two' });

    expect(session.getChatLog({ source: 'alice' }).map((message) => message.message)).toEqual(['one']);
    expect(session.getChatLog({ limit: 1 }).map((message) => message.message)).toEqual(['two']);
    expect(session.getChatLog({ since: Date.now() + 1000 })).toEqual([]);
  });

  it('filters the event log by type', () => {
    const session = makeSession();
    session.ingest('set_health', { health: 10 });
    session.ingest('text', { type: 'system', message: 'hi' });

    const healthEvents = session.getEventLog({ types: ['health_changed'] });
    expect(healthEvents).toHaveLength(1);
    expect(healthEvents[0]?.type).toBe('health_changed');
  });

  it('notifies subscribers and survives one that throws', () => {
    const session = makeSession();
    const seen: string[] = [];
    session.onEvent((event) => {
      seen.push(event.type);
      throw new Error('subscriber exploded');
    });
    session.onEvent((event) => seen.push(`second:${event.type}`));

    expect(() => session.ingest('set_health', { health: 5 })).not.toThrow();
    expect(seen).toEqual(['health_changed', 'second:health_changed']);
  });
});

describe('nearby queries', () => {
  it('sorts entities by distance and excludes the player by default', () => {
    const session = makeSession();
    session.ingest('start_game', { runtime_entity_id: 1n, player_position: { x: 0, y: 64, z: 0 } });
    session.ingest('add_entity', {
      unique_id: 1n,
      runtime_id: 1n,
      entity_type: 'minecraft:player',
      position: { x: 0, y: 64, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      pitch: 0,
      yaw: 0,
      head_yaw: 0,
      body_yaw: 0,
      attributes: [],
      metadata: [],
      properties: [],
      links: [],
    });
    session.ingest('add_entity', {
      unique_id: 2n,
      runtime_id: 2n,
      entity_type: 'minecraft:cow',
      position: { x: 10, y: 64, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      pitch: 0,
      yaw: 0,
      head_yaw: 0,
      body_yaw: 0,
      attributes: [],
      metadata: [],
      properties: [],
      links: [],
    });
    session.ingest('add_entity', {
      unique_id: 3n,
      runtime_id: 3n,
      entity_type: 'minecraft:pig',
      position: { x: 2, y: 64, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      pitch: 0,
      yaw: 0,
      head_yaw: 0,
      body_yaw: 0,
      attributes: [],
      metadata: [],
      properties: [],
      links: [],
    });

    const nearby = session.getNearbyEntities();
    expect(nearby.map((entity) => entity.type)).toEqual(['minecraft:pig', 'minecraft:cow']);
    expect(nearby[0]?.distance).toBe(2);

    const withSelf = session.getNearbyEntities({ includeSelf: true, limit: 1 });
    expect(withSelf).toHaveLength(1);
    expect(withSelf[0]?.type).toBe('minecraft:player');

    expect(session.getNearbyEntities({ types: ['minecraft:cow'] })).toHaveLength(1);
    expect(session.getNearbyEntities({ radius: 5 }).map((entity) => entity.type)).toEqual(['minecraft:pig']);
  });

  it('finds tracked blocks near a point, sorted by distance', () => {
    const session = makeSession();
    session.ingest('start_game', { runtime_entity_id: 1n, player_position: { x: 0, y: 64, z: 0 } });
    session.ingest('update_block', { position: { x: 1, y: 64, z: 0 }, block_runtime_id: 10, flags: 0, layer: 0 });
    session.ingest('update_block', { position: { x: 0, y: 64, z: 4 }, block_runtime_id: 20, flags: 0, layer: 0 });
    session.ingest('update_block', { position: { x: 50, y: 64, z: 50 }, block_runtime_id: 30, flags: 0, layer: 0 });

    const nearby = session.getNearbyTrackedBlocks({ radius: 10 });
    expect(nearby.map((block) => block.position)).toEqual([
      { x: 1, y: 64, z: 0 },
      { x: 0, y: 64, z: 4 },
    ]);
    expect(nearby[0]?.distance).toBe(1);
  });

  it('returns nothing when the position is unknown', () => {
    const session = makeSession();
    expect(session.getNearbyEntities()).toEqual([]);
    expect(session.getNearbyTrackedBlocks()).toEqual([]);
  });
});

describe('snapshot', () => {
  it('reports a complete, JSON-safe view of the session', () => {
    const session = makeSession();
    session.ingest('start_game', {
      runtime_entity_id: 1n,
      entity_id: 999n,
      player_gamemode: 'survival',
      player_position: { x: 1, y: 2, z: 3 },
      dimension: 'overworld',
      world_name: 'W',
      game_version: '1.26.51',
      server_authoritative_inventory: true,
    });
    session.ingest('set_health', { health: 20 });
    session.ingest('chunk_radius_update', { chunk_radius: 8 });
    session.markConnected('1.26.51', 900);
    session.setConnectionState('initialized');

    const snapshot = session.snapshot();
    expect(snapshot.connection.state).toBe('initialized');
    expect(snapshot.connection.version).toBe('1.26.51');
    expect(snapshot.connection.protocolVersion).toBe(900);
    expect(snapshot.connection.packetsReceived).toBeGreaterThan(0);
    expect(snapshot.runtimeEntityId).toBe(1);
    expect(snapshot.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(snapshot.health).toBe(20);
    expect(snapshot.chunkRadius).toBe(8);
    expect(snapshot.serverAuthoritative.inventory).toBe(true);
    expect(snapshot.uptimeMs).not.toBeNull();

    // Nothing in the snapshot may be a bigint: MCP returns JSON, and a bigint
    // anywhere would make the whole tool response unserialisable.
    expect(findBigint(snapshot)).toEqual([]);
    expect(() => JSON.stringify(snapshot)).not.toThrow();
  });

  it('resets world state but keeps connection metadata', () => {
    const session = makeSession();
    session.ingest('start_game', { runtime_entity_id: 1n, player_position: { x: 1, y: 2, z: 3 } });
    session.markConnected('1.26.51', 900);
    session.resetWorldState();

    const snapshot = session.snapshot();
    expect(snapshot.position).toBeNull();
    expect(snapshot.runtimeEntityId).toBeNull();
    expect(snapshot.dimension).toBe('unknown');
    expect(snapshot.connection.version).toBe('1.26.51');
    expect(snapshot.connection.connectedAt).not.toBeNull();
  });
});
