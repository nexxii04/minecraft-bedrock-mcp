import { z } from 'zod';

import type { McpContext } from '../context.js';
import type { ToolRegistry } from '../registry.js';
import { handle, resolveConnectedSession } from '../context.js';
import { sessionIdSchema, timeoutSchema } from '../schemas.js';

/**
 * Entity tools: what is nearby, and how to hit or use it.
 *
 * Bedrock identifies entities by a *runtime id* valid only for the connection plus
 * a stable *unique id*. Positions arrive through `add_entity`/`add_player` and are
 * updated by `move_entity`/`move_entity_delta`, so the entity table is built here.
 */

const targetArgs = {
  runtimeId: z.number().int().describe('Runtime entity id, as reported by get_nearby_entities.'),
  sessionId: sessionIdSchema,
};

const nearbyArgs = {
  sessionId: sessionIdSchema,
  radius: z.number().min(1).max(128).optional().describe('Search radius in blocks. Defaults to 32.'),
  limit: z.number().int().min(1).max(200).optional().describe('Maximum number of entities to return. Defaults to 50.'),
  includePlayers: z.boolean().optional().describe('Include other players. Defaults to true.'),
  includeSelf: z.boolean().optional().describe("Include this session's own player entity. Defaults to false."),
  entityType: z.string().optional().describe('Filter by Bedrock entity identifier, for example "minecraft:zombie" or "minecraft:player".'),
};

const attackArgs = {
  sessionId: sessionIdSchema,
  runtimeId: z.number().int().optional().describe('Runtime id of the target entity.'),
  entityType: z
    .string()
    .optional()
    .describe('Alternatively, attack the nearest entity of this type within `reach`, for example "minecraft:zombie".'),
  username: z.string().optional().describe('Or attack the nearest player with this username.'),
  reach: z.number().min(1).max(32).optional().describe('Maximum distance for automatic target selection. Defaults to 6 blocks.'),
  swing: z.boolean().optional().describe('Also send the arm-swing animation. Defaults to true.'),
  timeoutMs: timeoutSchema,
};

const interactArgs = {
  sessionId: sessionIdSchema,
  runtimeId: z.number().int().optional().describe('Runtime id of the target entity.'),
  entityType: z.string().optional().describe('Alternatively, select the nearest entity of this type.'),
  username: z.string().optional().describe('Or select the nearest player with this username.'),
  reach: z.number().min(1).max(32).optional().describe('Maximum distance for automatic target selection. Defaults to 6 blocks.'),
  mode: z
    .enum(['use', 'hover'])
    .optional()
    .describe(
      '"use" (default) sends the item-use-on-entity transaction (feed, shear, trade); "hover" only sends the lightweight interact packet.',
    ),
  timeoutMs: timeoutSchema,
};

