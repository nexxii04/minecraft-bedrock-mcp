# Architecture

`minecraft-bedrock-mcp` is an MCP server that logs an AI agent into a **Minecraft
Bedrock Edition** server as a real game client over the RakNet/Bedrock protocol,
lets it act there, and exposes what the client knows as MCP tools and resources.

The brief for this project fixes three structural requirements, and most of the
design below falls out of them:

1. `mcp/` must never import `bedrock-protocol` — the protocol stays behind
   `bedrock/client.ts` and `bedrock/actions.ts`.
2. Configuration comes only from environment variables.
3. Adding a tool must not require touching the connection layer.

Status of those requirements is checked by `tests/unit/mcp-tools.test.ts` and by a
grep anyone can repeat:

```bash
grep -rn "from 'bedrock-protocol'" src/
# -> src/bedrock/client.ts is the only match
```

## Layers

```
             ┌────────────────────────────────────────────────────────────┐
  MCP client │  tools (src/mcp/tools/*.ts)   resources (src/mcp/resources) │
  (agent)    └───────────────┬────────────────────────────────────────────┘
                             │ ToolRegistry + McpContext (src/mcp/registry.ts, context.ts)
                             ▼
             ┌────────────────────────────────────────────────────────────┐
             │  SessionManager (src/session-manager.ts)                    │
             │  sessions keyed by id → { client, actions, effective cfg }  │
             └───────────────┬────────────────────────────────────────────┘
                             │
        ┌────────────────────┴─────────────────────┐
        ▼                                          ▼
┌────────────────────────────┐        ┌──────────────────────────────────────┐
│ BedrockActions             │        │ BedrockClient                        │
│ (src/bedrock/actions.ts)   │───────▶│ (src/bedrock/client.ts)              │
│ high-level, ack-based      │        │ socket, lifecycle, reconnect, waiters│
└────────────────────────────┘        └───────────┬──────────────────────────┘
                                                  │  ← the ONLY import of
                                                  │    `bedrock-protocol`
                                   ┌──────────────┴───────────────┐
                                   ▼                              ▼
                        ┌────────────────────┐        ┌────────────────────┐
                        │ BedrockSession     │        │ events.ts          │
                        │ (session.ts)       │◀───────│ raw packet → domain│
                        │ mutable world state│        │ event + state fold │
                        └────────────────────┘        └────────────────────┘
```

| Path                                 | Responsibility                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `src/index.ts`                       | entry point: env → config → logger → session manager → MCP server → transport, plus signal handling |
| `src/transport.ts`                   | stdio and streamable-HTTP transports; redirects stdout to stderr when stdio is in use               |
| `src/config.ts`                      | Zod-validated environment schema, `AppConfig`, reconnect backoff maths                              |
| `src/logger.ts`                      | pino logger behind a minimal structural interface, plus a no-op logger for tests                    |
| `src/types.ts`                       | domain vocabulary: `DomainEvent`, `SessionSnapshot`, `ActionResult`, block/entity/item shapes       |
| `src/bedrock/client.ts`              | connection lifecycle, packet stream, reconnection, `waitFor*` helpers, `send`/`queue`               |
| `src/bedrock/actions.ts`             | high-level actions with acknowledgement semantics (move, break, place, chat, ...)                   |
| `src/bedrock/session.ts`             | mutable per-session state: position, inventory, entities, blocks, buffered logs                     |
| `src/bedrock/events.ts`              | normalisers: one raw packet in → state update + zero or more domain events out                      |
| `src/bedrock/packets.ts`             | encoders for the packets we send, and the modelled packet-name lists                                |
| `src/bedrock/vec3.ts`                | vector maths, block keys, distances, hotbar/face helpers                                            |
| `src/session-manager.ts`             | multi-session registry, session cap, graceful disposal                                              |
| `src/mcp/server.ts`                  | assembles `McpServer` + `ToolRegistry` + resources                                                  |
| `src/mcp/registry.ts`                | SDK-independent tool registry with schema validation                                                |
| `src/mcp/context.ts`                 | `McpContext`, result helpers, uniform error handling, session resolution                            |
| `src/mcp/schemas.ts`                 | shared argument schemas (`sessionId`, coordinates)                                                  |
| `src/mcp/tools/*.ts`                 | tool groups: connection, movement, world, entities, inventory, chat, qa, raw                        |
| `src/mcp/resources/session-state.ts` | read-only resources under `bedrock://`                                                              |

## The connection layer

`BedrockClient` owns exactly one socket and one `BedrockSession`.

### Lifecycle is event-driven, not return-value-driven

