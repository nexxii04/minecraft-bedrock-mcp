import { z } from 'zod';

/**
 * Input schemas shared by the MCP tools.
 *
 * Tool inputs are the only place an agent's intent is validated, so every field
 * carries a `.describe()` that ends up in the JSON Schema and the model's context;
 * the descriptions explain units and conventions.
 */

export const sessionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe(
    'Session to act on. Sessions are independent Bedrock connections, so several agent-players can be logged in at once. Defaults to the configured default session.',
  );

export const vec3Schema = z.object({
  x: z.number().describe('World X coordinate in blocks (east/west).'),
  y: z.number().describe('World Y coordinate in blocks (height).'),
  z: z.number().describe('World Z coordinate in blocks (south/north).'),
});

export const blockPositionSchema = z.object({
  x: z.number().int().describe('Integer block X coordinate.'),
  y: z.number().int().describe('Integer block Y coordinate.'),
  z: z.number().int().describe('Integer block Z coordinate.'),
});

export const rotationSchema = z.object({
  yaw: z.number().describe('Degrees. 0 = south (+Z), 90 = west (-X), -90 = east (+X).'),
  pitch: z.number().describe('Degrees. -90 = straight up, 90 = straight down.'),
  headYaw: z.number().optional().describe('Head yaw in degrees; defaults to yaw.'),
});

export const blockFaceSchema = z
  .enum(['down', 'up', 'north', 'south', 'west', 'east'])
  .describe('Block face, named after the direction the face points.');

export const timeoutSchema = z
  .number()
  .int()
  .min(100)
  .max(120_000)
  .optional()
  .describe('How long to wait for the server to acknowledge the action, in milliseconds.');

/** Slots 0-8 are the hotbar; the rest of the `inventory` window is the container. */
export const hotbarSlotSchema = z.number().int().min(0).max(8).describe('Hotbar slot, 0 (leftmost) to 8 (rightmost).');

export const inventorySlotSchema = z
  .number()
  .int()
  .min(0)
  .max(255)
  .describe('Inventory slot number. 0-8 are the hotbar, 9-35 the main container.');
