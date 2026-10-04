# minecraft-bedrock-mcp

An MCP server that puts AI agents **inside a Minecraft Bedrock Edition server**
as real game clients.

It connects over the RakNet/Bedrock protocol (the same one the game uses — this
is Bedrock, _not_ Java Edition), logs in as a player, and then exposes that
player to an agent: move, look, break and place blocks, attack and interact with
entities, read inventory, chat and run commands, observe the world through MCP
resources, and script reproducible QA scenarios with declarative assertions.

It is built on [`bedrock-protocol`](https://github.com/PrismarineJS/bedrock-protocol)
(PrismarineJS). That library is deliberately low-level — a socket, a login
handshake and a stream of decoded packets — so the interesting half of this
project is what sits on top of it: an action layer where "break this block"
means "the _server_ says the block is gone", not "we sent a packet".

## Requirements

- Node.js **>= 20.19** (ESM, `node:` imports, `import.meta.dirname`).
- A Bedrock server to connect to. Any of these work:
  - [Bedrock Dedicated Server](https://www.minecraft.net/en-us/download/server/bedrock)
    (BDS) with `online-mode=false` (the default) — recommended for local QA;
  - a LAN world opened to players (offline mode allowed);
  - a **custom Bedrock server implementation**, as long as it speaks the Bedrock
    protocol below (offline mode usually required);
  - a public server, if you have permission to drive a bot around on it.
- Minecraft Bedrock **1.26.50** (protocol 2193) is the release this client
  currently targets and is validated against. To talk to a different release,
  pin it with `MCBE_VERSION` (see [Configuration](#configuration)).

No compiler is needed: the default RakNet implementation is pure JavaScript.

## Install

```bash
npm install
cp .env.example .env      # then edit host/port/username
npm run build             # emits dist/ (the MCP entry point)
```

Run straight from source during development:

```bash
npm run dev               # tsx watch src/index.ts
```

## Use it from an MCP client

Stdio is the default transport. Point your client at the built entry point:

```json
{
  "mcpServers": {
    "bedrock": {
      "command": "node",
      "args": ["/absolute/path/to/minecraft-bedrock-mcp/dist/index.js"],
      "env": {
        "MCBE_HOST": "127.0.0.1",
        "MCBE_PORT": "19132",
        "MCBE_USERNAME": "MCPAgent",
        "MCBE_OFFLINE": "true"
      }
    }
  }
}
```

The same settings can live in `.env` next to the project instead of in the client
config; explicit `env` values win.

For remote or containerised agents, switch to streamable HTTP:

```bash
MCBE_TRANSPORT=http MCBE_HTTP_PORT=8787 node dist/index.js
# MCP endpoint: http://127.0.0.1:8787/mcp
```

Every log line goes to **stderr** — stdout carries the JSON-RPC stream and stays
clean, including for the library's own console output.

## Configuration

100% environment variables, validated at startup with a readable error listing
every problem it found. `.env.example` documents each one with its default and
why it exists; the ones that matter most:

| Variable                      | Default               | Purpose                                                                              |
| ----------------------------- | --------------------- | ------------------------------------------------------------------------------------ |
| `MCBE_HOST` / `MCBE_PORT`     | `127.0.0.1` / `19132` | Default server to join.                                                              |
| `MCBE_USERNAME`               | `MCPAgent`            | In-game name of the agent-player.                                                    |
| `MCBE_OFFLINE`                | `true`                | Offline login. Set `false` for Xbox Live device-code auth (URL and code are logged). |
| `MCBE_VERSION`                | library default       | Pin a Bedrock release, e.g. `1.21.130`.                                              |
| `MCBE_MAX_SESSIONS`           | `4`                   | How many agent-players may be connected at once.                                     |
| `MCBE_ACTION_TIMEOUT_MS`      | `5000`                | Budget for any action waiting on a server acknowledgement.                           |
| `MCBE_RECONNECT_*`            | enabled, 5 attempts   | Backoff and kick policy for automatic reconnection.                                  |
| `MCBE_ENABLE_RAW_PACKET_TOOL` | `false`               | Enables `send_raw_packet`, the escape hatch.                                         |
| `MCBE_LOG_LEVEL`              | `info`                | `debug` logs every decoded packet.                                                   |

## What an agent can do

39 tools by default (41 when `MCBE_ENABLE_RAW_PACKET_TOOL=true` adds the escape
hatch), in nine groups — full catalogue in [docs/TOOLS.md](./docs/TOOLS.md):

| Group        | Tools                                                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Connection   | `connect_to_server`, `disconnect`, `get_connection_status`, `list_sessions`                                                         |     | Movement | `move_to`, `walk_to`, `move_to_block`, `look_at`, `set_rotation`, `jump`, `get_position` |
| World        | `get_nearby_blocks`, `get_block_at`, `find_block`, `get_biome`, `break_block`, `place_block`, `abort_break`, `request_chunk_radius` |
| Inventory    | `get_inventory`, `equip_item`, `drop_item`, `use_held_item`, `resolve_item_name`                                                    |
| Entities     | `get_nearby_entities`, `get_entity`, `attack_entity`, `attack_nearest_entity`, `interact_entity`                                    |
| Commands     | `list_commands`, `run_command`                                                                                                      |
| Chat         | `send_chat`, `get_chat_log`, `get_event_log`, `wait_for_chat`                                                                       |
| QA           | `run_action_sequence`, `assert_session_state`, `wait_for_event`, `snapshot_session_state`                                           |
| Escape hatch | `send_raw_packet`, `list_bedrock_packets` (behind `MCBE_ENABLE_RAW_PACKET_TOOL`)                                                    |

And world state as MCP resources, so an agent can attach context instead of
polling:

```
bedrock://sessions                     bedrock://session/{id}/state
bedrock://config                       bedrock://session/{id}/inventory
bedrock://last-chat                    bedrock://session/{id}/entities
                                       bedrock://session/{id}/blocks
                                       bedrock://session/{id}/chat
                                       bedrock://session/{id}/events
```

Every action answers with `ok` (we sent it) and `confirmed` (the server showed us
the effect), plus `evidence` and `warnings` — so an agent can tell "the block is
gone" from "we clicked and nothing happened", and say which packet changed that.

## QA scenarios

The reason this exists: a server change can be tested the way you test code.
`run_action_sequence` takes a list of tool calls, a scripted pause, and
declarative assertions about the resulting state; `assert_session_state` checks
the same invariants at any point, and `wait_for_event` synchronises on a
server-side effect instead of sleeping.

```json
{
  "tool": "run_action_sequence",
  "args": {
    "sessionId": "tester",
    "steps": [
      { "tool": "move_to", "args": { "x": 8, "y": 65, "z": 8 } },
      { "tool": "break_block", "args": { "x": 8, "y": 64, "z": 8, "mode": "creative" } },
      { "tool": "wait", "args": { "ms": 400 } },
      { "tool": "get_block_at", "args": { "x": 8, "y": 64, "z": 8 } }
    ],
    "assertions": [
      { "name": "still in the world", "path": "connection.state", "equals": "initialized" },
      { "name": "not hurt", "path": "health", "atLeast": 20 }
    ]
  }
}
```

Multi-session is a first-class feature: connect two ids, drive one, assert on the
other — player-vs-player and "did the other client see it" testing.

## Tests

```bash
npm test              # unit + integration
npm run test:unit     # no server needed
npm run typecheck
npm run lint
```

- **Unit** tests cover the packet encoders against the installed protocol data,
  packet→domain-event normalisation, environment parsing, backoff maths, the tool
  registry and the QA assertion engine.
- **Integration** tests start `bedrock-protocol`'s own Bedrock server in-process
  and exercise the real connection path: joining, kick handling, reconnecting to
  a restarted server, a clear error when nothing is listening, the smoke test
  (connect → move → chat → disconnect), multi-session independence and the
  session cap.
- **External** tests run the same flows against a real server and are skipped
  unless you point them at one:

  ```bash
  MCBE_TEST_HOST=127.0.0.1 MCBE_TEST_PORT=19132 npm run test:integration
  ```

  Destructive steps only run with `MCBE_TEST_DESTRUCTIVE=true`, so aiming this at
  a world you care about is safe by default.

`npm run inspect:packets` connects and prints every decoded packet as JSON lines —
the tool to reach for when an action reports `confirmed: false`:

```bash
npm run inspect:packets -- --only update_block,mob_equipment --events
```

## Documentation

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — layering, the acknowledgement
  model, the action → packet → confirmation table, session state and event
  normalisation, testing strategy, known limitations.
- [docs/TOOLS.md](./docs/TOOLS.md) — the full tool and resource catalogue with
  arguments, assertion paths and worked scenarios.

## Limits worth knowing

- Movement is a **position report**, not pathfinding: servers that validate
  movement answer with a correction, reported as `confirmed: false`.
- Block and entity views are **deltas** of what the server has told us. Absence
  means "unknown", not "air".
- Rotation is largely client-side and rarely acknowledged.
- Offline mode is the tested path; Xbox Live auth needs real credentials.

## Contributing

Issues and pull requests are welcome. Before opening a PR:

```bash
npm run typecheck
npm run lint
npm test
```

Keep tests and docs with the code they describe.

## License

[MIT](./LICENSE)