`bedrock-protocol`'s `createClient()` is fire-and-forget: it pings for discovery,
then builds the RakNet transport, then runs the login handshake. "Connected" can
therefore only be detected from events, which is why the client maps the library's
`ClientStatus` codes onto its own `ConnectionState`:

```
disconnected → connecting → authenticating → initializing → initialized
                   │                                                  │
                   └────────────── errored / kicked ◀─────────────────┘
```

`connect()` resolves on the library's `join` event (we are in the login sequence),
and `spawn` promotes the session to `initialized`. `connect_to_server` exposes
`waitForSpawn` for callers that need to know the player is actually standing in
the world before issuing actions.

### Two library details shaped this code

- `client.close()` calls `removeAllListeners()` on the client instance, so
  listeners are never reused: every (re)connect builds a fresh underlying client
  and re-attaches handlers (`attachHandlers`).
- The library's `conLog` default is `console.log`, and stdout is the JSON-RPC
  channel under the stdio transport. `conLog` is redirected into the structured
  logger, and `silenceStdout()` in `src/transport.ts` catches anything else that
  writes to `console` (including third-party dependencies).

### Acknowledgements are events, not return values

Every action needs to know whether the _server_ accepted it. The primitive for
that is `waitForDomainEvent(predicate, timeoutMs, label)`:

```ts
const ack = this.client.waitForDomainEvent(
  (event) => event.type === 'block_updated' && sameBlock(event.position, position),
  options.timeoutMs ?? this.defaultTimeoutMs,
  'block place acknowledgement',
);
this.client.send('inventory_transaction', buildItemUseOnBlockTransaction({ ... }));
const acknowledged = await ack;   // null on timeout — never a rejection
```

The waiter is registered _before_ the packet is written, so a server that answers
before the next microtask cannot slip past. On timeout the waiter is removed and
resolves `null`, which becomes `confirmed: false` in the action result rather than
an exception: "the server did not answer" is a fact about the world that a QA
scenario wants to assert on, not a crash.

`send` writes immediately; `queue` goes through `bedrock-protocol`'s queue, for
packets the handshake must not interleave with.

## Session state and event normalisation

`BedrockSession` holds everything learned from the wire: connection info, position
and rotation, dimension, game mode, health, the item registry, tracked entities,
tracked blocks with their runtime ids, inventory containers, the chat buffer, the
event buffer, and counters used by `snapshot_session_state`.

The only writer is `session.ts`'s `ingest(packetName, params)`, which dispatches to
a normaliser in `events.ts`. Normalisers are pure functions of
`(params, mutable state)` that return the domain events the change produced.
That is what makes them unit-testable without a server: build a fake state, feed
it a captured packet, assert on the returned events (`tests/unit/events.test.ts`).

Two deliberate properties of normalisation:

- **Bigints and protocol trivia stop here.** `lf32` floats, `byterot` angles,
  metadata dictionaries keyed by numeric id and every `bigint` are converted to
  plain JSON-safe domain values, so a tool result can be handed to an LLM as-is.
- **Noise is dropped.** Chunk payloads become a single `chunk_loaded` event at
  most (with the payload discarded), camera shake, sounds and similar packets are
  swallowed entirely instead of flooding an agent's context window.

Domain events available to agents (`DomainEvent` in `src/types.ts`):
`chat`, `session_started`, `position_updated`, `health_changed`, `death`,
`entity_spawned`, `entity_removed`, `entity_moved`, `entity_metadata`,
`block_updated`, `inventory_updated`, `inventory_slot`, `dimension_changed`,
`player_list`, `chunk_loaded`, `chunk_radius_accepted`, `kicked`,
`connection_state`, `spawned`, `heartbeat`, `item_registry`, `commands_available`,
`command_executed`.

## The action layer

`BedrockActions` is the toolkit the brief calls for: `bedrock-protocol` is a
protocol library, so everything a bot must do to _mean_ something is written here.

Every action follows the same contract:

```ts
interface ActionResult {
  action: string; // stable action name, also the tool name
  ok: boolean; // did we manage to send it at all
  confirmed: boolean; // did the SERVER show us the effect
  evidence: string; // what convinced us, in words an agent can quote
  warnings: string[]; // what to look at when nothing was confirmed
  elapsedMs: number;
  detail?: Record<string, unknown>;
}
```

`ok` and `confirmed` are deliberately separate. `ok: true, confirmed: false`
means "the packet went out and the server did not demonstrate the effect inside
the timeout" — the single most useful distinction when debugging a server.

### Action → packet → confirmation

