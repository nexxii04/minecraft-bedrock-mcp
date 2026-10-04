import { describe, expect, it } from 'vitest';

import { decodeChunkData } from '../../src/bedrock/chunk.js';
import { chunkKey, type TrackedChunk } from '../../src/bedrock/events.js';
import { findBlocks, readBiome, readBlock, type BlockOverrides, type ChunkCache } from '../../src/bedrock/terrain.js';
import { blockKey } from '../../src/bedrock/vec3.js';
import { encodeChunkPayload, paletteStorage, uniformStorage } from '../helpers/chunk-encoder.js';

/**
 * Tests for reading the world.
 *
 * Fixtures are decoded from payloads encoded the way a server would write them, so
 * these exercise the path a tool takes: chunk bytes in, block out. They pin down the
 * *provenance* rules — which source wins, what "unknown" means, and that a search
 * says how much of its box it could see.
 */

const AIR = 3690217760;
const STONE = 2150698529;
const DIRT = 2186211206;
const GRASS = 3727763636;
const DIAMOND_ORE = 2127435560;

/** Local index packing, matching the decoder's layout. */
function place(values: number[], x: number, y: number, z: number, index: number): number[] {
  const next = [...values];
  next[(x << 8) | (z << 4) | y] = index;
  return next;
}

/**
 * One chunk at (0,0) with two sub-chunks: floor slice holding dirt under a grass
 * surface, and the slice above holding a stone column with one diamond ore.
 */
function cacheWithOneChunk(): ChunkCache {
  const lower = place(new Array<number>(4096).fill(0), 8, 0, 8, 2);
  // The slice above is stone throughout, with one ore three blocks up.
  const upper = place(new Array<number>(4096).fill(1), 8, 1, 8, 3);
  const payload = encodeChunkPayload({
    subChunks: [
      { index: -4, layers: [paletteStorage(lower, [AIR, DIRT, GRASS])], biomes: uniformStorage(64) },
      { index: -3, layers: [paletteStorage(upper, [AIR, STONE, STONE, DIAMOND_ORE])], biomes: uniformStorage(1) },
    ],
  });
  const decoded = decodeChunkData(payload, { subChunkCount: 2, dimension: 'overworld' });
  const chunk: TrackedChunk = {
    chunkX: 0,
    chunkZ: 0,
    dimension: 'overworld',
    decoded,
    slices: new Map(decoded.subChunks.map((subChunk) => [subChunk.index, subChunk])),
    at: Date.now(),
  };
  return new Map([[chunkKey(0, 0), chunk]]);
}

const emptyOverrides: BlockOverrides = new Map();

describe('readBlock', () => {
  it('answers from the terrain for a coordinate the server never mentioned', () => {
    const reading = readBlock(cacheWithOneChunk(), emptyOverrides, { x: 8, y: -64, z: 8 });
    expect(reading.blockRuntimeId).toBe(GRASS);
    expect(reading.source).toBe('chunk');
    expect(reading.unknown).toBeNull();
  });

  it("prefers the server's own statement over the chunk payload", () => {
    // A block the server reported as changed after the chunk was streamed. The
    // payload still holds the old block, and the server is right.
    const overrides: BlockOverrides = new Map([[blockKey({ x: 8, y: -64, z: 8 }), { blockRuntimeId: AIR, layer: 0, at: 123 }]]);
    const reading = readBlock(cacheWithOneChunk(), overrides, { x: 8, y: -64, z: 8 });

    expect(reading.blockRuntimeId).toBe(AIR);
    expect(reading.source).toBe('server');
    expect(reading.observedAt).toBe(123);
  });

  it('says the coordinate is unknown rather than empty', () => {
    const chunks = cacheWithOneChunk();
    const chunksLoaded = readBlock(chunks, emptyOverrides, { x: 8, y: -64, z: 8 });
    expect(chunksLoaded.unknown).toBeNull();

    const notLoaded = readBlock(chunks, emptyOverrides, { x: 100, y: -64, z: 8 });
    expect(notLoaded.blockRuntimeId).toBeNull();
    expect(notLoaded.unknown).toBe('chunk_not_loaded');
    expect(notLoaded.chunk).toEqual({ x: 6, z: 0 });

    // Above the top of the payload: loaded chunk, missing slice.
    const missingSlice = readBlock(chunks, emptyOverrides, { x: 8, y: 64, z: 8 });
    expect(missingSlice.blockRuntimeId).toBeNull();
    expect(missingSlice.unknown).toBe('sub_chunk_missing');
  });
});

