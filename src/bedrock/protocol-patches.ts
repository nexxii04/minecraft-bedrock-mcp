/**
 * Runtime protocol schema patches for `bedrock-protocol`.
 *
 * `bedrock-protocol` compiles packet schemas from `minecraft-data` at process
 * start; some fields drift from what real servers put on the wire, and this module
 * corrects the affected types in memory before any client compiles them. Patches
 * are idempotent and applied once per process. The schema data lives in
 * `minecraft-data` (generated from the Java-side dataset); the wire format we
 * target matches what real servers emit for protocol 2193 (1.26.50).
 */
import { createRequire } from 'node:module';

/** minecraft-data version keys whose schemas carry the drift we patch. */
const PATCHED_VERSION_KEYS = ['bedrock_1.26.51', 'bedrock_1.26.45', 'bedrock_1.26.40'] as const;

let applied = false;

/**
 * `start_game.experimental_gameplay_override` is a *nullable* bool on the wire:
 * `01 <value>` when present, a single `00` when absent. minecraft-data models it
 * as a plain `bool`, so any server that sends the two-byte form desynchronises
 * every field after it — the packet fails to decode and the client never learns
 * its position or game mode (some servers always send the explicit two-byte form).
 */
function patchStartGameExperimentalOverride(types: Record<string, unknown>): void {
  const startGame = types.packet_start_game as [string, Array<{ name: string; type: unknown }>] | undefined;
  if (!Array.isArray(startGame) || !Array.isArray(startGame[1])) return;
  const field = startGame[1].find((f) => f.name === 'experimental_gameplay_override');
  if (field && field.type === 'bool') field.type = ['option', 'bool'];
}

/** Applies every schema patch once per process. Safe to call repeatedly. */
export function applyProtocolPatches(): void {
  if (applied) return;
  let patched = 0;
  // `minecraft-data` is CJS; resolve it through a CJS require hook so this
  // stays ESM-safe (the MCP server runs as pure ESM).
  const requireCjs = createRequire(import.meta.url);
  const minecraftData = requireCjs('minecraft-data') as (key: string) => { protocol: { types: Record<string, unknown> } } | undefined;
  for (const key of PATCHED_VERSION_KEYS) {
    const data = minecraftData(key);
    if (!data?.protocol?.types) continue;
    patchStartGameExperimentalOverride(data.protocol.types);
    patched += 1;
  }
  // Only latch after a fully successful pass: a failure (e.g. a missing
  // dependency) must never permanently disable the patches for the process.
  if (patched > 0) applied = true;
}
