/**
 * Decoder for the `level_chunk` payload: the real terrain behind a chunk.
 *
 * Terrain arrives only here; other packets report just the blocks the server
 * volunteers. A payload is three concatenated sections: one *sub-chunk* per
 * 16-block vertical slice (in order), one biome section per sub-chunk, then a
 * border-block count byte (`0` in every world seen).
 *
 * A sub-chunk is `version`, `layerCount`, `index` (version 9 only) then one
 * paletted storage per layer. `index` is the slice relative to the dimension's
 * floor, so base Y is `index * 16` (the overworld's -4 is -64). Layer 0 is the
 * block, layer 1 waterlogging/snow. A storage is a header byte
 * (`bitsPerEntry << 1`, bit 0 marking the *network* block format), a packed bit
 * array, then a palette; a biome storage with `bitsPerEntry == 0` is a single raw
 * value. Entries are packed little-endian into 32-bit words (`floor(32 / bits)`
 * each) and extracted on demand, so a decoded chunk costs a few KB instead of
 * ~98 KB; block indices are `(x << 8) | (z << 4) | y`.
 *
 * Field order/encodings were read off the wire and cross-checked across server
 * implementations: `bedrock-protocol` treats the payload as opaque, so
 * minecraft-data says nothing about it.
 */

import type { BlockPosition, Dimension, Vec3 } from '../types.js';

/** Entries in one sub-chunk storage: 16 x 16 x 16. */
const STORAGE_SIZE = 4096;

/** Sub-chunks in a chunk column: 24 covers the 1.18+ overworld (-64..320). */
export const MAX_SUB_CHUNKS = 24;

/** Vertical sub-chunk offset per dimension: the overworld starts at y = -64. */
const SUB_CHUNK_OFFSET_OVERWORLD = 4;

export function subChunkOffset(dimension: Dimension): number {
  return dimension === 'overworld' ? SUB_CHUNK_OFFSET_OVERWORLD : 0;
}

/**
 * Maps the numeric dimension id a chunk packet carries onto our domain type:
 * `level_chunk`/`change_dimension` send a raw `zigzag32`, not the named mapper
 * `start_game` uses.
 */
export function dimensionFromId(value: unknown): Dimension {
  switch (value) {
    case 0:
      return 'overworld';
    case 1:
      return 'nether';
    case 2:
      return 'end';
    default:
      return 'unknown';
  }
}

/** One paletted storage: a packed bit array plus the values it indexes. */
export interface PalettedStorage {
  /** Bits per entry as the header claimed; `0` means "single value, no palette". */
  bitsPerEntry: number;
  /** Packed entries, one 32-bit word at a time. Empty when `bitsPerEntry` is 0. */
  words: Uint32Array;
  /** Values the packed entries index into. */
  palette: number[];
}

/** One decoded 16-block vertical slice of a chunk. */
export interface DecodedSubChunk {
  /**
   * Vertical slice number relative to the dimension's floor, as the payload
   * stated it. Absolute base Y is `index * 16`.
   */
  index: number;
  /** Layer 0 is the block itself; layer 1 carries waterlogging and snow. */
  layers: PalettedStorage[];
  /** Null when the payload carried no biome section for this sub-chunk. */
  biomes: PalettedStorage | null;
}

export interface DecodedChunk {
  subChunks: DecodedSubChunk[];
  /** Which sub-chunks the payload turned out to carry biomes for. */
  biomeRule: 'layers' | 'all';
  /**
   * `false` when the payload did not end exactly where the format says. An
   * inconsistent decode is a finding about the server, reported not thrown.
   */
  consistent: boolean;
  /** Bytes left unread after the border-block section; 0 in a clean decode. */
  leftoverBytes: number;
  /** Set when decoding could not proceed at all. */
  error: string | null;
}

/** Thrown when a payload runs out of bytes; caught by `decodeChunkData`. */
class ChunkDecodeError extends Error {}

/**
 * Byte cursor over a chunk payload. Kept private: callers see a decoded chunk or
 * a `consistent: false` verdict, never a half-consumed buffer.
 */
class Cursor {
  private offset = 0;

  constructor(private readonly buffer: Uint8Array) {}

  get remaining(): number {
    return this.buffer.length - this.offset;
  }

  private need(count: number): void {
    if (this.offset + count > this.buffer.length) {
      throw new ChunkDecodeError(`ran out of payload: wanted ${String(count)} more byte(s), ${String(this.remaining)} left`);
    }
  }

