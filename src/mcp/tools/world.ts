import { z } from 'zod';

import type { BlockStates } from '../../bedrock/block-ids.js';
import { blockCentre } from '../../bedrock/chunk.js';
import type { UnknownReading } from '../../bedrock/terrain.js';
import { findBlocks, readBiome, readBlock } from '../../bedrock/terrain.js';
import { blockIdIndex } from '../../bedrock/vanilla-blocks.js';
import type { McpContext } from '../context.js';
import type { ToolRegistry } from '../registry.js';
import { handle, resolveConnectedSession } from '../context.js';
import { blockFaceSchema, blockPositionSchema, sessionIdSchema, timeoutSchema } from '../schemas.js';

/**
 * World tools: what is around us, and how to change it.
 *
 * Two sources answer "what is at these coordinates?": the server's own statements
 * (`update_block`/`update_subchunk_blocks`, read by `get_nearby_blocks`) and the
 * terrain in chunk payloads (decoded in `bedrock/chunk.ts`, letting `get_block_at`
 * and `find_block` answer for blocks the server never mentioned). Every reading
 * says which answered. Unloaded terrain returns "unknown" rather than air — a
 * distinction a QA assertion must not collapse, or it passes when it should fail.
 */

/**
 * How far a `find_block` search may reach. The scan is a `(2r+1)^3` cube, so 32 is
 * already 274 625 lookups: dense enough to be useful, bounded enough for one call.
 */
const MAX_FIND_RADIUS = 32;

/** Names a block id back, when the dataset knows it. */
function describeBlock(id: number | null, index: ReturnType<typeof blockIdIndex>): { name: string | null; states: BlockStates | null } {
  if (id === null) return { name: null, states: null };
  const entry = index.byNetworkId(id);
  if (entry === undefined) return { name: null, states: null };
  return { name: entry.name, states: entry.states };
}

/** The note to attach when a reading is empty because the world is not loaded. */
function unknownNote(reading: UnknownReading): string | undefined {
  switch (reading.unknown) {
    case 'chunk_not_loaded':
      return `Chunk ${String(reading.chunk.x)},${String(reading.chunk.z)} has not been streamed to us, so this coordinate is unknown rather than empty. Use request_chunk_radius, then retry.`;
    case 'sub_chunk_missing':
      return 'The chunk is loaded but its payload carried no sub-chunk at this height, which usually means the server sends only the parts of the column that hold blocks.';
    case 'not_in_palette':
      return 'The palette for this sub-chunk did not cover the block index, so the server and this client disagree about the payload layout.';
    case 'no_biome_data':
      return 'The payload carried no biome section for this sub-chunk.';
    default:
      return undefined;
  }
}

const findBlockArgs = {
  sessionId: sessionIdSchema,
  block: z.string().optional().describe('Block name, with or without the namespace, e.g. "minecraft:diamond_ore" or "diamond_ore".'),
  blockId: z.number().int().optional().describe('Numeric network id, as reported by get_block_at. Use instead of `block`.'),
  states: z
    .record(z.string(), z.union([z.boolean(), z.number(), z.string()]))
    .optional()
    .describe('Block state to match, e.g. {"pillar_axis":"x"}. Defaults to the state-free variant of the name.'),
  radius: z
    .number()
    .int()
    .min(1)
    .max(MAX_FIND_RADIUS)
    .optional()
    .describe(`Half-extent of the cubic search box, in blocks. Defaults to 16, maximum ${String(MAX_FIND_RADIUS)}.`),
  origin: z
    .object({ x: z.number().int(), y: z.number().int(), z: z.number().int() })
    .optional()
    .describe('Centre of the search. Defaults to the player position.'),
  limit: z.number().int().min(1).max(200).optional().describe('Maximum matches to return, nearest first. Defaults to 20.'),
};

const biomeArgs = {
  sessionId: sessionIdSchema,
  ...blockPositionSchema.shape,
};

const nearbyBlocksArgs = {
  sessionId: sessionIdSchema,
  radius: z
    .number()
    .min(1)
    .max(64)
    .optional()
    .describe('Search radius in blocks around the player, measured in block-grid units. Defaults to 16.'),
  limit: z.number().int().min(1).max(500).optional().describe('Maximum number of blocks to return. Defaults to 100.'),
  onlyNonAir: z
    .boolean()
    .optional()
    .describe('Exclude block runtime ids of 0 (air), which is the usual case when looking for something to mine or stand on.'),
};

