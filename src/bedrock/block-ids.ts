/**
 * Block network ids: the 32-bit hash a Bedrock server puts in every packet that
 * names a block.
 *
 * Since 1.16.100 a block on the wire is not a palette index but the FNV-1a hash
 * of that block's NBT, and nothing sends the block name alongside it. So both
 * directions of the name/id mapping are computed here: it is what lets
 * `find_block` take `minecraft:diamond_ore` and `get_block_at` answer with a name
 * instead of `2837928005`.
 *
 * The hash input is a two-tag NBT document, no root name, states sorted
 * byte-lexicographically:
 *
 *     TAG_Compound  ""                (root, unnamed)
 *       TAG_String    "name"   -> the identifier, e.g. "minecraft:stone"
 *       TAG_Compound  "states"
 *         ... one tag per state, in byte order of the state name ...
 *     TAG_End                         (closes "states")
 *     TAG_End                         (closes the root)
 *
 * A boolean state is one byte, an integer state a little-endian `i32`, and a string
 * state a length-prefixed UTF-8 string; all lengths are byte lengths, not
 * character counts.
 *
 * A numeric state is a `TAG_Int`, but some states are `TAG_Byte` in the game's
 * definitions (`redstone_signal`, `facing_direction`, ...) and no packet says
 * which. Rather than ship a hand-copied table, `BlockIdIndex` registers every
 * combination of the two encodings: a superset that costs a few hashes and cannot
 * be wrong about the one actually used.
 */

/** Values a block state can hold, as they appear in a block's NBT. */
export type BlockStateValue = boolean | number | string;

/** A block's state map, e.g. `{ pillar_axis: 'y' }`. */
export type BlockStates = Record<string, BlockStateValue>;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 16777619;

/** Compares two state names by their UTF-8 bytes, which is what NBT ordering means. */
function compareBytes(left: string, right: string): number {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/** A growable byte writer; the hash input is at most a few hundred bytes. */
class ByteWriter {
  private readonly bytes: number[] = [];

  uint8(value: number): void {
    this.bytes.push(value & 0xff);
  }

  uint16(value: number): void {
    this.bytes.push(value & 0xff, (value >> 8) & 0xff);
  }

  int32(value: number): void {
    this.bytes.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff);
  }

  /** A length-prefixed UTF-8 string, the way every NBT string is written. */
  string(value: string): void {
    const encoded = Buffer.from(value, 'utf8');
    this.uint16(encoded.length);
    for (const byte of encoded) this.bytes.push(byte);
  }

  tagName(name: string): void {
    this.string(name);
  }

  toArray(): number[] {
    return this.bytes;
  }
}

/**
 * How a numeric state is written, where a caller needs to say so. `int` is the
 * default; `byte` is what the game declares for a handful. Only needed when the
 * caller already knows which is which.
 */
export type StateWidths = Record<string, 'int' | 'byte'>;

/**
 * The network id of a block from its identifier and state. States default to none,
 * which is the common case: a block with no state properties has one network id.
 * `widths` overrides the tag a numeric state is written with; leave it out and
 * every number is `TAG_Int`.
 */
