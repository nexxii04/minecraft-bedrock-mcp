import { z } from 'zod';

import { blockCenter } from '../../bedrock/vec3.js';
import type { McpContext } from '../context.js';
import type { ToolRegistry } from '../registry.js';
import { handle, resolveConnectedSession } from '../context.js';
import { blockPositionSchema, rotationSchema, sessionIdSchema, timeoutSchema } from '../schemas.js';

/**
 * Movement tools.
 *
 * Nothing here is pathfinding: `bedrock-protocol` ships neither physics nor a
 * planner. The tools differ in how much of a client they imitate — `move_to`
 * reports a position once; `walk_to` walks the straight line in steps, one
 * authoritative-input packet per step. Each says whether the server agreed.
 */

const moveArgs = {
  sessionId: sessionIdSchema,
  x: z.number().describe('Target X coordinate.'),
  y: z.number().describe('Target Y coordinate (feet position; standing on a block at y=64 means y=64).'),
  z: z.number().describe('Target Z coordinate.'),
  mode: z
    .enum(['teleport', 'auth_input', 'both'])
    .optional()
    .describe(
      'Which packet carries the position. "both" (default) sends player_auth_input — what every modern server applies movement from — and then move_player in teleport mode, the older way to force a position. Narrow it only to reproduce a specific server complaint: some servers have no handler for one of the two at all.',
    ),
  yaw: z.number().optional().describe('Yaw to face after moving, in degrees. Defaults to facing the target.'),
  pitch: z.number().optional().describe('Pitch to look at after moving, in degrees. Defaults to facing the target.'),
  tolerance: z
    .number()
    .min(0.05)
    .max(16)
    .optional()
    .describe('How close the server-reported position must be to the target to count as confirmed, in blocks. Defaults to 0.5.'),
  timeoutMs: timeoutSchema,
};

const walkArgs = {
  sessionId: sessionIdSchema,
  x: z.number().describe('Target X coordinate.'),
  y: z.number().describe('Target Y coordinate (feet position).'),
  z: z.number().describe('Target Z coordinate.'),
  stepLength: z
    .number()
    .min(0.5)
    .max(16)
    .optional()
    .describe(
      'Blocks covered per step, and therefore one player_auth_input per step. Defaults to 2; smaller steps read more like walking and cost more packets.',
    ),
  tolerance: z.number().min(0.05).max(16).optional().describe('How close to the target counts as arrived, in blocks. Defaults to 0.5.'),
  stepIntervalMs: z
    .number()
    .int()
    .min(0)
    .max(5000)
    .optional()
    .describe('Pause between steps, so the server sees them as separate ticks. Defaults to 50ms.'),
  maxSteps: z
    .number()
    .int()
    .min(1)
    .max(512)
    .optional()
    .describe('Hard cap on packets sent. Defaults to 64, or enough to reach the target, whichever is smaller.'),
  keepY: z
    .boolean()
    .optional()
    .describe(
      'Hold the starting height instead of following the straight line to the target. Defaults to true, because a walk does not change height on its own.',
    ),
  abortOnCorrection: z
    .boolean()
    .optional()
    .describe('Stop as soon as the server contradicts a step with a position correction. Defaults to false.'),
  timeoutMs: timeoutSchema,
};

const lookAtArgs = {
  sessionId: sessionIdSchema,
  x: z.number().describe('X coordinate to look at.'),
  y: z.number().describe('Y coordinate to look at.'),
  z: z.number().describe('Z coordinate to look at.'),
  timeoutMs: timeoutSchema,
};

const jumpArgs = {
  sessionId: sessionIdSchema,
  timeoutMs: timeoutSchema,
};