export function registerEntityTools(registry: ToolRegistry, context: McpContext): void {
  registry.define(
    {
      name: 'get_nearby_entities',
      title: 'List nearby entities',
      description:
        'Lists entities and players near this session, sorted by distance, with their runtime ids (needed by attack_entity and interact_entity), type identifiers, positions and last-seen timestamps. Entities are only known once the server has spawned them for this connection.',
      inputSchema: nearbyArgs,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(context, 'get_nearby_entities', (args: z.infer<z.ZodObject<typeof nearbyArgs>>): unknown => {
      const session = resolveConnectedSession(context, args.sessionId);
      let entities = session.client.session.getNearbyEntities({
        ...(args.radius !== undefined ? { radius: args.radius } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        includeSelf: args.includeSelf === true,
        ...(args.entityType !== undefined ? { types: [args.entityType] } : {}),
      });
      if (args.includePlayers === false) entities = entities.filter((entity) => !entity.isPlayer);
      return {
        sessionId: session.id,
        origin: session.client.session.position,
        trackedTotal: session.client.session.entities.size,
        count: entities.length,
        entities,
      };
    }),
  );

  registry.define(
    {
      name: 'get_entity',
      title: 'Get one entity',
      description:
        'Returns the full tracked state of a single entity by runtime id, including its stable unique id and most recent position.',
      inputSchema: targetArgs,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(context, 'get_entity', (args: z.infer<z.ZodObject<typeof targetArgs>>): unknown => {
      const session = resolveConnectedSession(context, args.sessionId);
      const entity = session.client.session.entities.get(args.runtimeId);
      if (entity === undefined) {
        return {
          sessionId: session.id,
          found: false,
          runtimeId: args.runtimeId,
          note: 'No entity with that runtime id is tracked. Runtime ids are per-connection and disappear when the entity despawns; call get_nearby_entities for current ids.',
        };
      }
      return { sessionId: session.id, found: true, entity };
    }),
  );

  registry.define(
    {
      name: 'attack_entity',
      title: 'Attack an entity',
      description:
        'Attacks an entity with the held item, using the same packet the vanilla client sends when you hit a mob (an item-use-on-entity transaction with action_type "attack"), optionally followed by an arm-swing animation. Confirmed when the target\'s metadata reports a health change or when it disappears. Targets can be picked by runtime id, entity type or player name.',
      inputSchema: attackArgs,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handle(context, 'attack_entity', async (args: z.infer<z.ZodObject<typeof attackArgs>>): Promise<unknown> => {
      const session = resolveConnectedSession(context, args.sessionId);
      const result = await session.actions.attackEntity({
        ...(args.runtimeId !== undefined ? { runtimeId: args.runtimeId } : {}),
        ...(args.entityType !== undefined ? { entityType: args.entityType } : {}),
        ...(args.username !== undefined ? { username: args.username } : {}),
        ...(args.reach !== undefined ? { reach: args.reach } : {}),
        ...(args.swing !== undefined ? { swing: args.swing } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      });
      return { sessionId: session.id, ...result };
    }),
  );

  registry.define(
    {
      name: 'interact_entity',
      title: 'Interact with an entity',
      description:
        'Uses the held item on an entity (feeding, shearing, trading) or merely hovers it. The Bedrock protocol has no acknowledgement for either, so a `confirmed: false` result here means "sent, outcome unknown" rather than failure — look for the downstream effect you actually care about (an inventory change, a chat line, changed metadata).',
      inputSchema: interactArgs,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handle(context, 'interact_entity', async (args: z.infer<z.ZodObject<typeof interactArgs>>): Promise<unknown> => {
      const session = resolveConnectedSession(context, args.sessionId);
      const result = await session.actions.interactEntity({
        ...(args.runtimeId !== undefined ? { runtimeId: args.runtimeId } : {}),
        ...(args.entityType !== undefined ? { entityType: args.entityType } : {}),
        ...(args.username !== undefined ? { username: args.username } : {}),
        ...(args.reach !== undefined ? { reach: args.reach } : {}),
        ...(args.mode !== undefined ? { mode: args.mode } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      });
      return { sessionId: session.id, ...result };
    }),
  );

  registry.define(
    {
      name: 'attack_nearest_entity',
      title: 'Attack the nearest entity',
      description:
        'Convenience wrapper: attacks the closest entity within reach, optionally restricted to a type. Handy for combat QA loops where the exact target does not matter.',
      inputSchema: {
        sessionId: sessionIdSchema,
        entityType: z.string().optional().describe('Restrict to this Bedrock entity identifier.'),
        reach: z.number().min(1).max(32).optional().describe('Maximum distance in blocks. Defaults to 6.'),
        timeoutMs: timeoutSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handle(
      context,
      'attack_nearest_entity',
      async (args: { sessionId?: string; entityType?: string; reach?: number; timeoutMs?: number }): Promise<unknown> => {
        const session = resolveConnectedSession(context, args.sessionId);
        const nearby = session.client.session.getNearbyEntities({
          ...(args.reach !== undefined ? { radius: args.reach } : {}),
          includeSelf: false,
        });
        const candidate = args.entityType !== undefined ? nearby.find((entity) => entity.type === args.entityType) : nearby[0];
        if (candidate === undefined) {
          throw new Error(
            `No ${args.entityType ?? 'entity'} within ${args.reach ?? 6} blocks. Use get_nearby_entities to see what is actually in range.`,
          );
        }
        const result = await session.actions.attackEntity({
          runtimeId: candidate.runtimeId,
          ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        });
        return { sessionId: session.id, target: candidate, ...result };
      },
    ),
  );
}