| Action / tool                               | Packet(s) written                                                                                                                                              | Confirmed by                                                                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect_to_server`                         | login handshake via `bedrock-protocol` (`request_network_settings`, `login`, `resource_pack_*`, `set_local_player_as_initialized`), then `client_cache_status` | `join` event, plus `spawn` when `waitForSpawn` is set                                                                                             |
| `disconnect`                                | `disconnect`                                                                                                                                                   | intentional close of the socket                                                                                                                   |
| `send_chat`                                 | `text`                                                                                                                                                         | our own message arriving back in the `chat` log (`fromSelf`)                                                                                      |
| `run_command`                               | `command_request`                                                                                                                                              | `command_output` whose echoed `request_id`/`uuid` matches this request (`detail.succeeded` reports what the server said about the command itself) |
| `move_to`                                   | `player_auth_input`, then `move_player` (mode `teleport`) unless narrowed                                                                                      | a _server-originated_ `position_updated` within `tolerance`; our own report is excluded, so a server that stays silent leaves `confirmed: false`  |     | `walk_to` | `player_auth_input` × steps (increasing tick, per-step `delta` and `move_vector`) | a server-originated correction, or nothing — the server broadcasts a walk to other viewers instead of echoing it to the walker |
| `look_at`, `set_rotation`                   | `move_player` (mode `rotation`)                                                                                                                                | a server-originated `position_updated` (rarely comes; rotation is client-side)                                                                    |
| `jump`                                      | `player_action` (`jump`) + `player_auth_input` with `jumping`/`start_jumping`                                                                                  | `position_updated` whose `y` rose by more than 0.05                                                                                               |
| `break_block` (creative)                    | `player_action` (`creative_player_destroy_block`)                                                                                                              | `block_updated` for that coordinate                                                                                                               |
| `break_block` (survival)                    | `player_action` (`start_break`, then `stop_break` with `result_position`)                                                                                      | `block_updated` for that coordinate, runtime id 0 = air                                                                                           |
| `place_block`                               | `inventory_transaction` (item use on block, click target derived from cached neighbours)                                                                       | `block_updated` for the target coordinate                                                                                                         |
| `abort_break`                               | `player_action` (`abort_break`)                                                                                                                                | nothing — fire and forget, always `confirmed: false`                                                                                              |
| `request_chunk_radius`                      | `request_chunk_radius`                                                                                                                                         | `chunk_radius_update` (reports the radius actually granted)                                                                                       |
| `get_block_at` / `find_block` / `get_biome` | none (read-only)                                                                                                                                               | decoded `level_chunk` payloads, with `update_block` overriding terrain; every reading names its `source` and says when it is `unknown`            |
| `equip_item`                                | `player_hotbar`                                                                                                                                                | `inventory_slot` / `inventory_updated` / `mob_equipment`                                                                                          |
| `drop_item`                                 | `inventory_transaction` (normal transaction, source `world_interaction`, replacing the stack with an empty one)                                                | `inventory_slot` for that slot                                                                                                                    |
| `use_held_item`                             | `player_action` (`start_using_item`) + item-use-on-air + item-release transactions                                                                             | `health_changed` or `inventory_slot`                                                                                                              |
| `attack_entity`                             | `inventory_transaction` (item use on entity, action `attack`) + optional `animate` arm swing                                                                   | a follow-up entity/metadata/chat event                                                                                                            |
| `interact_entity`                           | `interact` (`mouse_over_entity`) or item-use-on-entity transaction                                                                                             | a follow-up entity/inventory/chat event                                                                                                           |
| `send_raw_packet`                           | whatever the caller passes                                                                                                                                     | nothing (tool is not registered unless `MCBE_ENABLE_RAW_PACKET_TOOL=true`)                                                                        |

Packet encoders live in `src/bedrock/packets.ts` and are covered by
`tests/unit/packets.test.ts`, which asserts the field names against the installed
protocol version — a rename in `bedrock-protocol` shows up as a failing test
rather than as a silently ignored packet.

## The MCP surface

### Tools

Tools are declared against `ToolRegistry` rather than registered on `McpServer`
directly, for one concrete reason: `run_action_sequence` has to invoke tools
_programmatically_. One declaration therefore has two consumers — the MCP binding
(`registry.bind(server)`) and in-process invocation (`registry.invoke(name, args)`),
and a QA scenario can never drift from the interactive path.

`invoke` re-validates arguments against the tool's own Zod shape, so a scenario
cannot smuggle in input the interactive path would have rejected.

### Errors are data

`handle(context, toolName, fn)` wraps every handler. A thrown error becomes

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"error\": \"Session \\\"default\\\" is not in the world yet (state: disconnected). Call connect_to_server ...\"}"
    }
  ],
  "isError": true
}
```

