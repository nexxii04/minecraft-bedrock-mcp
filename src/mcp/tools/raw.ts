import { z } from 'zod';

import type { McpContext } from '../context.js';
import { handle, resolveConnectedSession } from '../context.js';
import type { ToolRegistry } from '../registry.js';
import { sessionIdSchema } from '../schemas.js';

/**
 * The escape hatch.
 *
 * `bedrock-protocol` is packet-level, so the packet names and field shapes it
 * accepts are the API surface. This tool exposes that directly for packets the
 * high-level actions do not model — but it bypasses every sanity check, so it is
 * off by default and registered only when `MCBE_ENABLE_RAW_PACKET_TOOL=true`.
 * `dryRun` serialises without sending, the safe way to test a shape.
 */
export function registerRawTools(registry: ToolRegistry, context: McpContext): void {
  if (!context.config.enableRawPacketTool) return;

  registry.define(
    {
      name: 'send_raw_packet',
      title: 'Send a raw Bedrock packet (advanced)',
      description:
        'Writes a packet straight to the Bedrock connection, bypassing all high-level action logic. Use `dryRun: true` first: it serialises the payload with the installed protocol version and reports whether the field names and enum values are accepted, without sending anything. Enabled only when MCBE_ENABLE_RAW_PACKET_TOOL=true.',
      inputSchema: {
        sessionId: sessionIdSchema,
        packet: z
          .string()
          .min(1)
          .describe(
            'Bedrock packet name exactly as minecraft-data names it, for example "text", "move_player", "player_action", "inventory_transaction".',
          ),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Packet fields. Enum fields use their mapper names, for example "action": "stop_break" for player_action.'),
        queue: z
          .boolean()
          .optional()
          .describe('Add the packet to the next outgoing batch instead of writing it immediately. Defaults to false.'),
        dryRun: z.boolean().optional().describe('Serialise but do not send. Defaults to false.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handle(
      context,
      'send_raw_packet',
      (args: { sessionId?: string; packet: string; params?: Record<string, unknown>; queue?: boolean; dryRun?: boolean }): unknown => {
        const session = resolveConnectedSession(context, args.sessionId);
        const outcome = session.actions.sendRawPacket(args.packet, args.params ?? {}, {
          queue: args.queue === true,
          dryRun: args.dryRun === true,
        });
        return {
          sessionId: session.id,
          packet: outcome.packet,
          sent: outcome.sent,
          dryRun: outcome.dryRun,
          acceptedByProtocol: outcome.error === null,
          error: outcome.error,
          note: outcome.dryRun
            ? 'Nothing was sent. A null error means the installed protocol version accepts this payload shape.'
            : 'The packet was sent; whether the server acts on it is not verified by this tool.',
        };
      },
    ),
  );

  registry.define(
    {
      name: 'list_bedrock_packets',
      title: 'List Bedrock packets known to the installed protocol',
      description:
        'Returns the Bedrock packet names this project produces or reacts to, along with the negotiated protocol version. Use it to confirm exact packet names before calling send_raw_packet, since Bedrock renames packets between releases. For the complete list the installed protocol data supports, run `npm run inspect:packets`.',
      inputSchema: { sessionId: sessionIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(context, 'list_bedrock_packets', (args: { sessionId?: string }): unknown => {
      const session = context.manager.get(args.sessionId ?? context.manager.defaultSessionId);
      const names = session?.client.listKnownPackets() ?? [];
      return {
        protocolVersion: session?.client.session.connection.version ?? null,
        count: names.length,
        packets: names,
        note: 'These are the packets this project produces or reacts to. For the complete list supported by the installed protocol data, run `npm run inspect:packets`.',
      };
    }),
  );
}
