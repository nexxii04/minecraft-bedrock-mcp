import { z } from 'zod';

import type { McpContext } from '../context.js';
import type { ToolRegistry } from '../registry.js';
import { handle, resolveConnectedSession } from '../context.js';
import { hotbarSlotSchema, inventorySlotSchema, sessionIdSchema, timeoutSchema } from '../schemas.js';

/**
 * Inventory tools.
 *
 * Bedrock inventory is a set of named windows (player container, chests, crafting,
 * armour, offhand) and items are numeric runtime ids resolved through the
 * `item_registry` packet. This project maintains the per-window slot map, so tools
 * talk about slots and stacks rather than packets. Slots 0-8 of the `inventory`
 * window are the hotbar, the only part usable without a UI.
 */

const getInventoryArgs = {
  sessionId: sessionIdSchema,
  containerId: z
    .string()
    .optional()
    .describe(
      'Window to read: "inventory" (default, the player container), "armor", "offhand", "hotbar" or a container id seen in the session state.',
    ),
  includeEmpty: z.boolean().optional().describe('Include slots we know to be empty. Defaults to false.'),
};

export function registerInventoryTools(registry: ToolRegistry, context: McpContext): void {
  registry.define(
    {
      name: 'get_inventory',
      title: 'Read the player inventory',
      description:
        'Returns the slots this session knows about for a container, with item runtime ids, counts and resolved item names when the server has sent its item registry. Slots 0-8 are the hotbar. The snapshot is built from inventory_content/inventory_slot packets, so it is as fresh as the last update the server sent.',
      inputSchema: getInventoryArgs,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(context, 'get_inventory', (args: z.infer<z.ZodObject<typeof getInventoryArgs>>): unknown => {
      const session = resolveConnectedSession(context, args.sessionId);
      const state = session.client.session;
      const containerId = args.containerId ?? 'inventory';
      const slots = state.getInventory(containerId);
      const container = state.inventory.get(containerId);

      if (container === undefined) {
        return {
          sessionId: session.id,
          containerId,
          known: false,
          slots: [],
          availableContainers: [...state.inventory.keys()],
          note: 'No inventory packet has arrived for this container yet. If you just connected, wait for the server to finish sending world data.',
        };
      }

      return {
        sessionId: session.id,
        containerId,
        known: true,
        itemRegistrySize: state.itemNames.size,
        selectedHotbarSlot: state.selectedHotbarSlot,
        slotCount: slots.length,
        slots: slots.map((item) => ({
          slot: item.slot,
          isHotbar: item.slot >= 0 && item.slot <= 8,
          networkId: item.networkId,
          name: item.name ?? null,
          count: item.count,
          metadata: item.metadata,
          stackId: item.stackId ?? null,
        })),
        ...(args.includeEmpty === true
          ? { emptySlotsNote: 'Empty slots are not transmitted by the server, so they cannot be listed.' }
          : {}),
      };
    }),
  );

  registry.define(
    {
      name: 'equip_item',
      title: 'Select a hotbar slot',
      description:
        'Selects a hotbar slot (0-8) as the held item. Bedrock has no "equip" concept beyond this selection plus the offhand: what the player holds is whatever is in the selected hotbar slot. Reports whether the slot is known to be empty.',
      inputSchema: { sessionId: sessionIdSchema, slot: hotbarSlotSchema, timeoutMs: timeoutSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(context, 'equip_item', async (args: { sessionId?: string; slot: number; timeoutMs?: number }): Promise<unknown> => {
      const session = resolveConnectedSession(context, args.sessionId);
      const result = await session.actions.equipItem(args.slot, args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {});
      return { sessionId: session.id, ...result, selectedHotbarSlot: session.client.session.selectedHotbarSlot };
    }),
  );

  registry.define(
    {
      name: 'drop_item',
      title: 'Drop items',
      description:
        "Drops part or all of a stack onto the ground. Bedrock has no dedicated drop packet: the vanilla client sends a normal inventory transaction sourced from the player's hand, which this tool reproduces. Confirmed when the server updates that slot.",
      inputSchema: {
        sessionId: sessionIdSchema,
        slot: inventorySlotSchema.optional().describe('Slot to drop from. Defaults to the selected hotbar slot.'),
        count: z.number().int().min(1).optional().describe('How many items to drop. Defaults to the whole stack.'),
        timeoutMs: timeoutSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handle(
      context,
      'drop_item',
      async (args: { sessionId?: string; slot?: number; count?: number; timeoutMs?: number }): Promise<unknown> => {
        const session = resolveConnectedSession(context, args.sessionId);
        const result = await session.actions.dropItem({
          ...(args.slot !== undefined ? { slot: args.slot } : {}),
          ...(args.count !== undefined ? { count: args.count } : {}),
          ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        });
        return { sessionId: session.id, ...result };
      },
    ),
  );

  registry.define(
    {
      name: 'use_held_item',
      title: 'Use the held item',
      description:
        'Uses the selected item without a target block, then releases/consumes it: eating, drinking a potion, throwing a snowball. Confirmed when the server reports a health change or an inventory update. For placing blocks use place_block; for using an item on a mob use interact_entity.',
      inputSchema: { sessionId: sessionIdSchema, timeoutMs: timeoutSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handle(context, 'use_held_item', async (args: { sessionId?: string; timeoutMs?: number }): Promise<unknown> => {
      const session = resolveConnectedSession(context, args.sessionId);
      const result = await session.actions.useHeldItem(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {});
      return { sessionId: session.id, ...result, health: session.client.session.health };
    }),
  );

  registry.define(
    {
      name: 'resolve_item_name',
      title: 'Resolve an item runtime id to a name',
      description:
        'Looks up a Bedrock item runtime id in the palette the server sent at login. Useful when an inventory stack or a block report contains a bare number and you need to know whether it is stone or a diamond pickaxe.',
      inputSchema: {
        sessionId: sessionIdSchema,
        networkId: z.number().int().describe('Item runtime id to resolve.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(context, 'resolve_item_name', (args: { sessionId?: string; networkId: number }): unknown => {
      const session = resolveConnectedSession(context, args.sessionId);
      const name = session.client.session.getItemName(args.networkId);
      return {
        sessionId: session.id,
        networkId: args.networkId,
        name,
        known: name !== null,
        note: name === null ? 'The palette is populated from the item_registry packet; it may still be arriving.' : undefined,
      };
    }),
  );
}