Because the message names the missing precondition and the tool that satisfies
it, an agent can recover by itself. Nothing in the tool layer throws across the
MCP boundary on purpose; `isError` is what a client renders as a failed call.

### Resources

Reads that an agent wants as _context_ rather than as an action are resources
(`src/mcp/resources/session-state.ts`):

```
bedrock://sessions                          all sessions, one view
bedrock://config                            non-secret effective configuration
bedrock://last-chat                         most recent chat across all sessions
bedrock://session/{id}/state                live snapshot
bedrock://session/{id}/inventory            slots, containers, held item
bedrock://session/{id}/entities             tracked entities, sorted by distance
bedrock://session/{id}/blocks               blocks the server has reported
bedrock://session/{id}/chat                 bounded chat buffer
bedrock://session/{id}/events               bounded domain-event buffer
```

Resources matter for cost: attaching a resource costs one read in the client's
context, whereas polling the same facts through tools costs a round trip each.

## Multi-session

`SessionManager` keys sessions by a caller-chosen id and creates them lazily
(nothing connects until `connect_to_server` is called). `MCBE_MAX_SESSIONS`
(default 4) caps concurrency, and the error names the sessions that already
exist. Every tool accepts an optional `sessionId`; omitting it uses
`MCBE_DEFAULT_SESSION_ID` (`default`).

This is what makes multi-agent QA possible: two ids, two connections, one
assertion pass. `run_action_sequence` passes its own `sessionId` down to each
step unless the step overrides it.

## Configuration

`loadConfig(env)` parses the environment with Zod and fails fast with a readable
list of problems. No config file, no CLI flags; `dotenv` is loaded by
`src/index.ts` so a `.env` in the working directory is honoured but never
required. Defaults are chosen to work against a local Bedrock Dedicated Server
with `online-mode=false` and no build toolchain:

- `MCBE_OFFLINE=true` — offline mode; set it to `false` for Xbox Live
  device-code login, whose URL and code are logged at `warn` level.
- `MCBE_RAKNET_BACKEND=jsp-raknet` — the pure-JS RakNet implementation, so a
  fresh clone needs no compiler; `raknet-native` is available where a native
  build is possible.
- `MCBE_VERSION` unset — use the version `bedrock-protocol` ships with, upgraded
  by server discovery; pin it to force a specific Bedrock release.

See `.env.example` for every variable with its default and rationale.

## Transports

- `stdio` (default): the usual local MCP setup. `silenceStdout()` runs before
  anything else can print, because stdout _is_ the protocol channel.
- `http`: streamable HTTP at `MCBE_HTTP_PATH`, for containerised or remote
  agents. Stateful sessions are the default.

Both are wrapped by `startTransport()`, which returns a `close()` used by the
graceful shutdown path in `src/index.ts`.

## Testing

| Suite                                       | What it proves                                                                                                                                                       | Needs a server?                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `tests/unit/*`                              | packet encoders against the installed protocol data, packet→event normalisation, config parsing/backoff, vector maths, the tool registry and the QA assertion engine | no                                                                             |
| `tests/integration/connection.test.ts`      | connect, kick handling, reconnect with backoff against a restarted server, clear failure when nothing is listening                                                   | yes — an in-process `bedrock-protocol` server (`tests/helpers/test-server.ts`) |
| `tests/integration/smoke.test.ts`           | the brief's smoke test: connect, move, chat, disconnect, plus multi-session independence and the session cap                                                         | yes — same helper                                                              |
| `tests/integration/external-server.test.ts` | the same flows against a _real_ server, skipped unless `MCBE_TEST_HOST` is set                                                                                       | yes — external                                                                 |

The in-process server helper exists so the connection layer is exercised for real
(RakNet, login, encryption with `offline: true`) without requiring anyone to run
BDS. It documents two quirks of `bedrock-protocol`'s own server worth knowing:
it keys connected players by an object, so several clients can collapse into one
entry, and its session table can go stale after a kick — the tests therefore use
a fresh server where that matters, and `test-server.ts` says so in comments.

Run everything with `npm test`; the external-server suite reports as skipped
unless `MCBE_TEST_HOST` (and friends) are exported.

## Known limitations