export function registerMovementTools(registry: ToolRegistry, context: McpContext): void {
  registry.define(
    {
      name: 'move_to',
      title: 'Move the player to a position',
      description:
        "Reports a new position for the player and records it as the session's own position, then waits for the server to say something about it. There is no walking simulation: this is a direct position report, so servers that validate movement may push the player back. Note that `confirmed: false` here is usually *not* a failure: Bedrock clients are authoritative over their own position, so most servers never echo movement back to the mover — they broadcast it to other viewers instead, and only reply with a correction when they disagree (which does count as confirmed). `detail.sessionPosition` is the position subsequent actions will use, and `detail.positionSource` says whether it came from the server or from our own report. To verify a move server-side, ask a second session what it sees.",
      inputSchema: moveArgs,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(context, 'move_to', async (args: z.infer<z.ZodObject<typeof moveArgs>>): Promise<unknown> => {
      const session = resolveConnectedSession(context, args.sessionId);
      const rotation =
        args.yaw !== undefined || args.pitch !== undefined
          ? {
              yaw: args.yaw ?? 0,
              pitch: args.pitch ?? 0,
              headYaw: args.yaw ?? 0,
            }
          : undefined;

      const result = await session.actions.moveTo(
        { x: args.x, y: args.y, z: args.z },
        {
          ...(args.mode !== undefined ? { mode: args.mode } : {}),
          ...(rotation !== undefined ? { rotation } : {}),
          ...(args.tolerance !== undefined ? { tolerance: args.tolerance } : {}),
          ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        },
      );

      return { sessionId: session.id, ...result, status: session.client.session.snapshot() };
    }),
  );

  registry.define(
    {
      name: 'move_to_block',
      title: 'Move the player onto a block',
      description:
        'Same as move_to, but takes integer block coordinates and targets the centre of the block at its base height, which is where a player stands when standing on it. Handy for QA scripts that talk in block terms.',
      inputSchema: { ...blockPositionSchema.shape, sessionId: sessionIdSchema, mode: moveArgs.mode, timeoutMs: timeoutSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(
      context,
      'move_to_block',
      async (args: {
        sessionId?: string;
        x: number;
        y: number;
        z: number;
        mode?: 'teleport' | 'auth_input' | 'both';
        timeoutMs?: number;
      }): Promise<unknown> => {
        const session = resolveConnectedSession(context, args.sessionId);
        const target = blockCenter({ x: args.x, y: args.y, z: args.z });
        const result = await session.actions.moveTo(target, {
          ...(args.mode !== undefined ? { mode: args.mode } : {}),
          ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        });
        return { sessionId: session.id, block: { x: args.x, y: args.y, z: args.z }, target, ...result };
      },
    ),
  );

  registry.define(
    {
      name: 'walk_to',
      title: 'Walk the player to a position in steps',
      description:
        'Moves the player towards a position in several steps, sending one player_auth_input per step with an increasing tick and a per-step displacement — what a real client sends when it holds forward, instead of the single position report move_to sends. Still not pathfinding: the steps run in a straight line, so anything solid between here and there is walked through and a validating server will push back (which counts as confirmation, and `detail.correction` reports it). Chatty by design: use move_to to simply be somewhere, and walk_to when the movement path itself is what you are testing — a walk is what other sessions can watch. `detail.trail` lists every step with its position and tick.',
      inputSchema: walkArgs,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(context, 'walk_to', async (args: z.infer<z.ZodObject<typeof walkArgs>>): Promise<unknown> => {
      const session = resolveConnectedSession(context, args.sessionId);
      const result = await session.actions.walkTo(
        { x: args.x, y: args.y, z: args.z },
        {
          ...(args.stepLength !== undefined ? { stepLength: args.stepLength } : {}),
          ...(args.tolerance !== undefined ? { tolerance: args.tolerance } : {}),
          ...(args.stepIntervalMs !== undefined ? { stepIntervalMs: args.stepIntervalMs } : {}),
          ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
          ...(args.keepY !== undefined ? { keepY: args.keepY } : {}),
          ...(args.abortOnCorrection !== undefined ? { abortOnCorrection: args.abortOnCorrection } : {}),
          ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        },
      );
      return { sessionId: session.id, ...result, status: session.client.session.snapshot() };
    }),
  );

  registry.define(
    {
      name: 'look_at',
      title: 'Point the player at a position',
      description:
        'Rotates the player so they face a world position, without changing where they stand. Rotation is largely client-side in Bedrock, so `confirmed` is usually false; the value is that the next movement or block packet carries the new orientation.',
      inputSchema: lookAtArgs,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(context, 'look_at', async (args: z.infer<z.ZodObject<typeof lookAtArgs>>): Promise<unknown> => {
      const session = resolveConnectedSession(context, args.sessionId);
      const result = await session.actions.lookAt(
        { x: args.x, y: args.y, z: args.z },
        args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
      );
      return { sessionId: session.id, ...result, rotation: session.client.session.rotation };
    }),
  );

  registry.define(
    {
      name: 'jump',
      title: 'Make the player jump',
      description:
        'Sends a jump action followed by an authoritative-input frame, then waits for the server-reported Y position to rise. Confirmed only when the height actually changes, so a `confirmed: false` result genuinely means the player did not leave the ground.',
      inputSchema: jumpArgs,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handle(context, 'jump', async (args: z.infer<z.ZodObject<typeof jumpArgs>>): Promise<unknown> => {
      const session = resolveConnectedSession(context, args.sessionId);
      const result = await session.actions.jump(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {});
      return { sessionId: session.id, ...result, status: session.client.session.snapshot() };
    }),
  );

  registry.define(
    {
      name: 'get_position',
      title: 'Get the player position',
      description:
        'Returns the current position, rotation, dimension, game mode, health and on-ground flag, plus how the position was last learned (server move, correction, respawn or teleport). Use it to verify what a movement tool actually achieved.',
      inputSchema: { sessionId: sessionIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(context, 'get_position', (args: z.infer<z.ZodObject<{ sessionId: z.ZodOptional<z.ZodString> }>>): unknown => {
      const session = resolveConnectedSession(context, args.sessionId);
      const snapshot = session.client.session.snapshot();
      return {
        sessionId: session.id,
        position: snapshot.position,
        rotation: snapshot.rotation,
        onGround: snapshot.onGround,
        dimension: snapshot.dimension,
        gameMode: snapshot.gameMode,
        health: snapshot.health,
        isAlive: snapshot.isAlive,
      };
    }),
  );

  registry.define(
    {
      name: 'set_rotation',
      title: 'Set the player rotation',
      description:
        'Sets yaw/pitch/head yaw explicitly, without moving. Yaw 0 faces south (+Z), yaw 90 faces west (-X), yaw -90 faces east (+X); pitch -90 looks straight up and 90 straight down.',
      inputSchema: { sessionId: sessionIdSchema, ...rotationSchema.shape, timeoutMs: timeoutSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(
      context,
      'set_rotation',
      async (args: { sessionId?: string; yaw: number; pitch: number; headYaw?: number; timeoutMs?: number }): Promise<unknown> => {
        const session = resolveConnectedSession(context, args.sessionId);
        const rotation = { yaw: args.yaw, pitch: args.pitch, headYaw: args.headYaw ?? args.yaw };
        const result = await session.actions.setRotation(rotation, args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {});
        return { sessionId: session.id, ...result, rotation };
      },
    ),
  );
}