describe('findBlocks', () => {
  it('finds blocks in untouched terrain, nearest first', () => {
    const result = findBlocks({
      chunks: cacheWithOneChunk(),
      overrides: emptyOverrides,
      center: { x: 8, y: -48, z: 8 },
      radius: 3,
      blockRuntimeIds: [STONE],
      limit: 10,
    });

    // The whole upper slice is stone except one ore, so a 7x7x7 box is full of it.
    expect(result.matches.length).toBe(10);
    expect(result.truncated).toBe(true);
    expect(result.notSeen).toEqual([]);
    expect(result.chunksCovered).toBe(1);
    expect(result.chunksMissing).toBe(0);
    for (const match of result.matches) {
      expect(match.blockRuntimeId).toBe(STONE);
      expect(match.source).toBe('chunk');
    }
    const distances = result.matches.map((match) => match.distance);
    expect([...distances].sort((left, right) => left - right)).toEqual(distances);
  });

  it('does not report a block the server said is gone', () => {
    const overrides: BlockOverrides = new Map([[blockKey({ x: 8, y: -47, z: 8 }), { blockRuntimeId: AIR, layer: 0, at: 1 }]]);
    const result = findBlocks({
      chunks: cacheWithOneChunk(),
      overrides,
      center: { x: 8, y: -47, z: 8 },
      radius: 0,
      blockRuntimeIds: [DIAMOND_ORE],
      limit: 5,
    });

    expect(result.matches).toHaveLength(0);
    expect(result.notSeen).toEqual([DIAMOND_ORE]);
  });

  it('reports how much of the box it could actually see', () => {
    const result = findBlocks({
      chunks: cacheWithOneChunk(),
      overrides: emptyOverrides,
      center: { x: 40, y: -64, z: 40 },
      radius: 2,
      blockRuntimeIds: [DIRT],
      limit: 5,
    });

    expect(result.matches).toHaveLength(0);
    // A miss here means nothing: the box sits in one chunk, and it is not loaded.
    expect(result.chunksCovered).toBe(1);
    expect(result.chunksMissing).toBe(1);
    expect(result.scanned).toBe(5 ** 3);
  });
});

describe('readBiome', () => {
  it('reads the biome the server wrote for the slice', () => {
    const chunks = cacheWithOneChunk();
    expect(readBiome(chunks, { x: 8, y: -64, z: 8 }).biomeId).toBe(64);
    expect(readBiome(chunks, { x: 8, y: -40, z: 8 }).biomeId).toBe(1);
  });

  it('separates a missing chunk from a payload with no biome section', () => {
    // The second sub-chunk carries no block data, so it carries no biome section
    // either: a biome reading there is "the server did not say", not a biome id.
    const payload = encodeChunkPayload({
      subChunks: [
        { index: -4, layers: [paletteStorage(new Array<number>(4096).fill(0), [AIR])], biomes: uniformStorage(64) },
        { index: -3, layers: [] },
      ],
    });
    const decoded = decodeChunkData(payload, { subChunkCount: 2, dimension: 'overworld' });
    expect(decoded.consistent).toBe(true);
    const chunk: TrackedChunk = {
      chunkX: 0,
      chunkZ: 0,
      dimension: 'overworld',
      decoded,
      slices: new Map(decoded.subChunks.map((subChunk) => [subChunk.index, subChunk])),
      at: 0,
    };
    const chunks: ChunkCache = new Map([[chunkKey(0, 0), chunk]]);

    expect(readBiome(chunks, { x: 1, y: -64, z: 1 }).biomeId).toBe(64);
    expect(readBiome(chunks, { x: 1, y: -48, z: 1 }).unknown).toBe('no_biome_data');
    expect(readBiome(chunks, { x: 1, y: -64, z: 40 }).unknown).toBe('chunk_not_loaded');
  });
});