export function blockNetworkId(identifier: string, states: BlockStates = {}, widths: StateWidths = {}): number {
  const writer = new ByteWriter();

  writer.uint8(10); // TAG_Compound: the root, unnamed
  writer.uint16(0);

  writer.uint8(8); // TAG_String named "name"
  writer.tagName('name');
  writer.string(identifier);

  writer.uint8(10); // TAG_Compound named "states"
  writer.tagName('states');
  for (const key of Object.keys(states).sort(compareBytes)) {
    const value = states[key];
    if (typeof value === 'boolean') {
      writer.uint8(1); // TAG_Byte
      writer.tagName(key);
      writer.uint8(value ? 1 : 0);
    } else if (typeof value === 'number') {
      if (widths[key] === 'byte') {
        writer.uint8(1); // TAG_Byte
        writer.tagName(key);
        writer.uint8(Math.trunc(value) & 0xff);
      } else {
        writer.uint8(3); // TAG_Int
        writer.tagName(key);
        writer.int32(Math.trunc(value));
      }
    } else if (typeof value === 'string') {
      writer.uint8(8); // TAG_String
      writer.tagName(key);
      writer.string(value);
    }
  }
  writer.uint8(0); // TAG_End closes "states"
  writer.uint8(0); // TAG_End closes the root

  let hash = FNV_OFFSET;
  for (const byte of writer.toArray()) {
    hash ^= byte;
    // `Math.imul` keeps the product in 32 bits, which is what makes this FNV-1a
    // rather than double-precision arithmetic that has already lost the low bits.
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** One named block variant and the id it hashes to. */
export interface BlockEntry {
  id: number;
  name: string;
  states: BlockStates;
  /** Tag width used for each numeric state, where it is not the default `int`. */
  widths: StateWidths;
}

/**
 * Beyond this many numeric states a variant is registered only in its all-`int`
 * and all-`byte` readings plus one state flipped at a time. Nothing in the game
 * comes close, but a 2^n table needs a ceiling.
 */
const MAX_WIDTH_COMBINATIONS = 8;

/**
 * Every tag-width reading of a variant's numeric states. The game declares a
 * handful of states as bytes rather than ints and no packet says which, so the
 * index holds both readings; where two readings collide the earlier (default) one
 * wins, so a caller resolving a name gets the default reading first.
 */
export function widthCombinations(states: BlockStates): StateWidths[] {
  const numericKeys = Object.keys(states).filter((key) => typeof states[key] === 'number');
  if (numericKeys.length === 0) return [{}];
  if (numericKeys.length > Math.log2(MAX_WIDTH_COMBINATIONS)) {
    const combinations: StateWidths[] = [{}, Object.fromEntries(numericKeys.map((key) => [key, 'byte' as const]))];
    for (const key of numericKeys) combinations.push({ [key]: 'byte' });
    return combinations;
  }

  const combinations: StateWidths[] = [];
  const total = 2 ** numericKeys.length;
  for (let mask = 0; mask < total; mask += 1) {
    const widths: StateWidths = {};
    numericKeys.forEach((key, index) => {
      if ((mask & (1 << index)) !== 0) widths[key] = 'byte';
    });
    combinations.push(widths);
  }
  return combinations;
}

/**
 * A name/id index: both directions of the block identity mapping. Network ids are
 * hashes, so they cannot be enumerated, only computed from a name; this table is
 * filled from the game's block definitions and extended with whatever a caller
 * resolves on the fly.
 */
export class BlockIdIndex {
  private readonly byId = new Map<number, BlockEntry>();
  private readonly byName = new Map<string, BlockEntry[]>();

  /** Adds one variant under one reading of its numeric states. */
  addVariant(name: string, states: BlockStates = {}, widths: StateWidths = {}): BlockEntry {
    const id = blockNetworkId(name, states, widths);
    const entry: BlockEntry = { id, name, states, widths };
    this.byId.set(id, entry);
    const key = normalizeName(name);
    const existing = this.byName.get(key) ?? [];
    // Re-adding the same id must not grow the list without bound: a session that
    // resolves the same name every tick would otherwise leak.
    const replaced = existing.findIndex((candidate) => candidate.id === id);
    if (replaced === -1) existing.push(entry);
    else existing[replaced] = entry;
    this.byName.set(key, existing);
    return entry;
  }

  /** Adds every reading of a variant, so the id the server used is always covered. */
  add(name: string, states: BlockStates = {}): BlockEntry[] {
    return widthCombinations(states).map((widths) => this.addVariant(name, states, widths));
  }

  get size(): number {
    return this.byId.size;
  }

  byNetworkId(id: number): BlockEntry | undefined {
    return this.byId.get(id);
  }

  /** Every variant registered for a name, in registration order. */
  byIdentifier(name: string): BlockEntry[] {
    return this.byName.get(normalizeName(name)) ?? [];
  }

  /**
   * The id for a name and state, registering the variant if new. A bare name means
   * the no-states variant, the reading to prefer when the caller gave no states.
   */
  resolve(name: string, states: BlockStates = {}): BlockEntry | undefined {
    const wanted = stateKey(states);
    const candidates = this.byIdentifier(name);
    // A default reading wins over a byte-width reading, so `minecraft:bedrock`
    // resolves to `{}` and not `{ infiniburn_bit: false }`.
    const exact = candidates.find((candidate) => stateKey(candidate.states) === wanted);
    if (exact !== undefined) return exact;
    if (Object.keys(states).length === 0 && candidates.length > 0) {
      return candidates.find((candidate) => Object.keys(candidate.widths).length === 0) ?? candidates[0];
    }
    if (candidates.length === 0) return undefined;
    return this.addVariant(name, states);
  }
}

/** A stable key for a state map, used to compare variants. */
function stateKey(states: BlockStates): string {
  return Object.keys(states)
    .sort(compareBytes)
    .map((key) => `${key}=${String(states[key])}`)
    .join('\u0000');
}

/**
 * Normalises a block name. Every vanilla identifier is namespaced and agents type
 * `stone` more often than `minecraft:stone`, so the namespace is defaulted.
 */
export function normalizeName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (trimmed === '') return trimmed;
  return trimmed.includes(':') ? trimmed : `minecraft:${trimmed}`;
}
