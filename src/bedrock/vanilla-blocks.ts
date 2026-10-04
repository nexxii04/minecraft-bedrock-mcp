/**
 * The block-name half of the block identity mapping.
 *
 * `block-ids.ts` turns a name and state into the id the server uses, but cannot
 * invent names; this module supplies them from the same PrismarineJS data package
 * `bedrock-protocol` compiles its packets from. Every query an agent makes starts
 * from a name or ends at one.
 *
 * State *types* matter as much as values: whether `facing_direction` is written as
 * a byte or an int changes the hash, and no packet says which. minecraft-data
 * records the type per state, so the index is built with the declared widths rather
 * than a guess.
 */

import minecraftData from 'minecraft-data';

import { BlockIdIndex, type BlockStates, type StateWidths } from './block-ids.js';

/** One state value as minecraft-data stores it: a tag type plus its value. */
interface RawStateValue {
  type?: string;
  value?: number | string;
}

interface RawBlockState {
  name?: string;
  states?: Record<string, RawStateValue>;
}

/*
 * One index per resolved data version, built at most once per process. The table is
 * ~17 000 variants and takes a few hundred milliseconds to hash, so building per
 * session or query would be visible; it is entirely static.
 */
const cache = new Map<string, BlockIdIndex>();

/** A Bedrock data version string that minecraft-data actually publishes. */
export interface BlockDataVersion {
  id: string;
  /** The game version this data describes. */
  minecraftVersion: string;
  /** True when the requested version was not available and this one stands in. */
  substituted: boolean;
}

/**
 * Picks the data version to read block names from. A server announces its *game*
 * version in `start_game` (the version this was validated against reports
 * `1.26.50`, newer than the dataset's `1.26.45` and older than `1.26.51`), and
 * minecraft-data publishes only some of them. Falling back to the newest published
 * release is safe because block identity has not changed across 1.26, and the
 * fallback is reported rather than hidden.
 */
export function resolveBlockDataVersion(version: string | null | undefined): BlockDataVersion {
  const releases = minecraftData.versions.bedrock.filter((entry) => entry.releaseType === 'release');
  if (releases.length === 0) {
    throw new Error('minecraft-data ships no Bedrock release data, so block names cannot be resolved');
  }
  const exact = releases.find((entry) => entry.minecraftVersion === version);
  if (exact !== undefined) {
    return {
      id: `bedrock_${exact.minecraftVersion}`,
      minecraftVersion: exact.minecraftVersion,
      substituted: false,
    };
  }
  const newest = releases[releases.length - 1];
  if (newest === undefined) {
    throw new Error('minecraft-data ships no Bedrock release data, so block names cannot be resolved');
  }
  return {
    id: `bedrock_${newest.minecraftVersion}`,
    minecraftVersion: newest.minecraftVersion,
    substituted: true,
  };
}

/** A block name as the wire spells it: always namespaced. */
function qualifiedName(name: string): string {
  return name.includes(':') ? name : `minecraft:${name}`;
}

/**
 * The block index for a data version, built once and reused. Registers every variant
 * the dataset knows (~1 356 names, ~17 000 combinations), so any id a server sends
 * can be named back. A pure hash pass: no network, no files.
 */
export function blockIdIndex(version: string | null | undefined): BlockIdIndex {
  const resolved = resolveBlockDataVersion(version);
  const cached = cache.get(resolved.id);
  if (cached !== undefined) return cached;

  const index = new BlockIdIndex();
  const data = minecraftData(resolved.id);
  for (const entry of data.blockStates ?? []) {
    const raw = entry as RawBlockState;
    if (raw.name === undefined || raw.name === '') continue;
    const states: BlockStates = {};
    const widths: StateWidths = {};
    for (const [key, value] of Object.entries(raw.states ?? {})) {
      if (value.type === 'string') {
        states[key] = String(value.value ?? '');
        continue;
      }
      // The dataset calls a boolean a `byte` holding 0 or 1, which is exactly how
      // the NBT is written, so both go down the same path.
      states[key] = Number(value.value ?? 0);
      if (value.type === 'byte' || value.type === 'bool') widths[key] = 'byte';
    }
    index.addVariant(qualifiedName(raw.name), states, widths);
  }

  cache.set(resolved.id, index);
  return index;
}

/** Drops the cached index; used by tests that want a cold build. */
export function resetBlockIdIndexCache(): void {
  cache.clear();
}