const breakBlockArgs = {
  sessionId: sessionIdSchema,
  x: z.number().int().describe('Block X coordinate.'),
  y: z.number().int().describe('Block Y coordinate.'),
  z: z.number().int().describe('Block Z coordinate.'),
  mode: z
    .enum(['auto', 'survival', 'creative'])
    .optional()
    .describe('Breaking strategy. "auto" (default) picks creative when the server reported creative game mode, survival otherwise.'),
  face: blockFaceSchema.optional().describe('Face to mine through. Defaults to the face closest to the player.'),
  timeoutMs: timeoutSchema,
};

const placeBlockArgs = {
  sessionId: sessionIdSchema,
  x: z.number().int().describe('X of the block where the new block should appear.'),
  y: z.number().int().describe('Y of the block where the new block should appear.'),
  z: z.number().int().describe('Z of the block where the new block should appear.'),
  againstX: z.number().int().optional().describe('X of the block to click. Defaults to a neighbour of the target that we have seen.'),
  againstY: z.number().int().optional().describe('Y of the block to click.'),
  againstZ: z.number().int().optional().describe('Z of the block to click.'),
  face: blockFaceSchema.optional().describe('Which face of the clicked block to place on. Defaults to the face pointing at the target.'),
  hotbarSlot: z
    .number()
    .int()
    .min(0)
    .max(8)
    .optional()
    .describe('Hotbar slot holding the block to place. Defaults to the currently selected slot.'),
  itemNetworkId: z
    .number()
    .int()
    .optional()
    .describe(
      'Item runtime id to place, when our inventory snapshot does not know what is in hand. Bedrock items are numeric runtime ids resolved from the item_registry packet.',
    ),
  timeoutMs: timeoutSchema,
};