  uint8(): number {
    this.need(1);
    return this.buffer[this.offset++] ?? 0;
  }

  int8(): number {
    const value = this.uint8();
    return value > 127 ? value - 256 : value;
  }

  int32(): number {
    this.need(4);
    const base = this.offset;
    this.offset += 4;
    // `DataView` rather than manual byte maths: the buffer may be a Node
    // `Buffer` view into a shared pool, so its own `byteOffset` must be honoured.
    return new DataView(this.buffer.buffer, this.buffer.byteOffset + base, 4).getInt32(0, true);
  }

  /** Unsigned LEB128, the encoding Bedrock calls a "varint". */
  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.uint8();
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      if (shift > 35) throw new ChunkDecodeError('varint is longer than 5 bytes');
    }
  }

  /** A signed value encoded as `zigzag` then varint. */
  zigzagVarint(): number {
    const raw = this.varint();
    const magnitude = raw >>> 1;
    return (raw & 1) === 1 ? -magnitude - 1 : magnitude;
  }
}

/** Reads one paletted storage: header, packed words, palette. */
function readStorage(cursor: Cursor, isBlock: boolean): PalettedStorage {
  const header = cursor.uint8();
  const bitsPerEntry = header >> 1;

  // Biomes may collapse to a single value, written raw with no palette at all.
  if (!isBlock && bitsPerEntry === 0) {
    return { bitsPerEntry: 0, words: new Uint32Array(0), palette: [cursor.int32() >>> 0] };
  }
  if (bitsPerEntry < 1 || bitsPerEntry > 16) {
    throw new ChunkDecodeError(`unsupported bits-per-entry ${String(bitsPerEntry)} (header byte ${String(header)})`);
  }

  const entriesPerWord = Math.floor(32 / bitsPerEntry);
  const wordCount = Math.ceil(STORAGE_SIZE / entriesPerWord);
  const words = new Uint32Array(wordCount);
  for (let index = 0; index < wordCount; index += 1) {
    words[index] = cursor.int32() >>> 0;
  }

  const paletteLength = cursor.zigzagVarint();
  if (paletteLength < 0 || paletteLength > 65536) {
    throw new ChunkDecodeError(`implausible palette length ${String(paletteLength)}: the payload is out of step`);
  }
  // Palette entries are 32-bit values sent zigzag-encoded. Block network ids are
  // hashes that routinely have the top bit set, and biome ids are unsigned, so
  // normalise to unsigned — this makes a chunk value comparable with an
  // `update_block` packet's `block_runtime_id`.
  const palette: number[] = [];
  for (let index = 0; index < paletteLength; index += 1) palette.push(cursor.zigzagVarint() >>> 0);

  return { bitsPerEntry, words, palette };
}

/**
 * Extracts one entry from a paletted storage, or `null` for an index the palette
 * does not cover (so a short palette stays a missing block, not a crash).
 */
export function readStorageEntry(storage: PalettedStorage | null | undefined, entryIndex: number): number | null {
  if (storage === null || storage === undefined) return null;
  if (storage.bitsPerEntry === 0) return storage.palette[0] ?? null;
  if (entryIndex < 0 || entryIndex >= STORAGE_SIZE) return null;

  const entriesPerWord = Math.floor(32 / storage.bitsPerEntry);
  const wordIndex = Math.floor(entryIndex / entriesPerWord);
  const shift = (entryIndex % entriesPerWord) * storage.bitsPerEntry;
  const word = storage.words[wordIndex];
  if (word === undefined) return null;

  const mask = 2 ** storage.bitsPerEntry - 1;
  const paletteIndex = (word >>> shift) & mask;
  return storage.palette[paletteIndex] ?? null;
}

/** Packs local coordinates the way every Bedrock implementation does. */
function localIndex(x: number, y: number, z: number): number {
  return ((x & 0xf) << 8) | ((z & 0xf) << 4) | (y & 0xf);
}

/** The network block id at a position inside one sub-chunk, or null. */
export function readSubChunkBlock(subChunk: DecodedSubChunk, x: number, y: number, z: number, layer = 0): number | null {
  return readStorageEntry(subChunk.layers[layer], localIndex(x, y, z));
}

/** The biome id at a position inside one sub-chunk, or null. */
export function readSubChunkBiome(subChunk: DecodedSubChunk, x: number, y: number, z: number): number | null {
  return readStorageEntry(subChunk.biomes, localIndex(x, y, z));
}

