/**
 * A minimal `level_chunk` payload writer, for tests.
 *
 * The decoder reads a binary format whose only real-world producer is a game
 * server; encoding one by hand lets the tests pin down the *reader*, including the
 * failure modes a live server would not conveniently produce (a truncated payload,
 * a palette that misses its indices, both biome layouts), without a socket or a
 * captured dump. Only what the decoder reads is implemented, for sub-chunk format
 * version 9 (1.18+).
 */

import type { PalettedStorage } from '../../src/bedrock/chunk.js';

/** One sub-chunk as the encoder will write it. */
export interface EncodableSubChunk {
  /** Vertical slice number, written into the payload as an `int8`. */
  index: number;
  /** One paletted storage per layer, layer 0 first. */
  layers: PalettedStorage[];
  /** Biome storage, or `null` to write no biome section for this sub-chunk. */
  biomes?: PalettedStorage | null;
}

/** Packs entries into 32-bit words the way the game does, for a storage header. */
export function packWords(values: number[], bitsPerEntry: number): number[] {
  const perWord = Math.floor(32 / bitsPerEntry);
  const words = new Array<number>(Math.ceil(values.length / perWord)).fill(0);
  values.forEach((value, index) => {
    const wordIndex = Math.floor(index / perWord);
    const shift = (index % perWord) * bitsPerEntry;
    const current = words[wordIndex] ?? 0;
    // `>>> 0` keeps the accumulator unsigned; JavaScript's `|` would sign it.
    words[wordIndex] = (current | ((value & ((1 << bitsPerEntry) - 1)) << shift)) >>> 0;
  });
  return words;
}

/** A storage holding one palette value repeated. `bitsPerEntry: 0` is the compact form. */
export function uniformStorage(value: number): PalettedStorage {
  return { bitsPerEntry: 0, words: new Uint32Array(0), palette: [value] };
}

/** A storage with a real palette and a bit array, so its indices are actually read. */
export function paletteStorage(values: number[], palette: number[]): PalettedStorage {
  const bitsPerEntry = Math.max(1, Math.ceil(Math.log2(Math.max(2, palette.length))));
  return { bitsPerEntry, words: Uint32Array.from(packWords(values, bitsPerEntry)), palette };
}

function writeVarint(bytes: number[], value: number): void {
  let remaining = value >>> 0;
  for (;;) {
    const byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining === 0) {
      bytes.push(byte);
      return;
    }
    bytes.push(byte | 0x80);
  }
}

function writeZigZag(bytes: number[], value: number): void {
  writeVarint(bytes, (value << 1) ^ (value >> 31));
}

function writeStorage(bytes: number[], storage: PalettedStorage, isBlock: boolean): void {
  if (!isBlock && storage.bitsPerEntry === 0) {
    // A single-value biome is written as a header of 0 then the value raw.
    bytes.push(0);
    const raw = storage.palette[0] ?? 0;
    bytes.push(raw & 0xff, (raw >> 8) & 0xff, (raw >> 16) & 0xff, (raw >>> 24) & 0xff);
    return;
  }
  // Bit 0 set means the network format, which is what blocks use.
  bytes.push((storage.bitsPerEntry << 1) | (isBlock ? 1 : 0));
  for (const word of storage.words) bytes.push(word & 0xff, (word >> 8) & 0xff, (word >> 16) & 0xff, (word >>> 24) & 0xff);
  writeZigZag(bytes, storage.palette.length);
  for (const value of storage.palette) writeZigZag(bytes, value);
}

export interface EncodeChunkOptions {
  subChunks: EncodableSubChunk[];
  /** Bytes appended after the border-block section, to simulate a desync. */
  trailingBytes?: number;
}

/** Encodes a payload as `level_chunk.payload` for the given sub-chunks. */
export function encodeChunkPayload(options: EncodeChunkOptions): Uint8Array {
  const bytes: number[] = [];
  for (const subChunk of options.subChunks) {
    bytes.push(9); // sub-chunk format version
    bytes.push(subChunk.layers.length);
    bytes.push(subChunk.index & 0xff);
    for (const layer of subChunk.layers) writeStorage(bytes, layer, true);
  }
  for (const subChunk of options.subChunks) {
    if (subChunk.biomes === null || subChunk.biomes === undefined) continue;
    writeStorage(bytes, subChunk.biomes, false);
  }
  writeVarint(bytes, 0); // no border blocks
  for (let index = 0; index < (options.trailingBytes ?? 0); index += 1) bytes.push(0);
  return Uint8Array.from(bytes);
}