export function registerWorldTools(registry: ToolRegistry, context: McpContext): void {
  registry.define(
    {
      name: 'get_nearby_blocks',
      title: 'List nearby known blocks',
      description:
        'Lists blocks near the player whose state the server has explicitly reported (via update_block or update_subchunk_blocks), sorted by distance. This is a delta view, not a full chunk dump: it is ideal for verifying a change you just made, and inconclusive about untouched terrain.',
      inputSchema: nearbyBlocksArgs,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(context, 'get_nearby_blocks', (args: z.infer<z.ZodObject<typeof nearbyBlocksArgs>>): unknown => {
      const session = resolveConnectedSession(context, args.sessionId);
      const blocks = session.client.session.getNearbyTrackedBlocks({
        ...(args.radius !== undefined ? { radius: args.radius } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      const filtered = args.onlyNonAir === true ? blocks.filter((block) => block.blockRuntimeId !== 0) : blocks;
      return {
        sessionId: session.id,
        origin: session.client.session.position,
        count: filtered.length,
        note: 'Blocks are identified by numeric runtime id; air is 0. Absence of a block means "the server has not told us about it", not "it is air".',
        blocks: filtered,
      };
    }),
  );

  registry.define(
    {
      name: 'get_block_at',
      title: 'Get the block at a coordinate',
      description:
        'Returns the block at a coordinate, from the decoded terrain of the chunk it sits in, or from the update the server sent for it if there was one — the server always wins, because it is right and the chunk payload may be stale. The result reports which source answered, a name when the id can be resolved, and whether the coordinate is merely unknown (chunk not streamed) rather than air.',
      inputSchema: { ...blockPositionSchema.shape, sessionId: sessionIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(
      context,
      'get_block_at',
      (args: z.infer<z.ZodObject<typeof blockPositionSchema.shape & { sessionId: z.ZodOptional<z.ZodString> }>>): unknown => {
        // The server's own updates win even for a loaded chunk: it is right and the
        // payload is a snapshot from before the change.

        const session = resolveConnectedSession(context, args.sessionId);
        const state = session.client.session;
        const position = { x: args.x, y: args.y, z: args.z };
        const reading = readBlock(state.chunks, state.blocks, position);
        const index = blockIdIndex(state.connection.version);
        const described = describeBlock(reading.blockRuntimeId, index);
        return {
          sessionId: session.id,
          position,
          known: reading.blockRuntimeId !== null,
          blockRuntimeId: reading.blockRuntimeId,
          name: described.name,
          states: described.states,
          source: reading.source,
          layer: reading.source === null ? null : reading.layer,
          observedAt: reading.observedAt,
          chunk: reading.chunk,
          unknown: reading.unknown,
          note:
            unknownNote(reading) ??
            (described.name === null ? 'The id is not one this client can name; the dataset does not list it.' : undefined),
        };
      },
    ),
  );

  registry.define(
    {
      name: 'find_block',
      title: 'Find blocks of a kind nearby',
      description:
        'Searches the decoded terrain around a point for blocks of a given name or numeric id, nearest first. Unlike get_nearby_blocks this covers untouched terrain, because it reads the chunk payloads — so it can answer "where is the nearest diamond ore?" — but only as far as chunks have been streamed, and the coverage numbers say how much of the box that covered. Block names are hashed to their network id, which is how Bedrock identifies blocks on the wire.',
      inputSchema: findBlockArgs,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(context, 'find_block', (args: z.infer<z.ZodObject<typeof findBlockArgs>>): unknown => {
      const session = resolveConnectedSession(context, args.sessionId);
      const state = session.client.session;
      if ((args.block === undefined) === (args.blockId === undefined)) {
        throw new Error('Provide exactly one of `block` (a name) or `blockId` (a numeric network id).');
      }

      const index = blockIdIndex(state.connection.version);
      let searchedIds: number[];
      let resolvedFrom: 'name' | 'id';
      if (args.blockId !== undefined) {
        searchedIds = [args.blockId];
        resolvedFrom = 'id';
      } else {
        const states = (args.states ?? {}) as BlockStates;
        const entry = index.resolve(args.block ?? '', states);
        if (entry === undefined) {
          throw new Error(
            `No block named "${args.block ?? ''}" is known to this client. Names are resolved against minecraft-data's block list for Bedrock; try the namespaced form ("minecraft:stone").`,
          );
        }
        // A name with no states registered may still be a block whose variants all
        // carry states; searching its default variant is the honest best effort.
        searchedIds = index.byIdentifier(args.block ?? '').map((variant) => variant.id);
        if (searchedIds.length === 0) searchedIds = [entry.id];
        resolvedFrom = 'name';
      }

      const origin = args.origin ?? (state.position === null ? null : state.position);
      if (origin === null) {
        throw new Error('No origin: pass `origin`, or move the agent first so its position is known.');
      }
      const center = { x: Math.floor(origin.x), y: Math.floor(origin.y), z: Math.floor(origin.z) };
      const radius = args.radius ?? 16;
      const result = findBlocks({
        chunks: state.chunks,
        overrides: state.blocks,
        center,
        radius,
        blockRuntimeIds: searchedIds,
        limit: args.limit ?? 20,
      });

      const matches = result.matches.map((match) => {
        const described = describeBlock(match.blockRuntimeId, index);
        return {
          position: match.position,
          blockRuntimeId: match.blockRuntimeId,
          name: described.name,
          states: described.states,
          source: match.source,
          distance: Math.round(match.distance * 100) / 100,
          centre: blockCentre(match.position),
        };
      });

      const notes: string[] = [];
      if (result.chunksMissing > 0) {
        notes.push(
          `${String(result.chunksMissing)} of ${String(result.chunksCovered)} chunks in the box had not been streamed, so a miss says nothing about them.`,
        );
      }
      if (result.truncated) notes.push('Match list was cut off by `limit`; raise it to see more.');
      if (matches.length === 0 && result.notSeen.length > 0 && resolvedFrom === 'name') {
        notes.push(
          `None of the ids this name hashes to (${result.notSeen.join(', ')}) appeared in the loaded part of the box. That is either "the block is not here" or a state variant whose id this client computed differently — pass the exact \`states\` if the block has any.`,
        );
      }

      return {
        sessionId: session.id,
        center,
        radius,
        resolvedFrom,
        searchedIds,
        count: matches.length,
        matches,
        scanned: result.scanned,
        chunksCovered: result.chunksCovered,
        chunksMissing: result.chunksMissing,
        truncated: result.truncated,
        notes,
      };
    }),
  );

  registry.define(
    {
      name: 'get_biome',
      title: 'Get the biome at a coordinate',
      description:
        "Returns the biome the server wrote into the chunk for a position, which is what the game itself uses for weather, mob spawning and grass colour. Names come from the server's own biome_definition_list, so the id is only named when the server also said which biome that id is; a server that announces biomes without ids (some servers do) yields the raw number and no name.",
      inputSchema: biomeArgs,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(context, 'get_biome', (args: z.infer<z.ZodObject<typeof biomeArgs>>): unknown => {
      const session = resolveConnectedSession(context, args.sessionId);
      const state = session.client.session;
      const position = { x: args.x, y: args.y, z: args.z };
      const reading = readBiome(state.chunks, position);
      const name = reading.biomeId === null ? undefined : state.biomes.get(reading.biomeId);
      return {
        sessionId: session.id,
        position,
        known: reading.biomeId !== null,
        biomeId: reading.biomeId,
        name: name ?? null,
        chunk: reading.chunk,
        unknown: reading.unknown,
        named: name !== undefined,
        note:
          unknownNote(reading) ??
          (name === undefined
            ? `The server named ${String(state.biomes.size)} biome id(s); ${String(reading.biomeId)} is not one of them. Whether that is a real biome this client cannot name, a stub world generator, or a custom biome is not something the payload says.`
            : undefined),
      };
    }),
  );

  registry.define(
    {
      name: 'break_block',
      title: 'Break a block',
      description:
        'Mines a block and waits for the server to confirm it is gone. In survival the sequence is start_break then stop_break; in creative a single creative_player_destroy_block is sent. Confirmation is the update_block packet for that coordinate, so `confirmed: true` means the block really changed. Survival mining that depends on accumulated crack time may be rejected by strict servers.',
      inputSchema: breakBlockArgs,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handle(context, 'break_block', async (args: z.infer<z.ZodObject<typeof breakBlockArgs>>): Promise<unknown> => {
      const session = resolveConnectedSession(context, args.sessionId);
      const result = await session.actions.breakBlock(
        { x: args.x, y: args.y, z: args.z },
        {
          ...(args.mode !== undefined ? { mode: args.mode } : {}),
          ...(args.face !== undefined ? { face: args.face } : {}),
          ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        },
      );
      return { sessionId: session.id, ...result };
    }),
  );

  registry.define(
    {
      name: 'place_block',
      title: 'Place a block',
      description:
        'Places the held item into a target block position, by clicking an adjacent block. Bedrock expresses placement as "use item on block", so the clicked block and face are derived automatically from the target unless you pass againstX/againstY/againstZ and face explicitly. Confirmed by the update_block the server sends for the target position.',
      inputSchema: placeBlockArgs,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handle(context, 'place_block', async (args: z.infer<z.ZodObject<typeof placeBlockArgs>>): Promise<unknown> => {
      const session = resolveConnectedSession(context, args.sessionId);
      const against =
        args.againstX !== undefined && args.againstY !== undefined && args.againstZ !== undefined
          ? { x: args.againstX, y: args.againstY, z: args.againstZ }
          : undefined;
      const result = await session.actions.placeBlock(
        { x: args.x, y: args.y, z: args.z },
        {
          ...(against !== undefined ? { against } : {}),
          ...(args.face !== undefined ? { face: args.face } : {}),
          ...(args.hotbarSlot !== undefined ? { hotbarSlot: args.hotbarSlot } : {}),
          ...(args.itemNetworkId !== undefined ? { itemNetworkId: args.itemNetworkId } : {}),
          ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        },
      );
      return { sessionId: session.id, ...result };
    }),
  );

  registry.define(
    {
      name: 'abort_break',
      title: 'Abort an in-progress block break',
      description:
        'Sends abort_break, which cancels a mining action the server still thinks is running. Use it to unstick a session after a failed or timed-out break_block.',
      inputSchema: { ...blockPositionSchema.shape, sessionId: sessionIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(
      context,
      'abort_break',
      async (
        args: z.infer<z.ZodObject<typeof blockPositionSchema.shape & { sessionId: z.ZodOptional<z.ZodString> }>>,
      ): Promise<unknown> => {
        const session = resolveConnectedSession(context, args.sessionId);
        const result = await session.actions.abortBreak({ x: args.x, y: args.y, z: args.z });
        return { sessionId: session.id, ...result };
      },
    ),
  );

  registry.define(
    {
      name: 'request_chunk_radius',
      title: 'Request more chunks',
      description:
        'Asks the server to stream chunks within a wider radius. Servers cap this; the response reports the radius actually granted, which also tells you how much of the world the server considers relevant to this player.',
      inputSchema: {
        sessionId: sessionIdSchema,
        chunkRadius: z.number().int().min(1).max(64).describe('Requested view radius in chunks.'),
        timeoutMs: timeoutSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(
      context,
      'request_chunk_radius',
      async (args: { sessionId?: string; chunkRadius: number; timeoutMs?: number }): Promise<unknown> => {
        const session = resolveConnectedSession(context, args.sessionId);
        const result = await session.actions.requestChunkRadius(
          args.chunkRadius,
          args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
        );
        return { sessionId: session.id, ...result };
      },
    ),
  );
}