- **Movement is not pathfinding.** There is no navigation code in this project
  and no walk-to primitive in the protocol, so neither movement tool knows about
  terrain. They differ in what they send, not in intelligence: `move_to` reports
  a position in one packet, `walk_to` walks the straight line to the target in
  steps, one `player_auth_input` per step with an increasing tick and a per-step
  displacement — what a client sends when it holds forward, and what makes a walk
  observable to other sessions instead of a teleport. Servers that validate
  movement answer with a correction (`correct_player_move_prediction`), which
  counts as confirmation and is the only case where the mover itself hears back
  about its own position; servers that stay silent leave the action
  `confirmed: false` even when the movement landed, because Bedrock clients are
  authoritative over their own position and are not owed an echo.
  `detail.sessionPosition` is the position later actions use and
  `detail.positionSource` says where it came from. A second session asking
  `get_nearby_entities` is how to verify either one server-side.
- **Block and entity views are deltas.** `get_nearby_blocks` reports blocks the
  server has explicitly sent (`update_block`, `update_subchunk_blocks`), not a
  full world read: absence means "unknown", not "air". `get_nearby_entities`
  reports entities the server tracks us against, and entities that walk out of
  range go stale until they move again.
- **Terrain comes from the chunk payloads, not from a world model.** The
  `level_chunk` payload is an opaque buffer as far as `bedrock-protocol` is
  concerned, so `bedrock/chunk.ts` decodes it directly: paletted storages per
  16-block slice, `(x << 8) | (z << 4) | y` indexing, layers for waterlogging,
  and the two biome layouts in the wild. That is what makes `get_block_at`,
  `find_block` and `get_biome` able to answer for blocks the server never
  mentioned. Three consequences worth remembering:
  - **Two sources, one answer, and the reading says which.** `readBlock` prefers
    the server's own `update_block` over the chunk, because the chunk is a
    snapshot from before the change. `source` is `server` or `chunk`.
  - **"Unknown" is not "air".** An unstreamed chunk, a missing sub-chunk or a
    palette that does not cover an index each produce `blockRuntimeId: null` with
    a reason in `unknown`. Collapsing those into air is how a QA assertion passes
    when it should fail.
  - **The cache evicts by distance, not by age.** A server streams its whole view
    radius in one burst, so every chunk in it carries the same timestamp and
    "oldest" means nothing; dropping the oldest would discard the chunks the
    player is standing in. `evictFarthestChunk` keeps the neighbourhood and bound
    by `MCBE_MAX_TRACKED_CHUNKS` (default 1024).
- **Block ids are recomputed, not table-copied.** From 1.16.100 a block's network
  id is the FNV-1a hash of an NBT document naming the block and its states, so
  `bedrock/block-ids.ts` derives ids from `minecraft-data`'s block list instead of
  shipping a snapshot. The one thing the data cannot say is an integer state's NBT
  tag width, and servers disagree, so every width combination is registered and
  lookups try each.
- **Biome names come from the server.** `minecraft-data`'s Bedrock biome `id`
  field is an alphabetical array index, not the wire biome id, so it cannot name
  a chunk's biome. `biome_definition_list` can: the session records the catalogue
  the server announced and `get_biome` reports `name: null` for an id the server
  did not attach a name to (which is the honest answer for servers whose
  definitions all carry the protocol default id).
- **Rotation is largely client-side.** `look_at` / `set_rotation` usually report
  `confirmed: false`; the rotation is nonetheless included in the next movement
  packet, which is what makes it observable server-side.
- **Some actions have no acknowledgement in the protocol.** `abort_break`,
  `interact_entity` and `send_raw_packet` are honest about it: `confirmed: false`
  means "sent, outcome unknown", never "failed".
- **Offline mode is the tested path.** Xbox Live login is implemented (device
  code, cached in `MCBE_PROFILES_FOLDER`) but needs real Microsoft credentials to
  exercise, so it is covered by unit-level configuration tests only.
- **Server-authoritative inventory.** When the server declares
  `server_authoritative_inventory`, locally computed inventory edits are advisory;
  the server's `inventory_content`/`inventory_slot` packets remain the truth, and
  actions that depend on inventory state report that in `warnings`.

## Recipes

**Add a tool.** Create or extend a module in `src/mcp/tools/`, define it against
the registry with a Zod `inputSchema` and a description of at least a paragraph
(a test enforces a real description), and register the module in
`src/mcp/server.ts`. Nothing in `src/bedrock/` changes.

**Add an action.** Add the packet encoder to `src/bedrock/packets.ts`, add the
method to `BedrockActions` following the `finish(...)` result contract, wait for a
domain event that the _server_ produces, and only then expose a tool. If no
confirmation event exists, say so in `evidence` instead of inventing one.

**Add a packet normaliser.** Add the case to `src/bedrock/events.ts`, add the
domain event to `DomainEvent` in `src/types.ts`, and add the packet name to
`INCOMING_PACKET_NAMES` in `src/bedrock/packets.ts` so `list_bedrock_packets`
stays accurate. Add a unit test with a captured payload.
