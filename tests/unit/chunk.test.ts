import { describe, expect, it } from 'vitest';

import {
  decodeChunkData,
  dimensionFromId,
  readStorageEntry,
  readSubChunkBiome,
  readSubChunkBlock,
  splitChunkPosition,
  subChunkBaseY,
  subChunkIndexOf,
  subChunkOffset,
} from '../../src/bedrock/chunk.js';
import { encodeChunkPayload, paletteStorage, type EncodableSubChunk } from '../helpers/chunk-encoder.js';

/**
 * Tests for the `level_chunk` payload decoder.
 *
 * A chunk payload is opaque to the protocol library, so the only way to prove the
 * reader is to encode a payload with known contents and read it back. The encoder is
 * written from the same documented layout on purpose: if the two disagree, these
 * tests fail. All three decoder verdicts matter: a clean chunk is queryable, an
 * inconsistent one is a finding about the server, and an unreadable one must not
 * take the session down.
 */

/** Places a palette index at local block coordinates inside a 16x16x16 slice. */
function withBlockAt(values: number[], x: number, y: number, z: number, index: number): number[] {
  const next = [...values];
  next[(x << 8) | (z << 4) | y] = index;
  return next;
}

/** Fills a slice with one palette index, then sets the listed blocks to another. */
function sliceWith(airIndex: number, blocks: { x: number; y: number; z: number; index: number }[]): number[] {
  let values = new Array<number>(4096).fill(airIndex);
  for (const block of blocks) values = withBlockAt(values, block.x, block.y, block.z, block.index);
  return values;
}

const AIR = 3690217760;
const DIRT = 2186211206;
const GRASS = 3727763636;

function twoSliceChunk(): EncodableSubChunk[] {
  return [
    {
      index: -4,
      layers: [paletteStorage(sliceWith(1, [{ x: 0, y: 0, z: 0, index: 2 }]), [AIR, AIR, DIRT])],
      biomes: paletteStorage(sliceWith(0, []), [64]),
    },
    {
      index: -3,
      layers: [paletteStorage(sliceWith(1, [{ x: 3, y: 0, z: 7, index: 2 }]), [AIR, AIR, GRASS])],
      biomes: paletteStorage(sliceWith(0, []), [64]),
    },
  ];
}

describe('decodeChunkData', () => {
  it('reads blocks and biomes at the coordinates they were written to', () => {
    const decoded = decodeChunkData(encodeChunkPayload({ subChunks: twoSliceChunk() }), {
      subChunkCount: 2,
      dimension: 'overworld',
    });

    expect(decoded.error).toBeNull();
    expect(decoded.consistent).toBe(true);
    expect(decoded.leftoverBytes).toBe(0);

    const lower = decoded.subChunks[0];
    const upper = decoded.subChunks[1];
    expect(lower?.index).toBe(-4);
    expect(upper?.index).toBe(-3);
    // Floor slice of the overworld: y = -64 is local y = 0.
    expect(readSubChunkBlock(lower!, 0, 0, 0)).toBe(DIRT);
    expect(readSubChunkBlock(lower!, 1, 0, 0)).toBe(AIR);
    // Second slice: y = -48 is local y = 0 there.
    expect(readSubChunkBlock(upper!, 3, 0, 7)).toBe(GRASS);
    expect(readSubChunkBiome(lower!, 0, 0, 0)).toBe(64);
  });

  it('reports a payload that does not end where the format says', () => {
    const decoded = decodeChunkData(encodeChunkPayload({ subChunks: twoSliceChunk(), trailingBytes: 4 }), {
      subChunkCount: 2,
      dimension: 'overworld',
    });

    // Not an error, a verdict: the blocks are readable, the shape is wrong.
    expect(decoded.error).toBeNull();
    expect(decoded.consistent).toBe(false);
    expect(decoded.leftoverBytes).toBe(4);
  });

  it('reports a payload it cannot read at all instead of throwing', () => {
    const full = encodeChunkPayload({ subChunks: twoSliceChunk() });
    const decoded = decodeChunkData(full.subarray(0, 12), { subChunkCount: 2, dimension: 'overworld' });

    expect(decoded.error).not.toBeNull();
    expect(decoded.consistent).toBe(false);
    expect(decoded.subChunks).toEqual([]);
  });

  it('falls back to the other biome layout when the first does not line up', () => {
    // A blockless sub-chunk that still carries biomes is where the two servers'
    // conventions diverge: under the "only sub-chunks with layers" rule the biome
    // section is unmatched, and the payload only ends cleanly under the other one.
    const payload = encodeChunkPayload({
      subChunks: [
        { index: -4, layers: [paletteStorage(sliceWith(0, []), [AIR])], biomes: paletteStorage(sliceWith(0, []), [1]) },
        { index: -3, layers: [], biomes: paletteStorage(sliceWith(0, []), [2]) },
      ],
    });
    const decoded = decodeChunkData(payload, { subChunkCount: 2, dimension: 'overworld' });

    expect(decoded.error).toBeNull();
    expect(decoded.consistent).toBe(true);
    expect(decoded.biomeRule).toBe('all');
  });

  it('returns null for an index outside the palette rather than a wrong block', () => {
    const storage = paletteStorage(sliceWith(3, []), [AIR]);
    // A two-entry palette cannot cover index 3: the write above packed 3 into one
    // bit, so the reader sees 1, which is outside a one-entry palette.
    expect(readStorageEntry(storage, 0)).toBeNull();
    expect(readStorageEntry(null, 0)).toBeNull();
  });
});

describe('chunk coordinate helpers', () => {
  it('maps world positions onto chunks the way the game does', () => {
    expect(splitChunkPosition({ x: 0, y: -64, z: 0 })).toEqual({ chunkX: 0, chunkZ: 0, localX: 0, localY: 0, localZ: 0 });
    expect(splitChunkPosition({ x: 17, y: -63, z: -1 })).toEqual({
      chunkX: 1,
      chunkZ: -1,
      localX: 1,
      localY: 1,
      localZ: 15,
    });
  });

  it('puts -64 in the first sub-chunk of the overworld and nowhere else', () => {
    expect(subChunkIndexOf(-64)).toBe(-4);
    expect(subChunkBaseY(-4)).toBe(-64);
    expect(subChunkOffset('overworld')).toBe(4);
    expect(subChunkOffset('nether')).toBe(0);
  });

  it('reads dimension ids as senders write them', () => {
    expect(dimensionFromId(0)).toBe('overworld');
    expect(dimensionFromId(1)).toBe('nether');
    expect(dimensionFromId(2)).toBe('end');
    expect(dimensionFromId(9)).toBe('unknown');
  });
});
