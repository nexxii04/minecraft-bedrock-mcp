/**
 * Reading the world: what block is at a coordinate, and where a block is.
 *
 * A session knows about blocks from two places with different authority:
 * `update_block`/`update_subchunk_blocks` (the server explicitly said a coordinate
 * changed — authoritative) and decoded chunk palettes (streamed terrain — complete
 * for a loaded chunk, but stale once the server changes a block without re-sending
 * it). `readBlock` consults the server's statement first, falls back to terrain,
 * and always says which answered, so an assertion can tell "server confirmed" from
 * "we never saw a change".
 *
 * An id of `null` is not air: the session cannot speak to that coordinate yet, and
 * `unknown` says why (chunk never streamed, sub-chunk missing, value outside the
 * palette). Treating "unknown" as "empty" produces false passes.
 */

import type { BlockPosition } from '../types.js';
import { readSubChunkBiome, readSubChunkBlock, splitChunkPosition, subChunkIndexOf } from './chunk.js';
import { chunkKey, type TrackedChunk } from './events.js';
import { blockKey } from './vec3.js';

/** Decoded chunks held by a session, keyed by `"chunkX,chunkZ"`. */
export type ChunkCache = Map<string, TrackedChunk>;

/** Blocks the server reported as changed, keyed by the same key `blockKey` uses. */
export type BlockOverrides = Map<string, { blockRuntimeId: number; layer: number; at?: number }>;

/** Where a block reading came from. */
export type BlockSource = 'server' | 'chunk';

/** Why a block reading could not be answered. */
export type BlockUnknown = 'chunk_not_loaded' | 'sub_chunk_missing' | 'not_in_palette';

/** Everything a terrain reading can be missing: block reasons, plus a payload with no biome section. */
export type TerrainUnknown = BlockUnknown | 'no_biome_data';

/** The part of a reading that says why it is empty, shared by blocks and biomes. */
export interface UnknownReading {
  unknown: TerrainUnknown | null;
  chunk: { x: number; z: number };
}

export interface BlockReading {
  position: BlockPosition;
  /** Network id of the block, or `null` when the session cannot say. */
  blockRuntimeId: number | null;
  /** Which source answered; `null` when nothing did. */
  source: BlockSource | null;
  /** Set only when `blockRuntimeId` is `null`. */
  unknown: BlockUnknown | null;
  /** Layer the value came from: 1 carries waterlogging and snow. */
  layer: number;
  /** The chunk the reading needed, whether or not it was loaded. */
  chunk: { x: number; z: number };
  /** When the server reported the change, for a `server` reading. */
  observedAt: number | null;
}

/** Reads one block, preferring what the server said over what the terrain implied. */
export function readBlock(chunks: ChunkCache, overrides: BlockOverrides, position: BlockPosition): BlockReading {
  const { chunkX, chunkZ } = splitChunkPosition(position);
  const base: Omit<BlockReading, 'blockRuntimeId' | 'source' | 'unknown' | 'layer' | 'observedAt'> = {
    position,
    chunk: { x: chunkX, z: chunkZ },
  };

  const override = overrides.get(blockKey(position));
  if (override !== undefined) {
    return {
      ...base,
      blockRuntimeId: override.blockRuntimeId,
      source: 'server',
      unknown: null,
      layer: override.layer,
      observedAt: override.at ?? null,
    };
  }

  const chunk = chunks.get(chunkKey(chunkX, chunkZ));
  if (chunk === undefined) {
    return { ...base, blockRuntimeId: null, source: null, unknown: 'chunk_not_loaded', layer: 0, observedAt: null };
  }

  const subChunk = chunk.slices.get(subChunkIndexOf(position.y));
  if (subChunk === undefined) {
    return { ...base, blockRuntimeId: null, source: null, unknown: 'sub_chunk_missing', layer: 0, observedAt: null };
  }

  const value = readSubChunkBlock(subChunk, position.x & 0xf, position.y & 0xf, position.z & 0xf, 0);
  if (value === null) {
    return { ...base, blockRuntimeId: null, source: null, unknown: 'not_in_palette', layer: 0, observedAt: null };
  }
  return { ...base, blockRuntimeId: value, source: 'chunk', unknown: null, layer: 0, observedAt: null };
}

export interface BiomeReading {
  position: BlockPosition;
  /** Biome id the server wrote into the chunk, or `null` when unknown. */
  biomeId: number | null;
  unknown: TerrainUnknown | null;
  chunk: { x: number; z: number };
}