export interface DecodeChunkOptions {
  /** Number of sub-chunks the `level_chunk` packet declared. */
  subChunkCount: number;
  /** Decides the vertical offset used when a payload omits sub-chunk indices. */
  dimension?: Dimension;
  /**
   * Which sub-chunks carry a biome section when the two readings disagree.
   *
   * `layers` — only sub-chunks that carried block data (a blockless sub-chunk
   * gets none). `all` — every declared sub-chunk, as some servers serialise. They
   * differ only for a blockless sub-chunk before the last one, so the decoder
   * tries one and falls back to the other; this is the one to try first.
   */
  biomeRule?: 'layers' | 'all';
}

/**
 * Decodes one `level_chunk` payload. Never throws: an unreadable payload is a
 * statement about the server that the caller should be able to report (with the
 * byte count it stopped at) rather than take the session down.
 */
export function decodeChunkData(data: Uint8Array, options: DecodeChunkOptions): DecodedChunk {
  const preferred = options.biomeRule ?? 'layers';
  const first = decodeWithBiomeRule(data, options, preferred);
  if (first.consistent || first.error !== null) return first;

  // The payload did not end where the format says. The only assumption that can be
  // wrong without another symptom is which sub-chunks carry biomes, so try the
  // other reading: if it lands exactly on the end of the buffer, that is the right
  // one. This lets one decoder read both styles.
  const alternate = decodeWithBiomeRule(data, options, preferred === 'layers' ? 'all' : 'layers');
  return alternate.consistent ? alternate : first;
}

/** One decoding attempt under a fixed biome rule. */
function decodeWithBiomeRule(data: Uint8Array, options: DecodeChunkOptions, biomeRule: 'layers' | 'all'): DecodedChunk {
  const subChunkCount = Math.max(0, Math.min(MAX_SUB_CHUNKS, Math.trunc(options.subChunkCount)));
  const offset = subChunkOffset(options.dimension ?? 'overworld');
  const cursor = new Cursor(data);

  try {
    const subChunks: DecodedSubChunk[] = [];
    for (let position = 0; position < subChunkCount; position += 1) {
      const version = cursor.uint8();
      const layerCount = cursor.uint8();
      // Version 8 predates the index byte; fall back to positional derivation.
      const index = version === 9 ? cursor.int8() : position - offset;
      if (version !== 8 && version !== 9) {
        throw new ChunkDecodeError(`unsupported sub-chunk format version ${String(version)}`);
      }

      const layers: PalettedStorage[] = [];
      for (let layer = 0; layer < layerCount; layer += 1) layers.push(readStorage(cursor, true));
      subChunks.push({ index, layers, biomes: null });
    }

    for (const subChunk of subChunks) {
      if (biomeRule === 'layers' && subChunk.layers.length === 0) continue;
      subChunk.biomes = readStorage(cursor, false);
    }

    // Border blocks: a count, then four varints each. The count is 0 everywhere
    // seen, but consuming it catches a desync.
    const borderBlocks = cursor.varint();
    for (let index = 0; index < borderBlocks * 4; index += 1) cursor.varint();

    return { subChunks, biomeRule, consistent: cursor.remaining === 0, leftoverBytes: cursor.remaining, error: null };
  } catch (error) {
    return {
      subChunks: [],
      biomeRule,
      consistent: false,
      leftoverBytes: cursor.remaining,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Splits a world position into chunk coordinates and in-chunk offsets. */
export function splitChunkPosition(position: BlockPosition): {
  chunkX: number;
  chunkZ: number;
  localX: number;
  localY: number;
  localZ: number;
} {
  return {
    chunkX: position.x >> 4,
    chunkZ: position.z >> 4,
    localX: position.x & 0xf,
    localY: position.y & 0xf,
    localZ: position.z & 0xf,
  };
}

/** The sub-chunk index a world Y falls in: `-64` is slice `-4`. */
export function subChunkIndexOf(y: number): number {
  return Math.floor(y / 16);
}

/** The base Y of a sub-chunk index. */
export function subChunkBaseY(index: number): number {
  return index * 16;
}

/** Centre of a block, for tools that want to look at what they just read. */
export function blockCentre(position: BlockPosition): Vec3 {
  return { x: position.x + 0.5, y: position.y, z: position.z + 0.5 };
}
