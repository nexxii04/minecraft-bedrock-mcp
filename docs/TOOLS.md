# Tools and resources

41 tools across nine groups. Thirty-nine are always registered; the two
escape-hatch tools appear only with `MCBE_ENABLE_RAW_PACKET_TOOL=true`. Every
tool takes an optional `sessionId`; omitting it targets
`MCBE_DEFAULT_SESSION_ID` (`default`).

This file is the human-readable catalogue. The authoritative JSON Schema for each
tool is what the MCP client sees in `tools/list` — argument descriptions live
there, and the tools themselves carry descriptions long enough for an agent to
choose between them without extra prompting.

## Result conventions

Action tools return the same envelope:

```json
{
  "action": "break_block",
  "ok": true,
  "confirmed": true,
  "evidence": "server sent update_block for (12, 64, -3)",
  "warnings": [],
  "elapsedMs": 240,
  "detail": { "position": { "x": 12, "y": 64, "z": -3 }, "blockRuntimeId": 0, "mode": "creative" }
}
```

- `ok` — did we manage to send the packet.
- `confirmed` — did the **server** show us the effect (see the acknowledgement
  table in [ARCHITECTURE.md](./ARCHITECTURE.md#action--packet--confirmation)).
- `evidence` — what convinced us, phrased so it can be quoted in a report.
- `warnings` — what to investigate when `confirmed` is false.

`ok: true, confirmed: false` means "sent, outcome unknown" — never "failed".
Failures (unknown session, no connection, bad argument) come back as
`isError: true` with a JSON `{"error": "..."}` body that says what to do next.

## Connection and sessions

| Tool                    | Arguments                                                                                                               | Notes                                                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect_to_server`     | `sessionId`, `host`, `port`, `username`, `offline`, `version`, `raknetBackend`, `skipPing`, `waitForSpawn`, `timeoutMs` | Creates the session if needed and logs in as a real player. Resolves once the server has let us in; with `waitForSpawn: true` it also waits for the spawn gate, so subsequent actions are safe. |
| `disconnect`            | `sessionId`, `reason`, `dispose`                                                                                        | Sends `disconnect`, closes the socket and suppresses auto-reconnect. `dispose: true` forgets the session so the id can point elsewhere.                                                         |
| `get_connection_status` | `sessionId`                                                                                                             | One session (or all, when omitted): state, host, protocol version, position, health, packet counters, whether a reconnect is pending and when.                                                  |
| `list_sessions`         | —                                                                                                                       | Every known session, connected or not. Use it after an "unknown session" error.                                                                                                                 |

## Movement and orientation

| Tool            | Arguments                                                                                                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `move_to`       | `x`, `y`, `z`, `mode`, `yaw`, `pitch`, `tolerance`, `timeoutMs`, `sessionId`                                                   | Position report, not pathfinding. `mode`: `both` (default — `player_auth_input` and `move_player`), `auth_input`, or `teleport`. The report is recorded locally as `detail.positionSource: "self_report"`, which is what later block actions aim at. Confirmed only by a **server-originated** position: a correction counts, silence does not, so `confirmed: false` on a server that never echoes movement means unverified rather than failed. Verify with a second session.                                                                                                     |
| `walk_to`       | `x`, `y`, `z`, `stepLength`, `tolerance`, `stepIntervalMs`, `maxSteps`, `keepY`, `abortOnCorrection`, `timeoutMs`, `sessionId` | Moves in steps, one `player_auth_input` per step with an increasing tick and a per-step displacement, instead of a single position report. Still not pathfinding: the steps run in a straight line, so solid terrain between the points is walked through and a validating server pushes back (`detail.correction`, which counts as confirmed). Chatty by design — use `move_to` just to _be_ somewhere, and `walk_to` when the movement path is what you are testing, because a walk is what other sessions can watch. `detail.trail` lists every step with its position and tick. |
| `move_to_block` | `x`, `y`, `z`, `mode`, `timeoutMs`, `sessionId`                                                                                | Integer block coordinates; targets the block centre at standing height.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `look_at`       | `x`, `y`, `z`, `timeoutMs`, `sessionId`                                                                                        | Faces a world position without moving. Usually `confirmed: false` — rotation rides along on the next movement packet.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `set_rotation`  | `yaw`, `pitch`, `headYaw`, `timeoutMs`, `sessionId`                                                                            | Same, with explicit angles. Yaw 0 = south (+Z), 90 = west (−X), −90 = east (+X); pitch −90 = up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `jump`          | `timeoutMs`, `sessionId`                                                                                                       | Sends `jump` plus an authoritative-input frame; confirmed only when the server-reported Y actually rises.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `get_position`  | `sessionId`                                                                                                                    | Position, rotation, dimension, game mode, health, on-ground, and how the position was last learned (server move, correction, respawn, teleport, self-report).                                                                                                                                                                                                                                                                                                                                                                                                                       |

## World and blocks

| Tool                   | Arguments                                                                                      | Notes                                                                                                                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_nearby_blocks`    | `radius`, `limit`, `onlyNonAir`, `sessionId`                                                   | Blocks the server has explicitly reported, nearest first. A delta view: absence means "unknown", not "air".                                                                                                                                                                       |
| `get_block_at`         | `x`, `y`, `z`, `sessionId`                                                                     | The block at a coordinate: the server's own `update_block` if it sent one, otherwise the decoded chunk payload. Reports which `source` answered, the resolved `name`, and `unknown` when the coordinate is untouched-and-unstreamed rather than air.                              |
| `find_block`           | `block` or `blockId`, `states`, `radius`, `origin`, `limit`, `sessionId`                       | Searches decoded terrain around a point, nearest first, so it answers for blocks the server never mentioned. Reports how many chunks of the box were loaded, because a miss in unstreamed terrain means nothing.                                                                  |
| `get_biome`            | `x`, `y`, `z`, `sessionId`                                                                     | The biome the server wrote into the chunk. Names come from the server's own `biome_definition_list`, so a server that announces biomes without ids (some do) yields the raw id and `named: false`.                                                                                |
| `break_block`          | `x`, `y`, `z`, `mode`, `face`, `timeoutMs`, `sessionId`                                        | `mode` is `auto` (default: creative when the server said the player is in creative), `survival` or `creative`. Creative sends one destroy packet; survival sends `start_break` → `stop_break`. Confirmed by the server's `update_block` for that coordinate (runtime id 0 = air). |
| `place_block`          | `x`, `y`, `z`, `againstX/Y/Z`, `face`, `hotbarSlot`, `itemNetworkId`, `timeoutMs`, `sessionId` | Bedrock places blocks by clicking a neighbouring block's face, so the click target is derived from cached neighbours unless you pass it. Confirmed by `update_block` at the target.                                                                                               |
| `abort_break`          | `x`, `y`, `z`, `timeoutMs`, `sessionId`                                                        | Cancels a mining action the server still thinks is running. Fire and forget.                                                                                                                                                                                                      |
| `request_chunk_radius` | `chunkRadius`, `timeoutMs`, `sessionId`                                                        | Asks for a wider view distance; the response reports the radius actually granted.                                                                                                                                                                                                 |

## Inventory

| Tool                | Arguments                                  | Notes                                                                                                                          |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `get_inventory`     | `containerId`, `includeEmpty`, `sessionId` | Known slots with runtime ids, counts and resolved item names where the registry has arrived. Slots 0–8 are the hotbar.         |
| `equip_item`        | `slot`, `timeoutMs`, `sessionId`           | Selects a hotbar slot (0–8): what a Bedrock player holds _is_ the selected slot.                                               |
| `drop_item`         | `slot`, `count`, `timeoutMs`, `sessionId`  | Drops part or all of a stack using the vanilla transaction (no dedicated drop packet exists). Confirmed when the slot empties. |
| `use_held_item`     | `timeoutMs`, `sessionId`                   | Uses the selected item with no target (eat, drink, throw), then releases it. Confirmed by a health change or inventory update. |
| `resolve_item_name` | `networkId`, `sessionId`                   | Runtime id → name, from the palette the server sent at login.                                                                  |

## Entities

| Tool                    | Arguments                                                                         | Notes                                                                                                                                                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_nearby_entities`   | `radius`, `limit`, `includePlayers`, `includeSelf`, `entityType`, `sessionId`     | Tracked entities and players, nearest first, with the runtime ids that the attack/interact tools need.                                                                                                                                          |
| `get_entity`            | `runtimeId`, `sessionId`                                                          | Full tracked state of one entity: identifier, position, unique id.                                                                                                                                                                              |
| `attack_entity`         | `runtimeId`, `entityType`, `username`, `reach`, `swing`, `timeoutMs`, `sessionId` | Attack transaction (plus an optional arm swing), the same packets the vanilla client sends.                                                                                                                                                     |
| `attack_nearest_entity` | `entityType`, `reach`, `timeoutMs`, `sessionId`                                   | Convenience wrapper for combat QA loops where the exact target does not matter.                                                                                                                                                                 |
| `interact_entity`       | `runtimeId`, `entityType`, `username`, `reach`, `mode`, `timeoutMs`, `sessionId`  | Use the held item on an entity (feed, shear, trade) or just hover. `mode: "hover"` sends `interact`; anything else sends the item-use transaction. No protocol acknowledgement exists, so `confirmed` reflects a _follow-up_ event, not an ack. |

## Commands

| Tool            | Arguments                                            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_commands` | `search`, `limit`, `timeoutMs`, `sessionId`          | The catalogue the server announced via `available_commands`: name, description, permission level, aliases and argument patterns (`usage`), rebuilt from scratch on every announcement. `search` matches name, alias or description case-insensitively (a leading `/` is ignored). This is the server's own answer to "what can I test here?" — and a feature you just registered that is missing from the list is itself a finding.                                                                                                                                     |
| `run_command`   | `command`, `timeoutMs`, `waitForOutput`, `sessionId` | Runs a server command through `command_request`, the path the protocol guarantees a reply on, and returns the server's own `command_output` in `detail.output` (colour codes stripped) and `detail.messages` (verbatim). `confirmed: true` means the server answered this exact request — matched on the echoed `request_id`. Read `detail.succeeded` for the verdict: `false` means the server replied and refused. Some commands never reply at all, so `confirmed: false` plus a warning is a normal outcome, not a failure — pass `waitForOutput: false` for those. |

Command names in `list_commands` are spelled the way the server announces them,
without a slash, which is also the form a server reported to us uses for
`permission_level: "any"` on every command it ships. In an argument pattern,
`name:type` is one parameter and a trailing `?` marks it optional; when the
server says a parameter is constrained to an enum the type reads `enum`, and an
unmapped numeric type code is shown as the bare number the server sent rather
than guessed at.

Commands are sent exactly as written (leading `/` optional; servers strip it). One
protocol wart is handled for you, and it is worth knowing about when a command
comes back `confirmed: false` with no reply at all: the `command_request.version`
field changed encoding across releases — a varint up to 1.21.x, a string from
1.21.130 on — and on 1.26.x a numeric-looking value makes real servers drop the
connection with a misleading `packet_violation_warning`. The tool always sends the
literal `latest`, which is the correct string on 1.26.x and coerces to a harmless
`0` under the older varint encoding, so the same call works on either.

## Chat and observation

| Tool            | Arguments                                    | Notes                                                                                                                                       |
| --------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `send_chat`     | `message`, `type`, `timeoutMs`, `sessionId`  | Public chat, or a server command with a leading `/`. Confirmed when the server echoes the line back to us (servers are not obliged to).     |
| `get_chat_log`  | `limit`, `since`, `source`, `sessionId`      | Bounded buffer (default 200, `MCBE_MAX_CHAT_LOG`), oldest first, filterable by time or sender.                                              |
| `get_event_log` | `limit`, `types`, `since`, `sessionId`       | Normalised domain events (see the list below), newest last, filterable. Filter `types: ["command_executed"]` to replay every command reply. |
| `wait_for_chat` | `contains`, `from`, `timeoutMs`, `sessionId` | Blocks until a matching chat line arrives. Use it instead of sleeping after a command.                                                      |

## QA and scenarios

| Tool                     | Arguments                                                                      | Notes                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run_action_sequence`    | `steps`, `stopOnFailure`, `assertions`, `assertionsAfterEachStep`, `sessionId` | Executes an ordered list of tool calls, each `{"tool": "...", "args": {...}}`, with `{"tool": "wait", "args": {"ms": 500}}` as a pause. Steps report their own `ok`/`confirmed`; a failing step is captured rather than aborting the run unless `stopOnFailure` is set. Assertions are evaluated at the end, and after every step when `assertionsAfterEachStep` is set. |
| `assert_session_state`   | `assertions`, `sessionId`                                                      | Declarative checks against the flattened session state, no side effects.                                                                                                                                                                                                                                                                                                 |
| `wait_for_event`         | `types`, `predicatePath`, `contains`, `equals`, `timeoutMs`, `sessionId`       | Blocks until a matching domain event occurs — how a scenario synchronises on a server-side effect instead of sleeping.                                                                                                                                                                                                                                                   |
| `snapshot_session_state` | `sessionId`                                                                    | The whole flat state, for expected/actual comparison or logging.                                                                                                                                                                                                                                                                                                         |

### Assertions

Each assertion is `{ name, source?, path, at?, ...comparison }`, where `path` is a
dotted path into the chosen view. `source` selects that view and defaults to
`state`; every result reports the `source` it read.

- `state` (default): the flattened session snapshot — the paths listed below.
- `command`: the server's answer to the last command — `count`, `succeeded`,
  `output`, `command`, `acknowledged`, `requestId`, `messages`, `messageCount`,
  `outputType`, `originType`.
- `chat`: the chat log — `count`, `text` (every message joined), `kinds`, `last.*`.
- `events`: how many of each event type have been recorded, plus `total` and
  `last.*`. "this happened at all" is `{ source: "events", path: "block_updated", atLeast: 1 }`.
- `block`: what is at a coordinate — `name`, `known`, `source`, `unknown`,
  `blockRuntimeId`, `reading.*`, `at`. Reads `at`, or the block the player stands
  in when `at` is omitted.
- `inventory`: what the session is carrying — `count`, `slots`, `byName.*`,
  `byShortName.*`, `held`, `heldName`, `heldCount`, `selectedHotbarSlot`.

Comparisons: `equals` (numbers honour `tolerance`, default `0.0001`), `notEquals`,
`greaterThan`, `lessThan`, `atLeast`, `atMost`, `isNull`. An assertion with no
comparison fails with a message saying so.

`state` view paths:

```
connection.state  connection.host  connection.port  connection.username
connection.offline  connection.version  connection.protocolVersion
connection.raknetBackend  connection.connectedAt  connection.packetsReceived
connection.packetsSent  connection.lastPacketAt  connection.lastDisconnectReason
connection.reconnectAttempts  connection.nextReconnectAt
entityId  runtimeEntityId  position.x  position.y  position.z
rotation.yaw  rotation.pitch  rotation.headYaw  onGround  dimension  gameMode
health  isAlive  worldName  serverVersion  permissionLevel  chunkRadius
chunksLoaded  tick  itemRegistrySize  commandCount  trackedEntities  trackedBlocks
knownPlayers  inventorySlots  selectedHotbarSlot  uptimeMs
serverAuthoritative.inventory  serverAuthoritative.blockBreaking
```

### Event types for `wait_for_event`

```
chat  session_started  position_updated  health_changed  death
entity_spawned  entity_removed  entity_moved  entity_metadata  block_updated
inventory_updated  inventory_slot  dimension_changed  player_list  chunk_loaded
chunk_radius_accepted  kicked  connection_state  spawned  heartbeat
item_registry  commands_available  command_executed
```

## Escape hatch

Disabled unless `MCBE_ENABLE_RAW_PACKET_TOOL=true`:

| Tool                   | Arguments                             | Notes                                                                                                                                                                                 |
| ---------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send_raw_packet`      | `packet`, `params`, `queue`, `dryRun` | Writes an arbitrary packet, bypassing all action logic. `dryRun: true` serialises the payload against the installed protocol version and reports whether it is valid — do that first. |
| `list_bedrock_packets` | `sessionId`                           | Packet names this project produces or reacts to, plus the negotiated protocol version. Bedrock renames packets between releases; check here before using `send_raw_packet`.           |

## Worked scenario

Two agent-players on the same server: `victim` stands on a pillar, `attacker`
knocks the block out from under it, then the consequence is asserted on the
victim's own session. Note the mix of step kinds — actions, a pause to let the
server react, and a read-back to confirm the block really changed:

```json
{
  "tool": "run_action_sequence",
  "args": {
    "sessionId": "attacker",
    "stopOnFailure": false,
    "steps": [
      { "tool": "move_to", "args": { "x": 8, "y": 66, "z": 9 } },
      { "tool": "look_at", "args": { "x": 8, "y": 64.5, "z": 8 } },
      { "tool": "break_block", "args": { "x": 8, "y": 64, "z": 8, "mode": "creative" } },
      { "tool": "wait", "args": { "ms": 400 } },
      { "tool": "get_block_at", "args": { "x": 8, "y": 64, "z": 8 } },
      {
        "tool": "assert_session_state",
        "args": {
          "assertions": [{ "name": "attacker is fine", "path": "isAlive", "equals": true }]
        }
      }
    ],
    "assertions": [
      {
        "name": "attacker stayed in the world",
        "path": "connection.state",
        "equals": "initialized"
      }
    ]
  }
}
```

Cross-session effects are asserted on the _other_ session — that is what the
`sessionId` argument is for:

```json
{
  "tool": "assert_session_state",
  "args": {
    "sessionId": "victim",
    "assertions": [
      { "name": "victim fell one block", "path": "position.y", "lessThan": 65 },
      { "name": "victim took damage", "path": "health", "lessThan": 20 }
    ]
  }
}
```

## Resources

Reads that belong in an agent's context rather than in a tool call:

```
bedrock://sessions                       every session, one view
bedrock://config                         non-secret effective configuration
bedrock://last-chat                      most recent chat across all sessions
bedrock://session/{id}/state             live snapshot
bedrock://session/{id}/inventory         slots, containers, held item
bedrock://session/{id}/entities          tracked entities
bedrock://session/{id}/blocks            blocks the server has reported
bedrock://session/{id}/chat              chat buffer
bedrock://session/{id}/events            domain-event buffer
```