/** Reads the biome the server declared for a position's sub-chunk. */
export function readBiome(chunks: ChunkCache, position: BlockPosition): BiomeReading {
  const { chunkX, chunkZ } = splitChunkPosition(position);
  const base = { position, chunk: { x: chunkX, z: chunkZ } };

  const chunk = chunks.get(chunkKey(chunkX, chunkZ));
  if (chunk === undefined) return { ...base, biomeId: null, unknown: 'chunk_not_loaded' };
  const subChunk = chunk.slices.get(subChunkIndexOf(position.y));
  if (subChunk === undefined) return { ...base, biomeId: null, unknown: 'sub_chunk_missing' };
  if (subChunk.biomes === null) return { ...base, biomeId: null, unknown: 'no_biome_data' };
  const value = readSubChunkBiome(subChunk, position.x & 0xf, position.y & 0xf, position.z & 0xf);
  return value === null ? { ...base, biomeId: null, unknown: 'not_in_palette' } : { ...base, biomeId: value, unknown: null };
}

export interface FindBlocksOptions {
  chunks: ChunkCache;
  overrides: BlockOverrides;
  center: BlockPosition;
  /** Half-extent, in blocks, of a cube around `center`. */
  radius: number;
  /** Network ids to match, in either the server's or the palette's numbering. */
  blockRuntimeIds: readonly number[];
  /** Maximum matches to return, nearest first. */
  limit: number;
}

export interface FoundBlock {
  position: BlockPosition;
  blockRuntimeId: number;
  source: BlockSource;
  /** Straight-line distance from `center`, in blocks. */
  distance: number;
}

export interface FindBlocksResult {
  matches: FoundBlock[];
  /** Positions examined: the volume of the search box. */
  scanned: number;
  /** Chunks the box touched. */
  chunksCovered: number;
  /** Of those, the ones that had not been streamed — they cannot be searched. */
  chunksMissing: number;
  /** True when the match list was cut off by `limit`. */
  truncated: boolean;
  /** Ids that were searched for and found nowhere in the loaded part of the box. */
  notSeen: number[];
}

/**
 * Finds blocks of the given ids inside a cube, nearest first. Scans decoded terrain
 * plus the server's change list, so a broken block is not found even though the
 * chunk still holds it. `chunksMissing` reports whether the box was fully loaded,
 * because a miss in unstreamed terrain means nothing.
 */
export function findBlocks(options: FindBlocksOptions): FindBlocksResult {
  const { center, radius } = options;
  const wanted = new Set(options.blockRuntimeIds);
  const matches: FoundBlock[] = [];
  const seen = new Set<number>();
  const chunksTouched = new Set<string>();
  let chunksMissing = 0;
  let scanned = 0;
  let truncated = false;

  for (let y = center.y - radius; y <= center.y + radius; y += 1) {
    for (let x = center.x - radius; x <= center.x + radius; x += 1) {
      for (let z = center.z - radius; z <= center.z + radius; z += 1) {
        const position = { x, y, z };
        const reading = readBlock(options.chunks, options.overrides, position);
        scanned += 1;
        const chunkId = `${String(reading.chunk.x)},${String(reading.chunk.z)}`;
        if (!chunksTouched.has(chunkId)) {
          chunksTouched.add(chunkId);
          if (reading.unknown === 'chunk_not_loaded') chunksMissing += 1;
        }
        if (reading.blockRuntimeId === null || !wanted.has(reading.blockRuntimeId)) continue;
        seen.add(reading.blockRuntimeId);
        if (matches.length >= options.limit) {
          // Keep scanning for coverage numbers, but stop collecting: the list is
          // already sorted later, so more matches would not change the answer.
          truncated = true;
          continue;
        }
        matches.push({
          position,
          blockRuntimeId: reading.blockRuntimeId,
          source: reading.source ?? 'chunk',
          distance: Math.sqrt((x - center.x) ** 2 + (y - center.y) ** 2 + (z - center.z) ** 2),
        });
      }
    }
  }

  matches.sort((left, right) => left.distance - right.distance);
  return {
    matches,
    scanned,
    chunksCovered: chunksTouched.size,
    chunksMissing,
    truncated,
    notSeen: options.blockRuntimeIds.filter((id) => !seen.has(id)),
  };
}
